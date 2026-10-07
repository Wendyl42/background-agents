"""Opt-in setup must fail before executing unmeasured work when misconfigured."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.toolchain import TOOLCHAIN
from sandbox_runtime.tracing.config import configure_execution_trace, ensure_trace_ready
from tests.runtime_helpers import make_opencode_server


def test_off_does_not_touch_workspace(tmp_path):
    assert configure_execution_trace(tmp_path, {}, {}) == ({}, set())
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    "env",
    [
        {"OI_EXECUTION_TRACE_MODE": "bad"},
        {"OI_EXECUTION_TRACE_MODE": "tools"},
        {"OI_EXECUTION_TRACE_MODE": "tools", "OI_EXECUTION_TRACE_DIR": "relative"},
    ],
)
def test_invalid_config_rejected(tmp_path, env):
    with pytest.raises(ValueError):
        configure_execution_trace(tmp_path, env, {})


def test_installs_runtime_plugin_and_preserves_opencode_config(tmp_path):
    work = tmp_path / "work"
    out = tmp_path / "out"
    config = {"model": "test/model", "permission": {"*": "allow"}}
    env, paths = configure_execution_trace(
        work, {"OI_EXECUTION_TRACE_MODE": "tools", "OI_EXECUTION_TRACE_DIR": str(out)}, config
    )
    assert config["model"] == "test/model"
    assert config["permission"] == {"*": "allow"}
    assert len(config["plugin"]) == 1
    assert config["plugin"][0].endswith("/plugins/execution-trace.js")
    assert Path(env["OI_EXECUTION_TRACE_DEFAULTS"]).is_file()
    assert env["OI_EXECUTION_TRACE_DIR"] == str(out)
    assert paths == set()
    assert not (work / ".opencode/plugins/execution-trace.js").exists()


async def test_server_passes_trace_environment_to_actual_child(tmp_path, monkeypatch):
    monkeypatch.setenv("OI_EXECUTION_TRACE_MODE", "tools")
    monkeypatch.setenv("OI_EXECUTION_TRACE_DIR", str(tmp_path / "spool"))
    server = make_opencode_server(workspace_path=tmp_path)
    server._setup_managed_oauth = MagicMock()
    server._prepare_opencode_filesystem = MagicMock(return_value=set())
    server._wait_for_health = AsyncMock()
    process = MagicMock(stdout=None)
    with (
        patch("asyncio.create_subprocess_exec", AsyncMock(return_value=process)) as spawn,
        patch("sandbox_runtime.opencode_server.ensure_trace_ready", AsyncMock()) as ready,
    ):
        await server.start((), tmp_path)
    ready.assert_awaited_once()
    env = spawn.call_args.kwargs["env"]
    assert env["OI_EXECUTION_TRACE_MODE"] == "tools"
    assert Path(env["OI_EXECUTION_TRACE_DEFAULTS"]).is_file()
    assert server._execution_trace_enabled


@pytest.mark.parametrize("dispose_fails", [False, True])
async def test_shutdown_attempts_flush_but_always_terminates(dispose_fails):
    server = make_opencode_server()
    server._execution_trace_enabled = True
    process = MagicMock(returncode=None)
    process.wait = AsyncMock(return_value=0)
    server._opencode_process = process
    client = AsyncMock()
    response = MagicMock()
    client.post = AsyncMock(
        side_effect=RuntimeError("closed") if dispose_fails else None, return_value=response
    )
    manager = AsyncMock()
    manager.__aenter__.return_value = client
    with patch("sandbox_runtime.opencode_server.httpx.AsyncClient", return_value=manager):
        await server.stop()
    assert client.post.call_args.args[0].endswith("/global/dispose")
    process.terminate.assert_called_once()
    process.wait.assert_awaited_once()


async def test_failed_handshake_stops_server_before_ready(tmp_path, monkeypatch):
    monkeypatch.setenv("OI_EXECUTION_TRACE_MODE", "tools")
    monkeypatch.setenv("OI_EXECUTION_TRACE_DIR", str(tmp_path / "spool"))
    server = make_opencode_server(workspace_path=tmp_path)
    server._setup_managed_oauth = MagicMock()
    server._prepare_opencode_filesystem = MagicMock(return_value=set())
    server._wait_for_health = AsyncMock()
    server.stop = AsyncMock()
    server.log = MagicMock()
    process = MagicMock(stdout=None)
    with (
        patch("asyncio.create_subprocess_exec", AsyncMock(return_value=process)),
        patch(
            "sandbox_runtime.opencode_server.ensure_trace_ready",
            AsyncMock(side_effect=RuntimeError("no trace")),
        ),
        pytest.raises(RuntimeError, match="no trace"),
    ):
        await server.start((), tmp_path)
    server.stop.assert_awaited_once()
    assert not any(call.args[0] == "opencode.ready" for call in server.log.info.call_args_list)


@pytest.mark.parametrize("invalid", [None, "stale", "project", "wrapper"])
async def test_readiness_requires_fresh_marker_and_matching_stream(tmp_path, monkeypatch, invalid):
    monkeypatch.setattr("sandbox_runtime.tracing.config.READY_TIMEOUT_SECONDS", 0.03)
    monkeypatch.setattr("sandbox_runtime.tracing.config.READY_POLL_SECONDS", 0.001)
    marker = {
        "handshake": "fresh",
        "stream_id": "s",
        "stream_file": "tools-s.jsonl",
        "project_directory": str(tmp_path),
        "real_shell": "/bin/bash",
        "wrapper_shell": "/trace/bash",
    }
    (tmp_path / "ready-fresh-s.json").write_text(json.dumps(marker))
    first = {
        "schema": "openinspect-execution-v1",
        "kind": "trace.open",
        "stream_id": "s",
        "handshake": "stale" if invalid == "stale" else "fresh",
        "context": {"project_directory": "/other" if invalid == "project" else str(tmp_path)},
        "mode": "process",
    }
    (tmp_path / "tools-s.jsonl").write_text(json.dumps(first) + "\n")
    client = AsyncMock()
    client.get.return_value = MagicMock()
    client.get.return_value.json.return_value = {
        "version": TOOLCHAIN["opencode"],
        "shell": "/other/bash" if invalid == "wrapper" else "/trace/bash",
    }
    manager = AsyncMock()
    manager.__aenter__.return_value = client
    with patch("sandbox_runtime.tracing.config.httpx.AsyncClient", return_value=manager):
        if invalid is None:
            assert (
                await ensure_trace_ready(tmp_path, "fresh", "http://localhost", tmp_path) == marker
            )
        else:
            with pytest.raises(RuntimeError, match="startup refused"):
                await ensure_trace_ready(tmp_path, "fresh", "http://localhost", tmp_path)


async def test_readiness_rejects_unvalidated_opencode_version(tmp_path):
    client = AsyncMock()
    client.get.return_value = MagicMock()
    client.get.return_value.json.return_value = {"version": "unvalidated-version"}
    manager = AsyncMock()
    manager.__aenter__.return_value = client
    with (
        patch("sandbox_runtime.tracing.config.httpx.AsyncClient", return_value=manager),
        pytest.raises(RuntimeError, match="requires OpenCode"),
    ):
        await ensure_trace_ready(tmp_path, "fresh", "http://localhost", tmp_path)
    assert client.get.call_count == 1
