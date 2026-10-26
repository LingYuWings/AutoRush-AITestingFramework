"""Authenticated, session-bound live JPEG relay with latest-frame backpressure."""
from __future__ import annotations

import asyncio
import json
import re
import struct
import anyio
from dataclasses import dataclass, field
from uuid import UUID, uuid4

from fastapi import HTTPException, WebSocket, WebSocketDisconnect

from autorush.devices.hub import DeviceSession


def parse_frame(data: bytes) -> dict:
    if not 12 <= len(data) <= 602_056 or data[:4] != b'ARF1':
        raise ValueError('invalid screen frame envelope')
    length = struct.unpack('!I', data[4:8])[0]
    if not 1 <= length <= 2048 or 8 + length >= len(data):
        raise ValueError('invalid screen frame header')
    try:
        header = json.loads(data[8:8 + length])
        if set(header) != {'stream_id', 'sequence', 'width', 'height', 'package', 'captured_at'}:
            raise ValueError()
        UUID(header['stream_id'])
        for name, upper in [('sequence', 2**53 - 1), ('captured_at', 2**53 - 1), ('width', 1280), ('height', 1280)]:
            if type(header[name]) is not int or not 1 <= header[name] <= upper:
                raise ValueError()
        if not isinstance(header['package'], str) or len(header['package']) > 200 or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.]*', header['package']):
            raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise ValueError('invalid screen frame metadata') from exc
    jpeg = data[8 + length:]
    if len(jpeg) > 600_000 or not jpeg.startswith(b'\xff\xd8') or not jpeg.endswith(b'\xff\xd9'):
        raise ValueError('invalid screen JPEG')
    return {'type': 'frame', **header, 'data': data}


@dataclass
class ScreenView:
    session: DeviceSession
    mode: str
    stream_id: UUID = field(default_factory=uuid4)
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=1))
    sequence: int = 0


class ScreenHub:
    def __init__(self):
        self.views: dict[UUID, ScreenView] = {}

    def attach(self, session: DeviceSession, mode: str) -> ScreenView:
        if session.device_id in self.views:
            raise RuntimeError('device already has a screen viewer')
        view = ScreenView(session, mode)
        self.views[session.device_id] = view
        return view

    def detach(self, view: ScreenView):
        if self.views.get(view.session.device_id) is view:
            del self.views[view.session.device_id]
        while not view.queue.empty():
            view.queue.get_nowait()

    @staticmethod
    def _latest(view: ScreenView, event: dict):
        if view.queue.full():
            view.queue.get_nowait()
        view.queue.put_nowait(event)

    def frame(self, session: DeviceSession, data: bytes):
        parsed = parse_frame(data)
        view = self.views.get(session.device_id)
        if (view is None or view.session is not session or parsed['stream_id'] != str(view.stream_id)
            or parsed['sequence'] <= view.sequence):
            return
        view.sequence = parsed['sequence']
        self._latest(view, parsed)

    def status(self, session: DeviceSession, message: dict):
        view = self.views.get(session.device_id)
        if view is None or view.session is not session or message.get('stream_id') != str(view.stream_id):
            return
        state = message.get('state')
        if state not in {'permission_required', 'blocked', 'streaming', 'stopped', 'error'}:
            return
        self._latest(view, {'type': 'screen.status', 'state': state, 'detail': str(message.get('detail', ''))[:200]})

    def disconnected(self, session: DeviceSession):
        view = self.views.get(session.device_id)
        if view and view.session is session:
            self._latest(view, {'type': 'screen.status', 'state': 'offline', 'detail': '手机已断开连接'})


async def serve_viewer(websocket: WebSocket, device_id: UUID, hub, screens: ScreenHub, require_operator, allowed_origins):
    if websocket.headers.get('origin') not in allowed_origins:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    view = None
    receive_task = None
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), 5)
        if len(raw) > 4096:
            raise ValueError()
        auth = json.loads(raw)
        if (not isinstance(auth, dict) or set(auth) != {'type', 'operator_token', 'mode'}
            or auth['type'] != 'screen.auth' or auth['mode'] not in {'preview', 'smooth'} or not isinstance(auth['operator_token'], str)):
            raise ValueError()
        require_operator(auth['operator_token'])
        if auth['mode'] == 'smooth':
            await websocket.send_json({'type': 'screen.status', 'state': 'error', 'reason': 'moved_to_adb',
                                       'detail': '流畅投屏已改为 ADB H.264，请刷新管理台并选择已配对的 ADB 手机；远程请使用截图预览'})
            await websocket.close()
            return
        session = hub.session(device_id)
        if session is None:
            raise ConnectionError('手机离线，请先连接 Portal')
        view = screens.attach(session, auth['mode'])
        await websocket.send_json({'type': 'screen.ready', 'mode': view.mode, 'stream_id': str(view.stream_id)})
        await hub.call(device_id, 'screen.start', {'stream_id': str(view.stream_id), 'mode': view.mode}, background_control=True)
        receive_task = asyncio.create_task(websocket.receive())
        while True:
            event_task = asyncio.create_task(view.queue.get())
            try:
                done, _ = await asyncio.wait({event_task, receive_task}, return_when=asyncio.FIRST_COMPLETED)
                if receive_task in done:
                    message = receive_task.result()
                    if message['type'] == 'websocket.disconnect':
                        break
                    # ACKs are accepted only while a frame is outstanding.
                    raise ValueError('unexpected screen control')
                event = event_task.result()
                if event['type'] == 'frame':
                    await asyncio.wait_for(websocket.send_bytes(event['data']), 3)
                    received = await asyncio.wait_for(asyncio.shield(receive_task), 5)
                    if received['type'] == 'websocket.disconnect':
                        break
                    raw_ack = received.get('text', '')
                    if len(raw_ack) > 256:
                        raise ValueError()
                    ack = json.loads(raw_ack)
                    if ack != {'type': 'frame.ack', 'sequence': event['sequence']}:
                        raise ValueError('invalid screen frame ACK')
                    receive_task = asyncio.create_task(websocket.receive())
                else:
                    await asyncio.wait_for(websocket.send_json(event), 3)
                    if event['state'] in {'offline', 'stopped', 'error'}:
                        break
            finally:
                if not event_task.done():
                    event_task.cancel()
                await asyncio.gather(event_task, return_exceptions=True)
    except (HTTPException, ValueError, TypeError, json.JSONDecodeError):
        await websocket.close(code=1008)
    except (ConnectionError, RuntimeError, asyncio.TimeoutError) as exc:
        try:
            await websocket.send_json({'type': 'screen.status', 'state': 'error', 'detail': str(exc)[:200]})
            await websocket.close(code=1013)
        except (RuntimeError, WebSocketDisconnect):
            pass
    except WebSocketDisconnect:
        pass
    finally:
        # ASGI cancels a disconnected request. Cleanup must still reach the
        # authenticated phone, while remaining bounded if it stops responding.
        with anyio.CancelScope(shield=True):
            if receive_task:
                receive_task.cancel()
                await asyncio.gather(receive_task, return_exceptions=True)
            if view:
                screens.detach(view)
                if hub.session(device_id) is view.session:
                    try:
                        await asyncio.wait_for(hub.call(device_id, 'screen.stop', {'stream_id': str(view.stream_id)}, background_control=True), 5)
                    except (ConnectionError, RuntimeError, asyncio.TimeoutError):
                        pass
