"""Run with python -m autorush.integrations.mcp_server; stdout is MCP only."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from mcp.server.fastmcp import FastMCP, Image
from mcp.types import ToolAnnotations

from autorush.integrations.operator import LocalOperator


def build_server(operator: LocalOperator | None = None) -> FastMCP:
    operator = operator or LocalOperator(
        base_url=os.getenv("AUTORUSH_MCP_API_URL", "http://127.0.0.1:8000"),
        console_origin=os.getenv("AUTORUSH_MCP_CONSOLE_ORIGIN", "http://127.0.0.1:5173"),
        allowed_packages=frozenset(item.strip() for item in os.getenv("AUTORUSH_MCP_ALLOWED_PACKAGES", "com.autorush.fixture").split(",") if item.strip()),
    )
    @asynccontextmanager
    async def lifespan(_):
        try:
            yield
        finally:
            await operator.close()
    server = FastMCP("AutoRush", lifespan=lifespan,
        instructions="Use only authorized test packages. Plans capture screenshot evidence after every executed step. Inspect step status and images before claiming verification.")
    read = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
    write = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)

    @server.tool(annotations=read)
    async def autorush_devices() -> dict:
        """List online Android Portal device IDs through the local platform API."""
        return await operator.devices()

    @server.tool(annotations=read)
    async def autorush_device_info(device_id: str) -> dict:
        """Read device display dimensions and Portal authorization status, without reading application content."""
        return await operator.device_info(device_id)

    @server.tool(annotations=write)
    async def autorush_prepare_android_plan(title: str, device_id: str, package: str,
                                            steps: list[dict], postconditions: list[dict]) -> dict:
        """Create and approve an Android case and a draft plan with every-step screenshot evidence. Only configured test packages and Android operations are accepted."""
        return await operator.prepare_android_plan(title, device_id, package, steps, postconditions)

    @server.tool(annotations=write)
    async def autorush_execute_plan(plan_id: str) -> dict:
        """Validate the plan scope, ready it and execute its Android case through the paired Portal. This operates the test phone; obtain human test-scope authorization first."""
        return await operator.execute_plan(plan_id)

    @server.tool(annotations=read)
    async def autorush_report(run_id: str) -> dict:
        """Read a configured-test-package run, including assertions and per-step screenshot metadata/errors."""
        return await operator.report(run_id)

    @server.tool(annotations=read)
    async def autorush_step_screenshot(run_id: str, case_index: int, step_index: int) -> Image:
        """Read a zero-based case/step screenshot, verify its recorded size and SHA-256, and return the actual JPEG for visual verification."""
        return Image(data=await operator.screenshot(run_id, case_index, step_index), format="jpeg")

    return server


def main():
    build_server().run(transport="stdio")


if __name__ == "__main__":
    main()
