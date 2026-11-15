#!/usr/bin/env python3
"""Local durable receiver. Exact-offset retries are idempotent; acknowledge after fsync."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

DEFAULTS = json.loads(
    (
        Path(__file__).parents[2]
        / "packages/sandbox-runtime/src/sandbox_runtime/tracing/defaults.json"
    ).read_text()
)
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
STREAM = re.compile(r"(?:tools|process)-[a-f0-9-]{36}\.jsonl\Z")


class Store:
    def __init__(self, directory, run_id, attempt_id, max_bytes):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.directory / "capture.json"
        self.lock = threading.Lock()
        self.max_bytes = max_bytes
        self.state = {
            "schema": "openinspect-capture-v1",
            "run_id": run_id,
            "attempt_id": attempt_id,
            "boots": {},
            "files": {},
            "losses": [],
            "bytes": 0,
            "max_bytes": max_bytes,
        }
        if self.path.exists():
            self.state = json.loads(self.path.read_text())
            if self.state["run_id"] != run_id or self.state["attempt_id"] != attempt_id:
                raise ValueError("Capture identity mismatch on recovery")
            # Reconcile bytes after a kill between stream fsync and index publication.
            self.state["bytes"] = 0
            for relative, info in self.state["files"].items():
                path = self.directory / relative
                info["bytes"] = path.stat().st_size
                self.state["bytes"] += info["bytes"]
        self.save()

    def save(self):
        pending = self.path.with_suffix(".pending")
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(self.state, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        pending.replace(self.path)
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def register(self, identity):
        boot = identity["runtime_boot_id"]
        session = identity["inspect_session_id"]
        if not IDENTIFIER.fullmatch(boot) or not IDENTIFIER.fullmatch(session):
            raise ValueError("Invalid capture identity")
        if (
            identity["run_id"] != self.state["run_id"]
            or identity["attempt_id"] != self.state["attempt_id"]
        ):
            raise ValueError("Wrong run identity")
        if (
            boot not in self.state["boots"]
            and len(self.state["boots"]) >= DEFAULTS["max_capture_boots"]
        ):
            self.loss("boot_limit")
            raise ValueError("Boot limit")
        old = self.state["boots"].get(boot)
        if old and old["identity"] != identity:
            raise ValueError("Boot identity changed")
        self.state["boots"][boot] = {"identity": identity, "finished": False}
        self.save()
        return {"registered": True}

    def loss(self, reason, boot=None):
        value = {"reason": reason, "runtime_boot_id": boot}
        if value not in self.state["losses"]:
            self.state["losses"].append(value)
        self.save()

    def append(self, boot, name, offset, chunk):
        if boot not in self.state["boots"] or not STREAM.fullmatch(name) or offset < 0:
            raise ValueError("Unknown boot or invalid stream")
        relative = f"streams/{boot}/{name}"
        path = self.directory / relative
        if relative not in self.state["files"]:
            if len(self.state["files"]) >= DEFAULTS["max_capture_files"]:
                self.loss("file_limit", boot)
                raise ValueError("File limit")
            if offset != 0:
                raise ValueError("Missing stream prefix")
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.state["files"][relative] = {"runtime_boot_id": boot, "bytes": 0}
            # Inventory precedes writing: a killed receiver cannot lose an entire stream silently.
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            self.save()
        fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
        with os.fdopen(fd, "r+b") as stream:
            size = os.fstat(stream.fileno()).st_size
            if offset < size:
                stream.seek(offset)
                if offset + len(chunk) > size or stream.read(len(chunk)) != chunk:
                    raise ValueError("Conflicting retry")
                return {"offset": offset + len(chunk)}
            if offset != size:
                raise ValueError("Noncontiguous stream")
            if self.state["bytes"] + len(chunk) > self.max_bytes:
                self.loss("capture_byte_limit", boot)
                raise ValueError("Capture byte limit")
            stream.seek(offset)
            stream.write(chunk)
            stream.flush()
            os.fsync(stream.fileno())
        self.state["bytes"] += len(chunk)
        self.state["files"][relative]["bytes"] = offset + len(chunk)
        self.save()
        return {"offset": offset + len(chunk)}


def serve(store, host, port, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Do not print capability URLs or trace content.

        def handle_request(self):
            parsed = urlsplit(self.path)
            parts = parsed.path.strip("/").split("/")
            if not parts or not secrets.compare_digest(parts[0], token):
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "-1"))
                if length < 0 or length > DEFAULTS["upload_chunk_bytes"]:
                    raise ValueError("Body limit")
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError("Short body")
                with store.lock:
                    if self.command == "POST" and parts[1:] == ["register"]:
                        result = store.register(json.loads(body))
                    elif self.command == "PUT" and len(parts) == 4 and parts[1] == "stream":
                        result = store.append(
                            parts[2], parts[3], int(parse_qs(parsed.query)["offset"][0]), body
                        )
                    elif self.command == "POST" and parts[1:] in (["finish"], ["loss"]):
                        value = json.loads(body)
                        boot = value["runtime_boot_id"]
                        if boot not in store.state["boots"]:
                            raise ValueError("Unknown boot")
                        if parts[1] == "finish":
                            store.state["boots"][boot]["finished"] = True
                            store.save()
                        else:
                            store.loss(value["reason"], boot)
                        result = {"acknowledged": True}
                    else:
                        raise ValueError("Unknown endpoint")
                encoded = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Durable bytes remain available for an exact-offset retry.
            except (ValueError, KeyError, TypeError, OSError):
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    self.send_error(409, "Capture request rejected")

        do_POST = handle_request
        do_PUT = handle_request

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--attempt-id", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--advertise-host")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--max-bytes", type=int, default=DEFAULTS["max_capture_bytes"])
    args = parser.parse_args()
    store = Store(args.out, args.run_id, args.attempt_id, args.max_bytes)
    connection_path = Path(args.out) / "connection.json"
    previous = json.loads(connection_path.read_text()) if connection_path.exists() else None
    old_url = urlsplit(previous["endpoint"]) if previous else None
    token = old_url.path.strip("/") if old_url else secrets.token_hex(32)
    port = args.port or (old_url.port if old_url else 0)
    server = serve(store, args.host, port, token)
    endpoint = f"http://{args.advertise_host or args.host}:{server.server_port}/{token}"
    path = Path(args.out) / "connection.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump({"endpoint": endpoint}, output)
    print("Execution trace receiver ready", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
