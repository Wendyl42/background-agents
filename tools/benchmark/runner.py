"""Normal-API batch execution with durable intents, artifact capture and scoped cleanup."""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from api import Client, ReadDeadlineReached, ReadStopRequested
from artifacts import atomic_json, make_server, store_patch
from common import (
    CAPTURE_INTERVAL_SECONDS,
    CLEANUP_SETTLE_SECONDS,
    POLL_INTERVAL_SECONDS,
    ROOT,
    digest,
    node_environment,
    now_ms,
    read_json,
    run_command,
    task_id,
)
from reporting import batch_report

TERMINAL_MESSAGES = {"completed", "failed", "cancelled", "canceled"}
CONTAINER_STOP_GRACE_SECONDS = 10
CONTAINER_STOP_COMMAND_TIMEOUT_SECONDS = 30
SNAPSHOT_LAUNCH = [
    "/opt/oi-runtime/bin/python3.12",
    "-I",
    "-S",
    "-c",
    "import ctypes,os,sys; assert ctypes.CDLL(None).prctl(38,1,0,0,0)==0; os.execv('/opt/oi-tools/oi-bench',['oi-bench','snapshot',*sys.argv[1:]])",
]


def process_birth(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except OSError:
        return None


def stop_owned_process(record):
    pid = record.get("pid")
    if not pid or process_birth(pid) != record.get("birth"):
        return
    os.killpg(pid, signal.SIGTERM)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and process_birth(pid) == record["birth"]:
        time.sleep(0.1)
    if process_birth(pid) == record["birth"]:
        os.killpg(pid, signal.SIGKILL)


def start_process(command, log, *, env=None):
    with Path(log).open("ab") as output:
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            env=env,
            stdout=output,
            stderr=output,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    return {"pid": process.pid, "birth": process_birth(process.pid), "startedAtMs": now_ms()}


def ensure_control_plane(run_directory, config, runtime):
    state = run_directory / "control-plane"
    state.mkdir(exist_ok=True, mode=0o700)
    record_file = state / "process.json"
    if record_file.exists():
        record = read_json(record_file)
        if (
            record.get("imageId") == runtime["imageId"]
            and process_birth(record["pid"]) == record["birth"]
        ):
            client = Client(state / "trace-connection.json")
            client.request("/sessions?limit=1")
            return client, state
        stop_owned_process(record)
    source = ROOT / ".cache/opensandbox"
    connection = read_json(source / "connection.json")
    connection.update(
        image=runtime["imageId"],
        python_path="/opt/oi-tools/python-runtime",
        max_spawn_depth=config["maxSpawnDepth"],
        startup_timeout_ms=config["setupTimeoutSeconds"] * 1000,
        inactivity_timeout_ms=config["sandboxLifetimeSeconds"] * 1000,
    )
    atomic_json(state / "connection.json", connection)
    if not (state / "sandbox-env.json").exists():
        shutil.copy2(source / "sandbox-env.json", state / "sandbox-env.json")
        (state / "sandbox-env.json").chmod(0o600)
    atomic_json(
        state / "sandbox-settings.json",
        {
            "sandboxTimeoutMs": config["sandboxLifetimeSeconds"] * 1000,
            "cpuCores": config["cpuCores"],
            "memoryMib": config["memoryMib"],
            "maxConcurrentChildSessions": config["children"],
            "maxTotalChildSessions": config["children"],
            "terminalEnabled": False,
        },
    )
    environment = {
        **node_environment(),
        "OPENINSPECT_LOCAL_STATE": str(state),
        "OPENINSPECT_LOCAL_PORT": str(config["controlPlanePort"]),
    }
    record = start_process(
        ["node", "packages/opensandbox-infra/control-plane.mjs", "serve"],
        state / "service.log",
        env=environment,
    )
    atomic_json(record_file, {**record, "imageId": runtime["imageId"]})
    deadline = time.monotonic() + config["setupTimeoutSeconds"]
    while time.monotonic() < deadline:
        if process_birth(record["pid"]) != record["birth"]:
            raise RuntimeError(f"Local control plane exited; see {state / 'service.log'}")
        try:
            client = Client(state / "trace-connection.json")
            client.request("/sessions?limit=1")
            return client, state
        except (OSError, ValueError, RuntimeError):
            time.sleep(POLL_INTERVAL_SECONDS)
    raise RuntimeError("Local control-plane setup deadline exceeded")


def containers_for(parents):
    identifiers = (
        run_command(["docker", "ps", "-aq", "--filter", "label=openinspect_framework=open-inspect"])
        .decode()
        .split()
    )
    result = []
    for container_id in identifiers:
        try:
            info = json.loads(run_command(["docker", "inspect", container_id]))[0]
        except RuntimeError:
            continue  # TTL can remove a container between ps and inspect.
        labels = info["Config"].get("Labels") or {}
        session_id = labels.get("openinspect_session_id")
        if session_id not in parents:
            continue
        environment = dict(
            entry.split("=", 1) for entry in info["Config"].get("Env", []) if "=" in entry
        )
        token = environment.get("SANDBOX_AUTH_TOKEN", "")
        result.append(
            {
                "sessionId": session_id,
                "parentId": parents[session_id],
                "containerId": info["Id"],
                "imageId": info["Image"],
                "startupAttemptId": labels.get("openinspect_startup_attempt_id"),
                "sandboxId": environment.get("SANDBOX_ID"),
                "providerObjectId": labels.get("opensandbox.io/id"),
                "running": info["State"]["Running"],
                "tokenSha256": hashlib.sha256(token.encode()).hexdigest() if token else None,
            }
        )
    return result


def snapshot_container(item):
    """Capture stopped workspaces inside a disposable, offline helper, never host Git."""
    if item["running"]:
        try:
            return run_command(
                ["docker", "exec", "--user", "10001:10001", item["containerId"], *SNAPSHOT_LAUNCH],
                timeout_seconds=30,
            )
        except RuntimeError:
            # Cancellation or TTL may stop a container between inspect and exec.
            running = (
                run_command(
                    ["docker", "inspect", item["containerId"], "--format", "{{.State.Running}}"]
                )
                .decode()
                .strip()
            )
            if running == "true":
                raise
    metadata = run_command(
        ["docker", "cp", f"{item['containerId']}:/opt/oi-benchmark/task.json", "-"]
    )
    with tarfile.open(fileobj=io.BytesIO(metadata)) as archive:
        members = [entry for entry in archive if entry.isfile()]
        if len(members) != 1 or members[0].size > 16384:
            raise ValueError("Invalid stopped-container task metadata")
        task = json.load(archive.extractfile(members[0]))
    workspace = task["workspacePath"]
    if workspace not in ["/workspace/repo", "/workspace", "/testbed"]:
        raise ValueError("Invalid stopped-container workspace")
    helper = (
        run_command(
            [
                "docker",
                "create",
                "--network",
                "none",
                "--memory",
                "512m",
                "--cpus",
                "1",
                "--entrypoint",
                "/opt/oi-runtime/bin/python3.12",
                "openinspect-benchmark-runtime:local",
                "-I",
                "-c",
                "import time; time.sleep(600)",
            ]
        )
        .decode()
        .strip()
    )
    try:
        run_command(["docker", "start", helper])
        run_command(
            [
                "docker",
                "exec",
                helper,
                "/opt/oi-runtime/bin/python3.12",
                "-I",
                "-c",
                "import os,shutil,sys; p=os.path.realpath(sys.argv[1]); shutil.rmtree(p,ignore_errors=True); os.makedirs(p); os.makedirs('/opt/oi-benchmark',exist_ok=True)",
                workspace,
            ]
        )
        run_command(
            [
                "docker",
                "cp",
                str(ROOT / "tools/benchmark/artifacts.py"),
                f"{helper}:/opt/oi-benchmark/artifacts.py",
            ]
        )
        with tempfile.NamedTemporaryFile(mode="w") as task_file:
            json.dump(task, task_file)
            task_file.flush()
            run_command(["docker", "cp", task_file.name, f"{helper}:/opt/oi-benchmark/task.json"])
        # Copy via a tar pipe: do not extract model-controlled paths or run its Git
        # configuration on the host. No session credentials enter the helper.
        with tempfile.TemporaryFile() as errors:
            source = subprocess.Popen(
                ["docker", "cp", f"{item['containerId']}:{workspace}/.", "-"],
                stdout=subprocess.PIPE,
                stderr=errors,
            )
            try:
                target = subprocess.run(
                    ["docker", "cp", "-", f"{helper}:{workspace}"],
                    stdin=source.stdout,
                    stdout=subprocess.DEVNULL,
                    stderr=errors,
                    timeout=300,
                )
                source.stdout.close()
                if source.wait(timeout=30) or target.returncode:
                    raise RuntimeError("Stopped-container workspace copy failed")
            finally:
                if source.poll() is None:
                    source.kill()
                    source.wait()
        ownership = """
import os,sys
from pathlib import Path
workspace=Path(sys.argv[1])
for directory, children, files in os.walk(workspace,followlinks=False):
 os.chown(directory,10001,10001,follow_symlinks=False)
 for name in [*children,*files]:os.chown(Path(directory)/name,10001,10001,follow_symlinks=False)
Path('/opt/oi-benchmark/task.json').chmod(0o444)
Path('/opt/oi-runtime/lib/python3.12/site-packages').chmod(0o700)
Path('/opt/oi-runtime/lib/node_modules').chmod(0o700)
"""
        run_command(
            [
                "docker",
                "exec",
                helper,
                "/opt/oi-runtime/bin/python3.12",
                "-I",
                "-S",
                "-c",
                ownership,
                workspace,
            ]
        )
        return run_command(
            [
                "docker",
                "exec",
                "--user",
                "10001:10001",
                helper,
                *SNAPSHOT_LAUNCH,
                "--base-commit",
                task["baseCommit"],
            ],
            timeout_seconds=120,
        )
    finally:
        run_command(["docker", "rm", "-f", helper])


def capture(directory, parents, *, checkpoint=True):
    containers = containers_for(parents)
    registry = {
        item["sessionId"]: {"parentId": item["parentId"], "tokenSha256": item["tokenSha256"]}
        for item in containers
        if item["tokenSha256"]
    }
    atomic_json(directory / "artifact-registry.json", registry)
    evidence = directory / "containers.json"
    previous = read_json(evidence) if evidence.exists() else {}
    errors = []
    for item in containers:
        public = {key: value for key, value in item.items() if key != "tokenSha256"}
        previous[item["containerId"]] = public
        if checkpoint:
            try:
                patch = snapshot_container(item)
                store_patch(directory / "artifacts", item["sessionId"], patch, source="checkpoint")
                item["captureSucceeded"] = True
            except (RuntimeError, subprocess.TimeoutExpired) as error:
                item["captureSucceeded"] = False
                errors.append(
                    {"sessionId": item["sessionId"], "atMs": now_ms(), "error": str(error)}
                )
    atomic_json(evidence, previous)
    if errors:
        with (directory / "capture-errors.jsonl").open("a") as stream:
            for error in errors:
                stream.write(json.dumps(error) + "\n")
    return containers


def original_hashes(task):
    return (
        [task["promptSha256"]]
        if task["benchmark"] == "featurebench"
        else [feature["prompt_sha256"] for feature in task["features"]]
    )


def compose_prompt(benchmark, originals, appendix):
    if benchmark == "featurebench":
        original = originals[0]
    else:
        original = (
            b"Original feature 1 (delegate to the first child):\n"
            + originals[0]
            + b"\n\nOriginal feature 2 (delegate to the second child):\n"
            + originals[1]
        )
    return original + appendix


def validate_saved_prompt(task, config, directory):
    expected = original_hashes(task)
    originals = [
        (directory / f"prompt.original.{index + 1}.txt").read_bytes()
        for index in range(len(expected))
    ]
    if [hashlib.sha256(data).hexdigest() for data in originals] != expected:
        raise ValueError("Saved original prompt differs from locked task")
    appendix = (directory / "prompt.appendix.txt").read_bytes()
    if appendix != (ROOT / config["appendix"]).read_bytes():
        raise ValueError("Saved appendix differs from frozen protocol")
    submitted = (directory / "prompt.submitted.txt").read_bytes()
    if submitted != compose_prompt(task["benchmark"], originals, appendix):
        raise ValueError("Saved submitted prompt was modified")
    manifest = read_json(directory / "prompt-manifest.json")
    if manifest != {
        "originalSha256": expected,
        "appendixSha256": hashlib.sha256(appendix).hexdigest(),
        "submittedSha256": hashlib.sha256(submitted).hexdigest(),
        "encoding": "UTF-8",
    }:
        raise ValueError("Saved prompt hash manifest differs")
    return submitted.decode("utf-8")


def prepare_prompt(task, prepared, config, directory):
    expected = original_hashes(task)
    if len(prepared["promptPaths"]) != len(expected):
        raise ValueError("Prepared prompt count differs from task manifest")
    originals = []
    for index, path in enumerate(prepared["promptPaths"]):
        data = Path(path).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected[index]:
            raise ValueError("Prepared original prompt differs from locked task")
        destination = directory / f"prompt.original.{index + 1}.txt"
        destination.write_bytes(data)
        originals.append(data)
    appendix = (ROOT / config["appendix"]).read_bytes()
    (directory / "prompt.appendix.txt").write_bytes(appendix)
    submitted = compose_prompt(task["benchmark"], originals, appendix)
    (directory / "prompt.submitted.txt").write_bytes(submitted)
    atomic_json(
        directory / "prompt-manifest.json",
        {
            "originalSha256": [hashlib.sha256(data).hexdigest() for data in originals],
            "appendixSha256": hashlib.sha256(appendix).hexdigest(),
            "submittedSha256": hashlib.sha256(submitted).hexdigest(),
            "encoding": "UTF-8",
        },
    )
    return submitted.decode("utf-8")


def ensure_submission(client, state, save, prompt, config):
    """Never repeat an uncertain mutation. Reconcile its persisted intent read-only."""
    if not state.get("rootSessionId"):
        if state["phase"] == "allocated":
            state["phase"] = "create_intent"
            state["createIntentAtMs"] = now_ms()
            save()
            response = client.request(
                "/sessions", "POST", {"title": state["title"], "model": config["model"]}
            )
            state["rootSessionId"] = response["sessionId"]
            state["phase"] = "created"
            save()
        else:
            matches = client.find_title(state["title"])
            if len(matches) != 1:
                raise RuntimeError(
                    f"Create intent unresolved ({len(matches)} matches); no POST repeated. Resume to reconcile."
                )
            state["rootSessionId"] = matches[0]["id"]
            state["phase"] = "created"
            save()
    root_id = state["rootSessionId"]
    if state["phase"] == "created":
        state["phase"] = "prompt_intent"
        state["promptIntentAtMs"] = now_ms()
        state["deadlineAtMs"] = now_ms() + config["deadlineSeconds"] * 1000
        save()
        response = client.request(f"/sessions/{root_id}/prompt", "POST", {"content": prompt})
        state["submission"] = response
        state["phase"] = "observing"
        save()
    elif state["phase"] == "prompt_intent":
        messages = client.pages(f"/sessions/{root_id}/messages", "messages")
        matches = [message for message in messages if message.get("content") == prompt]
        if len(matches) != 1:
            raise RuntimeError(
                f"Prompt intent unresolved ({len(matches)} matches); no POST repeated. Resume to reconcile."
            )
        state["submission"] = {"messageId": matches[0]["id"], "reconciled": True}
        state["phase"] = "observing"
        save()
    return root_id


def cleanup(client, directory, state, save):
    state["phase"] = "collecting"
    save()
    root_id = state["rootSessionId"]
    parents = state.get("sessionTree", {root_id: None})
    cancelled, removed, errors = set(), set(), []
    coverage_path = directory / "artifact-coverage.json"
    coverage = read_json(coverage_path).get("sessions", {}) if coverage_path.exists() else {}
    deadline = time.monotonic() + CLEANUP_SETTLE_SECONDS
    while True:
        try:
            parents.update(client.tree(root_id))
        except Exception as error:
            errors.append({"operation": "discover", "error": str(error)})
        state["sessionTree"] = parents
        save()
        for session_id in parents:
            if session_id in cancelled:
                continue
            try:
                client.request(f"/sessions/{session_id}/cancel", "POST", {})
                cancelled.add(session_id)
            except Exception as error:
                errors.append({"operation": "cancel", "sessionId": session_id, "error": str(error)})
        # API cancellation is asynchronous (and a terminal session may keep its runtime).
        # Stop only verified owned containers before reading the final workspace.
        for container in containers_for(parents):
            if not container["running"]:
                continue
            try:
                run_command(
                    [
                        "docker",
                        "stop",
                        "--time",
                        str(CONTAINER_STOP_GRACE_SECONDS),
                        container["containerId"],
                    ],
                    timeout_seconds=CONTAINER_STOP_COMMAND_TIMEOUT_SECONDS,
                )
            except (RuntimeError, subprocess.TimeoutExpired) as error:
                errors.append(
                    {
                        "operation": "stop_before_final_capture",
                        "containerId": container["containerId"],
                        "error": str(error),
                    }
                )
        containers = capture(directory, parents)
        for container in containers:
            if container.get("running") or not container.get("captureSucceeded"):
                continue  # Retry without deleting the only remaining code copy.
            session_id = container["sessionId"]
            if session_id in cancelled:
                coverage[session_id] = {
                    "finalCapture": True,
                    "capturedAtMs": now_ms(),
                    "containerId": container["containerId"],
                }
                atomic_json(coverage_path, {"status": "collecting", "sessions": coverage})
            try:
                connection = read_json(ROOT / ".cache/opensandbox/connection.json")
                provider_id = container["providerObjectId"]
                if not provider_id:
                    raise ValueError(
                        "Missing native OpenSandbox identity; refusing ambiguous deletion"
                    )
                request = Request(
                    connection["api_url"].rstrip("/") + f"/v1/sandboxes/{provider_id}",
                    method="DELETE",
                    headers={"OPEN-SANDBOX-API-KEY": connection["api_key"]},
                )
                try:
                    with build_opener(ProxyHandler({})).open(request, timeout=30) as response:
                        response.read()
                except HTTPError as error:
                    if error.code != 404:
                        raise RuntimeError(
                            f"Native OpenSandbox deletion returned HTTP {error.code}"
                        ) from None
                removed.add(container["containerId"])
            except (RuntimeError, OSError, ValueError) as error:
                errors.append({"operation": "remove", "error": str(error)})
        if time.monotonic() >= deadline:
            break
        time.sleep(POLL_INTERVAL_SECONDS)
    remaining = containers_for(parents)
    for session_id in parents:
        item = coverage.setdefault(session_id, {"finalCapture": False})
        for source in ["checkpoint", "published"]:
            metadata = directory / "artifacts" / session_id / f"{source}.json"
            item[source] = read_json(metadata) if metadata.exists() else None
    artifact_status = (
        "complete"
        if all(item.get("finalCapture") for item in coverage.values())
        else "partial"
        if any(item.get("checkpoint") or item.get("published") for item in coverage.values())
        else "missing"
    )
    state["artifactCoverage"] = artifact_status
    atomic_json(coverage_path, {"status": artifact_status, "sessions": coverage})
    result = {
        "status": "complete"
        if not remaining and len(cancelled) == len(parents) and not errors
        else "incomplete",
        "cancelledSessions": sorted(cancelled),
        "removedContainers": sorted(removed),
        "remainingContainers": [item["containerId"] for item in remaining],
        "errors": errors,
        "settleSeconds": CLEANUP_SETTLE_SECONDS,
    }
    atomic_json(directory / "cleanup.json", result)
    state["cleanup"] = result["status"]
    save()


def export_trace(directory, state, connection_file, *, profile):
    generation = len(list(directory.glob("trace-*"))) + 1
    output = directory / f"trace-{generation:03d}"
    command = [
        "node",
        "scripts/export-openinspect-trace.mjs",
        "--session",
        state["rootSessionId"],
        "--connection-file",
        str(connection_file),
        "--out",
        str(output),
        "--sandbox-backend",
        "opensandbox",
        "--skip-cloudflare-logs",
        "--skip-modal-logs",
    ]
    owned_sessions = set(state.get("sessionTree", {state["rootSessionId"]: None}))
    owned_containers = (
        set(read_json(directory / "containers.json"))
        if (directory / "containers.json").exists()
        else set()
    )
    attachments = directory / "attachments" / f"export-{generation:03d}"
    attachments.mkdir(parents=True)
    for index, observations in enumerate(sorted(directory.glob("observations-*"))):
        for name, flag in [
            ("runtime.jsonl", "--runtime-log"),
            ("host.jsonl", "--host-observations"),
        ]:
            if (observations / name).exists():
                filtered = attachments / f"{index + 1:03d}-{name}"
                with (observations / name).open() as source, filtered.open("w") as target:
                    for line in source:
                        record = json.loads(line)
                        owned = (
                            record.get("session_id") in owned_sessions
                            or record.get("container_id") in owned_containers
                        )
                        global_host = name == "host.jsonl" and (
                            record.get("kind") == "host_environment"
                            or record.get("role") == "server"
                        )
                        if owned or global_host:
                            if global_host:
                                record["attribution"] = (
                                    "shared host/server observation, not exclusive per-attempt cost"
                                )
                            target.write(json.dumps(record) + "\n")
                command.extend([flag, str(filtered)])
    run_command(command, env=node_environment(), log=directory / "export.log")
    state["trace"] = {"status": "exported", "path": str(output)}
    analysis_path = directory / f"analysis-{generation:03d}"
    try:
        run_command(
            [
                "node",
                "tools/openinspect-trace-analysis/cli.mjs",
                "analyze",
                str(output),
                "--profile",
                profile,
                "--out",
                str(analysis_path),
            ],
            env=node_environment(),
            log=directory / "analysis.log",
        )
        state["analysis"] = {"status": "complete", "path": str(analysis_path)}
    except (RuntimeError, OSError) as error:
        state["analysis"] = {
            "status": "incomplete",
            "path": str(analysis_path),
            "error": str(error),
        }
    return output


def run_attempt(lab_root, run_directory, task, state, config):
    directory = run_directory / "attempts" / state["attemptId"]
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    last_report_seconds = 0

    def save():
        nonlocal last_report_seconds
        state["updatedAtMs"] = now_ms()
        atomic_json(directory / "attempt.json", state)
        if time.monotonic() - last_report_seconds >= CAPTURE_INTERVAL_SECONDS:
            batch_report(run_directory)
            last_report_seconds = time.monotonic()

    save()
    prepared_path = lab_root / "task-workspaces" / task_id(task) / "prepared.json"
    prepared = read_json(prepared_path)
    runtime = read_json(prepared_path.parent / "runtime-overlay/runtime.json")
    if runtime["preparedSha256"] != digest(prepared_path):
        raise ValueError("Prepared task changed after runtime build")
    prompt_file = directory / "prompt.submitted.txt"
    prompt = (
        validate_saved_prompt(task, config, directory)
        if prompt_file.exists()
        else prepare_prompt(task, prepared, config, directory)
    )
    client, cp_state = ensure_control_plane(run_directory, config, runtime)
    client.diagnostics_path = directory / "api-requests.jsonl"
    client.read_diagnostics = state.setdefault(
        "readDiagnostics",
        {
            "path": str(client.diagnostics_path),
            "failures": 0,
            "retries": 0,
            "recoveredReads": 0,
        },
    )
    gateway = json.loads(
        run_command(["docker", "network", "inspect", "bridge", "--format", "{{json .IPAM.Config}}"])
    )[0]["Gateway"]
    atomic_json(directory / "artifact-registry.json", {})
    server = make_server(
        (gateway, config["artifactPort"]),
        directory / "artifacts",
        directory / "artifact-registry.json",
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    collector_file = directory / "collector.json"
    if collector_file.exists():
        stop_owned_process(read_json(collector_file))
    observations = directory / f"observations-{len(list(directory.glob('observations-*'))) + 1:03d}"
    collector = start_process(
        [
            sys.executable,
            "packages/opensandbox-infra/collect.py",
            "--out",
            str(observations),
            "--duration-seconds",
            str(config["sandboxLifetimeSeconds"]),
        ],
        directory / "collector.log",
    )
    atomic_json(collector_file, collector)
    interrupted = threading.Event()
    previous_handlers = {
        sig: signal.signal(sig, lambda *_: interrupted.set())
        for sig in [signal.SIGINT, signal.SIGTERM]
    }
    state["runtime"] = runtime
    state["modelRequested"] = config["model"]
    state.setdefault("modelExecution", "pending")
    state.setdefault("benchmarkCorrectness", "pending")
    state.setdefault("childProtocol", "pending")
    state.setdefault("trace", {"status": "pending"})
    state.setdefault("infrastructure", [])
    save()
    try:
        root_id = ensure_submission(client, state, save, prompt, config)
        capture_time = 0
        stable_terminal = 0
        while state["phase"] == "observing":
            try:
                with client.observation(
                    deadline_at_ms=state["deadlineAtMs"],
                    stop_requested=lambda: (
                        interrupted.is_set() or (run_directory / "stop-request.json").exists()
                    ),
                ):
                    parents = client.tree(root_id)
                    state["sessionTree"] = parents
                    messages = {
                        session_id: client.pages(f"/sessions/{session_id}/messages", "messages")
                        for session_id in parents
                    }
            except ReadDeadlineReached:
                state["modelExecution"] = "deadline"
                break
            except ReadStopRequested:
                state["modelExecution"] = "interrupted"
                break
            atomic_json(directory / "messages.json", messages)
            do_capture = time.monotonic() - capture_time >= CAPTURE_INTERVAL_SECONDS
            containers = capture(directory, parents, checkpoint=do_capture)
            if do_capture:
                capture_time = time.monotonic()
            state["lastObservedAtMs"] = now_ms()
            if len(parents) > config["maxSandboxes"] or any(
                parent != root_id for sid, parent in parents.items() if sid != root_id
            ):
                state["childProtocol"] = "failed_topology"
                state["modelExecution"] = "cancelled_protocol_violation"
                break
            if interrupted.is_set() or (run_directory / "stop-request.json").exists():
                state["modelExecution"] = "interrupted"
                break
            if now_ms() >= state["deadlineAtMs"]:
                state["modelExecution"] = "deadline"
                break
            all_terminal = all(
                items and all(item["status"] in TERMINAL_MESSAGES for item in items)
                for items in messages.values()
            )
            stable_terminal = stable_terminal + 1 if all_terminal else 0
            if stable_terminal >= 2:
                state["modelExecution"] = (
                    "completed"
                    if all(
                        item["status"] == "completed"
                        for items in messages.values()
                        for item in items
                    )
                    else "failed"
                )
                break
            if (
                not containers
                and now_ms() - state["promptIntentAtMs"] > config["setupTimeoutSeconds"] * 1000
            ):
                state["modelExecution"] = "interrupted_sandbox_lost"
                state["infrastructure"].append(
                    "No owned sandbox remains after setup deadline; workspace/context cannot be restored"
                )
                break
            save()
            time.sleep(POLL_INTERVAL_SECONDS)
        state["executionEndedAtMs"] = now_ms()
        save()
    except Exception as error:
        state.setdefault("executionEndedAtMs", now_ms())
        state["infrastructure"].append(str(error))
        save()
        # Unknown POST outcomes remain reconcilable; do not replace them with a new attempt.
        if state["phase"] in ["create_intent", "prompt_intent"]:
            raise
        state["modelExecution"] = "infrastructure_failure"
    finally:
        if state.get("rootSessionId") and state["phase"] not in ["create_intent", "prompt_intent"]:
            try:
                cleanup(client, directory, state, save)
            except Exception as error:
                state["cleanup"] = "incomplete"
                state["infrastructure"].append(f"cleanup: {error}")
            stop_owned_process(collector)
            try:
                export_trace(
                    directory,
                    state,
                    cp_state / "trace-connection.json",
                    profile=config["traceProfile"],
                )
            except Exception as error:
                state["trace"] = {"status": "incomplete", "error": str(error)}
            state["phase"] = (
                "collected" if state.get("cleanup") == "complete" else "cleanup_pending"
            )
            save()
        else:
            stop_owned_process(collector)
        server.shutdown()
        server.server_close()
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
    return state
