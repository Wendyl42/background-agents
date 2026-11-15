import { resolve, dirname, join, basename } from "node:path";
import { mkdirSync, existsSync, writeFileSync, renameSync, rmSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeProcessBundle, aggregateProcessReports } from "./analyze.mjs";
import { processMarkdown, renderProcessHtml, csv } from "./report.mjs";
import { stableJson, stableJsonl } from "../json.mjs";
import { isPathInside } from "../loader.mjs";
import { hashFile } from "../hash.mjs";

function realProspectivePath(path) {
  let ancestor = resolve(path);
  const parts = [];
  while (!existsSync(ancestor)) {
    parts.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return resolve(realpathSync(ancestor), ...parts);
}

export function writeProcessAnalysis(inputPaths, outputPath) {
  const output = resolve(outputPath);
  if (existsSync(output)) throw new Error("Analysis output already exists");
  if (inputPaths.some((input) => isPathInside(realpathSync(input), realProspectivePath(output))))
    throw new Error("Analysis output must be outside input bundles");
  const reports = inputPaths.map(analyzeProcessBundle);
  if (new Set(reports.map((r) => r.input.fingerprint)).size !== reports.length)
    throw new Error("Duplicate input bundle");
  const aggregate = aggregateProcessReports(reports);
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const sourceFiles = [
    "analyze.mjs",
    "math.mjs",
    "output.mjs",
    "report.mjs",
    "../loader.mjs",
    "../validator.mjs",
    "../hash.mjs",
    "../json.mjs",
    "../../../../scripts/lib/execution-trace.mjs",
  ];
  const sourceHashes = Object.fromEntries(
    sourceFiles.map((name) => [name, hashFile(resolve(moduleDir, name)).sha256])
  );
  const contextual = (key) =>
    reports.flatMap((r) =>
      r[key].map((row) => ({
        task_id: r.input.root_session_id,
        input_fingerprint: r.input.fingerprint,
        ...row,
      }))
    );
  const summary = {
    schema_version: "openinspect-process-analysis-v1",
    profile: "process-v1",
    analysis_source_hashes: sourceHashes,
    aggregate,
    tasks: reports.map((r) => ({
      input: r.input,
      status: r.status,
      analysis_complete: r.analysis_complete ?? false,
      quality: r.quality,
      issues: r.issues,
      summary: r.summary,
      coordination: r.coordination,
      session_tree: r.session_tree,
    })),
  };
  const files = {
    "summary.json": stableJson(summary),
    "report.md": processMarkdown(reports, aggregate),
    "timeline.html": renderProcessHtml(reports, aggregate),
    ...Object.fromEntries(
      ["tools", "processes", "stages", "groups", "coverage", "candidates"].map((key) => [
        key + ".jsonl",
        stableJsonl(contextual(key)),
      ])
    ),
    "stages.csv": csv(contextual("stages"), [
      "task_id",
      "input_fingerprint",
      "id",
      "process_id",
      "group_id",
      "executable",
      "kind",
      "clock_id",
      "start_ns",
      "end_ns",
      "duration_ns",
      "cpu_runtime_ns",
      "user_cpu_ns",
      "system_cpu_ns",
      "sources",
    ]),
    "groups.csv": csv(contextual("groups"), [
      "task_id",
      "input_fingerprint",
      "id",
      "executable",
      "elapsed_ns",
      "self_cpu",
      "complete",
      "member_process_ids",
      "sources",
    ]),
    "candidates.csv": csv(contextual("candidates"), [
      "task_id",
      "id",
      "kind",
      "count",
      "candidate_elapsed",
      "candidate_cpu",
      "group_ids",
      "sources",
    ]),
    "checkpoint.json": stableJson({
      profile: "process-v1",
      input_fingerprints: reports.map((r) => r.input.fingerprint),
    }),
  };
  const partial = output + ".partial";
  if (existsSync(partial)) throw new Error("Partial analysis output already exists");
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(partial, { mode: 0o700 });
  try {
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(partial, name), content, { mode: 0o600, flag: "wx" });
    const hashes = Object.keys(files)
      .sort()
      .map((path) => ({ path, ...hashFile(join(partial, path)) }));
    writeFileSync(
      join(partial, "output-hashes.json"),
      stableJson({ algorithm: "sha256", files: hashes }),
      { mode: 0o600 }
    );
    renameSync(partial, output);
    return output;
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}
