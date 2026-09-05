import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { analyzeTraceBundle, analyzeTraceBundleDetailed } from "../lib/analyze.mjs";
import { loadTraceBundle } from "../lib/loader.mjs";

const TRACE_A = resolve(
  "traces/openinspect/2026-08-19-template-typescript-monorepo-security-audit-4fd2789a"
);
const TRACE_B = resolve(
  "traces/openinspect/1c929e3aed7c97b57563c73e242e603a-2026-08-20T05-38-31-813Z"
);

function listedFileDigests(path) {
  const bundle = loadTraceBundle(path);
  return bundle.verifiedFiles.map((entry) => `${entry.path}:${entry.sha256}`);
}

test(
  "first real trace reproduces the manually checked Block A + B facts",
  { skip: !existsSync(TRACE_A) },
  () => {
    const before = listedFileDigests(TRACE_A);
    const summary = analyzeTraceBundle(TRACE_A);
    const after = listedFileDigests(TRACE_A);
    assert.deepEqual(after, before);
    assert.deepEqual(summary.validation.counts, { sessions: 8, events: 439, messages: 8 });
    assert.equal(summary.topology.rootOutDegree, 7);
    assert.equal(summary.topology.maxSpawnDepth, 1);
    assert.equal(summary.concurrency.childMessageExecutions.peakConcurrentSessions, 5);
    assert.equal(summary.concurrency.allMessageExecutions.peakConcurrentSessions, 6);
    assert.equal(summary.concurrency.childPlatformSetup.peakConcurrentIntervals, 5);
    assert.equal(summary.concurrency.childToolInvocations.peakConcurrentIntervals, 7);
    assert.equal(summary.concurrency.childToolInvocations.peakConcurrentSessions, 4);
  }
);

test(
  "first real trace block-c-v0 normalization checkpoint is deterministic",
  {
    skip: !existsSync(TRACE_A),
  },
  () => {
    const before = listedFileDigests(TRACE_A);
    const analyzed = analyzeTraceBundleDetailed(TRACE_A, { profile: "block-c-v0" });
    assert.deepEqual(listedFileDigests(TRACE_A), before);
    assert.equal(analyzed.summary.operationNormalization.toolInvocationCount, 407);
    assert.equal(analyzed.artifacts.operations.length, 794);
    assert.deepEqual(analyzed.summary.normalization.totals.counts, {
      total: 407,
      specific: 133,
      syntactic: 223,
      fallback: 51,
      error: 0,
    });
    assert.equal(
      analyzed.summary.normalization.diagnostics.find((item) => item.code === "pipeline_preserved")
        ?.count,
      140
    );
  }
);

test(
  "second real trace block-c-v0 normalization checkpoint is deterministic",
  {
    skip: !existsSync(TRACE_B),
  },
  () => {
    const before = listedFileDigests(TRACE_B);
    const analyzed = analyzeTraceBundleDetailed(TRACE_B, { profile: "block-c-v0" });
    assert.deepEqual(listedFileDigests(TRACE_B), before);
    assert.equal(analyzed.summary.operationNormalization.toolInvocationCount, 911);
    assert.equal(analyzed.artifacts.operations.length, 1_233);
    assert.deepEqual(analyzed.summary.normalization.totals.counts, {
      total: 911,
      specific: 261,
      syntactic: 458,
      fallback: 192,
      error: 0,
    });
    assert.equal(
      analyzed.summary.normalization.diagnostics.find((item) => item.code === "pipeline_preserved")
        ?.count,
      316
    );
  }
);

test(
  "first real trace block-c-v1 identity checkpoint preserves raw evidence",
  { skip: !existsSync(TRACE_A) },
  () => {
    const before = listedFileDigests(TRACE_A);
    const analyzed = analyzeTraceBundleDetailed(TRACE_A, { profile: "block-c-v1" });
    assert.deepEqual(listedFileDigests(TRACE_A), before);
    assert.equal(analyzed.artifacts.operations.length, 814);
    assert.deepEqual(analyzed.summary.normalization.totals.counts, {
      total: 407,
      specific: 153,
      syntactic: 223,
      fallback: 31,
      error: 0,
    });
    assert.equal(
      analyzed.artifacts.operations.filter(
        (operation) =>
          operation.parserId === "filesystem.read" &&
          (operation.parameters.selector.offset.present ||
            operation.parameters.selector.limit.present)
      ).length,
      18
    );
  }
);

