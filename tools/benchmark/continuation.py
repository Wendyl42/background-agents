"""Versioned continuation of a paused batch without rewriting its results or frozen inputs."""

import fcntl
import shutil
import tempfile
from pathlib import Path

from artifacts import atomic_json
from common import ROOT, digest, lock, now_ms, read_json, run_command, safe_id, tasks
from reporting import batch_report


def implementation_hashes():
    return {
        str(p.relative_to(ROOT)): digest(p) for p in sorted((ROOT / "tools/benchmark").glob("*.py"))
    }


def record_implementation(directory, batch):
    batch.update(
        implementationVersion=2,
        openinspectCommit=run_command(["git", "rev-parse", "HEAD"]).decode().strip(),
        workingTreeStatus=run_command(["git", "status", "--short"]).decode(),
        adapterHashes=implementation_hashes(),
    )
    patch = directory / "working-tree.patch"
    patch.write_bytes(run_command(["git", "diff", "--binary", "HEAD"]))
    batch["workingTreePatchSha256"] = digest(patch)
    source = directory / "adapter-source"
    source.mkdir()
    for name in batch["adapterHashes"]:
        shutil.copy2(ROOT / name, source / Path(name).name)


def validate_implementation(directory, batch):
    if batch.get("implementationVersion") != 2 or not batch.get("adapterHashes"):
        raise ValueError(
            "Legacy batch requires prepare-continuation; its scoring policy and evidence must be preserved"
        )
    if batch["adapterHashes"]:
        if batch["adapterHashes"] != implementation_hashes():
            raise ValueError(
                "Runner source changed; create a versioned continuation before resuming"
            )
        for name, expected in batch["adapterHashes"].items():
            if digest(directory / "adapter-source" / Path(name).name) != expected:
                raise ValueError("Saved runner snapshot changed")
    for item in batch.get("inheritedAttempts", {}).values():
        if digest(item["path"]) != item["sha256"]:
            raise ValueError("Inherited attempt changed")
    if batch.get("supplement"):
        source = directory.parent / safe_id(batch["supplement"]["sourceRunId"]) / "run.json"
        if digest(source) != batch["supplement"]["sourceRunSha256"]:
            raise ValueError("Supplement source batch changed")
        for plan in batch["attempts"]:
            reference = plan["retryOf"]
            if digest(reference["path"]) != reference["sha256"]:
                raise ValueError("Supplement original attempt changed")
    if batch.get("continuation"):
        manifest = directory / "source-evidence.json"
        if digest(manifest) != batch["continuation"]["evidenceManifestSha256"]:
            raise ValueError("Source evidence manifest changed")
        for path, expected in read_json(manifest).items():
            if digest(path) != expected:
                raise ValueError(f"Original batch evidence changed: {path}")


