function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "—";
}

function metricValue(run, key) {
  return percent(run.metrics[key]?.value);
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function macroRows(group) {
  return Object.entries(group).map(([name, metric]) => [
    name,
    metric.availableRunCount,
    percent(metric.macro?.mean),
    percent(metric.macro?.median),
    percent(metric.macro?.min),
    percent(metric.macro?.max),
  ]);
}

export function renderBatchReport({ manifest, runs, failures, aggregate }) {
  const runRows = runs.map((run) => [
    run.runId.slice(0, 8),
    run.repository ?? "—",
    metricValue(run, "specificSiblingPresenceRatio"),
    metricValue(run, "syntacticSiblingPresenceRatio"),
    metricValue(run, "specificAllInstanceExcessSensitivity"),
    metricValue(run, "syntacticAllInstanceExcessSensitivity"),
    metricValue(run, "specificWithinSiblingRepetitionRatio"),
    metricValue(run, "syntacticWithinSiblingRepetitionRatio"),
    metricValue(run, "invocationParsedCoverage"),
    metricValue(run, "fallbackInvocationRate"),
  ]);
  const failureRows = failures.map((failure) => [
    failure.relativePath.replaceAll("|", "\\|"),
    failure.stage,
    failure.code,
    failure.message.replaceAll("|", "\\|").replaceAll("\n", " "),
  ]);
  return `# OpenInspect Batch Analysis — E0 Pilot

## Scope

- Batch fingerprint: \`${manifest.batchFingerprint}\`
- Profile: \`${manifest.profileIdentity.profileId}\`
- Statistical unit: **run**
- Successful runs: ${runs.length}
- Failures: ${failures.length}
- Candidate bundles: ${manifest.discovery.candidateCount}
- Aggregation: unweighted per-run macro summaries
- Operation numerator/denominator pooling: **not performed**
- Confidence intervals: **not computed**

Pilot boundary: **${aggregate.pilot.reason}** No paper-level inference, significance, or causal claim
is made from this batch.

## Per-run metrics

${
  runRows.length > 0
    ? table(
        [
          "Run",
          "Repository",
          "Specific presence",
          "Syntactic presence",
          "Specific all-instance",
          "Syntactic all-instance",
          "Specific within",
          "Syntactic within",
          "Parser coverage",
          "Fallback rate",
        ],
        runRows
      )
    : "- No successful runs."
}

Every run's exact numerator, denominator, and value are retained in \`runs.jsonl\` and
\`aggregate-summary.json\`.

## Macro descriptive summaries

Duplication and sensitivity:

${table(["Metric", "Runs", "Mean", "Median", "Min", "Max"], macroRows(aggregate.duplication))}

Parser/fallback coverage:

${table(
  ["Metric", "Runs", "Mean", "Median", "Min", "Max"],
  macroRows(aggregate.normalizationCoverage)
)}

These are unweighted summaries of per-run values. They are not ratios of pooled operation counts.

## Failures

${failureRows.length > 0 ? table(["Bundle", "Stage", "Code", "Message"], failureRows) : "- None."}

## Interpretation boundary

- N=${runs.length} is a pilot workflow validation dataset.
- No confidence interval or significance test is computed.
- Parser coverage and fallback limits remain run-specific evidence boundaries.
- Observed duplication is not result equivalence, removability, or eliminability.
- No parser, semantic similarity, finding overlap, replay, or LLM analysis is added by E0.
`;
}
