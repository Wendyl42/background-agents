import assert from "node:assert/strict";
import test from "node:test";
import { analyzeStrictObservedDuplication } from "../lib/duplication.mjs";

function session(sessionId, parentSessionId = null) {
  return { sessionId, parentSessionId };
}

function invocation(invocationId, sessionId, startedAtMs) {
  return { invocationId, sessionId, startedAtMs };
}

function specificOperation(operationId, invocationId, target, inputFingerprint, parameters = {}) {
  return {
    operationId,
    sourceInvocationIds: [invocationId],
    sourceShellSegmentIds: [],
    kind: "file_read",
    targetType: "file_path",
    target,
    scope: "absolute_path",
    effect: "read",
    parameters,
    inputFingerprint,
    parserId: "filesystem.read",
    parserVersion: "2.0.0",
    normalizationLevel: "specific",
  };
}

function syntacticOperation(operationId, invocationId, target, inputFingerprint) {
  return {
    operationId,
    sourceInvocationIds: [invocationId],
    sourceShellSegmentIds: [`segment-${operationId}`],
    kind: "shell_segment",
    targetType: "shell_command",
    target,
    scope: "invocation_default",
    effect: "unknown",
    parameters: { pipeline: { stageCount: 1, firstStageOnlyPolicy: true } },
    inputFingerprint,
    parserId: "shell.segment",
    parserVersion: "2.0.0",
    normalizationLevel: "syntactic",
  };
}

function normalizationStub(fallbackCount = 0) {
  return {
    rulesetVersion: "openinspect-operation-rules-block-c-v2",
    results: Array.from({ length: fallbackCount }, (_, index) => ({
      status: "fallback",
      invocationId: `fallback-${index}`,
    })),
    coverage: {
      semanticRulesetVersion: "openinspect-package-command-rules-block-c-v2",
      layers: {
        invocation: {
          totals: { parsedCoverage: { numerator: 4, denominator: 5, value: 0.8 } },
        },
        segment: { semanticReach: { numerator: 2, denominator: 4, value: 0.5 } },
      },
    },
  };
}

function analyze({ sessions, invocations, operations, fallbackCount = 0 }) {
  return analyzeStrictObservedDuplication({
    rootSessionId: "root",
    sessions,
    toolInvocations: invocations,
    operations,
    normalization: normalizationStub(fallbackCount),
  });
}

function analyzeV1({ sessions, invocations, operations, fallbackCount = 0 }) {
  return analyzeStrictObservedDuplication({
    rootSessionId: "root",
    sessions,
    toolInvocations: invocations,
    operations,
    normalization: normalizationStub(fallbackCount),
    sensitivityVersion: "v1",
  });
}

test("strict clusters require different sibling sessions", () => {
  const sessions = [session("parent"), session("a", "parent"), session("b", "parent")];
  const invocations = [invocation("ia1", "a", 1), invocation("ia2", "a", 2)];
  const result = analyze({
    sessions,
    invocations,
    operations: [
      specificOperation("oa1", "ia1", "/same", "fp"),
      specificOperation("oa2", "ia2", "/same", "fp"),
    ],
  });
  assert.equal(result.clusters.length, 0);
  assert.equal(result.metrics.specificExactDuplicateInstanceRatio.numerator, 0);
});

test("cross-sibling exact instances form a deterministic specific cluster", () => {
  const sessions = [session("parent"), session("a", "parent"), session("b", "parent")];
  const invocations = [
    invocation("ia1", "a", 1),
    invocation("ia2", "a", 2),
    invocation("ib1", "b", 3),
  ];
  const operations = [
    specificOperation("oa1", "ia1", "/same", "fp", { selector: 1 }),
    specificOperation("oa2", "ia2", "/same", "fp", { selector: 1 }),
    specificOperation("ob1", "ib1", "/same", "fp", { selector: 1 }),
  ];
  const first = analyze({ sessions, invocations, operations, fallbackCount: 1 });
  const reordered = analyze({
    sessions: [...sessions].reverse(),
    invocations: [...invocations].reverse(),
    operations: [...operations].reverse(),
    fallbackCount: 1,
  });
  assert.equal(first.clusters.length, 1);
  assert.equal(first.clusters[0].distinctSiblingCount, 2);
  assert.equal(first.clusters[0].totalInstances, 3);
  assert.equal(first.clusters[0].duplicateInstances, 2);
  assert.equal(first.clusters[0].clusterId, reordered.clusters[0].clusterId);
  assert.equal(
    first.clusters[0].strictSignatureSha256,
    reordered.clusters[0].strictSignatureSha256
  );
  assert.deepEqual(first.clusters[0].memberOperationIds, reordered.clusters[0].memberOperationIds);
  assert.deepEqual(first.metrics.specificExactDuplicateInstanceRatio, {
    numerator: 2,
    denominator: 3,
    value: 2 / 3,
    numeratorDefinition: "Specific duplicate instances across strict sibling clusters.",
    denominatorDefinition: "All sibling-eligible specific normalized operations.",
    coverage: first.metrics.coverage,
  });
  assert.equal(first.metrics.coverage.excludedFallbackInvocationCount, 1);
});

