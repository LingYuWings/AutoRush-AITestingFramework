"""Bounded fan-out broker used by the local WebSocket event stream."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class PlatformEvent(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    type: Literal["stream.ready", "run.started", "case.completed", "report.ready", "agent.action.completed", "agent.run.failed"]
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    payload: dict[str, Any]


class EventBroker:
    """Fan events out without allowing one slow client to block a test run."""

    def __init__(self, queue_size: int = 32) -> None:
        if queue_size < 1:
            raise ValueError("queue_size must be positive")
        self._queue_size = queue_size
        self._subscribers: set[asyncio.Queue[PlatformEvent]] = set()

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[PlatformEvent]]:
        queue: asyncio.Queue[PlatformEvent] = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    async def publish(self, event: PlatformEvent) -> None:
        for queue in tuple(self._subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(event)
