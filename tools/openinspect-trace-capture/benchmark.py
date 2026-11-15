#!/usr/bin/env python3
"""P2 independent clock/CPU reference and interleaved off/tools/process overhead.

Uses real OpenCode's direct shell API, with no model requests. The busy-work iteration
count is calibrated once, then identical across every mode and repetition. Sleeps
appear only in the separate boundary-reference check, never the overhead workload.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import shlex
import shutil
import socket
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

RUNTIME = Path(__file__).resolve().parents[2] / "packages/sandbox-runtime/src"
sys.path.insert(0, str(RUNTIME))

from sandbox_runtime.tracing.config import (  # noqa: E402
    configure_execution_trace,
    ensure_trace_ready,
)

PAIRS = 20
REFERENCE_TARGET_SECONDS = 0.5
API_TIMEOUT_SECONDS = 30
HEALTH_TIMEOUT_SECONDS = 40
MODES = ("off", "tools", "process")


def percentile(values: list[float], fraction: float) -> float:
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)]


def rows(directory: Path) -> list[dict]:
    return [
        json.loads(line)
        for file in sorted(directory.glob("*.jsonl"))
        for line in file.read_text().splitlines()
    ]


def reference_rows(directory: Path, span_id: str) -> list[dict]:
    deadline_seconds = time.monotonic() + API_TIMEOUT_SECONDS
    while time.monotonic() < deadline_seconds:
        for file in directory.glob("process-*.jsonl"):
            try:
                data = [json.loads(line) for line in file.read_text().splitlines()]
            except json.JSONDecodeError:
                continue
            if (
                data
                and data[0]["context"]["span_id"] == span_id
                and data[-1]["kind"] == "trace.close"
            ):
                return data
        time.sleep(0.01)
    raise AssertionError("Reference collector did not close")


def cgroup_cpu_ns() -> int | None:
    try:
        values = dict(
            line.split() for line in Path("/sys/fs/cgroup/cpu.stat").read_text().splitlines()
        )
        return int(values["usage_usec"]) * 1000
    except (OSError, ValueError, KeyError):
        return None


def source_identity() -> dict[str, str]:
    paths = list((RUNTIME / "sandbox_runtime/tracing").glob("*.py"))
    paths += list((RUNTIME / "sandbox_runtime/tracing").glob("*.json"))
    paths += [
        RUNTIME / "sandbox_runtime/plugins/execution-trace.js",
        Path(__file__),
        Path(__file__).with_name("reference.c"),
    ]
    return {
        str(path.relative_to(RUNTIME.parents[2])): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(paths)
    }


def request(
    port: int, route: str, payload: dict | None = None, timeout_seconds: float = API_TIMEOUT_SECONDS
):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{route}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as response:
        return json.load(response)


def run(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    sources = source_identity()
    (output / "source-hashes.json").write_text(json.dumps(sources, indent=2) + "\n")
    reference = output / "reference"
    source = Path(__file__).with_name("reference.c")
    subprocess.run(
        ["cc", "-O2", "-static", str(source), "-o", str(reference)], check=True, capture_output=True
    )
    calibration = json.loads(
        subprocess.check_output([str(reference), "work", "100000000"], text=True)
    )
    elapsed = (int(calibration["end_ns"]) - int(calibration["start_ns"])) / 1_000_000_000
    iterations = max(1, round(100000000 * REFERENCE_TARGET_SECONDS / elapsed))

    # Conservative inner-program reference: exec/exit interval must contain both
    # markers; excess includes startup/teardown and observer boundary overhead.
    ref_dir = output / "reference-traces"
    ref_config = {}
    ref_env = {
        **os.environ,
        "OI_EXECUTION_TRACE_MODE": "process",
        "OI_EXECUTION_TRACE_DIR": str(ref_dir),
    }
    additions, _ = configure_execution_trace(output / "reference-work", ref_env, ref_config)
    ref_env.update(additions)
    timing = []
    for index in range(PAIRS):
        context = {
            "span_id": f"reference-{index}",
            "session_id": "reference",
            "call_id": str(index),
            "identity_quality": "exact_call",
        }
        proc = subprocess.run(
            [
                ref_env["OI_EXECUTION_TRACE_WRAPPER_SHELL"],
                "-c",
                f"exec {shlex.quote(str(reference))} sleep-ns 200000000",
            ],
            env={**ref_env, "OI_EXECUTION_TRACE_CONTEXT": json.dumps(context)},
            capture_output=True,
            text=True,
            timeout=API_TIMEOUT_SECONDS,
            check=True,
        )
        inner = json.loads(proc.stdout)
        data = reference_rows(ref_dir, context["span_id"])
        assert data[-1]["kind"] == "trace.close" and data[-1]["complete"]
        start = next(
            row
            for row in data
            if row["kind"] == "process.exec" and row["executable"] == str(reference)
        )
        end = next(
            row
            for row in data
            if row["kind"] == "process.exit"
            and row["process_instance_id"] == start["process_instance_id"]
        )
        assert (
            int(start["mono_ns"])
            <= int(inner["start_ns"])
            <= int(inner["end_ns"])
            <= int(end["mono_ns"])
        )
        inside_ns = int(inner["end_ns"]) - int(inner["start_ns"])
        excess_ns = int(end["mono_ns"]) - int(start["mono_ns"]) - inside_ns
        limit_ns = max(2_000_000, inside_ns * 0.02)
        timing.append(
            {
                "index": index,
                "boundary_slack_ms": excess_ns / 1_000_000,
                "limit_ms": limit_ns / 1_000_000,
                "pass": excess_ns <= limit_ns,
            }
        )

    cpu_context = {"span_id": "cpu-reference", "session_id": "reference", "call_id": "cpu"}
    result = subprocess.run(
        [
            ref_env["OI_EXECUTION_TRACE_WRAPPER_SHELL"],
            "-c",
            f"exec {shlex.quote(str(reference))} work {iterations}",
        ],
        env={**ref_env, "OI_EXECUTION_TRACE_CONTEXT": json.dumps(cpu_context)},
        capture_output=True,
        text=True,
        timeout=API_TIMEOUT_SECONDS,
        check=True,
    )
    native_cpu = json.loads(result.stdout)
    cpu_rows = reference_rows(ref_dir, "cpu-reference")
    cpu_end = next(row for row in cpu_rows if row["kind"] == "process.exit")
    cpu_delta_ns = abs(
        int(cpu_end["user_cpu_ns"])
        + int(cpu_end["system_cpu_ns"])
        - int(native_cpu["user_cpu_ns"])
        - int(native_cpu["system_cpu_ns"])
    )
    quantum_ns = int(cpu_rows[0]["cpu_resolution_ns"])
    assert cpu_end["cpu_complete"] and cpu_delta_ns <= quantum_ns * 2
    native_cpu_ns = int(native_cpu["user_cpu_ns"]) + int(native_cpu["system_cpu_ns"])
    runtime_cpu_error_ns = (
        abs(int(cpu_end["cpu_runtime_ns"]) - native_cpu_ns)
        if cpu_end.get("cpu_runtime_complete")
        else None
    )
    assert runtime_cpu_error_ns is not None and runtime_cpu_error_ns <= max(
        2_000_000, native_cpu_ns * 0.02
    )

    servers = {}
    measurements = []
    hash_script = "import hashlib; print(hashlib.sha256(b'x' * (32 * 1024 * 1024)).hexdigest())"
    command = f"{shlex.quote(str(reference))} work {iterations} >/dev/null; {shlex.quote(sys.executable)} -c {shlex.quote(hash_script)}; {shlex.quote(str(reference))} work {iterations} >/dev/null"
    expected_output = hashlib.sha256(b"x" * (32 * 1024 * 1024)).hexdigest()
    try:
        for mode in MODES:
            mode_dir = output / mode
            work = mode_dir / "work"
            work.mkdir(parents=True)
            config_dir = mode_dir / "config"
            config_dir.mkdir()
            config = {"permission": {"*": "allow"}}
            environment = {
                **os.environ,
                "OI_EXECUTION_TRACE_MODE": mode,
                "OI_EXECUTION_TRACE_DIR": str(mode_dir / "events"),
                "SESSION_CONFIG": json.dumps({"session_id": f"benchmark-{mode}"}),
                "OPENCODE_CONFIG_DIR": str(config_dir),
                "OPENCODE_DISABLE_AUTOUPDATE": "true",
                "OPENCODE_DISABLE_MODELS_FETCH": "true",
                "XDG_DATA_HOME": str(mode_dir / "data"),
                "XDG_CACHE_HOME": str(mode_dir / "cache"),
            }
            additions, _ = configure_execution_trace(work, environment, config)
            environment.update(additions)
            environment["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
            for directory in (config_dir, work / ".opencode"):
                directory.mkdir(exist_ok=True)
                for name in ("node_modules", "package.json", "package-lock.json"):
                    src = Path("/app/opencode-deps") / name
                    if src.exists():
                        (directory / name).symlink_to(src, target_is_directory=src.is_dir())
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            log = (mode_dir / "opencode.log").open("w")
            proc = subprocess.Popen(
                [shutil.which("opencode"), "serve", "--port", str(port), "--hostname", "127.0.0.1"],
                cwd=work,
                env=environment,
                stdout=log,
                stderr=log,
            )
            servers[mode] = {"process": proc, "port": port, "log": log}
            deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
            while True:
                try:
                    request(port, "/global/health", timeout_seconds=1)
                    break
                except (urllib.error.URLError, TimeoutError):
                    if time.monotonic() > deadline or proc.poll() is not None:
                        raise RuntimeError(f"{mode} server did not start")
            if mode != "off":
                asyncio.run(
                    ensure_trace_ready(
                        mode_dir / "events",
                        environment["OI_EXECUTION_TRACE_HANDSHAKE"],
                        f"http://127.0.0.1:{port}",
                        work,
                    )
                )
            servers[mode]["session_id"] = request(port, "/session", {})["id"]

        def execute(mode, command):
            server = servers[mode]
            return request(
                server["port"],
                f"/session/{server['session_id']}/shell",
                {
                    "agent": "build",
                    "command": command,
                    "model": {"providerID": "anthropic", "modelID": "claude-sonnet-4-6"},
                },
            )

        for mode in MODES:
            execute(mode, command)
        for workload, text in (
            ("fixed_cpu_hash", command),
            ("short_process_stress", "for i in $(seq 1 40); do /bin/true; done"),
        ):
            for index in range(PAIRS):
                order = MODES[index % len(MODES) :] + MODES[: index % len(MODES)]
                for mode in order:
                    cpu_before = cgroup_cpu_ns()
                    before = time.monotonic_ns()
                    result = execute(mode, text)
                    wall_ns = time.monotonic_ns() - before
                    cpu_after = cgroup_cpu_ns()
                    output_text = result["parts"][0]["state"]["output"]
                    if workload == "fixed_cpu_hash":
                        assert output_text.strip() == expected_output, (mode, output_text)
                    measurements.append(
                        {
                            "workload": workload,
                            "index": index,
                            "mode": mode,
                            "wall_seconds": wall_ns / 1_000_000_000,
                            "container_cpu_seconds": (cpu_after - cpu_before) / 1_000_000_000
                            if cpu_after is not None and cpu_before is not None
                            else None,
                            "call_id": result["parts"][0]["callID"],
                        }
                    )
                if (index + 1) % 5 == 0:
                    print(f"{workload}: {index + 1}/{PAIRS} interleaved blocks", flush=True)
        for mode in MODES:
            request(servers[mode]["port"], "/global/dispose", {})
    finally:
        for server in servers.values():
            server["process"].terminate()
            try:
                server["process"].wait(timeout=5)
            except subprocess.TimeoutExpired:
                server["process"].kill()
                server["process"].wait()
            server["log"].close()
        (output / "measurements.json").write_text(json.dumps(measurements, indent=2) + "\n")

    summaries = []
    for workload in ("fixed_cpu_hash", "short_process_stress"):
        baseline = {
            row["index"]: row
            for row in measurements
            if row["workload"] == workload and row["mode"] == "off"
        }
        for mode in MODES:
            selected = [
                row for row in measurements if row["workload"] == workload and row["mode"] == mode
            ]
            ratios = [
                row["wall_seconds"] / baseline[row["index"]]["wall_seconds"] - 1 for row in selected
            ]
            summaries.append(
                {
                    "workload": workload,
                    "mode": mode,
                    "samples": len(selected),
                    "median_wall_seconds": statistics.median(
                        row["wall_seconds"] for row in selected
                    ),
                    "median_overhead_fraction": statistics.median(ratios),
                    "p95_overhead_fraction": percentile(ratios, 0.95),
                    "median_container_cpu_seconds": statistics.median(
                        row["container_cpu_seconds"]
                        for row in selected
                        if row["container_cpu_seconds"] is not None
                    ),
                }
            )
    process_summary = next(
        row for row in summaries if row["workload"] == "fixed_cpu_hash" and row["mode"] == "process"
    )
    data = rows(output / "process" / "events")
    footers = [
        row for row in data if row["kind"] == "trace.close" and "observer_max_rss_bytes" in row
    ]
    assert footers and all(row["complete"] for row in footers)
    perf_pass = (
        process_summary["median_overhead_fraction"] <= 0.05
        and process_summary["p95_overhead_fraction"] <= 0.10
    )
    assert source_identity() == sources, "Capture source changed during benchmark"
    report = {
        "status": "pass" if perf_pass and all(row["pass"] for row in timing) else "diagnostic_only",
        "pairs": PAIRS,
        "source_hashes": sources,
        "fixed_iterations_per_native_command": iterations,
        "overhead_workload": "two identical fixed-iteration native CPU commands plus SHA-256 of 32 MiB; no sleeps/model waits",
        "reference_source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "boundary_check": {
            "description": "conservative excess over independent in-program monotonic markers, includes entry/exit and observer work; not exact kernel timestamps",
            "samples": timing,
        },
        "cpu_reference_absolute_error_ns": str(cpu_delta_ns),
        "cpu_reference_resolution_ns": str(quantum_ns),
        "schedstat_cpu_reference_error_ns": str(runtime_cpu_error_ns),
        "summaries": summaries,
        "collector_max_rss_bytes": max(row["observer_max_rss_bytes"] for row in footers),
        "trace_bytes": {
            mode: sum(file.stat().st_size for file in (output / mode / "events").glob("*.jsonl"))
            for mode in MODES
        },
        "limitations": [
            "Short-process overhead is reported separately and is not a low-overhead guarantee.",
            "Container CPU includes framework, controller, collector and workload; isolated serial test only.",
            "RSS is collector process RSS, not incremental physical memory.",
            "Live model/task observer effect remains P5.",
        ],
    }
    (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.out.resolve())
    print(
        json.dumps(
            {
                "status": result["status"],
                "summaries": result["summaries"],
                "collector_max_rss_bytes": result["collector_max_rss_bytes"],
            },
            indent=2,
        )
    )
