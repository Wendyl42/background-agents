"""The capture subreaper must preserve a benchmark supervisor's isolated interpreter."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.tracing import reaper


@pytest.mark.parametrize("isolated", [True, False])
def test_reexec_preserves_isolated_mode(monkeypatch, isolated):
    libc = MagicMock()
    libc.prctl.return_value = 0
    monkeypatch.setattr(reaper.ctypes, "CDLL", lambda *args, **kwargs: libc)
    monkeypatch.setattr(reaper.os, "fork", lambda: 0)
    monkeypatch.setattr(
        reaper,
        "sys",
        SimpleNamespace(
            executable="/python",
            argv=["entrypoint.py", "--argument"],
            flags=SimpleNamespace(isolated=isolated),
        ),
    )
    monkeypatch.setenv("OI_EXECUTION_TRACE_REAPER", "test")
    execute = MagicMock(side_effect=RuntimeError("exec boundary"))
    monkeypatch.setattr(reaper.os, "execvp", execute)
    with pytest.raises(RuntimeError, match="exec boundary"):
        reaper.run()
    expected = [
        "/python",
        *(["-I"] if isolated else []),
        "-m",
        "sandbox_runtime.entrypoint",
        "--argument",
    ]
    execute.assert_called_once_with("/python", expected)
