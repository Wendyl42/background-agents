import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTraceBundle } from "../loader.mjs";
import { validateTraceBundle } from "../validator.mjs";
import { buildIntermediateRepresentation } from "../ir.mjs";
import { hashFile, sha256Bytes } from "../hash.mjs";
import { readCampaign, resolveAttempt, validateOutputPath } from "./campaign-input.mjs";
import { buildLedger } from "./invocations.mjs";
import { RULESET_VERSION } from "./classify.mjs";
import { aggregate } from "./aggregate.mjs";
import { writeReport } from "./report.mjs";
import {
  analyzeParentWaits,
  summarizeParentWaits,
  WAIT_ANALYSIS_VERSION,
} from "./wait-timeline.mjs";
import { writeWaitReport } from "./wait-report.mjs";

export const ANALYZER_VERSION = "openinspect-time-distribution-v1";
export const DEFAULT_TOP_N = 30;

function sourceHashes() {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const files = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.name.endsWith(".mjs"))
        files.push({ path: relative(root, path), sha256: hashFile(path).sha256 });
    }
  };
  walk(join(root, "lib"));
  files.push({ path: "time-cli.mjs", sha256: hashFile(join(root, "time-cli.mjs")).sha256 });
  return files;
}

export function analyzeCampaign(runPath, outputPath, options = {}) {
  const topN = options.topN ?? DEFAULT_TOP_N;
  if (!Number.isSafeInteger(topN) || topN < 1) throw new Error("topN must be a positive integer");
  const campaign = readCampaign(runPath, options);
  const output = validateOutputPath(outputPath, campaign);
  const attempts = [];
  const rows = [];
  const waitAnalyses = [];
  const roots = new Set();
  const sessionIds = new Set();
  for (const planned of campaign.run.attempts) {
    let entry = {
      attemptId: planned.attemptId,
      taskId: planned.taskId,
      benchmark: campaign.tasks.get(planned.taskId)?.benchmark ?? "unknown",
    };
    try {
      const input = resolveAttempt(campaign, planned);
      entry = {
        ...entry,
        ...input.context,
        attemptPath: input.path,
        attemptHash: input.attemptHash,
        bundleDir: input.bundleDir,
        manifestHash: input.manifestHash,
      };
      const bundle = loadTraceBundle(input.bundleDir);
      const validation = validateTraceBundle(bundle);
      const root = validation.rootSessionIds[0];
      if (input.attempt.rootSessionId !== root)
        throw new Error("Attempt root session does not match trace");
      if (roots.has(root) || bundle.sessions.some((s) => sessionIds.has(s.id)))
        throw new Error("Duplicate trace/session identity across planned attempts");
      const ir = buildIntermediateRepresentation(bundle, validation);
      const ledger = buildLedger(ir, input.context, input.bundleDir);
      const waitAnalysis = options.waitTimeline
        ? analyzeParentWaits(bundle, ledger, input.context)
        : null;
      roots.add(root);
      for (const session of bundle.sessions) sessionIds.add(session.id);
      rows.push(...ledger);
      if (waitAnalysis) waitAnalyses.push(waitAnalysis);
      entry = {
        ...entry,
        disposition: "included",
        rootSessionId: root,
        inputFingerprint: bundle.inputFingerprint,
        verifiedFileCount: bundle.verifiedFiles.length,
        validationWarnings: validation.warnings,
      };
    } catch (error) {
      entry = {
        ...entry,
        disposition: "excluded",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    attempts.push(entry);
    options.onProgress?.(entry);
  }
  const code = sourceHashes();
  const manifest = {
    analyzerVersion: ANALYZER_VERSION,
    rulesetVersion: RULESET_VERSION,
    analyzerSourceHash: sha256Bytes(JSON.stringify(code)),
    analyzerSourceFiles: code,
    campaignId: campaign.run.runId,
    ...campaign.provenance,
    parameters: {
      topN,
      traceName: options.traceName ?? null,
      oldRunsRoot: options.oldRunsRoot ?? null,
      runsRoot: options.runsRoot ?? null,
    },
    attempts,
  };
  const metrics = aggregate(rows, attempts);
  const waitSummary = options.waitTimeline ? summarizeParentWaits(waitAnalyses, attempts) : null;
  if (waitSummary) {
    manifest.waitAnalysisVersion = WAIT_ANALYSIS_VERSION;
    manifest.parameters.waitTimeline = true;
  }
  mkdirSync(output, { recursive: true });
  writeReport(output, manifest, rows, metrics, topN);
  if (waitSummary) writeWaitReport(output, waitAnalyses, waitSummary);
  return { output, manifest, metrics, waitSummary };
}