def prepare_continuation(lab_root, config, config_path, source_id, run_id):
    from cli import require_freeze, suite_lock_path

    source_id, run_id = safe_id(source_id), safe_id(run_id)
    if source_id == run_id:
        raise ValueError("Continuation must use a new run ID")
    source = lab_root / "runs" / source_id
    target = lab_root / "runs" / run_id
    # Acquire the source lock without changing its historical owner record.
    with lock(lab_root / "runs/coordinator.lock"), (source / "batch.lock").open("rb") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if target.exists():
            existing = read_json(target / "run.json")
            if existing.get("continuation", {}).get("sourceRunId") != source_id or existing[
                "configSha256"
            ] != digest(config_path):
                raise ValueError("Existing continuation has different provenance")
            validate_implementation(target, existing)
            active = read_json(lab_root / "runs/active.json")["runId"]
            if active not in [source_id, run_id]:
                raise ValueError(f"Another batch is active: {active}")
            atomic_json(lab_root / "runs/active.json", {"runId": run_id, "sourceRunId": source_id})
            return existing
        active = read_json(lab_root / "runs/active.json")["runId"]
        if active != source_id:
            raise ValueError(f"Active batch is {active}; do not fork another unfinished batch")
        old = read_json(source / "run.json")
        if old.get("status") not in ["interrupted", "blocked"]:
            raise ValueError("Continuation requires an explicitly paused or blocked batch")
        old_config_path = source / "config.json"
        old_config = read_json(old_config_path)
        if digest(old_config_path) != old["configSha256"]:
            raise ValueError("Original batch config changed")
        changed = {k for k in set(config) | set(old_config) if config.get(k) != old_config.get(k)}
        if changed - {"suite", "officialScoring"} or config["suite"] == old_config["suite"]:
            raise ValueError("Continuation may only change suite version and officialScoring")
        freeze = require_freeze(lab_root, old_config, old_config_path)
        if read_json(source / "suite-lock.json") != freeze:
            raise ValueError("Original batch suite lock differs from frozen suite")
        selected = read_json(source / "tasks.json")
        if selected != tasks(config):
            raise ValueError("Continuation requires the original full task plan")
        inherited = dict(old.get("inheritedAttempts", {}))
        for plan in old["attempts"]:
            if plan["attemptId"] in inherited:
                reference = inherited[plan["attemptId"]]
                if digest(reference["path"]) != reference["sha256"]:
                    raise ValueError("Inherited attempt changed")
                continue
            path = source / "attempts" / plan["attemptId"] / "attempt.json"
            if not path.exists():
                if path.parent.exists():
                    raise ValueError(
                        "Unrecorded attempt files require recovery before continuation"
                    )
                continue
            state = read_json(path)
            if any(state.get(k) != v for k, v in plan.items()):
                raise ValueError("Original attempt identity differs from plan")
            if (
                state["phase"] != "done"
                or state.get("cleanup") != "complete"
                or state.get("trace", {}).get("status") != "complete"
            ):
                raise ValueError("Finish original attempt evidence/cleanup before continuation")
            inherited[plan["attemptId"]] = {"path": str(path), "sha256": digest(path)}
        if len(inherited) == len(old["attempts"]):
            raise ValueError("No unstarted attempts remain")
        new_freeze = {
            **freeze,
            "suite": config["suite"],
            "frozenAtMs": now_ms(),
            "configSha256": digest(config_path),
            "derivedFrom": {
                "suite": old_config["suite"],
                "sha256": digest(suite_lock_path(old_config)),
                "reason": "Versioned continuation; original task and environment evidence reused",
            },
        }
        lock_path = suite_lock_path(config)
        if lock_path.exists():
            recorded = read_json(lock_path)
            if {k: v for k, v in recorded.items() if k != "frozenAtMs"} != {
                k: v for k, v in new_freeze.items() if k != "frozenAtMs"
            }:
                raise ValueError("New suite lock already exists with different inputs")
            new_freeze = recorded
        else:
            atomic_json(lock_path, new_freeze)
        # Hash every original file, including raw logs. No original file is copied over or edited.
        source_evidence = {}
        if old.get("continuation"):
            previous_manifest = source / "source-evidence.json"
            if digest(previous_manifest) != old["continuation"]["evidenceManifestSha256"]:
                raise ValueError("Previous source manifest changed")
            source_evidence.update(read_json(previous_manifest))
            if any(digest(p) != h for p, h in source_evidence.items()):
                raise ValueError("Earlier source evidence changed")
        source_evidence.update(
            {str(p): digest(p) for p in sorted(source.rglob("*")) if p.is_file()}
        )
        final_target = target
        target = Path(tempfile.mkdtemp(prefix=f".preparing-{run_id}-", dir=target.parent))
        atomic_json(target / "source-evidence.json", source_evidence)
        provenance = {
            "sourceRunId": source_id,
            "sourceRunSha256": digest(source / "run.json"),
            "sourceConfigSha256": old["configSha256"],
            "sourceSuiteLockSha256": digest(source / "suite-lock.json"),
            "evidenceManifestSha256": digest(target / "source-evidence.json"),
            "inheritedAttemptIds": list(inherited),
            "remainingAttemptIds": [
                p["attemptId"] for p in old["attempts"] if p["attemptId"] not in inherited
            ],
            "policy": "Original results stay immutable, including user interruption; no model retries",
        }
        batch = {
            "schemaVersion": 2,
            "runId": run_id,
            "createdAtMs": now_ms(),
            "status": "allocated",
            "configSha256": digest(config_path),
            "attempts": old["attempts"],
            "inheritedAttempts": inherited,
            "continuation": provenance,
        }
        atomic_json(target / "tasks.json", selected)
        shutil.copy2(config_path, target / "config.json")
        atomic_json(target / "suite-lock.json", new_freeze)
        shutil.copytree(source / "benchmark-locks", target / "benchmark-locks")
        record_implementation(target, batch)
        atomic_json(target / "run.json", batch)
        target.rename(final_target)
        target = final_target
        batch_report(target)
        atomic_json(lab_root / "runs/active.json", {"runId": run_id, "sourceRunId": source_id})
        return batch