test("identical operations under different parents never mix", () => {
  const sessions = [
    session("p1"),
    session("a", "p1"),
    session("b", "p1"),
    session("p2"),
    session("c", "p2"),
    session("d", "p2"),
  ];
  const invocations = [invocation("ia", "a", 1), invocation("ic", "c", 2)];
  const result = analyze({
    sessions,
    invocations,
    operations: [
      specificOperation("oa", "ia", "/same", "fp"),
      specificOperation("oc", "ic", "/same", "fp"),
    ],
  });
  assert.equal(result.clusters.length, 0);
  assert.equal(result.matrix.parentGroups.length, 2);
});

test("same target with different input is shared-target overlap, not duplicate", () => {
  const sessions = [session("parent"), session("a", "parent"), session("b", "parent")];
  const invocations = [invocation("ia", "a", 1), invocation("ib", "b", 2)];
  const result = analyze({
    sessions,
    invocations,
    operations: [
      specificOperation("oa", "ia", "/same", "fp-a", { offset: 1 }),
      specificOperation("ob", "ib", "/same", "fp-b", { offset: 2 }),
    ],
  });
  assert.equal(result.clusters.length, 0);
  assert.equal(result.sharedTargetOverlaps.length, 1);
  assert.equal(result.sharedTargetOverlaps[0].distinctNormalizedInputCount, 2);
  assert.equal(result.matrix.rows[0].totalExactClusterCount, 0);
  assert.equal(result.matrix.rows[0].sharedTargetOverlapCount, 1);
});

test("specific and syntactic clusters are counted separately", () => {
  const sessions = [session("parent"), session("a", "parent"), session("b", "parent")];
  const invocations = [invocation("ia", "a", 1), invocation("ib", "b", 2)];
  const result = analyze({
    sessions,
    invocations,
    operations: [
      specificOperation("osa", "ia", "/same", "specific-fp"),
      specificOperation("osb", "ib", "/same", "specific-fp"),
      syntacticOperation("oya", "ia", "echo same", "syntactic-fp"),
      syntacticOperation("oyb", "ib", "echo same", "syntactic-fp"),
    ],
  });
  assert.deepEqual(result.clusters.map((cluster) => cluster.strictness).sort(), [
    "specific_exact",
    "syntactic_exact",
  ]);
  assert.equal(result.metrics.specificExactDuplicateInstanceRatio.numerator, 1);
  assert.equal(result.metrics.syntacticExactDuplicateInstanceRatio.numerator, 1);
  assert.deepEqual(result.matrix.rows[0], {
    parentSessionId: "parent",
    leftSessionId: "a",
    rightSessionId: "b",
    specificExactClusterCount: 1,
    syntacticExactClusterCount: 1,
    totalExactClusterCount: 2,
    sharedTargetOverlapCount: 0,
  });
  assert.match(result.matrixCsv, /parent,a,b,1,1,2,0/);
});

