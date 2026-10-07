# Trace Pipeline and Evidence Boundaries

This page maps the existing runtime-to-analysis path. It describes current evidence and its limits;
metric definitions belong to the
[analyzer contracts](https://github.com/Wendyl42/agent-benchmark-lab/blob/main/tools/openinspect-trace-analysis/README.md#documentation).
For the broader system, see [HOW_IT_WORKS.md](HOW_IT_WORKS.md).

## Ownership and data flow

```text
OpenCode event stream
  -> shared sandbox runtime: prompt_stream -> bridge / event_forwarder
  -> control plane: sandbox event handler -> session SQLite
  -> read-only trace exporter: raw API pages + normalized JSONL + hashes
  -> offline analyzers: validation -> IR -> derived metrics / reports

Service/runtime logs and optional host observations -> separate exported evidence
```

| Layer                 | Code entrypoints                                                                                                                                                                                                                             | Responsibility                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Sandbox lifecycle     | [provider-factory.ts](../packages/control-plane/src/sandbox/provider-factory.ts), [lifecycle/](../packages/control-plane/src/sandbox/lifecycle)                                                                                              | Select the configured backend and manage create, resume, snapshot, and stop operations                              |
| Shared runtime        | [entrypoint.py](../packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py), [supervisor.py](../packages/sandbox-runtime/src/sandbox_runtime/supervisor.py), [bridge.py](../packages/sandbox-runtime/src/sandbox_runtime/bridge.py)       | Start services, execute prompts through OpenCode, and connect to the control plane                                  |
| Tool-event conversion | [prompt_stream.py](../packages/sandbox-runtime/src/sandbox_runtime/prompt_stream.py), [child_activity.py](../packages/sandbox-runtime/src/sandbox_runtime/child_activity.py)                                                                 | Convert OpenCode parts to events and associate direct OpenCode Task activity                                        |
| Transport             | [event_forwarder.py](../packages/sandbox-runtime/src/sandbox_runtime/event_forwarder.py)                                                                                                                                                     | Add sandbox identity/timestamps, buffer events, and acknowledge selected critical event types                       |
| Shared protocol       | [sandbox-events.ts](../packages/shared/src/types/sandbox-events.ts)                                                                                                                                                                          | Event schemas and tool-call identity; see [ADR 0002](adr/0002-shared-session-contracts-and-correlation-boundary.md) |
| Persistence           | [sandbox-events.ts](../packages/control-plane/src/session/sandbox-events.ts), [event-repository.ts](../packages/control-plane/src/session/event-repository.ts)                                                                               | Broadcast live events and persist selected session evidence                                                         |
| Export                | [export-openinspect-trace.mjs](https://github.com/Wendyl42/agent-benchmark-lab/blob/main/scripts/export-openinspect-trace.mjs), [sandbox-trace.mjs](https://github.com/Wendyl42/agent-benchmark-lab/blob/main/scripts/lib/sandbox-trace.mjs) | Walk a stored session tree, save evidence, and attach supplied runtime/host JSONL                                   |
| Offline analysis      | [lib/](https://github.com/Wendyl42/agent-benchmark-lab/blob/main/tools/openinspect-trace-analysis/lib), [lib/time/](https://github.com/Wendyl42/agent-benchmark-lab/blob/main/tools/openinspect-trace-analysis/lib/time)                     | Validate bundles, derive operations/counts, and produce invocation-time summaries                                   |

## Session identities

An **OpenInspect child session** created by `spawn-child` has its own control-plane session and
sandbox. `parentSessionId` defines the exported session tree and the analyzer's sibling groups. Its
entrypoints are
[spawn-child.js](../packages/sandbox-runtime/src/sandbox_runtime/tools/spawn-child.js) and
[session-child-spawn.ts](../packages/control-plane/src/routes/session-child-spawn.ts).

An **OpenCode Task child** is activity inside an OpenInspect sandbox. Its events can carry
`isSubtask`, `childSessionId`, and `taskCallId` within the enclosing OpenInspect session stream.
These fields do not create another control-plane session or another sandbox. A tool's `callId` alone
is not globally unique; retain its session and event identity when joining evidence.

## What survives in a bundle

- `prompt_stream.py` emits tool name, arguments, call identity, state, output, and message identity.
  The conversion does not copy OpenCode tool-state start/end timing into the `tool_call` payload.
- `event_forwarder.py` supplies a sandbox epoch timestamp when an event has none. Its bounded buffer
  and critical-event acknowledgement policy are not a lossless history of all tool states.
- The control plane upserts each tool identity: the first row's `created_at` remains while `data` is
  replaced by later snapshots. The export therefore retains the latest persisted state, not every
  pending/running/completed transition.
- `step_start` and `step_finish` are broadcast but not stored as event rows by the current handler.
  Step-finish cost can update the session total; that does not preserve the step timeline.
- The exporter reads stored evidence without waking sandboxes. Hash and completeness checks cover
  the exported records, not events that were never persisted. Missing large-output side files cannot
  be reconstructed from the export.

For exporter options, run `node ../benchmark-lab/scripts/export-openinspect-trace.mjs --help`.
Backend selection, runtime/host attachments, and clock provenance are specified in
[SANDBOX_BACKEND_PREPARATION.md](SANDBOX_BACKEND_PREPARATION.md#trace-export-and-host-attachment-contract).
Service log correlation is covered separately by [DEBUGGING_PLAYBOOK.md](DEBUGGING_PLAYBOOK.md).

## Timing and derived operations

The
[raw IR](https://github.com/Wendyl42/agent-benchmark-lab/blob/main/docs/analysis/INTERMEDIATE_REPRESENTATION.md#toolinvocationir--primary-raw-unit)
uses the control-plane row's `createdAt` as the invocation start and the final stored sandbox
`timestamp` as its inferred finish. These clocks are not calibrated. Historical profiles repair
missing/nonpositive intervals to a synthetic 1 ms for deterministic interval sweeps; this is not an
observed duration.

The separate `trace:time` workflow uses the unmodified finish value, requires a positive interval
and a terminal tool state, and reports other durations as unknown. It classifies a whole call once;
its cumulative invocation time can exceed task wall time when calls overlap. Definitions are in
[the time measurement contract](https://github.com/Wendyl42/agent-benchmark-lab/blob/main/docs/analysis/TIME_DISTRIBUTION_PLAN.md).

Shell segments and normalized operations are derived from tool arguments after execution. Their
presence describes requested command structure, not proof that each segment executed or a measured
duration for that segment. Neither operation counts nor whole-call time establish CPU consumption,
critical-path contribution, or removable work. Runtime startup/hook durations and optional host
samples are separate evidence with their own clocks and scope.

## Analysis entrypoints

Use the
[trace analysis README](https://github.com/Wendyl42/agent-benchmark-lab/blob/main/tools/openinspect-trace-analysis/README.md)
to choose between per-bundle profiles, duplication batches, and campaign time summaries. The CLI
inputs and denominators differ.
[STATUS.md](https://github.com/Wendyl42/agent-benchmark-lab/blob/main/docs/analysis/STATUS.md) links
current capabilities and dated results; historical profiles and experiment plans are not a required
reading sequence for every task.

New experiments can use
[fine-grained execution capture](https://github.com/Wendyl42/agent-benchmark-lab/blob/main/tools/openinspect-trace-capture/README.md)
to preserve tool hooks and actual process/exec events independently of UI upserts. The separately
versioned
[process-v1 profile](https://github.com/Wendyl42/agent-benchmark-lab/blob/main/docs/analysis/PROCESS_PROFILE.md)
consumes those hashed attachments; it does not change the historical operation/time profiles above.
Implementation and independent P0–P4 acceptance are recorded in
[ACCEPTANCE.md](https://github.com/Wendyl42/agent-benchmark-lab/blob/main/docs/tracing/ACCEPTANCE.md).
