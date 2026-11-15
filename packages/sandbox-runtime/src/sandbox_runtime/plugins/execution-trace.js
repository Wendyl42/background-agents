/** Execution evidence is append-only; never send it through UI event upserts. */
import {
  accessSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, isAbsolute, basename, resolve, delimiter } from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout, clearTimeout } from "node:timers";

async function calibrateClock(defaults) {
  const child = spawn(
    process.env.OI_EXECUTION_TRACE_PYTHON || "python3",
    ["-I", "-S", "-u", process.env.OI_EXECUTION_TRACE_CLOCK_HELPER],
    { stdio: ["pipe", "pipe", "ignore"] }
  );
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let timer;
  const failure = new Promise((_, reject) => {
    child.once("error", reject);
    timer = setTimeout(
      () => reject(new Error("Execution trace clock calibration timed out")),
      defaults.clock_timeout_ms
    );
  });
  try {
    return await Promise.race([
      failure,
      (async () => {
        const header = JSON.parse((await iterator.next()).value);
        let best;
        for (let i = 0; i < defaults.clock_samples; i++) {
          const before = process.hrtime.bigint();
          child.stdin.write("sample\n");
          const reference = BigInt((await iterator.next()).value);
          const after = process.hrtime.bigint();
          const rtt = after - before;
          if (!best || rtt < best.rtt) best = { rtt, offset: reference - (before + after) / 2n };
        }
        return {
          ...header,
          offset: best.offset,
          uncertainty: (best.rtt + 1n) / 2n,
          samples: defaults.clock_samples,
        };
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

function identity(environment) {
  const session = JSON.parse(environment.SESSION_CONFIG || "{}");
  return {
    run_id: environment.OI_EXECUTION_TRACE_RUN_ID || null,
    attempt_id: environment.OI_EXECUTION_TRACE_ATTEMPT_ID || null,
    inspect_session_id: session.session_id || session.sessionId || null,
    parent_inspect_session_id: session.parent_session_id || session.parentSessionId || null,
    sandbox_id: environment.SANDBOX_ID || null,
    runtime_boot_id: environment.OI_RUNTIME_BOOT_ID || null,
  };
}

function writer(directory, defaults, context, clock) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const streamId = randomUUID();
  const streamFile = `tools-${streamId}.jsonl`;
  if (process.env.OI_EXECUTION_TRACE_MANAGED === "1") {
    const leases = join(directory, "leases");
    mkdirSync(leases, { recursive: true, mode: 0o700 });
    let reserved = false;
    for (let slot = 0; slot < defaults.max_pending_streams; slot++) {
      try {
        const lease = openSync(
          join(leases, String(slot)),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        );
        try {
          writeSync(lease, streamFile);
        } finally {
          closeSync(lease);
        }
        reserved = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    if (!reserved) {
      try {
        const marker = openSync(
          join(directory, "overflow.json"),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        );
        try {
          writeSync(marker, JSON.stringify({ reason: "pending_stream_limit" }));
        } finally {
          closeSync(marker);
        }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      throw new Error("Execution trace pending-stream budget exhausted");
    }
  }
  const fd = openSync(
    join(directory, streamFile),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  let seq = 0;
  let bytes = 0;
  let closed = false;
  let failed = false;
  function raw(kind, fields) {
    const sourceNs = process.hrtime.bigint();
    const line = Buffer.from(
      JSON.stringify({
        schema: defaults.schema,
        stream_id: streamId,
        seq: ++seq,
        kind,
        mono_ns: (sourceNs + clock.offset).toString(),
        source_mono_ns: sourceNs.toString(),
        clock_id: clock.clock_id,
        ...fields,
      }) + "\n"
    );
    let offset = 0;
    while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset);
    bytes += line.length;
  }
  function close(reason = "dispose", complete = true) {
    if (closed) return;
    try {
      raw("trace.close", { reason, complete: complete && !failed, preceding_records: seq });
      fsyncSync(fd);
    } catch (error) {
      failed = true;
      process.stderr.write(`execution-trace: stream write failed (${error.code || "unknown"})\n`);
    } finally {
      closed = true;
      closeSync(fd);
    }
  }
  function emit(kind, fields = {}) {
    if (closed) return false;
    if (kind === "trace.loss") failed = true;
    try {
      // Reserve room for a loss record and footer rather than silently truncating.
      const estimate = Buffer.byteLength(JSON.stringify(fields)) + 512;
      if (bytes + estimate > defaults.max_stream_bytes - defaults.reserved_tail_bytes) {
        failed = true;
        raw("trace.loss", { reason: "stream_byte_limit", dropped_records_at_least: 1 });
        close("stream_byte_limit", false);
        return false;
      }
      raw(kind, fields);
      return true;
    } catch (error) {
      failed = true;
      close(`write_error:${error.code || "unknown"}`, false);
      return false;
    }
  }
  const opened = emit("trace.open", {
    producer: "opencode_plugin",
    producer_version: defaults.producer_version,
    mode: process.env.OI_EXECUTION_TRACE_MODE,
    context,
    epoch_ms: Date.now(),
    clock_source: "js_hrtime_calibrated_to_linux_monotonic",
    clock_mapping: {
      method: "minimum_round_trip_midpoint",
      offset_ns: clock.offset.toString(),
      uncertainty_ns: clock.uncertainty.toString(),
      samples: clock.samples,
      source_clock_id: streamId,
    },
    host_boot_id: clock.host_boot_id,
    time_namespace: clock.time_namespace,
    pid: process.pid,
    handshake: process.env.OI_EXECUTION_TRACE_HANDSHAKE,
  });
  return { emit, close, opened, streamId, streamFile };
}

function resolveBash(selected, projectDirectory) {
  if (typeof selected !== "string" || basename(selected) !== "bash")
    throw new Error("Process tracing requires the effective OpenCode shell to be Bash");
  const candidates = isAbsolute(selected)
    ? [selected]
    : selected.includes("/")
      ? [resolve(projectDirectory, selected)]
      : (process.env.PATH || "")
          .split(delimiter)
          .map((part) => resolve(projectDirectory, part || ".", selected));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error("Effective Bash executable is unavailable");
}

export const ExecutionTrace = async (pluginInput = {}) => {
  const mode = process.env.OI_EXECUTION_TRACE_MODE || "off";
  if (mode === "off") return {};
  if (mode !== "tools" && mode !== "process") throw new Error("Unsupported execution trace mode");
  const directory = process.env.OI_EXECUTION_TRACE_DIR;
  if (!directory || !isAbsolute(directory))
    throw new Error("Execution trace directory must be absolute");
  const handshake = process.env.OI_EXECUTION_TRACE_HANDSHAKE;
  if (!handshake || !/^[a-f0-9-]{36}$/.test(handshake))
    throw new Error("Execution trace readiness nonce missing");
  const defaults = JSON.parse(readFileSync(process.env.OI_EXECUTION_TRACE_DEFAULTS, "utf8"));
  const projectDirectory = realpathSync(pluginInput.directory || process.cwd());
  const context = { ...identity(process.env), project_directory: projectDirectory };
  const clock = await calibrateClock(defaults);
  const output = writer(directory, defaults, context, clock);
  if (!output.opened) throw new Error("Execution trace stream could not be opened");
  let readyPublished = false;
  let realShell = null;
  let selectedShell = null;
  const publishReady = (extra = {}) => {
    if (readyPublished) return;
    const pendingMarker = join(directory, `pending-${handshake}-${output.streamId}.json`);
    const readyMarker = join(directory, `ready-${handshake}-${output.streamId}.json`);
    try {
      const marker = openSync(
        pendingMarker,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        const bytes = Buffer.from(
          JSON.stringify({
            handshake,
            stream_id: output.streamId,
            stream_file: output.streamFile,
            clock_id: clock.clock_id,
            project_directory: projectDirectory,
            ...extra,
          })
        );
        let offset = 0;
        while (offset < bytes.length)
          offset += writeSync(marker, bytes, offset, bytes.length - offset);
        fsyncSync(marker);
      } finally {
        closeSync(marker);
      }
      // A readable final marker certifies completed publication, not a partial write.
      renameSync(pendingMarker, readyMarker);
    } catch (error) {
      try {
        unlinkSync(pendingMarker);
      } catch {
        /* Startup will fail without a final marker. */
      }
      output.close("ready_publish_failed", false);
      throw error;
    }
    readyPublished = true;
  };
  if (mode === "tools") publishReady();
  const active = new Map();
  const completed = new Map();
  let disposed = false;
  const keyOf = (sessionID, callID) => JSON.stringify([sessionID, callID]);
  const remember = (key, span) => {
    active.delete(key);
    completed.set(key, span);
    while (completed.size > defaults.max_completed_spans)
      completed.delete(completed.keys().next().value);
  };
  const start = (input, boundary) => {
    const identified =
      typeof input.sessionID === "string" &&
      input.sessionID.length > 0 &&
      typeof input.callID === "string" &&
      input.callID.length > 0;
    // shell.env also serves anonymous terminals; never coalesce missing IDs.
    const key = identified ? keyOf(input.sessionID, input.callID) : randomUUID();
    if (active.has(key)) return active.get(key);
    if (active.size >= defaults.max_active_spans) {
      output.emit("trace.loss", { reason: "active_span_limit", dropped_records_at_least: 1 });
      return null;
    }
    const span = {
      span_id: randomUUID(),
      session_id: input.sessionID || null,
      call_id: input.callID || null,
      tool: input.tool || "shell",
      start_boundary: boundary,
      identity_quality: identified ? "exact_call" : "unattributed",
    };
    active.set(key, span);
    output.emit("tool.start", span);
    return span;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    output.close("plugin_dispose", active.size === 0);
    process.off("exit", dispose);
  };
  const linkTask = (span, metadata, source) => {
    const child = metadata?.sessionId;
    if (
      span.tool !== "task" ||
      typeof child !== "string" ||
      !child ||
      span.child_session_id === child
    )
      return;
    if (span.child_session_id)
      output.emit("trace.loss", { reason: "conflicting_task_child", span_id: span.span_id });
    span.child_session_id = child;
    output.emit("task.link", {
      span_id: span.span_id,
      session_id: span.session_id,
      call_id: span.call_id,
      child_session_id: child,
      source,
    });
  };
  process.once("exit", dispose);
  return {
    config: async (config) => {
      if (mode !== "process") return;
      try {
        const wrapper = process.env.OI_EXECUTION_TRACE_WRAPPER_SHELL;
        if (!wrapper || !isAbsolute(wrapper) || basename(wrapper) !== "bash")
          throw new Error("Execution trace wrapper is unavailable");
        accessSync(wrapper, constants.X_OK);
        if (config.shell === wrapper && realShell) return;
        selectedShell =
          config.shell || process.env.SHELL || process.env.OI_EXECUTION_TRACE_REAL_SHELL;
        realShell = resolveBash(selectedShell, projectDirectory);
        config.shell = wrapper;
        if (
          !output.emit("shell.configuration", {
            real_shell: realShell,
            selected_shell: selectedShell,
            wrapper_shell: wrapper,
            project_directory: projectDirectory,
          })
        )
          throw new Error("Could not persist shell configuration");
        publishReady({ real_shell: realShell, wrapper_shell: wrapper });
      } catch (error) {
        output.emit("trace.loss", { reason: "shell_configuration_failed" });
        output.close("shell_configuration_failed", false);
        throw error;
      }
    },
    "tool.execute.before": async (input) => {
      if (mode === "process" && !readyPublished) throw new Error("Process tracing is not ready");
      start(input, "tool_execute_before");
    },
    "tool.execute.after": async (input, result) => {
      const key = keyOf(input.sessionID, input.callID);
      const span = active.get(key) || completed.get(key);
      if (!span) {
        output.emit("trace.loss", {
          reason: "tool_end_without_start",
          session_id: input.sessionID,
          call_id: input.callID,
        });
        return;
      }
      if (span.execution_ended) return;
      linkTask(span, result?.metadata, "tool_result_metadata");
      output.emit("tool.end", {
        ...span,
        end_boundary: "tool_execute_after",
        status: "returned",
        exit_code: Number.isInteger(result?.metadata?.exit) ? result.metadata.exit : null,
      });
      span.execution_ended = true;
      remember(key, span);
    },
    "shell.env": async (input, result) => {
      if (mode === "process") {
        if (!readyPublished || !realShell)
          throw new Error("Process tracing shell is not configured");
        // Resolve with the actual spawn cwd and final environment in the launcher.
        // A tool workdir or another shell.env hook may differ from project defaults.
        result.env.OI_EXECUTION_TRACE_REAL_SHELL = selectedShell;
      }
      const key = keyOf(input.sessionID, input.callID);
      const span = active.get(key) || start(input, "shell_dispatch");
      if (!span) return;
      result.env.OI_EXECUTION_TRACE_CONTEXT = JSON.stringify({ ...context, ...span });
      output.emit("shell.context", { ...span, cwd: input.cwd || null });
    },
    event: async ({ event }) => {
      if (event?.type === "session.created") {
        const info = event.properties?.info;
        if (info?.id)
          output.emit("session.identity", {
            session_id: info.id,
            parent_session_id: info.parentID || null,
          });
        return;
      }
      const part = event?.properties?.part;
      if (event?.type !== "message.part.updated" || part?.type !== "tool") return;
      const key = keyOf(part.sessionID, part.callID);
      let span = active.get(key) || completed.get(key);
      // Parts can precede execution hooks. They are identity observations, not starts.
      if (!span) {
        output.emit("tool.part_observed", {
          session_id: part.sessionID,
          call_id: part.callID,
          message_id: part.messageID,
          part_id: part.id,
          status: part.state?.status,
        });
        return;
      }
      if (!span.message_id) {
        span.message_id = part.messageID || null;
        output.emit("tool.identity", { ...span, part_id: part.id || null });
      }
      linkTask(span, part.state?.metadata, "tool_part_metadata");
      if (!["completed", "error"].includes(part.state?.status) || span.terminal_observed) return;
      output.emit("tool.terminal_observed", {
        ...span,
        status: part.state.status,
        end_boundary: "event_observed",
        source_time: part.state.time || null,
      });
      span.terminal_observed = true;
      remember(key, span);
    },
    dispose,
  };
};
