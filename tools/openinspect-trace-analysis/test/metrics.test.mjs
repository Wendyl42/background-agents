import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeTraceBundle } from "../lib/analyze.mjs";
import { renderReport } from "../lib/report.mjs";
import { createSyntheticBundle } from "./fixture.mjs";

function analyzeFixture() {
  const root = createSyntheticBundle(mkdtempSync(join(tmpdir(), "oi-trace-metrics-")));
  return analyzeTraceBundle(root);
}

test("topology and lifecycle metrics are deterministic", () => {
  const summary = analyzeFixture();
  assert.equal(summary.topology.nodeCount, 2);
  assert.equal(summary.topology.edgeCount, 1);
  assert.equal(summary.topology.rootOutDegree, 1);
  assert.equal(summary.topology.maxSpawnDepth, 1);
  assert.equal(summary.lifecycle.reference.kind, "first_root_message_started");
  const child = summary.lifecycle.sessions.find((session) => session.sessionId === "child");
  assert.equal(child.platformReadyLatencyMs, 1_000);
  assert.equal(child.messages[0].queueWaitMs, 1_100);
  assert.equal(child.messages[0].executionDurationMs, 1_800);
  assert.equal(summary.operationNormalization.normalizedOperationCount, 0);
  assert.equal(summary.operationNormalization.fallbackCount, 4);
});

test("concurrency uses separate message, setup, and tool definitions", () => {
  const summary = analyzeFixture();
  assert.equal(summary.concurrency.allMessageExecutions.peakConcurrentSessions, 2);
  assert.equal(summary.concurrency.childMessageExecutions.peakConcurrentSessions, 1);
  assert.equal(summary.concurrency.childPlatformSetup.peakConcurrentIntervals, 1);
  assert.equal(summary.concurrency.childToolInvocations.peakConcurrentIntervals, 2);
  assert.equal(summary.concurrency.childToolInvocations.peakConcurrentSessions, 1);
});

test("summary and report contain no generation-time nondeterminism", () => {
  const first = analyzeFixture();
  const second = analyzeFixture();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(renderReport(first), renderReport(second));
  assert.match(renderReport(first), /Normalized-operation rules: \*\*not implemented/);
});
