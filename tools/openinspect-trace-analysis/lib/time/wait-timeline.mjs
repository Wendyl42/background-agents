import { readFileSync } from "node:fs";
import { join } from "node:path";

export const WAIT_ANALYSIS_VERSION = "openinspect-parent-wait-v1";
// Illustrative completion-boundary shifts, not calibrated clock-error bounds.
export const COMPLETION_GUARDS_MS = [0, 1000, 5000];
export const WAIT_STATES = [
  "child_work_pending",
  "all_final_completed",
  "all_current_completed",
  "all_current_terminal_with_failure",
  "unknown_child_state",
  "no_child_created",
  "outside_parent_execution",
];
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const SUCCESS_STATES = new Set(["all_final_completed", "all_current_completed"]);
const validTime = (value) => Number.isFinite(value) && value > 0;

function messageReferences(bundleDir) {
  const file = join(bundleDir, "normalized/messages.jsonl");
  const refs = new Map();
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      refs.set(`${message.sessionId}:${message.id}`, {
        file,
        line: index + 1,
        messageId: message.id,
      });
    });
  return refs;
}

export function buildSessionHistories(bundle, ledger) {
  const refs = messageReferences(bundle.bundleDir);
  const toolRefs = new Map(ledger.map((row) => [row.invocationId, row.source]));
  return bundle.sessions.map((session) => {
    const messages = bundle.messages
      .filter((m) => m.sessionId === session.id)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((m) => ({
        messageId: m.id,
        createdAtMs: m.createdAt,
        startedAtMs: m.startedAt,
        completedAtMs: m.completedAt,
        status: m.status,
        source: refs.get(`${session.id}:${m.id}`),
      }));
    const readyEvents = bundle.events
      .filter((e) => e.sessionId === session.id && e.type === "ready")
      .map((e) => ({
        atMs: e.createdAt,
        eventId: e.id,
        sourceFile: join(bundle.bundleDir, "normalized/events.jsonl"),
      }))
      .sort((a, b) => a.atMs - b.atMs);
    const issues = [];
    if (session.messageCount !== undefined && session.messageCount !== messages.length)
      issues.push("message_count_mismatch");
    if (!validTime(session.createdAt)) issues.push("invalid_session_creation");
    for (const m of messages) {
      if (!validTime(m.createdAtMs) || m.createdAtMs < session.createdAt)
        issues.push("invalid_message_creation");
      if (m.startedAtMs != null && (!validTime(m.startedAtMs) || m.startedAtMs < m.createdAtMs))
        issues.push("invalid_message_start");
      if (TERMINAL.has(m.status)) {
        if (!validTime(m.completedAtMs) || m.completedAtMs < (m.startedAtMs ?? m.createdAtMs))
          issues.push("invalid_terminal_boundary");
        if (m.status === "completed" && !validTime(m.startedAtMs))
          issues.push("missing_successful_start");
      } else if (
        m.completedAtMs != null ||
        !["queued", "pending", "running", "processing"].includes(m.status)
      )
        issues.push("unknown_message_lifecycle");
    }
    return {
      sessionId: session.id,
      parentSessionId: session.parentSessionId,
      finalStatus: session.status,
      createdAtMs: session.createdAt,
      messages,
      readyEvents,
      issues: [...new Set(issues)].sort(),
      hasDescendants: bundle.sessions.some((s) => s.parentSessionId === session.id),
      // Probes are evidence markers only: do not infer what the parent knew from final snapshots.
      statusProbes: bundle.events
        .filter(
          (e) =>
            e.sessionId === session.id &&
            e.type === "tool_call" &&
            e.data?.tool === "get-child-status"
        )
        .map((e) => ({
          atMs: e.createdAt,
          childId: e.data.args?.childId ?? null,
          source: toolRefs.get(`${session.id}:${e.id}`),
        })),
    };
  });
}

export function childStateAt(child, atMs) {
  if (child.issues.length)
    return { sessionId: child.sessionId, state: "unknown", reasons: child.issues };
  const requested = child.messages.filter((m) => m.createdAtMs <= atMs);
  if (!requested.length)
    return { sessionId: child.sessionId, state: "unknown", reasons: ["no_recorded_request_yet"] };
  const pending = requested.filter((m) => !validTime(m.completedAtMs) || m.completedAtMs > atMs);
  if (pending.length)
    return {
      sessionId: child.sessionId,
      state: "pending",
      messages: pending.map((m) => ({
        messageId: m.messageId,
        phase: m.startedAtMs != null && m.startedAtMs <= atMs ? "executing" : "queued",
        source: m.source,
      })),
    };
  const latest = requested.at(-1);
  const completedAtMs = Math.max(...requested.map((m) => m.completedAtMs));
  const afterReady = child.readyEvents.filter((e) => e.atMs > completedAtMs && e.atMs <= atMs);
  if (afterReady.length)
    return {
      sessionId: child.sessionId,
      state: "unknown",
      reasons: ["ready_after_last_completion"],
      readyEvents: afterReady,
    };
  const noLaterWork =
    requested.length === child.messages.length && !child.readyEvents.some((e) => e.atMs > atMs);
  return {
    sessionId: child.sessionId,
    state: latest.status === "completed" ? "completed" : "failed_or_cancelled",
    latestStatus: latest.status,
    completedAtMs,
    source: latest.source,
    finalObservedCompletion:
      noLaterWork && latest.status === "completed" && child.finalStatus === "completed",
  };
}

