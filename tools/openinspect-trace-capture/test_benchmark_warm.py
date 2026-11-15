"""Reject echoed command text as evidence of a successful native shell probe."""

import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "warm_probe", Path(__file__).with_name("benchmark_warm.py")
)
warm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(warm)


def response(output, exit_code=0):
    return {
        "parts": [
            {
                "type": "tool",
                "state": {
                    "status": "completed",
                    "input": {"command": "TRACE_UID=10001; 128 vet; printf TRACE_READY"},
                    "output": output,
                    "metadata": {"exit": exit_code},
                },
            }
        ]
    }


def test_echoed_input_does_not_prove_shell_success():
    with pytest.raises(RuntimeError, match="Actual shell output"):
        warm.verify_shell_result(response("go: command not found\n", 1), go_probe=True)


@pytest.mark.parametrize(
    "output,code",
    [
        ('TRACE_UID=10001\n{"ok":true,"commands":128}\nTRACE_READY\n', 1),
        ('TRACE_UID=0\n{"ok":true,"commands":128}\nTRACE_READY\n', 0),
        ('TRACE_UID=10001\n{"ok":true,"commands":127}\nTRACE_READY\n', 0),
    ],
)
def test_wrong_exit_uid_or_oracle_count_fails(output, code):
    with pytest.raises(RuntimeError):
        warm.verify_shell_result(response(output, code), go_probe=True)


def test_real_output_and_exit_are_accepted():
    output = 'TRACE_UID=10001\n{"ok":true,"commands":128}\nTRACE_READY\n'
    assert warm.verify_shell_result(response(output), go_probe=True)["api_exit_code"] == 0


def test_complete_capture_without_vet_execution_is_not_a_stress_pass(tmp_path):
    directory = tmp_path / "streams/boot"
    directory.mkdir(parents=True)
    rows = [
        {"kind": "shell.bind", "process_instance_id": "shell"},
        {"kind": "process.exit", "process_instance_id": "shell", "exit_code": 0},
    ]
    (directory / "process-example.jsonl").write_text(
        "".join(json.dumps(row) + "\n" for row in rows)
    )
    with pytest.raises(RuntimeError, match="128 successful vet"):
        warm.verify_process_result(tmp_path, go_probe=True)
