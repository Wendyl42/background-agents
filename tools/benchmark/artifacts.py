#!/usr/bin/env python3
"""Attempt-scoped code transport. No shared filesystem is exposed to the agents."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

MAX_PATCH_BYTES = 64 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 30
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False, mode="w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
        temporary = stream.name
    Path(temporary).replace(path)


def snapshot(workspace: Path, base_commit: str) -> bytes:
    """Include untracked additions, deletions, modes and binaries without editing the real index."""
    tracked = subprocess.run(
        ["git", "-c", f"safe.directory={workspace}", "-C", str(workspace), "ls-files", "-z"],
        check=True,
        capture_output=True,
    ).stdout
    tracked = b"\0".join(
        name
        for name in tracked.split(b"\0")
        if name
        and (
            (workspace / os.fsdecode(name)).exists() or (workspace / os.fsdecode(name)).is_symlink()
        )
    )
    if tracked:
        tracked += b"\0"
    with tempfile.TemporaryDirectory(prefix="oi-bench-index-") as directory:
        environment = {**os.environ, "GIT_INDEX_FILE": str(Path(directory) / "index")}

        def git(*args: str, input_data=None) -> bytes:
            return subprocess.run(
                ["git", "-c", f"safe.directory={workspace}", "-C", str(workspace), *args],
                env=environment,
                check=True,
                capture_output=True,
                input=input_data,
            ).stdout

        git("read-tree", base_commit)
        git("add", "-A", "--", ".")
        # Honor deliberately staged ignored files, including binaries. The temporary
        # index otherwise knows only the baseline and would lose git add -f intent.
        if tracked:
            git(
                "add",
                "-A",
                "-f",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
                input_data=tracked,
            )
        return git("diff", "--cached", "--binary", "--full-index", base_commit, "--", ".")


def store_patch(root: Path, session_id: str, data: bytes, *, source: str) -> dict:
    if not ID_PATTERN.fullmatch(session_id) or len(data) > MAX_PATCH_BYTES:
        raise ValueError("Invalid artifact identity or size")
    digest = hashlib.sha256(data).hexdigest()
    directory = root / session_id
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / f"{digest}.patch"
    try:
        with target.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        target.chmod(0o600)
    except FileExistsError:
        if target.read_bytes() != data:
            raise ValueError("Artifact digest collision")
    metadata = {
        "sessionId": session_id,
        "sha256": digest,
        "bytes": len(data),
        "capturedAtMs": time.time_ns() // 1_000_000,
        "source": source,
        "file": target.name,
    }
    # Agent publication and host checkpoints are separate: a later host sample must
    # never silently replace the exact revision a child explicitly returned.
    atomic_json(directory / f"{source}.json", metadata)
    return metadata


def make_server(address: tuple[str, int], root: Path, registry_path: Path):
    transfer_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Never log Authorization headers or task content.

        def reply(self, status: int, data: bytes, content_type="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def identity(self):
            try:
                registry = json.loads(registry_path.read_text())
                session_id = self.headers.get("X-OpenInspect-Session", "")
                expected = registry[session_id]["tokenSha256"]
                token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                if not hmac.compare_digest(expected, hashlib.sha256(token.encode()).hexdigest()):
                    raise ValueError("Unauthorized")
                return session_id, registry
            except (ValueError, KeyError, OSError):
                self.reply(403, b'{"error":"unauthorized session"}')
                return None

        def do_PUT(self):
            identity = self.identity()
            if identity is None:
                return
            if self.path != "/patch":
                return self.reply(404, b"{}")
            try:
                size = int(self.headers.get("Content-Length", "-1"))
                if not 0 <= size <= MAX_PATCH_BYTES:
                    return self.reply(413, b"{}")
                self.connection.settimeout(REQUEST_TIMEOUT_SECONDS)
                data = self.rfile.read(size)
                if len(data) != size:
                    raise ValueError("Truncated body")
                result = store_patch(root, identity[0], data, source="published")
                self.reply(201, json.dumps(result).encode())
            except (OSError, ValueError):
                self.reply(400, b'{"error":"invalid artifact"}')

        def do_GET(self):
            identity = self.identity()
            if identity is None:
                return
            session_id, registry = identity
            allowed = {session_id} | {
                key for key, value in registry.items() if value.get("parentId") == session_id
            }
            if self.path == "/patches":
                items = []
                for target_id in sorted(allowed):
                    metadata = root / target_id / "published.json"
                    if metadata.exists():
                        items.append(json.loads(metadata.read_text()))
                return self.reply(200, json.dumps(items).encode())
            parts = self.path.strip("/").split("/")
            if len(parts) != 3 or parts[0] != "patch" or parts[1] not in allowed:
                return self.reply(404, b"{}")
            if not re.fullmatch(r"[a-f0-9]{64}", parts[2]):
                return self.reply(404, b"{}")
            target = root / parts[1] / f"{parts[2]}.patch"
            if not target.exists():
                return self.reply(404, b"{}")
            data = target.read_bytes()
            self.reply(200, data, "application/octet-stream")
            with transfer_lock, (root.parent / "artifact-transfers.jsonl").open("a") as stream:
                stream.write(
                    json.dumps(
                        {
                            "recipientSessionId": session_id,
                            "sourceSessionId": parts[1],
                            "sha256": parts[2],
                            "bytes": len(data),
                            "sentAtMs": time.time_ns() // 1_000_000,
                        }
                    )
                    + "\n"
                )

    return ThreadingHTTPServer(address, Handler)


def agent_request(path: str, data: bytes | None = None) -> bytes:
    session_id = json.loads(os.environ["SESSION_CONFIG"])["session_id"]
    request = Request(
        os.environ["OI_BENCH_ARTIFACT_URL"].rstrip("/") + path,
        data=data,
        method="GET" if data is None else "PUT",
        headers={
            "Authorization": "Bearer " + os.environ["SANDBOX_AUTH_TOKEN"],
            "X-OpenInspect-Session": session_id,
        },
    )
    # Local Docker gateway traffic must bypass user-configured internet proxies.
    for attempt in range(5):
        try:
            with build_opener(ProxyHandler({})).open(
                request, timeout=REQUEST_TIMEOUT_SECONDS
            ) as response:
                return response.read()
        except HTTPError as error:
            if error.code != 403 or attempt == 4:
                raise
            time.sleep(2)  # The observer may still be registering a just-created child.
    raise RuntimeError("Artifact request failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    server = commands.add_parser("serve")
    server.add_argument("--host", required=True)
    server.add_argument("--port", required=True, type=int)
    server.add_argument("--root", required=True, type=Path)
    server.add_argument("--registry", required=True, type=Path)
    for command in ("publish", "snapshot"):
        sub = commands.add_parser(command)
        sub.add_argument("--workspace", type=Path)
        sub.add_argument("--base-commit")
    commands.add_parser("list")
    fetch = commands.add_parser("fetch")
    fetch.add_argument("session_id")
    fetch.add_argument("sha256")
    fetch.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "serve":
        make_server((args.host, args.port), args.root, args.registry).serve_forever()
    elif args.command in ("publish", "snapshot"):
        task = (
            json.loads(Path("/opt/oi-benchmark/task.json").read_text())
            if args.workspace is None
            else {}
        )
        workspace = args.workspace or Path(task["workspacePath"])
        base = args.base_commit or Path("/opt/oi-benchmark/base-commit").read_text().strip()
        data = snapshot(workspace, base)
        if args.command == "publish":
            print(agent_request("/patch", data).decode())
        else:
            import sys

            sys.stdout.buffer.write(data)
    elif args.command == "list":
        print(agent_request("/patches").decode())
    elif args.command == "fetch":
        if not ID_PATTERN.fullmatch(args.session_id) or not re.fullmatch(
            r"[a-f0-9]{64}", args.sha256
        ):
            parser.error("Invalid session ID or digest")
        data = agent_request(f"/patch/{args.session_id}/{args.sha256}")
        if hashlib.sha256(data).hexdigest() != args.sha256:
            raise ValueError("Artifact hash mismatch")
        with args.output.open("xb") as stream:
            stream.write(data)
        print(str(args.output))


if __name__ == "__main__":
    main()
