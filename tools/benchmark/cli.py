#!/usr/bin/env python3
"""Prepare, validate, start or reattach OpenInspect benchmark batches from durable state."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

from artifacts import atomic_json
from common import (
    DEFAULT_CONFIG,
    ROOT,
    digest,
    external_root,
    lock,
    max_task_memory_mib,
    node_environment,
    now_ms,
    read_json,
    run_command,
    safe_id,
    task_config,
    task_id,
    tasks,
    validate_config,
)
from continuation import prepare_continuation, record_implementation, validate_implementation
from environment import build_core, build_task
from reporting import analyze_batch, assess_attempt, attempt_state, batch_report
from runner import ensure_control_plane, export_trace, run_attempt, stop_owned_process


def doctor(lab_root, config):
    checks = []

    def check(name, operation):
        try:
            detail = operation()
            checks.append({"name": name, "passed": True, "detail": detail})
        except Exception as error:
            checks.append({"name": name, "passed": False, "detail": str(error)})

    check("configuration", lambda: bool(validate_config(config)))
    check("external_directory", lambda: str(external_root(lab_root)))
    check(
        "node", lambda: run_command(["node", "--version"], env=node_environment()).decode().strip()
    )
    check(
        "docker",
        lambda: json.loads(run_command(["docker", "info", "--format", "{{json .}}"])).get(
            "ServerVersion"
        ),
    )
    check(
        "runtime_image",
        lambda: (
            run_command(
                ["docker", "image", "inspect", config["runtimeImage"], "--format", "{{.Id}}"]
            )
            .decode()
            .strip()
        ),
    )

    def private_config():
        for name in ["connection.json", "sandbox-env.json"]:
            if not (ROOT / ".cache/opensandbox" / name).is_file():
                raise ValueError(f"Missing private {name}; see OpenSandbox README")
        environment = read_json(ROOT / ".cache/opensandbox/sandbox-env.json")
        if not environment.get("DEEPSEEK_API_KEY"):
            raise ValueError("Missing configured DEEPSEEK_API_KEY")
        return "Required files and model key present; availability is established by real API trial"

    check("private_configuration", private_config)

    def native_api():
        connection = read_json(ROOT / ".cache/opensandbox/connection.json")
        request = Request(
            connection["api_url"].rstrip("/") + "/v1/sandboxes",
            headers={"OPEN-SANDBOX-API-KEY": connection["api_key"]},
        )
        with build_opener(ProxyHandler({})).open(request, timeout=30) as response:
            response.read()
            return {"httpStatus": response.status, "authenticated": True}

    check("native_sandbox_api", native_api)

    def capacity():
        usage = shutil.disk_usage(lab_root)
        meminfo = dict(
            line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines()
        )
        available_mib = int(meminfo["MemAvailable"].split()[0]) // 1024
        needed_mib = (
            max(max_task_memory_mib(config) * config["maxSandboxes"], config["graderMemoryMib"])
            + 2048
        )
        if available_mib < needed_mib or usage.free < 20 * 1024**3:
            raise ValueError(
                f"Insufficient available capacity: memory {available_mib} MiB, disk {usage.free} bytes"
            )
        return {
            "availableMemoryMib": available_mib,
            "requiredMemoryMib": needed_mib,
            "freeDiskBytes": usage.free,
            "scoringSchedule": "after model containers removed",
        }

    check("capacity", capacity)
    report = {
        "checkedAtMs": now_ms(),
        "passed": all(item["passed"] for item in checks),
        "checks": checks,
    }
    atomic_json(lab_root / "runs/doctor.json", report)
    return report


def adapter_command(lab_root, task, action, output=None):
    benchmark = task["benchmark"]
    python = (
        str(lab_root / "cache/featurebench-venv/bin/python")
        if benchmark == "featurebench"
        else sys.executable
    )
    command = [
        python,
        str(ROOT / f"tools/benchmark/{benchmark}.py"),
        action,
        "--lab-root",
        str(lab_root),
        "--task-id",
        task_id(task),
    ]
    if output is not None:
        command.extend(["--output", str(output)])
    return command


def prepare_tasks(lab_root, selected, config):
    results = []
    for task in selected:
        directory = lab_root / "task-workspaces" / task_id(task)
        try:
            if not (directory / "prepared.json").exists() or not read_json(
                directory / "prepared.json"
            ).get("ready"):
                command = adapter_command(lab_root, task, "prepare", directory)
                run_command(command, log=lab_root / "runs/preparation" / f"{task_id(task)}.log")
            prepared = read_json(directory / "prepared.json")
            if not prepared.get("ready"):
                raise ValueError("Adapter did not produce a ready task")
            runtime = build_task(lab_root, prepared, config)
            results.append(
                {
                    "taskId": task_id(task),
                    "status": "prepared",
                    "runtimeImageId": runtime["imageId"],
                }
            )
        except Exception as error:
            results.append({"taskId": task_id(task), "status": "failed", "error": str(error)})
        atomic_json(lab_root / "runs/preparation/report.json", {"tasks": results})
        print(json.dumps(results[-1]), flush=True)
    return results


def calibration_files(lab_root, task, runtime):
    base = lab_root / "runs/calibration" / task["benchmark"] / task_id(task)
    reports = list(base.rglob("calibration.json")) if base.exists() else []
    # CooperBench also keeps mutable latest-report aliases. Freeze and later
    # scoring references must use the preserved report in its own generation.
    reports = [
        path
        for path in reports
        if not (generation := read_json(path).get("attempt_directory"))
        or path.resolve().parent == Path(generation).resolve()
    ]

    def is_overlay(path):
        report = read_json(path)
        return (
            "overlays" in path.parts
            or "overlay" in path.parts
            or bool(report.get("preparedImage"))
            or report.get("environment_kind") == "runtime_overlay"
            or bool(report.get("official_reference_report"))
        )

    official = [path for path in reports if not is_overlay(path)]
    overlay = [path for path in reports if is_overlay(path)]

    def latest(paths):
        return max(paths, key=lambda path: path.stat().st_mtime_ns) if paths else None

    return latest(official), latest(overlay)


def calibrate_tasks(lab_root, selected, config, *, overlay=False):
    results = []
    for task in selected:
        directory = lab_root / "task-workspaces" / task_id(task)
        base = lab_root / "runs/calibration" / task["benchmark"] / task_id(task)
        output = base / ("overlays" if overlay else "official") / uuid.uuid4().hex
        command = adapter_command(lab_root, task, "calibrate", output)
        if overlay:
            prepared = read_json(directory / "prepared.json")
            runtime = read_json(directory / "runtime-overlay/runtime.json")
            if task["benchmark"] == "featurebench":
                command.extend(
                    [
                        "--prepared-image",
                        runtime["imageId"],
                        "--baseline-commit",
                        prepared["baseCommit"],
                    ]
                )
            else:
                command.extend(["--image-id", runtime["imageId"]])
        try:
            run_command(command, log=base / "adapter.log")
            results.append({"taskId": task_id(task), "status": "executed"})
        except Exception as error:
            results.append({"taskId": task_id(task), "status": "failed", "error": str(error)})
        atomic_json(
            lab_root / "runs/calibration/command-report.json",
            {"tasks": results, "overlay": overlay},
        )
        print(json.dumps(results[-1]), flush=True)
    return results


def validate_runtime_provenance(lab_root, directory, runtime):
    core = read_json(lab_root / "cache/runtime-overlay/core.json")
    if runtime.get("core") != core:
        raise ValueError("Runtime was built with a different core or runtime source")
    for filename, metadata_key in [
        ("artifacts.py", "artifactScriptSha256"),
        ("launch_opencode.py", "agentLauncherSha256"),
        ("configure_overlay.py", None),
    ]:
        built_hash = digest(directory / "runtime-overlay" / filename)
        if built_hash != digest(ROOT / "tools/benchmark" / filename):
            raise ValueError(f"Runtime contains an outdated {filename}")
        if metadata_key and runtime.get(metadata_key) != built_hash:
            raise ValueError(f"Runtime provenance mismatch for {filename}")
    if runtime.get("dockerfileSha256") != digest(directory / "runtime-overlay/Dockerfile"):
        raise ValueError("Runtime Dockerfile changed since construction")


def agent_environment_file(lab_root, task, runtime):
    base = lab_root / "runs/calibration" / task["benchmark"] / task_id(task)
    reports = []
    for path in base.rglob("agent-environment.json"):
        report = read_json(path)
        if report.get("preparedImage", report.get("image_id")) == runtime["imageId"]:
            reports.append(path)
    return max(reports, key=lambda path: path.stat().st_mtime_ns) if reports else None


def validate_agent_environment(path, task, runtime):
    report = read_json(path) if path else {}
    if not report.get("passed") or report.get("taskId", report.get("task_id")) != task_id(task):
        raise ValueError("Current runtime agent environment verification must pass")
    if report.get("preparedImage", report.get("image_id")) != runtime["imageId"]:
        raise ValueError("Agent environment verification used a different image")
    if task["benchmark"] == "featurebench":
        if report.get("preparedSha256") != runtime["preparedSha256"]:
            raise ValueError("Agent environment verification used a different prepared task")
        if report.get("cleanup", {}).get("status") != "removed":
            raise ValueError("Agent verification container cleanup did not complete")
    elif report.get("cleanup_returncode") != 0:
        raise ValueError("Agent verification container cleanup did not complete")


def verify_agent_tasks(lab_root, selected):
    results = []
    for task in selected:
        base = lab_root / "runs/calibration" / task["benchmark"] / task_id(task)
        try:
            directory = lab_root / "task-workspaces" / task_id(task)
            runtime = read_json(directory / "runtime-overlay/runtime.json")
            validate_runtime_provenance(lab_root, directory, runtime)
            command = adapter_command(
                lab_root, task, "verify-agent", base / "overlays" / f"agent-{uuid.uuid4().hex}"
            )
            flag = "--prepared-image" if task["benchmark"] == "featurebench" else "--image-id"
            command.extend([flag, runtime["imageId"]])
            run_command(command, log=base / "agent-verification.log")
            validate_agent_environment(
                agent_environment_file(lab_root, task, runtime), task, runtime
            )
            results.append({"taskId": task_id(task), "status": "passed"})
        except Exception as error:
            results.append({"taskId": task_id(task), "status": "failed", "error": str(error)})
        atomic_json(lab_root / "runs/agent-verification-report.json", {"tasks": results})
        print(json.dumps(results[-1]), flush=True)
    return results


def suite_lock_path(config):
    return ROOT / "experiments" / f"{safe_id(config['suite'])}.lock.json"


def freeze_suite(lab_root, config, config_path):
    entries, missing = [], []
    selected = tasks(config)
    for task in selected:
        try:
            directory = lab_root / "task-workspaces" / task_id(task)
            prepared_path = directory / "prepared.json"
            runtime_path = directory / "runtime-overlay/runtime.json"
            runtime = read_json(runtime_path)
            if not read_json(prepared_path).get("ready") or not runtime.get("ready"):
                raise ValueError("Prepared task and runtime must both be ready")
            if runtime.get("preparedSha256") != digest(prepared_path):
                raise ValueError("Runtime was built from a different prepared task")
            validate_runtime_provenance(lab_root, directory, runtime)
            agent_environment = agent_environment_file(lab_root, task, runtime)
            validate_agent_environment(agent_environment, task, runtime)
            official, overlay = calibration_files(lab_root, task, runtime)
            if (
                not official
                or not overlay
                or not read_json(official).get("passed")
                or not read_json(overlay).get("passed")
            ):
                raise ValueError(
                    "Official and runtime-overlay baseline/reference calibrations must both pass"
                )
            overlay_report = read_json(overlay)
            actual_image = overlay_report.get(
                "grading_image_id", overlay_report.get("preparedImage")
            )
            if actual_image != runtime["imageId"]:
                raise ValueError("Overlay calibration must identify the exact runtime image")
            entries.append(
                {
                    "taskId": task_id(task),
                    "runtimeImageId": runtime["imageId"],
                    "preparedSha256": digest(prepared_path),
                    "runtimeSha256": digest(runtime_path),
                    "agentEnvironment": str(agent_environment.relative_to(lab_root)),
                    "agentEnvironmentSha256": digest(agent_environment),
                    "officialCalibration": str(official.relative_to(lab_root)),
                    "officialCalibrationSha256": digest(official),
                    "overlayCalibration": str(overlay.relative_to(lab_root)),
                    "overlayCalibrationSha256": digest(overlay),
                }
            )
        except Exception as error:
            missing.append({"taskId": task_id(task), "reason": str(error)})
    if missing:
        report = {"frozen": False, "missing": missing, "eligibleCount": len(entries)}
        atomic_json(lab_root / "runs/freeze-preflight.json", report)
        raise RuntimeError(
            f"Suite cannot freeze: {len(missing)} tasks pending; see runs/freeze-preflight.json"
        )
    value = {
        "schemaVersion": 1,
        "suite": config["suite"],
        "frozenAtMs": now_ms(),
        "configSha256": digest(config_path),
        "appendixSha256": digest(ROOT / config["appendix"]),
        "manifestHashes": {path: digest(ROOT / path) for path in config["manifests"]},
        "benchmarkLockHashes": {
            f"experiments/{benchmark}-lock.json": digest(
                ROOT / "experiments" / f"{benchmark}-lock.json"
            )
            for benchmark in sorted({task["benchmark"] for task in selected})
        },
        "tasks": entries,
    }
    target = suite_lock_path(config)
    if target.exists():
        raise ValueError(
            "Suite already frozen; preserve its lock and create a separate suite version"
        )
    atomic_json(target, value)
    return value


def require_freeze(lab_root, config, config_path):
    value = read_json(suite_lock_path(config))
    if value["configSha256"] != digest(config_path) or value["appendixSha256"] != digest(
        ROOT / config["appendix"]
    ):
        raise ValueError("Frozen configuration/appendix changed")
    for path, expected in value["manifestHashes"].items():
        if digest(ROOT / path) != expected:
            raise ValueError(f"Frozen task selection changed: {path}")
    if "benchmarkLockHashes" not in value:
        raise ValueError("Frozen suite must pin benchmark source/data/evaluator lock files")
    for path, expected in value["benchmarkLockHashes"].items():
        if digest(ROOT / path) != expected:
            raise ValueError(f"Frozen benchmark source/data/evaluator lock changed: {path}")
    for item in value["tasks"]:
        directory = lab_root / "task-workspaces" / item["taskId"]
        for path, expected in [
            (directory / "prepared.json", item["preparedSha256"]),
            (directory / "runtime-overlay/runtime.json", item["runtimeSha256"]),
            (lab_root / item["agentEnvironment"], item["agentEnvironmentSha256"]),
            (lab_root / item["officialCalibration"], item["officialCalibrationSha256"]),
            (lab_root / item["overlayCalibration"], item["overlayCalibrationSha256"]),
        ]:
            if digest(path) != expected:
                raise ValueError(f"Frozen evidence changed: {path}")
    return value


def supplement_plan(lab_root, source_run_id, selected, config):
    """Predeclare one new attempt per selected interrupted task; preserve the original cohort."""
    if config["attemptsPerTask"] != 1:
        raise ValueError("Supplement batches allow exactly one new attempt per selected task")
    source = lab_root / "runs" / safe_id(source_run_id)
    batch = read_json(source / "run.json")
    if batch["status"] != "complete":
        raise ValueError("Supplement requires a fully completed source batch")
    source_tasks = {task_id(t): t for t in read_json(source / "tasks.json")}
    plans = []
    for task in selected:
        identifier = task_id(task)
        if source_tasks.get(identifier) != task:
            raise ValueError("Supplement task must exactly match its original task")
        matches = [p for p in batch["attempts"] if p["taskId"] == identifier]
        if len(matches) != 1:
            raise ValueError("Supplement requires one unambiguous original attempt")
        original = matches[0]
        state = attempt_state(source, batch, original)
        if (
            state["phase"] != "done"
            or state.get("cleanup") != "complete"
            or state.get("trace", {}).get("status") != "complete"
        ):
            raise ValueError("Finish original evidence and cleanup before supplementing")
        if state.get("modelExecution") not in [
            "infrastructure_failure",
            "interrupted_sandbox_lost",
            "interrupted",
            "failed",
        ]:
            raise ValueError(
                "Do not select completed or normal-deadline tasks for fault supplements"
            )
        directory = Path(state.get("evidencePath", source / "attempts" / original["attemptId"]))
        repetition = original["repetition"] + 1
        prefix = original["attemptId"].rsplit("-", 1)[0]
        plans.append(
            {
                "taskId": identifier,
                "attemptId": f"{prefix}-{repetition:02d}",
                "repetition": repetition,
                "retryOf": {
                    "runId": state["runId"],
                    "attemptId": original["attemptId"],
                    "path": str(directory / "attempt.json"),
                    "sha256": digest(directory / "attempt.json"),
                    "modelExecution": state["modelExecution"],
                },
            }
        )
    return plans, {
        "sourceRunId": source_run_id,
        "sourceRunSha256": digest(source / "run.json"),
        "policy": "One predeclared supplementary attempt per selected task; original cohort and failures remain separate; no best-attempt replacement",
    }


def execute_batch(
    lab_root,
    config,
    config_path,
    selected,
    run_id=None,
    *,
    resume=False,
    allocate_only=False,
    source_run_id=None,
):
    if source_run_id and (resume or not allocate_only):
        raise ValueError("Supplement selection must be allocated and reviewed before execution")
    freeze = require_freeze(lab_root, config, config_path)
    if not allocate_only and not doctor(lab_root, config)["passed"]:
        raise RuntimeError("Preflight failed; see runs/doctor.json")
    run_id = safe_id(run_id or f"{config['suite']}-{now_ms()}-{uuid.uuid4().hex[:8]}")
    directory = lab_root / "runs" / run_id
    with lock(lab_root / "runs/coordinator.lock"):
        active_file = lab_root / "runs/active.json"
        if not resume and active_file.exists():
            active_id = safe_id(read_json(active_file)["runId"])
            active_batch = read_json(lab_root / "runs" / active_id / "run.json")
            if active_batch.get("status") != "complete":
                raise RuntimeError(
                    f"Unfinished batch {active_id}; use bench:resume before starting another batch"
                )
        if resume:
            batch = read_json(directory / "run.json")
            validate_implementation(directory, batch)
            if batch["configSha256"] != digest(config_path):
                raise ValueError("Batch config changed; resume with its original config")
            selected_by_id = {task_id(task): task for task in read_json(directory / "tasks.json")}
        else:
            selected_by_id = {task_id(task): task for task in selected}
            if not selected or len(selected_by_id) != len(selected):
                raise ValueError("Batch requires a nonempty, unique task selection")
            attempts = [
                {
                    "taskId": task_id(task),
                    "attemptId": f"{index + 1:03d}-{repetition + 1:02d}",
                    "repetition": repetition + 1,
                }
                for index, task in enumerate(selected)
                for repetition in range(config["attemptsPerTask"])
            ]
            supplement = None
            if source_run_id:
                attempts, supplement = supplement_plan(lab_root, source_run_id, selected, config)
            directory.mkdir(parents=True, exist_ok=False, mode=0o700)
            batch = {
                "schemaVersion": 1,
                "runId": run_id,
                "createdAtMs": now_ms(),
                "status": "allocated",
                "configSha256": digest(config_path),
                "attempts": attempts,
            }
            if supplement:
                batch["supplement"] = supplement
            atomic_json(directory / "run.json", batch)  # Written before any session creation.
            atomic_json(directory / "tasks.json", selected)
            shutil.copy2(config_path, directory / "config.json")
            atomic_json(directory / "suite-lock.json", freeze)
            record_implementation(directory, batch)
            benchmark_locks = directory / "benchmark-locks"
            benchmark_locks.mkdir()
            for path in freeze["benchmarkLockHashes"]:
                shutil.copy2(ROOT / path, benchmark_locks / Path(path).name)
            atomic_json(directory / "run.json", batch)
            atomic_json(lab_root / "runs/active.json", {"runId": run_id})
        if allocate_only:
            batch_report(directory)
            return batch
        print(f"runId={run_id}", flush=True)
        with lock(directory / "batch.lock"):
            request = directory / "stop-request.json"
            if request.exists() and read_json(request).get("requestId") == batch.get("stopAckId"):
                archived = directory / "stop-requests" / f"{batch['stopAckId']}.json"
                archived.parent.mkdir(exist_ok=True)
                request.rename(archived)
            batch["status"] = "running"
            batch.pop("blocked", None)
            atomic_json(directory / "run.json", batch)
            try:
                execute_attempts(lab_root, directory, batch, config, selected_by_id)
            except Exception as error:
                batch["status"] = "blocked"
                batch["blocked"] = {"atMs": now_ms(), "reason": str(error)}
                raise
            finally:
                if request.exists():
                    batch["stopAckId"] = read_json(request)["requestId"]
                atomic_json(directory / "run.json", batch)
                batch_report(directory)
                # Keep an unresolved session/control plane available for evidence recovery.
                live_states = [read_json(p) for p in directory.glob("attempts/*/attempt.json")]
                if all(s.get("cleanup") == "complete" for s in live_states):
                    process_file = directory / "control-plane/process.json"
                    if process_file.exists():
                        stop_owned_process(read_json(process_file))
    return batch


def execute_attempts(lab_root, directory, batch, config, selected_by_id):
    run_id = batch["runId"]
    for plan in batch["attempts"]:
        if (directory / "stop-request.json").exists():
            batch["status"] = "interrupted"
            return batch
        if plan["attemptId"] in batch.get("inheritedAttempts", {}):
            continue
        attempt_path = directory / "attempts" / plan["attemptId"] / "attempt.json"
        state = (
            read_json(attempt_path)
            if attempt_path.exists()
            else {
                **plan,
                "runId": run_id,
                "phase": "allocated",
                "allocatedAtMs": now_ms(),
                "title": f"OI benchmark {run_id} attempt {plan['attemptId']}",
            }
        )
        if state["phase"] == "done":
            continue
        task = selected_by_id[plan["taskId"]]
        effective_config = task_config(config, plan["taskId"])
        state["resourceProfile"] = {
            key: effective_config[key]
            for key in ["cpuCores", "memoryMib"]
            if key in effective_config
        }
        try:
            if state["phase"] != "collected":
                state = run_attempt(lab_root, directory, task, state, effective_config)
            if state["phase"] == "collected":
                if state.get("trace", {}).get("status") not in ["exported", "complete"]:
                    runtime = read_json(
                        lab_root
                        / "task-workspaces"
                        / task_id(task)
                        / "runtime-overlay/runtime.json"
                    )
                    _, cp_state = ensure_control_plane(directory, effective_config, runtime)
                    try:
                        export_trace(
                            attempt_path.parent,
                            state,
                            cp_state / "trace-connection.json",
                            profile=config["traceProfile"],
                        )
                    finally:
                        atomic_json(attempt_path, state)
                state = assess_attempt(
                    lab_root,
                    attempt_path.parent,
                    task,
                    state,
                    official_scoring=config.get("officialScoring", False),
                )
                if state.get("trace", {}).get("status") not in ["exported", "complete"]:
                    raise RuntimeError(
                        "Trace integrity failed; resume evidence export before advancing"
                    )
                state["phase"] = "done"
                atomic_json(attempt_path, state)
            else:
                raise RuntimeError("Cleanup is pending; resume this attempt before advancing")
        finally:
            batch_report(directory)
        print(
            json.dumps(
                {
                    "taskId": plan["taskId"],
                    "attemptId": plan["attemptId"],
                    "phase": state["phase"],
                    "modelExecution": state.get("modelExecution"),
                }
            ),
            flush=True,
        )
        if state.get("modelExecution") in ["infrastructure_failure", "interrupted_sandbox_lost"]:
            raise RuntimeError(
                f"Infrastructure failure in {plan['attemptId']}; inspect exceptions.json before resuming"
            )
        if state.get("modelExecution") == "interrupted":
            batch["status"] = "interrupted"
            atomic_json(directory / "run.json", batch)
            return batch
    batch["traceBatchAnalysis"] = analyze_batch(directory, config["traceProfile"])
    batch["status"] = "complete"
    return batch


def preparation_status(lab_root, config):
    entries = []
    for task in tasks(config):
        directory = lab_root / "task-workspaces" / task_id(task)
        runtime_path = directory / "runtime-overlay/runtime.json"
        runtime = read_json(runtime_path) if runtime_path.exists() else None
        prepared_path = directory / "prepared.json"
        prepared = read_json(prepared_path) if prepared_path.exists() else {}
        current_runtime = bool(
            runtime
            and runtime.get("ready")
            and prepared.get("ready")
            and runtime.get("preparedSha256") == digest(prepared_path)
        )
        runtime_issue = None
        if current_runtime:
            try:
                validate_runtime_provenance(lab_root, directory, runtime)
            except (OSError, ValueError) as error:
                current_runtime = False
                runtime_issue = str(error)
        official, overlay = calibration_files(lab_root, task, runtime)
        overlay_report = read_json(overlay) if overlay else {}
        agent_environment_passed = False
        if current_runtime:
            try:
                validate_agent_environment(
                    agent_environment_file(lab_root, task, runtime), task, runtime
                )
                agent_environment_passed = True
            except (OSError, ValueError):
                pass
        current_overlay = bool(
            current_runtime
            and overlay_report.get("passed")
            and overlay_report.get("preparedImage", overlay_report.get("grading_image_id"))
            == runtime["imageId"]
        )
        entries.append(
            {
                "taskId": task_id(task),
                "benchmark": task["benchmark"],
                "prepared": prepared.get("ready", False),
                "runtimeBuilt": current_runtime,
                "runtimeIssue": runtime_issue,
                "agentEnvironment": agent_environment_passed,
                "officialCalibration": read_json(official).get("passed", False)
                if official
                else None,
                "overlayCalibration": current_overlay if overlay else None,
            }
        )
    active = lab_root / "runs/active.json"
    result = {
        "suite": config["suite"],
        "labRoot": str(lab_root),
        "frozen": suite_lock_path(config).exists(),
        "activeBatch": read_json(active) if active.exists() else None,
        "tasks": entries,
        "counts": {
            "selected": len(entries),
            "officialPassed": sum(item["officialCalibration"] is True for item in entries),
            "overlayPassed": sum(item["overlayCalibration"] is True for item in entries),
            "prepared": sum(item["prepared"] for item in entries),
            "runtimeBuilt": sum(item["runtimeBuilt"] for item in entries),
            "agentEnvironmentPassed": sum(item["agentEnvironment"] for item in entries),
        },
    }
    atomic_json(lab_root / "runs/preparation-status.json", result)
    return result


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=[
            "status",
            "doctor",
            "prepare",
            "calibrate",
            "verify-agent",
            "build-runtime",
            "freeze",
            "run",
            "resume",
            "report",
            "prepare-continuation",
            "prepare-supplement",
        ],
    )
    parser.add_argument("--lab-root", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--suite")
    parser.add_argument("--task-id", action="append")
    parser.add_argument("--run-id")
    parser.add_argument("--from-run-id")
    parser.add_argument("--overlay", action="store_true")
    args = parser.parse_args()
    lab_root = external_root(args.lab_root)
    if args.command in ["resume", "report"]:
        args.run_id = args.run_id or read_json(lab_root / "runs/active.json")["runId"]
        args.config = args.config or lab_root / "runs" / safe_id(args.run_id) / "config.json"
    args.config = args.config or DEFAULT_CONFIG
    config = validate_config(read_json(args.config))
    if args.suite is not None and args.suite != config["suite"]:
        parser.error("Suite must match configuration")
    selected = tasks(config)
    if set(config.get("taskResourceOverrides", {})) - {task_id(t) for t in selected}:
        parser.error("Resource override names an unknown task")
    if args.task_id:
        selected = [task for task in selected if task_id(task) in args.task_id]
        if len(selected) != len(set(args.task_id)):
            parser.error("Unknown task ID")
    if args.command == "status":
        result = preparation_status(lab_root, config)
    elif args.command == "doctor":
        result = doctor(lab_root, config)
    elif args.command == "build-runtime":
        result = build_core(lab_root, config["runtimeImage"])
    elif args.command == "prepare":
        result = prepare_tasks(lab_root, selected, config)
    elif args.command == "calibrate":
        result = calibrate_tasks(lab_root, selected, config, overlay=args.overlay)
    elif args.command == "verify-agent":
        result = verify_agent_tasks(lab_root, selected)
    elif args.command == "freeze":
        result = freeze_suite(lab_root, config, args.config)
    elif args.command == "prepare-continuation":
        if not args.from_run_id or not args.run_id:
            parser.error("prepare-continuation requires --from-run-id and --run-id")
        result = prepare_continuation(lab_root, config, args.config, args.from_run_id, args.run_id)
    elif args.command == "prepare-supplement":
        if not args.from_run_id or not args.run_id or not args.task_id:
            parser.error(
                "prepare-supplement requires --from-run-id, --run-id and explicit --task-id selection"
            )
        result = execute_batch(
            lab_root,
            config,
            args.config,
            selected,
            args.run_id,
            allocate_only=True,
            source_run_id=args.from_run_id,
        )
    elif args.command in ["run", "resume"]:
        run_id = args.run_id
        if args.command == "resume" and run_id is None:
            run_id = read_json(lab_root / "runs/active.json")["runId"]
        result = execute_batch(
            lab_root, config, args.config, selected, run_id, resume=args.command == "resume"
        )
    else:
        run_id = args.run_id or read_json(lab_root / "runs/active.json")["runId"]
        result = batch_report(lab_root / "runs" / safe_id(run_id))
    display = result
    if isinstance(result, dict) and args.command in ["run", "resume", "report"]:
        display = {
            key: value
            for key, value in result.items()
            if key not in ["attempts", "adapterHashes", "workingTreeStatus"]
        }
    if args.command == "build-runtime":
        display = {key: value for key, value in result.items() if key != "runtimeSourceHashes"}
    if args.command == "status":
        display = {key: value for key, value in result.items() if key != "tasks"}
    print(json.dumps(display, indent=2))
    failed = isinstance(result, dict) and result.get("passed") is False
    failed |= isinstance(result, list) and any(item.get("status") == "failed" for item in result)
    return int(failed)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
