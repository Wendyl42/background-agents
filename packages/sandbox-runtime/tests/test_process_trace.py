"""Measurement integrity tests; real-kernel equivalence is process_probe.py."""

import hashlib
import io
import json
import signal
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.tracing.collector import (
    EVENT_CLONE,
    EVENT_EXEC,
    EVENT_EXIT,
    TICKS_PER_SECOND,
    Collector,
    Group,
    Task,
    image_info,
    signal_owned,
)
from sandbox_runtime.tracing.config import configure_execution_trace
from sandbox_runtime.tracing.writer import EventWriter


def read_rows(writer):
    return [json.loads(line) for line in writer.path.read_text().splitlines()]


def test_argv_retains_trailing_empty_arguments_and_matches_raw_fingerprint(monkeypatch):
    raw = b"program\0value\0\0\0"
    path = MagicMock()
    path.open.return_value = io.BytesIO(raw)
    path.readlink.return_value = Path("/bin/program")
    monkeypatch.setattr("sandbox_runtime.tracing.collector.Path", lambda _path: path)
    result = image_info(123)
    assert result["argv"] == ["program", "value", "", ""]
    assert result["argv_sha256"] == hashlib.sha256(raw).hexdigest()


def test_writer_preserves_sequence_and_explicit_overflow(tmp_path):
    writer = EventWriter(tmp_path, {"span_id": "span"}, max_bytes=8192)
    for index in range(100):
        writer.emit("process.signal", pid=index, signal=15)
    writer.close("test")
    rows = read_rows(writer)
    assert rows[0]["kind"] == "trace.open"
    assert rows[-2]["kind"] == "trace.loss"
    assert rows[-1]["complete"] is False
    assert rows[-1]["reason"] == "stream_byte_limit"
    assert [row["seq"] for row in rows] == list(range(1, len(rows) + 1))
    assert writer.path.stat().st_size <= 8192
    assert writer.path.stat().st_mode & 0o777 == 0o600


def test_deferred_evidence_is_written_after_resumption_without_retiming(tmp_path):
    writer = EventWriter(tmp_path, {"span_id": "span"})
    writer.begin_defer()
    writer.emit("process.exec", at_ns=123, process_instance_id="p", exec_index=1)
    assert len(read_rows(writer)) == 1
    writer.end_defer()
    assert read_rows(writer)[1]["mono_ns"] == "123"
    writer.close("test")
    assert read_rows(writer)[-1]["complete"]


def test_signal_forwarding_does_not_touch_reused_unowned_pid(monkeypatch):
    monkeypatch.setattr("sandbox_runtime.tracing.collector.os.getpid", lambda: 123)
    status = "PPid:\t999\nTracerPid:\t0\n"
    monkeypatch.setattr(Path, "read_text", lambda *_args, **_kwargs: status)
    kill = MagicMock()
    monkeypatch.setattr("sandbox_runtime.tracing.collector.os.kill", kill)
    signal_owned(20, signal.SIGTERM)
    kill.assert_not_called()
    status = "PPid:\t999\nTracerPid:\t123\n"
    signal_owned(20, signal.SIGTERM)
    kill.assert_called_once_with(20, signal.SIGTERM)


def test_parent_cpu_does_not_include_child_cpu(tmp_path):
    writer = EventWriter(tmp_path, {"span_id": "span"})
    collector = Collector(writer, 1, -1)
    parent = Group(10, "parent", None, True, exited_user_ticks=4, exited_system_ticks=2)
    child = Group(20, "child", "parent", False, exited_user_ticks=200, exited_system_ticks=50)
    collector.groups = {10: parent, 20: child}
    cpu = collector.cpu_snapshot(parent)
    assert int(cpu["user_cpu_ns"]) == 4 * 1_000_000_000 // TICKS_PER_SECOND
    assert int(cpu["system_cpu_ns"]) == 2 * 1_000_000_000 // TICKS_PER_SECOND
    writer.close("test")


