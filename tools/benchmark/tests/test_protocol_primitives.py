import base64
import hashlib
import json
import subprocess
import threading
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

import pytest
from api import Client, signature_headers
from artifacts import atomic_json, make_server, snapshot, store_patch
from common import ROOT, external_root, lock
from reporting import has_final_response, scoring_generation
from runner import ensure_submission, prepare_prompt, validate_saved_prompt


def test_frozen_suite_rejects_evaluator_lock_drift_before_execution(tmp_path, monkeypatch):
    import cli
    from common import digest

    monkeypatch.setattr(cli, "ROOT", tmp_path)
    experiments = tmp_path / "experiments"
    experiments.mkdir()
    config_path = experiments / "fixture.json"
    config = {"suite": "fixture", "appendix": "appendix.txt"}
    atomic_json(config_path, config)
    (tmp_path / "appendix.txt").write_text("fixed child-session protocol")
    evaluator_lock = experiments / "featurebench-lock.json"
    atomic_json(evaluator_lock, {"source": {"gitCommit": "original-version"}})
    atomic_json(
        experiments / "fixture.lock.json",
        {
            "configSha256": digest(config_path),
            "appendixSha256": digest(tmp_path / "appendix.txt"),
            "manifestHashes": {},
            "benchmarkLockHashes": {"experiments/featurebench-lock.json": digest(evaluator_lock)},
            "tasks": [],
        },
    )
    cli.require_freeze(tmp_path / "lab", config, config_path)
    atomic_json(evaluator_lock, {"source": {"gitCommit": "changed-version"}})
    with pytest.raises(ValueError, match="source/data/evaluator lock changed"):
        cli.require_freeze(tmp_path / "lab", config, config_path)


def test_calibration_selection_uses_immutable_generations_instead_of_latest_alias(tmp_path):
    from cli import calibration_files
    from common import digest

    task = {"id": "task-one", "benchmark": "cooperbench"}
    base = tmp_path / "runs/calibration/cooperbench/task-one"
    official = base / "attempt-one/calibration.json"
    overlay = base / "overlays/current/attempt-one/calibration.json"
    for path in [official, overlay]:
        value = {"passed": True, "attempt_directory": str(path.parent)}
        atomic_json(path, value)
        atomic_json(path.parent.parent / "calibration.json", value)
    assert calibration_files(tmp_path, task, {"imageId": "sha256:current"}) == (
        official,
        overlay,
    )
    frozen_hash = digest(official)
    newer = base / "attempt-two/calibration.json"
    value = {"passed": False, "attempt_directory": str(newer.parent)}
    atomic_json(newer, value)
    atomic_json(base / "calibration.json", value)
    assert calibration_files(tmp_path, task, {})[0] == newer
    assert digest(official) == frozen_hash
    custom_overlay = base / "custom-output/calibration.json"
    atomic_json(
        custom_overlay,
        {
            "passed": True,
            "attempt_directory": str(custom_overlay.parent),
            "environment_kind": "runtime_overlay",
        },
    )
    assert calibration_files(tmp_path, task, {}) == (newer, custom_overlay)


def test_cooper_agent_verification_preserves_reports_and_requested_output(tmp_path, monkeypatch):
    import cooperbench

    task = {"id": "task-one", "language": "Go"}
    monkeypatch.setattr(cooperbench, "configuration", lambda _: ({}, {}, None, None))
    monkeypatch.setattr(cooperbench, "validate_task", lambda *_: None)
    calls = []

    def command(args, **kwargs):
        calls.append(args)
        stdout = '[{"Id":"sha256:current"}]' if args[:3] == ["docker", "image", "inspect"] else ""
        if args[:2] == ["docker", "run"]:
            stdout = "container-one"
        return subprocess.CompletedProcess(args, 0, stdout, "")

    monkeypatch.setattr(cooperbench, "command", command)
    base = tmp_path / "runs/calibration/cooperbench/task-one/overlays/current"
    legacy = base / "agent-environment.json"
    atomic_json(legacy, {"evidence": "previously frozen report"})
    original = legacy.read_bytes()
    requested = tmp_path / "requested-generation"
    result = cooperbench.verify_agent_environment(task, tmp_path, "sha256:current", requested)
    report_path = requested / "agent-environment.json"
    assert result["passed"] and result["cleanup_returncode"] == 0
    assert json.loads(report_path.read_text()) == result
    assert legacy.read_bytes() == original
    docker_runs = sum(args[:2] == ["docker", "run"] for args in calls)
    with pytest.raises(FileExistsError, match="Preserve the existing report"):
        cooperbench.verify_agent_environment(task, tmp_path, "sha256:current", requested)
    assert sum(args[:2] == ["docker", "run"] for args in calls) == docker_runs
    assert json.loads(report_path.read_text()) == result
    default = cooperbench.verify_agent_environment(task, tmp_path, "sha256:current")
    assert default["report_path"] != str(legacy)
    assert legacy.read_bytes() == original


