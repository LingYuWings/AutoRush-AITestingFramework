"""Narrow runtime protocol shared by all execution drivers."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from autorush.domain.models import StepSpec


@dataclass(frozen=True)
class ActionResult:
    output: Any
    summary: str
    evidence: dict[str, Any] = field(default_factory=dict)
    checks: list[tuple[bool, str]] = field(default_factory=list)
    status: str | None = None


class DriverBlockedError(RuntimeError):
    """Execution target is unsafe or unavailable; do not run the action."""


class Driver(Protocol):
    async def execute(self, step: StepSpec) -> ActionResult: ...

    async def close(self) -> None: ...