def test_nonleader_exec_retires_old_leader_without_double_counting_cpu(tmp_path, monkeypatch):
    writer = EventWriter(tmp_path, {"span_id": "span"})
    collector = Collector(writer, 1, -1)
    group = Group(10, "group", None, True, tasks={10, 11}, exec_index=1)
    old_leader = Task(
        10, "leader", group, "100", exit_ns=1000, exit_wait_status=0, user_ticks=4, system_ticks=2
    )
    moving = Task(11, "worker", group, "101")
    collector.tasks = {10: old_leader, 11: moving}
    collector.groups = {10: group}
    monkeypatch.setattr("sandbox_runtime.tracing.collector.event_message", lambda _pid: 11)
    monkeypatch.setattr("sandbox_runtime.tracing.collector.ptrace", lambda *_args: None)
    monkeypatch.setattr("sandbox_runtime.tracing.collector.image_info", lambda _pid: {})
    monkeypatch.setattr(
        "sandbox_runtime.tracing.collector.task_info",
        lambda _pid: {"user_ticks": 3, "system_ticks": 1},
    )
    collector.handle(10, (EVENT_EXEC << 16) | (signal.SIGTRAP << 8) | 0x7F)
    assert list(collector.tasks) == [10]
    assert collector.tasks[10].instance_id == "worker"
    assert group.tasks == {10}
    assert group.cpu_complete
    assert (
        int(collector.cpu_snapshot(group)["user_cpu_ns"]) == 7 * 1_000_000_000 // TICKS_PER_SECOND
    )
    rows = read_rows(writer)
    retired = [row for row in rows if row["kind"] == "thread.exit"]
    assert len(retired) == 1 and retired[0]["task_instance_id"] == "leader"
    assert not any(row["kind"] == "trace.loss" for row in rows)
    writer.close("test")


def test_pid_reuse_creates_distinct_process_instances(tmp_path, monkeypatch):
    writer = EventWriter(tmp_path, {"span_id": "span"})
    collector = Collector(writer, 1, -1)
    parent_group = Group(1, "parent", None, True)
    parent = Task(1, "parent-task", parent_group, "1")
    info = {"tgid": 20, "birth_ticks": "100", "user_ticks": 0, "system_ticks": 0}
    monkeypatch.setattr("sandbox_runtime.tracing.collector.task_info", lambda _pid: info)
    monkeypatch.setattr("sandbox_runtime.tracing.collector.image_info", lambda _pid: {})
    first = collector.add_task(20, parent, "fork")
    first.user_ticks = first.system_ticks = 0
    collector.finish_task(20, 0)
    info["birth_ticks"] = "200"
    second = collector.add_task(20, parent, "fork")
    assert first.group.instance_id != second.group.instance_id
    assert first.instance_id != second.instance_id
    assert first.birth_ticks != second.birth_ticks
    writer.close("test", False)


def test_process_configuration_refuses_failed_kernel_probe(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "sandbox_runtime.tracing.config.subprocess.run",
        MagicMock(return_value=MagicMock(returncode=1)),
    )
    with pytest.raises(RuntimeError, match="probe failed"):
        configure_execution_trace(
            tmp_path / "work",
            {
                "OI_EXECUTION_TRACE_MODE": "process",
                "OI_EXECUTION_TRACE_DIR": str(tmp_path / "events"),
                "SHELL": "/bin/bash",
            },
            {},
        )


def test_process_configuration_requires_supported_shell(tmp_path):
    with pytest.raises(ValueError, match="requires Bash"):
        configure_execution_trace(
            tmp_path / "work",
            {
                "OI_EXECUTION_TRACE_MODE": "process",
                "OI_EXECUTION_TRACE_DIR": str(tmp_path / "events"),
            },
            {"shell": "/bin/sh"},
        )


