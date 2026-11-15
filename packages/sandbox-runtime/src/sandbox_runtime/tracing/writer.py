"""Bounded, single-writer append-only execution evidence."""

from __future__ import annotations

import json
import os
import resource
import time
import uuid
from pathlib import Path
from typing import Any

from .budget import reserve

DEFAULTS = json.loads(Path(__file__).with_name("defaults.json").read_text())


def clock_identity() -> str:
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    namespace = Path("/proc/self/ns/time").readlink()
    return f"{boot}:{namespace}:monotonic"


class EventWriter:
    def __init__(self, directory: Path, context: dict[str, Any], *, max_bytes: int | None = None):
        self.stream_id = str(uuid.uuid4())
        self.clock_id = clock_identity()
        self.seq = 0
        self.bytes = 0
        self.closed = False
        self.lost = False
        self.deferring = False
        self.pending: list[tuple[str, int, dict[str, Any]]] = []
        self.max_bytes = max_bytes or DEFAULTS["max_stream_bytes"]
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = directory / f"process-{self.stream_id}.jsonl"
        reserve(directory, self.path.name, DEFAULTS["max_pending_streams"])
        self.fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        self.emit(
            "trace.open",
            producer="ptrace_lifecycle",
            producer_version=DEFAULTS["producer_version"],
            context=context,
            epoch_ms=time.time_ns() // 1_000_000,
            clock_source="linux_monotonic_tracer_observed",
            cpu_resolution_ns=str(1_000_000_000 // os.sysconf("SC_CLK_TCK")),
            capabilities={
                "process_lifecycle": True,
                "self_cpu_ticks": True,
                "self_cpu_runtime_ns": Path("/proc/self/schedstat").is_file(),
                "io_bytes": False,
            },
            collector_pid=os.getpid(),
            pid_view_namespace=str(Path("/proc/self/ns/pid").readlink()),
        )

    def _write(self, kind: str, fields: dict[str, Any], at_ns: int | None = None) -> None:
        self.seq += 1
        data = (
            json.dumps(
                {
                    "schema": DEFAULTS["schema"],
                    "kind": kind,
                    "stream_id": self.stream_id,
                    "seq": self.seq,
                    "mono_ns": str(at_ns if at_ns is not None else time.monotonic_ns()),
                    "clock_id": self.clock_id,
                    **fields,
                },
                separators=(",", ":"),
            )
            + "\n"
        ).encode()
        offset = 0
        while offset < len(data):
            count = os.write(self.fd, data[offset:])
            if count <= 0:
                raise OSError("No progress writing execution evidence")
            offset += count
        self.bytes += len(data)

    def emit(self, kind: str, *, at_ns: int | None = None, **fields: Any) -> bool:
        if self.closed:
            return False
        if self.deferring:
            if len(self.pending) >= DEFAULTS["max_deferred_events"]:
                self.end_defer()
                self.begin_defer()
            self.pending.append((kind, at_ns if at_ns is not None else time.monotonic_ns(), fields))
            return True
        if kind == "trace.loss":
            self.lost = True
        try:
            if (
                self.bytes + len(json.dumps(fields).encode()) + 512
                > self.max_bytes - DEFAULTS["reserved_tail_bytes"]
            ):
                self.lost = True
                self._write(
                    "trace.loss", {"reason": "stream_byte_limit", "dropped_records_at_least": 1}
                )
                self.close("stream_byte_limit", False)
                return False
            self._write(kind, fields, at_ns)
            return True
        except OSError:
            self.lost = True
            self.close("write_error", False)
            return False

    def begin_defer(self) -> None:
        self.deferring = True

    def end_defer(self) -> None:
        self.deferring = False
        pending, self.pending = self.pending, []
        for kind, at_ns, fields in pending:
            self.emit(kind, at_ns=at_ns, **fields)

    def close(self, reason: str, complete: bool = True) -> None:
        if self.closed:
            return
        if self.pending:
            self.end_defer()
            if self.closed:
                return
        try:
            usage = resource.getrusage(resource.RUSAGE_SELF)
            self._write(
                "trace.close",
                {
                    "reason": reason,
                    "complete": complete and not self.lost,
                    "preceding_records": self.seq,
                    "observer_user_cpu_ns": str(round(usage.ru_utime * 1_000_000_000)),
                    "observer_system_cpu_ns": str(round(usage.ru_stime * 1_000_000_000)),
                    "observer_max_rss_bytes": usage.ru_maxrss * 1024,
                    "observer_resource_scope": "collector_process_only_excludes_launcher_startup",
                },
            )
            os.fsync(self.fd)
        except OSError:
            self.lost = True
        finally:
            self.closed = True
            os.close(self.fd)
