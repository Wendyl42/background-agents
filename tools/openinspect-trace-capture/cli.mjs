#!/usr/bin/env node
/** Local experiment -> dynamic session tree -> durable capture -> v0 bundle. */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import process from "node:process";
import { build } from "esbuild";
import { Buffer } from "node:buffer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The shared package uses bundler module resolution. Bundle its authoritative signer
// in memory so the standalone Node CLI does not duplicate the authentication protocol.
const authModule = await build({
  entryPoints: [join(root, "packages/shared/src/service-auth.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { buildServiceAuthHeaders } = await import(
  "data:text/javascript;base64," + Buffer.from(authModule.outputFiles[0].text).toString("base64")
);
const { values } = parseArgs({
  options: {
    connection: { type: "string" },
    out: { type: "string" },
    "prompt-file": { type: "string" },
    "session-options": { type: "string" },
    mode: { type: "string", default: "process" },
    host: { type: "string" },
    "advertise-host": { type: "string" },
    "deadline-seconds": { type: "string", default: "1800" },
    python: { type: "string", default: "python3" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  process.stdout.write(
    "Usage: node tools/openinspect-trace-capture/cli.mjs --connection PRIVATE.json --prompt-file TASK.txt --out NEW_DIR [--session-options CREATE_FIELDS.json] [--mode tools|process] [--host DOCKER_GATEWAY]\n"
  );
  process.exit(0);
}
if (
  !values.connection ||
  !values.out ||
  !values["prompt-file"] ||
  !["tools", "process"].includes(values.mode)
)
  throw new Error("Required: --connection, --prompt-file, --out, supported --mode (see --help)");
const deadlineSeconds = Number(values["deadline-seconds"]);
if (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0) throw new Error("Invalid deadline");
const output = resolve(values.out);
mkdirSync(output, { mode: 0o700 });
const captureDir = join(output, "capture");
const connection = JSON.parse(readFileSync(values.connection, "utf8"));
const sessionOptions = values["session-options"]
  ? JSON.parse(readFileSync(values["session-options"], "utf8"))
  : {};
const runId = randomUUID(),
  attemptId = randomUUID();
const host =
  values.host ||
  execFileSync(
    "docker",
    ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
    { encoding: "utf8" }
  ).trim();
const save = (name, value) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const receiver = spawn(
  values.python,
  [
    join(root, "tools/openinspect-trace-capture/receiver.py"),
    "--out",
    captureDir,
    "--run-id",
    runId,
    "--attempt-id",
    attemptId,
    "--host",
    host,
    "--advertise-host",
    values["advertise-host"] || host,
  ],
  { stdio: ["ignore", "inherit", "inherit"] }
);
let interrupted = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    interrupted = true;
  });
async function request(path, method = "GET", payload) {
  const url = connection.controlPlaneUrl.replace(/\/$/, "") + path;
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const headers = await buildServiceAuthHeaders({
    service: "github-bot",
    secret: connection.exportServiceSecret,
    url,
    method,
    body,
    actor: "github:execution-trace-experiment",
  });
  const response = await fetch(url, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (path.endsWith("/cancel") && response.status === 409) return {};
  if (!response.ok) throw new Error(`${method} ${path} failed: HTTP ${response.status}`);
  return response.json();
}
const sessions = new Set();
let rootSessionId, failure;
async function discover() {
  for (const id of sessions) {
    const page = await request(`/sessions/${id}/children`);
    if (page.hasMore) throw new Error("Child tree pagination is not supported by capture runner");
    for (const child of page.children ?? []) sessions.add(child.id);
  }
}
try {
  for (let i = 0; i < 100 && !existsSync(join(captureDir, "connection.json")); i++) {
    if (receiver.exitCode !== null) throw new Error("Receiver startup failed");
    await sleep(100);
  }
  const { endpoint } = JSON.parse(readFileSync(join(captureDir, "connection.json"), "utf8"));
  const created = await request("/sessions", "POST", {
    ...sessionOptions,
    executionTrace: { mode: values.mode, runId, attemptId, endpoint },
  });
  rootSessionId = created.sessionId;
  if (!rootSessionId) throw new Error("Root creation returned no identity");
  sessions.add(rootSessionId);
  save("run.json", { run_id: runId, attempt_id: attemptId, rootSessionId, mode: values.mode });
  await request(`/sessions/${rootSessionId}/prompt`, "POST", {
    content: readFileSync(values["prompt-file"], "utf8"),
  });
  const deadlineMs = Date.now() + deadlineSeconds * 1000;
  let completed = false;
  while (!interrupted && Date.now() < deadlineMs) {
    await discover();
    const snapshots = await Promise.all(
      [...sessions].map(async (id) => {
        const page = await request(`/sessions/${id}/messages?limit=100`);
        if (page.hasMore) throw new Error("Message pagination exceeds capture-runner limit");
        return { session_id: id, messages: page.messages ?? [] };
      })
    );
    if (snapshots.some((s) => s.messages.some((m) => m.status === "failed")))
      throw new Error("Agent message failed");
    if (
      snapshots.every((s) => s.messages.length && s.messages.every((m) => m.status === "completed"))
    ) {
      save("messages.json", snapshots);
      completed = true;
      break;
    }
    await sleep(1000);
  }
  if (!completed)
    throw new Error(interrupted ? "Experiment interrupted" : "Experiment deadline exceeded");
} catch (error) {
  failure = error.message;
} finally {
  const cleanup = [];
  const cleanupErrors = [];
  const reportCleanupError = (stage, error) => {
    cleanupErrors.push({ stage, error: error.message });
    failure ??= `Cleanup ${stage} failed: ${error.message}`;
  };
  const dockerIds = (...filters) =>
    execFileSync("docker", ["ps", "-aq", ...filters.flatMap((filter) => ["--filter", filter])], {
      encoding: "utf8",
      timeout: 15000,
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  const untilMs = Date.now() + 120000;
  do {
    // Recover membership from this run's launch contract even if the API is down.
    // Environment values are parsed only in memory and never emitted or saved.
    try {
      for (const container of dockerIds("label=openinspect_framework=open-inspect")) {
        const info = JSON.parse(
          execFileSync("docker", ["inspect", container], { encoding: "utf8", timeout: 15000 })
        )[0];
        const encoded = info.Config.Env.find((entry) => entry.startsWith("SESSION_CONFIG="));
        if (!encoded) continue;
        let config;
        try {
          config = JSON.parse(encoded.slice("SESSION_CONFIG=".length));
        } catch {
          continue;
        }
        if (
          config.execution_trace?.runId === runId &&
          config.execution_trace?.attemptId === attemptId &&
          info.Config.Labels.openinspect_session_id === config.session_id
        )
          sessions.add(config.session_id);
      }
    } catch (error) {
      reportCleanupError("local-discovery", error);
    }
    // Local removal of known members does not depend on discovery/cancel success.
    for (const id of sessions) {
      try {
        for (const container of dockerIds(
          `label=openinspect_session_id=${id}`,
          "label=openinspect_framework=open-inspect"
        )) {
          let forced = false;
          try {
            execFileSync("docker", ["stop", "--time", "45", container], {
              stdio: "ignore",
              timeout: 50000,
            });
          } catch (error) {
            forced = true;
            reportCleanupError("graceful-stop", error);
          }
          execFileSync("docker", ["rm", ...(forced ? ["-f"] : []), container], {
            stdio: "ignore",
            timeout: 15000,
          });
          cleanup.push({ session_id: id, container_id: container, removed: true, forced });
        }
      } catch (error) {
        reportCleanupError("local-removal", error);
      }
      try {
        await request(`/sessions/${id}/cancel`, "POST");
      } catch (error) {
        reportCleanupError("cancel", error);
      }
    }
    try {
      await discover();
    } catch (error) {
      reportCleanupError("api-discovery", error);
    }
    if (!failure) break;
    await sleep(1000);
  } while (Date.now() < untilMs);
  save("cleanup-errors.json", cleanupErrors);
  save("cleanup.json", cleanup);
  receiver.kill("SIGTERM");
  await new Promise((done) =>
    receiver.exitCode !== null || receiver.signalCode !== null
      ? done()
      : receiver.once("exit", done)
  );
  if (rootSessionId) {
    try {
      execFileSync(
        process.execPath,
        [
          join(root, "scripts/export-openinspect-trace.mjs"),
          "--session",
          rootSessionId,
          "--connection-file",
          resolve(values.connection),
          "--out",
          join(output, "trace"),
          "--execution-capture",
          captureDir,
        ],
        { stdio: "inherit" }
      );
      const manifest = JSON.parse(readFileSync(join(output, "trace/manifest.json"), "utf8"));
      execFileSync(
        process.execPath,
        [
          join(root, "tools/openinspect-trace-analysis/process-cli.mjs"),
          join(output, "trace"),
          "--out",
          join(output, "analysis"),
        ],
        { stdio: "inherit" }
      );
      if (manifest.executionTrace.status !== "complete")
        failure ??= "Execution evidence is incomplete; inspect the bundle quality report";
    } catch (error) {
      failure ??= `Export failed: ${error.message}`;
    }
  }
  save("result.json", {
    status: failure ? "incomplete" : "pass",
    failure: failure ?? null,
    session_ids: [...sessions],
  });
}
process.stdout.write(`Capture ${failure ? "incomplete" : "complete"}: ${output}\n`);
if (failure) process.exitCode = 1;
