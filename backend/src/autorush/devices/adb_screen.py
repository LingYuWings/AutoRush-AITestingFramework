"""Explicit local ADB display sharing, independent of Portal screenshot scope.

The raw Annex B stream is ordered: never discard arbitrary predicted frames.
Only one bounded pipe and websocket send may be in flight per recording.
"""
from __future__ import annotations

import asyncio
import json
import re
import subprocess
import struct
import time
from dataclasses import dataclass, field
from uuid import UUID

import anyio
from fastapi import HTTPException, WebSocket, WebSocketDisconnect

from autorush.devices import adb


class AdbUnavailable(RuntimeError):
    pass


class BindingError(RuntimeError):
    pass


@dataclass(eq=False)
class AdbView:
    device_id: UUID
    revoked: asyncio.Event = field(default_factory=asyncio.Event)


@dataclass(eq=False)
class Recording:
    serial: str
    process: asyncio.subprocess.Process
    pid: int | None = None
    closed: bool = False
    started_at: float = field(default_factory=time.monotonic)

    async def chunks(self):
        assert self.process.stdout is not None
        line = await asyncio.wait_for(self.process.stdout.readline(), 5)
        if not re.fullmatch(rb'[1-9][0-9]{0,9}\r?\n', line):
            raise RuntimeError('无法识别手机录制进程')
        self.pid = int(line)
        received = False
        while True:
            # A static Android display may emit no frames for a long time.
            # Allow still images while bounding even a hung remote encoder by
            # an absolute deadline slightly beyond its 175-second time limit.
            remaining = self.started_at + 185 - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('ADB 录制周期超时')
            chunk = await asyncio.wait_for(self.process.stdout.read(65_536), remaining if received else min(15, remaining))
            if not chunk:
                break
            received = True
            yield chunk
        code = await asyncio.wait_for(self.process.wait(), 3)
        if not received or code != 0 or time.monotonic() - self.started_at < 170:
            raise RuntimeError('手机 H.264 编码器已退出，请检查 ADB 连接')

    async def close(self):
        if self.closed:
            return
        self.closed = True
        # Stop only the PID created by this viewing session, not every recorder
        # on the phone. Also handle cancellation just after process creation.
        if self.pid is None and self.process.stdout is not None:
            try:
                line = await asyncio.wait_for(self.process.stdout.readline(), .5)
                if re.fullmatch(rb'[1-9][0-9]{0,9}\r?\n', line):
                    self.pid = int(line)
            except (OSError, RuntimeError, asyncio.TimeoutError):
                pass
        if self.pid is not None:
            cleanup = None
            try:
                # PID is parsed as a positive integer, never interpolated user
                # input. exec-out escapes each argument, including the script.
                command = (f'case "$(cat /proc/{self.pid}/comm 2>/dev/null)" in '
                           f'screenrecord|sh) kill -2 {self.pid};; esac')
                cleanup = await asyncio.create_subprocess_exec(
                    adb.adb_executable(), '-s', self.serial, 'exec-out', 'sh', '-c', command,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                await asyncio.wait_for(cleanup.wait(), 2)
            except (adb.AdbError, OSError, asyncio.TimeoutError):
                pass
            finally:
                if cleanup is not None and cleanup.returncode is None:
                    cleanup.kill()
                    await cleanup.wait()
        if self.process.returncode is None:
            try:
                await asyncio.wait_for(self.process.wait(), .5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()


async def start_recording(serial: str) -> Recording:
    # Echo the owned shell PID before exec replaces it with screenrecord. This
    # lets disconnect cleanup stop the remote process as well as the host adb.
    command = 'echo $$; exec screenrecord --output-format=h264 --time-limit 175 --bit-rate 8000000 -'
    process = await asyncio.create_subprocess_exec(
        adb.adb_executable(), '-s', serial, 'exec-out', 'sh', '-c', command,
        stdout=asyncio.subprocess.PIPE, stderr=subprocess.DEVNULL, limit=65_536,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return Recording(serial, process)


async def capture_poster(serial: str) -> bytes:
    """One bounded full-display image; H.264 framing never guesses idle NAL ends."""
    spawn = asyncio.create_task(asyncio.create_subprocess_exec(
        adb.adb_executable(), '-s', serial, 'exec-out', 'screencap', '-p',
        stdout=asyncio.subprocess.PIPE, stderr=subprocess.DEVNULL, limit=65_536,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)))
    process = None
    try:
        process = await asyncio.shield(spawn)
        data = bytearray()
        async with asyncio.timeout(5):
            while chunk := await process.stdout.read(65_536):
                data.extend(chunk)
                if len(data) > 8_000_000:
                    raise RuntimeError('ADB 首屏图片过大')
            code = await process.wait()
        if code != 0 or len(data) < 24 or data[:16] != b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR':
            raise RuntimeError('ADB 首屏图片无效')
        width, height = struct.unpack('!II', data[16:24])
        if not 1 <= width <= 8192 or not 1 <= height <= 8192 or width * height > 24_000_000:
            raise RuntimeError('ADB 首屏图片尺寸无效')
        return b'ARSP' + data
    finally:
        with anyio.CancelScope(shield=True):
            if process is None:
                try:
                    process = await spawn
                except OSError:
                    pass
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()


class AdbScreenHub:
    def __init__(self, pairings):
        self.pairings = pairings
        self.active: dict[str, AdbView] = {}
        self.recordings: set[Recording] = set()

    def revoke(self, device_id: UUID):
        for view in self.active.values():
            if view.device_id == device_id:
                view.revoked.set()

    async def close(self):
        await asyncio.gather(*(recording.close() for recording in list(self.recordings)), return_exceptions=True)

    async def stream(self, socket: WebSocket, serial: str, device_id: UUID):
        if not self.pairings.is_active_device(device_id):
            raise BindingError('仅可查看当前有效配对的手机')
        try:
            devices = await asyncio.to_thread(adb.list_devices)
        except adb.AdbError as exc:
            raise AdbUnavailable(str(exc)) from exc
        if not any(item['serial'] == serial and item['state'] == 'device' for item in devices):
            raise AdbUnavailable('所选 ADB 设备未连接或尚未授权')
        try:
            actual = await asyncio.to_thread(adb.portal_device_id, serial)
        except adb.AdbError as exc:
            raise BindingError(str(exc)) from exc
        if actual != device_id:
            raise BindingError('所选 ADB 设备不属于当前配对手机，请核对设备 ID 和 USB 连接')
        await asyncio.wait_for(socket.send_json({'type': 'h264.ready', 'serial': serial, 'device_id': str(device_id), 'codec': 'h264', 'scope': 'display'}), 2)
        first = True
        while True:
            if not self.pairings.is_active_device(device_id):
                raise BindingError('手机配对已撤销')
            spawn = asyncio.create_task(start_recording(serial))
            try:
                recording = await asyncio.shield(spawn)
            except asyncio.CancelledError:
                # Cancellation during Windows pipe setup must not lose the
                # child process handle after the OS has already created it.
                with anyio.CancelScope(shield=True):
                    recording = await spawn
                    await recording.close()
                raise
            self.recordings.add(recording)
            try:
                await asyncio.wait_for(socket.send_json({'type': 'h264.reset'}), 2)
                if first:
                    poster = await capture_poster(serial)
                    await asyncio.wait_for(socket.send_bytes(poster), 2)
                    first = False
                async for chunk in recording.chunks():
                    await asyncio.wait_for(socket.send_bytes(chunk), 2)
            finally:
                with anyio.CancelScope(shield=True):
                    await recording.close()
                    self.recordings.discard(recording)


async def serve_adb_viewer(socket: WebSocket, hub: AdbScreenHub, require_operator, allowed_origins):
    if socket.headers.get('origin') not in allowed_origins:
        await socket.close(code=1008)
        return
    await socket.accept()
    serial = None
    owner = None
    tasks = []
    try:
        raw = await asyncio.wait_for(socket.receive_text(), 5)
        if len(raw) > 4096:
            raise ValueError()
        auth = json.loads(raw)
        if (not isinstance(auth, dict) or set(auth) != {'type', 'operator_token', 'serial', 'device_id'}
            or auth['type'] != 'screen.auth' or not isinstance(auth['operator_token'], str)
            or not isinstance(auth['serial'], str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', auth['serial'])):
            raise ValueError()
        require_operator(auth['operator_token'])
        device_id = UUID(auth['device_id'])
        serial = auth['serial']
        if serial in hub.active:
            await asyncio.wait_for(socket.send_json({'type': 'screen.status', 'state': 'error', 'reason': 'busy', 'detail': '该 ADB 设备正在投屏，请先停止现有查看'}), 2)
            return
        owner = AdbView(device_id)
        hub.active[serial] = owner
        producer = asyncio.create_task(hub.stream(socket, serial, device_id))
        receiver = asyncio.create_task(socket.receive())
        revocation = asyncio.create_task(owner.revoked.wait())
        tasks = [producer, receiver, revocation]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        if revocation in done:
            raise BindingError('手机配对状态已改变，已停止投屏')
        elif receiver in done:
            if receiver.result()['type'] != 'websocket.disconnect':
                raise ValueError('unexpected ADB screen control')
        else:
            producer.result()
    except (HTTPException, ValueError, TypeError, AttributeError):
        await socket.close(code=1008)
    except WebSocketDisconnect:
        pass
    except (adb.AdbError, OSError, RuntimeError, asyncio.TimeoutError) as exc:
        with anyio.CancelScope(shield=True):
            # Revoke/stop the physical capture before any client-dependent I/O.
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            try:
                await asyncio.wait_for(socket.send_json({'type': 'screen.status', 'state': 'error',
                                        'reason': 'binding' if isinstance(exc, BindingError) else 'unavailable' if isinstance(exc, AdbUnavailable) else 'encoder',
                                        'detail': str(exc)[:200] or 'ADB 画面传输超时'}), 2)
            except (RuntimeError, WebSocketDisconnect, asyncio.TimeoutError):
                pass
    finally:
        with anyio.CancelScope(shield=True):
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if serial is not None and hub.active.get(serial) is owner:
                del hub.active[serial]
            try:
                await asyncio.wait_for(socket.close(), 2)
            except (RuntimeError, WebSocketDisconnect, asyncio.TimeoutError):
                pass
