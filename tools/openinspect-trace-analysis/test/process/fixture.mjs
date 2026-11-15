import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { hashFile } from "../../lib/hash.mjs";
import { attachExecutionCapture } from "../../../../scripts/lib/execution-trace.mjs";

const BASE = 10000000000000000000n;
export const at = (ms) => (BASE + BigInt(ms) * 1000000n).toString();
export const cpu = (ms) => (BigInt(ms) * 1000000n).toString();
const image = (executable, argv = [executable]) => ({
  executable,
  argv,
  cwd: "/workspace/repo",
  argv_truncated: false,
  argv_encoding_loss: false,
  argv_sha256: createHash("sha256")
    .update(Buffer.from(argv.join("\0") + "\0"))
    .digest("hex"),
});
const resources = (value) => ({
  cpu_runtime_ns: cpu(value),
  cpu_runtime_complete: true,
  user_cpu_ns: cpu(value),
  system_cpu_ns: "0",
  cpu_complete: true,
});

export function scenario({
  session = "root",
  name = "p",
  toolEnd = 100,
  rootEnd = 100,
  ops = [
    { id: "a", start: 10, exec: 12, end: 50, cpu: 20 },
    { id: "b", start: 30, exec: 31, end: 80, cpu: 10 },
  ],
  rootExec = null,
  clock = "domain-a",
  toolClock = clock,
  exact = true,
  ocSession = "oc-main",
  taskParent = null,
  mode = "process",
} = {}) {
  const boot = "boot-" + session,
    span = "span-" + name;
  const context = {
    run_id: "run",
    attempt_id: "attempt",
    inspect_session_id: session,
    runtime_boot_id: boot,
    span_id: span,
    session_id: ocSession,
    call_id: "call-" + name,
    tool: "shell",
    identity_quality: "exact_call",
  };
  const records = [
    {
      kind: "process.start",
      at: 0,
      process_instance_id: name + ":r",
      parent_process_instance_id: null,
      is_root: true,
      pid: 1,
      birth_ticks: "1",
      ...image("/python-launcher"),
      initial_cpu_runtime_ns: cpu(100),
      initial_user_cpu_ns: cpu(100),
      initial_system_cpu_ns: "0",
    },
    { kind: "shell.bind", at: 0, span_id: span, process_instance_id: name + ":r" },
    {
      kind: "process.exec",
      at: 1,
      process_instance_id: name + ":r",
      exec_index: 1,
      ...image("/bin/bash"),
      ...resources(101),
    },
  ];
  if (rootExec)
    records.push({
      kind: "process.exec",
      at: rootExec.at,
      process_instance_id: name + ":r",
      exec_index: 2,
      ...image(rootExec.exe ?? "/usr/bin/python", rootExec.argv),
      ...resources(rootExec.cpu),
    });
  for (const op of ops) {
    const parent = name + ":" + (op.parent ?? "r");
    records.push({
      kind: "process.start",
      at: op.start,
      process_instance_id: name + ":" + op.id,
      parent_process_instance_id: parent,
      inherited_from_exec_id: parent + ":exec:" + (op.parentExec ?? 1),
      is_root: false,
      pid: op.pid ?? 7,
      birth_ticks: String(op.start),
      ...image("/bin/bash"),
      initial_cpu_runtime_ns: "0",
      initial_user_cpu_ns: "0",
      initial_system_cpu_ns: "0",
    });
    if (op.exec !== null)
      records.push({
        kind: "process.exec",
        at: op.exec,
        process_instance_id: name + ":" + op.id,
        exec_index: 1,
        ...image(op.exe ?? "/usr/bin/job", op.argv),
        ...resources(op.preCpu ?? 1),
        ...(op.imageFields ?? {}),
      });
    if (op.end !== null)
      records.push({
        kind: "process.exit",
        at: op.end,
        process_instance_id: name + ":" + op.id,
        exit_code: op.exit ?? 0,
        signal: op.signal ?? null,
        ...resources(op.cpu),
      });
    if (op.extraThreadExit)
      records.push({
        kind: "thread.exit",
        at: op.end,
        process_instance_id: name + ":" + op.id,
        task_instance_id: "thread",
        ...resources(op.extraThreadExit),
      });
  }
  records.push({
    kind: "process.exit",
    at: rootEnd,
    process_instance_id: name + ":r",
    exit_code: 0,
    signal: null,
    ...resources(rootExec?.finalCpu ?? 110),
  });
  const complete = ops.every((op) => op.end !== null);
  const last = Math.max(rootEnd, ...ops.map((op) => op.end ?? op.exec));
  records.push({ kind: "trace.close", at: last + 1, complete });
  const tools = [
    { kind: "session.identity", at: 0, session_id: ocSession, parent_session_id: taskParent },
    {
      kind: "tool.start",
      at: 0,
      span_id: span,
      session_id: ocSession,
      call_id: context.call_id,
      tool: "shell",
      identity_quality: "exact_call",
      start_boundary: "tool_execute_before",
    },
    ...(mode === "process"
      ? [
          {
            kind: "shell.context",
            at: 0,
            span_id: span,
            session_id: ocSession,
            call_id: context.call_id,
          },
        ]
      : []),
    {
      kind: exact ? "tool.end" : "tool.terminal_observed",
      at: toolEnd,
      span_id: span,
      session_id: ocSession,
      call_id: context.call_id,
      tool: "shell",
      end_boundary: exact ? "tool_execute_after" : "event_observed",
      status: exact ? "returned" : "error",
      exit_code: 0,
    },
    { kind: "trace.close", at: toolEnd + 1, complete: true },
  ];
  const encode = (id, producer, events, domain) => {
    const rows = [
      {
        kind: "trace.open",
        at: 0,
        producer,
        context,
        mode,
        producer_version: "1",
        clock_source:
          producer === "opencode_plugin"
            ? "js_hrtime_calibrated_to_linux_monotonic"
            : "linux_monotonic_tracer_observed",
        clock_mapping: {
          offset_ns: (BASE - 100n).toString(),
          uncertainty_ns: "100",
          source_clock_id: id,
        },
        cpu_resolution_ns: cpu(10),
      },
      ...events,
    ];
    return rows.map(({ at: time, ...row }, i) => ({
      schema: "openinspect-execution-v1",
      stream_id: id,
      clock_id: domain,
      seq: i + 1,
      mono_ns: at(time),
      source_mono_ns: (100n + BigInt(time) * 1000000n).toString(),
      ...row,
    }));
  };
  return {
    context,
    mode,
    streams: [
      {
        name: "tools-" + name + ".jsonl",
        rows: encode("tools-" + name, "opencode_plugin", tools, toolClock),
      },
      ...(mode === "process"
        ? [
            {
              name: "process-" + name + ".jsonl",
              rows: encode("process-" + name, "ptrace_lifecycle", records, clock),
            },
          ]
        : []),
    ],
  };
}

