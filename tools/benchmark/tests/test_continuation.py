import cli
import continuation
import pytest
import reporting
import service
from artifacts import atomic_json
from common import digest, read_json, validate_config


@pytest.mark.parametrize("benchmark", ["featurebench", "cooperbench"])
def test_default_skip_still_checks_trace_and_protocol(tmp_path, monkeypatch, benchmark):
    state = {
        "rootSessionId": "parent",
        "sessionTree": {"parent": None},
        "modelRequested": "model",
        "trace": {"path": str(tmp_path / "trace")},
    }
    atomic_json(
        tmp_path / "trace/raw/session-index.json",
        {"sessions": [{"id": "parent", "model": "model"}]},
    )
    checks = []
    monkeypatch.setattr(
        reporting, "verify_trace", lambda *_: checks.append("trace") or {"status": "complete"}
    )
    monkeypatch.setattr(
        reporting,
        "protocol_evidence",
        lambda *args: checks.append("protocol") or {"status": "failed"},
    )
    monkeypatch.setattr(reporting, "runtime_evidence", lambda *args: checks.append("runtime") or {})
    monkeypatch.setattr(
        reporting, "run_command", lambda *a, **kw: pytest.fail("No grader subprocess allowed")
    )
    for _ in range(2):
        reporting.assess_attempt(tmp_path, tmp_path, {"benchmark": benchmark}, state)
    assert checks == ["trace", "protocol", "runtime"] * 2
    assert state["childProtocol"] == "failed"
    assert state["benchmarkCorrectness"]["status"] == "not_scored"
    assert not list(tmp_path.glob("scoring-*"))


def test_skip_refuses_to_replace_old_scoring_evidence(tmp_path):
    atomic_json(tmp_path / "scoring-001/score.json", {"status": "infrastructure_failed"})
    before = digest(tmp_path / "scoring-001/score.json")
    with pytest.raises(ValueError, match="Existing grading"):
        reporting.assess_attempt(tmp_path, tmp_path, {}, {})
    assert digest(tmp_path / "scoring-001/score.json") == before


def test_enabled_scoring_failure_is_distinct_from_skip(tmp_path, monkeypatch):
    monkeypatch.setattr(
        reporting,
        "run_command",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("grader failed")),
    )
    state = {"rootSessionId": "parent"}
    with pytest.raises(RuntimeError, match="Grading incomplete"):
        reporting.assess_attempt(
            tmp_path,
            tmp_path,
            {"benchmark": "featurebench", "taskId": "task"},
            state,
            official_scoring=True,
        )
    assert state["scoring"]["status"] == "failed"
    assert state["benchmarkCorrectness"]["status"] == "infrastructure_failed"
    assert not (tmp_path / "scoring-001/completion.json").exists()


def test_scoring_policy_type_is_explicit():
    with pytest.raises(ValueError, match="officialScoring"):
        validate_config({"officialScoring": "false"})


@pytest.fixture
def paused_batch(tmp_path, monkeypatch):
    root, lab = tmp_path / "checkout", tmp_path / "lab"
    monkeypatch.setattr(cli, "ROOT", root)
    monkeypatch.setattr(continuation, "ROOT", root)
    config = {"suite": "old", "officialScoring": True, "traceProfile": "test"}
    config_path = root / "experiments/new.json"
    atomic_json(config_path, {"suite": "new", "officialScoring": False, "traceProfile": "test"})
    source = lab / "runs/old"
    atomic_json(source / "config.json", config)
    selected = [
        {"taskId": "one", "benchmark": "featurebench"},
        {"taskId": "two", "benchmark": "cooperbench"},
    ]
    plans = [
        {"taskId": "one", "attemptId": "001", "repetition": 1},
        {"taskId": "two", "attemptId": "002", "repetition": 1},
    ]
    atomic_json(
        source / "run.json",
        {
            "runId": "old",
            "status": "interrupted",
            "configSha256": digest(source / "config.json"),
            "attempts": plans,
        },
    )
    atomic_json(source / "tasks.json", selected)
    atomic_json(source / "batch.lock", {"pid": 123})
    atomic_json(source / "suite-lock.json", {"tasks": ["original-calibration"]})
    atomic_json(root / "experiments/old.lock.json", {"tasks": ["original-calibration"]})
    atomic_json(source / "benchmark-locks/featurebench-lock.json", {"unchanged": True})
    atomic_json(
        source / "attempts/001/attempt.json",
        {
            **plans[0],
            "runId": "old",
            "phase": "done",
            "cleanup": "complete",
            "trace": {"status": "complete"},
            "modelExecution": "interrupted",
            "benchmarkCorrectness": {"status": "scored", "resolved": False},
        },
    )
    atomic_json(lab / "runs/active.json", {"runId": "old"})
    script = root / "tools/benchmark/runner.py"
    script.parent.mkdir(parents=True)
    script.write_text("# original implementation\n")
    monkeypatch.setattr(cli, "require_freeze", lambda *_: read_json(source / "suite-lock.json"))
    monkeypatch.setattr(continuation, "tasks", lambda _: selected)
    monkeypatch.setattr(continuation, "run_command", lambda *_: b"fixture")
    return lab, source, config_path, selected