def test_agent_environment_gate_rejects_stale_image_preparation_and_failed_cleanup(tmp_path):
    from cli import agent_environment_file, validate_agent_environment

    task = {"taskId": "feature", "benchmark": "featurebench"}
    runtime = {"imageId": "sha256:current", "preparedSha256": "prepared-current"}
    path = (
        tmp_path / "runs/calibration/featurebench/feature/overlays/current/agent-environment.json"
    )
    report = {
        "taskId": "feature",
        "preparedImage": "sha256:old",
        "preparedSha256": "prepared-current",
        "passed": True,
        "cleanup": {"status": "removed"},
    }
    atomic_json(path, report)
    assert agent_environment_file(tmp_path, task, runtime) is None
    with pytest.raises(ValueError, match="must pass"):
        validate_agent_environment(None, task, runtime)
    report["preparedImage"] = runtime["imageId"]
    report["preparedSha256"] = "prepared-old"
    atomic_json(path, report)
    with pytest.raises(ValueError, match="different prepared"):
        validate_agent_environment(path, task, runtime)
    report["preparedSha256"] = runtime["preparedSha256"]
    report["cleanup"]["status"] = "failed"
    atomic_json(path, report)
    with pytest.raises(ValueError, match="cleanup"):
        validate_agent_environment(path, task, runtime)
    report["cleanup"]["status"] = "removed"
    atomic_json(path, report)
    assert agent_environment_file(tmp_path, task, runtime) == path
    validate_agent_environment(path, task, runtime)


def test_resume_retries_failed_trace_export_without_resubmitting_model(tmp_path, monkeypatch):
    import cli
    from common import digest

    config = {"suite": "trace-recovery", "traceProfile": "test"}
    config_path = tmp_path / "config.json"
    atomic_json(config_path, config)
    directory = tmp_path / "runs/trace-recovery"
    task = {"taskId": "task-one", "benchmark": "featurebench"}
    plan = {"taskId": "task-one", "attemptId": "001"}
    atomic_json(
        directory / "run.json",
        {
            "runId": "trace-recovery",
            "attempts": [plan],
            "configSha256": digest(config_path),
        },
    )
    atomic_json(directory / "tasks.json", [task])
    state_path = directory / "attempts/001/attempt.json"
    atomic_json(
        state_path,
        {
            **plan,
            "phase": "collected",
            "rootSessionId": "root00001",
            "trace": {"status": "incomplete"},
        },
    )
    atomic_json(tmp_path / "task-workspaces/task-one/runtime-overlay/runtime.json", {})
    monkeypatch.setattr(cli, "require_freeze", lambda *_: {})
    monkeypatch.setattr(cli, "validate_implementation", lambda *_: None)
    monkeypatch.setattr(cli, "doctor", lambda *_: {"passed": True})
    monkeypatch.setattr(
        cli, "run_attempt", lambda *_: pytest.fail("Must not resume model execution")
    )
    monkeypatch.setattr(cli, "ensure_control_plane", lambda *_: (None, directory / "control-plane"))
    exports, scores = [], []

    def export(_, state, *args, **kwargs):
        exports.append(state["rootSessionId"])
        if len(exports) == 1:
            raise RuntimeError("temporary export failure")
        state["trace"] = {"status": "exported", "path": "existing-session-trace"}

    def assess(_, __, ___, state, **kwargs):
        scores.append(state["rootSessionId"])
        return state

    monkeypatch.setattr(cli, "export_trace", export)
    monkeypatch.setattr(cli, "assess_attempt", assess)
    monkeypatch.setattr(cli, "analyze_batch", lambda *_: "batch-analysis")
    with pytest.raises(RuntimeError, match="temporary export failure"):
        cli.execute_batch(tmp_path, config, config_path, [task], "trace-recovery", resume=True)
    assert json.loads(state_path.read_text())["phase"] == "collected"
    assert not scores
    cli.execute_batch(tmp_path, config, config_path, [task], "trace-recovery", resume=True)
    cli.execute_batch(tmp_path, config, config_path, [task], "trace-recovery", resume=True)
    assert exports == ["root00001", "root00001"]
    assert scores == ["root00001"]
    assert json.loads(state_path.read_text())["phase"] == "done"


