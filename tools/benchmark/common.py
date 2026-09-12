"""Durable local experiment primitives; all downloads/results live outside the checkout."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LAB_ROOT = ROOT.parent / "benchmark-lab"
DEFAULT_CONFIG = ROOT / "experiments/pilot-30.json"
REQUEST_TIMEOUT_SECONDS = 30
READ_REQUEST_MAX_ATTEMPTS = 3
READ_RETRY_DELAY_SECONDS = 1
POLL_INTERVAL_SECONDS = 2
CLEANUP_SETTLE_SECONDS = 125  # Covers the provider's bounded create request and observation lag.
CAPTURE_INTERVAL_SECONDS = 30
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$")


def now_ms():
    return time.time_ns() // 1_000_000


def read_json(path):
    return json.loads(Path(path).read_text())


def digest(path):
    hasher = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def external_root(path=None):
    result = Path(path or os.environ.get("BENCHMARK_LAB_ROOT", DEFAULT_LAB_ROOT)).resolve()
    if result == ROOT or ROOT in result.parents:
        raise ValueError("Benchmark materials/results must be outside the repository")
    return result


def safe_id(value):
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise ValueError("Invalid task/run identifier")
    return value


def task_id(task):
    return safe_id(task.get("taskId", task.get("id")))


def tasks(config):
    result = []
    for filename in config["manifests"]:
        result.extend(read_json(ROOT / filename)["tasks"])
    identifiers = [task_id(task) for task in result]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("Duplicate task IDs")
    return result


def run_command(
    command, *, log=None, error_log=None, cwd=ROOT, env=None, timeout_seconds=None, input_data=None
):
    kwargs = {"cwd": cwd, "env": env, "timeout": timeout_seconds, "input": input_data}
    if log is None:
        result = subprocess.run(command, capture_output=True, **kwargs)
        if result.returncode:
            # Private subprocess stderr may include credentials. Persist it only to a private log.
            if error_log:
                Path(error_log).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                Path(error_log).write_bytes(result.stderr)
                Path(error_log).chmod(0o600)
            raise RuntimeError(f"{Path(str(command[0])).name} exited {result.returncode}")
        return result.stdout
    Path(log).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with Path(log).open("ab") as stream:
        result = subprocess.run(command, stdout=stream, stderr=stream, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{Path(str(command[0])).name} exited {result.returncode}; see {log}")
    return b""


def node_environment():
    environment = dict(os.environ)
    local_node = ROOT / ".cache/opensandbox/node/bin"
    if local_node.exists():
        environment["PATH"] = f"{local_node}:{environment.get('PATH', '')}"
    return environment


@contextmanager
def lock(path):
    """Kernel releases flock after SIGKILL; stale PID files are never treated as locks."""
    Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with Path(path).open("a+") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError(f"An experiment already holds {path}") from error
        stream.seek(0)
        stream.truncate()
        stream.write(json.dumps({"pid": os.getpid(), "acquiredAtMs": now_ms()}))
        stream.flush()
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def validate_config(config):
    if not isinstance(config.get("officialScoring", False), bool):
        raise ValueError("officialScoring must be a boolean; defaults to false")
    if config["taskConcurrency"] != 1 or config["maxSandboxes"] != 3:
        raise ValueError("This deployment-image adapter supports one task / three sandboxes")
    if config["children"] != 2 or config["maxSpawnDepth"] != 1:
        raise ValueError("Protocol v1 requires two direct children and no grandchildren")
    if config["runtimeMaxRestarts"] != 0:
        raise ValueError("Benchmark attempts require runtime restart limit zero")
    for key in [
        "attemptsPerTask",
        "deadlineSeconds",
        "sandboxLifetimeSeconds",
        "setupTimeoutSeconds",
        "cpuCores",
        "memoryMib",
        "graderMemoryMib",
        "controlPlanePort",
        "artifactPort",
    ]:
        if isinstance(config[key], bool) or not isinstance(config[key], int) or config[key] <= 0:
            raise ValueError(f"Invalid {key}")
    if config["sandboxLifetimeSeconds"] <= config["deadlineSeconds"] + CLEANUP_SETTLE_SECONDS:
        raise ValueError("Sandbox TTL must exceed run deadline plus evidence/cleanup window")
    if config["reasoningEffort"] is not None:
        raise ValueError(
            "The initial DeepSeek Flash protocol uses the configured provider default reasoning"
        )
    if config["model"] != "deepseek/deepseek-v4-flash":
        raise ValueError(
            "Validate a new model/credential/reasoning profile before changing this protocol"
        )
    overrides = config.get("taskResourceOverrides", {})
    if not isinstance(overrides, dict):
        raise ValueError("taskResourceOverrides must map task IDs to memoryMib overrides")
    for identifier, override in overrides.items():
        safe_id(identifier)
        if not isinstance(override, dict) or set(override) != {"memoryMib"}:
            raise ValueError("Task resource overrides may only set memoryMib")
        memory_mib = override["memoryMib"]
        if isinstance(memory_mib, bool) or not isinstance(memory_mib, int) or memory_mib <= 0:
            raise ValueError("Invalid task memoryMib override")
    return config


def task_config(config, identifier):
    """Memory adjustments are explicit per task and cannot silently alter model or time budgets."""
    return {**config, **config.get("taskResourceOverrides", {}).get(identifier, {})}


def max_task_memory_mib(config):
    return max(
        [
            config["memoryMib"],
            *(v["memoryMib"] for v in config.get("taskResourceOverrides", {}).values()),
        ]
    )
