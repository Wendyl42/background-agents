"""Run inside the runtime build stage to relocate ELF dependencies without changing task libraries."""

import shutil
import struct
import subprocess
from pathlib import Path

root = Path("/opt/oi-runtime")
root.mkdir(parents=True)
shutil.copytree("/usr/local", root, dirs_exist_ok=True, symlinks=True)
shutil.copytree("/lib/x86_64-linux-gnu", root / "syslib", symlinks=True)
shutil.copyfile("/lib64/ld-linux-x86-64.so.2", root / "ld.so")
(root / "ld.so").chmod(0o755)
for path in root.rglob("*"):
    if path.is_symlink() or not path.is_file() or path.name == "ld.so":
        continue
    if "node_modules" in path.parts:
        continue  # Bun standalone binaries embed data at fixed offsets; never rewrite them.
    with path.open("rb") as stream:
        header = stream.read(20)
        if header[:4] != b"\x7fELF" or struct.unpack("<H", header[16:18])[0] not in [2, 3]:
            continue
    # DT_RPATH also covers dependencies loaded by dependencies on older task distros.
    subprocess.run(
        [
            "/tmp/patchelf",
            "--force-rpath",
            "--set-rpath",
            "$ORIGIN:$ORIGIN/../lib:/opt/oi-runtime/lib:/opt/oi-runtime/syslib",
            str(path),
        ],
        check=True,
    )
    result = subprocess.run(
        ["/tmp/patchelf", "--print-interpreter", str(path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode == 0:
        subprocess.run(
            ["/tmp/patchelf", "--set-interpreter", "/opt/oi-runtime/ld.so", str(path)], check=True
        )

# npm-installed launchers use env node. The task retains its own node/python PATH;
# runtime-only wrappers select their matching interpreter explicitly.
tools = Path("/opt/oi-tools")
tools.mkdir()
source = Path("/usr/local/bin/opencode").resolve()
relocated = root / source.relative_to("/usr/local")
with source.open("rb") as stream:
    native = stream.read(4) == b"\x7fELF"
target = tools / "opencode"
if native:
    # npm's tree can vendor Python packages that overlap benchmark targets. Keep
    # that tree private; the standalone Bun executable needs only its own bytes.
    relocated = root / "bin/oi-opencode.exe"
    shutil.copyfile(source, relocated)
    relocated.chmod(0o755)
    target.write_text(
        f'#!/bin/sh\nexec /opt/oi-runtime/ld.so --library-path /opt/oi-runtime/syslib {relocated} "$@"\n'
    )
    target.chmod(0o755)
else:
    target.write_text(f'#!/bin/sh\nexec /opt/oi-runtime/bin/node {relocated} "$@"\n')
    target.chmod(0o755)
target = tools / "oi-bench"
target.write_text(
    '#!/bin/sh\nexec /opt/oi-runtime/bin/python3.12 /opt/oi-benchmark/artifacts.py "$@"\n'
)
target.chmod(0o755)
