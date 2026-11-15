#!/usr/bin/env python3
"""P0 root-binding prototype. Not a production process-tree collector."""

from __future__ import annotations

import ctypes
import json
import os
import signal
import sys
import time
import uuid
from contextlib import suppress
from pathlib import Path

LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.ptrace.restype = ctypes.c_long
PTRACE_TRACEME = 0
PTRACE_CONT = 7
PTRACE_SETOPTIONS = 0x4200
PTRACE_O_TRACEEXEC = 0x10
PTRACE_EVENT_EXEC = 4


def ptrace(request: int, pid: int, data: int = 0) -> None:
    if LIBC.ptrace(request, pid, None, ctypes.c_void_p(data)) == -1:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def launch(argv: list[str]) -> int:
    context = json.loads(os.environ["OI_TRACE_PROBE_CONTEXT"])
    trace_file = Path(os.environ["OI_TRACE_PROBE_DIR"]) / f"{uuid.uuid4()}.jsonl"
    with trace_file.open("x", encoding="utf-8") as stream:
        seq = 0

        def emit(kind: str, **fields: object) -> None:
            nonlocal seq
            seq += 1
            stream.write(
                json.dumps(
                    {
                        "kind": kind,
                        "seq": seq,
                        "mono_ns": str(time.monotonic_ns()),
                        **context,
                        **fields,
                    }
                )
                + "\n"
            )
            stream.flush()

        pid = os.fork()
        if pid == 0:
            try:
                ptrace(PTRACE_TRACEME, 0)
                os.kill(os.getpid(), signal.SIGSTOP)
                env = dict(os.environ)
                env["SHELL"] = "/bin/bash"
                os.execve("/bin/bash", ["/bin/bash", *argv], env)
            except BaseException as error:
                print(f"trace probe child: {error}", file=sys.stderr, flush=True)
                os._exit(125)

        def forward(signum: int, _frame: object) -> None:
            with suppress(ProcessLookupError):
                os.kill(pid, signum)

        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, forward)
        _, status = os.waitpid(pid, 0)
        if not os.WIFSTOPPED(status):
            emit("unavailable", pid=pid, wait_status=status)
            return 125
        emit(
            "root_bound",
            pid=pid,
            launcher_pid=os.getpid(),
            pid_namespace=str(Path(f"/proc/{pid}/ns/pid").readlink()),
        )
        ptrace(PTRACE_SETOPTIONS, pid, PTRACE_O_TRACEEXEC)
        ptrace(PTRACE_CONT, pid)
        while True:
            _, status = os.waitpid(pid, 0)
            if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
                term_signal = os.WTERMSIG(status) if os.WIFSIGNALED(status) else None
                emit("root_exit", pid=pid, exit_code=exit_code, signal=term_signal)
                if term_signal:
                    if term_signal != signal.SIGKILL:
                        signal.signal(term_signal, signal.SIG_DFL)
                    os.kill(os.getpid(), term_signal)
                return exit_code or 0
            stop_signal = os.WSTOPSIG(status)
            event = status >> 16
            if event == PTRACE_EVENT_EXEC:
                emit("root_exec", pid=pid, executable=str(Path(f"/proc/{pid}/exe").readlink()))
            ptrace(PTRACE_CONT, pid, 0 if event else stop_signal)


if __name__ == "__main__":
    raise SystemExit(launch(sys.argv[1:]))
