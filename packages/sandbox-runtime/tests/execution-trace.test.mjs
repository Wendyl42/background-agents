import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ExecutionTrace } from "../src/sandbox_runtime/plugins/execution-trace.js";

const defaultsPath = fileURLToPath(
  new URL("../src/sandbox_runtime/tracing/defaults.json", import.meta.url)
);

async function fixture(t, overrides = {}, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "oi-tools-"));
  const defaults = { ...JSON.parse(readFileSync(defaultsPath)), ...overrides };
  const customDefaults = join(directory, "defaults.json");
  writeFileSync(customDefaults, JSON.stringify(defaults));
  const wrapper = join(directory, "bash");
  writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const environment = {
    OI_EXECUTION_TRACE_MODE: options.mode || "tools",
    OI_EXECUTION_TRACE_DIR: directory,
    OI_EXECUTION_TRACE_DEFAULTS: customDefaults,
    OI_EXECUTION_TRACE_HANDSHAKE: randomUUID(),
    OI_EXECUTION_TRACE_REAL_SHELL: "/bin/bash",
    OI_EXECUTION_TRACE_WRAPPER_SHELL: wrapper,
    OI_EXECUTION_TRACE_CLOCK_HELPER: fileURLToPath(
      new URL("../src/sandbox_runtime/tracing/clock.py", import.meta.url)
    ),
    SESSION_CONFIG: JSON.stringify({
      session_id: "inspect-parent",
      parent_session_id: "inspect-ancestor",
    }),
    ...options.env,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  const hooks = await ExecutionTrace({ directory });
  t.after(() => {
    hooks.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    hooks,
    directory,
    records() {
      return readdirSync(directory)
        .filter((name) => name.endsWith(".jsonl"))
        .flatMap((name) =>
          readFileSync(join(directory, name), "utf8").trim().split("\n").map(JSON.parse)
        );
    },
  };
}

test("disabled plugin has no hooks or filesystem side effects", async () => {
  const previous = process.env.OI_EXECUTION_TRACE_MODE;
  process.env.OI_EXECUTION_TRACE_MODE = "off";
  try {
    assert.deepEqual(await ExecutionTrace(), {});
  } finally {
    if (previous === undefined) delete process.env.OI_EXECUTION_TRACE_MODE;
    else process.env.OI_EXECUTION_TRACE_MODE = previous;
  }
});

test("process readiness honors effective project shell ahead of environment shell", async (t) => {
  const { hooks, directory, records } = await fixture(
    t,
    {},
    { mode: "process", env: { SHELL: "/bin/sh" } }
  );
  assert.equal(readdirSync(directory).filter((name) => name.startsWith("ready-")).length, 0);
  const config = { shell: "/bin/bash", permission: { "*": "allow" } };
  await hooks.config(config);
  assert.equal(config.shell, process.env.OI_EXECUTION_TRACE_WRAPPER_SHELL);
  assert.deepEqual(config.permission, { "*": "allow" });
  assert.equal(process.env.SHELL, "/bin/sh");
  const target = { env: {} };
  await hooks["shell.env"]({ sessionID: "s", callID: "c", cwd: directory }, target);
  assert.equal(target.env.OI_EXECUTION_TRACE_REAL_SHELL, "/bin/bash");
  const marker = JSON.parse(
    readFileSync(
      join(
        directory,
        readdirSync(directory).find((name) => name.startsWith("ready-"))
      ),
      "utf8"
    )
  );
  assert.equal(marker.project_directory, directory);
  assert.equal(records()[0].context.project_directory, directory);
});

test("unsupported effective shell cannot publish readiness or execute a tool", async (t) => {
  const { hooks, directory, records } = await fixture(
    t,
    {},
    { mode: "process", env: { SHELL: "/bin/bash" } }
  );
  const config = { shell: "/bin/sh" };
  await assert.rejects(hooks.config(config), /effective OpenCode shell/);
  assert.equal(config.shell, "/bin/sh");
  assert.equal(readdirSync(directory).filter((name) => name.startsWith("ready-")).length, 0);
  await assert.rejects(
    hooks["tool.execute.before"]({ sessionID: "s", callID: "c", tool: "read" }),
    /not ready/
  );
  assert.equal(records().at(-1).complete, false);
});

for (const selected of ["./bash", "bash"]) {
  test(`effective shell ${selected} resolves relative to the native project`, async (t) => {
    const { hooks, directory } = await fixture(t, {}, { mode: "process" });
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = ".";
      await hooks.config({ shell: selected });
      const target = { env: {} };
      await hooks["shell.env"]({ sessionID: "s", callID: "c", cwd: directory }, target);
      assert.equal(target.env.OI_EXECUTION_TRACE_REAL_SHELL, selected);
      const marker = JSON.parse(
        readFileSync(
          join(
            directory,
            readdirSync(directory).find((name) => name.startsWith("ready-"))
          ),
          "utf8"
        )
      );
      assert.equal(marker.real_shell, join(directory, "bash"));
    } finally {
      process.env.PATH = oldPath;
    }
  });
}

