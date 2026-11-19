#!/usr/bin/env python3
"""Collect Docker host observations and runtime logs without inspecting secrets."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import signal
import socket
import subprocess
import threading
import time
import urllib.parse
from pathlib import Path

DOCKER_SOCKET = "/var/run/docker.sock"
REQUEST_TIMEOUT_SECONDS = 5
DEFAULT_INTERVAL_SECONDS = 1.0
DEFAULT_DURATION_SECONDS = 300.0
OWNERSHIP_LABEL = "openinspect_framework=open-inspect"


class DockerConnection(http.client.HTTPConnection):
    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(DOCKER_SOCKET)


def docker_json(path: str) -> dict | list:
    connection = DockerConnection("localhost", timeout=REQUEST_TIMEOUT_SECONDS)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        if response.status != 200:
            raise OSError(f"Docker returned HTTP {response.status}")
        return json.load(response)
    finally:
        connection.close()


def container_query(filters: dict) -> list:
    query = urllib.parse.urlencode({"all": 1, "filters": json.dumps(filters)})
    return docker_json("/containers/json?" + query)


class Collector:
    def __init__(self, output: Path):
        output.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.host_file = (output / "host.jsonl").open("x")
        self.runtime_file = (output / "runtime.jsonl").open("x")
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.processes: list[subprocess.Popen] = []
        self.threads: list[threading.Thread] = []
        self.known: set[str] = set()
        self.identities: dict[str, tuple] = {}

    def write(self, kind: str, record: dict) -> None:
        with self.lock:
            target = self.host_file if kind == "host" else self.runtime_file
            target.write(
                json.dumps(
                    {"schema_version": 1, "observed_at_ms": time.time_ns() // 1_000_000, **record}
                )
                + "\n"
            )
            target.flush()

    def stream(self, args: list[str], kind: str, identity: dict) -> None:
        process = subprocess.Popen(
            ["docker", *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
        )
        self.processes.append(process)

        def read() -> None:
            assert process.stdout is not None
            for line in process.stdout:
                line = line.rstrip("\n")
                try:
                    if kind == "runtime":
                        timestamp, line = line.split(" ", 1)
                        event = json.loads(line)
                        if not isinstance(event, dict):
                            continue
                        record = {
                            "docker_timestamp": timestamp,
                            "sandbox_id": event.get("sandbox_id"),
                            "event": event,
                        }
                    else:
                        event = json.loads(line)
                        # No Config.Env, process arguments, exec command arguments, or tokens.
                        record = {
                            "kind": "docker_event",
                            "action": (event.get("Action") or "").split(":", 1)[0],
                            "container_id": event.get("id") or event.get("Actor", {}).get("ID"),
                            "time_ns": event.get("timeNano"),
                            "labels": {
                                k: v
                                for k, v in event.get("Actor", {}).get("Attributes", {}).items()
                                if k.startswith("openinspect_")
                            },
                        }
                except (ValueError, TypeError):
                    continue
                self.write(kind, {**identity, **record})

        thread = threading.Thread(target=read, daemon=True)
        self.threads.append(thread)
        thread.start()

    def observe(self, summary: dict, role: str) -> None:
        container_id = summary["Id"]
        detail = docker_json(f"/containers/{container_id}/json")
        labels = detail.get("Config", {}).get("Labels") or {}
        identity = {
            "container_id": container_id,
            "role": role,
            "session_id": labels.get("openinspect_session_id"),
            "provider_object_id": labels.get("opensandbox.io/id"),
            "startup_attempt_id": labels.get("openinspect_startup_attempt_id"),
        }
        state_identity = (detail["State"].get("Pid"), detail["State"].get("StartedAt"))
        if self.identities.get(container_id) != state_identity:
            self.identities[container_id] = state_identity
            self.write(
                "host",
                {
                    "kind": "container_identity",
                    **identity,
                    "image_id": detail.get("Image"),
                    "host_pid": detail["State"].get("Pid"),
                    "created_at": detail.get("Created"),
                    "started_at": detail["State"].get("StartedAt"),
                    "cpu_nanocores": detail["HostConfig"].get("NanoCpus"),
                    "memory_limit_bytes": detail["HostConfig"].get("Memory"),
                    "port_bindings": detail["HostConfig"].get("PortBindings"),
                },
            )
        # Following logs before Docker starts the container can exit immediately.
        if not detail["State"].get("Running"):
            return
        if container_id not in self.known:
            self.known.add(container_id)
            if role == "sandbox":
                self.stream(["logs", "--follow", "--timestamps", container_id], "runtime", identity)
        started = time.monotonic()
        stats = docker_json(f"/containers/{container_id}/stats?stream=false&one-shot=true")
        processes = docker_json(
            f"/containers/{container_id}/top?ps_args=" + urllib.parse.quote("-eo pid,ppid,comm")
        )
        self.write(
            "host",
            {
                "kind": "resource_sample",
                **identity,
                "docker_read_at": stats.get("read"),
                "cpu_stats": stats.get("cpu_stats"),
                "memory_stats": stats.get("memory_stats"),
                "blkio_stats": stats.get("blkio_stats"),
                "networks": stats.get("networks"),
                "pids_stats": stats.get("pids_stats"),
                "processes": processes,
                "sample_duration_ms": round((time.monotonic() - started) * 1000, 3),
            },
        )

    def close(self) -> None:
        for process in self.processes:
            process.terminate()
        for process in self.processes:
            try:
                process.wait(timeout=REQUEST_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for thread in self.threads:
            thread.join(timeout=REQUEST_TIMEOUT_SECONDS)
        self.host_file.close()
        self.runtime_file.close()


def positive_seconds(value: str) -> float:
    parsed = float(value)
    if not 0 < parsed < float("inf"):
        raise argparse.ArgumentTypeError("must be a finite positive number of seconds")
    return parsed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--interval-seconds", type=positive_seconds, default=DEFAULT_INTERVAL_SECONDS
    )
    parser.add_argument(
        "--duration-seconds", type=positive_seconds, default=DEFAULT_DURATION_SECONDS
    )
    args = parser.parse_args()
    os.umask(0o077)
    collector = Collector(args.out)
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: collector.stopped.set())
    try:
        info = docker_json("/info")
        collector.write(
            "host",
            {
                "kind": "host_environment",
                "docker": {
                    k: info.get(k)
                    for k in (
                        "ID",
                        "KernelVersion",
                        "OperatingSystem",
                        "Architecture",
                        "NCPU",
                        "MemTotal",
                        "Driver",
                        "ServerVersion",
                    )
                },
                "interval_seconds": args.interval_seconds,
                "clock": "host wall clock for timestamps; monotonic clock for sampler durations",
                "coverage": "Docker lifecycle events plus sampled resources; containers shorter than discovery interval may lack resource samples",
            },
        )
        collector.stream(
            [
                "events",
                "--filter",
                "type=container",
                "--filter",
                "label=" + OWNERSHIP_LABEL,
                "--format",
                "{{json .}}",
            ],
            "host",
            {},
        )
        deadline = time.monotonic() + args.duration_seconds
        while not collector.stopped.is_set() and time.monotonic() < deadline:
            cycle_start = time.monotonic()
            for role, filters in [
                ("sandbox", {"label": [OWNERSHIP_LABEL]}),
                ("server", {"name": ["^oi-opensandbox-server$"]}),
            ]:
                for summary in container_query(filters):
                    try:
                        collector.observe(summary, role)
                    except OSError as error:
                        collector.write(
                            "host",
                            {
                                "kind": "sample_unavailable",
                                "container_id": summary["Id"],
                                "reason": str(error),
                            },
                        )
            collector.stopped.wait(
                max(
                    0,
                    min(
                        args.interval_seconds - (time.monotonic() - cycle_start),
                        deadline - time.monotonic(),
                    ),
                )
            )
    finally:
        collector.close()


if __name__ == "__main__":
    main()