def test_continuation_preserves_original_and_only_executes_remaining(paused_batch, monkeypatch):
    lab, source, config_path, selected = paused_batch
    hashes = {p: digest(p) for p in source.rglob("*") if p.is_file()}
    config = read_json(config_path)
    batch = continuation.prepare_continuation(lab, config, config_path, "old", "new")
    target = lab / "runs/new"
    assert continuation.prepare_continuation(lab, config, config_path, "old", "new") == batch
    assert not (target / "attempts/001").exists()
    assert {p: digest(p) for p in hashes} == hashes
    assert batch["continuation"]["remainingAttemptIds"] == ["002"]
    continuation.validate_implementation(target, batch)
    seen = []

    def model(_, directory, task, state, config):
        seen.append(state["attemptId"])
        state.update(
            phase="collected",
            cleanup="complete",
            trace={"status": "complete"},
            modelExecution="completed",
        )
        atomic_json(directory / "attempts" / state["attemptId"] / "attempt.json", state)
        return state

    monkeypatch.setattr(cli, "run_attempt", model)
    monkeypatch.setattr(
        cli,
        "assess_attempt",
        lambda *args, **kwargs: {
            **args[3],
            "benchmarkCorrectness": {"status": "not_scored", "reason": "disabled_by_config"},
        },
    )
    monkeypatch.setattr(cli, "analyze_batch", lambda *args: "analysis")
    cli.execute_attempts(lab, target, batch, config, {t["taskId"]: t for t in selected})
    cli.execute_attempts(lab, target, batch, config, {t["taskId"]: t for t in selected})
    assert seen == ["002"]
    assert {p: digest(p) for p in hashes} == hashes
    report = reporting.batch_report(target)
    assert report["plannedAttempts"] == 2
    assert report["attempts"][0]["modelExecution"] == "interrupted"
    assert report["scoringCounts"] == {"scored": 1, "skippedByConfig": 1, "failed": 0, "pending": 0}
    assert read_json(target / "exceptions.json")["items"][0]["status"] == "interrupted"
    next(iter(hashes)).write_text("tampered")
    with pytest.raises(ValueError, match="changed"):
        continuation.validate_implementation(target, batch)


def test_continuation_rejects_unfinished_attempt_and_changed_budget(paused_batch):
    lab, source, config_path, _ = paused_batch
    changed = {**read_json(config_path), "deadlineSeconds": 999}
    with pytest.raises(ValueError, match="only change"):
        continuation.prepare_continuation(lab, changed, config_path, "old", "new")
    atomic_json(
        source / "attempts/002/attempt.json",
        {"taskId": "two", "attemptId": "002", "repetition": 1, "phase": "observing"},
    )
    with pytest.raises(ValueError, match="Finish original"):
        continuation.prepare_continuation(lab, read_json(config_path), config_path, "old", "new")
    assert not (lab / "runs/new").exists()


def test_safe_stop_before_next_attempt_does_not_submit(paused_batch, monkeypatch):
    lab, _source, config_path, _selected = paused_batch
    batch = continuation.prepare_continuation(
        lab, read_json(config_path), config_path, "old", "new"
    )
    target = lab / "runs/new"
    request = service.stop_request(target)
    assert service.stop_request(target) == request
    monkeypatch.setattr(cli, "run_attempt", lambda *a: pytest.fail("No next attempt after stop"))
    cli.execute_attempts(lab, target, batch, read_json(config_path), {})
    assert batch["status"] == "interrupted"
    assert not (target / "attempts/002").exists()


def test_infrastructure_failure_stops_scheduler_after_evidence(paused_batch, monkeypatch):
    lab, _source, config_path, selected = paused_batch
    batch = continuation.prepare_continuation(
        lab, read_json(config_path), config_path, "old", "new"
    )
    target = lab / "runs/new"

    def model(_, directory, task, state, config):
        state.update(
            phase="collected",
            cleanup="complete",
            trace={"status": "complete"},
            modelExecution="infrastructure_failure",
        )
        atomic_json(directory / "attempts" / state["attemptId"] / "attempt.json", state)
        return state

    monkeypatch.setattr(cli, "run_attempt", model)
    monkeypatch.setattr(cli, "assess_attempt", lambda *args, **kwargs: args[3])
    monkeypatch.setattr(cli, "analyze_batch", lambda *args: pytest.fail("Stop for investigation"))
    with pytest.raises(RuntimeError, match="Infrastructure failure"):
        cli.execute_attempts(
            lab, target, batch, read_json(config_path), {t["taskId"]: t for t in selected}
        )
    assert read_json(target / "attempts/002/attempt.json")["phase"] == "done"