function groupStateAt(children, atMs) {
  const visible = children.filter((c) => !validTime(c.createdAtMs) || c.createdAtMs <= atMs);
  const states = visible.map((child) => childStateAt(child, atMs));
  if (!states.length) return { state: "no_child_created", children: states };
  if (states.some((s) => s.state === "pending"))
    return { state: "child_work_pending", children: states };
  if (states.some((s) => s.state === "unknown"))
    return { state: "unknown_child_state", children: states };
  if (states.some((s) => s.state === "failed_or_cancelled"))
    return { state: "all_current_terminal_with_failure", children: states };
  const final =
    visible.length === children.length && states.every((s) => s.finalObservedCompletion);
  return {
    state: final ? "all_final_completed" : "all_current_completed",
    children: states,
    latestChildCompletionAtMs: Math.max(...states.map((s) => s.completedAtMs)),
  };
}

export function partitionWait(wait, parent, children) {
  if (wait.observedToolElapsedMs === null) return [];
  const start = wait.startedAtMs;
  const end = wait.rawFinishedAtMs;
  const parentMessage = parent.messages.find((m) => m.messageId === wait.messageId);
  const parentWindowValid =
    !parent.issues.length &&
    parentMessage &&
    validTime(parentMessage.startedAtMs) &&
    validTime(parentMessage.completedAtMs) &&
    parentMessage.completedAtMs >= parentMessage.startedAtMs;
  const boundaries = [start, end];
  if (parentWindowValid) boundaries.push(parentMessage.startedAtMs, parentMessage.completedAtMs);
  for (const c of children) {
    boundaries.push(c.createdAtMs, ...c.readyEvents.map((e) => e.atMs));
    for (const m of c.messages) boundaries.push(m.createdAtMs, m.startedAtMs, m.completedAtMs);
  }
  const sorted = [
    ...new Set(boundaries.filter((t) => validTime(t) && t >= start && t <= end)),
  ].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const startMs = sorted[i];
    const endMs = sorted[i + 1];
    const outside =
      !parentWindowValid ||
      startMs < parentMessage.startedAtMs ||
      startMs >= parentMessage.completedAtMs;
    const state = outside
      ? { state: "outside_parent_execution", children: [] }
      : groupStateAt(children, startMs);
    segments.push({
      invocationId: wait.invocationId,
      attemptId: wait.attemptId,
      taskId: wait.taskId,
      benchmark: wait.benchmark,
      parentSessionId: parent.sessionId,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      ...state,
      waitSource: wait.source,
      parentMessageSource: parentMessage?.source ?? null,
    });
  }
  return segments;
}

export function unionDuration(intervals) {
  const sorted = intervals
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let end = -Infinity;
  for (const [start, nextEnd] of sorted) {
    total += Math.max(0, nextEnd - Math.max(start, end));
    end = Math.max(end, nextEnd);
  }
  return total;
}

function intervalTotals(segments) {
  const intervals = (selected) => selected.map((s) => [s.startMs, s.endMs]);
  const byStateMs = Object.fromEntries(
    WAIT_STATES.map((state) => [
      state,
      unionDuration(intervals(segments.filter((s) => s.state === state))),
    ])
  );
  const success = segments.filter((s) => SUCCESS_STATES.has(s.state));
  return {
    waitUnionMs: unionDuration(intervals(segments)),
    byStateMs,
    allCompletedOverlapMs: unionDuration(intervals(success)),
    completionGuardScenarios: COMPLETION_GUARDS_MS.map((guardMs) => ({
      guardMs,
      allCompletedOverlapMs: unionDuration(
        success.map((s) => [Math.max(s.startMs, s.latestChildCompletionAtMs + guardMs), s.endMs])
      ),
      allFinalCompletedOverlapMs: unionDuration(
        success
          .filter((s) => s.state === "all_final_completed")
          .map((s) => [Math.max(s.startMs, s.latestChildCompletionAtMs + guardMs), s.endMs])
      ),
    })),
  };
}

