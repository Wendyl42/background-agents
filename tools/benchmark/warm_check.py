#!/usr/bin/env python3
"""Warm an official task environment via normal API, without submitting a model prompt."""

import argparse
import json
import os
import sys
import threading
import time
import uuid

from artifacts import atomic_json, make_server
from common import DEFAULT_CONFIG, external_root, lock, read_json, run_command
from runner import (
    capture,
    cleanup,
    ensure_control_plane,
    export_trace,
    start_process,
    stop_owned_process,
)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--lab-root")
    parser.add_argument("--check-credentials", action="store_true")
    parser.add_argument("--verify-crash-stop", action="store_true")
    args = parser.parse_args()
    lab_root = external_root(args.lab_root)
    config = read_json(DEFAULT_CONFIG)
    runtime = read_json(
        lab_root / "task-workspaces" / args.task_id / "runtime-overlay/runtime.json"
    )
    directory = lab_root / "runs" / f"warm-{uuid.uuid4().hex}"
    directory.mkdir(parents=True, mode=0o700)
    state = {"phase": "allocated", "modelPromptSubmitted": False, "taskId": args.task_id}

    def save():
        atomic_json(directory / "warm.json", state)

    with lock(lab_root / "runs/coordinator.lock"):
        client, cp_state = ensure_control_plane(directory, config, runtime)
        gateway = json.loads(run_command(["docker", "network", "inspect", "bridge"]))[0]["IPAM"][
            "Config"
        ][0]["Gateway"]
        atomic_json(directory / "artifact-registry.json", {})
        server = make_server(
            (gateway, config["artifactPort"]),
            directory / "artifacts",
            directory / "artifact-registry.json",
        )
        threading.Thread(target=server.serve_forever, daemon=True).start()
        collector = start_process(
            [
                sys.executable,
                "packages/opensandbox-infra/collect.py",
                "--out",
                str(directory / "observations-001"),
                "--duration-seconds",
                str(config["sandboxLifetimeSeconds"]),
            ],
            directory / "collector.log",
        )
        atomic_json(directory / "collector.json", collector)
        try:
            state["phase"] = "create_intent"
            save()
            response = client.request(
                "/sessions", "POST", {"title": directory.name, "model": config["model"]}
            )
            root_id = response["sessionId"]
            state.update(rootSessionId=root_id, sessionTree={root_id: None})
            save()
            deadline = time.monotonic() + config["setupTimeoutSeconds"]
            while time.monotonic() < deadline:
                events = client.pages(f"/sessions/{root_id}/events", "events")
                if any(event["type"] == "ready" for event in events):
                    state["ready"] = True
                    break
                containers = capture(directory, state["sessionTree"], checkpoint=False)
                if containers and all(not item["running"] for item in containers):
                    raise RuntimeError("Warm task runtime stopped before ready")
                time.sleep(2)
            containers = capture(directory, state["sessionTree"])
            if not state.get("ready"):
                raise RuntimeError("Warm task did not become ready")
            script = r"""
import json,os
from pathlib import Path
observed=[]
for p in Path('/proc').glob('[0-9]*'):
 try:
  command=(p/'cmdline').read_bytes()
  if b'oi-opencode.exe' in command and b'\x00serve\x00' in command:
   fields=dict(line.split(':',1) for line in (p/'status').read_text().splitlines())
   observed.append({'pid':int(p.name),'uids':fields['Uid'].split(),'noNewPrivileges':fields.get('NoNewPrivs','').strip()})
 except (FileNotFoundError,PermissionError):pass
print(json.dumps(observed))
"""
            container = containers[0]["containerId"]
            processes = json.loads(
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
                    error_log=directory / "process-check-error.log",
                )
            )
            assert len(processes) == 1 and processes[0]["uids"] == ["10001"] * 4
            assert processes[0]["noNewPrivileges"] == "1"
            visibility = r"""
import json,os
from pathlib import Path
paths=['/opt/oi-runtime/lib/python3.12/site-packages','/opt/oi-runtime/lib/node_modules']
t=json.loads(Path('/opt/oi-benchmark/task.json').read_text())
assert all(not os.access(path,os.R_OK|os.X_OK) for path in paths)
assert os.access(t['workspacePath'],os.W_OK)
print(json.dumps({'privateRuntimeDependenciesReadable':False,'workspaceWritable':True,'uid':os.geteuid()}))
"""
            boundary = json.loads(
                run_command(
                    [
                        "docker",
                        "exec",
                        "--user",
                        "10001:10001",
                        container,
                        "/opt/oi-runtime/bin/python3.12",
                        "-I",
                        "-S",
                        "-c",
                        visibility,
                    ],
                    error_log=directory / "visibility-check-error.log",
                )
            )
            atomic_json(
                directory / "agent-boundary.json",
                {"passed": True, "processes": processes, **boundary},
            )
            tools_check = r"""
import json
from urllib.request import build_opener,ProxyHandler
with build_opener(ProxyHandler({})).open('http://127.0.0.1:4096/experimental/tool/ids',timeout=30) as response: available=json.load(response)
required={'spawn-child','get-child-status','send-child-prompt'}
assert required.issubset(set(available)),str(sorted(required-set(available)))
print(json.dumps({'passed':True,'requiredTools':sorted(required),'availableToolCount':len(available)}))
"""
            available_tools = json.loads(
                run_command(
                    [
                        "docker",
                        "exec",
                        "--user",
                        "10001:10001",
                        container,
                        "/opt/oi-runtime/bin/python3.12",
                        "-I",
                        "-S",
                        "-c",
                        tools_check,
                    ],
                    error_log=directory / "tools-check-error.log",
                )
            )
            atomic_json(directory / "child-tools.json", available_tools)
            run_command(
                [
                    "docker",
                    "exec",
                    "--user",
                    "10001:10001",
                    container,
                    "/opt/oi-runtime/bin/python3.12",
                    "-I",
                    "-S",
                    "-c",
                    "import json; from pathlib import Path; "
                    "task=json.loads(Path('/opt/oi-benchmark/task.json').read_text()); "
                    "(Path(task['workspacePath'])/'.oi-benchmark-warm-transport.txt').write_text('No-model artifact transport validation\\n')",
                ],
                error_log=directory / "transport-fixture-error.log",
            )
            publication = json.loads(
                run_command(
                    ["docker", "exec", "--user", "10001:10001", container, "oi-bench", "publish"],
                    error_log=directory / "publish-error.log",
                )
            )
            if publication["bytes"] == 0:
                raise RuntimeError("Warm transport fixture was absent from the published patch")
            run_command(
                [
                    "docker",
                    "exec",
                    "--user",
                    "10001:10001",
                    container,
                    "oi-bench",
                    "fetch",
                    root_id,
                    publication["sha256"],
                    "--output",
                    "/tmp/warm-retrieved.patch",
                ],
                error_log=directory / "fetch-error.log",
            )
            atomic_json(
                directory / "artifact-transport.json",
                {
                    "passed": True,
                    "publication": publication,
                    "scope": "One real sandbox publishes and fetches through the authenticated host bridge; cross-session authorization covered separately.",
                },
            )
            if args.check_credentials:
                credential_check = r"""
import json,os,sys,ssl
from urllib.request import Request,urlopen,build_opener,ProxyHandler
provider_id,model_id=sys.argv[1].split('/',1)
with build_opener(ProxyHandler({})).open('http://127.0.0.1:4096/provider',timeout=30) as response:
 providers=json.load(response)
provider=next(item for item in providers['all'] if item['id']==provider_id)
assert provider_id in providers['connected'] and model_id in provider['models']
base=provider['models'][model_id]['api']['url'].rstrip('/')
request=Request(base+'/models',headers={'Authorization':'Bearer '+os.environ['DEEPSEEK_API_KEY']})
with urlopen(request,timeout=30,context=ssl.create_default_context(cafile='/etc/ssl/certs/ca-certificates.crt')) as response: models=json.load(response)
assert model_id in {item['id'] for item in models['data']}
print(json.dumps({'passed':True,'provider':provider_id,'model':model_id,'authentication':'GET models; no generation requested'}))
"""
                access = json.loads(
                    run_command(
                        [
                            "docker",
                            "exec",
                            "--user",
                            "10001:10001",
                            container,
                            "/opt/oi-runtime/bin/python3.12",
                            "-S",
                            "-c",
                            credential_check,
                            config["model"],
                        ],
                        error_log=directory / "model-check-error.log",
                    )
                )
                atomic_json(directory / "model-access.json", access)
            if args.verify_crash_stop:
                run_command(
                    [
                        "docker",
                        "exec",
                        container,
                        "/opt/oi-runtime/bin/python3.12",
                        "-I",
                        "-S",
                        "-c",
                        "import os,signal,sys; os.kill(int(sys.argv[1]),signal.SIGKILL)",
                        str(processes[0]["pid"]),
                    ]
                )
                deadline = time.monotonic() + 30
                stopped = False
                while time.monotonic() < deadline:
                    active = capture(directory, state["sessionTree"], checkpoint=False)
                    if active and all(not item["running"] for item in active):
                        stopped = True
                        break
                    time.sleep(1)
                atomic_json(
                    directory / "crash-policy.json",
                    {
                        "passed": stopped,
                        "expectedRuntimeMaxRestarts": config["runtimeMaxRestarts"],
                        "process": "OpenCode",
                        "injectedSignal": "SIGKILL",
                        "modelPromptSubmitted": False,
                    },
                )
                if not stopped:
                    raise RuntimeError("Runtime did not stop after controlled OpenCode failure")
        except BaseException as error:
            state["failure"] = type(error).__name__ + ": " + str(error)
            raise
        finally:
            if state.get("rootSessionId"):
                cleanup(client, directory, state, save)
                stop_owned_process(collector)
                export_trace(
                    directory,
                    state,
                    cp_state / "trace-connection.json",
                    profile=config["traceProfile"],
                )
            stop_owned_process(collector)
            stop_owned_process(read_json(cp_state / "process.json"))
            server.shutdown()
            server.server_close()
            state["phase"] = (
                "complete"
                if state.get("ready")
                and state.get("cleanup") == "complete"
                and not state.get("failure")
                else "failed"
            )
            save()
    print(directory)


if __name__ == "__main__":
    main()
