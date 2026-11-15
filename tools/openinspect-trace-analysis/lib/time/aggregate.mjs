import { CATEGORIES } from "./classify.mjs";

export function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function summarize(rows) {
  const times = rows.map((r) => r.observedToolElapsedMs).filter((v) => v !== null);
  const knownElapsedMs = times.reduce((sum, n) => sum + n, 0);
  return {
    invocationCount: rows.length,
    measurableCount: times.length,
    unknownTimingCount: rows.length - times.length,
    measurableCountShare: rows.length ? times.length / rows.length : null,
    knownElapsedMs,
    p50Ms: quantile(times, 0.5),
    p95Ms: quantile(times, 0.95),
    maxMs: times.length ? Math.max(...times) : null,
    taskCount: new Set(rows.map((r) => r.taskId)).size,
    attemptCount: new Set(rows.map((r) => r.attemptId)).size,
  };
}

function groupTable(rows, key, denominatorMs) {
  return [...new Set(rows.map((r) => r[key]))].sort().map((value) => {
    const summary = summarize(rows.filter((r) => r[key] === value));
    return {
      [key]: value,
      ...summary,
      denominatorMs,
      knownTimeShare: denominatorMs ? summary.knownElapsedMs / denominatorMs : null,
    };
  });
}

function quality(rows) {
  const summary = summarize(rows);
  const reasonCounts = {};
  for (const row of rows)
    for (const reason of row.exclusionReasons)
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  const ambiguous = rows.filter((r) => ["mixed", "unknown"].includes(r.category));
  const ambiguousMs = summarize(ambiguous).knownElapsedMs;
  return {
    ...summary,
    exclusionReasonCounts: reasonCounts,
    mixedOrUnknownCategoryCount: ambiguous.length,
    mixedOrUnknownKnownElapsedMs: ambiguousMs,
    mixedOrUnknownKnownTimeShare: summary.knownElapsedMs
      ? ambiguousMs / summary.knownElapsedMs
      : null,
  };
}

export function aggregate(rows, attempts) {
  const overall = quality(rows);
  const byTask = [];
  const taskSummaries = attempts.map((attempt) => {
    const taskRows = rows.filter((r) => r.attemptId === attempt.attemptId);
    const totals = quality(taskRows);
    for (const category of CATEGORIES) {
      const categoryRows = taskRows.filter((r) => r.category === category);
      const summary = summarize(categoryRows);
      byTask.push({
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        benchmark: attempt.benchmark,
        disposition: attempt.disposition,
        modelExecution: attempt.modelExecution ?? "unknown",
        scoringStatus: attempt.scoringStatus ?? "unknown",
        category,
        ...summary,
        denominatorMs: totals.knownElapsedMs,
        knownTimeShare: totals.knownElapsedMs
          ? summary.knownElapsedMs / totals.knownElapsedMs
          : null,
      });
    }
    return { ...attempt, ...totals };
  });
  const byBenchmark = [];
  for (const benchmark of [...new Set(attempts.map((a) => a.benchmark))].sort()) {
    const selected = taskSummaries.filter((a) => a.benchmark === benchmark);
    const benchmarkRows = rows.filter((r) => r.benchmark === benchmark);
    const denominatorMs = summarize(benchmarkRows).knownElapsedMs;
    for (const category of CATEGORIES) {
      // Equal weight per task: average measurable repetitions within each task first.
      const taskShares = new Map();
      for (const row of byTask.filter(
        (r) => r.benchmark === benchmark && r.category === category && r.knownTimeShare !== null
      )) {
        const shares = taskShares.get(row.taskId) ?? [];
        shares.push(row.knownTimeShare);
        taskShares.set(row.taskId, shares);
      }
      const shares = [...taskShares.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
      const summary = summarize(benchmarkRows.filter((r) => r.category === category));
      byBenchmark.push({
        benchmark,
        category,
        ...summary,
        denominatorMs,
        pooledKnownTimeShare: denominatorMs ? summary.knownElapsedMs / denominatorMs : null,
        macroTaskMeanShare: shares.length
          ? shares.reduce((a, b) => a + b, 0) / shares.length
          : null,
        macroTaskMedianShare: quantile(shares, 0.5),
        eligibleTaskCount: shares.length,
        plannedTaskCount: new Set(selected.map((a) => a.taskId)).size,
        plannedAttemptCount: selected.length,
        eligibleAttemptCount: selected.filter((a) => a.knownElapsedMs > 0).length,
      });
    }
  }
  return {
    overall,
    byTask,
    byBenchmark,
    byTool: groupTable(rows, "tool", overall.knownElapsedMs),
    byCategory: groupTable(rows, "category", overall.knownElapsedMs),
    byRole: groupTable(rows, "role", overall.knownElapsedMs),
    byStatus: groupTable(rows, "status", overall.knownElapsedMs),
    byOutcome: groupTable(rows, "modelExecution", overall.knownElapsedMs),
    byScoring: groupTable(rows, "scoringStatus", overall.knownElapsedMs),
    byTaskRole: taskSummaries.flatMap((a) =>
      groupTable(
        rows.filter((r) => r.attemptId === a.attemptId),
        "role",
        a.knownElapsedMs
      ).map((r) => ({ attemptId: a.attemptId, taskId: a.taskId, benchmark: a.benchmark, ...r }))
    ),
    coverage: {
      overall,
      attempts: taskSummaries,
      byTool: groupQuality(rows, "tool"),
      byStatus: groupQuality(rows, "status"),
      byBenchmark: groupQuality(rows, "benchmark"),
      note: "Exclusion reasons overlap. Count coverage is not time coverage; unknown durations are not zero.",
    },
  };
}

function groupQuality(rows, key) {
  return [...new Set(rows.map((r) => r[key]))]
    .sort()
    .map((value) => ({ [key]: value, ...quality(rows.filter((r) => r[key] === value)) }));
}
