"""Own the subprocess and shared leases for AutoRush's verified Qwen profiles."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import socket
import subprocess

import httpx

from autorush.llm.models import ProviderConfigRecord
from autorush.llm.protocols import model_endpoint


PROFILES = {f"autorush-vision-{size.lower()}": size for size in ("2B", "4B", "8B")}
MANAGED_ENDPOINT = "http://127.0.0.1:8080/v1/chat/completions"


class LocalVisionError(RuntimeError):
    """Report a failure to start or acquire the managed GPU runtime."""


def managed_profile(config: ProviderConfigRecord) -> str | None:
    """Limit automatic startup to the project's existing local, no-key profiles."""
    if config.protocol != "openai_chat" or config.credential_type != "local" or config.secret_ref:
        return None
    if model_endpoint(config.base_url, config.protocol) != MANAGED_ENDPOINT:
        return None
    return PROFILES.get(config.model_id)


async def stop_process(process: asyncio.subprocess.Process) -> None:
    """Reap only the child we started, releasing its GPU allocations."""
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    await process.wait()


async def spawn(*args: str, **kwargs) -> asyncio.subprocess.Process:
    """Finish acquiring the process handle even if the requesting task is cancelled."""
    task = asyncio.create_task(asyncio.create_subprocess_exec(
        *args, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), **kwargs,
    ))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await stop_process(await task)
        raise


class LocalVisionRuntime:
    """Share one owned model process across compatible runs until the last user exits."""

    def __init__(self, launcher: Path):
        self.launcher = launcher
        self._lock = asyncio.Lock()
        self._process: asyncio.subprocess.Process | None = None
        self._profile: str | None = None
        self._port: int | None = None
        self._users = 0

    async def acquire(self, profile: str) -> int:
        """Load the requested profile or join another run already using it."""
        async with self._lock:
            if self._process is None:
                self._process, self._port = await self._start(profile)
                self._profile = profile
            elif self._profile != profile:
                raise LocalVisionError("本地 GPU 正在运行另一个 Qwen 模型，请等待当前执行结束。")
            elif self._process.returncode is not None:
                raise LocalVisionError("本地模型进程已退出，请等待当前执行结束后重试。")
            self._users += 1
            assert self._port is not None
            return self._port

    async def release(self) -> None:
        """Unload weights as soon as the last run using this process completes."""
        async with self._lock:
            self._users -= 1
            if self._users == 0:
                await self._stop()

    async def close(self) -> None:
        """Stop the owned model process when the backend shuts down."""
        async with self._lock:
            await self._stop()

    async def _stop(self) -> None:
        """Keep the runtime locked until the GPU process has exited."""
        if self._process is not None:
            await stop_process(self._process)
        self._process = None
        self._profile = None
        self._port = None

    async def _start(self, profile: str) -> tuple[asyncio.subprocess.Process, int]:
        """Verify model assets, then start a private loopback server and wait for its catalog."""
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        verifier = process = None
        ready = False
        try:
            async with asyncio.timeout(65):
                verifier = await spawn(
                    "powershell.exe", "-NoProfile", "-NonInteractive", "-File", str(self.launcher),
                    "-ModelSize", profile, "-Port", str(port), "-IdleSeconds", "-1", "-CheckOnly",
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )
                output, _ = await verifier.communicate()
                if verifier.returncode != 0:
                    raise LocalVisionError("本地 Qwen 文件缺失或校验失败，请检查模型权重、投影文件和 llama.cpp。")
                command = json.loads(output)
                executable = Path(command["executable"])
                process = await spawn(
                    str(executable), *command["arguments"], cwd=executable.parent,
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                )
                async with httpx.AsyncClient(trust_env=False, timeout=1) as http:
                    while process.returncode is None:
                        try:
                            response = await http.get(f"http://127.0.0.1:{port}/v1/models")
                            if response.is_success and any(
                                item["id"] == command["alias"] for item in response.json()["data"]
                            ) and process.returncode is None:
                                break
                        except httpx.RequestError:
                            pass
                        await asyncio.sleep(0.25)
                if process.returncode is not None:
                    raise LocalVisionError("本地 Qwen 进程在加载模型时退出，请检查 llama.cpp 和可用显存。")
                ready = True
                return process, port
        except TimeoutError as exc:
            raise LocalVisionError("等待本地 Qwen 加载超时。") from exc
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise LocalVisionError("无法启动项目的本地 Qwen 服务，请检查运行时安装。") from exc
        finally:
            if verifier is not None and verifier.returncode is None:
                await stop_process(verifier)
            if process is not None and not ready:
                await stop_process(process)
