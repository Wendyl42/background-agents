"""Install the opt-in OpenCode measurement plugin without modifying tool arguments."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

from ..toolchain import TOOLCHAIN

if TYPE_CHECKING:
    from collections.abc import Mapping
    from typing import Any

PLUGIN_NAME = "execution-trace.js"
DEFAULTS_PATH = Path(__file__).with_name("defaults.json")
DEFAULTS = json.loads(DEFAULTS_PATH.read_text())
DISPOSE_TIMEOUT_SECONDS = DEFAULTS["dispose_timeout_seconds"]
READY_TIMEOUT_SECONDS = DEFAULTS["ready_timeout_seconds"]
READY_POLL_SECONDS = DEFAULTS["ready_poll_seconds"]


async def ensure_trace_ready(
    directory: Path, handshake: str, base_url: str, workdir: Path
) -> dict[str, Any]:
    """Force project plugin initialization, then verify a fresh persisted stream.

    OpenCode swallows failed plugins. HTTP health alone must never authorize a
    prompt when instrumentation was explicitly requested.
    """
    try:
        async with asyncio.timeout(READY_TIMEOUT_SECONDS):
            async with httpx.AsyncClient(timeout=READY_TIMEOUT_SECONDS) as client:
                health = await client.get(f"{base_url}/global/health")
                health.raise_for_status()
                observed_version = health.json().get("version")
                if observed_version != TOOLCHAIN["opencode"]:
                    raise RuntimeError(
                        f"Execution tracing requires OpenCode {TOOLCHAIN['opencode']}; observed {observed_version!r}"
                    )
                response = await client.get(
                    f"{base_url}/config", params={"directory": str(workdir)}
                )
                response.raise_for_status()
                effective_config = response.json()
            while True:
                for marker in directory.glob(f"ready-{handshake}-*.json"):
                    try:
                        data = json.loads(marker.read_text())
                        name = data["stream_file"]
                        if not isinstance(name, str) or Path(name).name != name:
                            continue
                        with (directory / name).open() as stream:
                            first = json.loads(stream.readline())
                        if (
                            data.get("handshake") == handshake
                            and first.get("handshake") == handshake
                            and first.get("kind") == "trace.open"
                            and first.get("schema") == DEFAULTS["schema"]
                            and first.get("stream_id") == data.get("stream_id")
                            and data.get("project_directory") == str(workdir.resolve())
                            and first.get("context", {}).get("project_directory")
                            == str(workdir.resolve())
                            and (
                                first.get("mode") != "process"
                                or (
                                    isinstance(data.get("wrapper_shell"), str)
                                    and effective_config.get("shell") == data["wrapper_shell"]
                                    and Path(data.get("real_shell", "")).name == "bash"
                                )
                            )
                        ):
                            return data
                    except (OSError, ValueError, KeyError, TypeError):
                        pass  # The unique marker may still be in its first write.
                await asyncio.sleep(READY_POLL_SECONDS)
    except (TimeoutError, httpx.HTTPError) as error:
        raise RuntimeError(
            "Execution tracing did not become ready; agent startup refused"
        ) from error


def configure_execution_trace(
    workdir: Path, environment: Mapping[str, str], opencode_config: dict[str, Any]
) -> tuple[dict[str, str], set[str]]:
    """Return child environment additions and runtime-owned installed paths.

    Missing/off mode has no filesystem effects. Explicit invalid configuration fails
    before OpenCode starts so an experiment cannot silently run without measurements.
    """
    mode = environment.get("OI_EXECUTION_TRACE_MODE", "off")
    if mode == "off":
        return {}, set()
    if mode not in ("tools", "process"):
        raise ValueError("OI_EXECUTION_TRACE_MODE supports off, tools or process")
    root = Path(environment.get("OI_EXECUTION_TRACE_DIR", ""))
    if not root.is_absolute():
        raise ValueError("OI_EXECUTION_TRACE_DIR must be an absolute persistent directory")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Exclusive open catches unwritable/misconfigured mounts before launching the agent.
    import tempfile

    with tempfile.TemporaryFile(dir=root):
        pass
    source = Path(__file__).parent.parent / "plugins" / PLUGIN_NAME
    destination = workdir / ".opencode" / "plugins" / PLUGIN_NAME
    # A global explicit file plugin covers alternate native project instances too.
    # Remove only an older runtime-owned project copy, avoiding duplicate hooks.
    if destination.is_file() and destination.read_text().startswith(
        "/** Execution evidence is append-only;"
    ):
        destination.unlink()
    spec = source.resolve().as_uri()
    plugins = list(opencode_config.get("plugin", []))
    if spec not in plugins:
        plugins.append(spec)
    opencode_config["plugin"] = plugins
    additions = {
        "OI_EXECUTION_TRACE_DIR": str(root),
        "OI_EXECUTION_TRACE_MODE": mode,
        "OI_EXECUTION_TRACE_DEFAULTS": os.fspath(DEFAULTS_PATH),
        "OI_EXECUTION_TRACE_CLOCK_HELPER": os.fspath(Path(__file__).with_name("clock.py")),
        "OI_EXECUTION_TRACE_PYTHON": sys.executable,
        "OI_EXECUTION_TRACE_HANDSHAKE": str(uuid.uuid4()),
    }
    if mode == "process":
        shell = opencode_config.get("shell") or "bash"
        resolved = shutil.which(shell, path=environment.get("PATH"))
        if not resolved or Path(resolved).name != "bash":
            raise ValueError("Process tracing currently requires Bash as the selected shell")
        launcher = Path(__file__).with_name("launcher.py")
        probe = subprocess.run(
            [sys.executable, "-I", "-S", str(launcher), "--probe"],
            capture_output=True,
            text=True,
            timeout=DEFAULTS["ptrace_probe_timeout_seconds"],
            check=False,
        )
        if probe.returncode != 0:
            raise RuntimeError(
                "Process tracing unavailable: child PTRACE_SEIZE or orphan-reaper probe failed (Docker requires --init)"
            )
        bin_dir = root / "launchers" / additions["OI_EXECUTION_TRACE_HANDSHAKE"]
        bin_dir.mkdir(parents=True, mode=0o700)
        wrapper = bin_dir / "bash"
        wrapper.write_text(
            f"#!{sys.executable} -IS\nimport runpy\n"
            f"runpy.run_path({str(launcher)!r}, run_name='__main__')\n"
        )
        wrapper.chmod(0o700)
        additions["OI_EXECUTION_TRACE_REAL_SHELL"] = resolved
        additions["OI_EXECUTION_TRACE_WRAPPER_SHELL"] = str(wrapper)
    return additions, set()
