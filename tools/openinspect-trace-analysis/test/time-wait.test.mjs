import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";
import { createSyntheticBundle } from "./fixture.mjs";
import { loadTraceBundle } from "../lib/loader.mjs";
import {
  buildSessionHistories,
  childStateAt,
  partitionWait,
  unionDuration,
  analyzeParentWaits,
  summarizeParentWaits,
  WAIT_STATES,
} from "../lib/time/wait-timeline.mjs";
import { renderWaitTimeline } from "../lib/time/wait-report.mjs";

const BASE = 1700000000000;
const context = { campaignId: "test", attemptId: "001", taskId: "task", benchmark: "featurebench" };
function message(id, created, started, completed, status = "completed") {
  return {
    messageId: id,
    createdAtMs: BASE + created,
    startedAtMs: started === null ? null : BASE + started,
    completedAtMs: completed === null ? null : BASE + completed,
    status,
    source: { file: "messages.jsonl", line: 1, messageId: id },
  };
}
function child(id = "child", messages = [message("m", 200, 300, 1000)]) {
  return {
    sessionId: id,
    parentSessionId: "root",
    finalStatus: "completed",
    createdAtMs: BASE + 100,
    messages,
    readyEvents: [],
    statusProbes: [],
    issues: [],
  };
}
function parent() {
  return {
    ...child("root", [message("root-message", 0, 100, 10000)]),
    parentSessionId: null,
    createdAtMs: BASE,
  };
}
function wait(start = 400, end = 2000) {
  return {
    ...context,
    invocationId: "wait-1",
    role: "parent",
    category: "explicit_wait",
    tags: ["explicit_wait"],
    messageId: "root-message",
    startedAtMs: BASE + start,
    rawFinishedAtMs: BASE + end,
    observedToolElapsedMs: end - start,
    source: { file: "events.jsonl", line: 1, eventId: "wait" },
  };
}
function duration(segments, state) {
  return segments.filter((s) => s.state === state).reduce((n, s) => n + s.durationMs, 0);
}

test("wait partition uses the last pending sibling, preserves evidence, and covers the whole interval", () => {
  const segments = partitionWait(wait(), parent(), [
    child(),
    child("other", [message("b", 250, 800, 1500)]),
  ]);
  assert.equal(duration(segments, "child_work_pending"), 1100);
  assert.equal(duration(segments, "all_final_completed"), 500);
  assert.equal(
    segments.reduce((n, s) => n + s.durationMs, 0),
    1600
  );
  const final = segments.at(-1);
  assert.equal(final.latestChildCompletionAtMs, BASE + 1500);
  assert.equal(final.children.length, 2);
  assert.equal(final.children[1].source.messageId, "b");
});

test("future child creation is not treated as past pending work or final completion", () => {
  const a = child("a", [message("a", 200, 300, 700)]);
  const b = { ...child("b", [message("b", 1200, 1300, 1600)]), createdAtMs: BASE + 1200 };
  const segments = partitionWait(wait(500, 2000), parent(), [a, b]);
  assert.equal(duration(segments, "all_current_completed"), 500);
  assert.equal(duration(segments, "all_final_completed"), 400);
  assert.equal(
    duration(partitionWait(wait(10, 50), parent(), [a]), "outside_parent_execution"),
    40
  );
  assert.equal(duration(partitionWait(wait(100, 150), parent(), []), "no_child_created"), 50);
});

test("later prompts split between-round completion from queued and executing work", () => {
  const c = child("child", [message("one", 200, 300, 800), message("two", 1200, 1500, 1900)]);
  const segments = partitionWait(wait(400, 2000), parent(), [c]);
  assert.equal(duration(segments, "all_current_completed"), 400);
  assert.equal(duration(segments, "all_final_completed"), 100);
  assert.equal(childStateAt(c, BASE + 1300).messages[0].phase, "queued");
  assert.equal(childStateAt(c, BASE + 1700).messages[0].phase, "executing");
});

test("failure/cancellation and absent history never become successful completion", () => {
  const failed = child("child", [message("bad", 200, null, 800, "failed")]);
  failed.finalStatus = "cancelled";
  assert.equal(
    duration(partitionWait(wait(), parent(), [failed]), "all_current_terminal_with_failure"),
    1200
  );
  const unknown = child("empty", []);
  assert.equal(duration(partitionWait(wait(), parent(), [unknown]), "unknown_child_state"), 1600);
  const malformed = { ...child(), createdAtMs: null, issues: ["invalid_session_creation"] };
  assert.equal(duration(partitionWait(wait(), parent(), [malformed]), "unknown_child_state"), 1600);
  const unresolved = child("run", [message("run", 200, 300, null, "running")]);
  assert.equal(duration(partitionWait(wait(), parent(), [unresolved]), "child_work_pending"), 1600);
});

