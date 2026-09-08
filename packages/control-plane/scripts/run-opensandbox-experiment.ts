/** Submit real agent tasks via the normal authenticated API and collect evidence. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import {
  OpenSandboxProvider,
  OPENSANDBOX_CREATE_TIMEOUT_MS,
} from "../src/sandbox/providers/opensandbox-provider";

import {
  assertToolEvidence,
  discoverSessionTree,
  CHILD_COMMAND,
  SINGLE_COMMAND,
} from "../../opensandbox-infra/experiment-checks.mjs";

const REQUEST_TIMEOUT_MS = 30_000;
const CLEANUP_SETTLE_MS = OPENSANDBOX_CREATE_TIMEOUT_MS + REQUEST_TIMEOUT_MS;

interface ExperimentMessage {
  status: string;
  startedAt: number | null;
  completedAt: number | null;
}
interface ApiResponse {
  sessionId?: string;
  hasMore?: boolean;
  children?: Array<{ id: string }>;
  messages?: ExperimentMessage[];
  events?: Array<{ data?: { sandboxBackend?: string; result?: string; error?: string } }>;
}

const { values } = parseArgs({
  options: {
    connection: { type: "string", default: ".cache/opensandbox/trace-connection.json" },
    out: { type: "string" },
    model: { type: "string" },
    "repo-owner": { type: "string" },
    "repo-name": { type: "string" },
    children: { type: "string", default: "2" },
    "deadline-seconds": { type: "string", default: "600" },
    "warm-only": { type: "boolean", default: false },
  },
});
assert(values.out, "--out is required (use a new output directory for each run)");
const childCount = values["warm-only"] ? 0 : Number(values.children);
const deadlineSeconds = Number(values["deadline-seconds"]);
assert(
  Number.isInteger(childCount) && childCount >= 0 && childCount <= 4,
  "--children must be 0..4"
);
assert(Number.isFinite(deadlineSeconds) && deadlineSeconds > 0, "Invalid deadline seconds");
assert(
  Boolean(values["repo-owner"]) === Boolean(values["repo-name"]),
  "Provide both repository fields"
);
const output = resolve(values.out);
mkdirSync(output, { recursive: false, mode: 0o700 });
const connection = JSON.parse(readFileSync(values.connection!, "utf8"));
const baseUrl = connection.controlPlaneUrl.replace(/\/$/, "");
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const save = (name: string, data: unknown) =>
  writeFileSync(resolve(output, name), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });

async function request(path: string, method = "GET", payload?: unknown): Promise<ApiResponse> {
  const url = `${baseUrl}${path}`;
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const headers = await buildServiceAuthHeaders({
    service: "github-bot",
    secret: connection.exportServiceSecret,
    method,
    url,
    body,
    actor: "github:opensandbox-local-research",
  });
  const response = await fetch(url, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok && !(path.endsWith("/cancel") && response.status === 409))
    throw new Error(
      `${method} ${path} failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`
    );
  return response.json();
}

const sessions = new Set<string>();
const sandboxConnection = JSON.parse(readFileSync(".cache/opensandbox/connection.json", "utf8"));
const sandboxProvider = new OpenSandboxProvider({
  apiUrl: sandboxConnection.api_url,
  apiKey: sandboxConnection.api_key,
  image: sandboxConnection.image,
  scmProvider: "github",
});
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
  });
let rootId: string | undefined;
const startMs = Date.now();
const observations = resolve(output, "observations");
const collector = spawn(
  "python3",
  [
    "packages/opensandbox-infra/collect.py",
    "--out",
    observations,
    "--duration-seconds",
    String(deadlineSeconds + CLEANUP_SETTLE_MS / 1000 + 60),
  ],
  { stdio: ["ignore", "inherit", "inherit"] }
);
let passed = false;
let failure: string | undefined;
let executionWindowMs = 0;
try {
  const created = await request("/sessions", "POST", {
    title: `OpenSandbox ${childCount ? `${childCount}-child fan-out` : "single session"} experiment`,
    ...(values.model ? { model: values.model } : {}),
    ...(values["repo-owner"]
      ? { repoOwner: values["repo-owner"], repoName: values["repo-name"] }
      : {}),
  });
  rootId = created.sessionId;
  assert(rootId);
  sessions.add(rootId);
  save("run.json", {
    rootSessionId: rootId,
    sandboxBackend: "opensandbox",
    requestedChildren: childCount,
    model: values.model ?? "deployment default",
    repository: values["repo-owner"] ? `${values["repo-owner"]}/${values["repo-name"]}` : null,
    startedAt: new Date(startMs).toISOString(),
    coldStartDefinition:
      "Fresh sandbox per session; image already built and locally cached. Server execd cache and OS caches are not cleared.",
  });
  console.log(`Created root session ${rootId}`);
  if (values["warm-only"]) {
    // Session creation immediately warms a sandbox, even before the first prompt.
    while (Date.now() < startMs + deadlineSeconds * 1000 && !interrupted) {
      const ready = await request(`/sessions/${rootId}/events?type=ready&limit=200`);
      if ((ready.events ?? []).some((event) => event.data?.sandboxBackend === "opensandbox")) {
        save(`ready-${rootId}.json`, ready);
        passed = true;
        break;
      }
      await wait(1000);
    }
    assert(passed, "Warm-up deadline exceeded");
  } else {
    const command = CHILD_COMMAND;
    const prompt = childCount
      ? `I explicitly request ${childCount} child sessions, each in a separate sandbox, using spawn-child. Create all ${childCount} before waiting for results. Give every child the same task: run this exact shell command once: ${command}. Then report CHILD_OK. Do not create more descendants. After creating every child, wait until their results are needed and use get-child-status with includeResponse to retrieve each result. Your final response must list the child IDs and their CHILD_OK results. Do not use in-process Task subagents for this request. Do not install additional dependencies or modify repository files for this smoke task.`
      : `Run this exact shell command once: ${SINGLE_COMMAND}. Report SINGLE_OK. Do not create child sessions or modify repository files.`;
    save("prompt.json", { content: prompt });
    const submitted = await request(`/sessions/${rootId}/prompt`, "POST", { content: prompt });
    save("submission.json", submitted);
    const deadlineMs = startMs + deadlineSeconds * 1000;
    let finished = false;
    while (Date.now() < deadlineMs && !interrupted) {
      const children = (await request(`/sessions/${rootId}/children`)).children ?? [];
      for (const child of children) sessions.add(child.id);
      const snapshots = await Promise.all(
        [...sessions].map(async (id) => ({
          id,
          messages: (await request(`/sessions/${id}/messages`)).messages ?? [],
        }))
      );
      for (const snapshot of snapshots) {
        if (snapshot.messages.some((message) => message.status === "failed"))
          throw new Error(`Agent task failed in session ${snapshot.id}`);
      }
      const allComplete = snapshots.every(
        (snapshot) =>
          snapshot.messages.length > 0 &&
          snapshot.messages.every((message) => message.status === "completed")
      );
      if (children.length >= childCount && allComplete) {
        if (childCount >= 2) {
          const childMessages = snapshots
            .filter((snapshot) => snapshot.id !== rootId)
            .map((snapshot) => snapshot.messages[0]);
          const overlapMs =
            Math.min(...childMessages.map((message) => message.completedAt ?? NaN)) -
            Math.max(...childMessages.map((message) => message.startedAt ?? NaN));
          assert(
            childMessages.every(
              (message) =>
                Number.isFinite(message.startedAt) && Number.isFinite(message.completedAt)
            ) && overlapMs > 0,
            "Child execution intervals did not overlap"
          );
          save("concurrency.json", {
            overlapMs,
            source: "persisted message startedAt/completedAt",
          });
        }
        save("messages.json", snapshots);
        save("children.json", children);
        finished = true;
        break;
      }
      await wait(2000);
    }
    assert(finished, "Experiment deadline exceeded");
    const tree = await discoverSessionTree(
      rootId,
      async (id: string) => (await request(`/sessions/${id}/children`)).children ?? []
    );
    for (const id of tree.keys()) sessions.add(id);
    assert.equal(tree.size, childCount + 1, "Unexpected child topology (including descendants)");
    assert(
      [...tree].every(([id, parent]) => id === rootId || parent === rootId),
      "Unexpected nested child sessions"
    );
    // Persisted ready events prove provider identity; host evidence proves distinct containers.
    for (const id of sessions) {
      const ready = await request(`/sessions/${id}/events?type=ready&limit=200`);
      assert(
        (ready.events ?? []).some((event) => event.data?.sandboxBackend === "opensandbox"),
        `Missing OpenSandbox ready event for ${id}`
      );
      save(`ready-${id}.json`, ready);
      const calls = await request(`/sessions/${id}/events?type=tool_call&limit=200`);
      const results = await request(`/sessions/${id}/events?type=tool_result&limit=200`);
      assert(
        !calls.hasMore && !results.hasMore,
        "Tool evidence exceeds the smoke runner's event limit"
      );
      assertToolEvidence([...(calls.events ?? []), ...(results.events ?? [])], {
        command: childCount === 0 ? SINGLE_COMMAND : id === rootId ? undefined : CHILD_COMMAND,
        childIds:
          id === rootId && childCount > 0 ? [...sessions].filter((child) => child !== rootId) : [],
        marker: childCount === 0 ? "SINGLE_OK" : "CHILD_OK",
      });
      save(`tool-calls-${id}.json`, calls);
      save(`tool-results-${id}.json`, results);
    }
    passed = true;
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  executionWindowMs = Date.now() - startMs;
  const cleanupDeadlineMs = Date.now() + (passed ? 0 : CLEANUP_SETTLE_MS);
  const cancelled = new Set<string>();
  const removed = new Set<string>();
  const observed = new Set<string>();
  const docker = (...args: string[]) =>
    execFileSync("docker", args, { encoding: "utf8", timeout: REQUEST_TIMEOUT_MS });
  let emptyPasses = 0;
  if (rootId) {
    if (!passed) console.log("Waiting for in-flight sandbox creation during bounded cleanup...");
    do {
      try {
        // Cancel queued/active work before discovery so no new tool calls are accepted.
        for (const id of sessions) {
          if (!cancelled.has(id)) {
            await request(`/sessions/${id}/cancel`, "POST");
            cancelled.add(id);
          }
        }
        const tree = await discoverSessionTree(
          rootId,
          async (id: string) => (await request(`/sessions/${id}/children`)).children ?? []
        );
        let found = false;
        for (const id of tree.keys()) {
          if (!sessions.has(id)) {
            sessions.add(id);
            found = true;
          }
          if (!cancelled.has(id)) {
            await request(`/sessions/${id}/cancel`, "POST");
            cancelled.add(id);
          }
          const containers = docker(
            "ps",
            "-aq",
            "--filter",
            `label=openinspect_session_id=${id}`,
            "--filter",
            "label=openinspect_framework=open-inspect"
          )
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          if (!observed.has(id) && passed)
            assert.equal(containers.length, 1, `Expected an independent container for ${id}`);
          for (const container of containers) {
            found = true;
            observed.add(id);
            const providerObjectId = docker(
              "inspect",
              "--format",
              '{{index .Config.Labels "opensandbox.io/id"}}',
              container
            ).trim();
            assert(providerObjectId, "Container missing OpenSandbox identity");
            const result = await sandboxProvider.stopSandbox({
              providerObjectId,
              sessionId: id,
              reason: "experiment-cleanup",
            });
            assert(result.success, result.error);
            removed.add(container);
          }
        }
        emptyPasses = found ? 0 : emptyPasses + 1;
      } catch (error) {
        passed = false;
        failure ??= error instanceof Error ? error.message : "Cleanup failed";
        emptyPasses = 0;
      }
      if (Date.now() >= cleanupDeadlineMs && emptyPasses >= 2) break;
      if (Date.now() > cleanupDeadlineMs + REQUEST_TIMEOUT_MS) {
        passed = false;
        failure ??= "Cleanup did not converge; use local.py down";
        break;
      }
      await wait(1000);
    } while (emptyPasses < 2 || Date.now() < cleanupDeadlineMs);
  }
  save("cleanup.json", {
    sessionIds: [...sessions],
    removedContainerIds: [...removed],
    emptyPasses,
    settled: emptyPasses >= 2,
  });
  if (collector) {
    collector.kill("SIGTERM");
    await new Promise((done) => {
      if (collector.exitCode !== null) done(null);
      else {
        const timer = setTimeout(() => collector.kill("SIGKILL"), REQUEST_TIMEOUT_MS);
        collector.once("exit", () => {
          clearTimeout(timer);
          done(null);
        });
      }
    });
    if (collector.exitCode !== 0) {
      passed = false;
      failure ??= "Host collector failed";
    }
  }
}
if (rootId) {
  try {
    if (passed) {
      const host = readFileSync(resolve(observations, "host.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const runtime = readFileSync(resolve(observations, "runtime.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const summaries = [...sessions].map((id) => {
        const identity = host.find(
          (row) => row.kind === "container_identity" && row.session_id === id && row.host_pid > 0
        );
        const samples = host.filter(
          (row) => row.kind === "resource_sample" && row.session_id === id
        );
        const startup = runtime.find(
          (row) => row.session_id === id && row.event?.event === "sandbox.startup"
        )?.event;
        assert(
          identity?.host_pid > 0 && samples.length > 0 && startup?.outcome === "success",
          `Incomplete host/runtime evidence for ${id}`
        );
        assert(
          startup.git_sync_success !== false && startup.setup_success !== false,
          `Repository startup failed for ${id}`
        );
        return {
          ...identity,
          sandbox_id: startup.sandbox_id,
          runtime_startup_ms: startup.duration_ms,
          sample_count: samples.length,
          observed_cpu_time_ns: samples.at(-1).cpu_stats?.cpu_usage?.total_usage,
          sampled_peak_memory_bytes: Math.max(
            ...samples.map((row) => row.memory_stats?.usage ?? 0)
          ),
          last_blkio_stats: samples.at(-1).blkio_stats,
        };
      });
      save("host-summary.json", summaries);
    }
  } catch (error) {
    passed = false;
    failure ??= error instanceof Error ? error.message : "Host evidence validation failed";
  }
  try {
    execFileSync(
      process.execPath,
      [
        "scripts/export-openinspect-trace.mjs",
        "--session",
        rootId,
        "--connection-file",
        values.connection!,
        "--out",
        resolve(output, "trace"),
        "--skip-cloudflare-logs",
        "--skip-modal-logs",
        "--sandbox-backend",
        "opensandbox",
        "--runtime-log",
        resolve(observations, "runtime.jsonl"),
        "--host-observations",
        resolve(observations, "host.jsonl"),
      ],
      { stdio: "inherit", timeout: 120_000 }
    );
  } catch (error) {
    passed = false;
    failure ??=
      error instanceof Error ? error.message : "Host evidence validation or trace export failed";
  }
}
save("result.json", {
  status: passed ? "passed" : "failed",
  rootSessionId: rootId,
  sessionIds: [...sessions],
  durationMs: Date.now() - startMs,
  executionWindowMs,
  failure,
  validation: values["warm-only"]
    ? "Real control-plane create, runtime WebSocket ready, container identity, cleanup and trace export; no LLM task"
    : "Real agent tool results, OpenSandbox ready events, independent containers, concurrent child message intervals, cleanup, and trace export",
});
if (!passed) throw new Error(failure ?? "Experiment failed");
console.log(`Experiment evidence: ${output}`);
