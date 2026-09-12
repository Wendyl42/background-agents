#!/usr/bin/env python3
"""Exercise stopped-container recovery with actual new/deleted/binary/staged-ignored files."""

import argparse
import hashlib
import uuid

from artifacts import atomic_json
from common import external_root, read_json, run_command
from runner import snapshot_container


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lab-root")
    parser.add_argument("--task-id", required=True)
    args = parser.parse_args()
    lab = external_root(args.lab_root)
    runtime = read_json(lab / "task-workspaces" / args.task_id / "runtime-overlay/runtime.json")
    directory = lab / "runs" / f"stopped-capture-{uuid.uuid4().hex}"
    directory.mkdir(parents=True, mode=0o700)
    script = r"""
import json,os,subprocess,sys
from pathlib import Path
sys.path.insert(0,"/opt/oi-benchmark")
from artifacts import snapshot
t=json.loads(Path("/opt/oi-benchmark/task.json").read_text());p=Path(t["workspacePath"])
def git(*a):return subprocess.check_output(["git","-c",f"safe.directory={p}","-C",str(p),*a])
tracked=git("ls-files","-z").split(b"\0")
deleted=next(p/os.fsdecode(n) for n in tracked if n and (p/os.fsdecode(n)).is_file() and not (p/os.fsdecode(n)).is_symlink())
deleted.unlink()
(p/"oi-new-binary.bin").write_bytes(b"\0\xff\x01\x80")
(p/"oi-new-script.sh").write_text("echo capture\n");(p/"oi-new-script.sh").chmod(0o755)
ignore=p/".gitignore";ignore.write_text((ignore.read_text() if ignore.exists() else "")+"\n.oi-staged-hidden\n")
(p/".oi-staged-hidden").write_text("explicit staged ignored artifact\n");git("add","-f",".oi-staged-hidden")
sys.stdout.buffer.write(snapshot(p,t["baseCommit"]))
"""
    container = (
        run_command(
            [
                "docker",
                "create",
                "--network",
                "none",
                "--memory",
                "512m",
                "--cpus",
                "1",
                "--entrypoint",
                "/opt/oi-runtime/bin/python3.12",
                runtime["imageId"],
                "-S",
                "-c",
                script,
            ]
        )
        .decode()
        .strip()
    )
    try:
        expected = run_command(["docker", "start", "-a", container])
        actual = snapshot_container(
            {"containerId": container, "imageId": runtime["imageId"], "running": False}
        )
        assert actual == expected and b"delete" in actual and b"GIT binary patch" in actual
        assert b".oi-staged-hidden" in actual and b"100755" in actual
        (directory / "expected.patch").write_bytes(expected)
        (directory / "recovered.patch").write_bytes(actual)
        atomic_json(
            directory / "verification.json",
            {
                "passed": True,
                "imageId": runtime["imageId"],
                "patchSha256": hashlib.sha256(actual).hexdigest(),
                "bytes": len(actual),
                "cases": ["deletion", "new binary", "executable mode", "staged ignored file"],
                "modelPromptSubmitted": False,
            },
        )
    finally:
        run_command(["docker", "rm", "-f", container])
    print(directory)


if __name__ == "__main__":
    main()
