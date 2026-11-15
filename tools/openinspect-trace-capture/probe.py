#!/usr/bin/env python3
"""Run the P0 capability and real OpenCode root-binding acceptance probe.

Requires a disposable environment with OpenCode 1.18.18 and its staged deps.
No model requests are made. Output is a new directory, never a live workspace.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HEALTH_TIMEOUT_SECONDS = 40
REQUEST_TIMEOUT_SECONDS = 20
PROTOTYPE = Path(__file__).parent / "prototype"


def capability() -> dict:
    pid = os.fork()
    if pid == 0:
        lib = ctypes.CDLL(None, use_errno=True)
        result = lib.ptrace(0, 0, None, None)
        os._exit(0 if result == 0 else min(ctypes.get_errno(), 255))
    _, status = os.waitpid(pid, 0)
    return {
        "kernel": platform.release(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "ptrace_child_errno": os.waitstatus_to_exitcode(status),
        "btf_readable": os.access("/sys/kernel/btf/vmlinux", os.R_OK),
        "unprivileged_bpf_disabled": Path("/proc/sys/kernel/unprivileged_bpf_disabled")
        .read_text()
        .strip(),
        "ebpf_status": "not_selected_no_privileged_loader_validated",
    }


def run(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    observations = capability()
    (output / "capability.json").write_text(json.dumps(observations, indent=2) + "\n")
    if observations["ptrace_child_errno"]:
        raise RuntimeError("Child ptrace unavailable: see capability.json")
    binary = shutil.which("opencode")
    if binary is None:
        raise RuntimeError("OpenCode is not installed")
    version = subprocess.check_output([binary, "--version"], text=True).strip()
    if version != "1.18.18":
        raise RuntimeError(f"Unsupported OpenCode version {version}")
    work = output / "work"
    config = output / "config"
    work.mkdir()
    config.mkdir()
    plugin_dir = work / ".opencode" / "plugins"
    plugin_dir.mkdir(parents=True)
    shutil.copy(PROTOTYPE / "plugin.js", plugin_dir / "trace-probe.js")
    for directory in (config, work / ".opencode"):
        for name in ("node_modules", "package.json", "package-lock.json"):
            source = Path("/app/opencode-deps") / name
            if source.exists():
                (directory / name).symlink_to(source, target_is_directory=source.is_dir())
    bindir = output / "bin"
    bindir.mkdir()
    wrapper = bindir / "bash"
    wrapper.write_text(
        f"#!{sys.executable}\n" + (PROTOTYPE / "launcher.py").read_text().split("\n", 1)[1]
    )
    wrapper.chmod(0o755)
    events = output / "events"
    events.mkdir()
    env = {
        **os.environ,
        "OI_TRACE_PROBE_DIR": str(events),
        "OPENCODE_CONFIG_DIR": str(config),
        "OPENCODE_CONFIG_CONTENT": json.dumps(
            {"shell": str(wrapper), "permission": {"*": "allow"}}
        ),
        "OPENCODE_DISABLE_AUTOUPDATE": "true",
        "OPENCODE_DISABLE_MODELS_FETCH": "true",
    }
    direct_events = output / "direct-events"
    direct_events.mkdir()
    direct_cases = [
        "exit 7",
        "true",
        "kill -TERM $$",
        "kill -KILL $$",
        "printf out; printf err >&2",
    ]
    direct_results = []
    for command in direct_cases:
        baseline = subprocess.run(["/bin/bash", "-c", command], capture_output=True, timeout=5)
        traced = subprocess.run(
            [str(wrapper), "-c", command],
            env={
                **env,
                "OI_TRACE_PROBE_DIR": str(direct_events),
                "OI_TRACE_PROBE_CONTEXT": json.dumps(
                    {
                        "token": str(uuid.uuid4()),
                        "session_id": "direct-parity",
                        "call_id": str(uuid.uuid4()),
                    }
                ),
            },
            capture_output=True,
            timeout=5,
        )
        assert (traced.returncode, traced.stdout, traced.stderr) == (
            baseline.returncode,
            baseline.stdout,
            baseline.stderr,
        ), (command, baseline, traced)
        direct_results.append(
            {
                "command": command,
                "baseline_returncode": baseline.returncode,
                "traced_returncode": traced.returncode,
                "output_equal": True,
            }
        )
    (output / "direct-parity.json").write_text(json.dumps(direct_results, indent=2) + "\n")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    def request(route: str, payload: dict | None = None) -> dict:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{route}",
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return json.load(response)

    with (output / "opencode.log").open("w") as log:
        server = subprocess.Popen(
            [binary, "serve", "--port", str(port), "--hostname", "127.0.0.1"],
            cwd=work,
            env=env,
            stdout=log,
            stderr=log,
        )
        try:
            deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
            while True:
                try:
                    request("/global/health")
                    break
                except (urllib.error.URLError, TimeoutError):
                    if time.monotonic() > deadline or server.poll() is not None:
                        raise RuntimeError("OpenCode did not start; see opencode.log")
                    time.sleep(0.1)
            sessions = [request("/session", {})["id"] for _ in range(2)]
            command = "sleep 0.25; printf probe-identical"

            def shell(session_id: str, command: str) -> dict:
                return request(
                    f"/session/{session_id}/shell",
                    {
                        "agent": "build",
                        "command": command,
                        "model": {"providerID": "anthropic", "modelID": "claude-sonnet-4-6"},
                    },
                )

            with ThreadPoolExecutor(2) as pool:
                futures = [pool.submit(shell, sid, command) for sid in sessions]
                results = [future.result() for future in futures]
            for result in results:
                assert "probe-identical" in result["parts"][0]["state"]["output"]
            results.append(shell(sessions[0], "exit 7"))
            results.append(shell(sessions[1], "true"))
            prior_calls = {result["parts"][0]["callID"] for result in results}
            with ThreadPoolExecutor(1) as pool:
                future = pool.submit(shell, sessions[0], "sleep 30")
                deadline = time.monotonic() + 5
                while True:
                    ready = False
                    for file in events.glob("*.jsonl"):
                        for line in file.read_text().splitlines():
                            try:
                                record = json.loads(line)
                            except json.JSONDecodeError:
                                continue  # The writer may be midway through its final line.
                            if (
                                record["kind"] == "root_bound"
                                and record["call_id"] not in prior_calls
                            ):
                                ready = True
                    if ready:
                        break
                    if time.monotonic() > deadline:
                        raise RuntimeError("Cancellation probe never launched")
                    time.sleep(0.01)
                request(f"/session/{sessions[0]}/abort", {})
                results.append(future.result())
            records = [
                json.loads(line)
                for file in events.glob("*.jsonl")
                for line in file.read_text().splitlines()
            ]
            hooks = [record for record in records if record["kind"] == "shell_hook"]
            roots = [record for record in records if record["kind"] == "root_bound"]
            exits = [record for record in records if record["kind"] == "root_exit"]
            assert len(hooks) == len(roots) == len(exits) == 5, (len(hooks), len(roots), len(exits))
            assert len({record["token"] for record in roots}) == 5
            assert {record["token"] for record in hooks} == {record["token"] for record in roots}
            assert {(record["session_id"], record["call_id"]) for record in hooks} == {
                (result["info"]["sessionID"], result["parts"][0]["callID"]) for result in results
            }
            for root in roots:
                hook = next(item for item in hooks if item["token"] == root["token"])
                assert (
                    root["session_id"] == hook["session_id"] and root["call_id"] == hook["call_id"]
                )
            assert any(item["exit_code"] == 7 for item in exits)
            assert any(item["signal"] == signal.SIGTERM for item in exits)
            first = [
                next(item for item in roots if item["token"] == hook["token"]) for hook in hooks[:2]
            ]
            first_exits = [
                next(item for item in exits if item["token"] == root["token"]) for root in first
            ]
            assert max(int(item["mono_ns"]) for item in first) < min(
                int(item["mono_ns"]) for item in first_exits
            )
            report = {
                "status": "pass",
                "opencode_version": version,
                "backend": "ptrace_lifecycle",
                "binding": "per_call_shell_env_token_to_launcher_child",
                "same_sandbox_concurrent_sessions": 2,
                "calls": 5,
                "misattributions": 0,
                "nonzero_exit_preserved": True,
                "short_builtin": True,
                "abort_sigterm_preserved": True,
                "model_requests": 0,
                "direct_launcher_parity_cases": len(direct_cases),
                "scope": "P0 prototype: root binding only; not process-tree completeness or overhead acceptance",
            }
            (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
            return report
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    options = parser.parse_args()
    print(json.dumps(run(options.out.resolve()), indent=2))