test(
  "second real trace block-c-v1 identity checkpoint preserves raw evidence",
  { skip: !existsSync(TRACE_B) },
  () => {
    const before = listedFileDigests(TRACE_B);
    const analyzed = analyzeTraceBundleDetailed(TRACE_B, { profile: "block-c-v1" });
    assert.deepEqual(listedFileDigests(TRACE_B), before);
    assert.equal(analyzed.artifacts.operations.length, 1_364);
    assert.deepEqual(analyzed.summary.normalization.totals.counts, {
      total: 911,
      specific: 392,
      syntactic: 458,
      fallback: 61,
      error: 0,
    });
    assert.equal(
      analyzed.artifacts.operations.filter((operation) => operation.parserId === "filesystem.edit")
        .length,
      95
    );
  }
);

function semanticParserCount(analyzed, parserId) {
  return analyzed.artifacts.operations.filter((operation) => operation.parserId === parserId)
    .length;
}

test(
  "first real trace block-c-v2 package-command checkpoint preserves raw evidence",
  { skip: !existsSync(TRACE_A) },
  () => {
    const before = listedFileDigests(TRACE_A);
    const analyzed = analyzeTraceBundleDetailed(TRACE_A, { profile: "block-c-v2" });
    assert.deepEqual(listedFileDigests(TRACE_A), before);
    assert.equal(analyzed.artifacts.operations.length, 814);
    assert.equal(analyzed.artifacts.shellSegments.length, 661);
    assert.deepEqual(analyzed.summary.normalization.layers.invocation.totals.counts, {
      total: 407,
      specific: 157,
      mixed: 106,
      syntactic: 113,
      fallback: 31,
      error: 0,
    });
    assert.deepEqual(analyzed.summary.normalization.layers.segment.counts, {
      total: 661,
      specific: 55,
      mixed: 75,
      syntactic: 531,
      error: 0,
    });
    assert.deepEqual(analyzed.summary.normalization.layers.operation.counts, {
      total: 814,
      semanticCommand: 130,
      specificNonShell: 153,
      syntacticShell: 531,
    });
    assert.equal(semanticParserCount(analyzed, "package-manager.pnpm.install"), 5);
    assert.equal(semanticParserCount(analyzed, "package-manager.pnpm.audit"), 30);
    assert.equal(semanticParserCount(analyzed, "package-manager.pnpm.outdated"), 11);
    assert.equal(semanticParserCount(analyzed, "package-manager.pnpm.licenses"), 18);
    assert.equal(semanticParserCount(analyzed, "package-manager.pnpm.script"), 16);
    assert.equal(semanticParserCount(analyzed, "package-manager.pnpm.exec"), 31);
    assert.equal(semanticParserCount(analyzed, "package-manager.npm.view"), 19);
  }
);

test(
  "second real trace block-c-v2 npm checkpoint preserves raw evidence",
  { skip: !existsSync(TRACE_B) },
  () => {
    const before = listedFileDigests(TRACE_B);
    const analyzed = analyzeTraceBundleDetailed(TRACE_B, { profile: "block-c-v2" });
    assert.deepEqual(listedFileDigests(TRACE_B), before);
    assert.equal(analyzed.artifacts.operations.length, 1_364);
    assert.equal(analyzed.artifacts.shellSegments.length, 972);
    assert.deepEqual(analyzed.summary.normalization.layers.invocation.totals.counts, {
      total: 911,
      specific: 392,
      mixed: 2,
      syntactic: 456,
      fallback: 61,
      error: 0,
    });
    assert.deepEqual(analyzed.summary.normalization.layers.segment.counts, {
      total: 972,
      specific: 1,
      mixed: 1,
      syntactic: 970,
      error: 0,
    });
    assert.deepEqual(analyzed.summary.normalization.layers.operation.counts, {
      total: 1_364,
      semanticCommand: 2,
      specificNonShell: 392,
      syntacticShell: 970,
    });
    assert.equal(semanticParserCount(analyzed, "package-manager.npm.install"), 2);
  }
);

