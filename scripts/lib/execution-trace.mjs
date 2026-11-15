/** Execution attachment snapshots preserve bytes, including damaged/unclosed prefixes. */
import { readFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const EXECUTION_SCHEMA = "openinspect-execution-v1";
const MAX_BYTES = 1024 * 1024 * 1024;

function safeFile(root, name) {
  if (typeof name !== "string" || isAbsolute(name) || name.split(/[\\/]/).includes(".."))
    throw new Error("Invalid execution evidence path");
  const target = resolve(root, name);
  if (!relative(root, target) || relative(root, target).startsWith(".."))
    throw new Error("Execution path escapes capture");
  let current = root;
  for (const part of name.split("/")) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error("Execution evidence cannot use symlinks");
  }
  if (!lstatSync(target).isFile()) throw new Error("Execution evidence must be a regular file");
  return target;
}

export function inspectExecutionStream(bytes, path) {
  const issues = [];
  const records = [];
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    issues.push("invalid_utf8");
  }
  const lines = bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  else if (bytes.length) issues.push("partial_tail");
  let streamId;
  let clockId;
  for (let i = 0; i < lines.length; i++) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      issues.push(`invalid_json:${i + 1}`);
      continue;
    }
    if (
      !row ||
      typeof row !== "object" ||
      row.schema !== EXECUTION_SCHEMA ||
      !Number.isInteger(row.seq) ||
      row.seq !== i + 1 ||
      typeof row.stream_id !== "string" ||
      typeof row.clock_id !== "string" ||
      typeof row.mono_ns !== "string" ||
      !/^\d+$/.test(row.mono_ns)
    ) {
      issues.push(`invalid_envelope:${i + 1}`);
      continue;
    }
    streamId ??= row.stream_id;
    clockId ??= row.clock_id;
    if (streamId !== row.stream_id || clockId !== row.clock_id)
      issues.push(`identity_change:${i + 1}`);
    records.push({ ...row, source: { path, line: i + 1 } });
  }
  if (records[0]?.kind !== "trace.open") issues.push("missing_open");
  const close = records.at(-1);
  if (close?.kind !== "trace.close") issues.push("missing_close");
  else if (close.complete !== true) issues.push("producer_incomplete");
  if (records.some((r) => r.kind === "trace.loss")) issues.push("producer_loss");
  if (
    records.slice(1).some((r) => r.kind === "trace.open") ||
    records.slice(0, -1).some((r) => r.kind === "trace.close")
  )
    issues.push("invalid_stream_boundary");
  const processes = new Map();
  const spans = new Set();
  const observedTerminals = new Set();
  const exactEnds = new Set();
  for (const row of records) {
    if (row.kind === "process.start") {
      if (processes.has(row.process_instance_id)) issues.push("duplicate_process_start");
      processes.set(row.process_instance_id, false);
    }
    if (row.kind === "process.exit") {
      if (!processes.has(row.process_instance_id) || processes.get(row.process_instance_id))
        issues.push("unmatched_process_exit");
      processes.set(row.process_instance_id, true);
    }
    if (row.kind === "tool.start") {
      if (spans.has(row.span_id)) issues.push("duplicate_span");
      spans.add(row.span_id);
    }
    if (row.kind === "tool.end") exactEnds.add(row.span_id);
    if (row.kind === "tool.terminal_observed") observedTerminals.add(row.span_id);
  }
  if ([...processes.values()].some((ended) => !ended)) issues.push("missing_process_exit");
  if ([...spans].some((id) => !exactEnds.has(id) && !observedTerminals.has(id)))
    issues.push("missing_tool_terminal");
  return {
    path,
    stream_id: streamId ?? null,
    producer: records[0]?.producer ?? null,
    issues: [...new Set(issues)],
    records,
    exact_tool_ends_missing: [...spans].filter((id) => !exactEnds.has(id)).length,
  };
}

