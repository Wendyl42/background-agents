import { getAnalysisProfile } from "./constants.mjs";
import { computeConcurrency } from "./concurrency.mjs";
import { analyzeStrictObservedDuplication } from "./duplication.mjs";
import { buildIntermediateRepresentation } from "./ir.mjs";
import { computeLifecycle } from "./lifecycle.mjs";
import { loadTraceBundle } from "./loader.mjs";
import { normalizeInvocations } from "./normalization/engine.mjs";
import { createRuleRegistryForProfile } from "./normalization/ruleset.mjs";
import { computeTopology } from "./topology.mjs";
import { validateTraceBundle } from "./validator.mjs";

export const BLOCK_AB_CHECKPOINT = {
  contract: { block: "A", status: "complete" },
  deterministicCore: { block: "B", status: "complete" },
  implemented: [
    "immutable bundle loading and sha256 verification",
    "structural and completeness validation",
    "tool-invocation intermediate representation",
    "topology metrics",
    "lifecycle metrics",
    "message/setup/tool concurrency sweep",
    "deterministic summary and Markdown report",
  ],
  intentionallyExcluded: [
    "normalized-operation rules",
    "semantic action or episode segmentation",
    "redundancy candidates",
    "eliminability judgments",
    "batch aggregation",
    "LLM parsing or numerical analysis",
  ],
  nextSteps: [
    "Review parser coverage requirements from the two real traces.",
    "Implement a versioned rule registry and deterministic normalized-operation schema in Block C.",
    "Add evidence-linked exact and structural redundancy candidates only after rule outputs are reviewed.",
  ],
};

export const BLOCK_C_CHECKPOINT = {
  contract: { block: "C", status: "foundation_complete" },
  deterministicCore: { block: "B", status: "preserved" },
  implemented: [
    "explicit analysis profiles with block-ab-v0 compatibility",
    "versioned NormalizedOperation schema",
    "versioned deterministic rule registry",
    "filesystem-specific rules for read/glob/grep/write",
    "conservative syntactic shell segmentation",
    "per-invocation normalization results and parser coverage",
    "deterministic operation and fallback artifacts",
  ],
  intentionallyExcluded: [
    "pnpm/npm/git semantic rules",
    "semantic action or episode grouping",
    "redundancy candidates or clustering",
    "eliminability judgments",
    "batch discovery or aggregation",
    "LLM parsing or numerical analysis",
  ],
  nextSteps: [
    "Manually review normalized operations from both real traces.",
    "Correct any deterministic misparses before adding domain-specific rules.",
    "Add the next rule only with a fixture, version, coverage impact, and evidence review.",
    "Do not implement redundancy candidates until normalized operations are accepted.",
  ],
};

export const BLOCK_C_V1_CHECKPOINT = {
  contract: { block: "C.1", status: "identity_hardening_complete" },
  deterministicCore: { block: "B", status: "preserved" },
  implemented: [
    "explicit block-c-v1 profile with block-ab-v0/block-c-v0 compatibility",
    "bounded normalized operation parameters included in deterministic identity",
    "read selector fingerprints",
    "write and edit content identities without plaintext",
    "deterministic child coordination request rules without outcome parsing",
  ],
  intentionallyExcluded: [
    "pnpm/npm/git semantic rules",
    "semantic action or episode grouping",
    "redundancy candidates or clustering",
    "eliminability judgments",
    "batch discovery or aggregation",
    "LLM parsing or numerical analysis",
  ],
  nextSteps: [
    "Manually accept block-c-v1 operations from both real traces.",
    "Only then consider versioned package-manager semantic rules.",
    "Do not treat input fingerprints as semantic equivalence or redundancy.",
  ],
};

export const BLOCK_C_V2_CHECKPOINT = {
  contract: { block: "C.2", status: "package_command_foundation_complete" },
  deterministicCore: { block: "B", status: "preserved" },
  implemented: [
    "explicit block-c-v2 profile preserving all earlier profile bytes",
    "invocation to shell-segment to semantic-command composition",
    "deterministic pnpm and npm command-request rules",
    "invocation, segment, and operation layer coverage with mixed status",
    "first-safe-pipeline-stage semantic parsing with syntactic tail preservation",
    "operation back-links to both invocation and shell segment",
  ],
  intentionallyExcluded: [
    "git, npx, or yarn semantic rules",
    "tool-output execution or success outcome parsing",
    "semantic action or episode grouping",
    "redundancy candidates or clustering",
    "eliminability judgments",
    "batch discovery or aggregation",
    "LLM parsing or numerical analysis",
  ],
  nextSteps: [
    "Manually accept block-c-v2 semantic command operations from both real traces.",
    "Extend only observed high-value command forms in another versioned ruleset.",
    "Do not treat command requests as execution outcomes or redundancy evidence.",
  ],
};

