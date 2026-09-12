#!/usr/bin/env python3
"""Pinned FeatureBench Level 1 preparation and official offline scoring.

Use the external cache/featurebench-venv interpreter for Docker/harness actions.
The adapter does not call a model. Agent assets and scorer files stay separate.
"""

from __future__ import annotations

import argparse
import fcntl
import functools
import hashlib
import importlib.metadata
import inspect
import json
import logging
import os
import platform
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

if __package__:
    from .pull_image import ensure_image, external_root, sha256_file, write_json
else:
    from pull_image import ensure_image, external_root, sha256_file, write_json

REPOSITORY = Path(__file__).resolve().parents[2]
ADAPTER_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
DEFAULT_SETUP_TIMEOUT_SECONDS = 600
DEFAULT_TEST_TIMEOUT_SECONDS = 600
DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 120
DEFAULT_PREPARATION_MEMORY_GIB = 2
DEFAULT_AGENT_CHECK_MEMORY_GIB = DEFAULT_PREPARATION_MEMORY_GIB
DEFAULT_FLATTEN_DISK_RESERVE_BYTES = 20 * 1024**3
BASELINE_SENTINEL_PATCH = """diff --git a/.openinspect-calibration-sentinel b/.openinspect-calibration-sentinel
new file mode 100644
--- /dev/null
+++ b/.openinspect-calibration-sentinel
@@ -0,0 +1 @@
+FeatureBench initial-state calibration; no implementation changes.
"""
MODULE_NAMES = {
    "mesonbuild/meson": "mesonbuild",
    "pytest-dev/pytest": "_pytest",
    "scikit-learn/scikit-learn": "sklearn",
}


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def bootstrap(lab_root: Path) -> dict:
    """Recreate pinned scorer sources, data and dependencies on a new machine."""
    root = external_root(lab_root)
    lock = json.loads((REPOSITORY / "experiments/featurebench-lock.json").read_text())
    if platform.python_version() != lock["dependencies"]["python"]:
        raise ValueError("Run bootstrap with Python " + lock["dependencies"]["python"])
    source = root / lock["source"]["path"]
    if not source.exists():
        source.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", str(source)], check=True)
        subprocess.run(
            ["git", "-C", str(source), "remote", "add", "origin", lock["source"]["url"]],
            check=True,
        )
    head = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "--verify", "HEAD"],
        capture_output=True,
        text=True,
    )
    if head.returncode:
        origin = subprocess.run(
            ["git", "-C", str(source), "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        # A failed initial network fetch leaves an empty repository. Resume
        # only that state; preserve arbitrary existing working files/history.
        if origin != lock["source"]["url"] or any(p.name != ".git" for p in source.iterdir()):
            raise ValueError("Incomplete source checkout is not an empty pinned clone")
        subprocess.run(
            [
                "git",
                "-C",
                str(source),
                "fetch",
                "--depth",
                "1",
                "origin",
                lock["source"]["gitCommit"],
            ],
            check=True,
        )
        subprocess.run(["git", "-C", str(source), "checkout", "--detach", "FETCH_HEAD"], check=True)
    actual = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if actual != lock["source"]["gitCommit"]:
        raise ValueError("Existing source checkout differs from the lock; refusing to reset it")
    dirty = subprocess.run(
        ["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"],
        capture_output=True,
        check=True,
        text=True,
    ).stdout
    if dirty:
        raise ValueError("Existing scorer checkout has tracked modifications")
    requirements = root / lock["dependencies"]["freezePath"]
    requirements.parent.mkdir(parents=True, exist_ok=True)
    raw_requirements = ("\n".join(lock["dependencies"]["packages"]) + "\n").encode()
    if digest_bytes(raw_requirements) != lock["dependencies"]["sha256"]:
        raise ValueError("Dependency list does not match its lock hash")
    requirements.write_bytes(raw_requirements)
    environment = root / lock["dependencies"]["environmentPath"]
    python = environment / "bin/python"
    if not python.exists():
        subprocess.run([sys.executable, "-m", "venv", str(environment)], check=True)
    environment_version = subprocess.run(
        [str(python), "-c", "import platform; print(platform.python_version())"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if environment_version != lock["dependencies"]["python"]:
        raise ValueError("Existing scorer environment Python differs from the lock")
    verification = (
        "import importlib.metadata as m,json; q=json.loads("
        + repr(json.dumps(lock["dependencies"]["packages"]))
        + "); assert all(m.version(x.split('==')[0]) == x.split('==')[1] for x in q)"
    )
    checked = subprocess.run([str(python), "-c", verification], capture_output=True)
    if checked.returncode:
        subprocess.run([str(python), "-m", "pip", "install", "-r", str(requirements)], check=True)
        subprocess.run([str(python), "-c", verification], check=True)
    data = root / lock["dataset"]["path"]
    for name, description in lock["dataset"]["files"].items():
        if name.endswith(".json"):
            continue
        destination = data / name
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            url = lock["dataset"]["url"] + "/resolve/" + lock["dataset"]["revision"] + "/" + name
            temporary = destination.with_suffix(destination.suffix + ".partial")
            with (
                urllib.request.urlopen(url, timeout=DEFAULT_DOWNLOAD_TIMEOUT_SECONDS) as response,
                temporary.open("wb") as output,
            ):
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if sha256_file(temporary) != "sha256:" + description["sha256"]:
                raise ValueError("Downloaded dataset hash differs from lock: " + name)
            temporary.replace(destination)
        if (
            sha256_file(destination) != "sha256:" + description["sha256"]
            or destination.stat().st_size != description["bytes"]
        ):
            raise ValueError("Cached dataset differs from lock: " + name)
    convert = """import json,pathlib,sys,pyarrow.parquet
directory=pathlib.Path(sys.argv[1])
for split in ['fast','full','lite']:
    destination=directory/(split+'.json')
    if not destination.exists():
        rows=pyarrow.parquet.read_table(directory/'data'/(split+'-00000-of-00001.parquet')).to_pylist()
        destination.write_text(json.dumps(rows,indent=2,ensure_ascii=False)+'\\n',encoding='utf-8')
"""
    subprocess.run([str(python), "-c", convert, str(data)], check=True)
    for name, description in lock["dataset"]["files"].items():
        if sha256_file(data / name) != "sha256:" + description["sha256"]:
            raise ValueError("Converted dataset differs from lock: " + name)
    result = {
        "ready": True,
        "sourceCommit": actual,
        "datasetRevision": lock["dataset"]["revision"],
        "dependencyPython": str(python),
        "dependencyLockSha256": lock["dependencies"]["sha256"],
        "datasetHashesVerified": len(lock["dataset"]["files"]),
        "adapterSha256": ADAPTER_SHA256,
    }
    write_json(root / "cache/featurebench-bootstrap.json", result)
    return result


def pull_images(lab_root: Path, task_id: str | None = None) -> dict:
    root = external_root(lab_root)
    lock = json.loads((REPOSITORY / "experiments/featurebench-lock.json").read_text())
    tasks = json.loads((REPOSITORY / "experiments/featurebench-tasks.json").read_text())["tasks"]
    selected = [task for task in tasks if task_id is None or task["taskId"] == task_id]
    if not selected:
        raise ValueError("Task is not in the selected FeatureBench suite")
    result = {"status": "running", "images": {}}
    for task in selected:
        name = task["environment"]["image"]
        try:
            result["images"][name] = image_for_task(root, task, lock)
        except Exception as error:
            result["images"][name] = {"status": "failed", "error": str(error)}
        write_json(root / "cache/featurebench-pull-images.json", result)
    result["ready"] = all(item.get("imageId") for item in result["images"].values())
    result["status"] = "completed" if result["ready"] else "completed_with_failures"
    write_json(root / "cache/featurebench-pull-images.json", result)
    return result


def load_task(lab_root: Path, task_id: str) -> tuple[dict, dict, dict]:
    root = external_root(lab_root)
    lock = json.loads((REPOSITORY / "experiments/featurebench-lock.json").read_text())
    manifest_path = REPOSITORY / "experiments/featurebench-tasks.json"
    if digest_bytes(manifest_path.read_bytes()) != lock["selectionSha256"]:
        raise ValueError("FeatureBench task selection differs from its lock")
    tasks = json.loads(manifest_path.read_text())["tasks"]
    task = next((item for item in tasks if item["taskId"] == task_id), None)
    if not task:
        raise ValueError(f"Task is not in the selected FeatureBench suite: {task_id}")
    source = root / lock["source"]["path"]
    actual_sha = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()
    if actual_sha != lock["source"]["gitCommit"]:
        raise ValueError("FeatureBench source checkout differs from its pinned commit")
    dirty = subprocess.run(
        ["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    if dirty:
        raise ValueError("FeatureBench scorer checkout has tracked modifications")
    data_path = root / lock["dataset"]["path"] / "fast.json"
    raw_data = data_path.read_bytes()
    if digest_bytes(raw_data) != lock["dataset"]["files"]["fast.json"]["sha256"]:
        raise ValueError("FeatureBench JSON does not match the dataset lock")
    row = next(item for item in json.loads(raw_data) if item["instance_id"] == task_id)
    if (
        digest_bytes(row["problem_statement"].encode("utf-8")) != task["promptSha256"]
        or row["base_commit"] != task["baseCommit"]
    ):
        raise ValueError("FeatureBench prompt/base revision differs from the selected task")
    sys.path.insert(0, str(source))
    return task, lock, row


def output_directory(root: Path, output: Path) -> Path:
    output = output.expanduser().resolve()
    if output == root or root not in output.parents:
        raise ValueError("Output must be a task-specific directory beneath the external lab root")
    output.mkdir(parents=True, exist_ok=True)
    return output


def serial_containers(function):
    """Keep official scoring and runtime parity within the original scorer slot."""

    @functools.wraps(function)
    def run(lab_root: Path, *args, **kwargs):
        root = external_root(lab_root)
        lock_path = root / "cache" / "featurebench-container.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return function(root, *args, **kwargs)

    return run


def serial_preparation(function):
    """One small preparation/probe slot alongside the original scorer slot."""

    @functools.wraps(function)
    def run(lab_root: Path, *args, **kwargs):
        root = external_root(lab_root)
        lock_path = root / "cache/featurebench-preparation.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return function(root, *args, **kwargs)

    return run


def image_for_task(root: Path, task: dict, lock: dict) -> dict:
    image = task["environment"]["image"]
    pinned = lock["images"][image].get("digest")
    if not pinned:
        raise ValueError(f"Official image digest is not locked: {image}")
    return ensure_image(image, root, expected_digest=pinned)


def verify_dependencies(lock: dict) -> None:
    for requirement in lock["dependencies"]["packages"]:
        name, expected = requirement.split("==", 1)
        actual = importlib.metadata.version(name)
        if actual != expected:
            raise ValueError(
                f"Scorer dependency differs from lock: {name} {actual}, expected {expected}"
            )


def logger_for(output: Path) -> logging.Logger:
    logger = logging.getLogger("featurebench-adapter-" + uuid.uuid4().hex)
    logger.setLevel(logging.INFO)
    handler = logging.FileHandler(output / "run_instance.log", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.propagate = False
    return logger


def close_logger(logger: logging.Logger) -> None:
    for handler in logger.handlers[:]:
        handler.close()
        logger.removeHandler(handler)


def new_container(image_id: str, task: dict, purpose: str, *, memory_gib: int | None = None):
    import docker

    client = docker.from_env()
    container = client.containers.run(
        image_id,
        ["bash", "-lc", "sleep infinity"],
        entrypoint=[],
        detach=True,
        working_dir="/testbed",
        user="root",
        mem_limit=f"{memory_gib if memory_gib is not None else task['environment']['memoryGiB']}g",
        nano_cpus=int(task["environment"]["cpus"] * 1_000_000_000),
        labels={
            "openinspect.benchmark": "featurebench",
            "openinspect.task": task["taskId"],
            "openinspect.purpose": purpose,
        },
    )
    return client, container


def checked_exec(
    container, command: str, timeout_seconds: int = DEFAULT_SETUP_TIMEOUT_SECONDS
) -> str:
    from featurebench.harness.container import exec_run_with_timeout

    code, output = exec_run_with_timeout(container, command, timeout=timeout_seconds)
    text = output.decode("utf-8", errors="replace")
    if code:
        raise RuntimeError(f"Container setup failed ({code}): {text[-4000:]}")
    return text


def verify_upstream_commit(container, task: dict) -> None:
    commit = checked_exec(container, "git -C /root/my_repo rev-parse HEAD").strip()
    if commit != task["baseCommit"]:
        raise ValueError(f"Official image repository HEAD {commit} differs from locked base commit")


def cleanup_container(container, result: dict) -> None:
    if container is None:
        result["cleanup"] = {"status": "not_created"}
        return
    try:
        container.remove(force=True, v=True)
        result["cleanup"] = {"status": "removed", "containerId": container.id}
    except Exception as error:
        result["cleanup"] = {"status": "failed", "containerId": container.id, "error": str(error)}


def isolate_target_package(
    workspace: str,
    module: str,
    mask_files: list[str],
    hidden_files: list[str],
    scan_roots: list[str],
    original_generic_hashes: dict[str, str] | None = None,
) -> dict:
    """Redirect true source copies while retaining integrations and compiled extensions."""
    import hashlib
    import os
    import pathlib
    import shutil

    root = pathlib.Path(workspace)
    candidates = [root / module, root / "src" / module, root / "lib" / module]
    target = next((p for p in candidates if p.is_dir()), None)
    if target is None:
        raise RuntimeError("Cannot identify canonical task package: " + module)
    changes = []
    compiled_packages = []
    skipped = []
    matched_generic_copies = []
    original_generic_hashes = original_generic_hashes or {}
    canonical_files = {str(p.relative_to(target)) for p in target.rglob("*.py") if p.is_file()}
    generic_files = {"__init__.py", "__main__.py", "version.py", "_version.py", "_version_meson.py"}

    def package_relative(path):
        parts = pathlib.PurePosixPath(path).parts
        if module not in parts:
            return None
        return str(pathlib.PurePosixPath(*parts[parts.index(module) + 1 :]))

    private_files = {
        p for name in mask_files + hidden_files if (p := package_relative(name)) is not None
    }
    for scan_root in scan_roots:
        for directory, dirs, _files in os.walk(scan_root, followlinks=False):
            for name in dirs[:]:
                if name != module:
                    continue
                duplicate = pathlib.Path(directory) / name
                if duplicate.resolve() == target.resolve():
                    dirs.remove(name)
                    continue
                # Ignore documentation/license directories with the same name.
                if not any(duplicate.glob("*.py")):
                    continue
                files = [p for p in duplicate.rglob("*") if p.is_file()]
                python_files = {str(p.relative_to(duplicate)) for p in files if p.suffix == ".py"}
                generic_matches = [
                    relative
                    for relative in sorted(python_files & private_files & generic_files)
                    if hashlib.sha256((duplicate / relative).read_bytes()).hexdigest()
                    == original_generic_hashes.get(relative)
                ]
                if not (
                    (python_files & (canonical_files | private_files)) - generic_files
                    or generic_matches
                ):
                    skipped.append(str(duplicate))
                    dirs.remove(name)
                    continue
                if generic_matches:
                    matched_generic_copies.append(
                        {"path": str(duplicate), "matchingOriginalFiles": generic_matches}
                    )
                binaries = [
                    p
                    for p in files
                    if p.suffix in {".so", ".pyd", ".dll", ".dylib"} or ".so." in p.name
                ]
                if binaries:
                    # Editable builds may load extensions from this exact path.
                    # Preserve binary placement/RPATH while redirecting Python
                    # implementations and removing every hidden/masked-only file.
                    linked = []
                    removed = []
                    for relative in sorted(python_files):
                        path = duplicate / relative
                        canonical = target / relative
                        if canonical.is_file():
                            if path.resolve() != canonical.resolve():
                                path.unlink()
                                path.symlink_to(canonical)
                                linked.append(relative)
                        elif relative in private_files:
                            path.unlink()
                            removed.append(relative)
                    for path in list(duplicate.rglob("__pycache__")):
                        if path.is_dir() and not path.is_symlink():
                            shutil.rmtree(path)
                    for pattern in ["*.pyc", "*.pyo"]:
                        for path in duplicate.rglob(pattern):
                            path.unlink()
                    compiled_packages.append(
                        {
                            "path": str(duplicate),
                            "compiledFileCount": len(binaries),
                            "linkedPythonFileCount": len(linked),
                            "removedPrivateFiles": removed,
                        }
                    )
                    dirs.remove(name)
                    continue
                if duplicate.is_symlink():
                    duplicate.unlink()
                else:
                    shutil.rmtree(duplicate)
                duplicate.symlink_to(target, target_is_directory=True)
                changes.append(str(duplicate))
                dirs.remove(name)
    return {
        "auditVersion": 4,
        "module": module,
        "canonical": str(target),
        "scanRoots": scan_roots,
        "replacedPackageCopies": changes,
        "preservedCompiledPackages": compiled_packages,
        "skippedSameNameDirectories": skipped,
        "originalMaskedGenericFileHashes": original_generic_hashes,
        "matchedMaskedGenericCopies": matched_generic_copies,
    }


PACKAGE_ISOLATION_SOURCE = inspect.getsource(isolate_target_package)


def sanitize_missing_test_build_entries(workspace: str, hidden_files: list[str]) -> dict:
    """Remove absent hidden tests from local Meson installation lists."""
    import hashlib
    import re
    from pathlib import Path

    root = Path(workspace).resolve()
    changes = []
    for name in hidden_files:
        missing = Path(name)
        if not missing.is_absolute():
            missing = root / missing
        if root not in missing.resolve().parents:
            raise ValueError("Hidden test path leaves the workspace")
        if missing.exists():
            raise ValueError("Hidden test must already be removed before build cleanup")
        manifest = missing.parent / "meson.build"
        if not manifest.is_file():
            continue
        before = manifest.read_bytes()
        pattern = re.compile(
            rb"^[ \t]*(['\"])"
            + re.escape(missing.name.encode())
            + rb"\1[ \t]*,[ \t]*(?:#[^\r\n]*)?\r?\n",
            re.MULTILINE,
        )
        after, count = pattern.subn(b"", before)
        if count:
            manifest.write_bytes(after)
            changes.append(
                {
                    "manifest": str(manifest.relative_to(root)),
                    "missingTest": str(missing.relative_to(root)),
                    "removedEntries": count,
                    "beforeSha256": hashlib.sha256(before).hexdigest(),
                    "afterSha256": hashlib.sha256(after).hexdigest(),
                }
            )
    return {"auditVersion": 1, "removedMissingTestEntries": changes}


BUILD_MANIFEST_SANITIZATION_SOURCE = inspect.getsource(sanitize_missing_test_build_entries)


def materialize_meson_copy_outputs(workspace: str, canonical_package: str) -> dict:
    """Keep masked build copies writable by their existing Meson copy rules."""
    import hashlib
    import re
    import shutil
    from pathlib import Path

    root = Path(workspace).resolve()
    canonical = Path(canonical_package).resolve()
    build_root = root / "build"
    changes = []
    pattern = re.compile(r"^ COMMAND = \S*/meson --internal copy (\S+) (\S+)$")
    for manifest in sorted(build_root.rglob("build.ninja")):
        for line in manifest.read_text().splitlines():
            match = pattern.fullmatch(line)
            if not match or "$" in line:
                continue
            source = (manifest.parent / match[1]).resolve()
            destination = manifest.parent / match[2]
            destination = destination.parent.resolve() / destination.name
            if (
                source.suffix != ".py"
                or canonical not in source.parents
                or build_root not in destination.parents
                or not destination.is_symlink()
                or destination.resolve() != source
            ):
                continue
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            destination.unlink()
            shutil.copy2(source, destination)
            assert hashlib.sha256(destination.read_bytes()).hexdigest() == digest
            changes.append(
                {
                    "manifest": str(manifest.relative_to(root)),
                    "source": str(source.relative_to(root)),
                    "destination": str(destination.relative_to(root)),
                    "maskedContentSha256": digest,
                }
            )
    return {"auditVersion": 1, "materializedMaskedPythonCopies": changes}


MESON_COPY_MATERIALIZATION_SOURCE = inspect.getsource(materialize_meson_copy_outputs)


def verify_target_module_location(
    module_file: str, canonical_package: str, mappings: list[dict], workspace: str
) -> dict:
    """Accept canonical imports or exact audited, byte-identical Meson copies."""
    import hashlib
    from pathlib import Path

    root = Path(workspace).resolve()
    canonical = Path(canonical_package).resolve()
    location = Path(module_file).resolve()
    destinations = []
    for mapping in mappings:
        source = (root / mapping["source"]).resolve()
        destination = root / mapping["destination"]
        assert canonical in source.parents, source
        assert root / "build" in destination.parent.resolve().parents, destination
        content = source.read_bytes()
        assert hashlib.sha256(content).hexdigest() == mapping["maskedContentSha256"], source
        assert destination.read_bytes() == content, destination
        destinations.append(destination.resolve())
    direct = canonical in location.parents
    assert direct or location in destinations, (location, canonical)
    return {
        "modulePath": str(location),
        "canonicalPackage": str(canonical),
        "locationPolicy": "canonical"
        if direct
        else "audited_meson_copy_with_identical_masked_bytes",
        "verifiedMaterializedCopyCount": len(destinations),
    }


TARGET_MODULE_LOCATION_SOURCE = inspect.getsource(verify_target_module_location)


def active_legacy_preparation(root: Path, task_id: str) -> int | None:
    """Identify an exact old preparation process before orphan recovery."""
    plan_path = root / "cache/featurebench-resource-plan.json"
    if not plan_path.exists():
        return None
    plan = json.loads(plan_path.read_text())
    for process in plan.get("legacyPreparationProcesses", []):
        expected = process["arguments"]
        if "--task-id" not in expected or "--lab-root" not in expected:
            continue
        if expected[expected.index("--task-id") + 1] != task_id:
            continue
        if Path(expected[expected.index("--lab-root") + 1]).resolve() != root.resolve():
            continue
        try:
            raw = (Path("/proc") / str(process["pid"]) / "cmdline").read_bytes()
        except FileNotFoundError:
            continue
        actual = [argument.decode() for argument in raw.split(b"\0") if argument]
        if actual == expected:
            return process["pid"]
    return None


def archive_preparation(root: Path, task_id: str, output: Path) -> dict:
    """Recover only adapter-owned artifacts and orphaned preparation containers.

    The caller's preparation lock excludes current adapters. Legacy adapters
    used the scorer lock; explicitly refuse recovery while the same task's
    recorded legacy process is alive, without serializing unrelated tasks.
    """
    if legacy_pid := active_legacy_preparation(root, task_id):
        raise RuntimeError(
            f"Task {task_id} still has active legacy preparation PID {legacy_pid}; "
            "refusing to archive artifacts or remove its container"
        )
    import docker

    client = docker.from_env()
    removed = []
    try:
        containers = client.containers.list(
            all=True,
            filters={
                "label": [
                    "openinspect.benchmark=featurebench",
                    "openinspect.task=" + task_id,
                    "openinspect.purpose=prepare",
                ]
            },
        )
        for container in containers:
            container.remove(force=True, v=True)
            removed.append(container.id)
    finally:
        client.close()
    generation = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:12]
    history = root / "runs/preparation-history" / task_id / generation
    history.mkdir(parents=True, exist_ok=False)
    moved = []
    # Other files in a caller-provided output directory are not adapter-owned.
    for name in [
        "prepared.json",
        "prepared.json.tmp",
        "initialize.log",
        "run_instance.log",
        "workspace.tar",
        "prompt.original.txt",
    ]:
        path = output / name
        if path.exists():
            path.rename(history / name)
            moved.append(name)
    recovery = {
        "archivedDirectory": str(history),
        "originalDirectory": str(output),
        "archivedArtifacts": moved,
        "orphanPreparationContainersRemoved": removed,
    }
    write_json(history / "recovery.json", recovery)
    return recovery


@serial_preparation
def prepare(lab_root: Path, task_id: str, output: Path, *, new_generation: bool = False) -> dict:
    root = external_root(lab_root)
    output = output_directory(root, output)
    task, lock, row = load_task(root, task_id)
    recovery = None
    if (output / "prepared.json").exists():
        previous = json.loads((output / "prepared.json").read_text())
        if previous.get("taskId") != task_id:
            raise ValueError("Existing preparation belongs to a different task")
        if previous.get("ready") and not new_generation:
            return previous
        recovery = archive_preparation(root, task_id, output)
    result = {
        "taskId": task_id,
        "benchmark": "featurebench",
        "ready": False,
        "upstreamBaseCommit": task["baseCommit"],
        "sourceRevision": lock["source"]["gitCommit"],
        "datasetRevision": lock["dataset"]["revision"],
        "adapterSha256": ADAPTER_SHA256,
        "preparationGeneration": uuid.uuid4().hex,
        "recovery": recovery,
        "resourceLimits": {
            "memoryGiB": DEFAULT_PREPARATION_MEMORY_GIB,
            "cpus": task["environment"]["cpus"],
            "slot": "preparation",
            "sharesSlotWithAgentProbes": True,
        },
    }
    write_json(output / "prepared.json", result)
    logger = logger_for(output)
    client = container = None
    started = time.monotonic()
    try:
        verify_dependencies(lock)
        image = image_for_task(root, task, lock)
        result["officialImage"] = image
        client, container = new_container(
            image["imageId"], task, "prepare", memory_gib=DEFAULT_PREPARATION_MEMORY_GIB
        )
        result["preparationContainerId"] = container.id
        result["stage"] = "official_initialization"
        write_json(output / "prepared.json", result)
        verify_upstream_commit(container, task)
        module = MODULE_NAMES.get(row["repo"], row["repo"].split("/")[-1].replace("-", "_"))
        mask_files = re.findall(r"^diff --git a/(.*?) b/", row["patch"], re.MULTILINE)
        fingerprint_script = """import hashlib,json,pathlib,sys
module=sys.argv[1]; paths=json.loads(sys.argv[2]); result={}
generic={'__init__.py','__main__.py','version.py','_version.py','_version_meson.py'}
for name in paths:
    parts=pathlib.PurePosixPath(name).parts
    if module not in parts or parts[-1] not in generic: continue
    relative=str(pathlib.PurePosixPath(*parts[parts.index(module)+1:]))
    path=pathlib.Path('/root/my_repo')/name
    if path.is_file(): result[relative]=hashlib.sha256(path.read_bytes()).hexdigest()
print(json.dumps(result))
"""
        # Capture only hashes before the official mask removes reference code.
        # A changed __init__.py can identify a real compiled-package copy while
        # an unrelated integration package with that filename remains intact.
        original_generic_hashes = json.loads(
            checked_exec(
                container,
                "python -c "
                + shlex.quote(fingerprint_script)
                + " "
                + shlex.quote(module)
                + " "
                + shlex.quote(json.dumps(mask_files)),
            )
        )
        from featurebench.infer.container import ContainerManager
        from featurebench.infer.models import TaskInstance
        from featurebench.infer.runtime import RuntimeHandler

        manager = ContainerManager(logger=logger)
        runtime = RuntimeHandler(manager, logger=logger)
        try:
            # Skip upstream's unrelated apt installation of tmux/asciinema;
            # execute its exact pinned Level 1 source/environment initialization.
            if not runtime._initialize_level1(
                container, TaskInstance.from_dict(row), output / "initialize.log", white_box=False
            ):
                raise RuntimeError("Official Level 1 initialization failed")
            if not runtime.clear_package_caches(container, output / "initialize.log"):
                raise RuntimeError("Official package cache removal failed")
        finally:
            manager.client.close()
        # Vendored packages are source copies too (for example pip and wheel
        # both contain packaging). Redirect every installed target package,
        # including copies nested under other distributions, to masked source.
        isolation_arguments = {
            "workspace": "/testbed",
            "module": module,
            "mask_files": mask_files,
            "hidden_files": row["FAIL_TO_PASS"],
            "scan_roots": ["/opt", "/usr", "/root", "/tmp", "/var", "/testbed/build"],
            "original_generic_hashes": original_generic_hashes,
        }
        cleanup_script = (
            PACKAGE_ISOLATION_SOURCE
            + "\nimport json\nprint(json.dumps(isolate_target_package(**"
            + repr(isolation_arguments)
            + ")))"
        )
        result["packageIsolation"] = json.loads(
            checked_exec(container, "python -c " + shlex.quote(cleanup_script))
        )
        result["stage"] = "package_isolation_complete"
        write_json(output / "prepared.json", result)
        missing_tests = [
            str(Path("/testbed") / test.removeprefix("/testbed/")) for test in row["FAIL_TO_PASS"]
        ]
        for path in missing_tests:
            checked_exec(container, "test ! -e " + shlex.quote(path))
        build_cleanup_script = (
            BUILD_MANIFEST_SANITIZATION_SOURCE
            + "\nimport json\nprint(json.dumps(sanitize_missing_test_build_entries("
            + repr("/testbed")
            + ", "
            + repr(missing_tests)
            + ")))"
        )
        result["buildManifestSanitization"] = json.loads(
            checked_exec(container, "python -c " + shlex.quote(build_cleanup_script))
        )
        materialization_script = (
            MESON_COPY_MATERIALIZATION_SOURCE
            + "\nimport json\nprint(json.dumps(materialize_meson_copy_outputs("
            + repr("/testbed")
            + ", "
            + repr(result["packageIsolation"]["canonical"])
            + ")))"
        )
        result["mesonCopyMaterialization"] = json.loads(
            checked_exec(container, "python -c " + shlex.quote(materialization_script))
        )
        checked_exec(container, "test ! -e /root/my_repo && test ! -e /tmp/mask.patch")
        checked_exec(
            container,
            "find /testbed -type d -name __pycache__ -prune -exec rm -rf -- {} +; find /testbed -type f \\( -name '*.pyc' -o -name '*.pyo' \\) -delete",
        )
        # A deterministic, single-root history is shared by parent and children.
        checked_exec(
            container,
            "cd /testbed && find . -name .git -prune -exec rm -rf -- {} + && find . -name .pytest_cache -type d -prune -exec rm -rf -- {} + && git init -b main && git config user.email benchmark@openinspect.local && git config user.name OpenInspect && git add -A && GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z git commit --allow-empty -m 'FeatureBench isolated initial state'",
        )
        initial_commit = checked_exec(
            container,
            'cd /testbed && test "$(git rev-list --count HEAD)" = 1 && test -z "$(git remote)" && git rev-parse HEAD',
        ).strip()
        git_paths = checked_exec(
            container,
            "find / -xdev -name .git -print -prune 2>/dev/null",
        ).splitlines()
        if git_paths != ["/testbed/.git"]:
            raise RuntimeError(
                "Unexpected additional Git histories in prepared image: " + repr(git_paths)
            )
        result["gitHistoryAudit"] = {"paths": git_paths, "singleInitialCommit": initial_commit}
        checked_exec(container, "test ! -e /workspace && ln -s /testbed /workspace")
        archive_path = output / "workspace.tar"
        with archive_path.open("wb") as destination:
            subprocess.run(
                ["docker", "exec", container.id, "tar", "-C", "/testbed", "-cf", "-", "."],
                stdout=destination,
                check=True,
            )
        prompt_path = output / "prompt.original.txt"
        prompt_path.write_bytes(row["problem_statement"].encode("utf-8"))
        result["stage"] = "flattening_sanitized_image"
        write_json(output / "prepared.json", result)
        # Flatten so prior pristine layers cannot accompany the agent image.
        tag = "openinspect-featurebench:" + hashlib.sha256(task_id.encode()).hexdigest()[:16]
        inspected_image = json.loads(
            subprocess.run(
                ["docker", "image", "inspect", image["imageId"]],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )[0]
        image_size = inspected_image["Size"]
        free_bytes = shutil.disk_usage(root).free
        required_bytes = 2 * image_size + DEFAULT_FLATTEN_DISK_RESERVE_BYTES
        result["diskCapacity"] = {
            "freeBytesBeforeFlatten": free_bytes,
            "officialImageSizeBytes": image_size,
            "requiredFreeBytes": required_bytes,
            "reserveBytes": DEFAULT_FLATTEN_DISK_RESERVE_BYTES,
            "basis": "two uncompressed image copies plus host/scorer reserve",
        }
        write_json(output / "prepared.json", result)
        if free_bytes < required_bytes:
            raise RuntimeError(
                "Insufficient disk before flatten: "
                f"{free_bytes} bytes free, {required_bytes} required; "
                "preserve this failed generation and retry after capacity is available"
            )
        image_config = inspected_image["Config"]
        environment = dict(
            entry.split("=", 1) for entry in image_config.get("Env", []) if "=" in entry
        )
        environment["PATH"] = (
            "/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        )
        import_command = ["docker", "import", "--change", "WORKDIR /testbed"]
        for name, value in environment.items():
            import_command.extend(["--change", "ENV " + name + "=" + json.dumps(value)])
        export = subprocess.Popen(["docker", "export", container.id], stdout=subprocess.PIPE)
        imported = subprocess.run(
            [*import_command, "-", tag], stdin=export.stdout, capture_output=True, text=True
        )
        export.stdout.close()
        if export.wait() or imported.returncode:
            raise RuntimeError("Clean image flatten/import failed: " + imported.stderr[-2000:])
        result.update(
            ready=True,
            stage="prepared",
            baseImage=imported.stdout.strip(),
            baseCommit=initial_commit,
            workspacePath="/testbed",
            workspaceArchive=str(archive_path),
            workspaceArchiveSha256=sha256_file(archive_path).removeprefix("sha256:"),
            promptPaths=[str(prompt_path)],
            promptSha256=task["promptSha256"],
            sanitizedImageTag=tag,
            hiddenTestsRemoved=True,
            flattened=True,
            baselineCommitCount=1,
        )
        result["resourceUsage"] = {
            "memoryPeakBytes": int(checked_exec(container, "cat /sys/fs/cgroup/memory.peak")),
            "memoryEvents": checked_exec(container, "cat /sys/fs/cgroup/memory.events"),
        }
    except KeyboardInterrupt:
        result.update(status="interrupted", error="Preparation interrupted")
    except Exception as error:
        logger.exception("FeatureBench preparation failed")
        result.update(status="infrastructure_failed", error=str(error))
    finally:
        cleanup_container(container, result)
        if result["cleanup"]["status"] == "failed":
            result["ready"] = False
        if client:
            client.close()
        result["durationSeconds"] = round(time.monotonic() - started, 3)
        write_json(output / "prepared.json", result)
        close_logger(logger)
    return result


@serial_containers
def score(
    lab_root: Path,
    task_id: str,
    output: Path,
    prediction_patch: Path | None = None,
    *,
    calibration_mode: str | None = None,
    timeout_seconds: int | None = None,
    prepared_image: str | None = None,
    baseline_commit: str | None = None,
) -> dict:
    root = external_root(lab_root)
    output = output_directory(root, output)
    task, lock, row = load_task(root, task_id)
    if timeout_seconds is None:
        timeout_seconds = task["environment"].get(
            "testTimeoutSeconds", DEFAULT_TEST_TIMEOUT_SECONDS
        )
    if (output / "score.json").exists():
        raise FileExistsError("Score output exists; use a new attempt directory")
    result = {
        "taskId": task_id,
        "benchmark": "featurebench",
        "status": "running",
        "resolved": False,
        "sourceRevision": lock["source"]["gitCommit"],
        "datasetRevision": lock["dataset"]["revision"],
        "calibrationMode": calibration_mode,
        "attemptIncluded": True,
        "adapterSha256": ADAPTER_SHA256,
        "environmentKind": "prepared_runtime" if prepared_image else "official",
        "testTimeoutSeconds": timeout_seconds,
    }
    write_json(output / "score.json", result)
    logger = logger_for(output)
    started = time.monotonic()
    container = client = None
    try:
        verify_dependencies(lock)
        import pandas as pd
        from featurebench.harness.report import (
            build_test_status,
            generate_instance_report,
            parse_test_outputs,
        )
        from featurebench.harness.runtime import run_instance_level1
        from featurebench.harness.utils import preprocess_hf_patch

        if calibration_mode == "baseline":
            patch = BASELINE_SENTINEL_PATCH
        elif calibration_mode == "gold":
            patch = preprocess_hf_patch(row["patch"], row["FAIL_TO_PASS"])
        elif prediction_patch:
            patch = prediction_patch.read_bytes().decode("utf-8")
        else:
            raise ValueError("A prediction patch or calibration mode is required")
        (output / "prediction.patch").write_bytes(patch.encode("utf-8"))
        write_json(
            output / "prediction.json",
            {
                "instance_id": task_id,
                "model_patch": patch,
                "n_attempt": 1,
                "model_name_or_path": "calibration" if calibration_mode else "openinspect",
            },
        )
        if prepared_image:
            if not baseline_commit:
                raise ValueError("Prepared image scoring requires its locked baseline commit")
            prepared_image = subprocess.run(
                ["docker", "image", "inspect", "--format", "{{.Id}}", prepared_image],
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
            image = {"imageId": prepared_image}
            result["preparedImage"] = prepared_image
            result["baselineCommit"] = baseline_commit
        else:
            image = image_for_task(root, task, lock)
            result["officialImage"] = image
        client, container = new_container(
            image["imageId"], task, "calibrate-" + calibration_mode if calibration_mode else "score"
        )
        result["containerId"] = container.id
        write_json(output / "score.json", result)
        if prepared_image:
            actual_commit = checked_exec(container, "git -C /testbed rev-parse HEAD").strip()
            if actual_commit != baseline_commit:
                raise ValueError("Prepared runtime image differs from the expected baseline")
            checked_exec(container, "test ! -e /root/my_repo && cp -a /testbed /root/my_repo")
            row = dict(row, patch="")
            result["preparedHarnessAdaptation"] = (
                "Existing masked source is the initial backup; skip removal patch; unchanged official prediction/test-patch application and grading"
            )
        else:
            verify_upstream_commit(container, task)
        evaluation = run_instance_level1(
            pd.Series(row),
            {"model_patch": patch},
            container,
            logger,
            output,
            timeout=timeout_seconds,
        )
        parsed = parse_test_outputs(output, row["repo"], 1)
        test_status = build_test_status(*parsed)
        report = generate_instance_report(
            task_id, 1, patch, evaluation["patch_applied"], *test_status, evaluation
        )
        write_json(output / "official-report.json", report)
        result.update(
            status="scored",
            resolved=report[task_id]["resolved"],
            evaluation=evaluation,
            officialReportPath=str(output / "official-report.json"),
            f2pObservedCount=len(parsed[0]),
            p2pObservedCount=sum(map(len, parsed[1])),
            predictionSha256=digest_bytes(patch.encode("utf-8")),
        )
        # Keep upstream correctness and missing-test evidence distinct.
        result["testEvidencePresent"] = (output / "test_output.txt").exists() and bool(parsed[0])
        if evaluation.get("error") and calibration_mode:
            result["status"] = "calibration_failed"
    except KeyboardInterrupt:
        result.update(status="interrupted", error="Scoring interrupted")
    except Exception as error:
        logger.exception("FeatureBench scoring failed")
        result.update(status="infrastructure_failed", error=str(error))
    finally:
        cleanup_container(container, result)
        if client:
            client.close()
        result["durationSeconds"] = round(time.monotonic() - started, 3)
        write_json(output / "score.json", result)
        close_logger(logger)
    return result


def calibrate(
    lab_root: Path,
    task_id: str,
    output: Path,
    *,
    timeout_seconds: int | None = None,
    prepared_image: str | None = None,
    baseline_commit: str | None = None,
) -> dict:
    root = external_root(lab_root)
    output = output_directory(root, output)
    result = {
        "taskId": task_id,
        "benchmark": "featurebench",
        "passed": False,
        "status": "running",
        "preparedImage": prepared_image,
        "baselineCommit": baseline_commit,
        "baselinePolicy": "inert added sentinel file: official harness rejects truly empty predictions before tests",
    }
    if (output / "calibration.json").exists():
        raise FileExistsError(
            "Calibration attempt exists; choose a new directory to preserve evidence"
        )
    write_json(output / "calibration.json", result)
    if prepared_image:
        try:
            prepared_image = subprocess.run(
                ["docker", "image", "inspect", "--format", "{{.Id}}", prepared_image],
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
            result["preparedImage"] = prepared_image
        except Exception as error:
            result.update(status="infrastructure_failed", error=str(error))
            write_json(output / "calibration.json", result)
            return result
    for mode in ("baseline", "gold"):
        outcome = score(
            root,
            task_id,
            output / mode,
            calibration_mode=mode,
            timeout_seconds=timeout_seconds,
            prepared_image=prepared_image,
            baseline_commit=baseline_commit,
        )
        result[mode] = outcome
        write_json(output / "calibration.json", result)
        if outcome["status"] in {"infrastructure_failed", "interrupted"}:
            break
    baseline, gold = result.get("baseline", {}), result.get("gold", {})
    result["passed"] = bool(
        baseline.get("status") == "scored"
        and baseline.get("testEvidencePresent")
        and baseline.get("evaluation", {}).get("f2p_success") is False
        and baseline.get("evaluation", {}).get("p2p_success") is True
        and gold.get("status") == "scored"
        and gold.get("testEvidencePresent")
        and gold.get("resolved") is True
        and baseline.get("cleanup", {}).get("status") == "removed"
        and gold.get("cleanup", {}).get("status") == "removed"
    )
    result["status"] = "passed" if result["passed"] else "failed"
    write_json(output / "calibration.json", result)
    return result


@serial_preparation
def verify_agent_environment(
    lab_root: Path, task_id: str, output: Path, prepared_image: str
) -> dict:
    """Probe real agent identity and visible task tooling without model calls."""
    import docker

    root = external_root(lab_root)
    output = output_directory(root, output)
    if (output / "agent-environment.json").exists():
        raise ValueError("Agent verification requires a new output directory")
    _task, _, row = load_task(root, task_id)
    prepared_path = root / "task-workspaces" / task_id / "prepared.json"
    prepared = json.loads(prepared_path.read_text())
    if not prepared.get("ready") or prepared.get("packageIsolation", {}).get("auditVersion", 0) < 3:
        raise ValueError("Agent verification requires current v3 task preparation")
    runtime_path = prepared_path.parent / "runtime-overlay/runtime.json"
    runtime = json.loads(runtime_path.read_text())
    if not runtime.get("ready") or runtime.get("preparedSha256") != sha256_file(
        prepared_path
    ).removeprefix("sha256:"):
        raise ValueError("Runtime does not correspond to the current prepared task")
    client = docker.from_env()
    container = None
    result = {
        "taskId": task_id,
        "benchmark": "featurebench",
        "classification": "agent_identity_and_visible_task_tooling; not official grading",
        "status": "running",
        "passed": False,
        "checks": [],
        "adapterSha256": ADAPTER_SHA256,
        "preparedSha256": runtime["preparedSha256"],
        "packageIsolationAuditVersion": prepared["packageIsolation"]["auditVersion"],
        "resourceLimits": {
            "memoryGiB": DEFAULT_AGENT_CHECK_MEMORY_GIB,
            "slot": "preparation",
            "network": "none",
        },
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    report_path = output / "agent-environment.json"
    write_json(report_path, result)

    def check(category, arguments, *, agent=True):
        command = ["docker", "exec", "--workdir", "/testbed"]
        if agent:
            command += [
                "--user",
                "10001:10001",
                "--env",
                "HOME=/home/oi-agent",
                "--env",
                "XDG_CACHE_HOME=/home/oi-agent/.cache",
                "--env",
                "OPENBLAS_NUM_THREADS=1",
            ]
        started = time.monotonic()
        completed = subprocess.run(
            [*command, container.id, *arguments],
            capture_output=True,
            text=True,
            timeout=DEFAULT_SETUP_TIMEOUT_SECONDS,
        )
        item = {
            "category": category,
            "uid": 10001 if agent else 0,
            "command": arguments,
            "returnCode": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
            "durationSeconds": round(time.monotonic() - started, 3),
            "passed": completed.returncode == 0,
        }
        result["checks"].append(item)
        write_json(report_path, result)
        return item

    try:
        actual_image = client.images.get(prepared_image).id
        if actual_image != runtime.get("imageId"):
            raise ValueError("Agent check image differs from current runtime image")
        result["preparedImage"] = actual_image
        result["agentLauncherSha256"] = runtime["agentLauncherSha256"]
        container = client.containers.run(
            actual_image,
            ["sleep", "infinity"],
            entrypoint=[],
            detach=True,
            network_disabled=True,
            security_opt=["no-new-privileges:true"],
            working_dir="/testbed",
            user="root",
            mem_limit=f"{DEFAULT_AGENT_CHECK_MEMORY_GIB}g",
            nano_cpus=2_000_000_000,
            labels={
                "openinspect.benchmark": "featurebench",
                "openinspect.task": task_id,
                "openinspect.purpose": "verify-agent",
            },
        )
        result["containerId"] = container.id
        if not check(
            "real_launcher_initialization", ["/opt/oi-tools/opencode", "--version"], agent=False
        )["passed"]:
            raise RuntimeError("Real launcher initialization failed")
        check(
            "identity",
            [
                "sh",
                "-c",
                "test \"$(id -u)\" = 10001 && id && awk '/^NoNewPrivs:/ {print; if ($2 != 1) exit 1}' /proc/self/status",
            ],
        )
        probe = (
            "import json,os,pathlib; "
            f"paths={row['PASS_TO_PASS']!r}; "
            "assert paths; [pathlib.Path(p).open('rb').read(1) for p in paths]; "
            "p=pathlib.Path('.oi-agent-permission-probe'); p.write_text('probe'); p.unlink(); "
            "assert not os.access('/opt/oi-runtime/lib/python3.12/site-packages',os.R_OK); "
            "assert not os.access('/opt/oi-runtime/lib/node_modules',os.R_OK); "
            "print(json.dumps({'readableOriginalTestFiles':len(paths),'workspaceWritable':True,'privateDependenciesUnreadable':True}))"
        )
        check(
            "visible_tests_workspace_and_private_runtime",
            ["/opt/oi-runtime/bin/python3.12", "-S", "-c", probe],
        )
        module = MODULE_NAMES.get(row["repo"], row["repo"].split("/")[-1].replace("-", "_"))
        materialized_copies = prepared.get("mesonCopyMaterialization", {}).get(
            "materializedMaskedPythonCopies", []
        )
        binary_probe = None
        binaries_before = None
        if materialized_copies:
            binary_roots = [
                item["path"]
                for item in prepared["packageIsolation"].get("preservedCompiledPackages", [])
            ]
            binary_probe = (
                "import hashlib,json,pathlib; "
                f"roots={binary_roots!r}; "
                "files=sorted({p for root in roots for p in pathlib.Path(root).rglob('*.so')}); "
                "print(json.dumps({str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}))"
            )
            binaries_before = check(
                "compiled_extensions_before_editable_import",
                ["/opt/oi-runtime/bin/python3.12", "-S", "-c", binary_probe],
            )
        target_probe = (
            TARGET_MODULE_LOCATION_SOURCE + "\nimport importlib,json,sys; "
            f"target=importlib.import_module({module!r}); "
            "location=verify_target_module_location(target.__file__, "
            f"{prepared['packageIsolation']['canonical']!r}, {materialized_copies!r}, '/testbed'); "
            "print(json.dumps({'executable':sys.executable,'version':sys.version,**location}))"
        )
        check(
            "task_interpreter_and_target_import",
            ["/opt/miniconda3/envs/testbed/bin/python", "-B", "-c", target_probe],
        )
        if binary_probe and binaries_before:
            binaries_after = check(
                "compiled_extensions_after_editable_import",
                ["/opt/oi-runtime/bin/python3.12", "-S", "-c", binary_probe],
            )
            if binaries_before["passed"] and binaries_after["passed"]:
                before = json.loads(binaries_before["stdout"])
                after = json.loads(binaries_after["stdout"])
                result["compiledExtensionRebuild"] = {
                    "beforeCount": len(before),
                    "afterCount": len(after),
                    "removedPaths": sorted(before.keys() - after.keys()),
                    "addedPaths": sorted(after.keys() - before.keys()),
                    "changedPaths": sorted(
                        name for name in before.keys() & after.keys() if before[name] != after[name]
                    ),
                    "interpretation": "Observed editable-build outputs; preparation-time preservation is a separate archive comparison.",
                }
                write_json(report_path, result)
        matched_copies = prepared["packageIsolation"].get("matchedMaskedGenericCopies", [])
        if matched_copies:
            copy_probe = (
                "import json,pathlib; "
                f"root=pathlib.Path({prepared['packageIsolation']['canonical']!r}); "
                f"copies={matched_copies!r}; "
                "pairs=[(pathlib.Path(copy['path'])/name,root/name) for copy in copies for name in copy['matchingOriginalFiles']]; "
                "assert all(a.read_bytes()==b.read_bytes() for a,b in pairs); "
                "print(json.dumps({'maskedGenericCopiesMatchCanonicalAfterImport':len(pairs)}))"
            )
            check(
                "masked_generic_copy_integrity_after_import",
                ["/opt/miniconda3/envs/testbed/bin/python", "-B", "-c", copy_probe],
            )
        if row["repo"] == "pandas-dev/pandas":
            pandas_probe = (
                "import json,pathlib; from hypothesis.extra.pandas import data_frames; "
                "assert data_frames.__module__.startswith('hypothesis.extra.pandas'); "
                "build=pathlib.Path('/testbed/build/cp311/pandas'); binaries=list(build.rglob('*.so')); "
                "assert binaries and not build.is_symlink(); "
                "print(json.dumps({'hypothesisStrategyModule':data_frames.__module__,'compiledExtensionCount':len(binaries)}))"
            )
            check(
                "pandas_hypothesis_integration_and_compiled_extensions",
                ["/opt/miniconda3/envs/testbed/bin/python", "-B", "-c", pandas_probe],
            )
        check(
            "pytest_tool",
            ["/opt/miniconda3/envs/testbed/bin/python", "-B", "-m", "pytest", "--version"],
        )
        check(
            "tracked_worktree_unchanged",
            ["sh", "-c", 'test -z "$(git status --porcelain --untracked-files=no)"'],
        )
        result["passed"] = all(item["passed"] for item in result["checks"])
        result["status"] = "passed" if result["passed"] else "agent_environment_failure"
    except KeyboardInterrupt:
        result.update(status="interrupted", error="Agent environment check interrupted")
    except Exception as error:
        result.update(status="infrastructure_failed", error=str(error))
    finally:
        cleanup_container(container, result)
        if result["cleanup"]["status"] != "removed":
            result["passed"] = False
        client.close()
        result["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_json(report_path, result)
    return result


def main() -> int:
    def interrupt(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=["bootstrap", "pull-images", "prepare", "calibrate", "score", "verify-agent"],
    )
    parser.add_argument("--lab-root", type=Path, default=os.environ.get("BENCHMARK_LAB_ROOT"))
    parser.add_argument("--task-id")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--prediction-patch", "--patch", type=Path)
    parser.add_argument(
        "--timeout-seconds", type=int, help="Default: task manifest testTimeoutSeconds"
    )
    parser.add_argument("--prepared-image")
    parser.add_argument("--baseline-commit")
    parser.add_argument(
        "--new-generation", action="store_true", help="Archive and rebuild prepared task"
    )
    args = parser.parse_args()
    if not args.lab_root:
        parser.error("--lab-root or BENCHMARK_LAB_ROOT is required")
    if args.timeout_seconds is not None and args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be positive")
    if args.command in {"prepare", "calibrate", "score", "verify-agent"} and (
        not args.task_id or not args.output
    ):
        parser.error("prepare/calibrate/score/verify-agent require --task-id and --output")
    if args.command == "verify-agent" and not args.prepared_image:
        parser.error("verify-agent requires --prepared-image")
    if args.new_generation and args.command != "prepare":
        parser.error("--new-generation only applies to prepare")
    if args.command == "bootstrap":
        result = bootstrap(args.lab_root)
        ok = result["ready"]
    elif args.command == "pull-images":
        result = pull_images(args.lab_root, args.task_id)
        ok = result["ready"]
    elif args.command == "prepare":
        result = prepare(
            args.lab_root, args.task_id, args.output, new_generation=args.new_generation
        )
        ok = result["ready"]
    elif args.command == "verify-agent":
        result = verify_agent_environment(
            args.lab_root, args.task_id, args.output, args.prepared_image
        )
        ok = result["passed"]
    elif args.command == "calibrate":
        result = calibrate(
            args.lab_root,
            args.task_id,
            args.output,
            timeout_seconds=args.timeout_seconds,
            prepared_image=args.prepared_image,
            baseline_commit=args.baseline_commit,
        )
        ok = result["passed"]
    else:
        result = score(
            args.lab_root,
            args.task_id,
            args.output,
            args.prediction_patch,
            timeout_seconds=args.timeout_seconds,
            prepared_image=args.prepared_image,
            baseline_commit=args.baseline_commit,
        )
        ok = result["status"] == "scored"
    print(json.dumps(result, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