test(
  "first real trace block-d0-v0 strict duplication checkpoint preserves raw evidence",
  { skip: !existsSync(TRACE_A) },
  () => {
    const before = listedFileDigests(TRACE_A);
    const analyzed = analyzeTraceBundleDetailed(TRACE_A, { profile: "block-d0-v0" });
    assert.deepEqual(listedFileDigests(TRACE_A), before);
    const metrics = analyzed.artifacts.duplicationMetrics;
    assert.deepEqual(metrics.coverage, {
      sourceProfile: "block-c-v2",
      operationRulesetVersion: "openinspect-operation-rules-block-c-v2",
      semanticRulesetVersion: "openinspect-package-command-rules-block-c-v2",
      eligibleParentCount: 1,
      eligibleSiblingSessionCount: 7,
      eligibleSpecificOperationCount: 260,
      eligibleSyntacticOperationCount: 516,
      excludedFallbackInvocationCount: 31,
      c2InvocationParsedCoverage: { numerator: 376, denominator: 407, value: 376 / 407 },
      c2ShellSegmentSemanticReach: { numerator: 130, denominator: 661, value: 130 / 661 },
    });
    assert.deepEqual(metrics.clusters, {
      total: 25,
      specificExact: 12,
      syntacticExact: 13,
      specificClusteredInstances: 35,
      syntacticClusteredInstances: 146,
    });
    assert.equal(metrics.specificExactDuplicateInstanceRatio.numerator, 23);
    assert.equal(metrics.syntacticExactDuplicateInstanceRatio.numerator, 133);
    assert.deepEqual(metrics.siblingPairs, {
      totalPairs: 21,
      pairsWithAtLeastOneExactCluster: 18,
      specificExactClusterIncidences: 28,
      syntacticExactClusterIncidences: 35,
    });
    assert.equal(analyzed.artifacts.sharedTargetOverlaps.length, 9);
    assert.ok(
      analyzed.artifacts.exactDuplicationClusters.every(
        (cluster) => cluster.distinctSiblingCount >= 2
      )
    );
  }
);

test(
  "second real trace block-d0-v0 strict duplication checkpoint preserves raw evidence",
  { skip: !existsSync(TRACE_B) },
  () => {
    const before = listedFileDigests(TRACE_B);
    const analyzed = analyzeTraceBundleDetailed(TRACE_B, { profile: "block-d0-v0" });
    assert.deepEqual(listedFileDigests(TRACE_B), before);
    const metrics = analyzed.artifacts.duplicationMetrics;
    assert.equal(metrics.coverage.eligibleSiblingSessionCount, 3);
    assert.equal(metrics.coverage.eligibleSpecificOperationCount, 289);
    assert.equal(metrics.coverage.eligibleSyntacticOperationCount, 662);
    assert.deepEqual(metrics.clusters, {
      total: 52,
      specificExact: 33,
      syntacticExact: 19,
      specificClusteredInstances: 89,
      syntacticClusteredInstances: 72,
    });
    assert.equal(metrics.specificExactDuplicateInstanceRatio.numerator, 56);
    assert.equal(metrics.syntacticExactDuplicateInstanceRatio.numerator, 53);
    assert.deepEqual(metrics.siblingPairs, {
      totalPairs: 3,
      pairsWithAtLeastOneExactCluster: 3,
      specificExactClusterIncidences: 79,
      syntacticExactClusterIncidences: 21,
    });
    assert.equal(analyzed.artifacts.sharedTargetOverlaps.length, 7);
    assert.equal(
      analyzed.artifacts.exactDuplicationClusters.filter(
        (cluster) => cluster.normalizationLevel === "specific"
      ).length,
      33
    );
  }
);

