import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { analyzeTraceBundleDetailed } from "../lib/analyze.mjs";
import { aggregateBatchRuns } from "../lib/batch/aggregate.mjs";
import { analyzeTraceCollection, batchProfileIdentity } from "../lib/batch/analyze.mjs";
import { batchCacheKey } from "../lib/batch/cache.mjs";
import { batchArtifactContents, writeBatchOutput } from "../lib/batch/output.mjs";
import { renderBatchReport } from "../lib/batch/report.mjs";
import { hashFile } from "../lib/hash.mjs";
import { stableJson, stableJsonl } from "../lib/json.mjs";
import { loadTraceBundle } from "../lib/loader.mjs";
import { createSyntheticBundle } from "./fixture.mjs";

const REAL_TRACE_A = resolve(
  "traces/openinspect/2026-08-19-template-typescript-monorepo-security-audit-4fd2789a"
);
const REAL_TRACE_B = resolve(
  "traces/openinspect/1c929e3aed7c97b57563c73e242e603a-2026-08-20T05-38-31-813Z"
);

function writeJson(path, value) {
  writeFileSync(path, stableJson(value));
}

function rewriteBundleIdentity(bundle, rootId, childId) {
  const completeness = JSON.parse(readFileSync(join(bundle, "completeness.json"), "utf8"));
  completeness.rootSessionId = rootId;
  completeness.sessionIds = [rootId, childId];
  completeness.sessions[0].sessionId = rootId;
  completeness.sessions[1].sessionId = childId;
  writeJson(join(bundle, "completeness.json"), completeness);

  const index = JSON.parse(readFileSync(join(bundle, "raw/session-index.json"), "utf8"));
  index.sessions[0].id = rootId;
  index.sessions[1].id = childId;
  index.sessions[1].parentSessionId = rootId;
  writeJson(join(bundle, "raw/session-index.json"), index);

  const events = readFileSync(join(bundle, "normalized/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .map((event) => ({
      ...event,
      rootSessionId: rootId,
      sessionId: event.sessionId === "root" ? rootId : childId,
      parentSessionId: event.parentSessionId === null ? null : rootId,
    }));
  writeFileSync(join(bundle, "normalized/events.jsonl"), stableJsonl(events));

  const messages = readFileSync(join(bundle, "normalized/messages.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .map((message) => ({
      ...message,
      rootSessionId: rootId,
      sessionId: message.sessionId === "root" ? rootId : childId,
      parentSessionId: message.parentSessionId === null ? null : rootId,
    }));
  writeFileSync(join(bundle, "normalized/messages.jsonl"), stableJsonl(messages));

  const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
  manifest.source.rootSessionId = rootId;
  manifest.source.repository = `test/${rootId}`;
  writeJson(join(bundle, "manifest.json"), manifest);

  const hashes = JSON.parse(readFileSync(join(bundle, "hashes.json"), "utf8"));
  hashes.files = hashes.files.map((entry) => ({
    path: entry.path,
    ...hashFile(join(bundle, entry.path)),
  }));
  writeJson(join(bundle, "hashes.json"), hashes);
  return bundle;
}

function uniqueBundle(path, rootId) {
  return rewriteBundleIdentity(createSyntheticBundle(path), rootId, `${rootId}-child`);
}

function digests(path) {
  return loadTraceBundle(path).verifiedFiles.map((entry) => `${entry.path}:${entry.sha256}`);
}

test("batch discovers multiple bundles deterministically and excludes analysis directories", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-batch-discovery-"));
  uniqueBundle(join(root, "z", "bundle"), "root-z");
  uniqueBundle(join(root, "a", "nested", "bundle"), "root-a");
  uniqueBundle(join(root, "analysis", "ignored"), "root-ignored");
  const result = analyzeTraceCollection(root, {
    cacheDir: join(root, "cache-outside-analysis-name"),
  });
  assert.deepEqual(
    result.runs.map((run) => run.relativePath),
    ["a/nested/bundle", "z/bundle"]
  );
  assert.deepEqual(
    result.runs.map((run) => run.runId),
    ["root-a", "root-z"]
  );
  assert.equal(result.manifest.discovery.candidateCount, 2);
});

test("malformed bundle is isolated while valid runs continue", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-batch-failure-"));
  uniqueBundle(join(root, "valid"), "valid-root");
  const malformed = join(root, "malformed");
  mkdirSync(malformed, { recursive: true });
  writeFileSync(join(malformed, "manifest.json"), "{\n");
  writeFileSync(join(malformed, "hashes.json"), "{}\n");
  const result = analyzeTraceCollection(root, { cacheDir: join(root, "cache") });
  assert.equal(result.runs.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].relativePath, "malformed");
  assert.equal(result.failures[0].stage, "validation");
  assert.equal(result.failures[0].code, "bundle_load_failed");
});

