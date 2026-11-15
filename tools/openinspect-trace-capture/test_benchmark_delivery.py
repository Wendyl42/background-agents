"""A persisted ready event must not authorize work after its runtime has stopped."""

import importlib.util
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

spec = importlib.util.spec_from_file_location(
    "benchmark_delivery_test_subject", Path(__file__).with_name("benchmark_delivery.py")
)
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


@pytest.mark.parametrize(
    ("finished", "mode", "has_ready", "accepted"),
    [
        (False, "process", True, True),
        (True, "process", True, False),
        (True, "process", False, False),
        (False, "tools", True, False),
        (False, "process", False, False),
    ],
)
def test_readiness_rejects_finished_or_unmeasured_runtime(finished, mode, has_ready, accepted):
    capture = delivery.BenchmarkCapture.__new__(delivery.BenchmarkCapture)
    capture.config = {"mode": "process"}
    capture.store = SimpleNamespace(
        lock=threading.Lock(),
        state={
            "boots": {
                "boot": {
                    "identity": {"inspect_session_id": "root", "mode": mode},
                    "finished": finished,
                }
            }
        },
    )
    client = Mock()
    client.request.return_value = {
        "events": [{"data": {"runtimeBootId": "boot"}}] if has_ready else []
    }
    with (
        patch.object(delivery.time, "monotonic", side_effect=[0, 0, 2]),
        patch.object(delivery.time, "sleep"),
    ):
        if accepted:
            capture.await_root_ready(client, "root", 1)
        else:
            with pytest.raises(RuntimeError, match="model prompt was not submitted"):
                capture.await_root_ready(client, "root", 1)
