#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTraceBundleDetailed } from "./lib/analyze.mjs";
import { DEFAULT_ANALYSIS_PROFILE, getAnalysisProfile } from "./lib/constants.mjs";
import { stableJson, stableJsonl } from "./lib/json.mjs";
import { renderReport } from "./lib/report.mjs";
import { writeAnalysisOutput } from "./lib/output.mjs";

const TOOL_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PROJECT_ROOT = resolve(TOOL_DIR, "../..");

function usage(error) {
  if (error) console.error(`Error: ${error}\n`);
  console.error(`Usage:
  node tools/openinspect-trace-analysis/cli.mjs analyze <trace-bundle> [--profile <id>] [--out <directory>]

Default profile: block-ab-v0. Available: block-ab-v0, block-c-v0, block-c-v1, block-c-v2, block-d0-v0, block-d0-v1.
`);
  process.exit(error ? 1 : 0);
}

function parseArgs(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") usage();
  if (argv[0] !== "analyze") usage("Expected the analyze command");
  if (!argv[1] || argv[1].startsWith("--")) usage("Trace bundle path is required");
  const parsed = {
    traceDir: resolve(argv[1]),
    outputDir: null,
    profileId: DEFAULT_ANALYSIS_PROFILE,
  };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usage("--out requires a directory");
      parsed.outputDir = resolve(value);
      index += 1;
    } else if (argv[index] === "--profile") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usage("--profile requires an ID");
      getAnalysisProfile(value);
      parsed.profileId = value;
      index += 1;
    } else {
      usage(`Unknown argument: ${argv[index]}`);
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const analyzed = analyzeTraceBundleDetailed(args.traceDir, { profile: args.profileId });
  const { summary, profile, artifacts } = analyzed;
  const rootId = summary.input.rootSessionId;
  const outputDir =
    args.outputDir ??
    resolve(
      PROJECT_ROOT,
      "analysis/openinspect",
      rootId,
      `${profile.outputPrefix}-${summary.input.fingerprint.slice(0, 12)}`
    );
  const report = renderReport(summary);
  const extraFiles = profile.operationNormalization
    ? {
        "operations.jsonl": stableJsonl(artifacts.operations),
        "normalization-results.jsonl": stableJsonl(artifacts.normalizationResults),
        "parser-coverage.json": stableJson(artifacts.parserCoverage),
        "fallback-invocations.jsonl": stableJsonl(artifacts.fallbackInvocations),
        ...(profile.operationSchemaVersion === "v2"
          ? {
              "shell-segments.jsonl": stableJsonl(artifacts.shellSegments),
              "layer-coverage.json": stableJson(artifacts.layerCoverage),
            }
          : {}),
        ...(profile.duplicationAnalysis
          ? {
              "exact-duplication-clusters.jsonl": stableJsonl(artifacts.exactDuplicationClusters),
              "shared-target-overlaps.jsonl": stableJsonl(artifacts.sharedTargetOverlaps),
              "sibling-duplication-matrix.json": stableJson(artifacts.siblingDuplicationMatrix),
              "sibling-duplication-matrix.csv": artifacts.siblingDuplicationMatrixCsv,
              "duplication-metrics.json": stableJson(artifacts.duplicationMetrics),
            }
          : {}),
      }
    : {};
  const written = writeAnalysisOutput(args.traceDir, outputDir, summary, report, extraFiles);
  console.log(written);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