test("duplicate bundle roots are detected and never double-counted", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-batch-duplicate-"));
  const first = createSyntheticBundle(join(root, "a"));
  cpSync(first, join(root, "b"), { recursive: true });
  const result = analyzeTraceCollection(root, { cacheDir: join(root, "cache") });
  assert.equal(result.runs.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, "duplicate_root_session_id");
  assert.equal(result.failures[0].details.duplicateOf, "a");
});

test("cache hits skip per-run analysis and keep deterministic artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-batch-cache-"));
  uniqueBundle(join(root, "bundle"), "cache-root");
  const cacheDir = join(root, "cache");
  let calls = 0;
  const analyzeRun = (...args) => {
    calls += 1;
    return analyzeTraceBundleDetailed(...args);
  };
  const first = analyzeTraceCollection(root, { cacheDir, analyzeRun });
  const second = analyzeTraceCollection(root, { cacheDir, analyzeRun });
  assert.equal(calls, 1);
  assert.deepEqual(first.execution, { cacheHits: 0, cacheMisses: 1 });
  assert.deepEqual(second.execution, { cacheHits: 1, cacheMisses: 0 });
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.runs, second.runs);
  assert.deepEqual(first.aggregate, second.aggregate);
});

test("incremental collection analysis reuses old runs and computes only new bundles", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-batch-incremental-"));
  uniqueBundle(join(root, "a"), "incremental-a");
  const cacheDir = join(root, "cache");
  let calls = 0;
  const analyzeRun = (...args) => {
    calls += 1;
    return analyzeTraceBundleDetailed(...args);
  };
  const first = analyzeTraceCollection(root, { cacheDir, analyzeRun });
  uniqueBundle(join(root, "b"), "incremental-b");
  const second = analyzeTraceCollection(root, { cacheDir, analyzeRun });
  assert.equal(calls, 2);
  assert.deepEqual(first.execution, { cacheHits: 0, cacheMisses: 1 });
  assert.deepEqual(second.execution, { cacheHits: 1, cacheMisses: 1 });
  assert.equal(first.runs.length, 1);
  assert.equal(second.runs.length, 2);
  assert.notEqual(first.batchFingerprint, second.batchFingerprint);
});

test("profile and version identity produce separate cache keys", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-batch-profile-cache-"));
  uniqueBundle(join(root, "bundle"), "profile-root");
  const cacheDir = join(root, "cache");
  let calls = 0;
  const analyzeRun = (...args) => {
    calls += 1;
    return analyzeTraceBundleDetailed(...args);
  };
  const d0 = analyzeTraceCollection(root, {
    cacheDir,
    profileId: "block-d0-v1",
    analyzeRun,
  });
  const c2 = analyzeTraceCollection(root, { cacheDir, profileId: "block-c-v2", analyzeRun });
  assert.equal(calls, 2);
  assert.notEqual(d0.runs[0].cacheKey, c2.runs[0].cacheKey);
  assert.notDeepEqual(d0.profileIdentity, c2.profileIdentity);
});

test("cache key changes when a profile schema or ruleset version changes", () => {
  const identity = {
    inputFingerprint: "same-input",
    ...batchProfileIdentity("block-d0-v1"),
  };
  assert.notEqual(
    batchCacheKey(identity),
    batchCacheKey({ ...identity, rulesetVersion: `${identity.rulesetVersion}-changed` })
  );
  assert.notEqual(
    batchCacheKey(identity),
    batchCacheKey({
      ...identity,
      duplicationSchemaVersion: `${identity.duplicationSchemaVersion}-changed`,
    })
  );
});

test("macro aggregation never pools operation denominators", () => {
  const runs = [
    {
      runId: "a",
      inputFingerprint: "a-fp",
      metrics: { specificSiblingPresenceRatio: { numerator: 1, denominator: 2, value: 0.5 } },
    },
    {
      runId: "b",
      inputFingerprint: "b-fp",
      metrics: { specificSiblingPresenceRatio: { numerator: 9, denominator: 10, value: 0.9 } },
    },
  ];
  const aggregate = aggregateBatchRuns({
    profileIdentity: { profileId: "block-d0-v1" },
    runs,
    failures: [],
    batchFingerprint: "batch",
  });
  const metric = aggregate.duplication.specificSiblingPresenceRatio;
  assert.equal(metric.macro.mean, 0.7);
  assert.notEqual(metric.macro.mean, 10 / 12);
  assert.equal(metric.denominatorPooling, "not_performed");
  assert.deepEqual(
    metric.perRun.map((item) => [item.numerator, item.denominator, item.value]),
    [
      [1, 2, 0.5],
      [9, 10, 0.9],
    ]
  );
  assert.equal(aggregate.pilot.isPilot, true);
  assert.equal(aggregate.pilot.confidenceIntervals, "not_computed");
});

