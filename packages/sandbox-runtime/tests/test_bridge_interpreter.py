"""A benchmark's Python can differ from the interpreter running the supervisor."""

import asyncio
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from sandbox_runtime.agent_bridge_process import AgentBridgeProcess


def test_bridge_uses_supervisor_interpreter(monkeypatch):
    process = SimpleNamespace(returncode=None)
    launch = AsyncMock(return_value=process)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    config = SimpleNamespace(
        sandbox_id="sandbox",
        session_id="session",
        control_plane_url="http://control-plane",
        sandbox_token="test-token",
    )
    bridge = AgentBridgeProcess(config, Mock())
    bridge._forward_logs = AsyncMock()
    asyncio.run(bridge.start())
    assert launch.call_args.args[:4] == (
        sys.executable,
        "-I" if sys.flags.isolated else "-P",
        "-m",
        "sandbox_runtime.bridge",
    )