export function analyzeParentWaits(bundle, ledger, context) {
  const histories = buildSessionHistories(bundle, ledger);
  const parent = histories.find((s) => s.parentSessionId === null);
  const children = histories.filter((s) => s.parentSessionId === parent.sessionId);
  const waits = ledger.filter((r) => r.role === "parent" && r.category === "explicit_wait");
  const allSegments = [];
  const records = waits.map((wait) => {
    const segments = partitionWait(wait, parent, children);
    allSegments.push(...segments);
    const totals = intervalTotals(segments);
    return {
      ...wait,
      ...totals,
      candidate: totals.allCompletedOverlapMs > 0,
      disposition: wait.observedToolElapsedMs === null ? "unknown_wait_timing" : "partitioned",
    };
  });
  const totals = intervalTotals(allSegments);
  const scope = {
    explicitWaitCount: waits.length,
    measurableWaitCount: waits.filter((w) => w.observedToolElapsedMs !== null).length,
    unknownWaitTimingCount: waits.filter((w) => w.observedToolElapsedMs === null).length,
    mixedCallsTaggedWaitCount: ledger.filter(
      (r) =>
        r.role === "parent" && r.category !== "explicit_wait" && r.tags.includes("explicit_wait")
    ).length,
    cumulativeWaitCallMs: waits.reduce((sum, w) => sum + (w.observedToolElapsedMs ?? 0), 0),
    directChildCount: children.length,
    multiRoundChildCount: children.filter((c) => c.messages.length > 1).length,
    childHistoryIssues: children
      .filter((c) => c.issues.length)
      .map((c) => ({ sessionId: c.sessionId, issues: c.issues })),
    childrenWithDescendants: children.filter((c) => c.hasDescendants).map((c) => c.sessionId),
  };
  return {
    context,
    sessions: histories,
    waits: records,
    segments: allSegments,
    summary: {
      ...context,
      ...scope,
      ...totals,
      candidateWaitCount: records.filter((r) => r.candidate).length,
      allCompletedWaitShare: totals.waitUnionMs
        ? totals.allCompletedOverlapMs / totals.waitUnionMs
        : null,
    },
  };
}

export function summarizeParentWaits(analyses, attempts) {
  const results = new Map(analyses.map((a) => [a.context.attemptId, a.summary]));
  const dispositions = attempts.map((a) =>
    results.has(a.attemptId)
      ? { ...results.get(a.attemptId), disposition: "included" }
      : {
          attemptId: a.attemptId,
          taskId: a.taskId,
          benchmark: a.benchmark,
          disposition: "excluded",
          error: a.error,
        }
  );
  const combine = (rows) => {
    const sum = (key) => rows.reduce((n, r) => n + r[key], 0);
    const waitUnionMs = sum("waitUnionMs");
    const taskShares = new Map();
    for (const r of rows.filter((r) => r.waitUnionMs > 0)) {
      const shares = taskShares.get(r.taskId) ?? [];
      shares.push(r.allCompletedWaitShare);
      taskShares.set(r.taskId, shares);
    }
    const means = [...taskShares.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
    return {
      attemptCount: rows.length,
      taskCount: new Set(rows.map((r) => r.taskId)).size,
      measurableWaitTaskCount: taskShares.size,
      noMeasurableWaitAttemptCount: rows.filter((r) => !r.waitUnionMs).length,
      explicitWaitCount: sum("explicitWaitCount"),
      measurableWaitCount: sum("measurableWaitCount"),
      unknownWaitTimingCount: sum("unknownWaitTimingCount"),
      mixedCallsTaggedWaitCount: sum("mixedCallsTaggedWaitCount"),
      candidateWaitCount: sum("candidateWaitCount"),
      candidateAttemptCount: rows.filter((r) => r.allCompletedOverlapMs > 0).length,
      cumulativeWaitCallMs: sum("cumulativeWaitCallMs"),
      waitUnionMs,
      allCompletedOverlapMs: sum("allCompletedOverlapMs"),
      pooledAllCompletedWaitShare: waitUnionMs ? sum("allCompletedOverlapMs") / waitUnionMs : null,
      macroTaskAllCompletedWaitShare: means.length
        ? means.reduce((a, b) => a + b, 0) / means.length
        : null,
      byStateMs: Object.fromEntries(
        WAIT_STATES.map((state) => [state, rows.reduce((n, r) => n + r.byStateMs[state], 0)])
      ),
      completionGuardScenarios: COMPLETION_GUARDS_MS.map((guardMs, i) => ({
        guardMs,
        allCompletedOverlapMs: rows.reduce(
          (n, r) => n + r.completionGuardScenarios[i].allCompletedOverlapMs,
          0
        ),
        allFinalCompletedOverlapMs: rows.reduce(
          (n, r) => n + r.completionGuardScenarios[i].allFinalCompletedOverlapMs,
          0
        ),
      })),
    };
  };
  const included = dispositions.filter((a) => a.disposition === "included");
  return {
    analysisVersion: WAIT_ANALYSIS_VERSION,
    plannedAttemptCount: attempts.length,
    excludedAttemptCount: attempts.length - included.length,
    scope:
      "Root-parent explicit-wait invocation intervals versus currently created direct-child message lifecycles. No inferred dependency, CPU cost, parent knowledge or removable time.",
    overall: combine(included),
    byBenchmark: [...new Set(attempts.map((a) => a.benchmark))].sort().map((benchmark) => ({
      benchmark,
      ...combine(included.filter((a) => a.benchmark === benchmark)),
    })),
    attempts: dispositions,
  };
}
