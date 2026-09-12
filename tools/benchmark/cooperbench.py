#!/usr/bin/env python3
"""Pinned CooperBench data, clean agent images, and official grading without LLMs.

All benchmark material, caches and reports live under --lab-root, outside this repo.
Only the Docker transport is adapted; grading functions are loaded from the locked
upstream source. No model SDK or cloud credential is needed.
"""

from __future__ import annotations

import argparse
import ast
import base64
import hashlib
import http.client
import io
import json
import os
import re
import subprocess
import tarfile
import time
import types
import urllib.error
import urllib.request
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TIMEOUT_SECONDS = 600
DEFAULT_MEMORY_GIB = 4
DEFAULT_CPU = 2
PLATFORM = "linux/amd64"
SANITIZATION_VERSION = 1


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def reserve_report(path: Path, value: object) -> None:
    """Publish the initial valid JSON atomically, refusing concurrent reuse."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".initial-" + uuid.uuid4().hex)
    try:
        temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
        os.link(temporary, path)
    except FileExistsError as exc:
        raise FileExistsError(
            "Preserve the existing report; choose a new output generation"
        ) from exc
    finally:
        temporary.unlink(missing_ok=True)


def command(
    args: list[str], *, timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS, check: bool = True, **kwargs
) -> subprocess.CompletedProcess:
    return subprocess.run(
        args, capture_output=True, text=True, timeout=timeout_seconds, check=check, **kwargs
    )


def bootstrap(lab_root: Path, tasks: list[dict], *, skip_images: bool = False) -> dict:
    """Rebuild locked public inputs without relying on previous-session scripts."""
    import fcntl

    lab_root = lab_root.resolve()
    if lab_root == REPO_ROOT or REPO_ROOT in lab_root.parents:
        raise ValueError("Benchmark material must live outside the source repository")
    lock = json.loads((REPO_ROOT / "experiments/cooperbench-lock.json").read_text())
    lab_root.mkdir(parents=True, exist_ok=True)
    with (lab_root / ".cooperbench-bootstrap.lock").open("a") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        source = lab_root / lock["source"]["path_relative_to_lab"]
        if not source.exists():
            staging = source.with_name(source.name + ".bootstrap-" + uuid.uuid4().hex[:8])
            staging.mkdir(parents=True)
            command(["git", "init", str(staging)])
            command(["git", "-C", str(staging), "remote", "add", "origin", lock["source"]["url"]])
            command(
                [
                    "git",
                    "-C",
                    str(staging),
                    "fetch",
                    "--depth=1",
                    "origin",
                    lock["source"]["git_sha"],
                ]
            )
            command(["git", "-C", str(staging), "checkout", "--detach", lock["source"]["git_sha"]])
            staging.rename(source)
        _, _, _, dataset = configuration(lab_root)
        if sha256(source / "uv.lock") != lock["evaluator"]["dependency_lock_sha256"]:
            raise ValueError("Upstream dependency lock has changed")
        if command(["git", "-C", str(source), "status", "--porcelain"]).stdout:
            raise ValueError(
                "Existing CooperBench source has local changes; preserve and review them"
            )
        tree = command(["git", "-C", str(source), "rev-parse", "HEAD:dataset"]).stdout.strip()
        if tree != lock["dataset"]["git_tree_sha"]:
            raise ValueError("Pinned dataset Git tree differs from lock")
        archive = subprocess.run(
            ["git", "-C", str(source), "archive", "--format=tar", "HEAD:dataset"],
            capture_output=True,
            check=True,
            timeout=DEFAULT_TIMEOUT_SECONDS,
        ).stdout
        files = {}
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            for entry in bundle:
                path = Path(entry.name)
                if path.is_absolute() or ".." in path.parts:
                    raise ValueError("Unsafe dataset archive path")
                if entry.isdir():
                    continue
                if not entry.isfile():
                    raise ValueError("Dataset archive must contain only regular files")
                files[entry.name] = bundle.extractfile(entry).read()
        inventory = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}
        inventory_digest = hashlib.sha256(
            json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        if (
            inventory_digest != lock["dataset"]["inventory_sha256"]
            or len(files) != lock["dataset"]["files"]
            or sum(map(len, files.values())) != lock["dataset"]["bytes"]
        ):
            raise ValueError("Full dataset inventory differs from lock")
        existing = {str(path.relative_to(dataset)) for path in dataset.rglob("*") if path.is_file()}
        if existing - files.keys():
            raise ValueError("Existing dataset has extra files; preserve and review them")
        for name, data in files.items():
            destination = dataset / name
            if destination.exists():
                if destination.is_symlink() or destination.read_bytes() != data:
                    raise ValueError(f"Existing dataset file differs from lock: {name}")
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
        write_json(lab_root / "datasets/cooperbench-inventory.json", inventory)
        ensure_offline_dependencies(lab_root, lock)
        for task in tasks:
            validate_task(task, dataset)
            if not skip_images:
                ensure_image(task, lab_root, lock)
        report = {
            "status": "complete",
            "source_revision": lock["source"]["git_sha"],
            "dataset_inventory_sha256": inventory_digest,
            "dataset_files": len(files),
            "offline_wheels": len(lock["offline_dependencies"]["files"]),
            "images_verified": 0 if skip_images else len(tasks),
            "host_dependencies": "Python 3.11+ standard library, git, Docker CLI/daemon; no CooperBench venv or LLM SDK",
        }
        write_json(lab_root / "runs/bootstrap/cooperbench.json", report)
        return report


def configuration(lab_root: Path) -> tuple[dict, dict, Path, Path]:
    lab_root = lab_root.resolve()
    if lab_root == REPO_ROOT or REPO_ROOT in lab_root.parents:
        raise ValueError("Benchmark material must live outside the source repository")
    manifest = json.loads((REPO_ROOT / "experiments/cooperbench-tasks.json").read_text())
    lock = json.loads((REPO_ROOT / "experiments/cooperbench-lock.json").read_text())
    source = lab_root / lock["source"]["path_relative_to_lab"]
    dataset = lab_root / lock["dataset"]["path_relative_to_lab"]
    actual = command(["git", "-C", str(source), "rev-parse", "HEAD"]).stdout.strip()
    if actual != lock["source"]["git_sha"]:
        raise ValueError(f"CooperBench source revision mismatch: {actual}")
    if sha256(source / lock["evaluator"]["path"]) != lock["evaluator"]["sha256"]:
        raise ValueError("Upstream evaluator has changed")
    return manifest, lock, source, dataset


def validate_task(task: dict, dataset: Path) -> None:
    feature_ids = task["feature_ids"]
    if (
        len(feature_ids) != 2
        or len(set(feature_ids)) != 2
        or [feature["feature_id"] for feature in task["features"]] != feature_ids
    ):
        raise ValueError(
            "A CooperBench task must contain exactly its two ordered, distinct features"
        )
    for feature in task["features"]:
        for label in ("prompt", "gold_patch", "tests_patch"):
            if sha256(dataset / feature[f"{label}_path"]) != feature[f"{label}_sha256"]:
                raise ValueError(f"Changed {label} for {task['id']}")
    if sha256(dataset / task["combined_patch_path"]) != task["combined_patch_sha256"]:
        raise ValueError(f"Changed combined patch for {task['id']}")
    for label in ("dockerfile", "runner"):
        key = "official_dockerfile" if label == "dockerfile" else "runner_path"
        if sha256(dataset / task["setup"][key]) != task["setup"][f"{label}_sha256"]:
            raise ValueError(f"Changed {label} for {task['id']}")


def ensure_image(task: dict, lab_root: Path, lock: dict) -> dict:
    image = task["image"]
    image_lock_path = (
        lab_root / "cache/cooperbench-images" / (task["repo"] + f"-{task['task_id']}.json")
    )
    prior = lock["images"][image]
    from pull_image import ensure_image as pull_image

    # Local image IDs depend on Docker's image store. Pin registry content instead.
    pull = pull_image(image, lab_root, expected_digest=prior["manifestDigest"])
    if pull["configDigest"] != prior["configDigest"]:
        raise ValueError(f"Image config changed since lock: {image}")
    inspect = command(["docker", "image", "inspect", pull["imageId"]])
    details = json.loads(inspect.stdout)[0]
    record = {
        **prior,
        **pull,
        "tag": image,
        "image_id": details["Id"],
        "repo_digests": details["RepoDigests"],
        "platform": f"{details['Os']}/{details['Architecture']}",
        "size_bytes": details["Size"],
    }
    if record["platform"] != PLATFORM:
        raise ValueError(f"Unexpected image architecture: {record['platform']}")
    if (
        not record.get("source_verified")
        or not record.get("base_tree")
        or prior["image_id"] != details["Id"]
    ):
        verification = command(
            [
                "docker",
                "run",
                "--rm",
                "--read-only",
                "--network",
                "none",
                "--entrypoint",
                "/bin/sh",
                details["Id"],
                "-c",
                "git -C /workspace/repo rev-parse HEAD && sha256sum /usr/local/bin/runner.sh && git -C /workspace/repo rev-parse 'HEAD^{tree}'",
            ]
        ).stdout.splitlines()
        if verification[0] != task["base_commit"]:
            raise ValueError(f"Official image base differs from locked dataset: {image}")
        if verification[1].split()[0] != task["setup"]["runner_sha256"]:
            raise ValueError(f"Official image runner differs from locked dataset: {image}")
        record["source_verified"] = True
        record["base_commit"] = verification[0]
        record["runner_sha256"] = verification[1].split()[0]
        record["base_tree"] = verification[2]
    write_json(image_lock_path, record)
    return record


def ensure_offline_dependencies(lab_root: Path, lock: dict) -> Path:
    dependencies = lock.get("offline_dependencies", lock.get("offline_build_dependencies"))
    directory = lab_root / dependencies["path_relative_to_lab"]
    directory.mkdir(parents=True, exist_ok=True)
    for filename, expected in dependencies["files"].items():
        path = directory / filename
        if not path.exists():
            url = dependencies["urls"][filename]
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(url, timeout=DEFAULT_TIMEOUT_SECONDS) as response:
                        payload = response.read()
                    break
                except (OSError, urllib.error.URLError, http.client.HTTPException):
                    if attempt == 2:
                        raise
                    time.sleep(attempt + 1)
            if hashlib.sha256(payload).hexdigest() != expected:
                raise ValueError(f"Offline dependency download hash mismatch: {filename}")
            temporary = path.with_suffix(".partial")
            temporary.write_bytes(payload)
            temporary.replace(path)
        if sha256(path) != expected:
            raise ValueError(f"Offline dependency hash mismatch: {filename}")
    if {path.name for path in directory.glob("*.whl")} != set(dependencies["files"]):
        raise ValueError("Unpinned dependency wheels are present in the grading wheelhouse")
    return directory


class DockerResult:
    def __init__(self, result: subprocess.CompletedProcess):
        self.returncode = result.returncode
        self._stdout, self._stderr = result.stdout, result.stderr

    def stdout_read(self) -> str:
        return self._stdout

    def stderr_read(self) -> str:
        return self._stderr


class DockerSandbox:
    def __init__(self, image: str, timeout_seconds: int, log_path: Path, wheelhouse: Path):
        self.deadline = time.monotonic() + timeout_seconds
        self.log_path = log_path
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.name = "oi-cooperbench-eval-" + uuid.uuid4().hex[:16]
        self.container_id = command(
            [
                "docker",
                "run",
                "-d",
                "--name",
                self.name,
                "--label",
                "openinspect.benchmark=cooperbench",
                "--network",
                "none",
                "--mount",
                f"type=bind,src={wheelhouse},dst=/opt/cooperbench-wheels,readonly",
                "--env",
                "PIP_NO_INDEX=1",
                "--env",
                "PIP_FIND_LINKS=/opt/cooperbench-wheels",
                "--cpus",
                str(DEFAULT_CPU),
                "--memory",
                f"{DEFAULT_MEMORY_GIB}g",
                "--entrypoint",
                "",
                image,
                "sleep",
                str(timeout_seconds),
            ]
        ).stdout.strip()
        try:
            self.exec("mkdir", "-p", "/patches")
        except BaseException:
            self.terminate()
            raise

    def exec(self, *args: str) -> DockerResult:
        remaining_seconds = max(1, int(self.deadline - time.monotonic()))
        result = command(
            ["docker", "exec", self.container_id, *args],
            timeout_seconds=remaining_seconds,
            check=False,
        )
        with self.log_path.open("a") as stream:
            stream.write(
                json.dumps(
                    {
                        "args": args,
                        "returncode": result.returncode,
                        "stdout": result.stdout,
                        "stderr": result.stderr,
                    }
                )
                + "\n"
            )
        return DockerResult(result)

    def terminate(self) -> None:
        result = command(["docker", "rm", "-f", self.container_id], check=False)
        with self.log_path.open("a") as stream:
            stream.write(
                json.dumps(
                    {
                        "cleanup": {
                            "container_id": self.container_id,
                            "returncode": result.returncode,
                            "stderr": result.stderr,
                        }
                    }
                )
                + "\n"
            )
        if result.returncode:
            raise RuntimeError(f"Failed to clean evaluation container {self.container_id}")


def evaluator(
    source: Path, image_id: str, logs: Path, runner_path: Path | None = None
) -> types.ModuleType:
    """Load exact upstream grading functions, replacing imports of transport only."""
    path = source / "src/cooperbench/eval/sandbox.py"
    tree = ast.parse(path.read_text(), filename=str(path))
    tree.body = [
        node
        for node in tree.body
        if not (isinstance(node, ast.ImportFrom) and (node.module or "").startswith("cooperbench."))
    ]
    module = types.ModuleType("cooperbench_pinned_grader")
    lock = json.loads((REPO_ROOT / "experiments/cooperbench-lock.json").read_text())
    wheelhouse = ensure_offline_dependencies(source.parents[1], lock)

    class Backend:
        def create_sandbox(self, image: str, timeout_seconds: int):
            sandbox = DockerSandbox(
                image_id,
                timeout_seconds,
                logs / (uuid.uuid4().hex + ".jsonl"),
                wheelhouse,
            )
            if runner_path is not None:
                try:
                    encoded = base64.b64encode(runner_path.read_bytes()).decode()
                    result = sandbox.exec(
                        "sh", "-c", f"printf %s '{encoded}' | base64 -d > /usr/local/bin/runner.sh"
                    )
                    if result.returncode:
                        raise RuntimeError(
                            "Cannot inject locked runner into overlay grading sandbox"
                        )
                except BaseException:
                    sandbox.terminate()
                    raise
            return sandbox

    module.__dict__.update(
        {
            "get_backend": lambda _: Backend(),
            "Sandbox": DockerSandbox,
            "DEFAULT_DATASET_DIR": Path("/unused"),
            "get_image_name": lambda *_: image_id,
        }
    )
    exec(compile(tree, str(path), "exec"), module.__dict__)
    return module


def baseline(
    grader: types.ModuleType,
    task: dict,
    dataset: Path,
    feature: dict,
    timeout_seconds: int,
    agent_patch: Path | None = None,
) -> dict:
    """Official feature runner with hidden tests only; no gold fallback or empty patch."""
    sandbox = grader.get_backend("docker").create_sandbox(task["image"], timeout_seconds)
    try:
        grader._write_patch(
            sandbox, "tests.patch", (dataset / feature["tests_patch_path"]).read_text()
        )
        arguments = ["bash", "-x", "/usr/local/bin/runner.sh", "tests.patch"]
        if agent_patch is not None:
            grader._write_patch(
                sandbox, "agent.patch", grader._filter_test_files(agent_patch.read_text())
            )
            arguments.append("agent.patch")
        result = sandbox.exec(*arguments)
        output = result.stdout_read() + result.stderr_read()
        parsed = grader._parse_results(output)
        return {
            "passed": result.returncode == 0 and parsed["passed"] > 0,
            "exit_code": result.returncode,
            "tests_passed": parsed["passed"],
            "tests_failed": parsed["failed"],
            "output": output,
            "tests_observed": parsed["passed"] + parsed["failed"] > 0,
        }
    finally:
        sandbox.terminate()


def calibration_equivalence(official: dict, overlay: dict) -> dict:
    """Compare observed test counts as well as final outcomes across environments."""
    checks = {}
    for section in ("baseline", "individual_gold"):
        checks[section] = official.get(section, {}).keys() == overlay.get(
            section, {}
        ).keys() and all(
            all(
                original.get(key) == overlay[section][feature_id].get(key)
                for key in ("passed", "tests_passed", "tests_failed")
            )
            for feature_id, original in official.get(section, {}).items()
        )
    checks["combined_gold"] = all(
        official.get("combined_gold", {}).get(feature, {}).get("passed")
        == overlay.get("combined_gold", {}).get(feature, {}).get("passed")
        for feature in ("feature1", "feature2")
    )
    return {
        "official_passed": official.get("passed") is True,
        "matching_test_counts_and_outcomes": checks,
        "passed": official.get("passed") is True and all(checks.values()),
    }


def calibrate(
    task: dict,
    lab_root: Path,
    *,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    image_id: str | None = None,
    output: Path | None = None,
) -> dict:
    _, lock, source, dataset = configuration(lab_root)
    validate_task(task, dataset)
    task_directory = lab_root / "runs/calibration/cooperbench" / task["id"]
    if image_id:
        actual_image = json.loads(command(["docker", "image", "inspect", image_id]).stdout)[0]["Id"]
        task_directory = task_directory / "overlays" / actual_image.removeprefix("sha256:")
    directory = (
        output
        or task_directory
        / ("attempt-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8])
    ).resolve()
    if directory == REPO_ROOT or REPO_ROOT in directory.parents:
        raise ValueError("Calibration output must be outside the repository")

    def save_report(report: dict) -> None:
        write_json(directory / "calibration.json", report)
        if output is None:
            write_json(task_directory / "calibration.json", report)

    report = {
        "task_id": task["id"],
        "status": "running",
        "started_at": time.time(),
        "source_revision": lock["source"]["git_sha"],
        "environment_kind": "runtime_overlay" if image_id else "official",
        "baseline": {},
        "individual_gold": {},
        "attempt_directory": str(directory),
    }
    reserve_report(directory / "calibration.json", report)
    try:
        if image_id:
            official_directory = lab_root / "runs/calibration/cooperbench" / task["id"]
            reference_alias = official_directory / "calibration.json"
            if reference_alias.exists():
                alias_bytes = reference_alias.read_bytes()
                alias = json.loads(alias_bytes)
                immutable_path = Path(alias["attempt_directory"]) / "calibration.json"
                if sha256(immutable_path) != hashlib.sha256(alias_bytes).hexdigest():
                    raise ValueError("Official immutable calibration differs from its latest alias")
            references = []
            for candidate in official_directory.rglob("calibration.json"):
                if "overlays" in candidate.relative_to(official_directory).parts:
                    continue
                candidate_report = json.loads(candidate.read_bytes())
                if candidate_report.get(
                    "environment_kind"
                ) == "runtime_overlay" or candidate_report.get("official_reference_report"):
                    continue
                generation = candidate_report.get("attempt_directory")
                if generation and candidate.parent.resolve() == Path(generation).resolve():
                    references.append(candidate)
            if not references:
                raise FileNotFoundError("No immutable official calibration report is available")
            reference_path = max(references, key=lambda path: path.stat().st_mtime_ns)
            reference_bytes = reference_path.read_bytes()
            reference = json.loads(reference_bytes)
            reference_digest = hashlib.sha256(reference_bytes).hexdigest()
            report["official_reference_report"] = str(reference_path)
            report["official_reference_sha256"] = reference_digest
        image = ensure_image(task, lab_root, lock)
        report["image"] = image
        report["grading_image_id"] = actual_image if image_id else image["image_id"]
        grader = evaluator(
            source,
            report["grading_image_id"],
            directory / "transport-logs",
            dataset / task["setup"]["runner_path"] if image_id else None,
        )
        for feature in task["features"]:
            feature_id = feature["feature_id"]
            started = time.monotonic()
            result = baseline(grader, task, dataset, feature, timeout_seconds)
            result["duration_seconds"] = time.monotonic() - started
            report["baseline"][str(feature_id)] = result
            save_report(report)
            started = time.monotonic()
            result = grader.run_patch_test(
                task["repo"],
                task["task_id"],
                feature_id,
                dataset / feature["gold_patch_path"],
                timeout=timeout_seconds,
                dataset_dir=dataset,
            )
            result["duration_seconds"] = time.monotonic() - started
            report["individual_gold"][str(feature_id)] = result
            save_report(report)
        started = time.monotonic()
        report["combined_gold"] = grader.test_solo(
            task["repo"],
            task["task_id"],
            *task["feature_ids"],
            patch=dataset / task["combined_patch_path"],
            timeout=timeout_seconds,
            dataset_dir=dataset,
        )
        report["combined_gold"]["duration_seconds"] = time.monotonic() - started
        base_good = all(
            not item["passed"] and item["tests_observed"] and item["tests_failed"] > 0
            for item in report["baseline"].values()
        )
        gold_good = all(item["passed"] for item in report["individual_gold"].values())
        report["status"] = (
            "passed"
            if base_good and gold_good and report["combined_gold"]["both_passed"]
            else "failed"
        )
        if image_id:
            report["environment_equivalence"] = calibration_equivalence(reference, report)
            if not report["environment_equivalence"]["passed"]:
                report["status"] = "environment_mismatch"
    except Exception as exc:
        report.update(status="infrastructure_error", error=f"{type(exc).__name__}: {exc}")
    except BaseException as exc:
        report.update(
            status="interrupted", passed=False, error=type(exc).__name__, finished_at=time.time()
        )
        save_report(report)
        raise
    report["passed"] = report["status"] == "passed"
    report["finished_at"] = time.time()
    report["duration_seconds"] = report["finished_at"] - report["started_at"]
    save_report(report)
    return report


def score(
    task: dict,
    lab_root: Path,
    output: Path,
    *,
    child_patches: list[Path] | None = None,
    parent_patch: Path | None = None,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    image_id: str | None = None,
) -> dict:
    output = output.resolve()
    if output == REPO_ROOT or REPO_ROOT in output.parents:
        raise ValueError("Scoring reports and grader logs must live outside the source repository")
    if output.suffix != ".json":
        output = output / "score.json"
    if output.exists():
        raise FileExistsError("Preserve the existing score report; choose a new scoring generation")
    report = {
        "task_id": task["id"],
        "status": "running",
        "started_at": time.time(),
        "protocol": "openinspect-parent-two-children-v1",
        "image": None,
        "grading_image_id": None,
        "source_revision": task["source_revision"],
        "official_child_patches": None,
        "openinspect_parent_integration": None,
        "missing_artifacts": [],
    }
    reserve_report(output, report)
    try:
        _, lock, source, dataset = configuration(lab_root)
        validate_task(task, dataset)
        children_available = (
            child_patches is not None
            and len(child_patches) == 2
            and all(path.is_file() for path in child_patches)
        )
        parent_available = parent_patch is not None and parent_patch.is_file()
        if not children_available:
            report["missing_artifacts"].append(
                {
                    "score": "official_child_patches",
                    "required_feature_ids": task["feature_ids"],
                    "reason": "Exactly two readable child patches in feature_ids order are required",
                }
            )
        if not parent_available:
            report["missing_artifacts"].append(
                {"score": "openinspect_parent_integration", "reason": "Parent patch is absent"}
            )
        write_json(output, report)
        if children_available or parent_available:
            image = ensure_image(task, lab_root, lock)
            grading_image_id = image["image_id"]
            if image_id:
                grading_image_id = json.loads(
                    command(["docker", "image", "inspect", image_id]).stdout
                )[0]["Id"]
            report.update(image=image, grading_image_id=grading_image_id)
            grader = evaluator(
                source,
                grading_image_id,
                output.parent / "transport-logs",
                dataset / task["setup"]["runner_path"] if image_id else None,
            )
            write_json(output, report)
            if children_available:
                report["child_patch_sha256"] = [sha256(path) for path in child_patches]
                report["official_child_patches"] = grader.test_merged(
                    task["repo"],
                    task["task_id"],
                    *task["feature_ids"],
                    patch1=child_patches[0],
                    patch2=child_patches[1],
                    timeout=timeout_seconds,
                    dataset_dir=dataset,
                )
                write_json(output, report)
            if parent_available:
                report["parent_patch_sha256"] = sha256(parent_patch)
                report["openinspect_parent_integration"] = grader.test_solo(
                    task["repo"],
                    task["task_id"],
                    *task["feature_ids"],
                    patch=parent_patch,
                    timeout=timeout_seconds,
                    dataset_dir=dataset,
                )
                write_json(output, report)
        errors = [
            value["error"]
            for key in ["official_child_patches", "openinspect_parent_integration"]
            if (value := report.get(key)) and value.get("error")
        ]
        if errors:
            report.update(status="infrastructure_error", errors=errors)
        elif report["missing_artifacts"]:
            report["status"] = "missing_artifacts"
        else:
            # Completion describes the scoring operation, independently of correctness.
            report["status"] = "complete"
    except Exception as exc:
        report.update(status="infrastructure_error", error=f"{type(exc).__name__}: {exc}")
    except BaseException as exc:
        report.update(status="interrupted", error=type(exc).__name__, finished_at=time.time())
        write_json(output, report)
        raise
    report["finished_at"] = time.time()
    report["duration_seconds"] = report["finished_at"] - report["started_at"]
    write_json(output, report)
    return report


def prepare(task: dict, lab_root: Path) -> dict:
    _, lock, _, dataset = configuration(lab_root)
    validate_task(task, dataset)
    image = ensure_image(task, lab_root, lock)
    directory = lab_root / "task-workspaces" / task["id"]
    directory.mkdir(parents=True, exist_ok=True)
    metadata_path = directory / "prepared.json"
    if metadata_path.exists():
        cached = json.loads(metadata_path.read_text())
        inspection = command(["docker", "image", "inspect", cached["baseImage"]], check=False)
        prompts_match = len(cached["promptPaths"]) == len(task["features"]) and all(
            Path(path).exists() and sha256(Path(path)) == feature["prompt_sha256"]
            for path, feature in zip(cached["promptPaths"], task["features"], strict=True)
        )
        archive = Path(cached["workspaceArchive"])
        if (
            cached.get("sanitizationVersion", 1) == SANITIZATION_VERSION
            and cached["officialImage"]["image_id"] == image["image_id"]
            and inspection.returncode == 0
            and prompts_match
            and archive.exists()
            and sha256(archive) == cached["workspaceArchiveSha256"]
        ):
            actual_tree = command(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--read-only",
                    "--network",
                    "none",
                    "--entrypoint",
                    "git",
                    cached["baseImage"],
                    "-C",
                    "/workspace/repo",
                    "rev-parse",
                    "HEAD^{tree}",
                ]
            ).stdout.strip()
            if actual_tree != image["base_tree"]:
                raise ValueError("Prepared source tree differs from the official image")
            return cached
    container_id = command(
        [
            "docker",
            "create",
            "--name",
            "oi-cooperbench-prepare-" + uuid.uuid4().hex[:16],
            "--label",
            "openinspect.benchmark=cooperbench",
            "--network",
            "none",
            "--entrypoint",
            "/bin/sh",
            image["image_id"],
            "-c",
            f"sleep {DEFAULT_TIMEOUT_SECONDS}",
        ]
    ).stdout.strip()
    try:
        command(["docker", "start", container_id])
        actual = command(
            ["docker", "exec", container_id, "git", "-C", "/workspace/repo", "rev-parse", "HEAD"]
        ).stdout.strip()
        if actual != task["base_commit"]:
            raise ValueError(f"Official image base mismatch: {actual}")
        # Preserve exactly the originally tracked tree; ignored build/dependency caches stay.
        script = r"""set -eu
