#!/usr/bin/env python3
"""Real benchmark-image trace readiness/UID/stop smoke without a model prompt."""

import argparse
import hashlib
import json
import sys
import uuid
from pathlib import Path

GO_PROBE_COMMANDS = 128
GO_VET_PATH = "/usr/local/go/pkg/tool/linux_amd64/vet"


def verify_shell_result(result, *, go_probe=False):
    parts = [part for part in result.get("parts", []) if part.get("type") == "tool"]
    if len(parts) != 1 or parts[0].get("state", {}).get("status") != "completed":
        raise RuntimeError("Native shell did not return one completed tool result")
    state = parts[0]["state"]
    output = state.get("output")
    if not isinstance(output, str):
        raise RuntimeError("Native shell output is missing")
    lines = output.splitlines()
    if "TRACE_UID=10001" not in lines or "TRACE_READY" not in lines:
        raise RuntimeError("Actual shell output did not verify UID and completion")
    exit_code = state.get("metadata", {}).get("exit")
    if exit_code is not None and (type(exit_code) is not int or exit_code != 0):
        raise RuntimeError("Native shell reported a nonzero exit")
    if go_probe:
        decoded = []
        for line in lines:
            try:
                decoded.append(json.loads(line))
            except ValueError:
                continue
        if {"ok": True, "commands": GO_PROBE_COMMANDS} not in decoded:
            raise RuntimeError("Actual Go oracle output did not confirm all child commands")
    return {
        "shell_output_verified": True,
        "agent_uid": 10001,
        "api_exit_code": exit_code,
        "external_model_calls": 0,
    }


def verify_process_result(directory, *, go_probe=False):
    rows = []
    for path in (directory / "streams").rglob("process-*.jsonl"):
        rows.extend(json.loads(line) for line in path.read_text().splitlines())
    roots = [row["process_instance_id"] for row in rows if row["kind"] == "shell.bind"]
    exits = {row["process_instance_id"]: row for row in rows if row["kind"] == "process.exit"}
    if len(roots) != 1 or exits.get(roots[0], {}).get("exit_code") != 0:
        raise RuntimeError("Raw trace does not prove successful shell exit")
    vet = [
        row
        for row in rows
        if row["kind"] == "process.exec" and row.get("executable") == GO_VET_PATH
    ]
    if go_probe and (
        len(vet) != GO_PROBE_COMMANDS
        or any(exits.get(row["process_instance_id"], {}).get("exit_code") != 0 for row in vet)
    ):
        raise RuntimeError("Raw trace does not prove 128 successful vet executions")
    return {"raw_shell_exit_code": 0, "raw_vet_executions": len(vet)}