def test_wrapper_forwards_arguments_through_private_bootstrap(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "sandbox_runtime.tracing.config.subprocess.run",
        MagicMock(return_value=MagicMock(returncode=0)),
    )
    config = {"shell": "/bin/bash"}
    env, _ = configure_execution_trace(
        tmp_path / "work",
        {"OI_EXECUTION_TRACE_MODE": "process", "OI_EXECUTION_TRACE_DIR": str(tmp_path / "events")},
        config,
    )
    wrapper = Path(env["OI_EXECUTION_TRACE_WRAPPER_SHELL"])
    assert wrapper.name == "bash"
    assert "runpy.run_path" in wrapper.read_text()
    assert "sys.path.insert" not in wrapper.read_text()
    assert env["OI_EXECUTION_TRACE_REAL_SHELL"] == "/bin/bash"
    assert config["shell"] == "/bin/bash"


def test_recovered_exit_stop_requires_owned_known_group_and_final_wait(tmp_path, monkeypatch):
    writer = EventWriter(tmp_path, {"span_id": "span"})
    collector = Collector(writer, 10, -1)
    leader = collector_group = Group(10, "group", None, True, tasks={10})
    task = Task(10, "leader", leader, "100", user_ticks=0, system_ticks=0)
    task.runtime_cpu_ns = 0
    collector.tasks = {10: task}
    collector.groups = {10: collector_group}
    info = {
        "tgid": 10,
        "tracer_pid": 123,
        "birth_ticks": "101",
        "user_ticks": 2,
        "system_ticks": 1,
        "runtime_cpu_ns": 1234567,
    }
    monkeypatch.setattr("sandbox_runtime.tracing.collector.os.getpid", lambda: 123)
    monkeypatch.setattr("sandbox_runtime.tracing.collector.task_info", lambda _: dict(info))
    monkeypatch.setattr("sandbox_runtime.tracing.collector.event_message", lambda _: 0)
    monkeypatch.setattr("sandbox_runtime.tracing.collector.ptrace", lambda *_: None)
    status = (EVENT_EXIT << 16) | (signal.SIGTRAP << 8) | 0x7F
    info["tracer_pid"] = 999
    assert not collector.recover_autoattached_thread(11, status)
    info["tracer_pid"], info["tgid"] = 123, 999
    assert not collector.recover_autoattached_thread(11, status)
    info["tgid"] = 10
    collector.retired_pids.add(11)
    assert not collector.recover_autoattached_thread(11, status)
    collector.retired_pids.clear()
    assert collector.recover_autoattached_thread(11, status)
    recovered = collector.tasks[11]
    assert collector.add_task(11, task, "clone") is recovered
    collector.handle(11, status)
    rows = read_rows(writer)
    assert rows[-1]["creation_observation"] == "exit_stop_recovered"
    assert not any(row["kind"].endswith(".exit") for row in rows)
    collector.handle(11, 0)
    assert 10 in collector.groups
    collector.handle(10, 0)
    rows = read_rows(writer)
    assert len([r for r in rows if r["kind"] == "thread.exit"]) == 2
    end = next(r for r in rows if r["kind"] == "process.exit")
    assert end["cpu_runtime_ns"] == "1234567"
    assert end["cpu_runtime_complete"] and end["exit_code"] == 0
    writer.close("test")


def test_unresponsive_detach_always_writes_incomplete_footer(tmp_path, monkeypatch):
    writer = EventWriter(tmp_path, {"span_id": "span"})
    collector = Collector(writer, 1, -1)
    group = Group(1, "group", None, True, tasks={1})
    collector.tasks = {1: Task(1, "thread", group, "100")}
    collector.groups = {1: group}
    collector.detaching = True
    collector.detach_started_seconds = 0
    monkeypatch.setattr("sandbox_runtime.tracing.collector.os.waitpid", lambda *_: (0, 0))
    monkeypatch.setattr("sandbox_runtime.tracing.collector.time.monotonic", lambda: 10)
    collector.collect()
    rows = read_rows(writer)
    assert rows[-1]["kind"] == "trace.close"
    assert rows[-1]["reason"] == "detach_deadline" and not rows[-1]["complete"]
    assert not any(row["kind"] == "process.exit" for row in rows)


