"""Python sig1 client, checked against the shared package's immutable golden vectors."""

import hashlib
import hmac
import json
import secrets
import time
from contextlib import contextmanager
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from common import (
    READ_REQUEST_MAX_ATTEMPTS,
    READ_RETRY_DELAY_SECONDS,
    REQUEST_TIMEOUT_SECONDS,
    now_ms,
    read_json,
)


class ReadDeadlineReached(RuntimeError):
    """The existing model deadline expired while observing; do not extend it for retries."""


class ReadStopRequested(RuntimeError):
    """A safe stop was requested while observing."""


def signature_headers(
    secret,
    method,
    url,
    body=b"",
    *,
    timestamp_ms=None,
    nonce=None,
    actor="github:openinspect-benchmark",
    service="github-bot",
):
    parsed = urlsplit(url)
    timestamp_ms = now_ms() if timestamp_ms is None else timestamp_ms
    nonce = secrets.token_hex(8) if nonce is None else nonce
    pairs = sorted(
        parse_qsl(parsed.query, keep_blank_values=True),
        key=lambda pair: f"{pair[0]}\0{pair[1]}".encode(),
    )

    def encode(text):
        return quote(text, safe="~!*'()-._")

    query = "&".join(f"{encode(key)}={encode(value)}" for key, value in pairs)
    pathname = quote(parsed.path or "/", safe="/%:@-._~!$&'()*+,;=")
    canonical = (
        f"sig1\n{service}\n{timestamp_ms}\n{nonce}\n{method.upper()}\n"
        f"{pathname}\n{query}\n{hashlib.sha256(body).hexdigest()}\n{actor}"
    )
    signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {
        "X-OpenInspect-Service": service,
        "X-OpenInspect-Service-Signature": f"sig1.{timestamp_ms}.{nonce}.{signature}",
        **({"X-OpenInspect-Actor": actor} if actor else {}),
    }


