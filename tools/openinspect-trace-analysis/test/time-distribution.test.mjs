import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createSyntheticBundle } from "./fixture.mjs";
import { hashFile } from "../lib/hash.mjs";
import { readJson } from "../lib/json.mjs";
import { loadTraceBundle } from "../lib/loader.mjs";
import { validateTraceBundle } from "../lib/validator.mjs";
import { buildIntermediateRepresentation } from "../lib/ir.mjs";
import { classifyInvocation } from "../lib/time/classify.mjs";
import { measureInvocation } from "../lib/time/invocations.mjs";
import { aggregate, quantile } from "../lib/time/aggregate.mjs";
import { analyzeCampaign } from "../lib/time/analyze.mjs";
import { readCampaign, resolveAttempt, validateOutputPath } from "../lib/time/campaign-input.mjs";

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}
function temp(t) {
  const path = mkdtempSync(join(tmpdir(), "oi-time-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function rehash(bundle) {
  const hashes = readJson(join(bundle, "hashes.json"));
  hashes.files = hashes.files.map(({ path }) => ({ path, ...hashFile(join(bundle, path)) }));
  writeJson(join(bundle, "hashes.json"), hashes);
}
function fixtureCampaign(base) {
  const runs = join(base, "runs");
  const finalDir = join(runs, "final");
  mkdirSync(finalDir, { recursive: true });
  const inherited = {};
  const tasks = [];
  const attempts = [];
  const inputs = [];
  for (const [id, runId, benchmark] of [
    ["001-01", "old", "featurebench"],
    ["002-01", "final", "cooperbench"],
  ]) {
    const dir = join(runs, runId, "attempts", id);
    const bundle = createSyntheticBundle(join(dir, "trace-001"));
    // Give each task independent session IDs while retaining fixture topology.
    for (const path of [
      "manifest.json",
      "completeness.json",
      "raw/session-index.json",
      "normalized/events.jsonl",
      "normalized/messages.jsonl",
    ]) {
      writeFileSync(
        join(bundle, path),
        readFileSync(join(bundle, path), "utf8")
          .replaceAll("root", `root-${id}`)
          .replaceAll("child", `child-${id}`)
          // Field names are schema, not identifiers.
          .replaceAll(`root-${id}SessionId`, "rootSessionId")
      );
    }
    rehash(bundle);
    const attempt = {
      taskId: `task-${id}`,
      attemptId: id,
      repetition: 1,
      runId,
      rootSessionId: `root-${id}`,
      modelExecution: "completed",
      benchmarkCorrectness: { status: "not_scored" },
      trace: { path: bundle, manifestSha256: hashFile(join(bundle, "manifest.json")).sha256 },
    };
    writeJson(join(dir, "attempt.json"), attempt);
    if (runId === "old")
      inherited[id] = {
        path: join(dir, "attempt.json"),
        sha256: hashFile(join(dir, "attempt.json")).sha256,
      };
    tasks.push(
      benchmark === "cooperbench"
        ? { id: attempt.taskId, benchmark }
        : { taskId: attempt.taskId, benchmark }
    );
    attempts.push({ taskId: attempt.taskId, attemptId: id, repetition: 1 });
    inputs.push({ dir, bundle, attempt });
  }
  writeJson(join(finalDir, "run.json"), { runId: "final", attempts, inheritedAttempts: inherited });
  writeJson(join(finalDir, "tasks.json"), tasks);
  return { run: join(finalDir, "run.json"), runs, finalDir, inputs };
}

test("raw timing excludes repairs, preserves terminal errors and reports overlapping reasons", () => {
  const invocation = {
    startedAtMs: 100,
    rawFinishedAtMs: 300,
    finishedAtMs: 101,
    status: "completed",
  };
  assert.equal(measureInvocation(invocation).observedToolElapsedMs, 200);
  assert.equal(measureInvocation({ ...invocation, status: "error" }).observedToolElapsedMs, 200);
  for (const rawFinishedAtMs of [null, 100, 99, NaN])
    assert.equal(measureInvocation({ ...invocation, rawFinishedAtMs }).observedToolElapsedMs, null);
  assert.deepEqual(
    measureInvocation({ ...invocation, rawFinishedAtMs: 99, status: "running" }).exclusionReasons,
    ["nonpositive_interval", "nonterminal_status"]
  );
  assert.equal(measureInvocation({ ...invocation, startedAtMs: null }).observedToolElapsedMs, null);
  assert.equal(
    measureInvocation({ ...invocation, rawFinishedAtMs: 1e12 }).observedToolElapsedMs,
    1e12 - 100
  );
});

test("reuses seconds/milliseconds conversion without using legacy clamped duration", (t) => {
  const bundleDir = createSyntheticBundle(join(temp(t), "trace"));
  const bundle = loadTraceBundle(bundleDir);
  const tools = bundle.events.filter((e) => e.type === "tool_call");
  tools[0].data.timestamp = tools[0].createdAt + 200; // milliseconds
  tools[1].data.timestamp = (tools[1].createdAt + 300) / 1000; // seconds
  tools[2].data.timestamp = (tools[2].createdAt - 3) / 1000;
  tools[3].data.timestamp = null;
  const ir = buildIntermediateRepresentation(bundle, validateTraceBundle(bundle));
  assert.deepEqual(
    ir.toolInvocations.map((i) => measureInvocation(i).observedToolElapsedMs),
    [200, 300, null, null]
  );
  assert.equal(ir.toolInvocations[2].finishedAtMs - ir.toolInvocations[2].startedAtMs, 1);
});

test("classifies whole requests conservatively instead of allocating segment times", () => {
  const examples = [
    ["cd /repo && pytest -q", "test_build"],
    ["cd /repo", "context_setup"],
    ["sleep 300; echo waited", "explicit_wait"],
    ["pip install foo && pytest", "mixed"],
    ["echo 'pytest sleep 300'", "output"],
    ["python -c 'print(\"pytest\")'", "script_execution"],
    ["pytest | head", "test_build"],
    ["pytest || echo failed", "mixed"],
    ["pytest 2>&1 | tail -30", "test_build"],
    ["pytest | tail -f", "mixed"],
    ["pytest | head other-file", "mixed"],
    ["pytest | tail <other-file", "mixed"],
    ["pytest | sh", "mixed"],
    ["python -m '' pytest", "unknown"],
    ["cat <<EOF\nsleep 300\nEOF", "unknown"],
    ["pytest &", "unknown"],
    ["for x in a; do pytest; done", "unknown"],
    ["echo $(sleep 300)", "unknown"],
    ["timeout 30 python -m pytest", "test_build"],
    ["timeout --signal=KILL 30 pytest", "unknown"],
    ["PYTHONPATH=/repo timeout 30 python -m pytest", "test_build"],
    ["python -m pip install foo", "environment"],
    ["sed -i s/a/b/ file", "unknown"],
    ["sed -n '1,20p' file", "search_read"],
    ["find . -exec sh run.sh \\;", "unknown"],
  ];
  for (const [command, category] of examples)
    assert.equal(classifyInvocation("bash", { command }).category, category, command);
  assert.equal(classifyInvocation("custom-tool").category, "unknown");
  assert.equal(classifyInvocation("get-child-status").category, "coordination");
  assert.deepEqual(classifyInvocation("bash", { command: "cd /repo && pytest" }).tags, [
    "context_setup",
    "test_build",
  ]);
});

function row(attemptId, category, ms) {
  return {
    taskId: attemptId,
    attemptId,
    benchmark: "featurebench",
    category,
    observedToolElapsedMs: ms,
    exclusionReasons: ms === null ? ["missing_finish"] : [],
    tool: "bash",
    role: "parent",
    status: "completed",
    modelExecution: "completed",
    scoringStatus: "not_scored",
  };
}
test("macro/pooled denominators, zero tasks, unknown time and concurrency remain distinct", () => {
  const rows = [
    row("a", "explicit_wait", 900),
    row("a", "test_build", 100),
    row("b", "test_build", 10),
    row("c", "unknown", null),
  ];
  const attempts = ["a", "b", "c", "d"].map((id) => ({
    taskId: id,
    attemptId: id,
    benchmark: "featurebench",
    disposition: id === "d" ? "excluded" : "included",
  }));
  const m = aggregate(rows, attempts);
  const wait = m.byBenchmark.find((r) => r.category === "explicit_wait");
  assert.equal(wait.macroTaskMeanShare, 0.45);
  assert.equal(wait.pooledKnownTimeShare, 900 / 1010);
  assert.equal(wait.eligibleTaskCount, 2);
  assert.equal(wait.plannedTaskCount, 4);
  assert.equal(m.overall.knownElapsedMs, 1010); // Workload sum, never clipped to a wall window.
  assert.equal(m.overall.unknownTimingCount, 1);
  assert.equal(
    m.byCategory.reduce((n, r) => n + r.knownElapsedMs, 0),
    1010
  );
  assert.ok(
    m.byTask.filter((r) => ["c", "d"].includes(r.attemptId)).every((r) => r.knownTimeShare === null)
  );
  assert.equal(quantile([], 0.95), null);
  assert.equal(quantile([4, 1, 2, 3], 0.5), 2);
  assert.equal(quantile([4, 1, 2, 3], 0.95), 4);
});

test("campaign resolves inherited attempts, validates inputs, and emits reproducible compact evidence", (t) => {
  const base = temp(t);
  const f = fixtureCampaign(base);
  const before = snapshot(f.runs);
  const result = analyzeCampaign(f.run, join(base, "out-a"));
  assert.deepEqual(
    result.manifest.attempts.map((a) => a.disposition),
    ["included", "included"]
  );
  assert.equal(result.metrics.overall.invocationCount, 8);
  assert.equal(result.manifest.attempts[0].sourceRunId, "old");
  const second = analyzeCampaign(f.run, join(base, "out-b"));
  for (const file of readdirSync(result.output))
    assert.deepEqual(
      readFileSync(join(result.output, file)),
      readFileSync(join(second.output, file)),
      file
    );
  const ledgerText = readFileSync(join(result.output, "invocations.jsonl"), "utf8");
  assert.ok(!ledgerText.includes("DO_NOT_COPY"));
  for (const row of ledgerText.trim().split("\n").map(JSON.parse)) {
    const event = JSON.parse(
      readFileSync(row.source.file, "utf8").split("\n")[row.source.line - 1]
    );
    assert.equal(event.id, row.source.eventId);
  }
  assert.throws(() => analyzeCampaign(f.run, result.output), /new or empty/);
  assert.deepEqual(snapshot(f.runs), before);
});

function snapshot(dir) {
  const result = {};
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    result[item.name] = item.isDirectory() ? snapshot(path) : hashFile(path).sha256;
  }
  return result;
}

test("repetitions do not overweight tasks in macro summaries", () => {
  const rows = [
    row("a1", "explicit_wait", 10),
    row("a2", "test_build", 10),
    row("b", "test_build", 10),
  ];
  for (const r of rows) if (r.attemptId.startsWith("a")) r.taskId = "a";
  const attempts = rows.map((r) => ({
    taskId: r.taskId,
    attemptId: r.attemptId,
    benchmark: r.benchmark,
    disposition: "included",
  }));
  const m = aggregate(rows, attempts).byBenchmark.find((r) => r.category === "explicit_wait");
  assert.equal(m.macroTaskMeanShare, 0.25);
  assert.equal(m.pooledKnownTimeShare, 1 / 3);
});

test("optional wait analysis emits deterministic timelines without changing T1/T2 metrics", (t) => {
  const base = temp(t);
  const f = fixtureCampaign(base);
  const plain = analyzeCampaign(f.run, join(base, "plain"));
  const first = analyzeCampaign(f.run, join(base, "wait-a"), { waitTimeline: true });
  const second = analyzeCampaign(f.run, join(base, "wait-b"), { waitTimeline: true });
  assert.deepEqual(first.metrics, plain.metrics);
  assert.equal(first.waitSummary.plannedAttemptCount, 2);
  assert.equal(first.waitSummary.overall.explicitWaitCount, 0);
  assert.equal(first.waitSummary.overall.noMeasurableWaitAttemptCount, 2);
  assert.equal(first.manifest.parameters.waitTimeline, true);
  for (const file of readdirSync(first.output))
    assert.deepEqual(
      readFileSync(join(first.output, file)),
      readFileSync(join(second.output, file)),
      file
    );
  const result = spawnSync(process.execPath, [
    new URL("../time-cli.mjs", import.meta.url).pathname,
    f.run,
    "--wait-timeline",
    "--out",
    join(base, "cli-wait"),
  ]);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(readJson(join(base, "cli-wait/wait-summary.json")).plannedAttemptCount, 2);
});

test("bad hashes and absent files produce explicit dispositions without dropping planned attempts", (t) => {
  const base = temp(t);
  const f = fixtureCampaign(base);
  writeFileSync(join(f.inputs[0].dir, "attempt.json"), "{}\n");
  rmSync(join(f.inputs[1].bundle, "normalized/events.jsonl"));
  const result = analyzeCampaign(f.run, join(base, "out"));
  assert.equal(result.manifest.attempts.length, 2);
  assert.match(result.manifest.attempts[0].error, /hash mismatch/);
  assert.equal(result.metrics.overall.invocationCount, 0);
  assert.equal(result.metrics.coverage.attempts.length, 2);
});

test("root identity conflicts and duplicate exports cannot double-count work", (t) => {
  const base = temp(t);
  const f = fixtureCampaign(base);
  cpSync(f.inputs[0].bundle, f.inputs[1].bundle, { recursive: true });
  const path = join(f.inputs[1].dir, "attempt.json");
  const a = readJson(path);
  a.rootSessionId = f.inputs[0].attempt.rootSessionId;
  a.trace.manifestSha256 = hashFile(join(f.inputs[1].bundle, "manifest.json")).sha256;
  writeJson(path, a);
  const result = analyzeCampaign(f.run, join(base, "out"));
  assert.equal(result.metrics.overall.invocationCount, 4);
  assert.match(result.manifest.attempts[1].error, /Duplicate trace\/session/);
});

test("explicit trace selection and root remapping preserve verified identity", (t) => {
  const base = temp(t);
  const f = fixtureCampaign(base);
  const destination = join(base, "moved");
  cpSync(f.runs, destination, { recursive: true });
  const moved = join(destination, "final/run.json");
  const result = analyzeCampaign(moved, join(base, "out"), {
    oldRunsRoot: f.runs,
    runsRoot: destination,
  });
  assert.equal(result.metrics.overall.invocationCount, 8);
  const a = readJson(join(f.inputs[1].dir, "attempt.json"));
  delete a.trace;
  writeJson(join(f.inputs[1].dir, "attempt.json"), a);
  cpSync(f.inputs[1].bundle, join(f.inputs[1].dir, "trace-002"), { recursive: true });
  assert.throws(
    () => resolveAttempt(readCampaign(f.run), readCampaign(f.run).run.attempts[1]),
    /ambiguous/
  );
  const selected = analyzeCampaign(f.run, join(base, "selected"), { traceName: "trace-002" });
  assert.equal(selected.manifest.attempts[1].disposition, "included");
  assert.equal(selected.manifest.attempts[0].disposition, "excluded");
});

test("rejects output in input tree, symlink aliases, duplicate plans and invalid CLI flags", (t) => {
  const base = temp(t);
  const f = fixtureCampaign(base);
  const campaign = readCampaign(f.run);
  assert.throws(() => validateOutputPath(join(f.runs, "output"), campaign), /outside/);
  symlinkSync(f.runs, join(base, "alias"));
  assert.throws(() => validateOutputPath(join(base, "alias/output"), campaign), /outside/);
  const run = readJson(f.run);
  run.attempts.push(run.attempts[0]);
  writeJson(f.run, run);
  assert.throws(() => readCampaign(f.run), /Duplicate planned/);
  const cli = new URL("../time-cli.mjs", import.meta.url);
  const help = spawnSync(process.execPath, [cli.pathname, "--help"]);
  assert.ifError(help.error);
  assert.equal(help.status, 0);
  const invalid = spawnSync(process.execPath, [cli.pathname, f.run, "--unknown", "x"]);
  assert.ifError(invalid.error);
  assert.equal(invalid.status, 1);
});
