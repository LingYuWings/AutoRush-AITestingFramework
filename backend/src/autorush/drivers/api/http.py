"""Restricted HTTP driver for approved API test environments."""

from __future__ import annotations

from urllib.parse import urlsplit

import httpx
import json

from autorush.domain.models import StepSpec
from autorush.drivers.base import ActionResult


class HttpApiDriver:
    def __init__(
        self,
        base_url: str,
        allowed_hosts: set[str],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        parsed = urlsplit(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("api_base_url must be an absolute HTTP(S) URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("api_base_url cannot contain credentials, query or fragment")
        if parsed.hostname.lower() not in {host.lower() for host in allowed_hosts}:
            raise PermissionError("API host is not in AUTORUSH_ALLOWED_API_HOSTS")
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            follow_redirects=False,
            timeout=10.0,
            transport=transport,
        )
        self._base_url=base_url
        self._last_output={}

    async def execute(self, step: StepSpec) -> ActionResult:
        if step.driver != "api" or step.operation != "api.request":
            raise ValueError("HTTP driver only accepts api.request")
        method = str(step.parameters.get("method", "GET")).upper()
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}:
            raise ValueError("unsupported HTTP method")
        path = step.parameters.get("path")
        if not isinstance(path, str) or not path.startswith("/") or path.startswith("//"):
            raise ValueError("path must be an absolute path on the configured host")
        if urlsplit(path).scheme or urlsplit(path).netloc or "#" in path or "\\" in path or any(ord(char) < 32 for char in path):
            raise ValueError("path cannot change host or contain a fragment")
        response = await self._client.request(
            method,
            path.lstrip("/"),
            params=step.parameters.get("query"),
            json=step.parameters.get("json"),
            headers=step.parameters.get("headers"),
        )
        try:
            body = response.json()
        except ValueError:
            body = response.text
        self._last_output={"status_code":response.status_code,"body":body}
        return ActionResult(
            output=self._last_output,
            summary=f"{method} {path} -> {response.status_code}",
        )

    async def observe(self):
        from autorush.agent.observers import fingerprint
        output=self._last_output
        text=json.dumps(output,ensure_ascii=False,default=str)
        if len(text)>12000:
            output={'status_code':output.get('status_code'),'body':str(output.get('body'))[:10000],'truncated':True}
        return {'target':{'base_url':self._base_url},'text':text[:12000],'last_output':output,'elements':[],
                'fingerprint':fingerprint(output)}

    async def close(self) -> None:
        await self._client.aclose()
