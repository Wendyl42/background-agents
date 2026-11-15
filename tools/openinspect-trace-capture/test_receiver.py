"""Durability, retry and budget failures must never certify a complete capture."""

import importlib.util
import json
import uuid
from pathlib import Path

import httpx
import pytest

spec = importlib.util.spec_from_file_location(
    "trace_receiver", Path(__file__).with_name("receiver.py")
)
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


def identity(boot="boot", session="root"):
    return {
        "run_id": "run",
        "attempt_id": "attempt",
        "runtime_boot_id": boot,
        "inspect_session_id": session,
        "mode": "process",
    }


def test_retries_are_byte_identical_and_recovery_reconciles_unindexed_tail(tmp_path):
    store = receiver.Store(tmp_path, "run", "attempt", 100)
    store.register(identity())
    name = "tools-" + "a" * 36 + ".jsonl"
    assert store.append("boot", name, 0, b"abc") == {"offset": 3}
    assert store.append("boot", name, 0, b"abc") == {"offset": 3}
    with pytest.raises(ValueError, match="Conflicting"):
        store.append("boot", name, 0, b"abd")
    with pytest.raises(ValueError, match="Noncontiguous"):
        store.append("boot", name, 9, b"d")
    with (tmp_path / "streams/boot" / name).open("ab") as output:
        output.write(b"partial")
    recovered = receiver.Store(tmp_path, "run", "attempt", 100)
    assert recovered.state["bytes"] == 10
    assert recovered.append("boot", name, 3, b"partial") == {"offset": 10}
    assert not recovered.state["boots"]["boot"]["finished"]


def test_receiver_limit_persists_loss_and_keeps_prefix(tmp_path):
    store = receiver.Store(tmp_path, "run", "attempt", 3)
    store.register(identity())
    name = "process-" + "b" * 36 + ".jsonl"
    store.append("boot", name, 0, b"abc")
    with pytest.raises(ValueError, match="byte limit"):
        store.append("boot", name, 3, b"d")
    result = json.loads((tmp_path / "capture.json").read_text())
    assert result["losses"] == [{"reason": "capture_byte_limit", "runtime_boot_id": "boot"}]
    assert (tmp_path / "streams/boot" / name).read_bytes() == b"abc"


def test_rejects_foreign_run_boot_changes_and_traversal(tmp_path):
    store = receiver.Store(tmp_path, "run", "attempt", 100)
    store.register(identity())
    for changed in [
        {**identity(), "run_id": "foreign"},
        identity(session="different"),
        identity(boot="../escape"),
    ]:
        with pytest.raises(ValueError):
            store.register(changed)
    with pytest.raises(ValueError):
        store.append("boot", "../../escape", 0, b"a")


def test_pending_budget_is_atomic_and_exhaustion_is_visible(tmp_path, monkeypatch):
    from sandbox_runtime.tracing.budget import reserve

    monkeypatch.setenv("OI_EXECUTION_TRACE_MANAGED", "1")
    reserve(tmp_path, "one", 2)
    reserve(tmp_path, "two", 2)
    with pytest.raises(RuntimeError, match="budget exhausted"):
        reserve(tmp_path, "three", 2)
    assert (tmp_path / "overflow.json").exists()
    assert len(list((tmp_path / "leases").iterdir())) == 2


def managed_fixture(tmp_path, monkeypatch, *, fail_loss=0):
    from sandbox_runtime.tracing.managed import DEFAULTS, ManagedCapture

    monkeypatch.setitem(DEFAULTS, "upload_poll_seconds", 0.001)
    monkeypatch.setitem(DEFAULTS, "upload_flush_seconds", 1)
    local = tmp_path / "local"
    local.mkdir()
    sink = receiver.Store(tmp_path / "sink", "run", "attempt", 1024 * 1024)
    sink.register(identity())
    calls = []
    losses = 0

    def handle(request):
        nonlocal losses
        path = request.url.path
        calls.append(path)
        if "/stream/" in path:
            result = sink.append(
                "boot", path.split("/")[-1], int(request.url.params["offset"]), request.content
            )
        elif path.endswith("/loss"):
            losses += 1
            if losses <= fail_loss:
                return httpx.Response(503)
            sink.loss("pending_stream_limit", "boot")
            result = {}
        elif path.endswith("/finish"):
            sink.state["boots"]["boot"]["finished"] = True
            sink.save()
            result = {}
        else:
            raise AssertionError(path)
        return httpx.Response(200, json=result)

    capture = ManagedCapture({"endpoint": "http://sink/token"}, local, identity())
    capture.client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle))
    return capture, sink, calls


@pytest.mark.asyncio
async def test_footer_across_chunks_is_drained_and_releases_lease(tmp_path, monkeypatch):
    from sandbox_runtime.tracing.managed import DEFAULTS

    capture, sink, calls = managed_fixture(tmp_path, monkeypatch)
    name = f"tools-{uuid.uuid4()}.jsonl"
    # The final JSON record begins before one chunk ends and finishes in the next.
    prefix = b'{"padding":"' + b"x" * (DEFAULTS["upload_chunk_bytes"] - 30) + b'"}\n'
    data = prefix + b'{"kind":"trace.close","complete":true,"reason":"dispose"}\n'
    path = capture.directory / name
    path.write_bytes(data)
    leases = capture.directory / "leases"
    leases.mkdir()
    (leases / "0").write_text(name)
    await capture.stop()
    assert not path.exists() and not list(leases.iterdir())
    assert sink.state["boots"]["boot"]["finished"]
    assert (sink.directory / "streams/boot" / name).read_bytes() == data
    assert calls[-1].endswith("/finish")


@pytest.mark.parametrize("fail_loss,finished", [(2, True), (10000, False)])
@pytest.mark.asyncio
async def test_finish_requires_loss_ack_even_after_last_file_was_deleted(
    tmp_path, monkeypatch, fail_loss, finished
):
    capture, sink, calls = managed_fixture(tmp_path, monkeypatch, fail_loss=fail_loss)
    (capture.directory / f"tools-{uuid.uuid4()}.jsonl").write_text(
        '{"kind":"trace.close","complete":true}\n'
    )
    (capture.directory / "overflow.json").write_text('{"reason":"pending_stream_limit"}')
    await capture.stop()
    assert not list(capture.directory.glob("*.jsonl"))
    assert sink.state["boots"]["boot"]["finished"] is finished
    assert any(path.endswith("/finish") for path in calls) is finished
    if finished:
        assert sink.state["losses"] == [
            {"reason": "pending_stream_limit", "runtime_boot_id": "boot"}
        ]
