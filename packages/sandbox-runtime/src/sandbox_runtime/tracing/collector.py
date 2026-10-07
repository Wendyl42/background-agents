"""Linux lifecycle-only ptrace collector. No syscall stepping or process polling.

The launcher authorizes an orphan observer then execs Bash in its original PID.
Native signal delivery and return status need no controller proxy. The observer
can finish redirected background descendants without holding the tool's pipes.
"""

from __future__ import annotations

import contextlib
import ctypes
import hashlib
import json
import os
import signal
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from .writer import DEFAULTS, EventWriter

LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.ptrace.restype = ctypes.c_long
PTRACE_CONT = 7
PTRACE_DETACH = 17
PTRACE_GETEVENTMSG = 0x4201
PTRACE_SEIZE = 0x4206
PTRACE_INTERRUPT = 0x4207
PTRACE_LISTEN = 0x4208
PTRACE_O_EXITKILL = 0x00100000
OPTIONS = 0x02 | 0x04 | 0x08 | 0x10 | 0x40 | PTRACE_O_EXITKILL
WAIT_ALL = 0x40000000
EVENT_FORK, EVENT_VFORK, EVENT_CLONE, EVENT_EXEC, EVENT_EXIT, EVENT_STOP = 1, 2, 3, 4, 6, 128
FORWARDED_SIGNALS = {signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
WAIT_SIGNALS = FORWARDED_SIGNALS | {signal.SIGCHLD}
GROUP_SIGNALS = {signal.SIGSTOP, signal.SIGTSTP, signal.SIGTTIN, signal.SIGTTOU}
TICKS_PER_SECOND = os.sysconf("SC_CLK_TCK")


def ptrace(request: int, pid: int, data: int = 0) -> None:
    if LIBC.ptrace(request, pid, None, ctypes.c_void_p(data)) == -1:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def event_message(pid: int) -> int:
    value = ctypes.c_ulong()
    if LIBC.ptrace(PTRACE_GETEVENTMSG, pid, None, ctypes.byref(value)) == -1:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return value.value


def signal_owned(pid: int, sig: int) -> None:
    """Never signal a reused PID that is no longer our child or tracee."""
    try:
        fields = dict(
            line.split(":", 1)
            for line in Path(f"/proc/{pid}/status").read_text(errors="replace").splitlines()
            if ":" in line
        )
        if int(fields["TracerPid"]) == os.getpid() or int(fields["PPid"]) == os.getpid():
            os.kill(pid, sig)
    except (OSError, KeyError, ValueError):
        pass


def task_info(pid: int) -> dict[str, Any]:
    status = Path(f"/proc/{pid}/status").read_text(errors="replace")
    tgid = int(next(line.split()[1] for line in status.splitlines() if line.startswith("Tgid:")))
    stat = Path(f"/proc/{tgid}/task/{pid}/stat").read_text(errors="replace")
    fields = stat[stat.rindex(")") + 2 :].split()
    try:
        runtime_ns = int(Path(f"/proc/{tgid}/task/{pid}/schedstat").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        runtime_ns = None
    return {
        "tgid": tgid,
        "tracer_pid": int(
            next(line.split()[1] for line in status.splitlines() if line.startswith("TracerPid:"))
        ),
        "birth_ticks": fields[19],
        "user_ticks": int(fields[11]),
        "system_ticks": int(fields[12]),
        "runtime_cpu_ns": runtime_ns,
    }


def image_info(pid: int) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, proc_path in (("executable", "exe"), ("cwd", "cwd")):
        try:
            result[name] = str(Path(f"/proc/{pid}/{proc_path}").readlink())
        except OSError:
            result[name] = None
    try:
        with Path(f"/proc/{pid}/cmdline").open("rb") as file:
            data = file.read(DEFAULTS["max_argv_bytes"] + 1)
        truncated = len(data) > DEFAULTS["max_argv_bytes"]
        data = data[: DEFAULTS["max_argv_bytes"]]
        try:
            text = data.decode("utf-8")
            encoding_loss = False
        except UnicodeDecodeError:
            text = data.decode("utf-8", "replace")
            encoding_loss = True
        result.update(
            argv=(text[:-1] if text.endswith("\0") else text).split("\0") if text else [],
            argv_truncated=truncated,
            argv_encoding_loss=encoding_loss,
            argv_sha256=hashlib.sha256(data).hexdigest()
            if not truncated and not encoding_loss
            else None,
        )
    except OSError:
        result.update(argv=None, argv_truncated=None, argv_encoding_loss=None, argv_sha256=None)
    return result


class Task:
    def __init__(
        self,
        pid: int,
        instance_id: str,
        group: Group,
        birth_ticks: str,
        *,
        exit_ns: int | None = None,
        exit_wait_status: int | None = None,
        user_ticks: int | None = None,
        system_ticks: int | None = None,
    ):
        self.pid = pid
        self.instance_id = instance_id
        self.group = group
        self.birth_ticks = birth_ticks
        self.exit_ns = exit_ns
        self.exit_wait_status = exit_wait_status
        self.user_ticks = user_ticks
        self.system_ticks = system_ticks
        self.group_stopped = False
        self.runtime_cpu_ns: int | None = None


class Group:
    def __init__(
        self,
        pid: int,
        instance_id: str,
        parent_instance_id: str | None,
        is_root: bool,
        *,
        tasks: set[int] | None = None,
        exec_index: int = 0,
        exited_user_ticks: int = 0,
        exited_system_ticks: int = 0,
    ):
        self.pid = pid
        self.instance_id = instance_id
        self.parent_instance_id = parent_instance_id
        self.is_root = is_root
        self.tasks = tasks if tasks is not None else set()
        self.exec_index = exec_index
        self.exited_user_ticks = exited_user_ticks
        self.exited_system_ticks = exited_system_ticks
        self.cpu_complete = True
        self.exit_status: int | None = None
        self.last_exit_ns = 0
        self.exited_runtime_cpu_ns = 0
        self.runtime_cpu_complete = True


class Collector:
    def __init__(self, writer: EventWriter, root_pid: int, status_fd: int):
        self.writer = writer
        self.status_fd = status_fd
        self.tasks: dict[int, Task] = {}
        self.groups: dict[int, Group] = {}
        self.ordinal = 0
        self.root_pid = root_pid
        self.root_done = False
        self.root_done_seconds: float | None = None
        self.detaching = False
        self.detach_started_seconds: float | None = None
        self.retired_pids: set[int] = set()
        self.autoattached_notifications: dict[int, tuple[str, str]] = {}

    def identity(self) -> str:
        self.ordinal += 1
        return f"{self.writer.stream_id}:{self.ordinal}"

    def status(self, **fields: Any) -> None:
        if self.status_fd >= 0:
            with contextlib.suppress(BrokenPipeError):
                os.write(self.status_fd, (json.dumps(fields) + "\n").encode())

    def add_task(
        self,
        pid: int,
        parent: Task | None,
        fork_kind: str,
        *,
        info: dict[str, Any] | None = None,
        creation_observation: str = "fork_notification",
    ) -> Task:
        if pid in self.tasks:
            return self.tasks[pid]
        if len(self.tasks) >= DEFAULTS["max_live_tasks"]:
            raise RuntimeError("Live traced task limit exceeded")
        self.retired_pids.discard(pid)
        info = task_info(pid) if info is None else info
        group = self.groups.get(info["tgid"])
        if group is None:
            group = Group(
                info["tgid"],
                self.identity(),
                parent.group.instance_id if parent else None,
                parent is None,
            )
            self.groups[group.pid] = group
            self.writer.emit(
                "process.start",
                process_instance_id=group.instance_id,
                parent_process_instance_id=group.parent_instance_id,
                pid=group.pid,
                birth_ticks=info["birth_ticks"],
                is_root=group.is_root,
                fork_kind=fork_kind,
                initial_user_cpu_ns=str(info["user_ticks"] * 1_000_000_000 // TICKS_PER_SECOND),
                initial_system_cpu_ns=str(info["system_ticks"] * 1_000_000_000 // TICKS_PER_SECOND),
                initial_cpu_runtime_ns=str(info["runtime_cpu_ns"])
                if info.get("runtime_cpu_ns") is not None
                else None,
                inherited_from_exec_id=f"{parent.group.instance_id}:exec:{parent.group.exec_index}"
                if parent
                else None,
                **image_info(pid),
            )
        task = Task(pid, self.identity(), group, info["birth_ticks"])
        self.tasks[pid] = task
        group.tasks.add(pid)
        self.writer.emit(
            "thread.start",
            task_instance_id=task.instance_id,
            process_instance_id=group.instance_id,
            pid=pid,
            tgid=group.pid,
            birth_ticks=task.birth_ticks,
            creation_observation="initial_attach"
            if fork_kind == "launcher"
            else creation_observation,
        )
        return task

    def recover_autoattached_thread(self, pid: int, status: int) -> bool:
        """Resolve an owned thread stop even if its parent's clone stop was superseded.

        A concurrent exit_group can replace a pending clone notification. Leaving
        the new thread stopped until that notification arrives deadlocks the
        group. TGID and TracerPid identify thread membership without guessing a
        process parent or inventing an exit. The final wait is still required.
        """
        if pid in self.retired_pids or not os.WIFSTOPPED(status):
            return False
        try:
            info = task_info(pid)
        except (OSError, ValueError, StopIteration):
            return False
        group = self.groups.get(info["tgid"])
        if info.get("tracer_pid") != os.getpid() or group is None or pid == group.pid:
            return False
        recovered = self.add_task(
            pid,
            None,
            "autoattached_thread",
            info=info,
            creation_observation=(
                "exit_stop_recovered" if status >> 16 == EVENT_EXIT else "auto_attach_stop"
            ),
        )
        self.autoattached_notifications[pid] = (group.instance_id, recovered.instance_id)
        return True

    def cpu_snapshot(self, group: Group) -> dict[str, Any]:
        user = group.exited_user_ticks
        system = group.exited_system_ticks
        complete = group.cpu_complete
        runtime_ns = group.exited_runtime_cpu_ns
        runtime_complete = group.runtime_cpu_complete
        for pid in group.tasks:
            task = self.tasks[pid]
            try:
                info = (
                    task_info(pid)
                    if task.user_ticks is None
                    else {
                        "user_ticks": task.user_ticks,
                        "system_ticks": task.system_ticks,
                        "runtime_cpu_ns": task.runtime_cpu_ns,
                    }
                )
                user += info["user_ticks"]
                system += info["system_ticks"]
                if info.get("runtime_cpu_ns") is None:
                    runtime_complete = False
                else:
                    runtime_ns += info["runtime_cpu_ns"]
            except (OSError, ValueError, StopIteration):
                complete = False
                runtime_complete = False
        return {
            "user_cpu_ns": str(user * 1_000_000_000 // TICKS_PER_SECOND),
            "system_cpu_ns": str(system * 1_000_000_000 // TICKS_PER_SECOND),
            "cpu_complete": complete,
            "cpu_scope": "sum_self_thread_ticks",
            "cpu_runtime_ns": str(runtime_ns) if runtime_complete else None,
            "cpu_runtime_complete": runtime_complete,
            "cpu_runtime_scope": "sum_self_thread_schedstat",
        }

    def record_thread_exit(self, task: Task, status: int | None, reason: str) -> None:
        group = task.group
        at_ns = task.exit_ns or time.monotonic_ns()
        group.last_exit_ns = max(group.last_exit_ns, at_ns)
        if task.user_ticks is None:
            group.cpu_complete = False
        else:
            group.exited_user_ticks += task.user_ticks
            group.exited_system_ticks += task.system_ticks or 0
        if task.runtime_cpu_ns is None:
            group.runtime_cpu_complete = False
        else:
            group.exited_runtime_cpu_ns += task.runtime_cpu_ns
        self.writer.emit(
            "thread.exit",
            at_ns=at_ns,
            task_instance_id=task.instance_id,
            process_instance_id=group.instance_id,
            pid=task.pid,
            exit_code=os.WEXITSTATUS(status)
            if status is not None and os.WIFEXITED(status)
            else None,
            signal=os.WTERMSIG(status) if status is not None and os.WIFSIGNALED(status) else None,
            reason=reason,
            user_cpu_ns=str(task.user_ticks * 1_000_000_000 // TICKS_PER_SECOND)
            if task.user_ticks is not None
            else None,
            system_cpu_ns=str(task.system_ticks * 1_000_000_000 // TICKS_PER_SECOND)
            if task.system_ticks is not None
            else None,
            cpu_runtime_ns=str(task.runtime_cpu_ns) if task.runtime_cpu_ns is not None else None,
        )

    def finish_task(self, pid: int, status: int) -> None:
        task = self.tasks.pop(pid)
        group = task.group
        group.tasks.discard(pid)
        self.record_thread_exit(task, status, "wait_exit")
        if pid == group.pid or group.exit_status is None:
            group.exit_status = status
        if group.tasks:
            return
        final = group.exit_status
        self.writer.emit(
            "process.exit",
            at_ns=group.last_exit_ns,
            process_instance_id=group.instance_id,
            pid=group.pid,
            exit_code=os.WEXITSTATUS(final) if os.WIFEXITED(final) else None,
            signal=os.WTERMSIG(final) if os.WIFSIGNALED(final) else None,
            **self.cpu_snapshot(group),
        )
        del self.groups[group.pid]
        self.autoattached_notifications = {
            child: identity
            for child, identity in self.autoattached_notifications.items()
            if identity[0] != group.instance_id
        }
        if group.is_root:
            self.root_done = True
            self.root_done_seconds = time.monotonic()

    def handle(self, pid: int, status: int) -> None:
        self.writer.begin_defer()
        try:
            self._handle_status(pid, status)
        finally:
            self.writer.end_defer()

    def _handle_status(self, pid: int, status: int) -> None:
        at_ns = time.monotonic_ns()
        event = status >> 16
        if event == EVENT_EXEC:
            former = event_message(pid)
            moving = self.tasks.get(former)
            if moving is not None:
                # Linux kills every other thread on exec. The old leader has an
                # EXIT stop but no separate final wait-exit notification.
                for sibling_pid in list(moving.group.tasks):
                    if sibling_pid == former:
                        continue
                    sibling = self.tasks.pop(sibling_pid)
                    moving.group.tasks.discard(sibling_pid)
                    self.record_thread_exit(sibling, sibling.exit_wait_status, "exec_replaced")
                    if sibling_pid != pid:
                        self.retired_pids.add(sibling_pid)
                self.tasks.pop(former)
                moving.group.tasks = {pid}
                moving.pid = pid
                self.tasks[pid] = moving
            if former != pid and moving is not None:
                self.writer.emit(
                    "thread.rebase",
                    task_instance_id=moving.instance_id,
                    old_pid=former,
                    pid=pid,
                    process_instance_id=moving.group.instance_id,
                )
        task = self.tasks.get(pid)
        if task is None:
            # Children can stop before their parent's fork notification is reaped.
            return
        if os.WIFEXITED(status) or os.WIFSIGNALED(status):
            self.finish_task(pid, status)
            return
        sig = os.WSTOPSIG(status)
        if self.detaching:
            with contextlib.suppress(ProcessLookupError):
                ptrace(
                    PTRACE_DETACH,
                    pid,
                    signal.SIGSTOP if task.group_stopped else (0 if event else sig),
                )
            self.tasks.pop(pid, None)
            return
        if event in (EVENT_FORK, EVENT_VFORK, EVENT_CLONE):
            try:
                child_pid = event_message(pid)
            except ProcessLookupError as error:
                # Another thread can start group exit after waitpid reports the
                # clone stop. Its autoattached children still produce stops;
                # resolve known-TGID threads there, and never synthesize exits.
                task.group.cpu_complete = False
                task.group.runtime_cpu_complete = False
                self.writer.emit(
                    "trace.notice",
                    reason="fork_notification_superseded",
                    pid=pid,
                    ptrace_event=event,
                    errno=error.errno,
                    cpu_accounting="unavailable_for_parent_group",
                )
                return
            recovered = self.autoattached_notifications.pop(child_pid, None)
            if (
                event == EVENT_CLONE
                and recovered is not None
                and recovered[0] == task.group.instance_id
                and child_pid not in self.tasks
            ):
                # An autoattached thread may reach its final wait before the
                # parent's clone notification. Its identity/exit are already
                # recorded; /proc is now gone. Do not create a second task.
                self.writer.emit(
                    "trace.notice",
                    reason="clone_notification_after_observed_exit",
                    pid=pid,
                    child_pid=child_pid,
                    task_instance_id=recovered[1],
                    process_instance_id=recovered[0],
                )
            else:
                self.add_task(
                    child_pid,
                    task,
                    {EVENT_FORK: "fork", EVENT_VFORK: "vfork", EVENT_CLONE: "clone"}[event],
                )
        elif event == EVENT_EXEC:
            task.group.exec_index += 1
            self.writer.emit(
                "process.exec",
                at_ns=at_ns,
                process_instance_id=task.group.instance_id,
                task_instance_id=task.instance_id,
                pid=pid,
                exec_index=task.group.exec_index,
                **image_info(pid),
                **self.cpu_snapshot(task.group),
            )
        elif event == EVENT_EXIT:
            task.exit_ns = at_ns
            task.exit_wait_status = event_message(pid)
            try:
                info = task_info(pid)
                task.user_ticks, task.system_ticks = info["user_ticks"], info["system_ticks"]
                task.runtime_cpu_ns = info.get("runtime_cpu_ns")
            except (OSError, ValueError, StopIteration):
                task.group.cpu_complete = False
        elif event == EVENT_STOP and sig in GROUP_SIGNALS:
            task.group_stopped = True
            self.writer.emit(
                "process.group_stop",
                at_ns=at_ns,
                process_instance_id=task.group.instance_id,
                pid=pid,
                signal=sig,
            )
            ptrace(PTRACE_LISTEN, pid)
            return
        elif event == 0:
            if sig == signal.SIGCONT:
                task.group_stopped = False
            self.writer.emit(
                "process.signal",
                at_ns=at_ns,
                process_instance_id=task.group.instance_id,
                task_instance_id=task.instance_id,
                pid=pid,
                signal=sig,
            )
        with contextlib.suppress(ProcessLookupError):
            ptrace(PTRACE_CONT, pid, 0 if event else sig)

    def collect(self) -> None:
        early: dict[int, int] = {}
        while self.tasks:
            batch_exhausted = True
            for _ in range(DEFAULTS["max_wait_batch"]):
                try:
                    pid, status = os.waitpid(-1, WAIT_ALL | os.WNOHANG)
                except ChildProcessError:
                    if not self.tasks:
                        break
                    raise RuntimeError("Tracked tasks remain but no kernel tracees are waitable")
                if not pid:
                    batch_exhausted = False
                    break
                if pid in self.retired_pids and (os.WIFEXITED(status) or os.WIFSIGNALED(status)):
                    self.retired_pids.discard(pid)
                    continue
                if pid not in self.tasks:
                    self.recover_autoattached_thread(pid, status)
                if pid not in self.tasks and status >> 16 != EVENT_EXEC:
                    early[pid] = status
                else:
                    self.handle(pid, status)
                for ready_pid in list(early):
                    if ready_pid in self.tasks:
                        self.handle(ready_pid, early.pop(ready_pid))
            if not self.tasks:
                break
            now = time.monotonic()
            if (
                self.detach_started_seconds is not None
                and now - self.detach_started_seconds >= DEFAULTS["detach_timeout_seconds"]
            ):
                self.writer.emit(
                    "trace.loss", reason="detach_deadline", unfinished_tasks=len(self.tasks)
                )
                self.writer.close("detach_deadline", False)
                return
            if (
                self.root_done_seconds is not None
                and now - self.root_done_seconds >= DEFAULTS["background_trace_seconds"]
                and not self.detaching
            ):
                self.writer.emit(
                    "trace.loss",
                    reason="background_collection_deadline",
                    unfinished_processes=len(self.groups),
                )
                self.detaching = True
                self.detach_started_seconds = now
                for pid in self.tasks:
                    with contextlib.suppress(ProcessLookupError):
                        ptrace(PTRACE_INTERRUPT, pid)
            wait_seconds = 0 if batch_exhausted else DEFAULTS["background_poll_seconds"]
            info = signal.sigtimedwait(WAIT_SIGNALS, wait_seconds)
            if info and info.si_signo in FORWARDED_SIGNALS:
                raise RuntimeError("Collector externally terminated")
        if early:
            self.writer.emit("trace.loss", reason="unmatched_task_statuses", count=len(early))
        self.writer.close(
            "background_deadline" if self.detaching else "all_processes_exited", not self.detaching
        )


def probe_reaper() -> bool:
    read_fd, write_fd = os.pipe()
    parent = os.fork()
    if parent == 0:
        os.close(read_fd)
        child = os.fork()
        if child == 0:
            os.write(write_fd, str(os.getpid()).encode())
        os._exit(0)
    os.close(write_fd)
    with os.fdopen(read_fd) as stream:
        orphan_pid = int(stream.read())
    os.waitpid(parent, 0)
    deadline = time.monotonic() + DEFAULTS["reaper_probe_seconds"]
    while Path(f"/proc/{orphan_pid}").exists():
        if time.monotonic() >= deadline:
            return False
        time.sleep(DEFAULTS["ready_poll_seconds"])
    return True


def authorize_observer(pid: int) -> None:
    # PR_SET_PTRACER grants only this observer access under Yama ptrace_scope=1.
    if LIBC.prctl(0x59616D61, pid, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def probe_ptrace() -> dict[str, Any]:
    go_read, go_write = os.pipe()
    done_read, done_write = os.pipe()
    target = os.getpid()
    observer = os.fork()
    if observer == 0:
        os.close(go_write)
        os.close(done_read)
        try:
            if not os.read(go_read, 1):
                os._exit(1)
            ptrace(PTRACE_SEIZE, target, OPTIONS)
            ptrace(PTRACE_INTERRUPT, target)
            os.waitpid(target, WAIT_ALL)
            ptrace(PTRACE_DETACH, target)
            result = {"available": True, "authorized_ptrace": True}
        except OSError as error:
            result = {"available": False, "errno": error.errno}
        os.write(done_write, json.dumps(result).encode())
        os._exit(0)
    os.close(go_read)
    os.close(done_write)
    try:
        authorize_observer(observer)
        os.write(go_write, b"1")
        with os.fdopen(done_read) as stream:
            result = json.loads(stream.read())
        os.waitpid(observer, 0)
        if result["available"]:
            reaper = probe_reaper()
            result.update(available=reaper, orphan_reaper=reaper)
        return {"backend": "ptrace_lifecycle", **result}
    except OSError as error:
        return {"available": False, "backend": "ptrace_lifecycle", "errno": error.errno}
    finally:
        os.close(go_write)
        with contextlib.suppress(ChildProcessError):
            os.waitpid(observer, 0)
        with contextlib.suppress(OSError):
            authorize_observer(0)


def run_observer(root: int, context: dict[str, Any], ready_fd: int) -> None:
    writer = EventWriter(Path(os.environ["OI_EXECUTION_TRACE_DIR"]), context)
    collector = Collector(writer, root, ready_fd)
    try:
        ptrace(PTRACE_SEIZE, root, OPTIONS)
        ptrace(PTRACE_INTERRUPT, root)
        _, status = os.waitpid(root, WAIT_ALL)
        if not os.WIFSTOPPED(status):
            raise RuntimeError("Root terminated before observer binding")
        task = collector.add_task(root, None, "launcher")
        writer.emit(
            "shell.bind",
            span_id=context["span_id"],
            process_instance_id=task.group.instance_id,
            pid=root,
            pid_namespace=str(Path(f"/proc/{root}/ns/pid").readlink()),
            root_pid_preserved=True,
        )
        ptrace(PTRACE_CONT, root)
        collector.status(ready=True)
        os.close(ready_fd)
        collector.status_fd = -1
        collector.collect()
    except BaseException as error:
        writer.emit("trace.loss", reason="collector_error", error_type=type(error).__name__)
        collector.status(error="collector_error")
        for pid in collector.tasks:
            signal_owned(pid, signal.SIGKILL)
        writer.close("collector_error", False)
    finally:
        if collector.status_fd >= 0:
            os.close(collector.status_fd)


def launch(argv: list[str]) -> int:
    context = json.loads(os.environ.get("OI_EXECUTION_TRACE_CONTEXT", "{}"))
    if not context.get("span_id"):
        context.update(
            span_id=str(uuid.uuid4()),
            session_id=None,
            call_id=None,
            identity_quality="unattributed",
        )
    original_mask = signal.pthread_sigmask(signal.SIG_BLOCK, WAIT_SIGNALS)
    go_read, go_write = os.pipe()
    ready_read, ready_write = os.pipe()
    root_pid = os.getpid()
    intermediate = os.fork()
    if intermediate == 0:
        os.close(go_write)
        os.close(ready_read)
        observer_pid = os.fork()
        if observer_pid:
            os.write(ready_write, (json.dumps({"observer_pid": observer_pid}) + "\n").encode())
            os._exit(0)
        os.setpgid(0, 0)
        try:
            if not os.read(go_read, 1):
                os._exit(0)
            os.close(go_read)
            # Do not retain the workload pipes after the root has returned.
            devnull = os.open(os.devnull, os.O_RDWR)
            for fd in (0, 1, 2):
                os.dup2(devnull, fd)
            if devnull > 2:
                os.close(devnull)
            run_observer(root_pid, context, ready_write)
        finally:
            os._exit(0)
    os.close(go_read)
    os.close(ready_write)
    try:
        with os.fdopen(ready_read) as stream:
            observer = json.loads(stream.readline())
            os.waitpid(intermediate, 0)
            authorize_observer(observer["observer_pid"])
            os.write(go_write, b"1")
            ready = json.loads(stream.readline())
            if not ready.get("ready"):
                raise RuntimeError("Observer did not bind the root")
        env = dict(os.environ)
        real_shell = env["OI_EXECUTION_TRACE_REAL_SHELL"]
        env.pop("OI_EXECUTION_TRACE_CONTEXT", None)
        # Descendant OpenCode CLIs are already observed by this process tree;
        # do not let inherited control variables request a second ptracer.
        env.pop("OI_EXECUTION_TRACE_MODE", None)
        for sig in FORWARDED_SIGNALS:
            if signal.getsignal(sig) != signal.SIG_IGN:
                signal.signal(sig, signal.SIG_DFL)
        for name in ("SIGPIPE", "SIGXFZ", "SIGXFSZ"):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), signal.SIG_DFL)
        signal.pthread_sigmask(signal.SIG_SETMASK, original_mask)
        os.close(go_write)
        go_write = -1
        # Preserve the PID, PPID, process group, stdio and native signal behavior.
        os.execvpe(real_shell, [real_shell, *argv], env)
    except (OSError, ValueError, KeyError, RuntimeError):
        print("execution-trace: observer initialization failed", file=sys.stderr)
        return 125
    finally:
        if go_write >= 0:
            os.close(go_write)