def test_lost_sandbox_marks_checkpoint_partial_after_cleanup(tmp_path, monkeypatch):
    import runner

    class LostClient:
        def tree(self, root_id):
            return {root_id: None}

        def request(self, *args):
            return {}

    store_patch(tmp_path / "artifacts", "root00001", b"partial patch", source="checkpoint")
    monkeypatch.setattr(runner, "CLEANUP_SETTLE_SECONDS", 0)
    monkeypatch.setattr(runner, "containers_for", lambda _: [])
    state = {"rootSessionId": "root00001"}
    runner.cleanup(LostClient(), tmp_path, state, lambda: None)
    assert state["cleanup"] == "complete"
    assert state["artifactCoverage"] == "partial"
    evidence = json.loads((tmp_path / "artifact-coverage.json").read_text())
    assert evidence["sessions"]["root00001"]["finalCapture"] is False
    assert evidence["sessions"]["root00001"]["checkpoint"]["bytes"] == 13


def test_analysis_failure_preserves_exported_trace(tmp_path, monkeypatch):
    import runner

    def command(args, **kwargs):
        if "tools/openinspect-trace-analysis/cli.mjs" in args:
            raise RuntimeError("offline analysis unavailable")

    monkeypatch.setattr(runner, "run_command", command)
    state = {"rootSessionId": "root00001"}
    output = runner.export_trace(tmp_path, state, tmp_path / "connection.json", profile="test")
    assert state["trace"] == {"status": "exported", "path": str(output)}
    assert state["analysis"]["status"] == "incomplete"


def test_batch_denominator_retains_missing_and_unstarted_attempts(tmp_path):
    from reporting import batch_report

    atomic_json(
        tmp_path / "run.json",
        {
            "runId": "report-test",
            "attempts": [
                {"taskId": "feature", "attemptId": "1"},
                {"taskId": "cooper", "attemptId": "2"},
                {"taskId": "cooper", "attemptId": "3"},
            ],
        },
    )
    atomic_json(
        tmp_path / "tasks.json",
        [
            {"taskId": "feature", "benchmark": "featurebench"},
            {"taskId": "cooper", "benchmark": "cooperbench"},
        ],
    )
    atomic_json(
        tmp_path / "attempts/2/attempt.json",
        {
            "taskId": "cooper",
            "attemptId": "2",
            "phase": "done",
            "benchmarkCorrectness": {"status": "missing_artifacts"},
        },
    )
    report = batch_report(tmp_path)
    assert report["plannedAttempts"] == 3
    assert report["phaseCounts"] == {"not_started": 2, "done": 1}
    assert report["benchmarkOutcomes"]["cooperbench"] == {
        "planned": 2,
        "officialChildrenPassed": 0,
        "parentIntegrationPassed": 0,
        "unscored": 1,
    }


def test_missing_artifacts_is_terminal_without_repeating_model_or_grading(tmp_path, monkeypatch):
    import reporting

    calls = []

    def grade(command, **kwargs):
        calls.append(command)
        output = command[command.index("--output") + 1]
        atomic_json(
            __import__("pathlib").Path(output) / "score.json", {"status": "missing_artifacts"}
        )
        raise RuntimeError("Adapter exits nonzero for missing required model artifacts")

    monkeypatch.setattr(reporting, "run_command", grade)
    state = {"rootSessionId": "root00001"}
    task = {"id": "test-task", "benchmark": "cooperbench"}
    reporting.assess_attempt(tmp_path, tmp_path, task, state, official_scoring=True)
    reporting.assess_attempt(tmp_path, tmp_path, task, state, official_scoring=True)
    assert len(calls) == 1
    assert state["benchmarkCorrectness"]["status"] == "missing_artifacts"
    assert (tmp_path / "scoring-001/completion.json").is_file()


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], stderr=subprocess.PIPE)


