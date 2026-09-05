#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTraceCollection, DEFAULT_BATCH_PROFILE } from "./lib/batch/analyze.mjs";
import { batchArtifactContents, writeBatchOutput } from "./lib/batch/output.mjs";
import { renderBatchReport } from "./lib/batch/report.mjs";
import { getAnalysisProfile } from "./lib/constants.mjs";

const TOOL_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PROJECT_ROOT = resolve(TOOL_DIR, "../..");

function usage(error) {
  if (error) console.error(`Error: ${error}\n`);
  console.error(`Usage:
  node tools/openinspect-trace-analysis/batch-cli.mjs <trace-collection> [--profile <id>] [--out <directory>] [--cache <directory>]

Default profile: block-d0-v1.
`);
  process.exit(error ? 1 : 0);
}

function parseArgs(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") usage();
  if (!argv[0] || argv[0].startsWith("--")) usage("Trace collection path is required");
  const parsed = {
    collectionRoot: resolve(argv[0]),
    profileId: DEFAULT_BATCH_PROFILE,
    outputDir: null,
    cacheDir: resolve(PROJECT_ROOT, "analysis/openinspect/batch-cache"),
  };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--profile") {
      if (!value || value.startsWith("--")) usage("--profile requires an ID");
      getAnalysisProfile(value);
      parsed.profileId = value;
      index += 1;
    } else if (flag === "--out") {
      if (!value || value.startsWith("--")) usage("--out requires a directory");
      parsed.outputDir = resolve(value);
      index += 1;
    } else if (flag === "--cache") {
      if (!value || value.startsWith("--")) usage("--cache requires a directory");
      parsed.cacheDir = resolve(value);
      index += 1;
    } else {
      usage(`Unknown argument: ${flag}`);
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const batch = analyzeTraceCollection(args.collectionRoot, {
    profileId: args.profileId,
    cacheDir: args.cacheDir,
  });
  const report = renderBatchReport(batch);
  const artifacts = batchArtifactContents({ ...batch, report });
  const outputDir =
    args.outputDir ??
    resolve(
      PROJECT_ROOT,
      "analysis/openinspect/batches",
      `${args.profileId}-${batch.batchFingerprint.slice(0, 12)}`
    );
  const written = writeBatchOutput(outputDir, artifacts);
  console.log(
    JSON.stringify({
      outputDir: written.outputDir,
      reusedBatchOutput: written.reused,
      batchFingerprint: batch.batchFingerprint,
      successfulRuns: batch.runs.length,
      failures: batch.failures.length,
      cacheHits: batch.execution.cacheHits,
      cacheMisses: batch.execution.cacheMisses,
    })
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