export function executionQuality(streams, capture, expectedSessionIds, expectedBootIds = []) {
  const issues = [];
  const observedSessions = new Set();
  const observedBoots = new Set();
  const ids = new Set();
  const contexts = new Map();
  const bindings = new Map();
  for (const stream of streams) {
    if (ids.has(stream.stream_id)) issues.push("duplicate_stream_id");
    ids.add(stream.stream_id);
    const first = stream.records[0];
    const context = first?.context;
    if (context?.inspect_session_id) observedSessions.add(context.inspect_session_id);
    if (context?.runtime_boot_id) observedBoots.add(context.runtime_boot_id);
    const registration = capture?.boots?.[context?.runtime_boot_id]?.identity;
    if (!registration || registration.inspect_session_id !== context?.inspect_session_id)
      stream.issues.push("boot_registration_mismatch");
    if (
      capture &&
      (context?.run_id !== capture.run_id || context?.attempt_id !== capture.attempt_id)
    )
      stream.issues.push("run_identity_mismatch");
    if (context?.inspect_session_id && !expectedSessionIds.includes(context.inspect_session_id))
      stream.issues.push("outside_expected_tree");
    for (const row of stream.records) {
      if (row.kind === "shell.context")
        contexts.set(row.span_id, (contexts.get(row.span_id) ?? 0) + 1);
      if (row.kind === "shell.bind")
        bindings.set(row.span_id, (bindings.get(row.span_id) ?? 0) + 1);
    }
  }
  const processMode = Object.values(capture?.boots ?? {}).some(
    (boot) => boot.identity.mode === "process"
  );
  if (processMode) {
    for (const [span, count] of contexts)
      if (bindings.get(span) !== count) issues.push("shell_binding_missing_or_ambiguous");
    for (const span of bindings.keys())
      if (!contexts.has(span)) issues.push("shell_context_missing");
  }
  const missingSessions = expectedSessionIds.filter((id) => !observedSessions.has(id));
  const missingBoots = [
    ...new Set([...expectedBootIds, ...Object.keys(capture?.boots ?? {})]),
  ].filter((id) => !observedBoots.has(id));
  const unfinishedBoots = Object.entries(capture?.boots ?? {})
    .filter(([, boot]) => !boot.finished)
    .map(([id]) => id);
  if (missingSessions.length) issues.push("missing_sessions");
  if (missingBoots.length) issues.push("missing_boots");
  if (unfinishedBoots.length) issues.push("runtime_not_finished");
  if (capture?.losses?.length) issues.push("capture_loss");
  if (!capture) issues.push("capture_inventory_unavailable");
  return {
    complete: streams.length > 0 && !issues.length && streams.every((s) => !s.issues.length),
    issues: [...new Set(issues)],
    missing_sessions: missingSessions,
    missing_boots: missingBoots,
    unfinished_boots: unfinishedBoots,
    streams: streams.map(({ records, ...summary }) => ({ ...summary, records: records.length })),
  };
}

export function attachExecutionCapture({ outputDir, captureDir, sessionIds, events = [] }) {
  if (!captureDir) return { status: "unavailable" };
  const root = resolve(captureDir);
  if (lstatSync(root).isSymbolicLink()) throw new Error("Capture root cannot be a symlink");
  const capture = JSON.parse(readFileSync(safeFile(root, "capture.json"), "utf8"));
  if (capture.schema !== "openinspect-capture-v1" || !capture.files || !capture.boots)
    throw new Error("Unsupported capture inventory");
  const destination = join(outputDir, "raw/execution");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const streams = [];
  const attachments = [];
  let total = 0;
  for (const [i, name] of Object.keys(capture.files).sort().entries()) {
    const input = safeFile(root, name);
    total += lstatSync(input).size;
    if (total > MAX_BYTES) throw new Error("Execution attachment byte limit");
    const bytes = readFileSync(input);
    const path = `raw/execution/stream-${String(i + 1).padStart(5, "0")}.jsonl`;
    writeFileSync(join(outputDir, path), bytes, { mode: 0o600, flag: "wx" });
    const stream = inspectExecutionStream(bytes, path);
    streams.push(stream);
    attachments.push({
      path,
      source_path: name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const boots = [
    ...new Set(
      events
        .filter((e) => e.type === "ready")
        .map((e) => e.data?.runtimeBootId)
        .filter(Boolean)
    ),
  ];
  const quality = executionQuality(streams, capture, sessionIds, boots);
  const index = {
    schema: "openinspect-execution-index-v1",
    capture,
    attachments,
    quality,
    expected_session_ids: sessionIds,
    expected_boot_ids: boots,
  };
  const indexFile = "raw/execution/index.json";
  writeFileSync(join(outputDir, indexFile), JSON.stringify(index, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  return {
    schemaVersion: EXECUTION_SCHEMA,
    status: quality.complete ? "complete" : "incomplete",
    indexFile,
  };
}
