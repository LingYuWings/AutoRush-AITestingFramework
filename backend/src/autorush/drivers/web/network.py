"""Session-owned SOCKS5 CONNECT gate for Chromium HTTP(S) and WebSocket traffic."""
from __future__ import annotations

import asyncio
from ipaddress import ip_address


async def _relay(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    while data := await reader.read(65536):
        writer.write(data)
        await writer.drain()
    writer.write_eof()


class BrowserNetworkGate:
    def __init__(self, allowed_hosts: set[str]) -> None:
        self._allowed = {host.lower() for host in allowed_hosts}
        self._connections: dict[asyncio.Task[None], asyncio.StreamWriter] = {}
        self._server: asyncio.Server | None = None

    async def start(self) -> dict[str, str]:
        self._server = await asyncio.start_server(self._accept, "127.0.0.1", 0)
        port = self._server.sockets[0].getsockname()[1]
        # Chromium otherwise bypasses a configured proxy for loopback hosts.
        return {"server": f"socks5://127.0.0.1:{port}", "bypass": "<-loopback>"}

    def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if self._server is None or len(self._connections) >= 256:
            writer.close()
            return
        task = asyncio.create_task(self._serve(reader, writer))
        self._connections[task] = writer
        task.add_done_callback(self._connections.pop)

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        upstream_writer = None
        try:
            async with asyncio.timeout(10):
                version, count = await reader.readexactly(2)
                if version != 5 or not count:
                    return
                if 0 not in await reader.readexactly(count):
                    writer.write(b"\x05\xff")
                    await writer.drain()
                    return
                writer.write(b"\x05\x00")
                await writer.drain()
                version, command, reserved, address_type = await reader.readexactly(4)
                if (version, command, reserved) != (5, 1, 0):
                    return
                if address_type == 3:
                    length = (await reader.readexactly(1))[0]
                    host = (await reader.readexactly(length)).decode("ascii").lower()
                elif address_type in (1, 4):
                    host = str(ip_address(await reader.readexactly(4 if address_type == 1 else 16)))
                else:
                    return
                port = int.from_bytes(await reader.readexactly(2), "big")
                reply = b"\x05%s\x00\x01\x00\x00\x00\x00\x00\x00"
                if host not in self._allowed or not port:
                    writer.write(reply % b"\x02")
                    await writer.drain()
                    return
                try:
                    upstream, upstream_writer = await asyncio.open_connection(host, port)
                except OSError:
                    writer.write(reply % b"\x04")
                    await writer.drain()
                    return
                writer.write(reply % b"\x00")
                await writer.drain()
            forward = asyncio.create_task(_relay(reader, upstream_writer))
            backward = asyncio.create_task(_relay(upstream, writer))
            try:
                await asyncio.gather(forward, backward)
            finally:
                forward.cancel()
                backward.cancel()
                await asyncio.gather(forward, backward, return_exceptions=True)
        except (asyncio.IncompleteReadError, OSError, TimeoutError, ValueError):
            pass
        finally:
            streams = (writer,) if upstream_writer is None else (writer, upstream_writer)
            # Teardown must finish even when a peer has stopped reading.
            for stream in streams:
                stream.transport.abort()
            await asyncio.gather(
                *(stream.wait_closed() for stream in streams),
                return_exceptions=True,
            )

    async def close(self) -> None:
        server, self._server = self._server, None
        if server is None:
            return
        server.close()
        connections = tuple(self._connections.items())
        for task, writer in connections:
            # The task might not yet have entered its finally block.
            writer.transport.abort()
            task.cancel()
        await asyncio.gather(*(task for task, _ in connections), return_exceptions=True)
        await server.wait_closed()