def main(args):
    args.workspace = args.workspace.resolve()
    args.lab_root = args.lab_root.resolve()
    args.config = args.config.resolve()
    sys.path.insert(0, str(args.workspace / "tools/benchmark"))
    from artifacts import atomic_json
    from benchmark_delivery import BenchmarkCapture
    from common import read_json, run_command
    from runner import (
        cleanup,
        containers_for,
        ensure_control_plane,
        export_trace,
        stop_owned_process,
    )
    from service import dependencies

    config = read_json(args.config)
    runtime = read_json(
        args.lab_root / "task-workspaces" / args.task_id / "runtime-overlay/runtime.json"
    )
    directory = args.lab_root / "runs" / ("trace-warm-" + uuid.uuid4().hex)
    directory.mkdir(parents=True, mode=0o700)
    state = {
        "runId": directory.name,
        "attemptId": "warm-01",
        "phase": "allocated",
        "taskId": args.task_id,
        "modelPromptSubmitted": False,
    }

    def save():
        atomic_json(directory / "warm.json", state)

    save()
    relay = None
    client = None
    cp_state = None
    capture = None
    try:
        relay = dependencies(directory, directory)
        client, cp_state = ensure_control_plane(directory, config, runtime)
        gateway = json.loads(run_command(["docker", "network", "inspect", "bridge"]))[0]["IPAM"][
            "Config"
        ][0]["Gateway"]
        capture = BenchmarkCapture(directory, state, save, gateway, "process")
        result = client.request(
            "/sessions",
            "POST",
            {"title": directory.name, "model": config["model"], "executionTrace": capture.config},
        )
        state.update(
            rootSessionId=result["sessionId"],
            sessionTree={result["sessionId"]: None},
            phase="created",
        )
        save()
        capture.await_root_ready(client, state["rootSessionId"], config["setupTimeoutSeconds"])
        state["runtimeReady"] = True
        container = containers_for(state["sessionTree"])[0]["containerId"]
        shell_command = "printf 'TRACE_UID='; /usr/bin/id -u; /bin/sleep 0.01; /bin/true; printf 'TRACE_READY\\n'"
        if args.go_probe:
            probe = args.go_probe.resolve()
            run_command(["docker", "cp", str(probe), f"{container}:/tmp/oi-go-lifecycle-probe"])
            shell_command = (
                "printf 'TRACE_UID='; /usr/bin/id -u; "
                f"/tmp/oi-go-lifecycle-probe {GO_VET_PATH} && printf 'TRACE_READY\\n'"
            )
            state["goProbeSha256"] = hashlib.sha256(probe.read_bytes()).hexdigest()
            save()
        script = """import json,urllib.request
def request(path,data=None):
 payload=None if data is None else json.dumps(data).encode()
 req=urllib.request.Request('http://127.0.0.1:4096'+path,data=payload,headers={'Content-Type':'application/json'})
 with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=30) as response:return json.load(response)
session=request('/session',{})['id']
result=request('/session/'+session+'/shell',{'agent':'build','command':SHELL_COMMAND,'model':{'providerID':'deepseek','modelID':'deepseek-v4-flash'}})
print(json.dumps(result))
"""
        script = script.replace("SHELL_COMMAND", repr(shell_command))
        response = json.loads(
            run_command(
                [
                    "docker",
                    "exec",
                    container,
                    "/opt/oi-runtime/bin/python3.12",
                    "-I",
                    "-S",
                    "-c",
                    script,
                ],
                error_log=directory / "shell-error.log",
            )
        )
        atomic_json(directory / "native-shell-response.json", response)
        state["smoke"] = verify_shell_result(response, go_probe=bool(args.go_probe))
        state["ready"] = True
        save()
    except BaseException as error:
        state["failure"] = f"{type(error).__name__}: {error}"
        save()
        raise
    finally:
        try:
            if client and state.get("rootSessionId"):
                try:
                    for item in containers_for(state["sessionTree"]):
                        run_command(
                            ["docker", "logs", item["containerId"]],
                            log=directory / f"runtime-{item['containerId']}.log",
                        )
                except (OSError, RuntimeError) as error:
                    state["diagnosticFailure"] = str(error)
                cleanup(client, directory, state, save)
            if capture:
                capture.stop()
                capture = None
            if state.get("ready"):
                state["smoke"].update(
                    verify_process_result(
                        directory / "execution-capture", go_probe=bool(args.go_probe)
                    )
                )
            if cp_state and state.get("rootSessionId"):
                export_trace(
                    directory,
                    state,
                    cp_state / "trace-connection.json",
                    profile=config["traceProfile"],
                )
        except BaseException as error:
            state["collectionFailure"] = f"{type(error).__name__}: {error}"
        finally:
            if capture:
                capture.stop()
            process_file = directory / "control-plane/process.json"
            if process_file.exists():
                stop_owned_process(read_json(process_file))
            if relay:
                stop_owned_process(relay)
            state["status"] = (
                "pass"
                if state.get("ready")
                and state.get("cleanup") == "complete"
                and state.get("executionCaptureQuality") == "complete"
                and not state.get("failure")
                and not state.get("collectionFailure")
                else "fail"
            )
            save()
            print(
                json.dumps(
                    {
                        "directory": str(directory),
                        "status": state["status"],
                        "failure": state.get("failure"),
                        "trace_quality": state.get("executionCaptureQuality"),
                    }
                )
            )
    if state["status"] != "pass":
        raise RuntimeError("Warm trace evidence did not pass")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--lab-root", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument(
        "--go-probe", type=Path, help="Prebuilt Go lifecycle reference for a managed stress smoke"
    )
    main(parser.parse_args())