def test_service_refuses_duplicate_live_runner(paused_batch, monkeypatch):
    lab, _source, config_path, _selected = paused_batch
    continuation.prepare_continuation(lab, read_json(config_path), config_path, "old", "new")
    atomic_json(lab / "runs/new/runner-service.json", {"unit": "existing.service"})
    monkeypatch.setattr(
        service, "service_state", lambda _: {"MainPID": "123", "ActiveState": "active"}
    )
    monkeypatch.setattr(service, "run_command", lambda *a, **kw: pytest.fail("No duplicate launch"))
    with pytest.raises(RuntimeError, match="already runs"):
        service.start(lab, "new")


def test_dependency_failure_is_persisted_without_model_attempt(paused_batch, monkeypatch):
    lab, _source, config_path, _selected = paused_batch
    continuation.prepare_continuation(lab, read_json(config_path), config_path, "old", "new")
    target = lab / "runs/new"
    monkeypatch.setattr(service.signal, "signal", lambda *a: None)
    monkeypatch.setattr(
        service,
        "dependencies",
        lambda *a: (_ for _ in ()).throw(RuntimeError("Restore model proxy")),
    )
    monkeypatch.setattr(cli, "execute_batch", lambda *a, **kw: pytest.fail("No model batch"))
    assert service.worker(lab, "new", "test-launch") == 1
    assert not (target / "attempts").exists()
    assert read_json(target / "progress.json")["status"] == "blocked"
    assert read_json(target / "exceptions.json")["blocked"]["reason"] == "Restore model proxy"
    assert read_json(target / "launches/test-launch/exit.json")["exitCode"] == 1


def test_second_continuation_retains_original_inheritance_and_new_results(
    paused_batch, monkeypatch
):
    lab, source, config_path, selected = paused_batch
    selected.append({"taskId": "three", "benchmark": "cooperbench"})
    original = read_json(source / "run.json")
    original["attempts"].append({"taskId": "three", "attemptId": "003", "repetition": 1})
    atomic_json(source / "run.json", original)
    atomic_json(source / "tasks.json", selected)
    first = continuation.prepare_continuation(
        lab, read_json(config_path), config_path, "old", "new"
    )
    first_directory = lab / "runs/new"
    first["status"] = "blocked"
    atomic_json(first_directory / "run.json", first)
    atomic_json(first_directory / "batch.lock", {"pid": 234})
    atomic_json(
        first_directory / "attempts/002/attempt.json",
        {
            **first["attempts"][1],
            "runId": "new",
            "phase": "done",
            "cleanup": "complete",
            "trace": {"status": "complete"},
            "modelExecution": "infrastructure_failure",
        },
    )
    next_config = {**read_json(config_path), "suite": "next"}
    next_config_path = config_path.parent / "next.json"
    atomic_json(next_config_path, next_config)
    monkeypatch.setattr(
        cli, "require_freeze", lambda *_: read_json(first_directory / "suite-lock.json")
    )
    second = continuation.prepare_continuation(lab, next_config, next_config_path, "new", "next")
    assert list(second["inheritedAttempts"]) == ["001", "002"]
    assert second["inheritedAttempts"]["001"]["path"] == str(source / "attempts/001/attempt.json")
    assert second["continuation"]["remainingAttemptIds"] == ["003"]
    continuation.validate_implementation(lab / "runs/next", second)
    assert (
        reporting.batch_report(lab / "runs/next")["attempts"][1]["modelExecution"]
        == "infrastructure_failure"
    )


def test_status_without_run_id_follows_active_continuation(paused_batch, monkeypatch, capsys):
    lab, _source, config_path, _selected = paused_batch
    continuation.prepare_continuation(lab, read_json(config_path), config_path, "old", "new")
    monkeypatch.setattr(service.sys, "argv", ["service.py", "status", "--lab-root", str(lab)])
    assert service.main() == 0
    assert '"runId": "new"' in capsys.readouterr().out


def test_stop_still_requires_an_explicit_batch(monkeypatch):
    monkeypatch.setattr(service.sys, "argv", ["service.py", "stop"])
    with pytest.raises(SystemExit) as error:
        service.main()
    assert error.value.code == 2