def test_superseded_clone_does_not_invent_exit_or_complete_cpu(tmp_path, monkeypatch):
    writer = EventWriter(tmp_path, {"span_id": "span"})
    collector = Collector(writer, 1, -1)
    group = Group(1, "group", None, True, tasks={1})
    collector.tasks = {1: Task(1, "thread", group, "100")}
    collector.groups = {1: group}

    def vanished(_pid):
        raise ProcessLookupError(3, "No such process")

    monkeypatch.setattr("sandbox_runtime.tracing.collector.event_message", vanished)
    collector.handle(1, (EVENT_CLONE << 16) | (signal.SIGTRAP << 8) | 0x7F)
    rows = read_rows(writer)
    assert rows[-1]["kind"] == "trace.notice"
    assert rows[-1]["reason"] == "fork_notification_superseded"
    assert rows[-1]["errno"] == 3
    assert rows[-1]["cpu_accounting"] == "unavailable_for_parent_group"
    assert not group.cpu_complete and not group.runtime_cpu_complete
    assert 1 in collector.tasks
    assert not any(row["kind"] == "process.exit" for row in rows)
    writer.close("test")


def test_clone_notification_after_autoattached_thread_exit(tmp_path, monkeypatch):
    writer = EventWriter(tmp_path, {"span_id": "span"})
    collector = Collector(writer, 10, -1)
    group = Group(10, "group", None, True, tasks={10})
    collector.tasks = {10: Task(10, "leader", group, "100", user_ticks=0, system_ticks=0)}
    collector.groups = {10: group}
    info = {
        "tgid": 10,
        "tracer_pid": 123,
        "birth_ticks": "101",
        "user_ticks": 0,
        "system_ticks": 0,
        "runtime_cpu_ns": 0,
    }
    monkeypatch.setattr("sandbox_runtime.tracing.collector.os.getpid", lambda: 123)
    monkeypatch.setattr("sandbox_runtime.tracing.collector.task_info", lambda _: dict(info))
    monkeypatch.setattr("sandbox_runtime.tracing.collector.ptrace", lambda *_: None)
    assert collector.recover_autoattached_thread(11, (signal.SIGSTOP << 8) | 0x7F)
    collector.tasks[11].user_ticks = collector.tasks[11].system_ticks = 0
    collector.tasks[11].runtime_cpu_ns = 0
    collector.handle(11, 0)

    def gone(_):
        raise FileNotFoundError("/proc/11/status")

    monkeypatch.setattr("sandbox_runtime.tracing.collector.task_info", gone)
    monkeypatch.setattr("sandbox_runtime.tracing.collector.event_message", lambda _: 11)
    collector.handle(10, (EVENT_CLONE << 16) | (signal.SIGTRAP << 8) | 0x7F)
    assert collector.autoattached_notifications == {}
    collector.handle(10, 0)
    rows = read_rows(writer)
    assert len([r for r in rows if r["kind"] == "thread.start" and r["pid"] == 11]) == 1
    assert len([r for r in rows if r["kind"] == "thread.exit" and r["pid"] == 11]) == 1
    assert any(r.get("reason") == "clone_notification_after_observed_exit" for r in rows)
    assert any(r["kind"] == "process.exit" for r in rows)
    assert not any(r["kind"] == "trace.loss" for r in rows)
    writer.close("test")


def test_late_clone_requires_same_group_identity(tmp_path, monkeypatch):
    writer = EventWriter(tmp_path, {"span_id": "span"})
    collector = Collector(writer, 10, -1)
    group = Group(10, "new-group", None, True, tasks={10})
    collector.tasks = {10: Task(10, "leader", group, "100")}
    collector.groups = {10: group}
    collector.autoattached_notifications[11] = ("old-group", "old-thread")
    monkeypatch.setattr("sandbox_runtime.tracing.collector.event_message", lambda _: 11)

    def gone(_):
        raise FileNotFoundError("/proc/11/status")

    monkeypatch.setattr("sandbox_runtime.tracing.collector.task_info", gone)
    with pytest.raises(FileNotFoundError):
        collector.handle(10, (EVENT_CLONE << 16) | (signal.SIGTRAP << 8) | 0x7F)
    assert not any(
        r.get("reason") == "clone_notification_after_observed_exit" for r in read_rows(writer)
    )
    writer.close("test")
