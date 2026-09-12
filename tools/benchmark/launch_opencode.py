"""Keep runtime-only Python dependency implementations outside the agent's readable files."""

import ctypes
import json
import os
import sys
from pathlib import Path

AGENT_UID = 10001
AGENT_GID = 10001
AGENT_HOME = Path("/home/oi-agent")
PRIVATE_PACKAGES = Path("/opt/oi-runtime/lib/python3.12/site-packages")


def assign_owner(path):
    current = path.lstat()
    if (current.st_uid, current.st_gid) != (AGENT_UID, AGENT_GID):
        os.chown(path, AGENT_UID, AGENT_GID, follow_symlinks=False)


def launch():
    task = json.loads(Path("/opt/oi-benchmark/task.json").read_text())
    if os.geteuid() == 0:
        PRIVATE_PACKAGES.chmod(0o700)
        Path("/opt/oi-runtime/lib/node_modules").chmod(0o700)
        AGENT_HOME.mkdir(parents=True, exist_ok=True)
        # The supervisor stages custom tools as root immediately before startup.
        # Transfer ownership of task code and its private home, preserving file modes.
        for base in [Path(task["workspacePath"]), Path("/workspace/.opencode"), AGENT_HOME]:
            if not base.exists():
                continue
            if base.is_symlink():
                raise RuntimeError("Benchmark ownership root must be a directory, not a symlink")
            assign_owner(base)
            for directory, children, files in os.walk(base, followlinks=False):
                for name in [*children, *files]:
                    assign_owner(Path(directory) / name)
        # Prevent setuid executables from regaining access to supervisor-private files.
        if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "Could not set no_new_privs")
        os.setgroups([])
        os.setgid(AGENT_GID)
        os.setuid(AGENT_UID)
    if os.geteuid() != AGENT_UID:
        raise RuntimeError("Unexpected benchmark agent identity")
    environment = {
        **os.environ,
        "HOME": str(AGENT_HOME),
        "XDG_CONFIG_HOME": str(AGENT_HOME / ".config"),
        "XDG_CACHE_HOME": str(AGENT_HOME / ".cache"),
        "XDG_DATA_HOME": str(AGENT_HOME / ".local/share"),
    }
    os.execve("/opt/oi-tools/opencode-native", ["opencode", *sys.argv[1:]], environment)


if __name__ == "__main__":
    launch()
