"""Constrained PyAutoGUI actions for a trusted interactive Windows session."""

from __future__ import annotations

import asyncio
import sys
import time
from threading import Lock
from typing import Any

from autorush.domain.models import StepSpec
from autorush.drivers.base import ActionResult, DriverBlockedError
from autorush.drivers.desktop.contracts import HOTKEYS, validate_desktop_step


_DESKTOP_LEASE = Lock()
_ALLOWED_HOTKEYS = {
    ("ctrl", "a"),
    ("tab",),
    ("enter",),
    ("esc",),
}


class PyAutoGuiDesktopDriver:
    def __init__(self, backend: Any, *, expected_size: tuple[int, int], window_title: str, guard=None) -> None:
        if not isinstance(expected_size, tuple) or len(expected_size) != 2 or any(type(value) is not int or value <= 0 for value in expected_size):
            raise ValueError("expected_size must be a positive (width, height) pair")
        if not window_title or not window_title.strip():
            raise ValueError("window_title must be an exact, non-empty title")
        if not _DESKTOP_LEASE.acquire(blocking=False):
            raise DriverBlockedError("another desktop driver already owns this process session")
        try:
            self._backend = backend
            self._guard = guard
            self._backend.FAILSAFE = True
            self._expected_size = expected_size
            self._window_title = window_title
            self._action_lock = asyncio.Lock()
            self._closed = False
        except Exception:
            _DESKTOP_LEASE.release()
            raise

    @classmethod
    def from_system(cls, *, target) -> "PyAutoGuiDesktopDriver":
        if sys.platform != "win32":
            raise DriverBlockedError("the initial desktop agent only supports Windows")
        try:
            import pyautogui
        except ImportError as exc:
            raise DriverBlockedError('PyAutoGUI is not installed; run pip install -e "backend[desktop]"') from exc
        from autorush.drivers.desktop.win32 import WindowGuard
        return cls(pyautogui, expected_size=(target.screen_width,target.screen_height), window_title=target.title, guard=WindowGuard(target))

    async def execute(self, step: StepSpec) -> ActionResult:
        async with self._action_lock:
            if self._closed:
                raise DriverBlockedError("desktop session is closed")
            # Keep the action on this thread: cancelling to_thread would leave a live
            # mouse/keyboard action running after the caller thinks it has stopped.
            return self._execute_sync(step)

    def _execute_sync(self, step: StepSpec) -> ActionResult:
        validate_desktop_step(step)
        if step.driver != "desktop":
            raise ValueError("desktop driver only accepts desktop steps")
        operation = step.operation
        if operation not in {"desktop.click", "desktop.write", "desktop.hotkey", "desktop.inspect_pixel", "desktop.scroll"}:
            raise ValueError(f"unsupported desktop operation: {operation}")
        parameters = step.parameters
        try:
            self._preflight()
            if operation == 'desktop.scroll':
                x,y=self._coordinates(parameters)
                self._backend.moveTo(x,y)
                self._preflight()
                # PyAutoGUI 0.9.54 forwards this value as raw Windows wheel
                # delta. One detent is WHEEL_DELTA=120, not a delta of one.
                delta=parameters['clicks']*(120 if sys.platform=='win32' else 1)
                self._backend.scroll(delta,x=x,y=y)
                return ActionResult(output={'x':x,'y':y},summary='scroll target window')
            if operation == "desktop.click":
                x, y = self._coordinates(parameters)
                button = parameters.get("button", "left")
                if button not in {"left", "middle", "right"}:
                    raise ValueError("button must be left, middle or right")
                self._backend.click(x=x, y=y, button=button)
                return ActionResult(output={"x": x, "y": y}, summary=f"click {button} at ({x}, {y})")
            if operation == "desktop.write":
                value = parameters.get("text")
                if not isinstance(value, str) or not value or len(value) > 1000 or not value.isascii() or not value.isprintable():
                    raise ValueError("desktop.write requires 1-1000 printable ASCII characters")
                for character in value:
                    self._preflight()
                    if self._guard is not None:
                        self._backend.write(character, interval=0.01, _pause=False)
                    else:
                        self._backend.write(character, interval=0.01)
                self._preflight()
                if self._guard is not None:
                    time.sleep(self._backend.PAUSE)
                return ActionResult(output={}, summary=f"type {len(value)} characters")
            if operation == "desktop.hotkey":
                keys = parameters.get("keys")
                if not isinstance(keys, list) or any(not isinstance(key, str) for key in keys) or tuple(keys) not in HOTKEYS:
                    raise ValueError("hotkey is not in the initial allowlist")
                if self._guard is not None:
                    # One native insertion contains all down/up events; killing the
                    # worker cannot split separate Python keyDown/keyUp calls.
                    self._guard.api.hotkey(keys)
                    time.sleep(self._backend.PAUSE)
                else:
                    try: self._backend.hotkey(*keys)
                    finally:
                        for key in reversed(keys):
                            if key in {'ctrl','shift'} and hasattr(self._backend,'keyUp'): self._backend.keyUp(key)
                return ActionResult(output={}, summary="press approved hotkey")
            x, y = self._coordinates(parameters)
            rgb = list(self._backend.pixel(x, y))[:3]
            return ActionResult(output={"rgb": rgb}, summary=f"inspect pixel at ({x}, {y})")
        except self._backend.FailSafeException as exc:
            raise DriverBlockedError("PyAutoGUI fail-safe triggered; desktop actions stopped") from exc

    def _preflight(self) -> None:
        if self._guard is not None: self._guard.check()
        self._backend.FAILSAFE = True
        actual_size = tuple(self._backend.size())
        if actual_size != self._expected_size:
            raise DriverBlockedError(f"screen resolution changed: expected {self._expected_size}, got {actual_size}")
        active_title = self._backend.getActiveWindowTitle()
        if active_title != self._window_title:
            raise DriverBlockedError("active window title does not match the approved desktop target")
        x, y = self._backend.position()
        width, height = actual_size
        if x in {0, width - 1} and y in {0, height - 1}:
            raise DriverBlockedError("mouse is in a fail-safe screen corner")

    def _coordinates(self, parameters: dict[str, Any]) -> tuple[int, int]:
        x, y = parameters.get("x"), parameters.get("y")
        if self._guard is not None: return self._guard.screen_point(x,y)
        if type(x) is not int or type(y) is not int:
            raise ValueError("desktop coordinates must be integers")
        width, height = self._expected_size
        if not 0 <= x < width or not 0 <= y < height:
            raise ValueError("desktop coordinates are outside the approved screen")
        if x in {0, width - 1} and y in {0, height - 1}:
            raise ValueError("desktop actions cannot target fail-safe screen corners")
        return x, y

    def capture_image(self):
        if self._guard is None: raise DriverBlockedError('screenshots require an identity-bound target')
        self._preflight()
        rect=self._guard.check()
        image=self._backend.screenshot(region=rect)
        self._preflight()
        if self._guard.check()!=rect: raise DriverBlockedError('target moved during screenshot')
        return image

    async def close(self) -> None:
        async with self._action_lock:
            if not self._closed:
                self._closed = True
                _DESKTOP_LEASE.release()
