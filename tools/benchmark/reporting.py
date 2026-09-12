"""Separate protocol evidence, artifact integrity and official benchmark correctness."""

import json
import re
import shutil
import sys
from pathlib import Path

from artifacts import atomic_json
from common import ROOT, digest, node_environment, now_ms, read_json, run_command, task_id


def json_lines(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def has_final_response(text):
    match = re.search(
        r"Final response:\s*Success:\s*(?:yes|no)\s*(?:Error:[^\n]*\s*)?(?:Events:[^\n]*\s*)?Text:\s*(.+?)(?:\n\s*Tool summary:|\n\s*Recent events:|$)",
        text,
        re.DOTALL,
    )
    return bool(match and match.group(1).strip() and match.group(1).strip() != "(empty)")


def verify_trace(path):
    issues = []
    manifest = read_json(path / "manifest.json")
    hashes = read_json(path / manifest["hashesFile"])
    for item in hashes["files"]:
        target = (path / item["path"]).resolve()
        if path.resolve() not in target.parents or not target.is_file():
            issues.append(f"Missing/invalid hashed file: {item['path']}")
        elif digest(target) != item["sha256"] or target.stat().st_size != item["bytes"]:
            issues.append(f"Hash/size mismatch: {item['path']}")
    completeness = read_json(path / manifest["completenessFile"])
    for key in ["parentMismatches", "compositeEventIdDuplicates", "compositeMessageIdDuplicates"]:
        if completeness.get(key):
            issues.append(key)
    for session in completeness["sessions"]:
        if session.get("eventIdDuplicates") or session.get("messageIdDuplicates"):
            issues.append(f"Duplicate records in {session['sessionId']}")
    return {
        "status": "complete" if not issues else "incomplete",
        "issues": issues,
        "manifestSha256": digest(path / "manifest.json"),
        "filesVerified": len(hashes["files"]),
        "coverage": "API pages and file hashes verified; host sampling gaps reported separately",
    }


def runtime_evidence(path, parents, requested_model):
    runtime_sessions, host_sessions, prompts = set(), set(), []
    for source in path.glob("raw/sandbox/*.jsonl"):
        for record in json_lines(source):
            event = record.get("event", {})
            session_id = record.get("session_id") or event.get("session_id")
            if session_id not in parents:
                continue
            runtime_sessions.add(session_id)
            if event.get("event") == "prompt.start":
                prompts.append(
                    {
                        "sessionId": session_id,
                        "model": event.get("model"),
                        "reasoningEffort": event.get("reasoning_effort"),
                        "messageId": event.get("message_id"),
                    }
                )
    for source in path.glob("raw/host/*.jsonl"):
        for record in json_lines(source):
            if record.get("session_id") in parents:
                host_sessions.add(record["session_id"])
    return {
        "missingRuntimeSessions": sorted(set(parents) - runtime_sessions),
        "missingHostSessions": sorted(set(parents) - host_sessions),
        "runtimePromptStarts": prompts,
        "modelConfigurationMatched": bool(prompts)
        and {item["sessionId"] for item in prompts} == set(parents)
        and all(
            item["model"] == requested_model and item["reasoningEffort"] is None for item in prompts
        ),
        "scope": "Runtime prompt dispatch confirms model configuration; host samples are not continuous CPU/shell activity.",
    }


def protocol_evidence(directory, state, task):
    trace_path = Path(state["trace"]["path"])
    events = json_lines(trace_path / "normalized/events.jsonl")
    calls = [event for event in events if event["type"] == "tool_call"]
    results = [event for event in events if event["type"] == "tool_result"]
    root_id = state["rootSessionId"]
    parents = state["sessionTree"]
    children = [key for key, parent in parents.items() if parent == root_id]
    issues = []
    review_required = []
    original_prompt_copies = []
    child_publications = {}
    transfer_file = directory / "artifact-transfers.jsonl"
    transfers = json_lines(transfer_file) if transfer_file.exists() else []

    def output(event):
        data = event["data"]
        if data.get("status") == "completed" and not data.get("error"):
            return data.get("output", "")
        for result in results:
            payload = result["data"]
            if (
                result["sessionId"] == event["sessionId"]
                and payload.get("callId") == data.get("callId")
                and payload.get("messageId") == data.get("messageId")
                and not payload.get("error")
            ):
                return payload.get("result", "")
        return ""

    def publication_call(event, session_id, sha256):
        command = event["data"].get("args", {}).get("command", "")
        return (
            event["sessionId"] == session_id
            and event["data"].get("tool") == "bash"
            and re.search(r"\boi-bench\s+publish\b", command)
            and not re.search(r"(?:^|\s)(?:--help|-h)(?:\s|$)", command)
            and session_id in output(event)
            and sha256 in output(event)
        )

    if len(children) != 2 or len(parents) != 3:
        issues.append("Expected one parent and exactly two direct children")
    if any(event["data"].get("tool", "").lower() == "task" for event in calls):
        issues.append("In-process Task delegation observed")
    spawned = []
    parent_calls = sorted(
        [event for event in calls if event["sessionId"] == root_id],
        key=lambda event: event["createdAt"],
    )
    for event in parent_calls:
        if event["data"].get("tool") == "spawn-child":
            match = re.search(r"Child ID:\s*([A-Za-z0-9_-]+)", output(event))
            if match:
                spawned.append(
                    {
                        "sessionId": match.group(1),
                        "atMs": event["createdAt"],
                        "args": event["data"].get("args", {}),
                    }
                )
    if len(spawned) != 2 or {item["sessionId"] for item in spawned} != set(children):
        issues.append("Missing successful spawn-child tool evidence")
    waits = [event for event in parent_calls if event["data"].get("tool") == "get-child-status"]
    if (
        len(spawned) == 2
        and waits
        and min(event["createdAt"] for event in waits) < spawned[1]["atMs"]
    ):
        issues.append("Parent waited for status before creating both children")
    for child_id in children:
        if not any(
            event["data"].get("args", {}).get("childId") == child_id
            and event["data"].get("args", {}).get("includeResponse") is True
            and f"Child: {child_id}" in output(event)
            and has_final_response(output(event))
            for event in waits
        ):
            issues.append(f"No final child response retrieval: {child_id}")
        publication = directory / "artifacts" / child_id / "published.json"
        if not publication.exists():
            issues.append(f"Child did not publish code: {child_id}")
        else:
            try:
                latest_patch(directory, child_id)
                child_publications[child_id] = read_json(publication)["sha256"]
                if not any(
                    publication_call(event, child_id, child_publications[child_id])
                    for event in calls
                ):
                    issues.append(f"No successful child publication tool evidence: {child_id}")
            except (OSError, ValueError, KeyError) as error:
                issues.append(f"Invalid child publication {child_id}: {error}")
        fetched = False
        expected_sha256 = child_publications.get(child_id)
        for event in parent_calls:
            command = event["data"].get("args", {}).get("command", "")
            if (
                event["data"].get("tool") == "bash"
                and expected_sha256
                and re.search(
                    r"\boi-bench\s+fetch\s+"
                    + re.escape(child_id)
                    + r"\s+"
                    + expected_sha256
                    + r"\b",
                    command,
                )
                and output(event)
            ):
                fetched = True
        if not fetched:
            issues.append(f"No successful parent patch fetch observed: {child_id}")
        if not any(
            record["recipientSessionId"] == root_id
            and record["sourceSessionId"] == child_id
            and expected_sha256
            and record["sha256"] == expected_sha256
            and (directory / "artifacts" / child_id / f"{record['sha256']}.patch").is_file()
            and digest(directory / "artifacts" / child_id / f"{record['sha256']}.patch")
            == expected_sha256
            and (directory / "artifacts" / child_id / f"{record['sha256']}.patch").stat().st_size
            == record["bytes"]
            for record in transfers
        ):
            issues.append(f"No artifact server delivery evidence: {child_id}")
    parent_publication = directory / "artifacts" / root_id / "published.json"
    parent_publication_sha256 = None
    if not parent_publication.exists():
        issues.append("Parent did not publish its integrated code")
    else:
        try:
            published_patch = latest_patch(directory, root_id)
            parent_publication_sha256 = read_json(parent_publication)["sha256"]
            checkpoint_path = directory / "artifacts" / root_id / "checkpoint.json"
            final_patch = None
            if checkpoint_path.exists():
                checkpoint = read_json(checkpoint_path)
                final_patch = checkpoint_path.parent / checkpoint["file"]
                if digest(final_patch) != checkpoint["sha256"]:
                    raise ValueError("Parent final checkpoint hash mismatch")
            else:
                issues.append("Missing final parent checkpoint")
            coverage_path = directory / "artifact-coverage.json"
            coverage = read_json(coverage_path) if coverage_path.exists() else {}
            if coverage.get("sessions", {}).get(root_id, {}).get("finalCapture") is not True:
                issues.append("Parent checkpoint has no successful final capture evidence")
            if (
                published_patch is None
                or final_patch is None
                or digest(final_patch) != digest(published_patch)
            ):
                issues.append("Parent publication does not match its final captured code")
            if not any(
                publication_call(event, root_id, parent_publication_sha256)
                for event in parent_calls
            ):
                issues.append("No successful parent publication tool evidence for its final patch")
        except (OSError, ValueError, KeyError) as error:
            issues.append(f"Invalid parent publication: {error}")
    successful_parent_messages = {
        event["data"].get("messageId", event.get("messageId"))
        for event in events
        if event["sessionId"] == root_id
        and event["type"] == "execution_complete"
        and event["data"].get("success") is True
        and event["data"].get("messageId", event.get("messageId"))
    }
    parent_responses = {}
    for event in sorted(events, key=lambda item: item["createdAt"]):
        message_id = event["data"].get("messageId", event.get("messageId"))
        if (
            event["sessionId"] == root_id
            and event["type"] == "token"
            and message_id in successful_parent_messages
        ):
            parent_responses[message_id] = parent_responses.get(message_id, "") + event["data"].get(
                "content", ""
            )
    if not any(text.strip() for text in parent_responses.values()):
        issues.append("No nonempty successful parent final response")
    if len(child_publications) != 2 or not any(
        all(child_id in text and sha256 in text for child_id, sha256 in child_publications.items())
        for text in parent_responses.values()
    ):
        issues.append(
            "Parent final response did not retain both child session and patch identities"
        )
    containers = (
        read_json(directory / "containers.json") if (directory / "containers.json").exists() else {}
    )
    identities = {item["sessionId"] for item in containers.values()}
    if not set(parents).issubset(identities) or len(containers) != len(parents):
        issues.append("Missing/distinct container identity evidence")
    for session_id in parents:
        if not any(
            event["sessionId"] == session_id
            and event["type"] == "ready"
            and event["data"].get("sandboxBackend") == "opensandbox"
            for event in events
        ):
            issues.append(f"Missing OpenSandbox ready: {session_id}")
    if task["benchmark"] == "cooperbench" and len(spawned) == 2:
        for index, spawn in enumerate(spawned):
            original = (directory / f"prompt.original.{index + 1}.txt").read_bytes().decode()
            verbatim = original in spawn["args"].get("prompt", "")
            original_prompt_copies.append(
                {
                    "childSessionId": spawn["sessionId"],
                    "featureIndex": index + 1,
                    "verbatim": verbatim,
                    "semanticCompleteness": "original_text_present"
                    if verbatim
                    else "not_automatically_assessed",
                }
            )
            if not verbatim:
                review_required.append(
                    f"Child {index + 1} prompt is not a verbatim copy; review requirement completeness"
                )
    score = state.get("benchmarkCorrectness")
    score_link = {"status": "not_applicable"}
    if task["benchmark"] == "cooperbench":
        score_link = {"status": "pending"}
        if isinstance(score, dict) and score.get("status") == "not_scored":
            score_link = {"status": "not_scored", "reason": "disabled_by_config"}
        if isinstance(score, dict) and score.get("status") in ["complete", "missing_artifacts"]:
            expected = [child_publications.get(item["sessionId"]) for item in spawned]
            actual = score.get("child_patch_sha256")
            matched = len(expected) == 2 and all(expected) and actual == expected
            score_link = {
                "status": "matched" if matched else "unmatched",
                "publishedChildPatchSha256": expected,
                "scoredChildPatchSha256": actual,
            }
            if not matched:
                issues.append("Official child scoring does not reference both published revisions")
    report = {
        "validatorVersion": 4,
        "status": "failed" if issues else "review_required" if review_required else "passed",
        "issues": issues,
        "reviewRequired": review_required,
        "originalPromptCopies": original_prompt_copies,
        "parentPublicationSha256": parent_publication_sha256,
        "childPublicationSha256": child_publications,
        "officialChildScoring": score_link,
        "spawnOrder": spawned,
        "childSessionIds": children,
        "protocol": "OpenInspect parent/two-child v1",
        "scope": "Automated topology, tool, artifact and response checks. Substantive division of work, integration/validation quality, upstream-access restrictions and rewritten requirement completeness need independent review; verbatim mismatch alone does not establish missing requirements.",
        "concurrencyMeasurement": "Use trace analyzer's action/setup intervals; no shell overlap inferred from messages",
    }
    atomic_json(directory / "protocol.json", report)
    return report


def latest_patch(directory, session_id, preferred="published"):
    for source in [preferred, "checkpoint" if preferred == "published" else "published"]:
        metadata_file = directory / "artifacts" / session_id / f"{source}.json"
        if metadata_file.exists():
            metadata = read_json(metadata_file)
            patch = metadata_file.parent / metadata["file"]
            if digest(patch) != metadata["sha256"]:
                raise ValueError("Code artifact hash mismatch")
            return patch
    return None


def scoring_generation(directory):
    """Only a separately committed completion record makes a grading attempt reusable."""
    generations = sorted(directory.glob("scoring-*"))
    if generations:
        current = generations[-1]
        marker = current / "completion.json"
        score = current / "score.json"
        if (
            marker.exists()
            and score.exists()
            and read_json(marker).get("scoreSha256") == digest(score)
        ):
            return current, True
    target = directory / f"scoring-{len(generations) + 1:03d}"
    target.mkdir(exist_ok=False)
    return target, False


def assess_attempt(lab_root, directory, task, state, *, official_scoring=False):
    # A policy change must use a separate batch, never discard an existing grading attempt.
    if not official_scoring:
        if list(directory.glob("scoring-*")) or state.get("scoringPath"):
            raise ValueError("Existing grading evidence requires its original scoring policy")
        state["benchmarkCorrectness"] = {
            "status": "not_scored",
            "reason": "disabled_by_config",
            "officialScoring": False,
        }
        state["scoring"] = {"status": "skipped", "reason": "disabled_by_config"}
    if state.get("trace", {}).get("path"):
        state["trace"].update(verify_trace(Path(state["trace"]["path"])))
        protocol = protocol_evidence(directory, state, task)
        state["childProtocol"] = protocol["status"]
        index = read_json(Path(state["trace"]["path"]) / "raw/session-index.json")
        state["modelObserved"] = [
            {
                "sessionId": item["id"],
                "model": item.get("model"),
                "reasoningEffort": item.get("reasoningEffort"),
                "totalCost": item.get("totalCost"),
            }
            for item in index["sessions"]
        ]
        state["modelConfigurationConsistent"] = all(
            item["model"] == state.get("modelRequested") and item["reasoningEffort"] is None
            for item in state["modelObserved"]
        )
        state["runtimeEvidence"] = runtime_evidence(
            Path(state["trace"]["path"]), state["sessionTree"], state.get("modelRequested")
        )
    else:
        protocol = {"spawnOrder": []}
        state["childProtocol"] = "unverified"
    if not official_scoring:
        atomic_json(directory / "attempt.json", state)
        return state
    scoring, completed = scoring_generation(directory)
    score_file = scoring / "score.json"
    if completed:
        state["benchmarkCorrectness"] = read_json(score_file)
        state["scoring"] = {"status": "complete"}
        state["scoringPath"] = str(scoring)
        return state
    parent = latest_patch(directory, state["rootSessionId"], preferred="checkpoint")
    if task["benchmark"] == "featurebench":
        if parent is None:
            parent = scoring / "empty.patch"
            parent.write_bytes(b"")
        python = lab_root / "cache/featurebench-venv/bin/python"
        command = [
            str(python),
            str(ROOT / "tools/benchmark/featurebench.py"),
            "score",
            "--lab-root",
            str(lab_root),
            "--task-id",
            task_id(task),
            "--output",
            str(scoring),
            "--prediction-patch",
            str(parent),
        ]
    else:
        command = [
            sys.executable,
            str(ROOT / "tools/benchmark/cooperbench.py"),
            "score",
            "--lab-root",
            str(lab_root),
            "--task-id",
            task_id(task),
            "--output",
            str(scoring),
        ]
        if parent:
            command.extend(["--parent-patch", str(parent)])
        if len(protocol["spawnOrder"]) == 2:
            for index, spawn in enumerate(protocol["spawnOrder"]):
                patch = latest_patch(directory, spawn["sessionId"])
                if patch is None:
                    patch = scoring / f"missing-child-{index + 1}.patch"
                    patch.write_bytes(b"")
                command.extend(["--child-patch", str(patch)])
    command_failed = False
    try:
        run_command(command, log=directory / "score.log")
    except RuntimeError as error:
        command_failed = True
        if not score_file.exists():
            atomic_json(score_file, {"status": "infrastructure_failed", "error": str(error)})
    state["benchmarkCorrectness"] = read_json(score_file)
    state["scoringPath"] = str(scoring)
    atomic_json(directory / "attempt.json", state)
    terminal_status = state["benchmarkCorrectness"].get("status") in [
        "scored",
        "complete",
        "missing_artifacts",
    ]
    if not terminal_status or (
        command_failed and state["benchmarkCorrectness"].get("status") != "missing_artifacts"
    ):
        state["scoring"] = {"status": "failed", "reason": "grading_incomplete"}
        atomic_json(directory / "attempt.json", state)
        raise RuntimeError(
            "Grading incomplete; resume will retain this scoring attempt and start a new grading generation without rerunning the model"
        )
    atomic_json(scoring / "completion.json", {"scoreSha256": digest(score_file)})
    state["scoring"] = {"status": "complete"}
    if state.get("trace", {}).get("path"):
        state["childProtocol"] = protocol_evidence(directory, state, task)["status"]
    return state


def attempt_state(run_directory, batch, plan):
    inherited = batch.get("inheritedAttempts", {}).get(plan["attemptId"])
    if inherited:
        path = Path(inherited["path"])
        if digest(path) != inherited["sha256"]:
            raise ValueError(f"Inherited attempt changed: {path}")
        return {**read_json(path), "evidencePath": str(path.parent), "inherited": True}
    path = run_directory / "attempts" / plan["attemptId"] / "attempt.json"
    return read_json(path) if path.exists() else {**plan, "phase": "not_started"}


def batch_report(run_directory):
    batch = read_json(run_directory / "run.json")
    attempts = []
    for plan in batch["attempts"]:
        attempts.append(attempt_state(run_directory, batch, plan))
    counts = {}
    outcomes = {
        "featurebench": {"planned": 0, "resolved": 0, "unscored": 0},
        "cooperbench": {
            "planned": 0,
            "officialChildrenPassed": 0,
            "parentIntegrationPassed": 0,
            "unscored": 0,
        },
    }
    selected = {task_id(task): task for task in read_json(run_directory / "tasks.json")}
    scoring_counts = {"scored": 0, "skippedByConfig": 0, "failed": 0, "pending": 0}
    exceptions = []
    for attempt in attempts:
        phase = attempt.get("phase", "not_started")
        counts[phase] = counts.get(phase, 0) + 1
        benchmark = selected[attempt["taskId"]]["benchmark"]
        outcome = outcomes[benchmark]
        outcome["planned"] += 1
        score = attempt.get("benchmarkCorrectness")
        score = score if isinstance(score, dict) else {}
        score_status = score.get("status")
        if score_status == "not_scored":
            scoring_counts["skippedByConfig"] += 1
        elif score_status in ["scored", "complete", "missing_artifacts"]:
            scoring_counts["scored"] += 1
        elif score_status and score_status != "pending":
            scoring_counts["failed"] += 1
        else:
            scoring_counts["pending"] += 1
        evidence = attempt.get(
            "evidencePath", str(run_directory / "attempts" / attempt["attemptId"])
        )
        for dimension, value in [
            ("modelExecution", attempt.get("modelExecution")),
            ("childProtocol", attempt.get("childProtocol")),
            ("trace", attempt.get("trace", {}).get("status")),
            ("analysis", attempt.get("analysis", {}).get("status")),
            ("cleanup", attempt.get("cleanup")),
            ("artifactCoverage", attempt.get("artifactCoverage")),
        ]:
            if value and value not in ["completed", "complete", "passed", "pending", "exported"]:
                exceptions.append(
                    {
                        "attemptId": attempt["attemptId"],
                        "dimension": dimension,
                        "status": value,
                        "evidencePath": evidence,
                    }
                )
        if attempt.get("infrastructure") or attempt.get("scoring", {}).get("status") == "failed":
            exceptions.append(
                {
                    "attemptId": attempt["attemptId"],
                    "dimension": "infrastructure",
                    "details": attempt.get("infrastructure", []),
                    "evidencePath": evidence,
                }
            )
        if attempt.get("readDiagnostics", {}).get("failures", 0):
            exceptions.append(
                {
                    "attemptId": attempt["attemptId"],
                    "dimension": "observation_reads",
                    "details": attempt["readDiagnostics"],
                    "evidencePath": evidence,
                }
            )
        if benchmark == "featurebench":
            outcome["resolved"] += score.get("resolved") is True
        else:
            outcome["officialChildrenPassed"] += (score.get("official_child_patches") or {}).get(
                "both_passed"
            ) is True
            outcome["parentIntegrationPassed"] += (
                score.get("openinspect_parent_integration") or {}
            ).get("both_passed") is True
        outcome["unscored"] += score.get("status") not in [
            "scored",
            "complete",
            "missing_artifacts",
        ]
    report = {
        "runId": batch["runId"],
        "status": batch.get("status", "unknown"),
        "updatedAtMs": now_ms(),
        "continuation": batch.get("continuation"),
        "supplement": batch.get("supplement"),
        "scoringCounts": scoring_counts,
        "plannedAttempts": len(batch["attempts"]),
        "attempts": attempts,
        "phaseCounts": counts,
        "benchmarkOutcomes": outcomes,
        "traceBatchAnalysis": batch.get("traceBatchAnalysis"),
        "aggregation": "All planned attempts retained. Task/attempt IDs define repetitions; no best-attempt selection.",
        "limitations": [
            "Parent integration differs from CooperBench peer protocol",
            "Wall-clock budget enforced; token/cost cap not enforced",
            "Sampled host memory peak is not an exact lifetime peak",
            "Exact repeated actions do not establish semantic redundancy",
        ],
    }
    atomic_json(run_directory / "report.json", report)
    atomic_json(
        run_directory / "exceptions.json",
        {
            "runId": batch["runId"],
            "updatedAtMs": report["updatedAtMs"],
            "blocked": batch.get("blocked"),
            "items": exceptions,
        },
    )
    atomic_json(
        run_directory / "progress.json",
        {
            "runId": batch["runId"],
            "status": report["status"],
            "updatedAtMs": report["updatedAtMs"],
            "plannedAttempts": len(attempts),
            "phaseCounts": counts,
            "scoringCounts": scoring_counts,
            "current": [
                {
                    "attemptId": a["attemptId"],
                    "phase": a["phase"],
                    "lastObservedAtMs": a.get("lastObservedAtMs"),
                }
                for a in attempts
                if a["phase"] not in ["done", "not_started"]
            ],
            "nextAttemptId": next(
                (a["attemptId"] for a in attempts if a["phase"] == "not_started"), None
            ),
            "blocked": batch.get("blocked"),
            "exceptionCount": len(exceptions),
        },
    )
    lines = [
        f"# Benchmark run {batch['runId']}",
        "",
        f"Planned attempts: {len(attempts)}. All attempts remain in the denominator.",
        "",
        f"Status: {report['status']}. Scoring: {json.dumps(scoring_counts)}.",
        "Skipped by configuration is not a scoring failure or an incorrect solution.",
        "Historical scores remain in report.json; behavior, evidence and efficiency are the primary observations.",
        "",
        "| Task | Attempt | Phase | Model | Child protocol | Scoring | Trace | Cleanup |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for attempt in attempts:
        trace = attempt.get("trace", {}).get("status", "pending")
        lines.append(
            f"| {attempt['taskId']} | {attempt['attemptId']} | {attempt['phase']} | {attempt.get('modelExecution', 'pending')} | {attempt.get('childProtocol', 'pending')} | {(attempt.get('benchmarkCorrectness') if isinstance(attempt.get('benchmarkCorrectness'), dict) else {}).get('status', 'pending')} | {trace} | {attempt.get('cleanup', 'pending')} |"
        )
    (run_directory / "report.md").write_text("\n".join(lines) + "\n")
    return report


def analyze_batch(run_directory, profile):
    """Include one final trace per attempt; resumed export generations are not extra trials."""
    report = batch_report(run_directory)
    generation = len(list(run_directory.glob("trace-batch-*"))) + 1
    target = run_directory / f"trace-batch-{generation:03d}"
    collection = target / "collection"
    collection.mkdir(parents=True)
    inputs = []
    for attempt in report["attempts"]:
        source = attempt.get("trace", {}).get("path")
        if source:
            shutil.copytree(source, collection / attempt["attemptId"])
            inputs.append({"attemptId": attempt["attemptId"], "tracePath": source})
    atomic_json(
        target / "inputs.json", {"traces": inputs, "plannedAttempts": report["plannedAttempts"]}
    )
    run_command(
        [
            "node",
            "tools/openinspect-trace-analysis/batch-cli.mjs",
            str(collection),
            "--profile",
            profile,
            "--out",
            str(target / "analysis"),
            "--cache",
            str(run_directory.parent.parent / "cache/trace-analysis"),
        ],
        env=node_environment(),
        log=target / "analysis.log",
    )
    return str(target / "analysis")
