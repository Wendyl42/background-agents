import { resolve } from "node:path";
import { analyzeTraceBundleDetailed } from "../analyze.mjs";
import { getAnalysisProfile } from "../constants.mjs";
import { sha256Bytes } from "../hash.mjs";
import { stableJson } from "../json.mjs";
import { loadTraceBundle } from "../loader.mjs";
import { canonicalJson } from "../normalization/inputs.mjs";
import { aggregateBatchRuns } from "./aggregate.mjs";
import { batchCacheKey, readBatchCache, writeBatchCache } from "./cache.mjs";
import { discoverTraceBundles } from "./discovery.mjs";

export const BATCH_MANIFEST_SCHEMA_VERSION = "openinspect-trace-batch-manifest-e0-v0";
export const BATCH_RUN_SCHEMA_VERSION = "openinspect-trace-batch-run-e0-v0";
export const DEFAULT_BATCH_PROFILE = "block-d0-v1";

export function batchProfileIdentity(profileId) {
  const profile = getAnalysisProfile(profileId);
  return {
    profileId: profile.id,
    analysisSchemaVersion: profile.analysisSchemaVersion,
    operationSchemaVersion: profile.operationSchemaVersion ?? null,
    rulesetVersion: profile.rulesetVersion ?? null,
    semanticRulesetVersion: profile.semanticRulesetVersion ?? null,
    duplicationSchemaVersion: profile.duplicationSchemaVersion ?? null,
  };
}

function metric(value) {
  return value && Number.isFinite(value.value)
    ? { numerator: value.numerator, denominator: value.denominator, value: value.value }
    : null;
}

function extractRunMetrics(summary) {
  const duplication = summary.observedDuplication;
  const invocationParsed =
    summary.normalization?.layers?.invocation?.totals?.parsedCoverage ??
    summary.normalization?.totals?.parsedCoverage ??
    null;
  const shellSemantic = summary.normalization?.layers?.segment?.semanticReach ?? null;
  const fallbackCount = summary.operationNormalization?.fallbackCount;
  const invocationCount = summary.operationNormalization?.toolInvocationCount;
  const fallbackRate =
    Number.isFinite(fallbackCount) && Number.isFinite(invocationCount)
      ? {
          numerator: fallbackCount,
          denominator: invocationCount,
          value: invocationCount ? fallbackCount / invocationCount : 0,
        }
      : null;
  return {
    specificSiblingPresenceRatio: metric(duplication?.specificSiblingPresenceDuplicateRatio),
    syntacticSiblingPresenceRatio: metric(duplication?.syntacticSiblingPresenceDuplicateRatio),
    specificAllInstanceExcessSensitivity: metric(
      duplication?.specificAllInstanceExcessSensitivity ??
        duplication?.specificExactDuplicateInstanceRatio
    ),
    syntacticAllInstanceExcessSensitivity: metric(
      duplication?.syntacticAllInstanceExcessSensitivity ??
        duplication?.syntacticExactDuplicateInstanceRatio
    ),
    specificWithinSiblingRepetitionRatio: metric(duplication?.specificWithinSiblingRepetitionRatio),
    syntacticWithinSiblingRepetitionRatio: metric(
      duplication?.syntacticWithinSiblingRepetitionRatio
    ),
    invocationParsedCoverage: metric(invocationParsed),
    shellSegmentSemanticReach: metric(shellSemantic),
    fallbackInvocationRate: metric(fallbackRate),
  };
}

function runRecord({ candidate, bundle, summary, profileIdentity, cacheKey }) {
  return {
    schemaVersion: BATCH_RUN_SCHEMA_VERSION,
    runId: summary.input.rootSessionId,
    relativePath: candidate.relativePath,
    inputFingerprint: bundle.inputFingerprint,
    repository: summary.input.repository,
    analysisProfile: profileIdentity.profileId,
    analysisSchemaVersion: profileIdentity.analysisSchemaVersion,
    cacheKey,
    cacheIdentity: {
      inputFingerprint: bundle.inputFingerprint,
      ...profileIdentity,
    },
    summarySha256: sha256Bytes(Buffer.from(stableJson(summary))),
    counts: {
      sessions: summary.validation.counts.sessions,
      messages: summary.validation.counts.messages,
      events: summary.validation.counts.events,
      toolInvocations: summary.operationNormalization.toolInvocationCount,
      normalizedOperations: summary.operationNormalization.normalizedOperationCount,
      fallbackInvocations: summary.operationNormalization.fallbackCount,
    },
    parserEvidence: {
      usedRules: summary.normalization?.usedRules ?? [],
      usedOperationRules: summary.normalization?.usedOperationRules ?? [],
    },
    metrics: extractRunMetrics(summary),
  };
}

