"""Small, host-restricted Playwright driver for approved test sites."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlsplit
import asyncio
import io
import time
from pathlib import Path
from uuid import UUID

from autorush.domain.models import StepSpec
from autorush.drivers.base import ActionResult
from autorush.drivers.web.validation import validate_web_step


class PlaywrightWebDriver:
    def __init__(
        self,
        base_url: str,
        allowed_hosts: set[str],
        page: Any,
        closer: Callable[[], Awaitable[None]],
        *, capture_screenshots: bool = False, evidence_directory: Path | None = None, run_id: UUID | None = None,
    ) -> None:
        parsed = urlsplit(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("web_base_url must be an absolute HTTP(S) origin")
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
            raise ValueError("web_base_url must contain only scheme, host and optional port")
        self._allowed_hosts = {host.lower() for host in allowed_hosts}
        if parsed.hostname.lower() not in self._allowed_hosts:
            raise PermissionError("Web host is not in AUTORUSH_ALLOWED_WEB_HOSTS")
        self._origin = f"{parsed.scheme}://{parsed.netloc}"
        self._page = page
        self._closer = closer
        self._capture = capture_screenshots
        self._evidence_directory, self._run_id = evidence_directory, run_id
        self._closing = None
        if capture_screenshots and (evidence_directory is None or run_id is None):
            raise ValueError('screenshot storage is not configured')

    @classmethod
    async def create(cls, base_url: str, allowed_hosts: set[str], *, headless: bool = True,
                     viewport: dict | None = None, capture_screenshots: bool = False,
                     evidence_directory: Path | None = None, run_id: UUID | None = None) -> "PlaywrightWebDriver":
        # Validate before launching a browser, including the explicit allowlist.
        cls(base_url, allowed_hosts, None, _noop)
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise RuntimeError('Playwright is not installed; run pip install -e "backend[web]"') from exc

        starting = asyncio.create_task(async_playwright().start())
        try:
            playwright = await asyncio.shield(starting)
        except asyncio.CancelledError:
            playwright = await starting
            await asyncio.shield(playwright.stop())
            raise
        browser = None
        context = None
        try:
            browser = await playwright.chromium.launch(headless=headless)
            context = await browser.new_context(viewport=viewport or {'width': 1280, 'height': 800}, service_workers='block')
            allowed = {host.lower() for host in allowed_hosts}

            async def guard(route: Any) -> None:
                target = urlsplit(route.request.url)
                if target.scheme in {"http", "https"} and target.hostname and target.hostname.lower() in allowed:
                    await route.continue_()
                else:
                    await route.abort("blockedbyclient")

            await context.route("**/*", guard)
            page = await context.new_page()
            page.set_default_timeout(10_000)
            page.set_default_navigation_timeout(15_000)

            async def closer() -> None:
                try:
                    await context.close()
                finally:
                    try: await browser.close()
                    finally: await playwright.stop()

            return cls(base_url, allowed_hosts, page, closer, capture_screenshots=capture_screenshots,
                       evidence_directory=evidence_directory, run_id=run_id)
        except BaseException:
            try:
                if context is not None: await context.close()
            finally:
                try:
                    if browser is not None: await browser.close()
                finally: await playwright.stop()
            raise

    async def execute(self, step: StepSpec) -> ActionResult:
        validate_web_step(step)
        if step.driver != "web":
            raise ValueError("Playwright driver only accepts web steps")
        operation = step.operation
        if operation == "web.open":
            path = step.parameters.get("path")
            if not isinstance(path, str) or not path.startswith("/") or path.startswith("//"):
                raise ValueError("web.open requires an absolute path on the configured host")
            parsed = urlsplit(path)
            if parsed.scheme or parsed.netloc or parsed.fragment or "\\" in path or any(ord(char) < 32 for char in path):
                raise ValueError("web.open path cannot change host or contain a fragment")
            await self._page.goto(self._origin + path, wait_until="domcontentloaded")
            self._assert_page_allowed()
            return ActionResult(output={"url": self._page.url}, summary=f"open {path}")
        if operation not in {"web.click", "web.fill", "web.inspect", "web.press", "web.select", "web.wait"}:
            raise ValueError(f"unsupported Web operation: {operation}")
        self._assert_page_allowed()
        locator = self._locator(step.parameters)
        if operation in {'web.press', 'web.select', 'web.wait'}:
            if operation == 'web.press': await locator.press(step.parameters['key'])
            elif operation == 'web.select': await locator.select_option(step.parameters['value'])
            else: await locator.wait_for(state=step.parameters.get('state', 'visible'), timeout=step.parameters.get('timeout_ms', 10000))
            self._assert_page_allowed()
            return ActionResult(output={'url': self._page.url}, summary=operation)
        if operation == "web.click":
            await locator.click()
            self._assert_page_allowed()
            return ActionResult(output={"url": self._page.url}, summary="click element")
        if operation == "web.fill":
            value = step.parameters.get("value")
            if not isinstance(value, str):
                raise ValueError("web.fill requires a string value")
            await locator.fill(value)
            self._assert_page_allowed()
            return ActionResult(output={"url": self._page.url}, summary="fill element")
        visible = await locator.is_visible()
        rendered_text = await locator.inner_text() if visible else ""
        return ActionResult(
            output={"url": self._page.url, "visible": visible, "text": rendered_text[:4000]},
            summary="inspect element",
        )

    async def observe(self):
        from autorush.agent.web_observer import collect_web_state
        return await collect_web_state(self)

    def _locator(self, parameters: dict[str, Any]) -> Any:
        target = parameters.get("target")
        if not isinstance(target, dict):
            raise ValueError("Web action requires a target object")
        keys = [key for key in ("role", "label", "test_id", "css") if key in target]
        if len(keys) != 1:
            raise ValueError("target must specify exactly one of role, label, test_id, css")
        key = keys[0]
        value = target[key]
        if not isinstance(value, str) or not value:
            raise ValueError("target locator must be a non-empty string")
        if key == "role":
            name = target.get("name")
            if name is not None and (not isinstance(name, str) or not name):
                raise ValueError("target name must be a non-empty string")
            return self._page.get_by_role(value, name=name) if name is not None else self._page.get_by_role(value)
        if "name" in target:
            raise ValueError("target name is only valid with role")
        if key == "label":
            return self._page.get_by_label(value)
        if key == "test_id":
            return self._page.get_by_test_id(value)
        return self._page.locator(value)

    def _assert_page_allowed(self) -> None:
        parsed = urlsplit(self._page.url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.hostname.lower() not in self._allowed_hosts:
            raise PermissionError("browser navigated outside AUTORUSH_ALLOWED_WEB_HOSTS")

    async def close(self) -> None:
        if self._closing is None: self._closing = asyncio.create_task(self._closer())
        await asyncio.shield(self._closing)

    async def capture_evidence(self) -> dict:
        if not self._capture: return {}
        self._assert_page_allowed()
        if self._page.is_closed(): raise RuntimeError('browser page is closed')
        from PIL import Image,ImageDraw
        import math
        from autorush.evidence.images import encode_jpeg, record_local_image
        # Playwright mask injects a visible X-PW-GLASS overlay in headed browsers.
        # Redact the in-memory bitmap instead; never mutate the tested page for evidence.
        async def password_boxes():
            boxes=[]
            for frame in self._page.frames:
                fields=await frame.locator('input[type="password"]').all()
                if len(fields)>200:raise RuntimeError('too many password fields for bounded redaction')
                for field in fields:
                    box=await field.bounding_box(timeout=2000)
                    if box:boxes.append(box)
            return boxes
        captured_url=self._page.url
        boxes=await password_boxes()
        data = await self._page.screenshot(type='png', full_page=False,caret='initial',scale='css',timeout=5000)
        self._assert_page_allowed()
        if self._page.url!=captured_url or await password_boxes()!=boxes:
            raise RuntimeError('page or password layout changed during evidence capture')
        with Image.open(io.BytesIO(data)) as image:
            draw=ImageDraw.Draw(image)
            for box in boxes:
                left=max(0,math.floor(box['x'])-2);top=max(0,math.floor(box['y'])-2)
                right=min(image.width-1,math.ceil(box['x']+box['width'])+2)
                bottom=min(image.height-1,math.ceil(box['y']+box['height'])+2)
                if right>=left and bottom>=top:draw.rectangle((left,top,right,bottom),fill='black')
            jpeg, width, height = encode_jpeg(image)
        return {'screenshot': record_local_image(jpeg, report_dir=self._evidence_directory, run_id=self._run_id,
            driver='web', target={'url': self._page.url[:2000]}, width=width, height=height, captured_at=int(time.time()*1000))}


async def _noop() -> None:
    return None
