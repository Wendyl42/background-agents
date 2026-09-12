#!/usr/bin/env python3
"""Run a prepared benchmark batch under the host user service manager, outside Codex."""

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

from artifacts import atomic_json
from common import ROOT, external_root, lock, now_ms, read_json, run_command, safe_id
from reporting import batch_report
from runner import process_birth, start_process, stop_owned_process

SERVICE_STOP_TIMEOUT_SECONDS = 1200
DEPENDENCY_READY_TIMEOUT_SECONDS = 30
PROXY_HOST = "127.0.0.1"
PROXY_PORT = 7890
RELAY_PORT = 17890


def service_state(unit):
    result = subprocess.run(
        [
            "systemctl",
            "--user",
            "show",
            unit,
            "--property=LoadState,ActiveState,SubState,MainPID,Result",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def stop_request(directory):
    request = directory / "stop-request.json"
    if request.exists():
        return read_json(request)
    value = {
        "requestId": uuid.uuid4().hex,
        "requestedAtMs": now_ms(),
        "reason": "User requested safe stop; collect current attempt and keep remaining tasks unstarted",
    }
    atomic_json(request, value)
    return value


def listening(host, port):
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except OSError:
        return False


def dependencies(directory, launch):
    if not listening(PROXY_HOST, PROXY_PORT):
        raise RuntimeError(
            f"Restore the existing model proxy at {PROXY_HOST}:{PROXY_PORT}, then resume"
        )
    running = run_command(
        ["docker", "inspect", "oi-opensandbox-server", "--format", "{{.State.Running}}"]
    )
    if running.strip() != b"true":
        run_command(["docker", "start", "oi-opensandbox-server"], log=launch / "dependencies.log")
    gateway = json.loads(run_command(["docker", "network", "inspect", "bridge"]))[0]["IPAM"][
        "Config"
    ][0]["Gateway"]
    relay = None
    if not listening(gateway, RELAY_PORT):
        relay = start_process(
            [
                sys.executable,
                "packages/opensandbox-infra/proxy.py",
                "--upstream",
                f"http://{PROXY_HOST}:{PROXY_PORT}",
                "--port",
                str(RELAY_PORT),
            ],
            launch / "relay.log",
        )
        atomic_json(launch / "relay-process.json", relay)
    deadline = time.monotonic() + DEPENDENCY_READY_TIMEOUT_SECONDS
    while not listening(gateway, RELAY_PORT):
        if time.monotonic() >= deadline:
            if relay:
                stop_owned_process(relay)
            raise RuntimeError("Docker bridge relay did not become ready; see relay.log")
        time.sleep(0.2)
    return relay


def start(lab_root, run_id, *, probe=False):
    from cli import require_freeze
    from continuation import validate_implementation

    directory = lab_root / "runs" / run_id
    if not probe:
        batch = read_json(directory / "run.json")
        if batch.get("status") == "complete":
            raise ValueError("Batch already complete; read its summary instead")
        require_freeze(lab_root, read_json(directory / "config.json"), directory / "config.json")
        validate_implementation(directory, batch)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Serialize service launchers. The runner also takes the normal coordinator and batch locks.
    with lock(lab_root / "runs/service-launch.lock"):
        marker = directory / "runner-service.json"
        if marker.exists():
            previous = read_json(marker)
            state = service_state(previous["unit"])
            if state.get("MainPID", "0") != "0" or state.get("ActiveState") in [
                "activating",
                "deactivating",
            ]:
                raise RuntimeError("A service already runs this batch; use status or stop")
        generation = f"{now_ms()}-{uuid.uuid4().hex[:8]}"
        launch = directory / "launches" / generation
        launch.mkdir(parents=True, mode=0o700)
        unit = f"oi-bench-{run_id}-{generation}.service"
        record = {
            "runId": run_id,
            "unit": unit,
            "launchId": generation,
            "logPath": str(launch / "runner.log"),
            "createdAtMs": now_ms(),
            "manager": "systemd --user",
            "probe": probe,
        }
        atomic_json(marker, record)
        atomic_json(launch / "launch.json", record)
        run_command(
            [
                "systemd-run",
                "--user",
                f"--unit={unit}",
                "--property=Type=exec",
                "--property=RemainAfterExit=yes",
                "--property=KillMode=mixed",
                "--property=Restart=no",
                f"--property=TimeoutStopSec={SERVICE_STOP_TIMEOUT_SECONDS}s",
                f"--property=WorkingDirectory={ROOT}",
                f"--property=StandardOutput=append:{launch / 'runner.log'}",
                f"--property=StandardError=append:{launch / 'runner.log'}",
                "--setenv=PYTHONUNBUFFERED=1",
                sys.executable,
                str(ROOT / "tools/benchmark/service.py"),
                "probe-worker" if probe else "worker",
                "--lab-root",
                str(lab_root),
                "--run-id",
                run_id,
                "--launch-id",
                generation,
            ],
            log=launch / "systemd-start.log",
        )
        return {**record, "service": service_state(unit)}


def worker(lab_root, run_id, launch_id):
    from cli import execute_batch
    from common import tasks, validate_config

    directory = lab_root / "runs" / run_id
    launch = directory / "launches" / safe_id(launch_id)
    record = {
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "birth": process_birth(os.getpid()),
        "cgroup": Path("/proc/self/cgroup").read_text(),
        "startedAtMs": now_ms(),
    }
    atomic_json(launch / "worker.json", record)
    for sig in [signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, lambda *_: stop_request(directory))
    relay = None
    exit_code = 0
    try:
        relay = dependencies(directory, launch)
        config_path = directory / "config.json"
        config = validate_config(read_json(config_path))
        result = execute_batch(lab_root, config, config_path, tasks(config), run_id, resume=True)
        print(json.dumps({"runId": run_id, "status": result["status"]}), flush=True)
    except Exception as error:
        exit_code = 1
        # Preflight may fail before execute_batch owns the batch. Acquire its normal lock
        # before recording the failure so a rejected duplicate cannot overwrite a live run.
        try:
            with lock(lab_root / "runs/coordinator.lock"), lock(directory / "batch.lock"):
                batch = read_json(directory / "run.json")
                batch["status"] = "blocked"
                batch["blocked"] = {
                    "atMs": now_ms(),
                    "reason": str(error),
                    "launchPath": str(launch),
                }
                atomic_json(directory / "run.json", batch)
                batch_report(directory)
        except RuntimeError:
            pass
        print(str(error), file=sys.stderr, flush=True)
        atomic_json(launch / "error.json", {"atMs": now_ms(), "reason": str(error)})
    finally:
        if relay:
            stop_owned_process(relay)
        atomic_json(launch / "exit.json", {"exitCode": exit_code, "endedAtMs": now_ms()})
    return exit_code


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=["start", "resume", "status", "stop", "worker", "probe", "probe-worker"]
    )
    parser.add_argument("--lab-root", type=Path)
    parser.add_argument(
        "--run-id", help="Defaults to the active batch for status; required for other commands"
    )
    parser.add_argument("--launch-id")
    args = parser.parse_args()
    lab_root = external_root(args.lab_root)
    if args.run_id is None:
        if args.command != "status":
            parser.error("--run-id is required for this command")
        args.run_id = read_json(lab_root / "runs/active.json")["runId"]
    run_id = safe_id(args.run_id)
    directory = lab_root / "runs" / run_id
    if args.command in ["start", "resume", "probe"]:
        result = start(lab_root, run_id, probe=args.command == "probe")
    elif args.command == "stop":
        read_json(directory / "run.json")
        result = stop_request(directory)
    elif args.command == "worker":
        return worker(lab_root, run_id, args.launch_id)
    elif args.command == "probe-worker":
        # A no-model service remains alive after its launching terminal/tool process exits.
        launch = directory / "launches" / safe_id(args.launch_id)
        for step in range(3):
            atomic_json(
                launch / f"probe-{step}.json",
                {
                    "atMs": now_ms(),
                    "pid": os.getpid(),
                    "ppid": os.getppid(),
                    "cgroup": Path("/proc/self/cgroup").read_text(),
                    "step": step,
                },
            )
            time.sleep(3)
        atomic_json(launch / "exit.json", {"exitCode": 0, "endedAtMs": now_ms()})
        return 0
    else:
        marker = directory / "runner-service.json"
        record = read_json(marker) if marker.exists() else None
        result = {
            "runId": run_id,
            "service": service_state(record["unit"]) if record else None,
            "launch": record,
            "progress": read_json(directory / "progress.json")
            if (directory / "progress.json").exists()
            else None,
            "stopRequested": (directory / "stop-request.json").exists(),
        }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
