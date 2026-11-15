#!/usr/bin/env python3
"""Run real OpenCode shell calls with managed delivery; no model or external API calls."""

import argparse
import asyncio
import json
import os
import socket
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / "packages/sandbox-runtime/src"))
import httpx
from sandbox_runtime.tracing.config import configure_execution_trace, ensure_trace_ready
from sandbox_runtime.tracing.managed import ManagedCapture


async def main(args):
    work = Path("/tmp/managed-probe")
    work.mkdir()
    config_dir = work / "config"
    config_dir.mkdir()
    for name in ("node_modules", "package.json", "package-lock.json"):
        source = Path("/app/opencode-deps") / name
        if source.exists():
            (config_dir / name).symlink_to(source, target_is_directory=source.is_dir())
    os.environ.update(
        {
            "SESSION_CONFIG": json.dumps(
                {
                    "session_id": args.session,
                    "parent_session_id": args.parent,
                    "execution_trace": {
                        "mode": "process",
                        "runId": args.run_id,
                        "attemptId": args.attempt_id,
                        "endpoint": args.endpoint,
                    },
                }
            ),
            "SANDBOX_ID": args.session + "-sandbox",
            "OI_RUNTIME_BOOT_ID": str(uuid.uuid4()),
            "OPENCODE_CONFIG_DIR": str(config_dir),
            "OPENCODE_DISABLE_AUTOUPDATE": "true",
            "OPENCODE_DISABLE_MODELS_FETCH": "true",
        }
    )
    capture = await ManagedCapture.start()
    config = {"permission": {"*": "allow"}}
    additions, _ = configure_execution_trace(work, os.environ, config)
    environment = {**os.environ, **additions, "OPENCODE_CONFIG_CONTENT": json.dumps(config)}
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    log = (work / "opencode.log").open("w")
    server = await asyncio.create_subprocess_exec(
        "opencode",
        "serve",
        "--port",
        str(port),
        "--hostname",
        "127.0.0.1",
        env=environment,
        cwd=work,
        stdout=log,
        stderr=log,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        async with httpx.AsyncClient(timeout=40, trust_env=False) as client:
            for _ in range(100):
                try:
                    response = await client.get(url + "/global/health", timeout=1)
                    if response.is_success:
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.1)
            await ensure_trace_ready(
                capture.directory, additions["OI_EXECUTION_TRACE_HANDSHAKE"], url, work
            )

            async def command(command):
                response = await client.post(url + "/session", json={})
                response.raise_for_status()
                session = response.json()["id"]
                response = await client.post(
                    url + f"/session/{session}/shell",
                    json={
                        "agent": "build",
                        "command": command,
                        "model": {"providerID": "anthropic", "modelID": "claude-sonnet-4-6"},
                    },
                )
                response.raise_for_status()
                assert "CAPTURE_OK" in json.dumps(response.json())

            await asyncio.gather(
                command(f"sleep {args.command_seconds} & sleep .08; wait; printf CAPTURE_OK"),
                command("/bin/true && printf CAPTURE_OK"),
            )
            response = await client.post(url + "/global/dispose")
            response.raise_for_status()
    finally:
        server.terminate()
        await server.wait()
        await capture.stop()
        log.close()
    print(
        json.dumps(
            {
                "status": "pass",
                "session_id": args.session,
                "runtime_boot_id": capture.identity["runtime_boot_id"],
                "local_pending_streams": len(list(capture.directory.glob("*.jsonl"))),
                "external_model_calls": 0,
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("endpoint", "run-id", "attempt-id", "session"):
        parser.add_argument("--" + field, required=True)
    parser.add_argument("--parent")
    parser.add_argument("--command-seconds", type=float, default=0.12)
    asyncio.run(main(parser.parse_args()))
