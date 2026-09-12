import contextlib
import io
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError

import api
import pytest
from artifacts import atomic_json
from common import READ_REQUEST_MAX_ATTEMPTS


class Response(io.BytesIO):
    def __init__(self, value):
        super().__init__(json.dumps(value).encode())
        self.headers = {"x-request-id": "server-request"}


@pytest.fixture
def client(tmp_path):
    path = tmp_path / "connection.json"
    atomic_json(
        path, {"controlPlaneUrl": "http://127.0.0.1:8788", "exportServiceSecret": "private-key"}
    )
    return api.Client(path)


def install_sequence(client, monkeypatch, results):
    requests = []

    def open_request(request, *, timeout):
        requests.append((request, timeout))
        result = results.pop(0)
        if isinstance(result, Exception):
            raise result
        return Response(result)

    monkeypatch.setattr(client.opener, "open", open_request)
    monkeypatch.setattr(api.time, "sleep", lambda _: None)
    return requests


def test_transient_get_recovers_with_fresh_signatures_and_safe_diagnostics(client, monkeypatch):
    requests = install_sequence(
        client, monkeypatch, [TimeoutError("secret error text"), {"children": []}]
    )
    assert client.request("/sessions/root/children?cursor=secret-query") == {"children": []}
    assert len(requests) == 2
    assert requests[0][0].get_header("X-openinspect-service-signature") != requests[1][
        0
    ].get_header("X-openinspect-service-signature")
    assert client.read_diagnostics == {"failures": 1, "retries": 1, "recoveredReads": 1}
    log = client.diagnostics_path.read_text()
    assert not any(
        secret in log for secret in ["private-key", "secret-query", "secret error text", "sig1."]
    )
    records = [json.loads(line) for line in log.splitlines()]
    assert [row["event"] for row in records] == [
        "started",
        "transport_error",
        "started",
        "completed",
    ]
    assert records[-1]["serverRequestId"] == "server-request"


def test_persistent_read_failure_is_bounded_and_names_endpoint(client, monkeypatch):
    requests = install_sequence(client, monkeypatch, [TimeoutError()] * READ_REQUEST_MAX_ATTEMPTS)
    with pytest.raises(RuntimeError, match=r"GET /sessions/root/children failed after .* attempts"):
        client.request("/sessions/root/children")
    assert len(requests) == READ_REQUEST_MAX_ATTEMPTS


@pytest.mark.parametrize(
    "error", [TimeoutError(), HTTPError("http://localhost", 503, "failed", {}, None)]
)
def test_mutations_are_never_retried(client, monkeypatch, error):
    requests = install_sequence(client, monkeypatch, [error])
    with pytest.raises(RuntimeError):
        client.request("/sessions/root/prompt", "POST", {"content": "private-prompt"})
    assert len(requests) == 1
    assert "private-prompt" not in client.diagnostics_path.read_text()


@pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 429])
def test_permanent_http_error_does_not_retry(client, monkeypatch, status):
    requests = install_sequence(
        client, monkeypatch, [HTTPError("http://localhost", status, "failed", {}, None)]
    )
    with pytest.raises(RuntimeError, match=f"HTTP {status}"):
        client.request("/sessions/root/messages")
    assert len(requests) == 1


def test_temporary_service_error_can_retry_a_read(client, monkeypatch):
    requests = install_sequence(
        client, monkeypatch, [HTTPError("http://localhost", 503, "failed", {}, None), {}]
    )
    assert client.request("/sessions/root/messages") == {}
    assert len(requests) == 2


def test_read_retries_cannot_extend_model_deadline(client, monkeypatch):
    clock = [1000]
    timeouts = []
    monkeypatch.setattr(api, "now_ms", lambda: clock[0])

    def timeout_request(request, *, timeout):
        timeouts.append(timeout)
        clock[0] += int(timeout * 1000)
        raise TimeoutError()

    monkeypatch.setattr(client.opener, "open", timeout_request)
    with (
        client.observation(deadline_at_ms=1250, stop_requested=lambda: False),
        pytest.raises(api.ReadDeadlineReached),
    ):
        client.request("/sessions/root/messages")
    assert timeouts == [0.25]
    assert client.read_deadline_at_ms is None


def test_safe_stop_interrupts_retry_and_releases_read_scope_for_cleanup(client, monkeypatch):
    stopped = [False]
    requests = []

    def timeout_request(request, *, timeout):
        requests.append(request)
        stopped[0] = True
        raise TimeoutError()

    monkeypatch.setattr(client.opener, "open", timeout_request)
    with (
        client.observation(deadline_at_ms=api.now_ms() + 60_000, stop_requested=lambda: stopped[0]),
        pytest.raises(api.ReadStopRequested),
    ):
        client.request("/sessions/root/children")
    assert len(requests) == 1
    assert client.read_stop_requested is None
    install_sequence(client, monkeypatch, [{}])
    assert client.request("/sessions/root/cancel", "POST", {}) == {}


def test_retried_pagination_keeps_each_page_once(client, monkeypatch):
    requests = install_sequence(
        client,
        monkeypatch,
        [
            {"messages": [{"id": "one"}], "hasMore": True, "cursor": "next"},
            TimeoutError(),
            {"messages": [{"id": "two"}], "hasMore": False},
        ],
    )
    assert client.pages("/sessions/root/messages", "messages") == [{"id": "one"}, {"id": "two"}]
    assert requests[1][0].full_url == requests[2][0].full_url


def test_real_loopback_read_timeout_recovers_without_an_extra_mutation(client, monkeypatch):
    count = [0]
    first_done = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            count[0] += 1
            if count[0] == 1:
                time.sleep(0.1)
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"messages": [], "hasMore": false}')
            first_done.set()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    client.base_url = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setattr(api, "REQUEST_TIMEOUT_SECONDS", 0.03)
    monkeypatch.setattr(api, "READ_RETRY_DELAY_SECONDS", 0.15)
    try:
        assert client.pages("/sessions/root/messages", "messages") == []
        assert count[0] == 2
        assert client.read_diagnostics["recoveredReads"] == 1
    finally:
        first_done.wait(1)
        server.shutdown()
        server.server_close()
        thread.join(1)