def test_patch_round_trip_new_deleted_binary_modes_and_preserved_index(tmp_path):
    original = tmp_path / "original"
    original.mkdir()
    git(original, "init", "-b", "main")
    git(original, "config", "user.name", "Test")
    git(original, "config", "user.email", "test@local")
    (original / "delete.txt").write_text("delete me")
    (original / "binary.bin").write_bytes(b"\x00\x01old\xff")
    (original / "script.sh").write_text("echo hi\n")
    (original / ".gitignore").write_text("ignored.txt\n")
    git(original, "add", ".")
    git(original, "commit", "-qm", "base")
    base = git(original, "rev-parse", "HEAD").decode().strip()
    index_before = (original / ".git/index").read_bytes()
    (original / "delete.txt").unlink()
    (original / "new.txt").write_text("new file\n")
    (original / "binary.bin").write_bytes(b"\x00\xfeNEW\x01")
    (original / "script.sh").chmod(0o755)
    (original / "ignored.txt").write_text("cache must stay out")
    patch = snapshot(original, base)
    assert (original / ".git/index").read_bytes() == index_before
    assert b"new.txt" in patch and b"GIT binary patch" in patch
    assert b"ignored.txt" not in patch
    git(original, "add", "-f", "ignored.txt")
    assert b"ignored.txt" in snapshot(original, base)
    clean = tmp_path / "clean"
    subprocess.run(
        ["git", "clone", "--no-hardlinks", str(original), str(clean)],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "-C", str(clean), "apply", "--binary", "-"],
        input=patch,
        check=True,
        capture_output=True,
    )
    assert (clean / "new.txt").read_text() == "new file\n"
    assert not (clean / "delete.txt").exists()
    assert (clean / "binary.bin").read_bytes() == (original / "binary.bin").read_bytes()
    assert (clean / "script.sh").stat().st_mode & 0o111


def test_artifact_authorization_revisions_and_checkpoint_separation(tmp_path):
    parent, child, other = "parent0001", "child00001", "other00001"
    registry = {
        parent: {"parentId": None, "tokenSha256": hashlib.sha256(b"parent-secret").hexdigest()},
        child: {"parentId": parent, "tokenSha256": hashlib.sha256(b"child-secret").hexdigest()},
        other: {"parentId": None, "tokenSha256": hashlib.sha256(b"other-secret").hexdigest()},
    }
    atomic_json(tmp_path / "registry.json", registry)
    server = make_server(("127.0.0.1", 0), tmp_path / "artifacts", tmp_path / "registry.json")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    opener = build_opener(ProxyHandler({}))

    def request(session_id, token, path, data=None):
        req = Request(
            f"http://127.0.0.1:{server.server_address[1]}{path}",
            data=data,
            method="GET" if data is None else "PUT",
            headers={"Authorization": f"Bearer {token}", "X-OpenInspect-Session": session_id},
        )
        with opener.open(req, timeout=5) as response:
            return response.read()

    try:
        first = json.loads(request(child, "child-secret", "/patch", b"first"))
        second = json.loads(request(child, "child-secret", "/patch", b"second"))
        store_patch(tmp_path / "artifacts", child, b"host checkpoint", source="checkpoint")
        assert (
            json.loads((tmp_path / "artifacts" / child / "published.json").read_text())["sha256"]
            == second["sha256"]
        )
        assert request(parent, "parent-secret", f"/patch/{child}/{first['sha256']}") == b"first"
        with pytest.raises(HTTPError) as exc:
            request(other, "other-secret", f"/patch/{child}/{first['sha256']}")
        assert exc.value.code == 404
        with pytest.raises(HTTPError) as exc:
            request(child, "wrong-secret", "/patches")
        assert exc.value.code == 403
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize(
    "vector",
    json.loads((ROOT / "packages/shared/test-fixtures/service-auth-vectors.json").read_text())[
        "vectors"
    ],
    ids=lambda vector: vector["name"],
)
def test_python_signatures_match_shared_immutable_vectors(vector):
    body = (
        base64.b64decode(vector["bodyBase64"])
        if "bodyBase64" in vector
        else vector.get("body", "").encode()
    )
    headers = signature_headers(
        vector["secret"],
        vector["method"],
        vector["url"],
        body,
        timestamp_ms=vector["timestampMs"],
        nonce=vector["nonce"],
        actor=vector.get("actor", ""),
        service=vector["service"],
    )
    assert headers["X-OpenInspect-Service-Signature"] == vector["expected"]["signatureHeader"]


