"""Small subreaper for managed capture when the provider does not supply an init."""

import contextlib
import ctypes
import os
import signal
import sys


def run(command=None):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "Could not become a trace subreaper")
    child = os.fork()
    if child == 0:
        os.environ["OI_EXECUTION_TRACE_REAPER"] = "1"
        command = command or [
            sys.executable,
            *(["-I"] if sys.flags.isolated else []),
            "-m",
            "sandbox_runtime.entrypoint",
            *sys.argv[1:],
        ]
        os.execvp(command[0], command)

    def forward(signum, _frame):
        with contextlib.suppress(ProcessLookupError):
            os.kill(child, signum)

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, forward)
    result = 0
    while True:
        try:
            pid, status = os.waitpid(-1, 0)
        except ChildProcessError:
            return result
        if pid == child:
            result = os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:] or None))