test("concurrent identical call IDs in different sessions retain distinct exact spans", async (t) => {
  const { hooks, records } = await fixture(t);
  const first = { sessionID: "oc-parent", callID: "same-call", tool: "bash" };
  const second = { sessionID: "oc-task-child", callID: "same-call", tool: "bash" };
  const args = { command: "do-not-copy-this-command" };
  await Promise.all([
    hooks["tool.execute.before"](first, { args }),
    hooks["tool.execute.before"](second, { args }),
  ]);
  const env1 = { env: { PRESERVED: "value" } };
  const env2 = { env: {} };
  await hooks["shell.env"]({ ...first, cwd: "/repo" }, env1);
  await hooks["shell.env"]({ ...second, cwd: "/repo" }, env2);
  assert.equal(env1.env.PRESERVED, "value");
  assert.equal(process.env.OI_EXECUTION_TRACE_CONTEXT, undefined);
  assert.equal(args.command, "do-not-copy-this-command");
  const contexts = [env1, env2].map((env) => JSON.parse(env.env.OI_EXECUTION_TRACE_CONTEXT));
  assert.notEqual(contexts[0].span_id, contexts[1].span_id);
  assert.equal(contexts[0].inspect_session_id, "inspect-parent");
  await hooks["tool.execute.after"](second, { metadata: { exit: 7 } });
  await hooks["tool.execute.after"](first, { metadata: { exit: 0 } });
  hooks.dispose();
  const data = records();
  assert.equal(data.filter((row) => row.kind === "tool.start").length, 2);
  const ends = data.filter((row) => row.kind === "tool.end");
  assert.deepEqual(
    ends.map((row) => row.exit_code),
    [7, 0]
  );
  assert.equal(data.at(-1).complete, true);
  assert.deepEqual(
    data.map((row) => row.seq),
    data.map((_, i) => i + 1)
  );
  assert.equal(JSON.stringify(data).includes("do-not-copy-this-command"), false);
  for (const end of ends) {
    const start = data.find((row) => row.kind === "tool.start" && row.span_id === end.span_id);
    assert.ok(BigInt(end.mono_ns) >= BigInt(start.mono_ns));
    assert.equal(end.clock_id, start.clock_id);
  }
});

test("error and cancellation observations never become exact execution ends", async (t) => {
  const { hooks, records } = await fixture(t);
  for (const callID of ["error", "cancelled"]) {
    const input = { sessionID: "s", callID, tool: "read" };
    await hooks["tool.execute.before"](input);
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "s",
            callID,
            messageID: "msg-1",
            id: "part-1",
            state: { status: "error", time: { start: 100, end: 300 } },
          },
        },
      },
    });
  }
  hooks.dispose();
  const data = records();
  assert.equal(data.filter((row) => row.kind === "tool.end").length, 0);
  assert.equal(data.filter((row) => row.kind === "tool.terminal_observed").length, 2);
  assert.ok(
    data
      .filter((row) => row.kind === "tool.terminal_observed")
      .every((row) => row.end_boundary === "event_observed")
  );
  assert.equal(data.filter((row) => row.kind === "tool.identity")[0].message_id, "msg-1");
});

test("late after hook retains exact timing when terminal event arrived first", async (t) => {
  const { hooks, records } = await fixture(t);
  const input = { sessionID: "s", callID: "c", tool: "read" };
  await hooks["tool.execute.before"](input);
  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: { type: "tool", sessionID: "s", callID: "c", state: { status: "completed" } },
      },
    },
  });
  await hooks["tool.execute.after"](input, {});
  await hooks["tool.execute.after"](input, {});
  hooks.dispose();
  assert.equal(records().filter((row) => row.kind === "tool.end").length, 1);
});

test("concurrent Task calls retain exact edges to their distinct child sessions", async (t) => {
  const { hooks, records } = await fixture(t);
  for (const callID of ["task-a", "task-b"]) {
    await hooks["tool.execute.before"]({ sessionID: "parent", callID, tool: "task" });
  }
  for (const callID of ["task-b", "task-a"]) {
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "parent",
            callID,
            messageID: "parent-message",
            state: { status: "running", metadata: { sessionId: `child-${callID}` } },
          },
        },
      },
    });
    await hooks["tool.execute.after"](
      { sessionID: "parent", callID, tool: "task" },
      { metadata: { sessionId: `child-${callID}` } }
    );
  }
  hooks.dispose();
  const edges = records().filter((row) => row.kind === "task.link");
  assert.equal(edges.length, 2);
  assert.notEqual(edges[0].span_id, edges[1].span_id);
  assert.deepEqual(
    edges.map((row) => [row.call_id, row.child_session_id]),
    [
      ["task-b", "child-task-b"],
      ["task-a", "child-task-a"],
    ]
  );
});

