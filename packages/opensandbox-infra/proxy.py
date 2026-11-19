#!/usr/bin/env python3
"""Expose an existing loopback HTTP proxy to containers on Docker's bridge only."""

import argparse
import asyncio
import contextlib
import json
import subprocess
import urllib.parse

DEFAULT_LISTEN_PORT = 17890
CONNECT_TIMEOUT_SECONDS = 10


async def serve(upstream: str, port: int) -> None:
    target = urllib.parse.urlsplit(upstream)
    if target.scheme != "http" or target.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("--upstream must be an existing HTTP proxy on host loopback")
    if target.username or target.password or target.path not in {"", "/"}:
        raise ValueError("--upstream must be an origin without credentials")
    gateway = json.loads(
        subprocess.check_output(["docker", "network", "inspect", "bridge"], text=True)
    )[0]["IPAM"]["Config"][0]["Gateway"]

    async def relay(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        remote_writer = None
        try:
            remote_reader, remote_writer = await asyncio.wait_for(
                asyncio.open_connection(target.hostname, target.port or 80),
                timeout=CONNECT_TIMEOUT_SECONDS,
            )

            async def copy(source: asyncio.StreamReader, destination: asyncio.StreamWriter) -> None:
                while data := await source.read(65536):
                    destination.write(data)
                    await destination.drain()
                if destination.can_write_eof():
                    destination.write_eof()

            async with asyncio.TaskGroup() as group:
                group.create_task(copy(reader, remote_writer))
                group.create_task(copy(remote_reader, writer))
        except (OSError, TimeoutError, ExceptionGroup):
            pass
        finally:
            writer.close()
            if remote_writer:
                remote_writer.close()

    server = await asyncio.start_server(relay, gateway, port)
    print(f"Docker bridge proxy: http://{gateway}:{port}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, help="e.g. http://127.0.0.1:7890")
    parser.add_argument("--port", type=int, default=DEFAULT_LISTEN_PORT)
    args = parser.parse_args()
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(serve(args.upstream, args.port))