def test_paginate_long_trace_and_reject_cursor_cycles():
    client = object.__new__(Client)
    calls = []

    def request(path):
        calls.append(path)
        return {"events": list(range(200)), "hasMore": len(calls) < 3, "cursor": str(len(calls))}

    client.request = request
    assert len(client.pages("/sessions/long/events", "events")) == 600
    assert "cursor=2" in calls[-1]
    client.request = lambda path: {"events": [], "hasMore": True, "cursor": "repeated"}
    with pytest.raises(ValueError, match="pagination cursor"):
        client.pages("/sessions/long/events", "events")


class LostResponseClient:
    def __init__(self, fail_on):
        self.fail_on = fail_on
        self.posts = []
        self.messages = []

    def request(self, path, method, payload):
        self.posts.append(path)
        if path.endswith("/prompt"):
            self.messages.append({"id": "message1", "content": payload["content"]})
        if path == self.fail_on:
            raise TimeoutError("Accepted remotely but response was lost")
        return {"sessionId": "root00001", "messageId": "message1"}

    def find_title(self, title):
        return [{"id": "root00001", "title": title}]

    def pages(self, path, field):
        return self.messages


@pytest.mark.parametrize("fail_on", ["/sessions", "/sessions/root00001/prompt"])
def test_lost_mutation_response_reconciles_without_duplicate_post(fail_on):
    client = LostResponseClient(fail_on)
    state = {"phase": "allocated", "title": "unique attempt"}
    snapshots = []

    def save():
        snapshots.append(dict(state))

    config = {"model": "model", "deadlineSeconds": 60}
    with pytest.raises(TimeoutError):
        ensure_submission(client, state, save, "prompt bytes", config)
    assert snapshots[-1]["phase"] in ["create_intent", "prompt_intent"]
    client.fail_on = None
    assert ensure_submission(client, state, save, "prompt bytes", config) == "root00001"
    assert client.posts == ["/sessions", "/sessions/root00001/prompt"]
    assert state["phase"] == "observing"


def test_unresolved_intent_is_never_reposted():
    client = LostResponseClient(None)
    client.find_title = lambda _: []
    state = {"phase": "create_intent", "title": "unique"}
    with pytest.raises(RuntimeError, match="no POST repeated"):
        ensure_submission(client, state, lambda: None, "prompt", {"model": "model"})
    assert client.posts == []


def test_lock_rejects_concurrent_batch_and_external_root_guard(tmp_path):
    with (
        lock(tmp_path / "batch.lock"),
        pytest.raises(RuntimeError, match="already holds"),
        lock(tmp_path / "batch.lock"),
    ):
        pytest.fail("Concurrent ownership admitted")
    with lock(tmp_path / "batch.lock"):
        pass
    with pytest.raises(ValueError, match="outside"):
        external_root(ROOT / "dataset")


def test_final_response_requires_actual_completed_text():
    assert not has_final_response("Child: child0001\n  Final response: not available yet")
    assert not has_final_response(
        "Latest completed response (newer prompt queued or running):\n Success: yes\n Text:\n old"
    )
    assert not has_final_response("Final response:\n Success: yes\n Text:\n (empty)")
    assert has_final_response(
        "Final response:\n Success: yes\n Text:\n implemented feature\n Tool summary:\n - bash"
    )
    assert has_final_response(
        "Final response:\n Success: no\n Error: deadline\n Text:\n partial work"
    )


