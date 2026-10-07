"""Select a verified local upstream catalog; OpenCode owns all cost calculation."""

import hashlib
import json
from pathlib import Path

CATALOG_MANIFEST = Path(__file__).with_name("model_catalog_data") / "manifest.json"


def model_catalog_environment() -> dict[str, str]:
    manifest = json.loads(CATALOG_MANIFEST.read_text())
    name = manifest["file"]
    if not isinstance(name, str) or Path(name).name != name:
        raise ValueError("Invalid model catalog filename")
    path = CATALOG_MANIFEST.parent / name
    data = path.read_bytes()
    if len(data) != manifest["bytes"] or hashlib.sha256(data).hexdigest() != manifest["sha256"]:
        raise ValueError("Frozen model catalog checksum mismatch")
    return {
        "OPENCODE_MODELS_PATH": str(path.resolve()),
        "OPENCODE_DISABLE_MODELS_FETCH": "true",
    }
