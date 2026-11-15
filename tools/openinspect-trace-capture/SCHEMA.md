# Execution measurement contract v1

Version 1 contract, 2026-09-17. P0–P4 have passed independent acceptance (see
[ACCEPTANCE.md](ACCEPTANCE.md)). The separate P0 prototype uses diagnostic records, not this
production schema.

## Scope and backend

The first supported target is Linux with `/proc`, Python >=3.12, Bash, authorized ptrace permission,
a functioning orphan reaper, and the pinned OpenCode version. The backend is `ptrace_lifecycle`,
using fork/vfork/clone/exec/exit events and `PTRACE_CONT`, not syscall stepping or `/proc` polling.
Unsupported platforms must fail the preflight, not silently substitute sampled data. eBPF remains a
future backend; it is not required to run this implementation.

After native config merging, the global plugin validates the effective shell (including project
overrides and the native `SHELL` fallback). Process mode supports Bash only. Unsupported shells fail
readiness before a task can run. The hook replaces only the in-memory config, without writing the
repository configuration, and passes the selected real Bash through each call's environment.
Readiness is scoped to the project directory and verifies the effective wrapper selection. A global
file plugin also instruments alternate native project instances. Relative shell selections are
checked against the project for readiness, while execution preserves the original selector and
resolves it with the actual tool workdir and final PATH via `execvpe`.

OpenCode's configured shell points to a launcher named `bash`, preserving upstream Bash selection
and argument construction. The launcher receives a per-call context from `shell.env`, authorizes a
specific observer using `PR_SET_PTRACER`, and execs real Bash with the original arguments in the
original PID. The observer binds that PID before execution. Native PID, PPID, process group and
signal delivery are preserved; there is no signal-forwarding proxy. The observer is reparented to
the init reaper and closes its copies of workload pipes. `SHELL` is unchanged. Startup and ptrace
stops are instrumentation effects included in the overhead measurements.

Direct Docker process-mode probes use `--init`; managed runtime entrypoints can instead supply the
bundled subreaper. The preflight actually tests orphan reaping. The observer uses
`PTRACE_O_EXITKILL`: its unexpected death terminates its remaining tracees and invalidates that
call's evidence, instead of leaving uncontrolled work running. A normal background observation
deadline explicitly detaches surviving descendants and marks their ends unknown. Programs requiring
their own ptrace debugger and work performed by external daemons are outside the transparent
process-collection scope; this is an experimental diagnostic backend.

Tool plugin hooks provide successful invocation boundaries. Event-observed abnormal terminal states
are labeled separately from execution boundaries; missing ends remain open spans. Direct user
`/shell` API calls have shell context but do not have `tool.execute.before/after` hooks and must not
masquerade as exactly timed model tool calls.

## Common event envelope

Each UTF-8 JSONL record has:

| Field       | Meaning                                                           |
| ----------- | ----------------------------------------------------------------- |
| `schema`    | `openinspect-execution-v1`                                        |
| `kind`      | Event type below                                                  |
| `stream_id` | Unique writer/collector instance; never reused after restart      |
| `seq`       | Contiguous positive integer starting at 1, scoped to stream       |
| `mono_ns`   | Decimal string from the local monotonic clock                     |
| `clock_id`  | Host boot plus time namespace identity; no cross-host subtraction |

`trace.open` additionally defines the producer/version/mode, epoch anchor, timing source and
precision, and available context: run/attempt, OpenInspect session/parent session, sandbox/runtime
boot, OpenCode session/call and span ID. Missing identity fields are explicit nulls, never guessed.
Each writer owns a file; filenames do not interpolate untrusted session or tool IDs.

`tool.start` / `tool.end` / `tool.terminal_observed` reference a unique `span_id` and preserve
OpenCode `session_id`, `call_id`, message identity when available, tool name and status. The start
and execution end are recorded in the same plugin process. An observed terminal event may close the
lifecycle for diagnostics, but does not supply an exact execution duration.

`shell.bind` connects the token/span and actual root process instance. Multiple shell launches
within one invocation require distinct collection IDs. Anonymous launches must be recorded as
unattributed, not matched to the nearest tool event.

`process.start` records a process/task instance, PID/TGID, birth identity, parent instance and fork
kind. `process.exec` starts a new image segment under that instance with an increasing exec index,
executable, bounded argv/cwd, truncation/missing flags, and resource snapshot when available.
`process.exit` records the end boundary, exit code or signal and available resource counters.
Internal tracer stops are not command failures. Threads are not independent command invocations.

Producer version 2 resolves an autoattached nonleader thread through kernel `TracerPid` and
`Tgid` when its process group is already known. Concurrent `exit_group` can supersede the parent's
clone notification. `thread.start.creation_observation` distinguishes `initial_attach`, `fork_notification`,
`auto_attach_stop`, and `exit_stop_recovered`; the last has no observed thread-creation boundary
and must not be used as a thread lifetime. No process start is synthesized in this recovery path.
CPU is sampled at the real exit stop and exits still require the final kernel wait notification.
`trace.notice/fork_notification_superseded` retains the ptrace event and errno; the affected parent
group's CPU availability is conservatively disabled. Unresolved statuses still produce loss.
Detachment has a bounded drain deadline; an unresponsive tracee yields `trace.loss/detach_deadline`
and an incomplete footer, never a fabricated exit or a completed stream. The documented
`PTRACE_O_EXITKILL` fail-closed behavior still applies if an observer cannot detach before exiting.

