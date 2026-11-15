#!/usr/bin/env python3
"""Deterministic native-shell equivalence and lifecycle acceptance, without models."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

RUNTIME = Path(__file__).resolve().parents[2] / "packages/sandbox-runtime/src"
sys.path.insert(0, str(RUNTIME))

from sandbox_runtime.tracing.config import configure_execution_trace  # noqa: E402

CASE_TIMEOUT_SECONDS = 8
COLLECTION_TIMEOUT_SECONDS = 5


def records(directory: Path) -> list[dict]:
    result = []
    for file in directory.glob("process-*.jsonl"):
        for line in file.read_text().splitlines():
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return result


def closed_records(directory: Path) -> list[dict]:
    deadline = time.monotonic() + COLLECTION_TIMEOUT_SECONDS
    while True:
        rows = records(directory)
        if any(row["kind"] == "trace.close" for row in rows):
            return rows
        if time.monotonic() >= deadline:
            raise AssertionError(f"No collector footer in {directory}")
        time.sleep(0.01)


def assert_complete(rows: list[dict]) -> None:
    assert rows[-1]["kind"] == "trace.close" and rows[-1]["complete"], rows[-5:]
    assert not [row for row in rows if row["kind"] == "trace.loss"]
    assert [row["seq"] for row in rows] == list(range(1, len(rows) + 1))
    starts = {row["process_instance_id"] for row in rows if row["kind"] == "process.start"}
    ends = {row["process_instance_id"] for row in rows if row["kind"] == "process.exit"}
    assert starts == ends
    threads = {row["task_instance_id"] for row in rows if row["kind"] == "thread.start"}
    thread_ends = {row["task_instance_id"] for row in rows if row["kind"] == "thread.exit"}
    assert threads == thread_ends


def run(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    config = {}
    additions, _ = configure_execution_trace(
        output / "work",
        {
            **os.environ,
            "OI_EXECUTION_TRACE_MODE": "process",
            "OI_EXECUTION_TRACE_DIR": str(output / "spool"),
        },
        config,
    )
    base_env = {**os.environ, **additions}
    wrapper = additions["OI_EXECUTION_TRACE_WRAPPER_SHELL"]
    python = shlex.quote(sys.executable)
    threaded = "import threading; threads=[threading.Thread(target=lambda: sum(i*i for i in range(300000))) for _ in range(4)]; [t.start() for t in threads]; [t.join() for t in threads]; print('threads-ok')"
    thread_exec = 'import threading,os,time; threading.Thread(target=lambda: os.execv("/bin/true", ["/bin/true"])).start(); time.sleep(2)'
    reparent = "import os,time; p=os.fork();\nif p==0:\n if os.fork()==0:\n  os.setsid(); os.close(1); os.close(2); time.sleep(0.2)\n os._exit(0)\nos.waitpid(p,0)"
    cases = {
        "serial": "printf a; /bin/sleep 0.05; /bin/true; exit 7",
        "pipeline": "/usr/bin/printf 'b\\na\\n' | /usr/bin/sort | /usr/bin/wc -l",
        "short_circuit": "/bin/false && /bin/sleep 9; /bin/true",
        "short_processes": "for i in $(seq 1 50); do /bin/true; done",
        "threads": f"{python} -c {shlex.quote(threaded)}",
        "thread_exec": f"{python} -c {shlex.quote(thread_exec)}",
        "reparent": f"{python} -c {shlex.quote(reparent)}",
        "exec": "/bin/bash -c 'exec /bin/sleep 0.03'",
        "sigkill": "kill -KILL $$",
        "sigterm": "kill -TERM $$",
        "sigpipe": "yes | head -1",
        "builtin": "cd /tmp; printf builtin-only",
        "parent_identity": 'printf "%s" "$PPID"',
        "substitution": 'x=$(/bin/echo nested); (/bin/echo "$x")',
        "cwd": "cd /tmp; /bin/pwd",
        "long_argv": f"{python} -c 'import sys; print(len(sys.argv[1]))' " + "x" * 20000,
        "empty_arguments": f"{python} -c 'import sys; print(repr(sys.argv[1:]))' kept '' ''",
    }
    summaries = []

    def environment(name):
        directory = output / name
        directory.mkdir()
        context = {
            "inspect_session_id": "process-probe",
            "session_id": "oc-probe",
            "call_id": name,
            "span_id": str(uuid.uuid4()),
            "identity_quality": "exact_call",
        }
        return directory, {
            **base_env,
            "OI_EXECUTION_TRACE_DIR": str(directory),
            "OI_EXECUTION_TRACE_CONTEXT": json.dumps(context),
        }

    for name, command in cases.items():
        directory, env = environment(name)
        baseline = subprocess.run(
            ["/bin/bash", "-c", command], capture_output=True, timeout=CASE_TIMEOUT_SECONDS
        )
        traced = subprocess.run(
            [wrapper, "-c", command], env=env, capture_output=True, timeout=CASE_TIMEOUT_SECONDS
        )
        assert (traced.returncode, traced.stdout, traced.stderr) == (
            baseline.returncode,
            baseline.stdout,
            baseline.stderr,
        ), (name, baseline, traced)
        rows = closed_records(directory)
        assert_complete(rows)
        execs = [row for row in rows if row["kind"] == "process.exec"]
        if name == "short_circuit":
            assert not any(Path(row["executable"]).name == "sleep" for row in execs)
        if name == "short_processes":
            assert sum(Path(row["executable"]).name == "true" for row in execs) == 50
        if name == "threads":
            assert len([row for row in rows if row["kind"] == "thread.start"]) >= 5
            assert len([row for row in rows if row["kind"] == "process.start"]) == 1
        if name == "long_argv":
            assert any(row.get("argv_truncated") for row in execs)
            assert all(row.get("argv_sha256") is None for row in execs if row.get("argv_truncated"))
        if name == "empty_arguments":
            assert any(row.get("argv", [])[-3:] == ["kept", "", ""] for row in execs)
        if name == "cwd":
            assert any(
                row["cwd"] == "/tmp" and Path(row["executable"]).name == "pwd" for row in execs
            )
        summaries.append(
            {
                "case": name,
                "status": "pass",
                "processes": sum(row["kind"] == "process.start" for row in rows),
                "execs": len(execs),
                "events": len(rows),
            }
        )

    directory, env = environment("background")
    started = time.monotonic()
    result = subprocess.run(
        [wrapper, "-c", "sleep 2 >/dev/null 2>&1 & printf returned"],
        env=env,
        capture_output=True,
        timeout=CASE_TIMEOUT_SECONDS,
    )
    elapsed = time.monotonic() - started
    assert result.returncode == 0 and result.stdout == b"returned", result
    assert elapsed < 1, elapsed
    rows = closed_records(directory)
    assert_complete(rows)
    root = next(
        row["process_instance_id"]
        for row in rows
        if row["kind"] == "process.start" and row["is_root"]
    )
    exits = [row for row in rows if row["kind"] == "process.exit"]
    root_end = int(next(row["mono_ns"] for row in exits if row["process_instance_id"] == root))
    assert any(
        int(row["mono_ns"]) > root_end for row in exits if row["process_instance_id"] != root
    )
    summaries.append({"case": "background", "status": "pass", "tool_return_seconds": elapsed})

    concurrent_dirs = []
    concurrent_envs = []
    for index in range(2):
        directory, env = environment(f"concurrent-{index}")
        context = json.loads(env["OI_EXECUTION_TRACE_CONTEXT"])
        context.update(session_id=f"oc-concurrent-{index}", call_id="same-call")
        env["OI_EXECUTION_TRACE_CONTEXT"] = json.dumps(context)
        concurrent_dirs.append(directory)
        concurrent_envs.append(env)
    with ThreadPoolExecutor(2) as pool:
        futures = [
            pool.submit(
                subprocess.run,
                [wrapper, "-c", "sleep 0.2; printf same"],
                env=env,
                capture_output=True,
                timeout=CASE_TIMEOUT_SECONDS,
            )
            for env in concurrent_envs
        ]
        results = [future.result() for future in futures]
    assert all(result.returncode == 0 and result.stdout == b"same" for result in results)
    concurrent_rows = [closed_records(directory) for directory in concurrent_dirs]
    for data in concurrent_rows:
        assert_complete(data)
    assert {data[0]["context"]["session_id"] for data in concurrent_rows} == {
        "oc-concurrent-0",
        "oc-concurrent-1",
    }
    bound = [next(row for row in data if row["kind"] == "shell.bind") for data in concurrent_rows]
    assert bound[0]["process_instance_id"] != bound[1]["process_instance_id"]
    end = [
        next(
            row
            for row in data
            if row["kind"] == "process.exit"
            and row["process_instance_id"] == binding["process_instance_id"]
        )
        for data, binding in zip(concurrent_rows, bound, strict=True)
    ]
    assert max(int(row["mono_ns"]) for row in bound) < min(int(row["mono_ns"]) for row in end)
    summaries.append({"case": "concurrent_identical_calls", "status": "pass"})

    # Independent in-program getrusage counters validate thread rebasing and
    # exclusion of waited-for child CPU from the parent's self CPU total.
    report_cpu = "import os,resource,json; r=resource.getrusage(resource.RUSAGE_SELF); os.write(1,json.dumps({'self_ns':round((r.ru_utime+r.ru_stime)*1e9)}).encode()); os._exit(0)"
    cpu_programs = {
        "cpu_after_thread_exec": f"import os,sys,threading; sum(i*i for i in range(1000000)); t=threading.Thread(target=lambda: os.execv(sys.executable,[sys.executable,'-c',{report_cpu!r}])); t.start(); t.join()",
        "parent_self_cpu": "import subprocess,sys; subprocess.run([sys.executable,'-c','sum(i*i for i in range(3000000))'],check=True); "
        + report_cpu,
    }
    for name, program in cpu_programs.items():
        directory, env = environment(name)
        result = subprocess.run(
            [wrapper, "-c", f"exec {python} -c {shlex.quote(program)}"],
            env=env,
            capture_output=True,
            timeout=CASE_TIMEOUT_SECONDS,
            check=True,
        )
        measured = json.loads(result.stdout)["self_ns"]
        data = closed_records(directory)
        assert_complete(data)
        root_id = next(row["process_instance_id"] for row in data if row["kind"] == "shell.bind")
        terminal = next(
            row
            for row in data
            if row["kind"] == "process.exit" and row["process_instance_id"] == root_id
        )
        assert terminal["cpu_runtime_complete"]
        error_ns = abs(int(terminal["cpu_runtime_ns"]) - measured)
        assert error_ns <= max(2_000_000, measured * 0.02), (name, error_ns, measured)
        summaries.append({"case": name, "status": "pass", "cpu_reference_error_ns": error_ns})

    for name, group_signal in (("cancel_pid", False), ("cancel_group", True)):
        directory, env = environment(name)
        process = subprocess.Popen(
            [wrapper, "-c", "sleep 30"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + COLLECTION_TIMEOUT_SECONDS
            while not any(row["kind"] == "process.exec" for row in records(directory)):
                if time.monotonic() > deadline:
                    raise AssertionError("Cancellation root never exec'd")
                time.sleep(0.01)
            assert (
                next(row["pid"] for row in records(directory) if row["kind"] == "shell.bind")
                == process.pid
            )
            (os.killpg if group_signal else os.kill)(process.pid, signal.SIGTERM)
            process.communicate(timeout=CASE_TIMEOUT_SECONDS)
            assert process.returncode == -signal.SIGTERM, process.returncode
            assert_complete(closed_records(directory))
            summaries.append({"case": name, "status": "pass"})
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()

    directory, env = environment("stop_continue")
    process = subprocess.Popen(
        [wrapper, "-c", "kill -STOP $$; printf resumed"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + COLLECTION_TIMEOUT_SECONDS
        while True:
            stops = [row for row in records(directory) if row["kind"] == "process.group_stop"]
            if stops:
                break
            if time.monotonic() > deadline:
                raise AssertionError("Group stop not observed")
            time.sleep(0.01)
        os.kill(stops[0]["pid"], signal.SIGCONT)
        stdout, stderr = process.communicate(timeout=CASE_TIMEOUT_SECONDS)
        assert process.returncode == 0 and stdout == b"resumed" and not stderr
        assert_complete(closed_records(directory))
        summaries.append({"case": "stop_continue", "status": "pass"})
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()

    report = {
        "status": "pass",
        "backend": "ptrace_lifecycle",
        "cases": summaries,
        "model_requests": 0,
        "scope": "correctness matrix; performance acceptance is separate",
    }
    (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.out.resolve()), indent=2))