test(
  "first real trace block-d0-v1 sibling-presence checkpoint preserves raw evidence",
  { skip: !existsSync(TRACE_A) },
  () => {
    const before = listedFileDigests(TRACE_A);
    const analyzed = analyzeTraceBundleDetailed(TRACE_A, { profile: "block-d0-v1" });
    assert.deepEqual(listedFileDigests(TRACE_A), before);
    const metrics = analyzed.artifacts.duplicationMetrics;
    assert.equal(metrics.coverage.eligibleSpecificPresenceCount, 220);
    assert.equal(metrics.coverage.eligibleSyntacticPresenceCount, 377);
    assert.deepEqual(metrics.decomposition, {
      specific: {
        allExcessInstances: 23,
        crossSiblingExcessPresences: 19,
        withinSiblingExcessInstances: 4,
        invariantHolds: true,
      },
      syntactic: {
        allExcessInstances: 133,
        crossSiblingExcessPresences: 21,
        withinSiblingExcessInstances: 112,
        invariantHolds: true,
      },
    });
    assert.equal(metrics.specificSiblingPresenceDuplicateRatio.numerator, 19);
    assert.equal(metrics.specificSiblingPresenceDuplicateRatio.denominator, 220);
    assert.equal(metrics.syntacticSiblingPresenceDuplicateRatio.numerator, 21);
    assert.equal(metrics.syntacticSiblingPresenceDuplicateRatio.denominator, 377);
    assert.equal(metrics.specificWithinSiblingRepetitionRatio.numerator, 4);
    assert.equal(metrics.syntacticWithinSiblingRepetitionRatio.numerator, 112);
    assert.equal(
      metrics.specificStratification.byOperationKind.find((row) => row.key === "file_read")
        ?.crossSiblingExcessPresences,
      15
    );
    assert.ok(
      analyzed.artifacts.exactDuplicationClusters.every(
        (cluster) =>
          cluster.allExcessInstances ===
          cluster.crossSiblingExcessPresences + cluster.withinSiblingExcessInstances
      )
    );
  }
);

test(
  "second real trace block-d0-v1 sibling-presence checkpoint preserves raw evidence",
  { skip: !existsSync(TRACE_B) },
  () => {
    const before = listedFileDigests(TRACE_B);
    const analyzed = analyzeTraceBundleDetailed(TRACE_B, { profile: "block-d0-v1" });
    assert.deepEqual(listedFileDigests(TRACE_B), before);
    const metrics = analyzed.artifacts.duplicationMetrics;
    assert.equal(metrics.coverage.eligibleSpecificPresenceCount, 287);
    assert.equal(metrics.coverage.eligibleSyntacticPresenceCount, 578);
    assert.deepEqual(metrics.decomposition, {
      specific: {
        allExcessInstances: 56,
        crossSiblingExcessPresences: 56,
        withinSiblingExcessInstances: 0,
        invariantHolds: true,
      },
      syntactic: {
        allExcessInstances: 53,
        crossSiblingExcessPresences: 20,
        withinSiblingExcessInstances: 33,
        invariantHolds: true,
      },
    });
    assert.equal(metrics.specificSiblingPresenceDuplicateRatio.numerator, 56);
    assert.equal(metrics.specificSiblingPresenceDuplicateRatio.denominator, 287);
    assert.equal(metrics.syntacticSiblingPresenceDuplicateRatio.numerator, 20);
    assert.equal(metrics.syntacticSiblingPresenceDuplicateRatio.denominator, 578);
    assert.equal(metrics.specificWithinSiblingRepetitionRatio.numerator, 0);
    assert.equal(metrics.syntacticWithinSiblingRepetitionRatio.numerator, 33);
    assert.equal(metrics.specificStratification.crossParserClusterCount, 0);
    assert.ok(
      analyzed.artifacts.exactDuplicationClusters.every(
        (cluster) =>
          cluster.allExcessInstances ===
          cluster.crossSiblingExcessPresences + cluster.withinSiblingExcessInstances
      )
    );
  }
);

test(
  "second real trace loads and computes metrics without modifying raw evidence",
  { skip: !existsSync(TRACE_B) },
  () => {
    const manifestBefore = readFileSync(resolve(TRACE_B, "manifest.json"));
    const before = listedFileDigests(TRACE_B);
    const summary = analyzeTraceBundle(TRACE_B);
    const after = listedFileDigests(TRACE_B);
    assert.deepEqual(after, before);
    assert.deepEqual(readFileSync(resolve(TRACE_B, "manifest.json")), manifestBefore);
    assert.deepEqual(summary.validation.counts, { sessions: 4, events: 936, messages: 6 });
    assert.equal(summary.topology.rootOutDegree, 3);
    assert.equal(summary.topology.maxSpawnDepth, 1);
    assert.equal(summary.scope.llmUsed, false);
    assert.equal(summary.operationNormalization.normalizedOperationCount, 0);
  }
);