export const BLOCK_D0_CHECKPOINT = {
  contract: { block: "D0", status: "strict_observed_duplication_complete" },
  deterministicCore: { block: "B", status: "preserved" },
  implemented: [
    "independent block-d0-v0 profile over block-c-v2 normalized operations",
    "strict sibling-only specific and syntactic exact duplicate clusters",
    "shared-target overlaps separated from exact duplication",
    "deterministic sibling-pair duplication matrix and metrics",
    "evidence-linked members, signatures, parser versions, and rulesets",
  ],
  intentionallyExcluded: [
    "new semantic parser rules",
    "semantic similarity or episode grouping",
    "finding or result overlap",
    "duration or resource weighting",
    "removability, eliminability, or actionable judgments",
    "batch aggregation",
    "LLM parsing or numerical analysis",
  ],
  nextSteps: [
    "Manually review top strict clusters and shared-target overlaps.",
    "Quantify false-positive categories before relaxing any signature.",
    "Keep removability and actionable claims gated on replay or ablation evidence.",
  ],
};

export const BLOCK_D0_V1_CHECKPOINT = {
  contract: { block: "D0.1", status: "sibling_presence_sensitivity_complete" },
  deterministicCore: { block: "B", status: "preserved" },
  implemented: [
    "independent block-d0-v1 profile preserving D0 v0 and earlier profiles",
    "cluster-level all/cross-sibling/within-sibling excess decomposition",
    "primary sibling-presence ratios after within-sibling signature deduplication",
    "all-instance excess and within-sibling repetition sensitivity metrics",
    "specific stratification by operation kind and parser",
    "separate syntactic sensitivity layer without automatic value labels",
  ],
  intentionallyExcluded: [
    "new parser rules or semantic similarity",
    "finding or result overlap",
    "duration or resource weighting",
    "removability, eliminability, or actionable judgments",
    "batch aggregation",
    "LLM parsing or numerical analysis",
  ],
  nextSteps: [
    "Manually accept sibling-presence denominators and stratum interpretations.",
    "Use presence as the primary strict sibling metric and all-instance excess as sensitivity only.",
    "Keep eliminability gated on replay or ablation evidence.",
  ],
};

function buildBaseSummary(bundle, validation, ir, profile) {
  const topology = computeTopology(ir);
  const lifecycle = computeLifecycle(ir);
  const concurrency = computeConcurrency(ir);
  return {
    analysisSchemaVersion: profile.analysisSchemaVersion,
    input: {
      bundleSchemaVersion: bundle.manifest.schemaVersion,
      fingerprint: bundle.inputFingerprint,
      rootSessionId: bundle.completeness.rootSessionId,
      repository: bundle.manifest.source?.repository ?? null,
      verifiedFileCount: bundle.verifiedFiles.length,
    },
    scope: {
      rawUnit: "tool_invocation",
      normalizedOperationsImplemented: false,
      semanticRedundancyImplemented: false,
      batchAggregationImplemented: false,
      llmUsed: false,
    },
    validation,
    topology,
    lifecycle,
    concurrency,
    operationNormalization: ir.operationNormalization,
    missingness: ir.missingness,
    checkpoint: BLOCK_AB_CHECKPOINT,
  };
}

