#!/usr/bin/env python3
"""Exercise real OpenCode model-tool hooks using a loopback-only scripted provider."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HEALTH_TIMEOUT_SECONDS = 40
HEALTH_REQUEST_TIMEOUT_SECONDS = 1
REQUEST_TIMEOUT_SECONDS = 45
RUNTIME = Path(__file__).resolve().parents[2] / "packages/sandbox-runtime/src"
sys.path.insert(0, str(RUNTIME))

from sandbox_runtime.tracing.config import (  # noqa: E402
    configure_execution_trace,
    ensure_trace_ready,
)


def run(
    output: Path,
    *,
    inject_clock_failure: bool = False,
    inject_shell_override: bool = False,
    mode: str = "tools",
) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    version = subprocess.check_output(["opencode", "--version"], text=True).strip()
    if version != "1.18.18":
        raise RuntimeError(f"Unsupported OpenCode version: {version}")
    work = output / "work"
    work.mkdir()
    if inject_shell_override:
        (work / "opencode.json").write_text(json.dumps({"shell": "/bin/sh"}))
    (work / "probe.txt").write_text("trace probe data\n")
    calls: list[dict] = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            available = [tool["function"]["name"] for tool in body.get("tools", [])]
            messages = body.get("messages", [])
            user_text = " ".join(
                json.dumps(message.get("content"))
                for message in messages
                if message.get("role") == "user"
            )
            scenario = next(
                (
                    name
                    for name in ("cancel", "timeout", "error", "task", "read", "shell")
                    if f"probe:{name}" in user_text
                ),
                "read",
            )
            done = any(message.get("role") == "tool" for message in messages)
            calls.append(
                {"path": self.path, "scenario": scenario, "tools": available, "done": done}
            )
            use_tool = bool(available) and not done
            if use_tool:
                if scenario in ("shell", "timeout", "cancel"):
                    name = "bash" if "bash" in available else "shell"
                    args = {
                        "command": "sleep 30"
                        if scenario != "shell"
                        else f"python3 -c 'import time; print(time.monotonic_ns())' > {shlex.quote(str(work / 'clock-sample.txt'))}; printf shell-ok; exit 7",
                        "description": "trace probe",
                        "timeout": 50 if scenario == "timeout" else 60000,
                    }
                elif scenario == "task":
                    name = "task"
                    args = {
                        "description": "trace child",
                        "prompt": "probe:read",
                        "subagent_type": "general",
                    }
                else:
                    name = "read"
                    args = {
                        "filePath": str(
                            work / ("missing.txt" if scenario == "error" else "probe.txt")
                        )
                    }
                if name not in available:
                    raise RuntimeError(f"Missing requested tool {name}: {available}")
                delta = {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call-probe",
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)},
                        }
                    ],
                }
                finish = "tool_calls"
            else:
                delta = {"role": "assistant", "content": "probe complete"}
                finish = "stop"
            chunks = [
                {
                    "id": "chatcmpl-probe",
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": "probe",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                },
                {
                    "id": "chatcmpl-probe",
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": "probe",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                },
            ]
            data = (
                "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    config_dir = output / "config"
    config_dir.mkdir()
    config = {
        "model": "traceprobe/probe",
        "permission": {"*": "allow"},
        "provider": {
            "traceprobe": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Trace Probe",
                "options": {
                    "baseURL": f"http://127.0.0.1:{provider.server_port}/v1",
                    "apiKey": "local-probe",
                },
                "models": {"probe": {"name": "Probe", "limit": {"context": 32000, "output": 4096}}},
            }
        },
    }
    environment = {
        **os.environ,
        "OI_EXECUTION_TRACE_MODE": mode,
        "OI_EXECUTION_TRACE_DIR": str(output / "events"),
        "SESSION_CONFIG": json.dumps(
            {"session_id": "p1-inspect", "parent_session_id": "p1-parent"}
        ),
        "OPENCODE_CONFIG_DIR": str(config_dir),
        "OPENCODE_DISABLE_AUTOUPDATE": "true",
        "OPENCODE_DISABLE_MODELS_FETCH": "true",
        "OI_RUNTIME_BOOT_ID": "probe-boot",
    }
    additions, _ = configure_execution_trace(work, environment, config)
    environment.update(additions)
    if inject_clock_failure:
        environment["OI_EXECUTION_TRACE_CLOCK_HELPER"] = "/missing-clock-helper.py"
    environment["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
    for directory in (config_dir, work / ".opencode"):
        directory.mkdir(parents=True, exist_ok=True)
        for name in ("node_modules", "package.json", "package-lock.json"):
            source = Path("/app/opencode-deps") / name
            if source.exists():
                (directory / name).symlink_to(source, target_is_directory=source.is_dir())
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    def request(route, payload=None, timeout_seconds=REQUEST_TIMEOUT_SECONDS):
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{route}",
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout_seconds) as response:
            return json.load(response)

    def records():
        result = []
        for file in (output / "events").glob("*.jsonl"):
            for line in file.read_text().splitlines():
                with contextlib.suppress(json.JSONDecodeError):
                    result.append(json.loads(line))
        return result

    with (output / "opencode.log").open("w") as log:
        server = subprocess.Popen(
            [
                shutil.which("opencode"),
                "serve",
                "--port",
                str(port),
                "--hostname",
                "127.0.0.1",
                "--print-logs",
            ],
            cwd=work,
            env=environment,
            stdout=log,
            stderr=log,
        )
        try:
            deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
            while True:
                try:
                    request("/global/health", timeout_seconds=HEALTH_REQUEST_TIMEOUT_SECONDS)
                    break
                except (urllib.error.URLError, TimeoutError):
                    if time.monotonic() > deadline or server.poll() is not None:
                        raise RuntimeError("OpenCode failed to start")
                    time.sleep(0.1)

            try:
                asyncio.run(
                    ensure_trace_ready(
                        output / "events",
                        environment["OI_EXECUTION_TRACE_HANDSHAKE"],
                        f"http://127.0.0.1:{port}",
                        work,
                    )
                )
            except RuntimeError:
                if not (inject_clock_failure or inject_shell_override):
                    raise
                assert calls == [], calls
                if inject_clock_failure:
                    assert not list((output / "events").glob("*.jsonl"))
                else:
                    assert json.loads((work / "opencode.json").read_text())["shell"] == "/bin/sh"
                    assert not any(row["kind"] == "tool.start" for row in records())
                report = {
                    "status": "pass",
                    "fault": "missing_clock_helper"
                    if inject_clock_failure
                    else "unsupported_project_shell",
                    "readiness": "refused",
                    "model_requests": 0,
                    "tool_executions": 0,
                }
                (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
                return report
            if inject_clock_failure or inject_shell_override:
                raise AssertionError("Faulty tracing unexpectedly became ready")

            def prompt(scenario):
                sid = request("/session", {})["id"]
                result = request(
                    f"/session/{sid}/message",
                    {
                        "model": {"providerID": "traceprobe", "modelID": "probe"},
                        "parts": [{"type": "text", "text": f"probe:{scenario}"}],
                    },
                )
                (output / f"response-{scenario}-{sid}.json").write_text(
                    json.dumps(result, indent=2)
                )
                return sid, result

            with ThreadPoolExecutor(2) as pool:
                futures = [pool.submit(prompt, scenario) for scenario in ("read", "shell")]
                results = [future.result() for future in futures]
            for scenario in ("error", "timeout", "task"):
                results.append(prompt(scenario))
            cancel_sid = request("/session", {})["id"]
            with ThreadPoolExecutor(1) as pool:
                future = pool.submit(
                    request,
                    f"/session/{cancel_sid}/message",
                    {
                        "model": {"providerID": "traceprobe", "modelID": "probe"},
                        "parts": [{"type": "text", "text": "probe:cancel"}],
                    },
                )
                deadline = time.monotonic() + 15

                def cancellation_ready():
                    rows = records()
                    contexts = [
                        row
                        for row in rows
                        if row["kind"] == "shell.context" and row["session_id"] == cancel_sid
                    ]
                    if mode == "tools":
                        return bool(contexts)
                    span_ids = {row["span_id"] for row in contexts}
                    roots = {
                        row["pid"]
                        for row in rows
                        if row["kind"] == "shell.bind" and row["span_id"] in span_ids
                    }
                    return any(
                        row["kind"] == "process.exec" and row["pid"] in roots for row in rows
                    )

                while not cancellation_ready():
                    if time.monotonic() > deadline:
                        raise RuntimeError("Cancellation tool never started")
                    time.sleep(0.02)
                request(f"/session/{cancel_sid}/abort", {})
                future.result()
            data = records()
            starts = [
                row
                for row in data
                if row["kind"] == "tool.start" and row["start_boundary"] == "tool_execute_before"
            ]
            ends = [row for row in data if row["kind"] == "tool.end"]
            observed = [row for row in data if row["kind"] == "tool.terminal_observed"]
            assert len(starts) == 7, (len(starts), calls)
            assert len({row["span_id"] for row in starts}) == len(starts)
            assert len(ends) >= 4, ends
            assert any(row["status"] == "error" for row in observed), observed
            assert any(row["exit_code"] == 7 for row in ends), ends
            assert any(
                row["kind"] == "session.identity" and row["parent_session_id"] for row in data
            )
            task_start = next(row for row in starts if row["tool"] == "task")
            task_edges = [
                row
                for row in data
                if row["kind"] == "task.link" and row["span_id"] == task_start["span_id"]
            ]
            assert len(task_edges) == 1
            assert any(
                row["tool"] == "read" and row["session_id"] == task_edges[0]["child_session_id"]
                for row in starts
            )
            for end in ends:
                start = next(row for row in starts if row["span_id"] == end["span_id"])
                assert int(end["mono_ns"]) >= int(start["mono_ns"])
            shell_end = next(row for row in ends if row["exit_code"] == 7)
            shell_start = next(row for row in starts if row["span_id"] == shell_end["span_id"])
            sample = int((work / "clock-sample.txt").read_text())
            assert int(shell_start["mono_ns"]) <= sample <= int(shell_end["mono_ns"])
            request("/global/dispose", {})
            deadline_seconds = time.monotonic() + 5
            while True:
                collected = records()
                opened_ids = {row["stream_id"] for row in collected if row["kind"] == "trace.open"}
                closed = [row for row in collected if row["kind"] == "trace.close"]
                if {row["stream_id"] for row in closed} == opened_ids:
                    break
                if time.monotonic() > deadline_seconds:
                    raise AssertionError("Execution streams did not close")
                time.sleep(0.01)
            assert closed and all(row["complete"] for row in closed), closed
            if mode == "process":
                expected_spans = {
                    row["span_id"] for row in collected if row["kind"] == "shell.context"
                }
                assert expected_spans == {
                    row["span_id"] for row in collected if row["kind"] == "shell.bind"
                }
            report = {
                "status": "pass",
                "tool_starts": len(starts),
                "execution_ends": len(ends),
                "observed_terminals": len(observed),
                "local_provider_requests": len(calls),
                "external_model_requests": 0,
                "clock_bracketing": "Bun hrtime contains independent Python monotonic sample",
                "clean_dispose": True,
                "mode": mode,
                "process_bindings": sum(row["kind"] == "shell.bind" for row in records()),
                "scenarios": [
                    "concurrent_read_shell",
                    "read_error",
                    "shell_exit_7",
                    "timeout",
                    "task_child",
                    "cancel",
                ],
                "abnormal_end_policy": "observed terminal or open; never fabricate tool.execute.after",
            }
            (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
            return report
        finally:
            (output / "provider-requests.json").write_text(json.dumps(calls, indent=2) + "\n")
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
            provider.shutdown()
            provider.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--inject-clock-failure", action="store_true")
    parser.add_argument("--inject-shell-override", action="store_true")
    parser.add_argument("--mode", choices=("tools", "process"), default="tools")
    args = parser.parse_args()
    if args.inject_shell_override and args.mode != "process":
        parser.error("--inject-shell-override requires --mode process")
    print(
        json.dumps(
            run(
                args.out.resolve(),
                inject_clock_failure=args.inject_clock_failure,
                inject_shell_override=args.inject_shell_override,
                mode=args.mode,
            ),
            indent=2,
        )
    )
