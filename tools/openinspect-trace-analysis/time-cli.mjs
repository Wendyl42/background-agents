#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeCampaign } from "./lib/time/analyze.mjs";

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    process.stdout.write(
      "Usage: node tools/openinspect-trace-analysis/time-cli.mjs RUN_JSON --out EMPTY_DIR [--wait-timeline] [--top N] [--trace trace-001] [--old-runs-root OLD --runs-root NEW]\n"
    );
    return 0;
  }
  const [runPath, ...flags] = argv;
  if (!runPath || runPath.startsWith("--"))
    throw new Error("A final campaign run.json is required");
  const options = {};
  let output;
  const names = {
    "--top": "topN",
    "--trace": "traceName",
    "--old-runs-root": "oldRunsRoot",
    "--runs-root": "runsRoot",
  };
  const seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    const key = flags[i];
    if (key === "--wait-timeline") {
      if (seen.has(key)) throw new Error(`Repeated option: ${key}`);
      seen.add(key);
      options.waitTimeline = true;
      continue;
    }
    const value = flags[i + 1];
    if ((!names[key] && key !== "--out") || !value || value.startsWith("--") || seen.has(key))
      throw new Error(`Invalid or repeated option: ${key}`);
    seen.add(key);
    if (key === "--out") output = value;
    else options[names[key]] = key === "--top" ? Number(value) : value;
    i++;
  }
  if (!output) throw new Error("--out is required (new or empty directory outside source runs)");
  const result = analyzeCampaign(runPath, output, {
    ...options,
    onProgress: (a) =>
      process.stderr.write(`${a.attemptId}: ${a.disposition}${a.error ? ` (${a.error})` : ""}\n`),
  });
  process.stdout.write(`${result.output}/report.md\n`);
  return result.manifest.attempts.some((a) => a.disposition !== "included") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