`trace.loss` and other diagnostic events state the cause and counts where known; missing counts are
unknown, not zero. `trace.close` reports event totals and a completion reason. A missing close,
sequence gap, truncated tail, dropped event or unresolved process marks evidence incomplete.

`task.link` records parent span/session/call to child session using the native Task metadata
`sessionId`, observed either while running or in its result. `session.identity` records the session
parent relationship independently. Anonymous shell launches have unique span IDs and
`identity_quality=unattributed`; missing call/session IDs are never coalesced into a shared call.

Explicit tracing requires a fresh per-start readiness nonce. Runtime initialization triggers the
project's plugin loading, then checks its ready marker and matching persisted `trace.open` header.
No readiness means startup failure before the bridge may submit prompts. This is necessary because
the pinned OpenCode logs and ignores failed plugin initialization.

## Clock and resource rules

Nanosecond integers are serialized as strings to avoid JavaScript precision loss. Python APIs use
seconds and TypeScript APIs milliseconds; every field/variable names its unit. An epoch anchor
allows approximate display, not precise subtraction against control-plane timestamps. JavaScript
hrtime and Python monotonic alignment must be measured before their intervals can share a timeline.
P1 found that the pinned OpenCode's Bun uses process-relative hrtime, even though Node on the same
host uses a system-wide origin. The plugin retains `source_mono_ns` and calibrates against a local
Python monotonic peer with repeated pipe round trips. `clock_mapping` records the minimum-RTT
midpoint offset, half-RTT uncertainty, sample count and source clock identity. `mono_ns` is mapped,
not an assertion of zero alignment error. Same-plugin durations use the original clock;
process-to-tool overlap must carry mapping uncertainty. Different boot/time namespace identities
stay separate. Calibration failure prevents plugin initialization; it never labels uncalibrated
clocks as the same clock domain.

Process endpoints are tracer-observed lifecycle stops, not exact kernel event timestamps. Report
this provenance and measure scheduling/observer error. CPU counters have their own resolution and
availability; do not label elapsed as CPU or elapsed minus CPU as I/O wait. A group's resource total
includes each self counter once; parent wait/rusage values that include children cannot be summed
with those children. Threads and exec replacements must not duplicate process CPU.

`cpu_runtime_ns` sums each thread's first `/proc/.../schedstat` counter once, when available;
`user_cpu_ns` and `system_cpu_ns` retain the lower-resolution `/proc/.../stat` ticks. Availability
is explicit and thread exit records preserve the component counters. See the
[kernel counter definition](https://docs.kernel.org/scheduler/sched-stats.html#proc-pid-schedstat).
Runqueue fields are not used to infer I/O waiting. Initial counters are stored at process binding.
Because the root PID first runs the launcher, its cumulative self CPU includes launcher startup;
workload/exec CPU must use counter deltas, not the final root counter as command cost. Collector
CPU/RSS in the footer are a separate observer scope.

`process.start` creates an instance independent of PID reuse; `thread.rebase` preserves the
executing thread identity when Linux replaces the old leader on non-leader exec.
`pid_view_namespace` in the stream header identifies the namespace in which the emitted numeric PIDs
are meaningful. Lifecycle timestamps may be appended after later observations (for example an
earlier EXIT stop reported when a thread is reaped); sequence order is serialization order, not
timestamp order.

Arguments and paths can be truncated or omitted. A partial command cannot enter a strict signature
comparison as if complete. No full environment, prompt or tool output is needed in measurement
events. Cwd/argv identity alone does not establish unchanged repository or environment state.

## Integrity, compatibility and denominators

The append-only spool is separate from UI state/upsert events. Each file has a bounded size and
explicit closure/overflow handling. Production collection discovers the full selected session tree,
copies evidence into the bundle before sandbox deletion, hashes the copied files and records
expected versus observed sessions. File presence alone is not proof of completeness.

The enclosing bundle stays `openinspect-trace-v0`; execution attachments have this independent
schema and a versioned manifest entry. Old profiles keep their existing semantics. New analysis
reports `unavailable` for old bundles with no execution data, never fabricated process timings.

Analysis distinguishes tool spans, process instances, exec segments and command groups. It reports
cumulative process elapsed, union inside the accurate tool window, out-of-window background work,
self CPU and missingness independently. Exclude the launcher/root carrier shell from workload
coverage; root `exec` into a workload executable is nevertheless real work. Nested interpreter
coverage is not statement-level semantic coverage. Parent/child inclusive elapsed cannot be added
into a nonoverlapping cost denominator. Repeated signatures mean observed repeated command
candidates, not proven redundant work, critical-path contribution or removable latency.

## Acceptance gates

P0: same-sandbox concurrent identical commands have unique exact identity bindings; short calls,
nonzero exits and cancellation are exercised in actual pinned OpenCode without model calls. P1: tool
success/error/cancel/open boundaries, concurrency and writer integrity are tested. P2:
fork/exec/thread/short-circuit/pipeline/background/signal stress matrix, independent timing
comparison and fixed-workload observer overhead. P3: whole-tree collection, recovery, hashes,
missingness and old exporter compatibility. P4: known-answer interval/resource/group fixtures,
source-linked reports, deterministic output and old-profile regressions.

Initial performance targets remain those in [the plan](../../docs/plans/fine-grained-tracing.md): at
least 20 interleaved pairs, median wall overhead <=5% and p95 <=10% on representative fixed
workloads; short-process stress separately. Until those pass, the backend is diagnostic. No test may
hide overhead in model waits or sleeps.
