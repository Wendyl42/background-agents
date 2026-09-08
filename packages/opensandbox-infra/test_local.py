"""Focused cleanup/observation boundary tests; no Docker daemon required."""

import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, call, patch

import collect
import local


def response(data):
    return io.BytesIO(json.dumps(data).encode())


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.settings = patch.object(
            local,
            "settings",
            return_value={"api_url": "http://localhost:8090", "api_key": "private"},
        )
        self.settings.start()
        self.addCleanup(self.settings.stop)

    def test_down_deletes_owned_sandboxes_before_server(self):
        opener = Mock()
        opener.open.side_effect = [
            response(
                {
                    "items": [
                        {"id": "sandbox/id", "metadata": {"openinspect_framework": "open-inspect"}}
                    ]
                }
            ),
            io.BytesIO(),
            response({"items": []}),
        ]
        with (
            patch.object(local.urllib.request, "build_opener", return_value=opener),
            patch.object(local.subprocess, "check_output", return_value="server-id\n"),
            patch.object(local, "run") as run,
        ):
            local.down()
        deletion = opener.open.call_args_list[1].args[0]
        self.assertEqual(deletion.method, "DELETE")
        self.assertTrue(deletion.full_url.endswith("sandbox%2Fid"))
        run.assert_called_once_with("docker", "rm", "-f", "server-id")

    def test_auth_failure_does_not_delete_server_or_bypass_api(self):
        opener = Mock()
        opener.open.side_effect = urllib.error.HTTPError(
            "http://localhost", 403, "Forbidden", {}, None
        )
        with (
            patch.object(local.urllib.request, "build_opener", return_value=opener),
            patch.object(local, "run") as run,
            self.assertRaises(urllib.error.HTTPError),
        ):
            local.down()
        run.assert_not_called()

    def test_unreachable_server_fallback_uses_exact_ownership_filter(self):
        opener = Mock()
        opener.open.side_effect = ConnectionRefusedError()
        with (
            patch.object(local.urllib.request, "build_opener", return_value=opener),
            patch.object(
                local.subprocess, "check_output", side_effect=["owned-id\n", "server-id\n"]
            ) as output,
            patch.object(local, "run") as run,
        ):
            local.down()
        self.assertIn("label=openinspect_framework=open-inspect", output.call_args_list[0].args[0])
        self.assertEqual(
            run.call_args_list,
            [call("docker", "rm", "-f", "owned-id"), call("docker", "rm", "-f", "server-id")],
        )

    def test_foreign_metadata_is_rejected_without_deleting(self):
        opener = Mock()
        opener.open.return_value = response({"items": [{"id": "foreign", "metadata": {}}]})
        with (
            patch.object(local.urllib.request, "build_opener", return_value=opener),
            patch.object(local, "run") as run,
            self.assertRaises(RuntimeError),
        ):
            local.down()
        run.assert_not_called()


class ObservationTests(unittest.TestCase):
    def test_observation_refreshes_pid_without_environment_or_command_arguments(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "observations"
            collector = collect.Collector(output)
            detail = {
                "Config": {
                    "Env": ["API_KEY=secret-canary"],
                    "Cmd": ["secret-canary"],
                    "Labels": {
                        "openinspect_session_id": "session",
                        "opensandbox.io/id": "provider",
                    },
                },
                "State": {"Pid": 0, "Running": False},
                "HostConfig": {"Memory": 1024, "NanoCpus": 500_000_000},
                "Image": "sha256:abc",
            }
            stats = {"memory_stats": {"usage": 42}, "cpu_stats": {"cpu_usage": {"total_usage": 17}}}
            with (
                patch.object(
                    collect,
                    "docker_json",
                    side_effect=[
                        detail,
                        detail,
                        stats,
                        {
                            "Titles": ["PID", "PPID", "COMMAND"],
                            "Processes": [["123", "1", "python"]],
                        },
                    ],
                ),
                patch.object(collector, "stream") as stream,
            ):
                collector.observe({"Id": "container"}, "sandbox")
                stream.assert_not_called()
                detail["State"].update(Pid=123, Running=True)
                collector.observe({"Id": "container"}, "sandbox")
                stream.assert_called_once()
            collector.close()
            text = (output / "host.jsonl").read_text()
            self.assertNotIn("secret-canary", text)
            records = [json.loads(line) for line in text.splitlines()]
            self.assertEqual(records[0]["host_pid"], 0)
            self.assertEqual(records[1]["host_pid"], 123)
            self.assertEqual(records[2]["memory_stats"]["usage"], 42)

    def test_exec_event_does_not_record_arguments(self):
        with tempfile.TemporaryDirectory() as temp:
            collector = collect.Collector(Path(temp) / "observations")
            process = Mock(
                stdout=io.StringIO(
                    json.dumps(
                        {
                            "Action": "exec_create: echo secret-canary",
                            "Actor": {
                                "ID": "container",
                                "Attributes": {
                                    "execID": "opaque",
                                    "openinspect_session_id": "session",
                                },
                            },
                        }
                    )
                    + "\n"
                )
            )
            with patch.object(collect.subprocess, "Popen", return_value=process):
                collector.stream(["events"], "host", {})
                collector.threads[0].join()
            collector.close()
            text = (Path(temp) / "observations" / "host.jsonl").read_text()
            self.assertNotIn("secret-canary", text)
            self.assertEqual(json.loads(text)["action"], "exec_create")


if __name__ == "__main__":
    unittest.main()
