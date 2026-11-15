"""Managed trace delivery for the existing local benchmark runner.

Keep the receiver alive through native container shutdown and reuse exact run/attempt
identities on coordinator resume. This module does not submit a model prompt.
"""

from __future__ import annotations

import importlib.util
import json
import secrets
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

_spec = importlib.util.spec_from_file_location(
    "oi_benchmark_receiver", Path(__file__).with_name("receiver.py")
)
_receiver = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_receiver)


class BenchmarkCapture:
    def __init__(self, directory, state, save, gateway, mode):
        self.directory = Path(directory) / "execution-capture"
        existing = state.get("executionTrace")
        run_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "openinspect:" + state["runId"]))
        attempt_id = str(uuid.uuid5(uuid.UUID(run_id), state["attemptId"]))
        old = urlsplit(existing["endpoint"]) if existing else None
        token = old.path.strip("/") if old else secrets.token_hex(32)
        self.store = _receiver.Store(
            self.directory, run_id, attempt_id, _receiver.DEFAULTS["max_capture_bytes"]
        )
        self.server = _receiver.serve(self.store, gateway, old.port if old else 0, token)
        self.config = {
            "mode": mode,
            "runId": run_id,
            "attemptId": attempt_id,
            "endpoint": f"http://{gateway}:{self.server.server_port}/{token}",
        }
        if existing and existing != self.config:
            self.server.server_close()
            raise ValueError("Capture identity/configuration changed during resume")
        state["executionTrace"] = self.config
        state["executionCapture"] = {"path": str(self.directory), "status": "collecting"}
        try:
            save()
            self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.thread.start()
        except BaseException:
            self.server.server_close()
            raise

    def await_root_ready(self, client, session_id, timeout_seconds):
        deadline_seconds = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline_seconds:
            page = client.request(f"/sessions/{session_id}/events?type=ready&limit=200")
            with self.store.lock:
                boots = dict(self.store.state["boots"])
            for event in page.get("events", []):
                boot_id = event.get("data", {}).get("runtimeBootId")
                identity = boots.get(boot_id, {}).get("identity", {})
                if (
                    identity.get("inspect_session_id") == session_id
                    and identity.get("mode") == self.config["mode"]
                    and not boots[boot_id].get("finished")
                ):
                    return
            if any(
                boot.get("finished")
                and boot.get("identity", {}).get("inspect_session_id") == session_id
                for boot in boots.values()
            ):
                raise RuntimeError(
                    "Measured root stopped before ready; model prompt was not submitted"
                )
            time.sleep(0.25)
        raise RuntimeError("Measured root did not become ready; model prompt was not submitted")

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        # Reading the persisted inventory also checks that the final receiver state exists.
        return json.loads((self.directory / "capture.json").read_text())
