import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableJson, stableJsonl } from "../json.mjs";

function cell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return `${[headers.map(cell).join(","), ...rows.map((r) => headers.map((key) => cell(r[key])).join(","))].join("\n")}\n`;
}

function percent(value) {
  return value === null ? "unknown" : `${(value * 100).toFixed(2)}%`;
}
function seconds(value) {
  return value === null ? "unknown" : (value / 1000).toFixed(3);
}
function escapeMd(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(rows, key) {
  return [
    `| ${key} | Calls | Timed | Known seconds | Known time share | P50 seconds | P95 seconds |`,
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...[...rows]
      .sort((a, b) => b.knownElapsedMs - a.knownElapsedMs)
      .map(
        (r) =>
          `| ${escapeMd(r[key])} | ${r.invocationCount} | ${r.measurableCount} | ${seconds(r.knownElapsedMs)} | ${percent(r.knownTimeShare)} | ${seconds(r.p50Ms)} | ${seconds(r.p95Ms)} |`
      ),
  ].join("\n");
}

export function writeReport(output, manifest, rows, metrics, topN) {
  const ordered = rows
    .filter((r) => r.observedToolElapsedMs !== null)
    .sort(
      (a, b) =>
        b.observedToolElapsedMs - a.observedToolElapsedMs ||
        a.invocationId.localeCompare(b.invocationId)
    );
  const top = ordered.slice(0, topN);
  const ambiguous = ordered.filter((r) => ["mixed", "unknown"].includes(r.category)).slice(0, topN);
  const tables = {
    "by-task": metrics.byTask,
    "by-benchmark": metrics.byBenchmark,
    "by-tool": metrics.byTool,
    "by-category": metrics.byCategory,
    "by-role": metrics.byRole,
    "by-status": metrics.byStatus,
    "by-outcome": metrics.byOutcome,
    "by-scoring": metrics.byScoring,
    "by-task-role": metrics.byTaskRole,
  };
  writeFileSync(join(output, "input-manifest.json"), stableJson(manifest));
  writeFileSync(join(output, "invocations.jsonl"), stableJsonl(rows));
  writeFileSync(join(output, "coverage.json"), stableJson(metrics.coverage));
  writeFileSync(join(output, "summary.json"), stableJson(metrics));
  writeFileSync(join(output, "top-invocations.jsonl"), stableJsonl(top));
  writeFileSync(join(output, "top-ambiguous.jsonl"), stableJsonl(ambiguous));
  for (const [name, values] of Object.entries(tables))
    writeFileSync(join(output, `${name}.csv`), csv(values));
  const failed = manifest.attempts.filter((a) => a.disposition !== "included");
  const o = metrics.overall;
  const report = [
    `# Time distribution: ${escapeMd(manifest.campaignId)}`,
    "",
    `Analyzer: ${manifest.analyzerVersion}; rules: ${manifest.rulesetVersion}.`,
    "",
    `Planned attempts: ${manifest.attempts.length}; included: ${manifest.attempts.length - failed.length}; excluded: ${failed.length}.`,
    `Tool calls: ${o.invocationCount}; measurable: ${o.measurableCount}; unknown timing: ${o.unknownTimingCount}.`,
    `Known cumulative tool seconds: ${seconds(o.knownElapsedMs)}; mixed/unknown category share of known time: ${percent(o.mixedOrUnknownKnownTimeShare)}.`,
    "",
    "These are uncalibrated cross-clock invocation elapsed-time proxies, not CPU time or task wall time. Parallel calls and parent waiting overlap child work. Unknown durations are excluded, not zero; count coverage does not establish time coverage. Synthetic 1 ms repairs are never used.",
    "",
    "Classification describes requested whole invocations, not execution/success of individual shell segments. Compound calls are counted once. Script execution does not establish computation or test intent. No critical-path savings, removable waiting, or LLM-time claim is made.",
    "",
    "Coordination tool time measures the recorded call interval, not sandbox startup or the child task's lifetime. A zero category share means no eligible calls were assigned to that category; it does not establish absence of that work inside mixed/unknown calls.",
    "",
    "## Campaign workload by category",
    "",
    table(metrics.byCategory, "category"),
    "",
    "## By tool",
    "",
    table(metrics.byTool, "tool"),
    "",
    "## By agent role",
    "",
    table(metrics.byRole, "role"),
    "",
    "## Equal-weight task shares versus pooled workload",
    "",
    "| Benchmark | Category | Macro task mean | Macro task median | Pooled share | Eligible tasks / planned |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...metrics.byBenchmark.map(
      (r) =>
        `| ${r.benchmark} | ${r.category} | ${percent(r.macroTaskMeanShare)} | ${percent(r.macroTaskMedianShare)} | ${percent(r.pooledKnownTimeShare)} | ${r.eligibleTaskCount}/${r.plannedTaskCount} |`
    ),
    "",
    "Macro shares average measurable repetitions within each task, then weight tasks equally. Missing categories are zero for eligible tasks. Zero-denominator attempts/tasks are excluded from share means, with dispositions retained in coverage.json. P50/P95 and medians use nearest-rank; CSV durations are milliseconds.",
    "",
    "## Slowest invocation evidence",
    "",
    "| Attempt | Role | Tool | Category | Proxy seconds | Source event |",
    "| --- | --- | --- | --- | ---: | --- |",
    ...top
      .slice(0, 10)
      .map(
        (r) =>
          `| ${r.attemptId} | ${r.role} | ${r.tool} | ${r.category} | ${seconds(r.observedToolElapsedMs)} | ${escapeMd(r.source.eventId)} |`
      ),
    "",
    "Exact source file/line and call IDs are in top-invocations.jsonl; high-time mixed/unknown calls are in top-ambiguous.jsonl. Raw command arguments and tool output are intentionally not copied. Inspect only selected source events.",
    "",
    "## Input dispositions",
    "",
    ...(failed.length
      ? failed.map((a) => `- ${a.attemptId}: ${escapeMd(a.error)}`)
      : ["All planned attempts passed input validation and were included."]),
    "",
    "coverage.json contains overlapping exclusion-reason counts, coverage by tool/status/benchmark and all planned attempts, including failures and unscored tasks. by-outcome.csv and by-scoring.csv preserve execution/validation strata.",
    "",
  ].join("\n");
  writeFileSync(join(output, "report.md"), report);
}
