#!/usr/bin/env python3
"""Exercise receiver disconnect/restart and whole-container SIGKILL with real OpenCode."""

import argparse
import importlib.util
import json
import secrets
import subprocess
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).parents[2].resolve()
spec = importlib.util.spec_from_file_location("receiver", Path(__file__).with_name("receiver.py"))
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


def main(output):
    output.mkdir(mode=0o700)
    host = subprocess.check_output(
        [
            "docker",
            "network",
            "inspect",
            "bridge",
            "--format",
            "{{(index .IPAM.Config 0).Gateway}}",
        ],
        text=True,
    ).strip()
    results = []
    for scenario in ("disconnect", "kill"):
        directory = output / scenario
        run_id, attempt_id = str(uuid.uuid4()), str(uuid.uuid4())
        store = receiver.Store(
            directory / "capture", run_id, attempt_id, receiver.DEFAULTS["max_capture_bytes"]
        )
        token = secrets.token_hex(32)
        server = receiver.serve(store, host, 0, token)
        port = server.server_port
        threading.Thread(target=server.serve_forever, daemon=True).start()
        name = "oi-trace-transport-" + uuid.uuid4().hex
        session = "p3-transport-" + scenario
        command = [
            "docker",
            "run",
            "--init",
            "--name",
            name,
            "--mount",
            f"type=bind,source={ROOT},target=/repo,readonly",
            "--entrypoint",
            "python3",
            "openinspect-runtime:opensandbox",
            "/repo/tools/openinspect-trace-capture/managed_probe.py",
            "--endpoint",
            f"http://{host}:{port}/{token}",
            "--run-id",
            run_id,
            "--attempt-id",
            attempt_id,
            "--session",
            session,
            "--command-seconds",
            "4" if scenario == "disconnect" else "30",
        ]
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        try:
            deadline_seconds = time.monotonic() + 40
            while time.monotonic() < deadline_seconds:
                files = list((directory / "capture/streams").glob("*/*.jsonl"))
                if any(b'"process.exec"' in file.read_bytes() for file in files):
                    break
                assert process.poll() is None, "Runtime exited before fault injection"
                time.sleep(0.05)
            else:
                raise AssertionError("No persisted process execution before deadline")
            if scenario == "disconnect":
                server.shutdown()
                server.server_close()
                time.sleep(0.75)
                store = receiver.Store(
                    directory / "capture",
                    run_id,
                    attempt_id,
                    receiver.DEFAULTS["max_capture_bytes"],
                )
                server = receiver.serve(store, host, port, token)
                threading.Thread(target=server.serve_forever, daemon=True).start()
            else:
                subprocess.run(
                    ["docker", "kill", "--signal", "KILL", name],
                    check=True,
                    stdout=subprocess.DEVNULL,
                )
            stdout, stderr = process.communicate(timeout=60)
            (directory / "runtime-result.json").write_text(
                json.dumps(
                    {"exit": process.returncode, "stdout": stdout, "stderr": stderr}, indent=2
                )
            )
            state = json.loads((directory / "capture/capture.json").read_text())
            finished = all(boot["finished"] for boot in state["boots"].values())
            assert len(state["boots"]) == 1 and state["bytes"] > 0
            if scenario == "disconnect":
                assert process.returncode == 0 and finished, (stdout, stderr, state)
            else:
                assert process.returncode == 137 and not finished
            results.append(
                {
                    "scenario": scenario,
                    "status": "pass",
                    "finished": finished,
                    "durable_bytes": state["bytes"],
                    "external_model_calls": 0,
                }
            )
            print(json.dumps(results[-1]), flush=True)
        finally:
            subprocess.run(
                ["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            server.shutdown()
            server.server_close()
    (output / "result.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    main(parser.parse_args().out.resolve())