test("batch output is deterministic, reusable, and raw bundles remain unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-batch-output-"));
  const bundleA = uniqueBundle(join(root, "a"), "output-a");
  const bundleB = uniqueBundle(join(root, "b"), "output-b");
  const beforeA = digests(bundleA);
  const beforeB = digests(bundleB);
  const batch = analyzeTraceCollection(root, { cacheDir: join(root, "cache") });
  const report = renderBatchReport(batch);
  const artifacts = batchArtifactContents({ ...batch, report });
  const output = join(root, "result");
  const first = writeBatchOutput(output, artifacts);
  const second = writeBatchOutput(output, artifacts);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.deepEqual(digests(bundleA), beforeA);
  assert.deepEqual(digests(bundleB), beforeB);
  assert.match(report, /N=2 pilot/);
  assert.match(report, /not ratios of pooled operation counts/);
  for (const file of [
    "batch-manifest.json",
    "runs.jsonl",
    "failures.jsonl",
    "aggregate-summary.json",
    "report.md",
    "output-hashes.json",
  ]) {
    assert.ok(readFileSync(resolve(output, file)).length >= 0);
  }
});

test(
  "real N=2 batch equals the two per-run D0.1 summaries and preserves raw evidence",
  { skip: !existsSync(REAL_TRACE_A) || !existsSync(REAL_TRACE_B) },
  () => {
    const beforeA = digests(REAL_TRACE_A);
    const beforeB = digests(REAL_TRACE_B);
    const fixtureRoot = mkdtempSync(join(tmpdir(), "oi-real-batch-"));
    const collectionDir = join(fixtureRoot, "collection");
    mkdirSync(collectionDir);
    cpSync(REAL_TRACE_A, join(collectionDir, "trace-a"), { recursive: true });
    cpSync(REAL_TRACE_B, join(collectionDir, "trace-b"), { recursive: true });
    const batch = analyzeTraceCollection(collectionDir, {
      cacheDir: join(fixtureRoot, "cache"),
    });
    assert.equal(batch.runs.length, 2);
    assert.equal(batch.failures.length, 0);
    assert.equal(batch.aggregate.pilot.isPilot, true);
    for (const [trace, rootId] of [
      [REAL_TRACE_A, "4fd2789a968301d04feea8c5cd2a4628"],
      [REAL_TRACE_B, "1c929e3aed7c97b57563c73e242e603a"],
    ]) {
      const perRun = analyzeTraceBundleDetailed(trace, { profile: "block-d0-v1" }).summary;
      const run = batch.runs.find((item) => item.runId === rootId);
      assert.ok(run);
      const numericMetric = (value) => ({
        numerator: value.numerator,
        denominator: value.denominator,
        value: value.value,
      });
      assert.deepEqual(
        run.metrics.specificSiblingPresenceRatio,
        numericMetric(perRun.observedDuplication.specificSiblingPresenceDuplicateRatio)
      );
      assert.deepEqual(
        run.metrics.syntacticSiblingPresenceRatio,
        numericMetric(perRun.observedDuplication.syntacticSiblingPresenceDuplicateRatio)
      );
      assert.deepEqual(
        run.metrics.specificAllInstanceExcessSensitivity,
        numericMetric(perRun.observedDuplication.specificAllInstanceExcessSensitivity)
      );
      assert.deepEqual(
        run.metrics.syntacticWithinSiblingRepetitionRatio,
        numericMetric(perRun.observedDuplication.syntacticWithinSiblingRepetitionRatio)
      );
    }
    assert.equal(
      batch.aggregate.duplication.specificSiblingPresenceRatio.macro.mean,
      (19 / 220 + 56 / 287) / 2
    );
    assert.equal(
      batch.aggregate.duplication.specificSiblingPresenceRatio.denominatorPooling,
      "not_performed"
    );
    assert.deepEqual(digests(REAL_TRACE_A), beforeA);
    assert.deepEqual(digests(REAL_TRACE_B), beforeB);
  }
);
