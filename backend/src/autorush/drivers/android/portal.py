"""Deterministic Android actions over the authenticated reverse-WebSocket Portal."""
from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Any
from uuid import UUID

from autorush.devices.hub import DeviceHub
from autorush.assertions.evaluate import evaluate_assertion
from autorush.domain.models import StepSpec
from autorush.drivers.base import ActionResult, DriverBlockedError
from autorush.evidence.screenshot import record_screenshot

OPERATIONS = {"android.launch", "android.inspect", "android.tap", "android.input_text", "android.swipe", "android.back"}


def validate_android_step(step: StepSpec) -> None:
    if step.operation not in OPERATIONS:
        raise ValueError("unsupported Android operation")
    params = step.parameters
    allowed = {
        "android.launch": set(), "android.inspect": {"target", "timeout_ms"}, "android.tap": {"target"},
        "android.input_text": {"target", "text"}, "android.swipe": {"from_x", "from_y", "to_x", "to_y", "duration_ms"},
        "android.back": set(),
    }[step.operation]
    if set(params) - allowed:
        raise ValueError("unsupported Android parameters")
    if "timeout_ms" in params and (type(params["timeout_ms"]) is not int or not 100 <= params["timeout_ms"] <= 10000):
        raise ValueError("Android inspection timeout must be 100..10000 ms")
    if step.operation in {"android.tap", "android.input_text"} or "target" in params:
        target = params.get("target")
        if not isinstance(target, dict) or len(target) != 1 or not set(target) <= {"resource_id", "text", "description"}:
            raise ValueError("Android target requires exactly one resource_id, text or description")
        if not isinstance(next(iter(target.values())), str) or not next(iter(target.values())).strip():
            raise ValueError("Android target must be a non-empty string")
    if step.operation == "android.input_text" and (not isinstance(params.get("text"), str) or len(params["text"]) > 2000):
        raise ValueError("Android text must contain at most 2000 characters")
    if step.operation == "android.swipe":
        if any(type(params.get(key)) is not int or params[key] < 0 for key in ("from_x", "from_y", "to_x", "to_y")):
            raise ValueError("Android swipe requires non-negative integer coordinates")
        if type(params.get("duration_ms", 400)) is not int or not 100 <= params.get("duration_ms", 400) <= 2000:
            raise ValueError("Android swipe duration must be 100..2000 ms")
    if any(item.kind not in {"element_visible", "text_contains", "package_equals"} for item in step.assertions):
        raise ValueError("unsupported Android assertion")
    if step.assertions and step.operation != "android.inspect":
        raise ValueError("Android assertions require android.inspect")