class Client:
    def __init__(self, connection_file):
        connection = read_json(connection_file)
        self.base_url = connection["controlPlaneUrl"].rstrip("/")
        self.secret = connection["exportServiceSecret"]
        self.opener = build_opener(ProxyHandler({}))
        self.diagnostics_path = Path(connection_file).parent / "api-requests.jsonl"
        self.read_diagnostics = {"failures": 0, "retries": 0, "recoveredReads": 0}
        self.read_deadline_at_ms = None
        self.read_stop_requested = None

    @contextmanager
    def observation(self, *, deadline_at_ms, stop_requested):
        previous = self.read_deadline_at_ms, self.read_stop_requested
        self.read_deadline_at_ms, self.read_stop_requested = deadline_at_ms, stop_requested
        try:
            yield
        finally:
            self.read_deadline_at_ms, self.read_stop_requested = previous

    def read_timeout_seconds(self):
        if self.read_stop_requested and self.read_stop_requested():
            raise ReadStopRequested("Safe stop requested during observation")
        if self.read_deadline_at_ms is None:
            return REQUEST_TIMEOUT_SECONDS
        remaining_seconds = (self.read_deadline_at_ms - now_ms()) / 1000
        if remaining_seconds <= 0:
            raise ReadDeadlineReached("Model deadline reached during observation")
        return min(REQUEST_TIMEOUT_SECONDS, remaining_seconds)

    def record_request(self, record):
        # Never log payloads, query values, signatures, or response bodies.
        self.diagnostics_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.diagnostics_path.open("a") as output:
            output.write(json.dumps({"atMs": now_ms(), **record}) + "\n")

    def request(self, path, method="GET", payload=None):
        method = method.upper()
        data = (
            b""
            if payload is None
            else json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        )
        url = self.base_url + path
        max_attempts = READ_REQUEST_MAX_ATTEMPTS if method == "GET" else 1
        safe_path = path.split("?", 1)[0]
        for attempt in range(1, max_attempts + 1):
            timeout_seconds = (
                self.read_timeout_seconds() if method == "GET" else REQUEST_TIMEOUT_SECONDS
            )
            # Every attempt needs a fresh sig1 nonce; reusing signed requests is rejected.
            headers = signature_headers(self.secret, method, url, data)
            request_id = secrets.token_hex(8)
            request = Request(
                url,
                data=None if payload is None else data,
                method=method,
                headers={**headers, "Content-Type": "application/json", "X-Request-ID": request_id},
            )
            record = {
                "method": method,
                "path": safe_path,
                "attempt": attempt,
                "maxAttempts": max_attempts,
                "clientRequestId": request_id,
                "timeoutSeconds": timeout_seconds,
            }
            if method == "GET" and attempt > 1:
                self.read_diagnostics["retries"] += 1
            self.record_request({**record, "event": "started"})
            started_seconds = time.monotonic()
            try:
                with self.opener.open(request, timeout=timeout_seconds) as response:
                    result = json.load(response)
                    server_request_id = response.headers.get("x-request-id")
                self.record_request(
                    {
                        **record,
                        "event": "completed",
                        "elapsedSeconds": time.monotonic() - started_seconds,
                        "recovered": attempt > 1,
                        "serverRequestId": server_request_id,
                    }
                )
                if method == "GET":
                    if attempt > 1:
                        self.read_diagnostics["recoveredReads"] += 1
                    self.read_timeout_seconds()
                return result
            except HTTPError as error:
                status = error.code
                server_request_id = error.headers.get("x-request-id") if error.headers else None
                error.close()
                self.record_request(
                    {
                        **record,
                        "event": "http_error",
                        "httpStatus": status,
                        "serverRequestId": server_request_id,
                        "elapsedSeconds": time.monotonic() - started_seconds,
                    }
                )
                if path.endswith("/cancel") and status == 409:
                    return {"alreadyTerminal": True}
                if method != "GET" or status not in [502, 503, 504]:
                    raise RuntimeError(f"{method} {safe_path} returned HTTP {status}") from None
                reason = f"HTTP {status}"
            except (TimeoutError, ConnectionError, URLError, IncompleteRead) as error:
                reason = type(error).__name__
                cause = error.reason if isinstance(error, URLError) else error
                self.record_request(
                    {
                        **record,
                        "event": "transport_error",
                        "errorType": reason,
                        "causeType": type(cause).__name__,
                        "errno": getattr(cause, "errno", None),
                        "elapsedSeconds": time.monotonic() - started_seconds,
                    }
                )
                if method != "GET":
                    raise RuntimeError(
                        f"{method} {safe_path} failed ({reason}); mutation outcome unknown, no retry"
                    ) from error
            self.read_diagnostics["failures"] += 1
            remaining_seconds = self.read_timeout_seconds()
            if attempt == max_attempts:
                raise RuntimeError(
                    f"GET {safe_path} failed after {max_attempts} attempts ({reason}); see {self.diagnostics_path}"
                )
            time.sleep(min(READ_RETRY_DELAY_SECONDS, remaining_seconds))

    def pages(self, path, field):
        output, cursors, cursor = [], set(), None
        while True:
            suffix = "?limit=200" + ("&cursor=" + quote(cursor, safe="") if cursor else "")
            response = self.request(path + suffix)
            if not isinstance(response.get(field), list):
                raise ValueError(f"Missing {field} in paginated response")
            output.extend(response[field])
            if not response.get("hasMore"):
                return output
            cursor = response.get("cursor")
            if not isinstance(cursor, str) or not cursor or cursor in cursors:
                raise ValueError("Invalid/repeated pagination cursor")
            cursors.add(cursor)

    def tree(self, root_id):
        parents, queue = {root_id: None}, [root_id]
        while queue:
            parent_id = queue.pop(0)
            response = self.request(f"/sessions/{parent_id}/children")
            if response.get("hasMore"):
                raise ValueError("Children API requires unsupported pagination")
            for child in response["children"]:
                child_id = child["id"]
                if child_id in parents:
                    raise ValueError("Cycle or duplicate child in session tree")
                parents[child_id] = parent_id
                queue.append(child_id)
        return parents

    def find_title(self, title):
        matches, offset = [], 0
        while True:
            response = self.request(f"/sessions?limit=100&offset={offset}")
            matches.extend(item for item in response["sessions"] if item.get("title") == title)
            if not response.get("hasMore"):
                return matches
            offset += 100
