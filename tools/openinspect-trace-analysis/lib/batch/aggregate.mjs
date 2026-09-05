export const BATCH_AGGREGATE_SCHEMA_VERSION = "openinspect-trace-batch-aggregate-e0-v0";

function descriptive(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function macroMetric(runs, metricKey) {
  const perRun = runs.flatMap((run) => {
    const metric = run.metrics[metricKey];
    if (!metric || !Number.isFinite(metric.value)) return [];
    return [
      {
        runId: run.runId,
        inputFingerprint: run.inputFingerprint,
        numerator: metric.numerator,
        denominator: metric.denominator,
        value: metric.value,
      },
    ];
  });
  return {
    statisticalUnit: "run",
    aggregation: "unweighted_macro",
    denominatorPooling: "not_performed",
    availableRunCount: perRun.length,
    missingRunCount: runs.length - perRun.length,
    perRun,
    macro: descriptive(perRun.map((item) => item.value)),
  };
}

export function aggregateBatchRuns({ profileIdentity, runs, failures, batchFingerprint }) {
  const runCount = runs.length;
  const pilot = runCount <= 2;
  return {
    schemaVersion: BATCH_AGGREGATE_SCHEMA_VERSION,
    batchFingerprint,
    profileIdentity,
    statisticalUnit: "run",
    aggregationPrinciple:
      "Unweighted per-run macro summaries; operation numerators and denominators are never pooled across runs.",
    successfulRunCount: runCount,
    failureCount: failures.length,
    pilot: {
      isPilot: pilot,
      reason:
        runCount === 2
          ? "N=2 pilot: descriptive validation only."
          : pilot
            ? `N=${runCount} pilot: descriptive validation only.`
            : `N=${runCount}: descriptive batch summary only.`,
      statisticalInference: "not_performed",
      significanceClaims: "not_performed",
      confidenceIntervals: "not_computed",
    },
    duplication: {
      specificSiblingPresenceRatio: macroMetric(runs, "specificSiblingPresenceRatio"),
      syntacticSiblingPresenceRatio: macroMetric(runs, "syntacticSiblingPresenceRatio"),
      specificAllInstanceExcessSensitivity: macroMetric(
        runs,
        "specificAllInstanceExcessSensitivity"
      ),
      syntacticAllInstanceExcessSensitivity: macroMetric(
        runs,
        "syntacticAllInstanceExcessSensitivity"
      ),
      specificWithinSiblingRepetitionRatio: macroMetric(
        runs,
        "specificWithinSiblingRepetitionRatio"
      ),
      syntacticWithinSiblingRepetitionRatio: macroMetric(
        runs,
        "syntacticWithinSiblingRepetitionRatio"
      ),
    },
    normalizationCoverage: {
      invocationParsedCoverage: macroMetric(runs, "invocationParsedCoverage"),
      shellSegmentSemanticReach: macroMetric(runs, "shellSegmentSemanticReach"),
      fallbackInvocationRate: macroMetric(runs, "fallbackInvocationRate"),
    },
  };
}
