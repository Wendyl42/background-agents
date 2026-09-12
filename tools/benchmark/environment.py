"""Build and verify runtime overlays on sanitized benchmark environments."""

import json
import shutil
import zipfile

from artifacts import atomic_json
from common import ROOT, digest, read_json, run_command, safe_id

PATCHELF_VERSION = "0.17.2.4"
CORE_TAG = "openinspect-benchmark-runtime:local"


def build_core(lab_root, runtime_image):
    directory = lab_root / "cache/runtime-overlay"
    directory.mkdir(parents=True, exist_ok=True)
    wheels = list((lab_root / "cache/runtime-tools").glob(f"patchelf-{PATCHELF_VERSION}-*.whl"))
    if len(wheels) != 1:
        raise RuntimeError(
            f"Download patchelf=={PATCHELF_VERSION} to {lab_root / 'cache/runtime-tools'} first"
        )
    with zipfile.ZipFile(wheels[0]) as archive:
        entries = [name for name in archive.namelist() if name.endswith("/scripts/patchelf")]
        if len(entries) != 1:
            raise ValueError("Unexpected patchelf wheel contents")
        (directory / "patchelf").write_bytes(archive.read(entries[0]))
        (directory / "patchelf").chmod(0o755)
    shutil.copy2(ROOT / "tools/benchmark/relocate_runtime.py", directory)
    shutil.copytree(
        ROOT / "packages/sandbox-runtime/src/sandbox_runtime",
        directory / "runtime-source",
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    runtime_id = (
        run_command(["docker", "image", "inspect", runtime_image, "--format", "{{.Id}}"])
        .decode()
        .strip()
    )
    runtime_pin = "openinspect-benchmark-pin:" + runtime_id.removeprefix("sha256:")
    run_command(["docker", "tag", runtime_id, runtime_pin])
    (directory / "Dockerfile").write_text(f"""FROM {runtime_pin}
COPY patchelf /tmp/patchelf
COPY relocate_runtime.py /tmp/relocate_runtime.py
COPY runtime-source /opt/openinspect-runtime/src/sandbox_runtime
RUN python /tmp/relocate_runtime.py
RUN /opt/oi-runtime/bin/python3.12 -I -c 'import sandbox_runtime,ssl,cryptography,httpx,websockets,pydantic,jwt' && /opt/oi-tools/opencode --version
""")
    run_command(
        ["docker", "build", "--network", "none", "-t", CORE_TAG, str(directory)],
        log=directory / "build.log",
    )
    identity = (
        run_command(["docker", "image", "inspect", CORE_TAG, "--format", "{{.Id}}"])
        .decode()
        .strip()
    )
    result = {
        "imageId": identity,
        "runtimeSourceImageId": runtime_id,
        "patchelfVersion": PATCHELF_VERSION,
        "patchelfWheelSha256": digest(wheels[0]),
        "relocationScriptSha256": digest(directory / "relocate_runtime.py"),
        "runtimeSourceHashes": {
            str(path.relative_to(directory / "runtime-source")): digest(path)
            for path in sorted((directory / "runtime-source").rglob("*"))
            if path.is_file()
        },
    }
    atomic_json(directory / "core.json", result)
    return result


def build_task(lab_root, prepared, config):
    if not prepared.get("ready"):
        raise ValueError("Task preparation is not ready")
    task_id = safe_id(prepared["taskId"])
    core = read_json(lab_root / "cache/runtime-overlay/core.json")
    core_pin = "openinspect-benchmark-pin:" + core["imageId"].removeprefix("sha256:")
    task_pin = "openinspect-benchmark-pin:" + prepared["baseImage"].removeprefix("sha256:")
    run_command(["docker", "tag", core["imageId"], core_pin])
    run_command(["docker", "tag", prepared["baseImage"], task_pin])
    directory = lab_root / "task-workspaces" / task_id / "runtime-overlay"
    directory.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "tools/benchmark/artifacts.py", directory)
    shutil.copy2(ROOT / "tools/benchmark/launch_opencode.py", directory)
    shutil.copy2(ROOT / "tools/benchmark/configure_overlay.py", directory)
    task = {key: prepared[key] for key in ["taskId", "benchmark", "workspacePath", "baseCommit"]}
    atomic_json(directory / "task.json", task)
    gateway = json.loads(
        run_command(["docker", "network", "inspect", "bridge", "--format", "{{json .IPAM.Config}}"])
    )[0]["Gateway"]
    workdir = prepared["workspacePath"]
    if workdir not in ["/workspace/repo", "/workspace", "/testbed"]:
        raise ValueError("Unsupported prepared workspace location")
    # Benchmark Python/Node and system libraries remain in place; runtime ELF files
    # resolve only the relocated runtime libraries even on Alpine/musl images.
    workspace = (
        "RUN test ! -e /workspace || test -L /workspace || rmdir /workspace\nRUN ln -sfn /testbed /workspace\n"
        if workdir == "/testbed"
        else ""
    )
    (directory / "Dockerfile").write_text(f"""FROM {core_pin} AS oi
FROM {task_pin}
USER root
COPY --from=oi /opt/oi-runtime /opt/oi-runtime
COPY --from=oi /opt/oi-tools /opt/oi-tools
COPY --from=oi /opt/openinspect-runtime /opt/openinspect-runtime
COPY --from=oi /app/opencode-deps /app/opencode-deps
COPY --from=oi /app/oi-toolchain.json /app/oi-toolchain.json
RUN ln -s /opt/openinspect-runtime/src/sandbox_runtime /app/sandbox_runtime
COPY artifacts.py /opt/oi-benchmark/artifacts.py
COPY launch_opencode.py /opt/oi-benchmark/launch_opencode.py
COPY configure_overlay.py /opt/oi-benchmark/configure_overlay.py
COPY task.json /opt/oi-benchmark/task.json
ENV PATH="/opt/oi-tools:${{PATH}}" PYTHONUNBUFFERED=1 SANDBOX_VERSION=benchmark-v1
ENV SANDBOX_MAX_RESTARTS={config["runtimeMaxRestarts"]}
ENV OI_BENCH_ARTIFACT_URL="http://{gateway}:{config["artifactPort"]}"
{workspace}RUN git -C {workdir} rev-parse HEAD > /opt/oi-benchmark/base-commit
RUN git config --global --add safe.directory {workdir}
RUN /opt/oi-runtime/bin/python3.12 -I -c 'from pathlib import Path; p=Path("{workdir}/.git/info/exclude"); p.write_text(p.read_text()+"\\n.opencode/\\n")'
RUN /opt/oi-runtime/bin/python3.12 -I /opt/oi-benchmark/configure_overlay.py
RUN /opt/oi-runtime/bin/python3.12 -I -c 'import sandbox_runtime,ssl,cryptography,httpx,websockets,pydantic,jwt' && opencode --version
WORKDIR /workspace
ENTRYPOINT ["/opt/oi-tools/python-runtime", "-m", "sandbox_runtime.entrypoint"]
""")
    tag = "openinspect-benchmark-task:" + task_id.lower()
    run_command(
        ["docker", "build", "--network", "none", "-t", tag, str(directory)],
        log=directory / "build.log",
    )
    identity = (
        run_command(["docker", "image", "inspect", tag, "--format", "{{.Id}}"]).decode().strip()
    )
    run_command(
        ["docker", "tag", identity, "openinspect-benchmark-pin:" + identity.removeprefix("sha256:")]
    )
    base = (
        run_command(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--entrypoint",
                "git",
                identity,
                "-C",
                workdir,
                "rev-parse",
                "HEAD",
            ]
        )
        .decode()
        .strip()
    )
    if base != prepared["baseCommit"]:
        raise ValueError("Runtime overlay changed the task base")
    result = {
        "imageId": identity,
        "imageTag": tag,
        "taskId": task_id,
        "preparedSha256": digest(lab_root / "task-workspaces" / task_id / "prepared.json"),
        "core": core,
        "taskBaseCommit": base,
        "artifactScriptSha256": digest(directory / "artifacts.py"),
        "agentLauncherSha256": digest(directory / "launch_opencode.py"),
        "agentIdentity": {
            "uid": 10001,
            "gid": 10001,
            "noNewPrivileges": True,
            "privateRuntimePackages": "/opt/oi-runtime/lib/python3.12/site-packages",
        },
        "dockerfileSha256": digest(directory / "Dockerfile"),
        "ready": True,
        "testEnvironmentParity": "pending replay of baseline/reference under overlay",
    }
    atomic_json(directory / "runtime.json", result)
    return result