class AndroidPortalDriver:
    def __init__(self, hub: DeviceHub, device_id: UUID, package: str, lease: UUID, *,
                 capture_screenshots: bool = False, evidence_directory: Path | None = None, run_id: UUID | None = None):
        self._hub, self._device_id, self._package, self._lease = hub, device_id, package, lease
        self._capture_screenshots, self._evidence_directory, self._run_id = capture_screenshots, evidence_directory, run_id
        self._closed = False

    @classmethod
    async def create(cls, hub: DeviceHub, device_id: UUID, package: str, **options: Any) -> "AndroidPortalDriver":
        if not re.fullmatch(r"(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*", package):
            raise ValueError("invalid Android package")
        if options.get("capture_screenshots") and (options.get("evidence_directory") is None or options.get("run_id") is None):
            raise ValueError("screenshot evidence requires a run and report directory")
        return cls(hub, device_id, package, hub.acquire(device_id), **options)

    async def _call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            return await self._hub.call(self._device_id, method, params, lease_id=self._lease)
        except (ConnectionError, asyncio.TimeoutError) as exc:
            raise DriverBlockedError("Android device disconnected or timed out") from exc

    async def _snapshot(self, *, require_complete: bool = True, allow_startup: bool = False) -> dict[str, Any]:
        snapshot = await self._call("ui.snapshot", {})
        if snapshot.get("package") != self._package:
            if allow_startup and isinstance(snapshot.get('package'),str) and snapshot['package']:
                return {'startup':True,'package':self._package,'nodes':[],'snapshot_id':'startup'}
            raise DriverBlockedError("current Android package does not match the plan target")
        if not isinstance(snapshot.get("nodes"), list) or not isinstance(snapshot.get("snapshot_id"), str):
            raise RuntimeError("device returned an invalid UI snapshot")
        if require_complete and snapshot.get("truncated", False) is not False:
            raise DriverBlockedError("Android UI snapshot is truncated; target uniqueness and assertions cannot be verified")
        return snapshot

    @staticmethod
    def _match(snapshot: dict[str, Any], target: dict[str, str]) -> list[dict[str, Any]]:
        key, expected = next(iter(target.items()))
        return [node for node in snapshot["nodes"] if isinstance(node, dict) and node.get(key) == expected and node.get("visible", True)]

    async def _inspect(self, step: StepSpec) -> ActionResult:
        deadline = asyncio.get_running_loop().time() + step.parameters.get("timeout_ms", 3000) / 1000
        target = step.parameters.get("target")
        while True:
            snapshot = await self._snapshot()
            matches = self._match(snapshot, target) if target else []
            if len(matches) > 1:
                raise DriverBlockedError("Android target is ambiguous; use a unique resource_id")
            text = (str(matches[0].get("text", "")) if matches else "") if target else "\n".join(
                str(node.get("text", "")) for node in snapshot["nodes"] if isinstance(node, dict) and node.get("visible", True)
            )
            output = {"visible": bool(matches) if target else True, "text": text, "package": self._package}
            satisfied = all(evaluate_assertion(item, output)[0] for item in step.assertions)
            if satisfied or asyncio.get_running_loop().time() >= deadline:
                return ActionResult(output, "inspect Android UI", {"ui_snapshot": snapshot})
            await asyncio.sleep(0.15)

    async def execute(self, step: StepSpec) -> ActionResult:
        if self._closed or not self._hub.owns_lease(self._device_id, self._lease):
            raise DriverBlockedError("Android execution lease is no longer active")
        if step.driver != "android":
            raise ValueError("Android driver only accepts Android steps")
        validate_android_step(step)
        operation, params = step.operation, step.parameters
        if operation == "android.launch":
            result = await self._call("app.launch", {"package": self._package})
            if result.get("launched") != self._package:
                raise RuntimeError("Android launch was not confirmed")
            return ActionResult(result, f"launch {self._package}")
        if operation == "android.inspect":
            return await self._inspect(step)
        snapshot = await self._snapshot(require_complete=operation in {"android.tap", "android.input_text"})
        target = params.get("target")
        matches = self._match(snapshot, target) if target else []
        if len(matches) > 1:
            raise DriverBlockedError("Android target is ambiguous; use a unique resource_id")
        if target:
            if not matches:
                raise DriverBlockedError("Android target was not found")
            node = matches[0]
            if type(node.get("index")) is not int:
                raise RuntimeError("device returned an invalid node index")
            action_params = {"snapshot_id": snapshot["snapshot_id"], "index": node["index"]}
            if operation == "android.input_text":
                action_params["text"] = params["text"]
            method = "ui.tap_element" if operation == "android.tap" else "ui.input_text"
        else:
            method = "ui.swipe" if operation == "android.swipe" else "ui.back"
            action_params = params
        action_params = {
            **action_params,
            "expected_package": self._package,
            "snapshot_id": snapshot["snapshot_id"],
        }
        result = await self._call(method, action_params)
        if result.get("performed") is not True:
            raise RuntimeError("Android action returned performed=false or no confirmation")
        return ActionResult(result, operation or "Android action", {"ui_snapshot": snapshot})

    async def capture_evidence(self) -> dict[str, Any]:
        if not self._capture_screenshots:
            return {}
        if self._closed or not self._hub.owns_lease(self._device_id, self._lease):
            raise DriverBlockedError("Android execution lease is no longer active")
        assert self._evidence_directory is not None and self._run_id is not None
        # Launch/activity animations can change the capture boundary after the
        # action receipt. Retry observation only; never replay the UI action.
        for attempt, delay in enumerate((0, 0.25, 0.5, 0.75)):
            if delay:
                await asyncio.sleep(delay)
            try:
                captured = await self._call("ui.screenshot", {"expected_package": self._package})
                break
            except DriverBlockedError:
                raise
            except RuntimeError:
                if attempt == 3:
                    raise
        return {"screenshot": record_screenshot(captured, self._evidence_directory, self._run_id, self._package)}

    async def observe(self):
        from autorush.agent.android_observer import collect_android_state
        return await collect_android_state(self)

    async def close(self) -> None:
        self._closed = True
        self._hub.release(self._device_id, self._lease)
