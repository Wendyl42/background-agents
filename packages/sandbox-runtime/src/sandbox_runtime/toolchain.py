"""Shared build pins, offline smoke checks, and non-secret runtime provenance.

Capture resolved versions at IMAGE BUILD time, never on the session critical path.
The manifest pins key tools, not every apt/npm dependency; an immutable image
identifier plus the resolved inventory is still needed for reproducible experiments.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import platform
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

RUNTIME_DIR = Path(__file__).parent
TOOLCHAIN = json.loads((RUNTIME_DIR / "toolchain.json").read_text())
RESOLVED_TOOLCHAIN_PATH = Path("/app/oi-toolchain.json")
VERSION_CHECK_TIMEOUT_SECONDS = 15
_VERSION_COMMANDS = {
    "node": ["node", "--version"],
    "opencode": ["opencode", "--version"],
    "code_server": ["code-server", "--version"],
    "agent_browser": ["agent-browser", "--version"],
    "ttyd": ["ttyd", "--version"],
    "git": ["git", "--version"],
    "pnpm": ["pnpm", "--version"],
    "bun": ["bun", "--version"],
    "uv": ["uv", "--version"],
}
_PYTHON_PACKAGES = ("httpx", "websockets", "pydantic", "PyJWT", "cryptography")


def runtime_source_digest(root: Path = RUNTIME_DIR) -> str:
    """Content identity includes dirty source changes; excludes interpreter caches."""
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def capture_toolchain() -> dict[str, Any]:
    versions: dict[str, str | None] = {"python": platform.python_version()}
    for name, command in _VERSION_COMMANDS.items():
        versions[name] = None
        if not shutil.which(command[0]):
            continue
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=VERSION_CHECK_TIMEOUT_SECONDS,
                check=False,
            )
            if result.returncode == 0:
                # Store only a version, not arbitrary tool stdout/environment data.
                match = re.search(r"\b(?:v)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)", result.stdout)
                if match:
                    versions[name] = match.group(1)
        except (OSError, subprocess.TimeoutExpired):
            pass
    for package in _PYTHON_PACKAGES:
        try:
            versions[f"python:{package}"] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[f"python:{package}"] = None
    versions["opencode_plugin"] = None
    if shutil.which("npm"):
        try:
            result = subprocess.run(
                ["npm", "list", "--global", "--depth=0", "--json"],
                capture_output=True,
                text=True,
                timeout=VERSION_CHECK_TIMEOUT_SECONDS,
                check=False,
            )
            packages = json.loads(result.stdout).get("dependencies", {})
            versions["opencode_plugin"] = packages.get("@opencode-ai/plugin", {}).get("version")
        except (OSError, subprocess.TimeoutExpired, ValueError, AttributeError):
            pass
    return {"schema_version": 1, "versions": versions}


def smoke_errors(inventory: dict[str, Any]) -> list[str]:
    versions = inventory["versions"]
    errors = []
    for tool in ("opencode", "code_server", "agent_browser", "ttyd"):
        if versions.get(tool) != TOOLCHAIN[tool]:
            errors.append(f"{tool}: expected {TOOLCHAIN[tool]}, found {versions.get(tool)}")
    if versions.get("opencode_plugin") != TOOLCHAIN["opencode"]:
        errors.append("OpenCode CLI and plugin must use the same manifest pin")
    if (versions.get("node") or "").split(".")[0] != TOOLCHAIN["node_major"]:
        errors.append(f"node: expected major {TOOLCHAIN['node_major']}")
    if tuple(int(part) for part in versions["python"].split(".")[:2]) < tuple(
        int(part) for part in TOOLCHAIN["python_series"].split(".")
    ):
        errors.append(f"python: requires >={TOOLCHAIN['python_series']}")
    for package in _PYTHON_PACKAGES:
        if not versions.get(f"python:{package}"):
            errors.append(f"missing Python dependency: {package}")
    for module in (
        "sandbox_runtime.entrypoint",
        "sandbox_runtime.credentials.git_credential_helper",
    ):
        if importlib.util.find_spec(module) is None:
            errors.append(f"missing runtime module: {module}")
    if not versions.get("git"):
        errors.append("git is required")
    return errors


def runtime_identity(inventory_path: Path = RESOLVED_TOOLCHAIN_PATH) -> dict[str, Any]:
    """No subprocesses or network requests during session startup."""
    try:
        inventory = json.loads(inventory_path.read_text())
    except (OSError, ValueError):
        inventory = None
    return {
        "runtime_source_sha256": runtime_source_digest(),
        "declared_toolchain": TOOLCHAIN,
        "resolved_toolchain": inventory,
        "inventory_status": "available" if inventory is not None else "unavailable",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", type=Path, help="Write a build-time resolved tool inventory")
    parser.add_argument(
        "--check", action="store_true", help="Validate tools without starting an agent"
    )
    args = parser.parse_args()
    inventory = capture_toolchain()
    if args.check:
        errors = smoke_errors(inventory)
        if errors:
            parser.exit(1, "\n".join(errors) + "\n")
    if args.capture:
        args.capture.write_text(json.dumps(inventory, sort_keys=True) + "\n")
    else:
        print(json.dumps(inventory, sort_keys=True))


if __name__ == "__main__":
    main()
