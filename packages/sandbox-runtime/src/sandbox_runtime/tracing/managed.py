"""Opt-in delivery to a local durable capture receiver, independent of bridge WebSockets."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .config import DEFAULTS


def settings(environment=None):
    environment = os.environ if environment is None else environment
    return json.loads(environment.get("SESSION_CONFIG", "{}")).get("execution_trace")


class ManagedCapture:
    def __init__(self, config, directory, identity):
        self.config = config
        self.directory = directory
        self.identity = identity
        self.task = None
        self.stopping = False
        self.offsets = {}
        self.loss_acknowledged = False

    @classmethod
    async def start(cls):
        config = settings()
        if config is None:
            return None
        for key in ("runId", "attemptId"):
            uuid.UUID(config[key])
        endpoint = urlsplit(config["endpoint"])
        if endpoint.scheme not in ("http", "https") or endpoint.query or endpoint.fragment:
            raise ValueError("Invalid execution trace endpoint")
        if config["mode"] not in ("tools", "process"):
            raise ValueError("Invalid execution trace mode")
        session = json.loads(os.environ.get("SESSION_CONFIG", "{}"))
        boot = os.environ.get("OI_RUNTIME_BOOT_ID") or str(uuid.uuid4())
        os.environ["OI_RUNTIME_BOOT_ID"] = boot
        directory = Path("/tmp/openinspect-execution") / config["runId"] / boot
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.environ.update(
            {
                "OI_EXECUTION_TRACE_MODE": config["mode"],
                "OI_EXECUTION_TRACE_DIR": str(directory),
                "OI_EXECUTION_TRACE_RUN_ID": config["runId"],
                "OI_EXECUTION_TRACE_ATTEMPT_ID": config["attemptId"],
                "OI_EXECUTION_TRACE_MANAGED": "1",
            }
        )
        source = Path(__file__).parent.parent
        files = sorted([*source.rglob("*.py"), *source.rglob("*.js"), *source.rglob("*.json")])
        hashes = {
            str(file.relative_to(source)): hashlib.sha256(file.read_bytes()).hexdigest()
            for file in files
        }
        identity = {
            "schema": "openinspect-capture-v1",
            "run_id": config["runId"],
            "attempt_id": config["attemptId"],
            "inspect_session_id": session["session_id"],
            "runtime_boot_id": boot,
            "sandbox_id": os.environ.get("SANDBOX_ID"),
            "startup_attempt_id": session.get("startup_attempt_id"),
            "repositories": session.get("repositories")
            or [
                {
                    "repo_owner": session.get("repo_owner"),
                    "repo_name": session.get("repo_name"),
                    "base_sha": session.get("base_sha"),
                    "branch": session.get("branch"),
                }
            ],
            "source_hashes": hashes,
            "mode": config["mode"],
            "max_pending_streams": DEFAULTS["max_pending_streams"],
            "max_stream_bytes": DEFAULTS["max_stream_bytes"],
        }
        result = cls(config, directory, identity)
        # The receiver has persisted this expected boot before any model/tool work.
        async with result.client() as client:
            response = await client.post(config["endpoint"] + "/register", json=identity)
            response.raise_for_status()
        result.task = asyncio.create_task(result.run())
        return result

    def client(self):
        return httpx.AsyncClient(timeout=DEFAULTS["upload_timeout_seconds"], trust_env=False)

    async def sweep(self, client):
        for path in sorted(self.directory.glob("*.jsonl")):
            if path.is_symlink() or not path.is_file():
                continue
            offset = self.offsets.get(path.name, 0)
            with path.open("rb") as stream:
                stream.seek(offset)
                chunk = stream.read(DEFAULTS["upload_chunk_bytes"])
            next_offset = offset
            if chunk:
                response = await client.put(
                    self.config["endpoint"]
                    + "/stream/"
                    + self.identity["runtime_boot_id"]
                    + "/"
                    + path.name,
                    params={"offset": offset},
                    content=chunk,
                )
                response.raise_for_status()
                next_offset = response.json()["offset"]
                if next_offset != offset + len(chunk):
                    raise RuntimeError("Capture receiver acknowledged an unexpected offset")
                self.offsets[path.name] = next_offset
            # Chunk boundaries can split a footer. Inspect the bounded file tail at
            # acknowledged EOF, not the last network chunk's partial JSON line.
            if path.stat().st_size == next_offset:
                with path.open("rb") as stream:
                    stream.seek(max(0, next_offset - DEFAULTS["reserved_tail_bytes"]))
                    tail = stream.read(DEFAULTS["reserved_tail_bytes"])
                try:
                    last = (
                        json.loads(tail.rstrip(b"\n").split(b"\n")[-1])
                        if tail.endswith(b"\n")
                        else {}
                    )
                except ValueError:
                    last = {}
                if last.get("kind") == "trace.close" and path.stat().st_size == next_offset:
                    path.unlink()
                    for lease in (self.directory / "leases").glob("*"):
                        if lease.read_text() == path.name:
                            lease.unlink()
        overflow = self.directory / "overflow.json"
        if overflow.exists() and not self.loss_acknowledged:
            response = await client.post(
                self.config["endpoint"] + "/loss",
                json={
                    "runtime_boot_id": self.identity["runtime_boot_id"],
                    "reason": "pending_stream_limit",
                },
            )
            response.raise_for_status()
            self.loss_acknowledged = True

    def has_pending(self):
        return (
            any(self.directory.glob("*.jsonl"))
            or any((self.directory / "leases").glob("*"))
            or ((self.directory / "overflow.json").exists() and not self.loss_acknowledged)
        )

    async def run(self):
        async with self.client() as client:
            while not self.stopping:
                with contextlib.suppress(
                    httpx.HTTPError, OSError, ValueError, KeyError, RuntimeError
                ):
                    await self.sweep(client)
                await asyncio.sleep(DEFAULTS["upload_poll_seconds"])

    async def stop(self):
        self.stopping = True
        if self.task:
            await self.task
        try:
            async with asyncio.timeout(DEFAULTS["upload_flush_seconds"]):
                async with self.client() as client:
                    while self.has_pending():
                        with contextlib.suppress(
                            httpx.HTTPError, OSError, ValueError, RuntimeError
                        ):
                            await self.sweep(client)
                        await asyncio.sleep(DEFAULTS["upload_poll_seconds"])
                    response = await client.post(
                        self.config["endpoint"] + "/finish",
                        json={
                            "runtime_boot_id": self.identity["runtime_boot_id"],
                        },
                    )
                    response.raise_for_status()
        except (TimeoutError, httpx.HTTPError, OSError, ValueError, RuntimeError):
            # Missing finish/stream footer remains explicit durable evidence at the receiver.
            return
