"""Scoped local operator: no device secrets, arbitrary URLs or filesystem reads."""
from __future__ import annotations

import hashlib
import re
from urllib.parse import urlsplit
from uuid import UUID

import httpx

from autorush.domain.models import CaseCreate
from autorush.drivers.android.portal import validate_android_step


class LocalOperator:
    def __init__(self, base_url: str = "http://127.0.0.1:8000", *,
                 allowed_packages: frozenset[str] = frozenset({"com.autorush.fixture"}),
                 console_origin: str = "http://127.0.0.1:5173", transport=None):
        url = urlsplit(base_url)
        if (url.scheme != "http" or url.hostname not in {"127.0.0.1", "::1", "localhost"}
            or url.username is not None or url.password is not None or url.path not in {"", "/"}
            or url.query or url.fragment or not url.port):
            raise ValueError("MCP requires a plain loopback API origin with an explicit port")
        if not allowed_packages or any(not re.fullmatch(r"(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*", item) for item in allowed_packages):
            raise ValueError("configure at least one valid authorized Android test package")
        self.allowed_packages = allowed_packages
        self.console_origin = console_origin
        self._token = None
        self._client = httpx.AsyncClient(base_url=base_url, transport=transport, trust_env=False,
                                        follow_redirects=False, timeout=120)

    async def _request(self, method: str, path: str, payload=None):
        if self._token is None:
            response = await self._client.get("/api/v1/devices/operator-session", headers={"Origin": self.console_origin})
            response.raise_for_status()
            self._token = response.json()["operator_token"]
        response = await self._client.request(method, path, json=payload,
                                              headers={"X-Autorush-Operator-Token": self._token})
        if response.status_code == 403:
            self._token = None
            raise RuntimeError("local operator session expired; retry the tool to obtain a new session")
        if not response.is_success:
            raise RuntimeError(f"AutoRush API returned HTTP {response.status_code}")
        return response

    def _package(self, package: str):
        if package not in self.allowed_packages:
            raise ValueError("Android package is outside the configured MCP test scope")

    async def devices(self) -> dict:
        return (await self._request("GET", "/api/v1/devices")).json()

    async def device_info(self, device_id: str) -> dict:
        return (await self._request("POST", f"/api/v1/devices/{UUID(device_id)}/commands",
                                    {"method": "device.info", "params": {}})).json()

    async def prepare_android_plan(self, title: str, device_id: str, package: str, steps: list[dict], postconditions: list[dict]) -> dict:
        self._package(package)
        device = UUID(device_id)
        case = CaseCreate(title=title, steps=steps, postconditions=postconditions)
        for step in case.steps + case.postconditions:
            if step.driver != "android":
                raise ValueError("MCP Android plans accept only Android steps")
            validate_android_step(step)
        created = (await self._request("POST", "/api/v1/cases", case.model_dump(mode="json"))).json()
        await self._request("POST", f"/api/v1/cases/{UUID(created['id'])}/approve")
        return (await self._request("POST", "/api/v1/plans", {
            "name": title, "environment": "codex-local-mcp", "case_ids": [created["id"]],
            "android_device_id": str(device), "android_package": package, "capture_screenshots": True,
        })).json()

    async def execute_plan(self, plan_id: str) -> dict:
        plan_id = str(UUID(plan_id))
        plan = (await self._request("GET", f"/api/v1/plans/{plan_id}")).json()
        self._package(plan.get("android_package"))
        if not plan.get("android_device_id") or not plan.get("capture_screenshots"):
            raise ValueError("MCP execution requires an Android target and screenshot evidence")
        for case_id in plan["case_ids"]:
            case = (await self._request("GET", f"/api/v1/cases/{UUID(case_id)}")).json()
            validated = CaseCreate.model_validate(case)
            for step in validated.steps + validated.postconditions:
                if step.driver != "android":
                    raise ValueError("MCP execution accepts only Android steps")
                validate_android_step(step)
        await self._request("POST", f"/api/v1/plans/{plan_id}/ready")
        return (await self._request("POST", f"/api/v1/plans/{plan_id}/runs")).json()

    async def report(self, run_id: str) -> dict:
        result = (await self._request("GET", f"/api/v1/runs/{UUID(run_id)}")).json()
        plan = (await self._request("GET", f"/api/v1/plans/{UUID(result['plan_id'])}")).json()
        self._package(plan.get("android_package"))
        # Host-specific report filesystem paths are not needed by the agent.
        result.pop("report_path", None)
        result.pop("report_paths", None)
        return result

    async def screenshot(self, run_id: str, case_index: int, step_index: int) -> bytes:
        run_id = str(UUID(run_id))
        result = await self.report(run_id)
        if type(case_index) is not int or type(step_index) is not int or min(case_index, step_index) < 0:
            raise ValueError("screenshot indices must be non-negative integers")
        try:
            meta = result["cases"][case_index]["steps"][step_index]["evidence"]["screenshot"]
        except (IndexError, KeyError) as exc:
            raise ValueError("step has no screenshot evidence") from exc
        self._package(meta.get("package"))
        if meta.get("mime_type") != "image/jpeg" or not re.fullmatch(rf"/api/v1/runs/{run_id}/evidence/[a-f0-9]{{32}}\.jpg", meta.get("url", "")):
            raise ValueError("invalid screenshot evidence URL")
        response = await self._request("GET", meta["url"])
        jpeg = response.content
        if (response.headers.get("content-type", "").split(";")[0] != "image/jpeg" or len(jpeg) > 1_000_000
            or len(jpeg) != meta.get("bytes") or hashlib.sha256(jpeg).hexdigest() != meta.get("sha256")):
            raise ValueError("screenshot evidence checksum, format or size mismatch")
        return jpeg

    async def close(self):
        self._token = None
        await self._client.aclose()
