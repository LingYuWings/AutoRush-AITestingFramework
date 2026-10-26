"""Small reverse-WebSocket registry. The phone enforces its own package allowlist."""

from __future__ import annotations

import asyncio
from contextlib import nullcontext
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID, uuid4

from fastapi import WebSocket, WebSocketDisconnect


class DeviceAlreadyConnectedError(ValueError):
    """A transient registration conflict while an older socket is still live."""


@dataclass
class DeviceSession:
    device_id: UUID
    websocket: WebSocket
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    pending: dict[str, asyncio.Future[dict[str, Any]]] = field(default_factory=dict)


class DeviceHub:
    def __init__(self) -> None:
        self._sessions: dict[UUID, DeviceSession] = {}
        self._leases: dict[UUID, UUID] = {}

    def list_devices(self) -> list[str]:
        return sorted(str(device_id) for device_id in self._sessions)

    def session(self, device_id: UUID) -> DeviceSession | None:
        return self._sessions.get(device_id)

    def acquire(self, device_id: UUID) -> UUID:
        if device_id not in self._sessions:
            raise ConnectionError("device is offline")
        if device_id in self._leases:
            raise RuntimeError("device is busy with another run")
        lease = uuid4()
        self._leases[device_id] = lease
        return lease

    def release(self, device_id: UUID, lease: UUID) -> None:
        if self._leases.get(device_id) == lease:
            del self._leases[device_id]

    def owns_lease(self, device_id: UUID, lease: UUID) -> bool:
        return device_id in self._sessions and self._leases.get(device_id) == lease

    def _check_access(self, device_id: UUID, lease_id: UUID | None) -> None:
        if lease_id is not None and not self.owns_lease(device_id, lease_id):
            raise ConnectionError("device execution lease expired")
        if device_id in self._leases and self._leases[device_id] != lease_id:
            raise RuntimeError("device is busy with another run")

    def register(self, device_id: UUID, websocket: WebSocket) -> DeviceSession:
        if device_id in self._sessions:
            raise DeviceAlreadyConnectedError("device already connected")
        session = DeviceSession(device_id, websocket)
        self._sessions[device_id] = session
        return session

    def unregister(self, session: DeviceSession) -> None:
        if self._sessions.get(session.device_id) is session:
            del self._sessions[session.device_id]
            self._leases.pop(session.device_id, None)
        for future in session.pending.values():
            if not future.done():
                future.set_exception(ConnectionError("device disconnected"))
        session.pending.clear()

    async def disconnect(self, device_id: UUID) -> None:
        session = self._sessions.get(device_id)
        if session is None:
            self._leases.pop(device_id, None)
            return
        self.unregister(session)
        try:
            await session.websocket.close(code=1008, reason="device credentials changed")
        except (RuntimeError, WebSocketDisconnect):
            pass

    def response(self, session: DeviceSession, message: dict[str, Any]) -> None:
        if message.get("type") != "response":
            return
        request_id = message.get("id")
        if not isinstance(request_id, str):
            return
        future = session.pending.pop(request_id, None)
        if future is not None and not future.done():
            future.set_result(message)

    async def call(self, device_id: UUID, method: str, params: dict[str, Any], *, lease_id: UUID | None = None, background_control: bool = False) -> dict[str, Any]:
        if background_control and method not in {'screen.start', 'screen.stop'}:
            raise ValueError('background control is limited to screen lifecycle')
        if not background_control:
            self._check_access(device_id, lease_id)
        session = self._sessions.get(device_id)
        if session is None:
            raise ConnectionError("device is offline")
        # Lifecycle commands have their own request IDs and are handled ahead of
        # the phone action gate. They must not wait for a long-running action.
        async with (nullcontext() if background_control else session.lock):
            if not background_control:
                self._check_access(device_id, lease_id)
            if self._sessions.get(device_id) is not session:
                raise ConnectionError("device session changed")
            request_id = uuid4().hex
            future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
            session.pending[request_id] = future
            try:
                await session.websocket.send_json({
                    "type": "command", "id": request_id, "method": method, "params": params,
                })
                response = await asyncio.wait_for(future, timeout=17)
            finally:
                session.pending.pop(request_id, None)
            if not response.get("ok"):
                raise RuntimeError(str(response.get("error", "device operation failed")))
            result = response.get("result")
            if not isinstance(result, dict):
                raise RuntimeError("device returned an invalid result")
            return result
