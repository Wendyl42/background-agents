import json

import pytest

from sandbox_runtime import model_catalog


def test_local_catalog_selection_matches_upstream_snapshot():
    env = model_catalog.model_catalog_environment()
    assert env["OPENCODE_DISABLE_MODELS_FETCH"] == "true"
    from pathlib import Path

    catalog = json.loads(Path(env["OPENCODE_MODELS_PATH"]).read_text())
    assert catalog["deepseek"]["models"]["deepseek-flash"]["id"] == "deepseek-flash"


def test_corrupt_or_missing_catalog_fails_instead_of_falling_back(tmp_path, monkeypatch):
    original = json.loads(model_catalog.CATALOG_MANIFEST.read_text())
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps(original))
    monkeypatch.setattr(model_catalog, "CATALOG_MANIFEST", manifest)
    with pytest.raises(FileNotFoundError):
        model_catalog.model_catalog_environment()
    (tmp_path / original["file"]).write_text("{}")
    with pytest.raises(ValueError, match="checksum"):
        model_catalog.model_catalog_environment()