export function analyzeTraceBundleDetailed(inputPath, { profile: profileId } = {}) {
  const profile = getAnalysisProfile(profileId);
  const bundle = loadTraceBundle(inputPath);
  const validation = validateTraceBundle(bundle);
  const ir = buildIntermediateRepresentation(bundle, validation);
  const baseSummary = buildBaseSummary(bundle, validation, ir, profile);

  if (!profile.operationNormalization) {
    // Do not add profile metadata to block-ab-v0: its exact serialized shape is
    // part of the compatibility contract and is checked byte-for-byte.
    return { profile, summary: baseSummary, artifacts: {} };
  }

  const normalization = normalizeInvocations(
    ir.toolInvocations,
    createRuleRegistryForProfile(profile.id)
  );
  const coverageTotals = normalization.coverage.totals;
  const blockCV2 = profile.operationSchemaVersion === "v2";
  const duplication = profile.duplicationAnalysis
    ? analyzeStrictObservedDuplication({
        rootSessionId: bundle.completeness.rootSessionId,
        sessions: ir.sessions,
        toolInvocations: ir.toolInvocations,
        operations: normalization.operations,
        normalization,
        sensitivityVersion: profile.duplicationSensitivityVersion ?? "v0",
      })
    : null;
  const summary = {
    ...baseSummary,
    analysisProfile: profile.id,
    scope: {
      ...baseSummary.scope,
      normalizedOperationsImplemented: true,
      ...(blockCV2 ? { semanticCommandRequestsImplemented: true } : {}),
      ...(duplication ? { strictObservedDuplicationImplemented: true } : {}),
    },
    operationNormalization: {
      implemented: true,
      rulesetVersion: normalization.rulesetVersion,
      toolInvocationCount: ir.toolInvocations.length,
      normalizedOperationCount: normalization.operations.length,
      parserCoverage: coverageTotals.parsedCoverage.value,
      fallbackCount: coverageTotals.counts.fallback,
      specificCount: coverageTotals.counts.specific,
      ...(blockCV2 ? { mixedCount: coverageTotals.counts.mixed } : {}),
      syntacticCount: coverageTotals.counts.syntactic,
      errorCount: coverageTotals.counts.error,
      usedRules: normalization.usedRules,
      ruleInventory: normalization.ruleInventory,
      ...(blockCV2
        ? {
            semanticRulesetVersion: normalization.coverage.semanticRulesetVersion,
            usedOperationRules: normalization.usedOperationRules,
            semanticRuleInventory: normalization.coverage.semanticRuleInventory,
            shellSegmentCount: normalization.segments.length,
            semanticCommandOperationCount:
              normalization.coverage.layers.operation.counts.semanticCommand,
          }
        : {}),
      note: "Parser coverage describes deterministic normalization only; it is not redundancy.",
    },
    normalization: {
      rulesetVersion: normalization.rulesetVersion,
      usedRules: normalization.usedRules,
      ruleInventory: normalization.ruleInventory,
      totals: coverageTotals,
      coverageDefinitions: normalization.coverage.definitions,
      byTool: normalization.coverage.byTool,
      bySession: normalization.coverage.bySession,
      byParser: normalization.coverage.byParser,
      fallbackToolTopK: normalization.coverage.fallbackToolTopK,
      diagnostics: normalization.coverage.diagnostics,
      ...(blockCV2
        ? {
            semanticRulesetVersion: normalization.coverage.semanticRulesetVersion,
            usedOperationRules: normalization.usedOperationRules,
            semanticRuleInventory: normalization.coverage.semanticRuleInventory,
            layers: normalization.coverage.layers,
          }
        : {}),
    },
    ...(duplication
      ? {
          observedDuplication:
            profile.duplicationSensitivityVersion === "v1"
              ? duplication.metrics
              : {
                  schemaVersion: duplication.schemaVersion,
                  definitions: duplication.metrics.definitions,
                  coverage: duplication.metrics.coverage,
                  specificExactDuplicateInstanceRatio:
                    duplication.metrics.specificExactDuplicateInstanceRatio,
                  syntacticExactDuplicateInstanceRatio:
                    duplication.metrics.syntacticExactDuplicateInstanceRatio,
                  runsWithAtLeastOneExactCluster:
                    duplication.metrics.runsWithAtLeastOneExactCluster,
                  parentsWithAtLeastOneExactCluster:
                    duplication.metrics.parentsWithAtLeastOneExactCluster,
                  clusters: duplication.metrics.clusters,
                  siblingPairs: duplication.metrics.siblingPairs,
                  sharedTargetOverlap: duplication.metrics.sharedTargetOverlap,
                  topExactClusters: duplication.metrics.topExactClusters,
                  topSharedTargetOverlaps: duplication.metrics.topSharedTargetOverlaps,
                },
        }
      : {}),
    checkpoint:
      profile.id === "block-d0-v1"
        ? BLOCK_D0_V1_CHECKPOINT
        : profile.id === "block-d0-v0"
          ? BLOCK_D0_CHECKPOINT
          : profile.id === "block-c-v2"
            ? BLOCK_C_V2_CHECKPOINT
            : profile.id === "block-c-v1"
              ? BLOCK_C_V1_CHECKPOINT
              : BLOCK_C_CHECKPOINT,
  };
  return {
    profile,
    summary,
    artifacts: {
      operations: normalization.operations,
      normalizationResults: normalization.results,
      parserCoverage: normalization.coverage,
      fallbackInvocations: normalization.fallbackInvocations,
      ...(blockCV2
        ? {
            shellSegments: normalization.segments,
            layerCoverage: normalization.coverage.layers,
          }
        : {}),
      ...(duplication
        ? {
            exactDuplicationClusters: duplication.clusters,
            sharedTargetOverlaps: duplication.sharedTargetOverlaps,
            siblingDuplicationMatrix: duplication.matrix,
            siblingDuplicationMatrixCsv: duplication.matrixCsv,
            duplicationMetrics: duplication.metrics,
          }
        : {}),
    },
  };
}

export function analyzeTraceBundle(inputPath, options = {}) {
  return analyzeTraceBundleDetailed(inputPath, options).summary;
}