test("direct shell dispatch is labeled and unmatched starts keep closure incomplete", async (t) => {
  const { hooks, records } = await fixture(t);
  await hooks["shell.env"]({ sessionID: "s", callID: "direct", cwd: "/repo" }, { env: {} });
  hooks.dispose();
  assert.equal(records().find((row) => row.kind === "tool.start").start_boundary, "shell_dispatch");
  assert.equal(records().at(-1).complete, false);
});

test("anonymous shell launches never share a synthetic current-call identity", async (t) => {
  const { hooks, records } = await fixture(t);
  const first = { env: {} };
  const second = { env: {} };
  await hooks["shell.env"]({ cwd: "/repo" }, first);
  await hooks["shell.env"]({ cwd: "/repo" }, second);
  assert.notEqual(
    JSON.parse(first.env.OI_EXECUTION_TRACE_CONTEXT).span_id,
    JSON.parse(second.env.OI_EXECUTION_TRACE_CONTEXT).span_id
  );
  hooks.dispose();
  const starts = records().filter((row) => row.kind === "tool.start");
  assert.equal(starts.length, 2);
  assert.ok(starts.every((row) => row.identity_quality === "unattributed"));
});

test("stream limit produces explicit loss and incomplete footer", async (t) => {
  const { hooks, records } = await fixture(t, { max_stream_bytes: 8192 });
  for (let i = 0; i < 100; i++) {
    const input = { sessionID: "s", callID: `c${i}`, tool: "read" };
    await hooks["tool.execute.before"](input);
    await hooks["tool.execute.after"](input, {});
  }
  hooks.dispose();
  const data = records();
  assert.equal(data.at(-2).kind, "trace.loss");
  assert.equal(data.at(-1).reason, "stream_byte_limit");
  assert.equal(data.at(-1).complete, false);
  assert.ok(Buffer.byteLength(data.map(JSON.stringify).join("\n")) < 8192);
});

test("active span cap reports loss instead of silently evicting an active call", async (t) => {
  const { hooks, records } = await fixture(t, { max_active_spans: 1 });
  await hooks["tool.execute.before"]({ sessionID: "s", callID: "1", tool: "read" });
  await hooks["tool.execute.before"]({ sessionID: "s", callID: "2", tool: "read" });
  await hooks["tool.execute.after"]({ sessionID: "s", callID: "1", tool: "read" }, {});
  hooks.dispose();
  assert.equal(records().filter((row) => row.kind === "tool.start").length, 1);
  assert.equal(records().find((row) => row.kind === "trace.loss").reason, "active_span_limit");
  assert.equal(records().at(-1).complete, false);
});

test("calibration failure rejects initialization instead of inventing a shared clock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oi-clock-failure-"));
  const environment = {
    OI_EXECUTION_TRACE_MODE: "tools",
    OI_EXECUTION_TRACE_DIR: directory,
    OI_EXECUTION_TRACE_DEFAULTS: defaultsPath,
    OI_EXECUTION_TRACE_HANDSHAKE: randomUUID(),
    OI_EXECUTION_TRACE_CLOCK_HELPER: join(directory, "missing.py"),
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  try {
    await assert.rejects(ExecutionTrace());
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed readiness fsync never publishes a final marker", () => {
  const directory = mkdtempSync(join(tmpdir(), "oi-ready-failure-"));
  try {
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      fs.fsyncSync = () => { throw Object.assign(new Error('injected'), {code:'EIO'}); };
      syncBuiltinESMExports();
      const { ExecutionTrace } = await import(${JSON.stringify(new URL("../src/sandbox_runtime/plugins/execution-trace.js", import.meta.url).href)});
      try { await ExecutionTrace(); process.exitCode = 9; }
      catch { process.exitCode = 0; }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        OI_EXECUTION_TRACE_MODE: "tools",
        OI_EXECUTION_TRACE_DIR: directory,
        OI_EXECUTION_TRACE_DEFAULTS: defaultsPath,
        OI_EXECUTION_TRACE_HANDSHAKE: randomUUID(),
        OI_EXECUTION_TRACE_CLOCK_HELPER: fileURLToPath(
          new URL("../src/sandbox_runtime/tracing/clock.py", import.meta.url)
        ),
      },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(
      readdirSync(directory).filter(
        (name) => name.startsWith("ready-") || name.startsWith("pending-")
      ).length,
      0
    );
    const stream = readdirSync(directory).find((name) => name.endsWith(".jsonl"));
    const data = readFileSync(join(directory, stream), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(data.at(-1).complete, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Linux Node hrtime brackets independent Python monotonic clock",
  { skip: process.platform !== "linux" },
  () => {
    const before = process.hrtime.bigint();
    const child = spawnSync("python3", ["-c", "import time; print(time.monotonic_ns())"], {
      encoding: "utf8",
    });
    const after = process.hrtime.bigint();
    assert.equal(child.status, 0, child.stderr);
    const sample = BigInt(child.stdout.trim());
    assert.ok(before <= sample && sample <= after, "clock domains do not match");
  }
);