test("a ready event after completion invalidates the quiet period until a new request", () => {
  const c = child("child", [message("one", 200, 300, 800), message("two", 1400, 1500, 1800)]);
  c.readyEvents = [{ atMs: BASE + 1100, eventId: "ready-again" }];
  const segments = partitionWait(wait(), parent(), [c]);
  assert.equal(duration(segments, "all_current_completed"), 300);
  assert.equal(duration(segments, "unknown_child_state"), 300);
  assert.equal(duration(segments, "all_final_completed"), 200);
  const crossing = child("cross", [message("one", 200, 300, 1800)]);
  crossing.readyEvents = c.readyEvents;
  assert.equal(childStateAt(crossing, BASE + 1200).state, "pending");
});

test("invalid wait timing is not synthesized, and parent execution bounds are retained", () => {
  assert.deepEqual(
    partitionWait({ ...wait(), observedToolElapsedMs: null }, parent(), [child()]),
    []
  );
  const segments = partitionWait(wait(9000, 11000), parent(), [child()]);
  assert.equal(duration(segments, "all_final_completed"), 1000);
  assert.equal(duration(segments, "outside_parent_execution"), 1000);
  const badParent = parent();
  badParent.messages[0].completedAtMs = null;
  assert.equal(
    duration(partitionWait(wait(), badParent, [child()]), "outside_parent_execution"),
    1600
  );
});

test("overlap union does not count repeated intervals, and summaries retain excluded/no-wait attempts", () => {
  assert.equal(
    unionDuration([
      [10, 30],
      [20, 40],
      [15, 25],
      [40, 50],
      [90, 80],
    ]),
    40
  );
  const baseSummary = {
    ...context,
    explicitWaitCount: 1,
    measurableWaitCount: 1,
    unknownWaitTimingCount: 0,
    mixedCallsTaggedWaitCount: 0,
    candidateWaitCount: 1,
    cumulativeWaitCallMs: 100,
    waitUnionMs: 100,
    allCompletedOverlapMs: 20,
    allCompletedWaitShare: 0.2,
    byStateMs: Object.fromEntries(
      WAIT_STATES.map((s) => [
        s,
        s === "all_final_completed" ? 20 : s === "child_work_pending" ? 80 : 0,
      ])
    ),
    completionGuardScenarios: [0, 1000, 5000].map((guardMs) => ({
      guardMs,
      allCompletedOverlapMs: 20,
      allFinalCompletedOverlapMs: 20,
    })),
  };
  const summary = summarizeParentWaits(
    [{ context, summary: baseSummary }],
    [context, { ...context, attemptId: "missing", taskId: "missing", error: "missing data" }]
  );
  assert.equal(summary.excludedAttemptCount, 1);
  assert.equal(summary.overall.pooledAllCompletedWaitShare, 0.2);
  assert.equal(summary.attempts[1].disposition, "excluded");
  const empty = summarizeParentWaits([], []);
  assert.equal(empty.overall.pooledAllCompletedWaitShare, null);
});

test("bundle analysis checks message count and boundary validity without exporting prompt content", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oi-waits-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  createSyntheticBundle(dir);
  const bundle = loadTraceBundle(dir);
  const root = bundle.messages.find((m) => m.sessionId === "root");
  const record = { ...wait(2500, 5000), messageId: root.id };
  const result = analyzeParentWaits(
    bundle,
    [
      record,
      { ...record, invocationId: "wait-2", startedAtMs: BASE + 3000, observedToolElapsedMs: 2000 },
    ],
    context
  );
  assert.equal(result.summary.cumulativeWaitCallMs, 4500);
  assert.equal(result.summary.waitUnionMs, 2500);
  assert.equal(result.summary.byStateMs.all_final_completed, 1000);
  assert.equal(result.summary.completionGuardScenarios[1].allCompletedOverlapMs, 0);
  assert.ok(!JSON.stringify(result).includes('"content"'));
  bundle.sessions[1].messageCount = 20;
  assert.ok(buildSessionHistories(bundle, [record])[1].issues.includes("message_count_mismatch"));
  bundle.messages[1].completedAt = null;
  assert.ok(
    buildSessionHistories(bundle, [record])[1].issues.includes("invalid_terminal_boundary")
  );
});

test("HTML embeds escaped data, has no network dependencies, and contains syntactically valid UI code", () => {
  const html = renderWaitTimeline({
    labels: {},
    attempts: [],
    test: "</script><script>alert(1)</script>",
  });
  assert.ok(!html.includes("<script>alert(1)"));
  assert.ok(!html.includes("<script src="));
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  assert.equal(JSON.parse(scripts[0][1]).test, "</script><script>alert(1)</script>");
  assert.doesNotThrow(() => new Script(scripts[1][1]));
});