test("sibling presence separates ten same-sibling repeats from one cross-sibling presence", () => {
  const sessions = [session("parent"), session("a", "parent"), session("b", "parent")];
  const invocations = [
    ...Array.from({ length: 10 }, (_, index) => invocation(`ia${index}`, "a", index)),
    invocation("ib", "b", 10),
  ];
  const operations = [
    ...Array.from({ length: 10 }, (_, index) =>
      specificOperation(`oa${index}`, `ia${index}`, "/same", "fp", { selector: 1 })
    ),
    specificOperation("ob", "ib", "/same", "fp", { selector: 1 }),
  ];
  const result = analyzeV1({ sessions, invocations, operations });
  const cluster = result.clusters[0];
  assert.equal(cluster.totalInstances, 11);
  assert.equal(cluster.distinctSiblingCount, 2);
  assert.equal(cluster.allExcessInstances, 10);
  assert.equal(cluster.crossSiblingExcessPresences, 1);
  assert.equal(cluster.withinSiblingExcessInstances, 9);
  assert.equal(
    cluster.allExcessInstances,
    cluster.crossSiblingExcessPresences + cluster.withinSiblingExcessInstances
  );
  assert.deepEqual(cluster.instancesBySibling, [
    { sessionId: "a", instanceCount: 10, withinSiblingExcessInstances: 9 },
    { sessionId: "b", instanceCount: 1, withinSiblingExcessInstances: 0 },
  ]);
  assert.deepEqual(result.metrics.specificSiblingPresenceDuplicateRatio, {
    numerator: 1,
    denominator: 2,
    value: 0.5,
    numeratorDefinition:
      "Specific cross-sibling excess presences after within-sibling signature deduplication.",
    denominatorDefinition: "Eligible distinct specific (parent, sibling, signature) presences.",
    coverage: result.metrics.coverage,
  });
  assert.equal(result.metrics.specificAllInstanceExcessSensitivity.numerator, 10);
  assert.equal(result.metrics.specificAllInstanceExcessSensitivity.denominator, 11);
  assert.equal(result.metrics.specificWithinSiblingRepetitionRatio.numerator, 9);
  assert.equal(result.metrics.specificWithinSiblingRepetitionRatio.denominator, 11);
});

test("one exact instance per sibling has zero within-sibling repetition", () => {
  const sessions = [session("parent"), session("a", "parent"), session("b", "parent")];
  const invocations = [invocation("ia", "a", 1), invocation("ib", "b", 2)];
  const result = analyzeV1({
    sessions,
    invocations,
    operations: [
      specificOperation("oa", "ia", "/same", "fp"),
      specificOperation("ob", "ib", "/same", "fp"),
    ],
  });
  assert.equal(result.clusters[0].allExcessInstances, 1);
  assert.equal(result.clusters[0].crossSiblingExcessPresences, 1);
  assert.equal(result.clusters[0].withinSiblingExcessInstances, 0);
  assert.equal(result.metrics.specificWithinSiblingRepetitionRatio.numerator, 0);
});

test("presence denominator deduplicates signatures inside each sibling", () => {
  const sessions = [session("parent"), session("a", "parent"), session("b", "parent")];
  const invocations = [
    invocation("ia1", "a", 1),
    invocation("ia2", "a", 2),
    invocation("ia3", "a", 3),
    invocation("ib", "b", 4),
  ];
  const result = analyzeV1({
    sessions,
    invocations,
    operations: [
      specificOperation("oa1", "ia1", "/same", "fp"),
      specificOperation("oa2", "ia2", "/same", "fp"),
      specificOperation("oa3", "ia3", "/same", "fp"),
      specificOperation("ob", "ib", "/same", "fp"),
    ],
  });
  assert.equal(result.metrics.coverage.eligibleSpecificOperationCount, 4);
  assert.equal(result.metrics.coverage.eligibleSpecificPresenceCount, 2);
  assert.equal(result.metrics.specificSiblingPresenceDuplicateRatio.denominator, 2);
});

test("D0.1 keeps specific and syntactic sensitivity separate and deterministic", () => {
  const sessions = [session("parent"), session("a", "parent"), session("b", "parent")];
  const invocations = [invocation("ia", "a", 1), invocation("ib", "b", 2)];
  const operations = [
    specificOperation("osa", "ia", "/same", "specific-fp"),
    specificOperation("osb", "ib", "/same", "specific-fp"),
    syntacticOperation("oya", "ia", "echo same", "syntactic-fp"),
    syntacticOperation("oyb", "ib", "echo same", "syntactic-fp"),
  ];
  const first = analyzeV1({ sessions, invocations, operations });
  const second = analyzeV1({
    sessions: [...sessions].reverse(),
    invocations: [...invocations].reverse(),
    operations: [...operations].reverse(),
  });
  assert.equal(first.metrics.specificSiblingPresenceDuplicateRatio.numerator, 1);
  assert.equal(first.metrics.syntacticSiblingPresenceDuplicateRatio.numerator, 1);
  assert.equal(first.metrics.decomposition.specific.invariantHolds, true);
  assert.equal(first.metrics.decomposition.syntactic.invariantHolds, true);
  assert.deepEqual(first, second);
});
