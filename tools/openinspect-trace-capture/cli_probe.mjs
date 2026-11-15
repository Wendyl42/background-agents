#!/usr/bin/env node
/** CLI contract fixture with two real runtime containers and a deterministic control-plane peer. */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import process from "node:process";
import assert from "node:assert/strict";
const { values } = parseArgs({ options: { out: { type: "string" } } });
const out = resolve(values.out);
mkdirSync(out, { mode: 0o700 });
const root = process.cwd();
const sessions = new Map();
const now = Date.now();
const rootId = "p3-cli-root-" + now,
  childId = "p3-cli-child-" + now;
let traceConfig, runtimeError;
async function runtime(id, parent) {
  const child = spawn(
    "docker",
    [
      "run",
      "--init",
      "--label",
      "openinspect_framework=open-inspect",
      "--label",
      `openinspect_session_id=${id}`,
      "--mount",
      `type=bind,source=${root},target=/repo,readonly`,
      "--entrypoint",
      "python3",
      "openinspect-runtime:opensandbox",
      "/repo/tools/openinspect-trace-capture/managed_probe.py",
      "--endpoint",
      traceConfig.endpoint,
      "--run-id",
      traceConfig.runId,
      "--attempt-id",
      traceConfig.attemptId,
      "--session",
      id,
      ...(parent ? ["--parent", parent] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const [code] = await once(child, "exit");
  writeFileSync(join(out, id + ".json"), JSON.stringify({ code, stdout, stderr }), { mode: 0o600 });
  if (code !== 0) {
    runtimeError = `runtime ${id} failed`;
    sessions.get(id).status = "failed";
    return;
  }
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  sessions.get(id).boot = result.runtime_boot_id;
  sessions.get(id).status = "completed";
}
const metadata = (id, s) => ({
  id,
  parentSessionId: s.parent,
  spawnDepth: s.parent ? 1 : 0,
  status: "completed",
  title: "CLI fixture",
  createdAt: now,
  updatedAt: now + 1,
});
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let bytes = "";
    for await (const chunk of req) bytes += chunk;
    const body = bytes ? JSON.parse(bytes) : {};
    let value;
    if (req.method === "POST" && url.pathname === "/sessions") {
      traceConfig = body.executionTrace;
      assert.equal(traceConfig.mode, "process");
      sessions.set(rootId, { parent: null, status: "processing" });
      value = { sessionId: rootId };
    } else if (req.method === "POST" && url.pathname.endsWith("/prompt")) {
      assert.equal(body.content, "Fixture prompt sent verbatim.\n");
      sessions.set(childId, { parent: rootId, status: "processing" });
      void Promise.all([runtime(rootId, null), runtime(childId, rootId)]);
      value = { messageId: "fixture-message" };
    } else if (req.method === "POST" && url.pathname.endsWith("/cancel")) value = { success: true };
    else if (url.pathname === "/sessions")
      value = { sessions: [...sessions].map(([id, s]) => metadata(id, s)), hasMore: false };
    else {
      const [, , id, resource] = url.pathname.split("/");
      const s = sessions.get(id);
      if (!s) throw new Error("Unknown session");
      if (resource === "children")
        value = {
          children: [...sessions]
            .filter(([, c]) => c.parent === id)
            .map(([child, c]) => metadata(child, c)),
          hasMore: false,
        };
      else if (resource === "messages")
        value = {
          messages: [
            {
              id: "msg-" + id,
              content: "Fixture prompt",
              status: s.status,
              createdAt: now,
              startedAt: now,
              completedAt: s.status === "completed" ? now + 1 : null,
            },
          ],
          hasMore: false,
        };
      else if (resource === "events")
        value = {
          events: s.boot
            ? [
                {
                  id: "ready-" + id,
                  type: "ready",
                  createdAt: now,
                  data: {
                    sandboxBackend: "opensandbox",
                    runtimeBootId: s.boot,
                    sandboxId: id + "-sandbox",
                  },
                },
              ]
            : [],
          hasMore: false,
        };
      else if (resource === "artifacts") value = { artifacts: [] };
      else if (resource === "participants") value = { participants: [] };
      else throw new Error("Unknown route");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  } catch (error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const connection = join(out, "connection.json"),
  prompt = join(out, "prompt.txt");
writeFileSync(
  connection,
  JSON.stringify({
    controlPlaneUrl: `http://127.0.0.1:${server.address().port}`,
    exportServiceSecret: "local-fixture-only",
    sandboxBackend: "opensandbox",
  }),
  { mode: 0o600 }
);
writeFileSync(prompt, "Fixture prompt sent verbatim.\n");
try {
  const child = spawn(
    process.execPath,
    [
      "tools/openinspect-trace-capture/cli.mjs",
      "--out",
      join(out, "run"),
      "--connection",
      connection,
      "--prompt-file",
      prompt,
      "--deadline-seconds",
      "90",
    ],
    { stdio: "inherit" }
  );
  const [code] = await once(child, "exit");
  assert.equal(code, 0, runtimeError);
  const result = JSON.parse(readFileSync(join(out, "run/result.json")));
  assert.equal(result.status, "pass");
  const cleanup = JSON.parse(readFileSync(join(out, "run/cleanup.json")));
  assert.equal(cleanup.length, 2);
  const quality = JSON.parse(readFileSync(join(out, "run/trace/raw/execution/index.json"))).quality;
  assert.equal(quality.complete, true);
  assert.equal(quality.streams.length, 6);
  assert.equal(
    JSON.parse(readFileSync(join(out, "run/analysis/summary.json"))).profile,
    "process-v1"
  );
  process.stdout.write(
    JSON.stringify({
      status: "pass",
      actual_runtime_containers: 2,
      control_plane: "deterministic API contract fixture; D1/DO inheritance is tested separately",
      external_model_calls: 0,
    }) + "\n"
  );
} finally {
  server.close();
}