export function bundleFixture(
  directory,
  scenarios = [scenario()],
  {
    sessions = [{ id: "root", parentSessionId: null, spawnDepth: 0 }],
    mutate,
    events = [],
    repositories = [
      { repo_owner: "group/subgroup", repo_name: "repo", base_sha: "a".repeat(40), branch: "main" },
    ],
  } = {}
) {
  mkdirSync(directory, { recursive: true });
  const captureDir = directory + "-capture";
  mkdirSync(captureDir);
  const write = (name, data) => {
    mkdirSync(join(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), JSON.stringify(data, null, 2) + "\n");
  };
  const capture = {
    schema: "openinspect-capture-v1",
    run_id: "run",
    attempt_id: "attempt",
    boots: {},
    files: {},
    losses: [],
  };
  for (const fixture of scenarios) {
    const ctx = fixture.context;
    capture.boots[ctx.runtime_boot_id] = {
      finished: true,
      identity: {
        mode: fixture.mode,
        inspect_session_id: ctx.inspect_session_id,
        repositories,
      },
    };
    for (const stream of fixture.streams) {
      if (mutate) mutate(stream);
      const raw = stream.rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
      writeFileSync(join(captureDir, stream.name), raw);
      capture.files[stream.name] = { bytes: Buffer.byteLength(raw) };
    }
  }
  writeFileSync(join(captureDir, "capture.json"), JSON.stringify(capture));
  write("raw/session-index.json", { sessions });
  write("missingness.json", {});
  write("completeness.json", {
    rootSessionId: "root",
    sessionCount: sessions.length,
    sessionIds: sessions.map((s) => s.id),
    sessions: sessions.map((s) => ({
      sessionId: s.id,
      eventCount: events.filter((e) => e.sessionId === s.id).length,
      messageCount: 0,
    })),
    eventCount: events.length,
    messageCount: 0,
    eventTypes: Object.fromEntries(
      [...new Set(events.map((e) => e.type))]
        .sort()
        .map((type) => [type, events.filter((e) => e.type === type).length])
    ),
    parentMismatches: [],
  });
  mkdirSync(join(directory, "normalized"));
  writeFileSync(
    join(directory, "normalized/events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "")
  );
  writeFileSync(join(directory, "normalized/messages.jsonl"), "");
  const executionTrace = attachExecutionCapture({
    outputDir: directory,
    captureDir,
    sessionIds: sessions.map((s) => s.id),
  });
  const base = [
    "raw/session-index.json",
    "completeness.json",
    "missingness.json",
    "normalized/events.jsonl",
    "normalized/messages.jsonl",
    executionTrace.indexFile,
  ];
  for (const file of scenarios
    .flatMap((s) => s.streams)
    .map((_, i) => `raw/execution/stream-${String(i + 1).padStart(5, "0")}.jsonl`))
    base.push(file);
  write("hashes.json", {
    algorithm: "sha256",
    files: base.map((path) => ({ path, ...hashFile(join(directory, path)) })),
  });
  write("manifest.json", {
    schemaVersion: "openinspect-trace-v0",
    source: { rootSessionId: "root" },
    counts: { sessions: sessions.length, events: events.length, messages: 0 },
    executionTrace,
  });
  return directory;
}
