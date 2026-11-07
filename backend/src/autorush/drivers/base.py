"""Narrow runtime protocol shared by all execution drivers."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from autorush.domain.models import StepSpec


# Carry a driver's output, summary, evidence, and assertion results.
@dataclass(frozen=True)
class ActionResult:
    output: Any
    summary: str
    evidence: dict[str, Any] = field(default_factory=dict)
    checks: list[tuple[bool, str]] = field(default_factory=list)
    status: str | None = None


# Signal that an unsafe or unavailable target blocks the action.
class DriverBlockedError(RuntimeError):
    """Execution target is unsafe or unavailable; do not run the action."""


# Define the common interface implemented by test drivers.
class Driver(Protocol):
    # Run one test step and return its output and evidence.
    async def execute(self, step: StepSpec) -> ActionResult: ...

    # Release resources held by the driver.
    async def close(self) -> None: ...
