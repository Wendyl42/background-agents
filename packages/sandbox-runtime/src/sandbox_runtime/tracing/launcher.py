#!/usr/bin/env python3
"""Direct executable bootstrap, also usable with Python -I for capability checks."""

import importlib.util
import json
import sys
from pathlib import Path

trace_dir = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "oi_execution_trace", trace_dir / "__init__.py", submodule_search_locations=[str(trace_dir)]
)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

from oi_execution_trace.collector import launch, probe_ptrace  # noqa: E402

if __name__ == "__main__":
    if sys.argv[1:] == ["--probe"]:
        result = probe_ptrace()
        print(json.dumps(result))
        raise SystemExit(0 if result["available"] else 1)
    raise SystemExit(launch(sys.argv[1:]))
