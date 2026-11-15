import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readJson } from "../json.mjs";
import { hashFile } from "../hash.mjs";

export function contained(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function component(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value))
    throw new Error("Invalid run/attempt/trace identifier");
  return value;
}

export function readCampaign(runPath, { oldRunsRoot, runsRoot, traceName } = {}) {
  if (Boolean(oldRunsRoot) !== Boolean(runsRoot))
    throw new Error("Use --old-runs-root and --runs-root together");
  if (traceName) component(traceName);
  const runFile = realpathSync(resolve(runPath));
  const runDir = dirname(runFile);
  const run = readJson(runFile);
  component(run.runId);
  if (basename(runDir) !== run.runId) throw new Error("Run ID does not match its directory");
  if (!Array.isArray(run.attempts)) throw new Error("run.json must contain attempts[]");
  const tasksFile = join(runDir, "tasks.json");
  const taskList = readJson(tasksFile);
  if (!Array.isArray(taskList)) throw new Error("tasks.json must contain an array");
  const tasks = new Map(
    taskList.map((t) => {
      const id = t.benchmark === "cooperbench" ? t.id : t.taskId;
      if (typeof id !== "string" || !id)
        throw new Error("Missing task identity for benchmark schema");
      return [id, t];
    })
  );
  if (tasks.size !== taskList.length) throw new Error("Duplicate task identity");
  const ids = new Set();
  for (const a of run.attempts) {
    component(a.attemptId);
    if (ids.has(a.attemptId)) throw new Error(`Duplicate planned attempt: ${a.attemptId}`);
    ids.add(a.attemptId);
  }
  const root = realpathSync(resolve(runsRoot ?? dirname(runDir)));
  if (!contained(root, runDir)) throw new Error("Campaign directory is outside runs root");
  const remap = (path) => {
    if (!isAbsolute(path)) throw new Error("Source reference must be absolute");
    if (!oldRunsRoot) return path;
    if (!contained(oldRunsRoot, path))
      throw new Error("Source reference is outside --old-runs-root");
    return resolve(root, relative(resolve(oldRunsRoot), path));
  };
  return {
    runFile,
    runDir,
    run,
    tasks,
    root,
    traceName,
    remap,
    provenance: {
      runFile,
      runHash: hashFile(runFile).sha256,
      tasksFile,
      tasksHash: hashFile(tasksFile).sha256,
    },
  };
}

export function resolveAttempt(campaign, planned) {
  const inherited = campaign.run.inheritedAttempts?.[planned.attemptId];
  const path = inherited
    ? campaign.remap(inherited.path)
    : join(campaign.runDir, "attempts", planned.attemptId, "attempt.json");
  if (!contained(campaign.root, path) || !contained(campaign.root, realpathSync(path)))
    throw new Error("Attempt reference escapes runs root");
  const attemptHash = hashFile(path).sha256;
  if (inherited && inherited.sha256 !== attemptHash)
    throw new Error("Inherited attempt hash mismatch");
  const attempt = readJson(path);
  const attemptDir = dirname(path);
  const sourceRunId = basename(dirname(dirname(attemptDir)));
  if (
    basename(path) !== "attempt.json" ||
    basename(dirname(attemptDir)) !== "attempts" ||
    basename(attemptDir) !== planned.attemptId ||
    attempt.attemptId !== planned.attemptId ||
    attempt.taskId !== planned.taskId ||
    attempt.runId !== sourceRunId ||
    (planned.repetition !== undefined && attempt.repetition !== planned.repetition)
  )
    throw new Error("Attempt identity mismatch");
  const task = campaign.tasks.get(planned.taskId);
  if (!task || !["featurebench", "cooperbench"].includes(task.benchmark))
    throw new Error("Missing or unsupported task benchmark");
  let bundleDir;
  if (campaign.traceName) bundleDir = join(attemptDir, campaign.traceName);
  else if (attempt.trace?.path) bundleDir = campaign.remap(attempt.trace.path);
  else {
    const candidates = readdirSync(attemptDir).filter((name) => /^trace-\d+$/.test(name));
    if (candidates.length !== 1)
      throw new Error("Select a trace explicitly: absent or ambiguous trace exports");
    bundleDir = join(attemptDir, candidates[0]);
  }
  if (
    !contained(attemptDir, bundleDir) ||
    !contained(realpathSync(attemptDir), realpathSync(bundleDir))
  )
    throw new Error("Trace reference escapes attempt");
  const manifestHash = hashFile(join(bundleDir, "manifest.json")).sha256;
  if (
    !campaign.traceName &&
    attempt.trace?.manifestSha256 &&
    manifestHash !== attempt.trace.manifestSha256
  )
    throw new Error("Trace manifest hash mismatch");
  return {
    path,
    attemptDir,
    attemptHash,
    sourceRunId,
    attempt,
    bundleDir,
    manifestHash,
    context: {
      campaignId: campaign.run.runId,
      sourceRunId,
      attemptId: planned.attemptId,
      taskId: planned.taskId,
      benchmark: task.benchmark,
      repetition: planned.repetition ?? null,
      modelExecution: attempt.modelExecution ?? "unknown",
      scoringStatus: attempt.benchmarkCorrectness?.status ?? attempt.scoring?.status ?? "unknown",
    },
  };
}

export function validateOutputPath(outputPath, campaign) {
  const output = resolve(outputPath);
  // Resolve existing ancestors so a symlink cannot redirect output into source data.
  let ancestor = output;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), relative(ancestor, output));
  if (contained(campaign.root, actual) || contained(actual, campaign.root))
    throw new Error("Output must be outside the source runs tree");
  if (
    existsSync(output) &&
    (lstatSync(output).isSymbolicLink() ||
      !lstatSync(output).isDirectory() ||
      readdirSync(output).length)
  )
    throw new Error("Output must be a new or empty directory");
  return output;
}