function failureRecord(candidate, stage, code, message, details = {}) {
  const identity = {
    relativePath: candidate.relativePath,
    stage,
    code,
    message,
    details,
  };
  return {
    schemaVersion: BATCH_RUN_SCHEMA_VERSION,
    failureId: `failure_${sha256Bytes(Buffer.from(canonicalJson(identity))).slice(0, 32)}`,
    ...identity,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function analyzeTraceCollection(
  collectionRoot,
  {
    profileId = DEFAULT_BATCH_PROFILE,
    cacheDir,
    excludedRoots = [],
    analyzeRun = analyzeTraceBundleDetailed,
  } = {}
) {
  if (!cacheDir) throw new Error("Batch cacheDir is required");
  const profileIdentity = batchProfileIdentity(profileId);
  const discovery = discoverTraceBundles(collectionRoot, {
    excludedRoots: [resolve(cacheDir), ...excludedRoots],
  });
  const batchFingerprint = sha256Bytes(
    Buffer.from(
      canonicalJson({
        schemaVersion: BATCH_MANIFEST_SCHEMA_VERSION,
        collectionRoot: discovery.root,
        profileIdentity,
        candidates: discovery.candidates.map((candidate) => ({
          relativePath: candidate.relativePath,
          trustAnchorFingerprint: candidate.trustAnchorFingerprint,
        })),
      })
    )
  );
  const runs = [];
  const failures = [];
  const rootOwners = new Map();
  const fingerprintOwners = new Map();
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const candidate of discovery.candidates) {
    let bundle;
    try {
      bundle = loadTraceBundle(candidate.path);
    } catch (error) {
      failures.push(
        failureRecord(candidate, "validation", "bundle_load_failed", errorMessage(error))
      );
      continue;
    }
    const rootSessionId = bundle.completeness.rootSessionId;
    if (rootOwners.has(rootSessionId)) {
      failures.push(
        failureRecord(candidate, "deduplication", "duplicate_root_session_id", rootSessionId, {
          duplicateOf: rootOwners.get(rootSessionId),
        })
      );
      continue;
    }
    if (fingerprintOwners.has(bundle.inputFingerprint)) {
      failures.push(
        failureRecord(
          candidate,
          "deduplication",
          "duplicate_input_fingerprint",
          bundle.inputFingerprint,
          { duplicateOf: fingerprintOwners.get(bundle.inputFingerprint) }
        )
      );
      continue;
    }
    rootOwners.set(rootSessionId, candidate.relativePath);
    fingerprintOwners.set(bundle.inputFingerprint, candidate.relativePath);

    const cacheIdentity = { inputFingerprint: bundle.inputFingerprint, ...profileIdentity };
    const cacheKey = batchCacheKey(cacheIdentity);
    try {
      const cached = readBatchCache(cacheDir, cacheKey, cacheIdentity);
      if (cached) {
        cacheHits += 1;
        runs.push({ ...cached, relativePath: candidate.relativePath });
        continue;
      }
      cacheMisses += 1;
      const analyzed = analyzeRun(candidate.path, { profile: profileId });
      if (
        analyzed.summary.input.fingerprint !== bundle.inputFingerprint ||
        analyzed.summary.input.rootSessionId !== rootSessionId
      ) {
        throw new Error("Per-run analysis identity disagrees with validated bundle");
      }
      const run = runRecord({
        candidate,
        bundle,
        summary: analyzed.summary,
        profileIdentity,
        cacheKey,
      });
      writeBatchCache(cacheDir, cacheKey, cacheIdentity, run);
      runs.push(run);
    } catch (error) {
      failures.push(
        failureRecord(candidate, "analysis", "run_analysis_failed", errorMessage(error))
      );
    }
  }

  runs.sort(
    (left, right) =>
      left.relativePath.localeCompare(right.relativePath) || left.runId.localeCompare(right.runId)
  );
  failures.sort(
    (left, right) =>
      left.relativePath.localeCompare(right.relativePath) ||
      left.stage.localeCompare(right.stage) ||
      left.failureId.localeCompare(right.failureId)
  );
  const aggregate = aggregateBatchRuns({ profileIdentity, runs, failures, batchFingerprint });
  const manifest = {
    schemaVersion: BATCH_MANIFEST_SCHEMA_VERSION,
    batchFingerprint,
    collectionRoot: discovery.root,
    profileIdentity,
    discovery: {
      recursive: true,
      requiredTrustAnchors: ["manifest.json", "hashes.json"],
      symlinkDirectoriesFollowed: false,
      analysisDirectoriesExcluded: true,
      deterministicOrder: "relativePath ascending",
      candidateCount: discovery.candidates.length,
      candidates: discovery.candidates.map((candidate) => ({
        relativePath: candidate.relativePath,
        trustAnchorFingerprint: candidate.trustAnchorFingerprint,
      })),
    },
    successfulRunCount: runs.length,
    failureCount: failures.length,
    runIds: runs.map((run) => run.runId),
    failureIds: failures.map((failure) => failure.failureId),
    aggregation: {
      statisticalUnit: "run",
      denominatorPooling: "not_performed",
      confidenceIntervals: "not_computed",
    },
  };
  return {
    batchFingerprint,
    profileIdentity,
    manifest,
    runs,
    failures,
    aggregate,
    execution: { cacheHits, cacheMisses },
  };
}
