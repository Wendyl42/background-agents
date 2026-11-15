#!/usr/bin/env python3
"""P2 fault injection in private copies of the collector; no live runtime changes."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

SOURCE = (
    Path(__file__).resolve().parents[2] / "packages/sandbox-runtime/src/sandbox_runtime/tracing"
)
WAIT_SECONDS = 5


def rows(directory: Path) -> list[dict]:
    data = []
    for file in directory.glob("process-*.jsonl"):
        for line in file.read_text().splitlines():
            try:
                data.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return data


def wait_for(directory, predicate):
    deadline = time.monotonic() + WAIT_SECONDS
    while True:
        data = rows(directory)
        if predicate(data):
            return data
        if time.monotonic() > deadline:
            raise AssertionError(f"No expected evidence in {directory}")
        time.sleep(0.01)


def setup(output: Path, name: str, changes: dict):
    directory = output / name
    code = directory / "code"
    shutil.copytree(SOURCE, code, ignore=shutil.ignore_patterns("__pycache__"))
    defaults_path = code / "defaults.json"
    defaults = json.loads(defaults_path.read_text())
    defaults.update(changes)
    defaults_path.write_text(json.dumps(defaults))
    spool = directory / "events"
    spool.mkdir()
    env = {
        **os.environ,
        "OI_EXECUTION_TRACE_DIR": str(spool),
        "OI_EXECUTION_TRACE_REAL_SHELL": "/bin/bash",
        "OI_EXECUTION_TRACE_CONTEXT": json.dumps(
            {"span_id": name, "session_id": "faults", "call_id": name}
        ),
    }
    return spool, [sys.executable, "-I", "-S", str(code / "launcher.py"), "-c"], env


def run(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    spool, command, env = setup(output, "byte_limit", {"max_stream_bytes": 8192})
    process = subprocess.run(
        [*command, "for i in $(seq 1 50); do /bin/true; done; printf finished"],
        env=env,
        capture_output=True,
        timeout=WAIT_SECONDS,
    )
    assert process.returncode == 0 and process.stdout == b"finished", process
    data = wait_for(spool, lambda data: any(row["kind"] == "trace.close" for row in data))
    assert data[-1]["reason"] == "stream_byte_limit" and not data[-1]["complete"]
    assert sum(file.stat().st_size for file in spool.glob("*.jsonl")) <= 8192

    spool, command, env = setup(output, "background_deadline", {"background_trace_seconds": 0.1})
    process = subprocess.run(
        [*command, "sleep 0.5 >/dev/null 2>&1 & printf returned"],
        env=env,
        capture_output=True,
        timeout=WAIT_SECONDS,
    )
    assert process.returncode == 0 and process.stdout == b"returned", process
    data = wait_for(spool, lambda data: any(row["kind"] == "trace.close" for row in data))
    assert data[-1]["reason"] == "background_deadline" and not data[-1]["complete"]
    sleep_pid = next(
        row["pid"]
        for row in data
        if row["kind"] == "process.exec" and Path(row["executable"]).name == "sleep"
    )
    # Observation deadline detaches rather than killing the legitimate background work.
    assert Path(f"/proc/{sleep_pid}").exists()
    deadline = time.monotonic() + WAIT_SECONDS
    while Path(f"/proc/{sleep_pid}").exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not Path(f"/proc/{sleep_pid}").exists(), "Background process was not reaped"

    spool, command, env = setup(output, "collector_sigkill", {})
    process = subprocess.Popen(
        [*command, "sleep 30"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        data = wait_for(
            spool,
            lambda data: any(
                row["kind"] == "process.exec" and Path(row["executable"]).name == "sleep"
                for row in data
            ),
        )
        collector_pid = data[0]["collector_pid"]
        root_pid = next(row["pid"] for row in data if row["kind"] == "shell.bind")
        os.kill(collector_pid, signal.SIGKILL)
        process.communicate(timeout=WAIT_SECONDS)
        assert process.returncode == -signal.SIGKILL
        assert not any(row["kind"] == "trace.close" for row in rows(spool))
        deadline = time.monotonic() + WAIT_SECONDS
        while Path(f"/proc/{root_pid}").exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert not Path(f"/proc/{root_pid}").exists(), "Tracee survived killed collector"
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()

    report = {
        "status": "pass",
        "cases": [
            "stream_limit_preserves_command_and_marks_loss",
            "background_deadline_detaches_without_fabricated_exit",
            "collector_sigkill_fails_call_and_kernel_kills_tracees",
        ],
        "model_requests": 0,
    }
    (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.out.resolve()), indent=2))