cd /workspace/repo
git status --porcelain --untracked-files=no > /tmp/base-status
test ! -s /tmp/base-status
BASE_TREE=$(git rev-parse 'HEAD^{tree}')
git ls-files -z > /tmp/base-files
git ls-tree -rz HEAD > /tmp/base-index
git archive HEAD > /tmp/agent-source.tar
rm -rf .git /patches
rm -f /usr/local/bin/runner.sh
git init -b main >/dev/null
git config user.name "OpenInspect Benchmark"
git config user.email "benchmark@openinspect.local"
GIT_LITERAL_PATHSPECS=1 git add -f --pathspec-from-file=/tmp/base-files --pathspec-file-nul
git update-index -z --index-info < /tmp/base-index
GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z git commit -qm "Benchmark initial state"
test "$(git rev-parse 'HEAD^{tree}')" = "$BASE_TREE"
test "$(git rev-list --all --count)" = 1
test -z "$(git remote)"
git rev-parse HEAD
rm -f /tmp/base-files /tmp/base-index /tmp/base-status
"""
        prepared_commit = command(
            ["docker", "exec", container_id, "sh", "-c", script]
        ).stdout.strip()
        command(
            [
                "docker",
                "cp",
                f"{container_id}:/tmp/agent-source.tar",
                str(directory / "agent-source.tar"),
            ]
        )
        command(["docker", "exec", container_id, "rm", "/tmp/agent-source.tar"])
        tag = "openinspect-cooperbench:" + task["id"].removeprefix("cooperbench-")
        clean_id = command(
            [
                "docker",
                "commit",
                "--change",
                "ENTRYPOINT []",
                "--change",
                'CMD ["/bin/sh"]',
                container_id,
                tag,
            ]
        ).stdout.strip()
        prompts = []
        for feature in task["features"]:
            dest = directory / f"feature{feature['feature_id']}.md"
            dest.write_bytes((dataset / feature["prompt_path"]).read_bytes())
            prompts.append(str(dest))
        metadata = {
            "taskId": task["id"],
            "benchmark": "cooperbench",
            "baseImage": clean_id,
            "baseImageTag": tag,
            "officialImage": image,
            "workspacePath": "/workspace/repo",
            "workspaceArchive": str(directory / "agent-source.tar"),
            "workspaceArchiveSha256": sha256(directory / "agent-source.tar"),
            "promptPaths": prompts,
            "baseCommit": prepared_commit,
            "upstreamBaseCommit": actual,
            "baseTree": image["base_tree"],
            "featureIds": task["feature_ids"],
            "setupCommand": None,
            "ready": True,
            "sanitizationVersion": SANITIZATION_VERSION,
            "sanitization": {
                "git_commits": 1,
                "git_remotes": [],
                "grader_runner_removed": True,
                "patches_directory_removed": True,
                "original_visible_tests_preserved": True,
                "note": "Deleted files remain in inaccessible Docker parent layers; do not mount Docker socket in agent sandbox.",
            },
        }
        write_json(directory / "prepared.json", metadata)
        return metadata
    finally:
        command(["docker", "rm", "-f", container_id])


def verify_agent_environment(
    task: dict, lab_root: Path, image_id: str, output: Path | None = None
) -> dict:
    """Check actual agent UID/tool access separately from root official grading."""
    _, _, _, dataset = configuration(lab_root)
    validate_task(task, dataset)
    actual_image = json.loads(command(["docker", "image", "inspect", image_id]).stdout)[0]["Id"]
    base = (
        lab_root
        / "runs/calibration/cooperbench"
        / task["id"]
        / "overlays"
        / actual_image.removeprefix("sha256:")
    )
    directory = (output or base / ("agent-" + uuid.uuid4().hex)).resolve()
    if directory == REPO_ROOT or REPO_ROOT in directory.parents:
        raise ValueError("Agent verification output must be outside the repository")
    report_path = directory / "agent-environment.json"
    report = {
        "task_id": task["id"],
        "image_id": actual_image,
        "classification": "agent_identity_and_visible_task_tooling; not official grading",
        "started_at": time.time(),
        "checks": [],
        "status": "running",
        "passed": False,
        "report_path": str(report_path),
    }
    reserve_report(report_path, report)
    container_id = None

    def check(label: str, args: list[str], *, user: bool = True) -> dict:
        prefix = ["docker", "exec"]
        if user:
            prefix += [
                "--user",
                "10001:10001",
                "--env",
                "HOME=/home/oi-agent",
                "--env",
                "XDG_CACHE_HOME=/home/oi-agent/.cache",
            ]
        started = time.monotonic()
        result = command(
            [*prefix, "--workdir", "/workspace/repo", container_id, *args],
            check=False,
        )
        item = {
            "category": label,
            "uid": 10001 if user else 0,
            "command": args,
            "returncode": result.returncode,
            "duration_seconds": time.monotonic() - started,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "passed": result.returncode == 0,
        }
        report["checks"].append(item)
        write_json(report_path, report)
        return item

    try:
        container_id = command(
            [
                "docker",
                "run",
                "-d",
                "--network",
                "none",
                "--security-opt",
                "no-new-privileges:true",
                "--cpus",
                str(DEFAULT_CPU),
                "--memory",
                f"{DEFAULT_MEMORY_GIB}g",
                "--label",
                "openinspect.benchmark=cooperbench-agent-check",
                "--entrypoint",
                "sleep",
                actual_image,
                str(DEFAULT_TIMEOUT_SECONDS),
            ]
        ).stdout.strip()
        # Invoke the real launcher once; it transfers task ownership before dropping UID.
        check("real_launcher_initialization", ["/opt/oi-tools/opencode", "--version"], user=False)
        check(
            "uid_and_no_new_privileges",
            [
                "sh",
                "-c",
                "test $(id -u) = 10001 && id && awk '/^NoNewPrivs:/ {print; if ($2 != 1) exit 1}' /proc/self/status",
            ],
        )
        files = check("visible_git_tree", ["git", "ls-files", "-z"])
        tracked = files["stdout"].split("\0")
        tests = [
            name
            for name in tracked
            if name
            and re.search(r"(^|/)([Tt]ests?|__tests__)/|_test\.go$|\.(test|spec)\.[jt]sx?$", name)
        ]
        payload = base64.b64encode(json.dumps(tests).encode()).decode()
        probe = (
            "import base64,json,os,pathlib; "
            f"paths=json.loads(base64.b64decode('{payload}')); "
            "assert paths, 'No original visible tests found'; "
            "[pathlib.Path(p).open('rb').read(1) for p in paths]; "
            "p=pathlib.Path('.oi-permission-probe'); p.write_text('probe'); p.unlink(); "
            "print(json.dumps({'readableOriginalTestFiles':len(paths),'workspaceWritable':True})); "
            "assert not os.access('/opt/oi-runtime/lib/python3.12/site-packages',os.R_OK); "
            "assert not os.access('/opt/oi-runtime/lib/node_modules',os.R_OK)"
        )
        check(
            "original_tests_workspace_and_private_runtime",
            ["/opt/oi-runtime/bin/python3.12", "-S", "-c", probe],
        )
        if task["language"] == "Python":
            package = {
                "samuelcolvin_dirty_equals_task": "dirty_equals",
                "pallets_click_task": "click",
                "pallets_jinja_task": "jinja2",
                "pillow": "PIL",
                "huggingface_datasets_task": "datasets",
                "dspy_task": "dspy",
            }.get(task["repo"])
            if package is None:
                package = next(
                    value
                    for key, value in {"pillow": "PIL", "dspy": "dspy"}.items()
                    if key in task["repo"]
                )
            check(
                "python_and_target_import",
                [
                    "python",
                    "-c",
                    f"import sys,{package}; print(sys.executable); print(sys.version); print({package}.__file__)",
                ],
            )
            check("pytest_tool", ["python", "-m", "pytest", "--version"])
            check("pip_tool", ["python", "-m", "pip", "--version"])
        elif task["language"] == "Go":
            check("go_toolchain", ["go", "version"])
            check("go_package_listing", ["go", "list", "./..."])
        else:
            check("node_toolchain", ["node", "--version"])
            check("npm_tool", ["npm", "--version"])
            check("typescript_tool", ["./node_modules/.bin/tsc", "--version"])
            check("jest_tool", ["./node_modules/.bin/jest", "--version"])
        check(
            "git_worktree_unchanged",
            ["sh", "-c", 'test -z "$(git status --porcelain --untracked-files=no)"'],
        )
        report["passed"] = all(item["passed"] for item in report["checks"])
        report["status"] = "passed" if report["passed"] else "agent_environment_failure"
    except Exception as exc:
        report.update(status="infrastructure_error", error=f"{type(exc).__name__}: {exc}")
    finally:
        if container_id:
            cleanup = command(["docker", "rm", "-f", container_id], check=False)
            report["cleanup_returncode"] = cleanup.returncode
            if cleanup.returncode:
                report.update(status="infrastructure_error", passed=False)
        report["finished_at"] = time.time()
        write_json(report_path, report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action", choices=["bootstrap", "prepare", "calibrate", "score", "pull", "verify-agent"]
    )
    parser.add_argument("--lab-root", type=Path, default=os.getenv("BENCHMARK_LAB_ROOT"))
    parser.add_argument("--task-id", action="append")
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--child-patch", action="append", type=Path)
    parser.add_argument("--parent-patch", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--skip-images", action="store_true", help="Bootstrap source/data/wheels only"
    )
    parser.add_argument(
        "--image-id", help="Optional runtime overlay for environment-equivalence calibration"
    )
    args = parser.parse_args()
    if not args.lab_root:
        parser.error("Set BENCHMARK_LAB_ROOT or --lab-root")
    lab_root = Path(args.lab_root).resolve()
    if args.action in {"score", "bootstrap"}:
        # score() persists its initial state before checking external prerequisites.
        manifest = json.loads((REPO_ROOT / "experiments/cooperbench-tasks.json").read_text())
        lock = None
    else:
        manifest, lock, _, _ = configuration(lab_root)
    tasks = [task for task in manifest["tasks"] if not args.task_id or task["id"] in args.task_id]
    if args.task_id and len(tasks) != len(set(args.task_id)):
        parser.error("Unknown task ID")
    if args.action == "score" and (len(tasks) != 1 or not args.output):
        parser.error("score requires exactly one --task-id and --output")
    if args.action == "verify-agent" and (len(tasks) != 1 or not args.image_id):
        parser.error("verify-agent requires exactly one --task-id and --image-id")
    if args.action == "calibrate" and args.output and len(tasks) != 1:
        parser.error("calibrate --output requires exactly one --task-id")
    if args.skip_images and args.action != "bootstrap":
        parser.error("--skip-images is only valid for bootstrap")
    if args.action == "bootstrap":
        print(json.dumps(bootstrap(lab_root, tasks, skip_images=args.skip_images), indent=2))
        return 0
    failed = False
    for task in tasks:
        if args.action == "prepare":
            result = prepare(task, lab_root)
        elif args.action == "pull":
            result = ensure_image(task, lab_root, lock)
        elif args.action == "calibrate":
            result = calibrate(
                task,
                lab_root,
                timeout_seconds=args.timeout_seconds,
                image_id=args.image_id,
                output=args.output,
            )
            failed |= result["status"] != "passed"
        elif args.action == "verify-agent":
            result = verify_agent_environment(task, lab_root, args.image_id, args.output)
            failed |= not result["passed"]
        else:
            result = score(
                task,
                lab_root,
                args.output,
                child_patches=args.child_patch,
                parent_patch=args.parent_patch,
                timeout_seconds=args.timeout_seconds,
                image_id=args.image_id,
            )
            failed |= result["status"] != "complete"
        print(
            json.dumps(
                {
                    "task_id": task["id"],
                    "action": args.action,
                    "status": result.get("status", "complete"),
                }
            ),
            flush=True,
        )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