def test_unfinished_score_is_preserved_and_never_reused(tmp_path):
    first, completed = scoring_generation(tmp_path)
    assert not completed
    atomic_json(first / "score.json", {"status": "running"})
    second, completed = scoring_generation(tmp_path)
    assert not completed and first != second and (first / "score.json").exists()
    atomic_json(second / "score.json", {"status": "scored", "resolved": False})
    atomic_json(
        second / "completion.json",
        {"scoreSha256": hashlib.sha256((second / "score.json").read_bytes()).hexdigest()},
    )
    third, completed = scoring_generation(tmp_path)
    assert completed and third == second


def test_prompt_bytes_checked_before_submission_and_on_resume(tmp_path):
    original = tmp_path / "source.txt"
    original.write_bytes(b"original\r\nrequirement\n")
    task = {
        "benchmark": "featurebench",
        "promptSha256": hashlib.sha256(original.read_bytes()).hexdigest(),
    }
    config = {"appendix": "experiments/appendices/child-sessions-v1.txt"}
    prepared = {"promptPaths": [str(original)]}
    output = tmp_path / "attempt"
    output.mkdir()
    prompt = prepare_prompt(task, prepared, config, output)
    assert prompt.startswith("original\r\nrequirement\n")
    assert validate_saved_prompt(task, config, output) == prompt
    original.write_bytes(b"changed original")
    with pytest.raises(ValueError, match="locked task"):
        prepare_prompt(task, prepared, config, output)
    (output / "prompt.submitted.txt").write_text("changed submission")
    with pytest.raises(ValueError, match="was modified"):
        validate_saved_prompt(task, config, output)


def test_cleanup_retains_container_when_final_capture_fails(tmp_path, monkeypatch):
    import runner

    class Client:
        def tree(self, root):
            return {root: None}

        def request(self, *args):
            return {}

    container = {
        "containerId": "owned-only",
        "sessionId": "parent001",
        "captureSucceeded": False,
        "running": False,
    }
    monkeypatch.setattr(runner, "CLEANUP_SETTLE_SECONDS", 0)
    monkeypatch.setattr(runner, "capture", lambda *_: [container])
    monkeypatch.setattr(runner, "containers_for", lambda *_: [container])
    monkeypatch.setattr(
        runner, "build_opener", lambda *_: pytest.fail("Must not delete an unsaved workspace")
    )
    state = {"rootSessionId": "parent001"}
    runner.cleanup(Client(), tmp_path, state, lambda: None)
    assert state["cleanup"] == "incomplete"
    assert json.loads((tmp_path / "cleanup.json").read_text())["remainingContainers"] == [
        "owned-only"
    ]


def test_running_workspace_is_not_final_or_deleted_when_stop_fails(tmp_path, monkeypatch):
    import runner

    class Client:
        def tree(self, root):
            return {root: None}

        def request(self, *args):
            return {}

    container = {
        "containerId": "owned-only",
        "sessionId": "parent001",
        "captureSucceeded": True,
        "running": True,
    }
    store_patch(tmp_path / "artifacts", "parent001", b"live patch", source="checkpoint")
    monkeypatch.setattr(runner, "CLEANUP_SETTLE_SECONDS", 0)
    monkeypatch.setattr(runner, "capture", lambda *_: [container])
    monkeypatch.setattr(runner, "containers_for", lambda *_: [container])
    monkeypatch.setattr(
        runner, "build_opener", lambda *_: pytest.fail("Live workspace must remain")
    )
    commands = []

    def stop(command, **kwargs):
        commands.append(command)
        raise RuntimeError("stop did not complete")

    monkeypatch.setattr(runner, "run_command", stop)
    state = {"rootSessionId": "parent001"}
    runner.cleanup(Client(), tmp_path, state, lambda: None)
    assert commands == [["docker", "stop", "--time", "10", "owned-only"]]
    assert state["cleanup"] == "incomplete"
    assert state["artifactCoverage"] == "partial"
    coverage = json.loads((tmp_path / "artifact-coverage.json").read_text())
    assert coverage["sessions"]["parent001"]["finalCapture"] is False
