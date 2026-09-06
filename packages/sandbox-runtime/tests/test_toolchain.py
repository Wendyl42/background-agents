import json
import subprocess
from pathlib import Path

from sandbox_runtime import toolchain


def test_source_digest_is_stable_and_detects_dirty_sources(tmp_path):
    (tmp_path / "module.py").write_text("a = 1")
    first = toolchain.runtime_source_digest(tmp_path)
    (tmp_path / "__pycache__").mkdir()
    (tmp_path / "__pycache__" / "module.pyc").write_bytes(b"ignored")
    assert toolchain.runtime_source_digest(tmp_path) == first
    (tmp_path / "module.py").write_text("a = 2")
    assert toolchain.runtime_source_digest(tmp_path) != first


def test_runtime_identity_never_spawns_version_processes(monkeypatch, tmp_path):
    def forbidden(*args, **kwargs):
        raise AssertionError("No subprocesses on the session startup path")

    monkeypatch.setattr(subprocess, "run", forbidden)
    path = tmp_path / "inventory.json"
    assert toolchain.runtime_identity(path)["inventory_status"] == "unavailable"
    path.write_text(json.dumps({"versions": {"node": "22.0.0"}}))
    identity = toolchain.runtime_identity(path)
    assert identity["resolved_toolchain"]["versions"]["node"] == "22.0.0"
    assert len(identity["runtime_source_sha256"]) == 64
    path.write_text("invalid")
    assert toolchain.runtime_identity(path)["inventory_status"] == "unavailable"


def test_smoke_checks_detect_version_drift_and_missing_dependencies():
    versions = {
        **{
            name: toolchain.TOOLCHAIN[name]
            for name in ("opencode", "code_server", "agent_browser", "ttyd")
        },
        "node": "22.0.0",
        "python": "3.12.0",
        "git": "2.0.0",
        "opencode_plugin": toolchain.TOOLCHAIN["opencode"],
        **{f"python:{name}": "1.0.0" for name in toolchain._PYTHON_PACKAGES},
    }
    assert toolchain.smoke_errors({"versions": versions}) == []
    versions["opencode"] = "0.0.0"
    versions["python:httpx"] = None
    errors = toolchain.smoke_errors({"versions": versions})
    assert any("opencode" in error for error in errors)
    assert "missing Python dependency: httpx" in errors


def test_modal_build_consumes_manifest_and_captures_versions_once():
    base_path = Path(__file__).parents[2] / "modal-infra/src/images/base.py"
    source = base_path.read_text()
    assert 'OPENCODE_VERSION = TOOLCHAIN["opencode"]' in source
    assert "--check --capture /app/oi-toolchain.json" in source
    assert "copy=True" in source
