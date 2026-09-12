import cli
import continuation
import pytest
from artifacts import atomic_json
from common import ROOT, digest, max_task_memory_mib, read_json, task_config, validate_config


@pytest.fixture
def source_batch(tmp_path):
    source = tmp_path / "runs/original"
    tasks = [
        {"taskId": "meson", "benchmark": "featurebench"},
        {"taskId": "dspy", "benchmark": "cooperbench"},
    ]
    plans = [
        {"taskId": "meson", "attemptId": "003-01", "repetition": 1},
        {"taskId": "dspy", "attemptId": "030-01", "repetition": 1},
    ]
    atomic_json(source / "run.json", {"runId": "original", "status": "complete", "attempts": plans})
    atomic_json(source / "tasks.json", tasks)
    for plan in plans:
        atomic_json(
            source / "attempts" / plan["attemptId"] / "attempt.json",
            {
                **plan,
                "runId": "original",
                "phase": "done",
                "cleanup": "complete",
                "trace": {"status": "complete"},
                "modelExecution": "failed"
                if plan["taskId"] == "dspy"
                else "infrastructure_failure",
            },
        )
    atomic_json(tmp_path / "runs/active.json", {"runId": "original"})
    config = read_json(ROOT / "experiments/behavior-30-v3.json")
    config.update(suite="supplement-test", taskResourceOverrides={"dspy": {"memoryMib": 3840}})
    config_path = tmp_path / "config.json"
    atomic_json(config_path, config)
    return source, tasks, config, config_path


def test_allocate_supplement_preserves_originals_and_does_not_start_models(
    source_batch, tmp_path, monkeypatch
):
    source, tasks, config, config_path = source_batch
    before = {p: digest(p) for p in source.rglob("*") if p.is_file()}
    monkeypatch.setattr(cli, "require_freeze", lambda *_: {"benchmarkLockHashes": {}})
    monkeypatch.setattr(
        cli, "doctor", lambda *_: pytest.fail("Allocation needs no running services")
    )
    monkeypatch.setattr(cli, "run_attempt", lambda *_: pytest.fail("No model during allocation"))
    batch = cli.execute_batch(
        tmp_path,
        config,
        config_path,
        tasks,
        "supplement",
        allocate_only=True,
        source_run_id="original",
    )
    target = tmp_path / "runs/supplement"
    assert batch["status"] == "allocated"
    assert [p["attemptId"] for p in batch["attempts"]] == ["003-02", "030-02"]
    assert all(p["repetition"] == 2 for p in batch["attempts"])
    assert not (target / "attempts").exists()
    assert read_json(target / "report.json")["plannedAttempts"] == 2
    assert read_json(target / "report.json")["supplement"]["sourceRunId"] == "original"
    assert {p: digest(p) for p in before} == before
    continuation.validate_implementation(target, batch)
    prior = source / "attempts/003-01/attempt.json"
    prior.write_text("{}")
    with pytest.raises(ValueError, match="original attempt changed"):
        continuation.validate_implementation(target, batch)


@pytest.mark.parametrize("status", ["completed", "deadline"])
def test_fault_selection_rejects_normal_results(source_batch, tmp_path, status):
    source, tasks, config, _ = source_batch
    path = source / "attempts/003-01/attempt.json"
    state = read_json(path)
    state["modelExecution"] = status
    atomic_json(path, state)
    with pytest.raises(ValueError, match="normal-deadline"):
        cli.supplement_plan(tmp_path, "original", tasks, config)


def test_supplement_rejects_changed_task_and_unfinished_source(source_batch, tmp_path):
    source, tasks, config, _ = source_batch
    with pytest.raises(ValueError, match="exactly match"):
        cli.supplement_plan(tmp_path, "original", [{**tasks[0], "promptSha256": "changed"}], config)
    batch = read_json(source / "run.json")
    batch["status"] = "blocked"
    atomic_json(source / "run.json", batch)
    with pytest.raises(ValueError, match="fully completed"):
        cli.supplement_plan(tmp_path, "original", tasks, config)


def test_only_selected_task_receives_more_memory_with_same_model_and_deadline(
    source_batch, tmp_path, monkeypatch
):
    _source, tasks, config, _ = source_batch
    plans, supplement = cli.supplement_plan(tmp_path, "original", tasks, config)
    target = tmp_path / "runs/supplement"
    batch = {
        "runId": "supplement",
        "status": "running",
        "attempts": plans,
        "supplement": supplement,
    }
    atomic_json(target / "run.json", batch)
    atomic_json(target / "tasks.json", tasks)
    actual = []

    def run_attempt(_lab, directory, task, state, effective):
        actual.append(
            (
                task["taskId"],
                effective["memoryMib"],
                effective["deadlineSeconds"],
                effective["model"],
            )
        )
        state.update(
            phase="collected",
            cleanup="complete",
            trace={"status": "complete"},
            modelExecution="completed",
        )
        atomic_json(directory / "attempts" / state["attemptId"] / "attempt.json", state)
        return state

    monkeypatch.setattr(cli, "run_attempt", run_attempt)
    monkeypatch.setattr(cli, "assess_attempt", lambda *args, **kwargs: args[3])
    monkeypatch.setattr(cli, "analyze_batch", lambda *_: "analysis")
    cli.execute_attempts(tmp_path, target, batch, config, {t["taskId"]: t for t in tasks})
    assert [(t, m) for t, m, _, _ in actual] == [("meson", 3072), ("dspy", 3840)]
    assert all(
        deadline == config["deadlineSeconds"] and model == config["model"]
        for _, _, deadline, model in actual
    )
    assert config["memoryMib"] == 3072
    assert (
        read_json(target / "attempts/030-02/attempt.json")["resourceProfile"]["memoryMib"] == 3840
    )
    assert max_task_memory_mib(config) == 3840
    assert task_config(config, "meson")["memoryMib"] == 3072


@pytest.mark.parametrize("override", [True, -1, 0, "3840"])
def test_invalid_memory_override_is_rejected(source_batch, override):
    _source, _tasks, config, _ = source_batch
    config["taskResourceOverrides"] = {"dspy": {"memoryMib": override}}
    with pytest.raises(ValueError, match="memoryMib"):
        validate_config(config)


def test_resource_override_cannot_change_model_budget(source_batch):
    _source, _tasks, config, _ = source_batch
    config["taskResourceOverrides"] = {"dspy": {"memoryMib": 3840, "deadlineSeconds": 3600}}
    with pytest.raises(ValueError, match="only set memoryMib"):
        validate_config(config)
