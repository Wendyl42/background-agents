#!/usr/bin/env python3
"""Native/traced Go lifecycle equivalence and process-count oracle; no model requests."""

import argparse
import ctypes
import hashlib
import json
import os
import shlex
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

DEFAULT_REPETITIONS = 40
COMMAND_TIMEOUT_SECONDS = 15
FOOTER_TIMEOUT_SECONDS = 5


def read_rows(directory):
    files = list(directory.glob("process-*.jsonl"))
    if not files:
        return []
    assert len(files) == 1, files
    lines = files[0].read_text().splitlines(keepends=True)
    return [json.loads(line) for line in lines if line.endswith("\n")]


def run(args):
    args.out.mkdir(parents=True, exist_ok=False)
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError("Could not become a subreaper for the isolated probe")
    command = (
        f'{shlex.quote(str(args.program))} {shlex.quote(str(args.vet))}; status=$?; exit "$status"'
    )
    baseline = subprocess.run(
        ["/bin/bash", "-c", command], capture_output=True, timeout=COMMAND_TIMEOUT_SECONDS
    )
    assert baseline.returncode == 0 and not baseline.stderr, baseline
    expected = json.loads(baseline.stdout)
    assert expected["ok"] and expected["commands"] > 0
    report = {
        "status": "running",
        "model_requests": 0,
        "scope": "lifecycle correctness; not a task-performance A/B experiment",
        "program_sha256": hashlib.sha256(args.program.read_bytes()).hexdigest(),
        "vet_sha256": hashlib.sha256(args.vet.read_bytes()).hexdigest(),
        "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "collector_source_hashes": {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(args.launcher.parent.iterdir())
            if path.is_file() and path.suffix in (".py", ".json")
        },
        "expected_child_commands": expected["commands"],
        "cases": [],
    }
    for index in range(args.repetitions):
        directory = args.out / f"case-{index:03d}"
        directory.mkdir()
        environment = {
            **os.environ,
            "OI_EXECUTION_TRACE_DIR": str(directory),
            "OI_EXECUTION_TRACE_REAL_SHELL": "/bin/bash",
            "OI_EXECUTION_TRACE_CONTEXT": json.dumps(
                {
                    "span_id": str(uuid.uuid4()),
                    "call_id": str(index),
                    "inspect_session_id": "go-oracle",
                }
            ),
        }
        process = subprocess.Popen(
            [sys.executable, "-I", "-S", str(args.launcher), "-c", command],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=COMMAND_TIMEOUT_SECONDS)
            assert (process.returncode, stdout, stderr) == (
                baseline.returncode,
                baseline.stdout,
                baseline.stderr,
            )
            deadline_seconds = time.monotonic() + FOOTER_TIMEOUT_SECONDS
            while True:
                rows = read_rows(directory)
                if rows and rows[-1]["kind"] == "trace.close":
                    break
                if time.monotonic() >= deadline_seconds:
                    raise AssertionError("Missing collector footer")
                time.sleep(0.01)
            assert rows[-1]["complete"]
            assert not any(row["kind"] == "trace.loss" for row in rows)
            assert [row["seq"] for row in rows] == list(range(1, len(rows) + 1))
            for prefix, identity in [
                ("process", "process_instance_id"),
                ("thread", "task_instance_id"),
            ]:
                starts = [r[identity] for r in rows if r["kind"] == prefix + ".start"]
                ends = [r[identity] for r in rows if r["kind"] == prefix + ".exit"]
                assert len(starts) == len(set(starts)) == len(ends) == len(set(ends))
                assert set(starts) == set(ends)
            assert sum(r["kind"] == "process.start" for r in rows) == expected["commands"] + 2
            assert (
                sum(
                    r["kind"] == "process.exec" and r.get("executable") == str(args.vet)
                    for r in rows
                )
                == expected["commands"]
            )
            report["cases"].append(
                {
                    "case": index,
                    "status": "pass",
                    "events": len(rows),
                    "late_exit_threads": sum(
                        r.get("creation_observation") == "exit_stop_recovered" for r in rows
                    ),
                    "superseded_notifications": sum(
                        r.get("reason") == "fork_notification_superseded" for r in rows
                    ),
                }
            )
        except BaseException as error:
            report.update(
                status="fail", failure=f"{type(error).__name__}: {error}", failed_case=index
            )
            raise
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            rows = read_rows(directory)
            if rows and rows[-1]["kind"] != "trace.close":
                observer = rows[0]["collector_pid"]
                try:
                    fields = dict(
                        line.split(":", 1)
                        for line in Path(f"/proc/{observer}/status").read_text().splitlines()
                    )
                    if int(fields["PPid"]) == os.getpid():
                        os.kill(observer, signal.SIGKILL)
                except OSError:
                    pass
            while True:
                try:
                    if not os.waitpid(-1, os.WNOHANG)[0]:
                        break
                except ChildProcessError:
                    break
            for path in directory.glob("*.jsonl"):
                path.chmod(0o644)  # Disposable oracle evidence contains no credentials.
            (args.out / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    report["status"] = "pass"
    (args.out / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": "pass", "cases": len(report["cases"]), "model_requests": 0}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program", type=Path, required=True)
    parser.add_argument("--vet", type=Path, required=True)
    parser.add_argument("--launcher", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, default=DEFAULT_REPETITIONS)
    arguments = parser.parse_args()
    for name in ["program", "vet", "launcher", "out"]:
        setattr(arguments, name, getattr(arguments, name).resolve())
    run(arguments)
