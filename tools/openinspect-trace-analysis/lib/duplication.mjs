import { sha256Bytes } from "./hash.mjs";
import {
  BLOCK_D0_DUPLICATION_SCHEMA_VERSION,
  BLOCK_D0_V1_DUPLICATION_SCHEMA_VERSION,
} from "./constants.mjs";
import { canonicalJson } from "./normalization/inputs.mjs";

const DUPLICATION_SCHEMA_VERSION = BLOCK_D0_DUPLICATION_SCHEMA_VERSION;
const TARGET_PREVIEW_LIMIT = 240;

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value)));
}

function ratio(numerator, denominator) {
  return { numerator, denominator, value: denominator ? numerator / denominator : 0 };
}

function boundedTarget(target) {
  return {
    sha256: sha256Bytes(Buffer.from(target)),
    bytes: Buffer.byteLength(target, "utf8"),
    preview: target.slice(0, TARGET_PREVIEW_LIMIT),
    truncated: target.length > TARGET_PREVIEW_LIMIT,
  };
}

function parserInventory(operations) {
  const parsers = new Map();
  for (const operation of operations) {
    const key = `${operation.parserId}@${operation.parserVersion}`;
    parsers.set(key, { parserId: operation.parserId, parserVersion: operation.parserVersion });
  }
  return [...parsers.values()].sort(
    (left, right) =>
      left.parserId.localeCompare(right.parserId) ||
      left.parserVersion.localeCompare(right.parserVersion)
  );
}

function exactIdentity(operation) {
  return {
    kind: operation.kind,
    targetType: operation.targetType,
    target: operation.target,
    scope: operation.scope,
    parameters: operation.parameters,
    inputFingerprint: operation.inputFingerprint,
  };
}

function summarizedIdentity(identity) {
  return {
    kind: identity.kind,
    targetType: identity.targetType,
    target: boundedTarget(identity.target),
    scope: identity.scope,
    parametersSha256: sha256Canonical(identity.parameters),
    inputFingerprint: identity.inputFingerprint,
  };
}

function makeMember(operation, invocation) {
  return {
    sessionId: invocation.sessionId,
    invocationId: invocation.invocationId,
    operationId: operation.operationId,
    sourceShellSegmentIds: [...(operation.sourceShellSegmentIds ?? [])],
    startedAtMs: invocation.startedAtMs,
  };
}

function compareMembers(left, right) {
  return (
    left.startedAtMs - right.startedAtMs ||
    left.sessionId.localeCompare(right.sessionId) ||
    left.invocationId.localeCompare(right.invocationId) ||
    left.operationId.localeCompare(right.operationId)
  );
}

function publicMember(member) {
  return {
    sessionId: member.sessionId,
    invocationId: member.invocationId,
    operationId: member.operationId,
    sourceShellSegmentIds: member.sourceShellSegmentIds,
  };
}

function combinations(values) {
  const pairs = [];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      pairs.push([values[left], values[right]]);
    }
  }
  return pairs;
}

function siblingUniverse(sessions) {
  const childrenByParent = new Map();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const children = childrenByParent.get(session.parentSessionId) ?? [];
    children.push(session.sessionId);
    childrenByParent.set(session.parentSessionId, children);
  }
  const eligibleParents = [...childrenByParent.entries()]
    .map(([parentSessionId, sessionIds]) => ({
      parentSessionId,
      sessionIds: [...new Set(sessionIds)].sort(),
    }))
    .filter((group) => group.sessionIds.length >= 2)
    .sort((left, right) => left.parentSessionId.localeCompare(right.parentSessionId));
  const parentBySession = new Map();
  for (const group of eligibleParents) {
    for (const sessionId of group.sessionIds) parentBySession.set(sessionId, group.parentSessionId);
  }
  return { eligibleParents, parentBySession };
}

function eligibleOperationRecords({ sessions, toolInvocations, operations }) {
  const universe = siblingUniverse(sessions);
  const invocationById = new Map(
    toolInvocations.map((invocation) => [invocation.invocationId, invocation])
  );
  const records = [];
  for (const operation of operations) {
    const invocation = invocationById.get(operation.sourceInvocationIds[0]);
    if (!invocation) throw new Error(`Missing invocation for operation ${operation.operationId}`);
    const parentSessionId = universe.parentBySession.get(invocation.sessionId);
    if (!parentSessionId) continue;
    const exactLevel =
      operation.normalizationLevel === "specific"
        ? "specific"
        : operation.normalizationLevel === "syntactic" && operation.kind === "shell_segment"
          ? "syntactic"
          : null;
    if (!exactLevel) continue;
    records.push({ operation, invocation, parentSessionId, exactLevel });
  }
  return { ...universe, invocationById, records };
}

function buildExactClusters(records, rulesetEvidence, schemaVersion, sensitivityVersion) {
  const groups = new Map();
  for (const record of records) {
    const identity = exactIdentity(record.operation);
    const canonicalIdentity = canonicalJson(identity);
    const key = `${record.parentSessionId}\0${record.exactLevel}\0${canonicalIdentity}`;
    const group = groups.get(key) ?? {
      parentSessionId: record.parentSessionId,
      exactLevel: record.exactLevel,
      identity,
      operations: [],
      members: [],
    };
    group.operations.push(record.operation);
    group.members.push(makeMember(record.operation, record.invocation));
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const members = group.members.sort(compareMembers);
      const sessionIds = [...new Set(members.map((member) => member.sessionId))].sort();
      if (sessionIds.length < 2) return null;
      const strictSignatureSha256 = sha256Canonical(group.identity);
      const clusterIdentity = {
        schemaVersion,
        strictness: `${group.exactLevel}_exact`,
        parentSessionId: group.parentSessionId,
        strictSignatureSha256,
      };
      const common = {
        schemaVersion,
        clusterId: `dup_${sha256Canonical(clusterIdentity).slice(0, 32)}`,
        strictSignatureSha256,
        strictness: `${group.exactLevel}_exact`,
        normalizationLevel: group.exactLevel,
        parentSessionId: group.parentSessionId,
        normalizedIdentity: summarizedIdentity(group.identity),
        distinctSiblingCount: sessionIds.length,
        totalInstances: members.length,
      };
      const evidence = {
        memberSessionIds: sessionIds,
        memberInvocationIds: [...new Set(members.map((member) => member.invocationId))].sort(),
        memberOperationIds: members.map((member) => member.operationId),
        firstInstance: publicMember(members[0]),
        members: members.map(publicMember),
        parserEvidence: parserInventory(group.operations),
        rulesetEvidence,
      };
      if (sensitivityVersion === "v1") {
        const instanceCounts = new Map();
        for (const member of members) {
          instanceCounts.set(member.sessionId, (instanceCounts.get(member.sessionId) ?? 0) + 1);
        }
        const allExcessInstances = members.length - 1;
        const crossSiblingExcessPresences = sessionIds.length - 1;
        const withinSiblingExcessInstances = members.length - sessionIds.length;
        if (allExcessInstances !== crossSiblingExcessPresences + withinSiblingExcessInstances) {
          throw new Error(`Sibling-presence invariant failed for ${strictSignatureSha256}`);
        }
        return {
          ...common,
          allExcessInstances,
          crossSiblingExcessPresences,
          withinSiblingExcessInstances,
          instancesBySibling: sessionIds.map((sessionId) => ({
            sessionId,
            instanceCount: instanceCounts.get(sessionId),
            withinSiblingExcessInstances: instanceCounts.get(sessionId) - 1,
          })),
          ...evidence,
          claimBoundary:
            "Observed sibling-presence and within-sibling repetition only; no removability, eliminability, or outcome equivalence is claimed.",
        };
      }
      return {
        ...common,
        duplicateInstances: members.length - 1,
        ...evidence,
        claimBoundary:
          "Observed exact duplicate instances only; no removability, eliminability, or outcome equivalence is claimed.",
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.clusterId.localeCompare(right.clusterId));
}

function buildSharedTargetOverlaps(records, rulesetEvidence, schemaVersion) {
  const groups = new Map();
  for (const record of records) {
    const operation = record.operation;
    const key = `${record.parentSessionId}\0${operation.targetType}\0${operation.target}`;
    const group = groups.get(key) ?? {
      parentSessionId: record.parentSessionId,
      targetType: operation.targetType,
      target: operation.target,
      operations: [],
      members: [],
    };
    group.operations.push(operation);
    group.members.push(makeMember(operation, record.invocation));
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const members = group.members.sort(compareMembers);
      const sessionIds = [...new Set(members.map((member) => member.sessionId))].sort();
      const fingerprints = [
        ...new Set(group.operations.map((operation) => operation.inputFingerprint ?? null)),
      ].sort((left, right) => String(left).localeCompare(String(right)));
      if (sessionIds.length < 2 || fingerprints.length < 2) return null;
      const kinds = [...new Set(group.operations.map((operation) => operation.kind))].sort();
      const levels = [
        ...new Set(group.operations.map((operation) => operation.normalizationLevel)),
      ].sort();
      const overlapSignature = {
        parentSessionId: group.parentSessionId,
        targetType: group.targetType,
        target: group.target,
        inputFingerprints: fingerprints,
      };
      return {
        schemaVersion,
        overlapId: `target_${sha256Canonical(overlapSignature).slice(0, 32)}`,
        classification: "shared_target_overlap",
        parentSessionId: group.parentSessionId,
        targetType: group.targetType,
        target: boundedTarget(group.target),
        distinctSiblingCount: sessionIds.length,
        totalInstances: members.length,
        distinctNormalizedInputCount: fingerprints.length,
        inputFingerprints: fingerprints,
        kinds,
        normalizationLevels: levels,
        memberSessionIds: sessionIds,
        memberInvocationIds: [...new Set(members.map((member) => member.invocationId))].sort(),
        memberOperationIds: members.map((member) => member.operationId),
        members: members.map(publicMember),
        parserEvidence: parserInventory(group.operations),
        rulesetEvidence,
        claimBoundary:
          "Shared target with different normalized inputs; explicitly not classified as an exact duplicate.",
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.overlapId.localeCompare(right.overlapId));
}

function pairKey(parentSessionId, leftSessionId, rightSessionId) {
  return `${parentSessionId}\0${leftSessionId}\0${rightSessionId}`;
}

function buildSiblingMatrix(
  eligibleParents,
  clusters,
  sharedTargetOverlaps,
  rootSessionId,
  schemaVersion
) {
  const rows = [];
  const rowsByKey = new Map();
  for (const group of eligibleParents) {
    for (const [leftSessionId, rightSessionId] of combinations(group.sessionIds)) {
      const row = {
        parentSessionId: group.parentSessionId,
        leftSessionId,
        rightSessionId,
        specificExactClusterCount: 0,
        syntacticExactClusterCount: 0,
        totalExactClusterCount: 0,
        sharedTargetOverlapCount: 0,
      };
      rows.push(row);
      rowsByKey.set(pairKey(group.parentSessionId, leftSessionId, rightSessionId), row);
    }
  }
  for (const cluster of clusters) {
    for (const [left, right] of combinations(cluster.memberSessionIds)) {
      const row = rowsByKey.get(pairKey(cluster.parentSessionId, left, right));
      if (!row) throw new Error(`Missing sibling matrix row for cluster ${cluster.clusterId}`);
      if (cluster.normalizationLevel === "specific") row.specificExactClusterCount += 1;
      else row.syntacticExactClusterCount += 1;
      row.totalExactClusterCount += 1;
    }
  }
  for (const overlap of sharedTargetOverlaps) {
    for (const [left, right] of combinations(overlap.memberSessionIds)) {
      const row = rowsByKey.get(pairKey(overlap.parentSessionId, left, right));
      if (!row) throw new Error(`Missing sibling matrix row for overlap ${overlap.overlapId}`);
      row.sharedTargetOverlapCount += 1;
    }
  }
  return {
    schemaVersion,
    rootSessionId,
    parentGroups: eligibleParents,
    rows,
  };
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function renderSiblingMatrixCsv(matrix) {
  const columns = [
    "parentSessionId",
    "leftSessionId",
    "rightSessionId",
    "specificExactClusterCount",
    "syntacticExactClusterCount",
    "totalExactClusterCount",
    "sharedTargetOverlapCount",
  ];
  return `${[
    columns.join(","),
    ...matrix.rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n")}\n`;
}

function topClusters(clusters, limit = 10) {
  return [...clusters]
    .sort(
      (left, right) =>
        right.duplicateInstances - left.duplicateInstances ||
        right.distinctSiblingCount - left.distinctSiblingCount ||
        left.clusterId.localeCompare(right.clusterId)
    )
    .slice(0, limit)
    .map((cluster) => ({
      clusterId: cluster.clusterId,
      strictness: cluster.strictness,
      parentSessionId: cluster.parentSessionId,
      kind: cluster.normalizedIdentity.kind,
      targetType: cluster.normalizedIdentity.targetType,
      target: cluster.normalizedIdentity.target,
      distinctSiblingCount: cluster.distinctSiblingCount,
      totalInstances: cluster.totalInstances,
      duplicateInstances: cluster.duplicateInstances,
      memberSessionIds: cluster.memberSessionIds,
      memberOperationIdCount: cluster.memberOperationIds.length,
      memberOperationIds: cluster.memberOperationIds.slice(0, 5),
    }));
}

function topSharedTargets(overlaps, limit = 10) {
  return [...overlaps]
    .sort(
      (left, right) =>
        right.distinctSiblingCount - left.distinctSiblingCount ||
        right.totalInstances - left.totalInstances ||
        left.overlapId.localeCompare(right.overlapId)
    )
    .slice(0, limit)
    .map((overlap) => ({
      overlapId: overlap.overlapId,
      parentSessionId: overlap.parentSessionId,
      targetType: overlap.targetType,
      target: overlap.target,
      distinctSiblingCount: overlap.distinctSiblingCount,
      totalInstances: overlap.totalInstances,
      distinctNormalizedInputCount: overlap.distinctNormalizedInputCount,
      kinds: overlap.kinds,
      memberSessionIds: overlap.memberSessionIds,
      memberOperationIdCount: overlap.memberOperationIds.length,
      memberOperationIds: overlap.memberOperationIds.slice(0, 5),
    }));
}

function recordSignature(record) {
  return canonicalJson(exactIdentity(record.operation));
}

function sensitivityForRecords(records) {
  const presenceKeys = new Set();
  const groups = new Map();
  for (const record of records) {
    const signature = recordSignature(record);
    presenceKeys.add(`${record.parentSessionId}\0${record.invocation.sessionId}\0${signature}`);
    const key = `${record.parentSessionId}\0${signature}`;
    const group = groups.get(key) ?? { totalInstances: 0, sessionIds: new Set() };
    group.totalInstances += 1;
    group.sessionIds.add(record.invocation.sessionId);
    groups.set(key, group);
  }
  let clusterCount = 0;
  let clusteredInstances = 0;
  let allExcessInstances = 0;
  let crossSiblingExcessPresences = 0;
  let withinSiblingExcessInstances = 0;
  for (const group of groups.values()) {
    if (group.sessionIds.size < 2) continue;
    clusterCount += 1;
    clusteredInstances += group.totalInstances;
    allExcessInstances += group.totalInstances - 1;
    crossSiblingExcessPresences += group.sessionIds.size - 1;
    withinSiblingExcessInstances += group.totalInstances - group.sessionIds.size;
  }
  if (allExcessInstances !== crossSiblingExcessPresences + withinSiblingExcessInstances) {
    throw new Error("Aggregate sibling-presence decomposition invariant failed");
  }
  return {
    eligibleOperationInstances: records.length,
    eligibleDistinctSiblingSignaturePresences: presenceKeys.size,
    clusterCount,
    clusteredInstances,
    allExcessInstances,
    crossSiblingExcessPresences,
    withinSiblingExcessInstances,
    siblingPresenceDuplicateRatio: ratio(crossSiblingExcessPresences, presenceKeys.size),
    allInstanceExcessSensitivity: ratio(allExcessInstances, records.length),
    withinSiblingRepetitionRatio: ratio(withinSiblingExcessInstances, records.length),
  };
}

function stratifySpecific(records, keyFn) {
  const groups = new Map();
  for (const record of records) {
    const key = keyFn(record);
    const items = groups.get(key) ?? [];
    items.push(record);
    groups.set(key, items);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, items]) => ({ key, ...sensitivityForRecords(items) }));
}

function topClustersV1(clusters, limit = 10) {
  return [...clusters]
    .sort(
      (left, right) =>
        right.crossSiblingExcessPresences - left.crossSiblingExcessPresences ||
        right.allExcessInstances - left.allExcessInstances ||
        left.clusterId.localeCompare(right.clusterId)
    )
    .slice(0, limit)
    .map((cluster) => ({
      clusterId: cluster.clusterId,
      strictness: cluster.strictness,
      parentSessionId: cluster.parentSessionId,
      kind: cluster.normalizedIdentity.kind,
      targetType: cluster.normalizedIdentity.targetType,
      target: cluster.normalizedIdentity.target,
      distinctSiblingCount: cluster.distinctSiblingCount,
      totalInstances: cluster.totalInstances,
      allExcessInstances: cluster.allExcessInstances,
      crossSiblingExcessPresences: cluster.crossSiblingExcessPresences,
      withinSiblingExcessInstances: cluster.withinSiblingExcessInstances,
      memberSessionIds: cluster.memberSessionIds,
      memberOperationIdCount: cluster.memberOperationIds.length,
      memberOperationIds: cluster.memberOperationIds.slice(0, 5),
    }));
}

function buildMetrics({
  rootSessionId,
  eligibleParents,
  records,
  clusters,
  sharedTargetOverlaps,
  matrix,
  normalization,
}) {
  const specificRecords = records.filter((record) => record.exactLevel === "specific");
  const syntacticRecords = records.filter((record) => record.exactLevel === "syntactic");
  const specificClusters = clusters.filter((cluster) => cluster.normalizationLevel === "specific");
  const syntacticClusters = clusters.filter(
    (cluster) => cluster.normalizationLevel === "syntactic"
  );
  const specificDuplicateInstances = specificClusters.reduce(
    (sum, cluster) => sum + cluster.duplicateInstances,
    0
  );
  const syntacticDuplicateInstances = syntacticClusters.reduce(
    (sum, cluster) => sum + cluster.duplicateInstances,
    0
  );
  const parentsWithClusters = new Set(clusters.map((cluster) => cluster.parentSessionId));
  const pairsWithClusters = matrix.rows.filter((row) => row.totalExactClusterCount > 0);
  const pairsWithSharedTargets = matrix.rows.filter((row) => row.sharedTargetOverlapCount > 0);
  const eligibleSiblingSessionCount = new Set(eligibleParents.flatMap((group) => group.sessionIds))
    .size;
  const coverage = {
    sourceProfile: "block-c-v2",
    operationRulesetVersion: normalization.rulesetVersion,
    semanticRulesetVersion: normalization.coverage.semanticRulesetVersion,
    eligibleParentCount: eligibleParents.length,
    eligibleSiblingSessionCount,
    eligibleSpecificOperationCount: specificRecords.length,
    eligibleSyntacticOperationCount: syntacticRecords.length,
    excludedFallbackInvocationCount: normalization.results.filter(
      (result) => result.status === "fallback"
    ).length,
    c2InvocationParsedCoverage: normalization.coverage.layers.invocation.totals.parsedCoverage,
    c2ShellSegmentSemanticReach: normalization.coverage.layers.segment.semanticReach,
  };
  return {
    schemaVersion: DUPLICATION_SCHEMA_VERSION,
    rootSessionId,
    definitions: {
      sibling:
        "Different child sessions with the same non-null parentSessionId; parents and non-sibling sessions are excluded.",
      duplicateInstance:
        "Within a qualifying strict cluster, every instance after the deterministic first instance.",
      claimBoundary:
        "Observed exact duplication only; duplicate instances are not removable or eliminable instances.",
    },
    coverage,
    specificExactDuplicateInstanceRatio: {
      ...ratio(specificDuplicateInstances, specificRecords.length),
      numeratorDefinition: "Specific duplicate instances across strict sibling clusters.",
      denominatorDefinition: "All sibling-eligible specific normalized operations.",
      coverage,
    },
    syntacticExactDuplicateInstanceRatio: {
      ...ratio(syntacticDuplicateInstances, syntacticRecords.length),
      numeratorDefinition: "Syntactic duplicate instances across strict sibling clusters.",
      denominatorDefinition: "All sibling-eligible syntactic shell_segment operations.",
      coverage,
    },
    runsWithAtLeastOneExactCluster: {
      ...ratio(clusters.length > 0 ? 1 : 0, 1),
      numeratorDefinition: "This run has at least one strict sibling duplicate cluster.",
      denominatorDefinition: "The single analyzed trace bundle/run.",
    },
    parentsWithAtLeastOneExactCluster: {
      ...ratio(parentsWithClusters.size, eligibleParents.length),
      numeratorDefinition: "Eligible parent groups with at least one strict cluster.",
      denominatorDefinition: "Parent groups containing at least two child sessions.",
    },
    clusters: {
      total: clusters.length,
      specificExact: specificClusters.length,
      syntacticExact: syntacticClusters.length,
      specificClusteredInstances: specificClusters.reduce(
        (sum, cluster) => sum + cluster.totalInstances,
        0
      ),
      syntacticClusteredInstances: syntacticClusters.reduce(
        (sum, cluster) => sum + cluster.totalInstances,
        0
      ),
    },
    siblingPairs: {
      totalPairs: matrix.rows.length,
      pairsWithAtLeastOneExactCluster: pairsWithClusters.length,
      specificExactClusterIncidences: matrix.rows.reduce(
        (sum, row) => sum + row.specificExactClusterCount,
        0
      ),
      syntacticExactClusterIncidences: matrix.rows.reduce(
        (sum, row) => sum + row.syntacticExactClusterCount,
        0
      ),
    },
    sharedTargetOverlap: {
      overlapCount: sharedTargetOverlaps.length,
      totalInstances: sharedTargetOverlaps.reduce(
        (sum, overlap) => sum + overlap.totalInstances,
        0
      ),
      pairsWithAtLeastOneOverlap: pairsWithSharedTargets.length,
      pairOverlapIncidences: matrix.rows.reduce(
        (sum, row) => sum + row.sharedTargetOverlapCount,
        0
      ),
      claimBoundary: "Reported separately and never counted as exact duplication.",
    },
    topExactClusters: topClusters(clusters),
    topSharedTargetOverlaps: topSharedTargets(sharedTargetOverlaps),
  };
}

function metricWithDefinitions(metric, numeratorDefinition, denominatorDefinition, coverage) {
  return { ...metric, numeratorDefinition, denominatorDefinition, coverage };
}

function assertSensitivityMatchesClusters(sensitivity, clusters, level) {
  const all = clusters.reduce((sum, cluster) => sum + cluster.allExcessInstances, 0);
  const cross = clusters.reduce((sum, cluster) => sum + cluster.crossSiblingExcessPresences, 0);
  const within = clusters.reduce((sum, cluster) => sum + cluster.withinSiblingExcessInstances, 0);
  if (
    sensitivity.allExcessInstances !== all ||
    sensitivity.crossSiblingExcessPresences !== cross ||
    sensitivity.withinSiblingExcessInstances !== within
  ) {
    throw new Error(`${level} sibling-presence metrics disagree with exact clusters`);
  }
}

function buildMetricsV1({
  rootSessionId,
  eligibleParents,
  records,
  clusters,
  sharedTargetOverlaps,
  matrix,
  normalization,
  schemaVersion,
}) {
  const specificRecords = records.filter((record) => record.exactLevel === "specific");
  const syntacticRecords = records.filter((record) => record.exactLevel === "syntactic");
  const specificClusters = clusters.filter((cluster) => cluster.normalizationLevel === "specific");
  const syntacticClusters = clusters.filter(
    (cluster) => cluster.normalizationLevel === "syntactic"
  );
  const specific = sensitivityForRecords(specificRecords);
  const syntactic = sensitivityForRecords(syntacticRecords);
  assertSensitivityMatchesClusters(specific, specificClusters, "specific");
  assertSensitivityMatchesClusters(syntactic, syntacticClusters, "syntactic");
  const parentsWithClusters = new Set(clusters.map((cluster) => cluster.parentSessionId));
  const pairsWithClusters = matrix.rows.filter((row) => row.totalExactClusterCount > 0);
  const pairsWithSharedTargets = matrix.rows.filter((row) => row.sharedTargetOverlapCount > 0);
  const eligibleSiblingSessionCount = new Set(eligibleParents.flatMap((group) => group.sessionIds))
    .size;
  const coverage = {
    sourceProfile: "block-c-v2",
    operationRulesetVersion: normalization.rulesetVersion,
    semanticRulesetVersion: normalization.coverage.semanticRulesetVersion,
    eligibleParentCount: eligibleParents.length,
    eligibleSiblingSessionCount,
    eligibleSpecificOperationCount: specificRecords.length,
    eligibleSyntacticOperationCount: syntacticRecords.length,
    eligibleSpecificPresenceCount: specific.eligibleDistinctSiblingSignaturePresences,
    eligibleSyntacticPresenceCount: syntactic.eligibleDistinctSiblingSignaturePresences,
    excludedFallbackInvocationCount: normalization.results.filter(
      (result) => result.status === "fallback"
    ).length,
    c2InvocationParsedCoverage: normalization.coverage.layers.invocation.totals.parsedCoverage,
    c2ShellSegmentSemanticReach: normalization.coverage.layers.segment.semanticReach,
  };
  const byOperationKind = stratifySpecific(specificRecords, (record) => record.operation.kind);
  const byParser = stratifySpecific(
    specificRecords,
    (record) => `${record.operation.parserId}@${record.operation.parserVersion}`
  );
  const syntacticByParser = stratifySpecific(
    syntacticRecords,
    (record) => `${record.operation.parserId}@${record.operation.parserVersion}`
  );
  return {
    schemaVersion,
    rootSessionId,
    definitions: {
      sibling:
        "Different child sessions with the same non-null parentSessionId; parents and non-sibling sessions are excluded.",
      signaturePresence:
        "One distinct (parent, sibling session, strict exact signature) presence after within-sibling deduplication.",
      allExcessInstances: "Within a qualifying cluster, totalInstances - 1.",
      crossSiblingExcessPresences:
        "Within a qualifying cluster, distinctSiblingCount - 1; the primary sibling-presence numerator.",
      withinSiblingExcessInstances:
        "Within a qualifying cluster, totalInstances - distinctSiblingCount.",
      invariant: "allExcessInstances = crossSiblingExcessPresences + withinSiblingExcessInstances.",
      claimBoundary:
        "Observed strict presence duplication and repetition only; no removability or eliminability is claimed.",
    },
    coverage,
    specificSiblingPresenceDuplicateRatio: metricWithDefinitions(
      specific.siblingPresenceDuplicateRatio,
      "Specific cross-sibling excess presences after within-sibling signature deduplication.",
      "Eligible distinct specific (parent, sibling, signature) presences.",
      coverage
    ),
    syntacticSiblingPresenceDuplicateRatio: metricWithDefinitions(
      syntactic.siblingPresenceDuplicateRatio,
      "Syntactic cross-sibling excess presences after within-sibling signature deduplication.",
      "Eligible distinct syntactic (parent, sibling, signature) presences.",
      coverage
    ),
    specificAllInstanceExcessSensitivity: metricWithDefinitions(
      specific.allInstanceExcessSensitivity,
      "Specific all-instance excess (totalInstances - 1) across strict sibling clusters.",
      "All sibling-eligible specific operation instances.",
      coverage
    ),
    syntacticAllInstanceExcessSensitivity: metricWithDefinitions(
      syntactic.allInstanceExcessSensitivity,
      "Syntactic all-instance excess (totalInstances - 1) across strict sibling clusters.",
      "All sibling-eligible syntactic shell_segment instances.",
      coverage
    ),
    specificWithinSiblingRepetitionRatio: metricWithDefinitions(
      specific.withinSiblingRepetitionRatio,
      "Specific within-sibling excess instances inside strict cross-sibling clusters.",
      "All sibling-eligible specific operation instances.",
      coverage
    ),
    syntacticWithinSiblingRepetitionRatio: metricWithDefinitions(
      syntactic.withinSiblingRepetitionRatio,
      "Syntactic within-sibling excess instances inside strict cross-sibling clusters.",
      "All sibling-eligible syntactic shell_segment instances.",
      coverage
    ),
    decomposition: {
      specific: {
        allExcessInstances: specific.allExcessInstances,
        crossSiblingExcessPresences: specific.crossSiblingExcessPresences,
        withinSiblingExcessInstances: specific.withinSiblingExcessInstances,
        invariantHolds:
          specific.allExcessInstances ===
          specific.crossSiblingExcessPresences + specific.withinSiblingExcessInstances,
      },
      syntactic: {
        allExcessInstances: syntactic.allExcessInstances,
        crossSiblingExcessPresences: syntactic.crossSiblingExcessPresences,
        withinSiblingExcessInstances: syntactic.withinSiblingExcessInstances,
        invariantHolds:
          syntactic.allExcessInstances ===
          syntactic.crossSiblingExcessPresences + syntactic.withinSiblingExcessInstances,
      },
    },
    specificStratification: {
      byOperationKind,
      byParser,
      crossParserClusterCount: specificClusters.filter(
        (cluster) => cluster.parserEvidence.length > 1
      ).length,
    },
    syntacticLayer: {
      ...syntactic,
      byParser: syntacticByParser,
    },
    runsWithAtLeastOneExactCluster: {
      ...ratio(clusters.length > 0 ? 1 : 0, 1),
      numeratorDefinition: "This run has at least one strict sibling duplicate cluster.",
      denominatorDefinition: "The single analyzed trace bundle/run.",
    },
    parentsWithAtLeastOneExactCluster: {
      ...ratio(parentsWithClusters.size, eligibleParents.length),
      numeratorDefinition: "Eligible parent groups with at least one strict cluster.",
      denominatorDefinition: "Parent groups containing at least two child sessions.",
    },
    clusters: {
      total: clusters.length,
      specificExact: specificClusters.length,
      syntacticExact: syntacticClusters.length,
      specificClusteredInstances: specific.clusteredInstances,
      syntacticClusteredInstances: syntactic.clusteredInstances,
      specificAllExcessInstances: specific.allExcessInstances,
      specificCrossSiblingExcessPresences: specific.crossSiblingExcessPresences,
      specificWithinSiblingExcessInstances: specific.withinSiblingExcessInstances,
      syntacticAllExcessInstances: syntactic.allExcessInstances,
      syntacticCrossSiblingExcessPresences: syntactic.crossSiblingExcessPresences,
      syntacticWithinSiblingExcessInstances: syntactic.withinSiblingExcessInstances,
    },
    siblingPairs: {
      totalPairs: matrix.rows.length,
      pairsWithAtLeastOneExactCluster: pairsWithClusters.length,
      specificExactClusterIncidences: matrix.rows.reduce(
        (sum, row) => sum + row.specificExactClusterCount,
        0
      ),
      syntacticExactClusterIncidences: matrix.rows.reduce(
        (sum, row) => sum + row.syntacticExactClusterCount,
        0
      ),
    },
    sharedTargetOverlap: {
      overlapCount: sharedTargetOverlaps.length,
      totalInstances: sharedTargetOverlaps.reduce(
        (sum, overlap) => sum + overlap.totalInstances,
        0
      ),
      pairsWithAtLeastOneOverlap: pairsWithSharedTargets.length,
      pairOverlapIncidences: matrix.rows.reduce(
        (sum, row) => sum + row.sharedTargetOverlapCount,
        0
      ),
      claimBoundary: "Reported separately and never counted as exact duplication.",
    },
    topExactClusters: topClustersV1(clusters),
    topSharedTargetOverlaps: topSharedTargets(sharedTargetOverlaps),
  };
}

export function analyzeStrictObservedDuplication({
  rootSessionId,
  sessions,
  toolInvocations,
  operations,
  normalization,
  sensitivityVersion = "v0",
}) {
  if (!new Set(["v0", "v1"]).has(sensitivityVersion)) {
    throw new Error(`Unsupported duplication sensitivity version: ${sensitivityVersion}`);
  }
  const schemaVersion =
    sensitivityVersion === "v1"
      ? BLOCK_D0_V1_DUPLICATION_SCHEMA_VERSION
      : DUPLICATION_SCHEMA_VERSION;
  const rulesetEvidence = {
    operationRulesetVersion: normalization.rulesetVersion,
    semanticRulesetVersion: normalization.coverage.semanticRulesetVersion,
  };
  const universe = eligibleOperationRecords({ sessions, toolInvocations, operations });
  const clusters = buildExactClusters(
    universe.records,
    rulesetEvidence,
    schemaVersion,
    sensitivityVersion
  );
  const sharedTargetOverlaps = buildSharedTargetOverlaps(
    universe.records,
    rulesetEvidence,
    schemaVersion
  );
  const matrix = buildSiblingMatrix(
    universe.eligibleParents,
    clusters,
    sharedTargetOverlaps,
    rootSessionId,
    schemaVersion
  );
  const metricInput = {
    rootSessionId,
    eligibleParents: universe.eligibleParents,
    records: universe.records,
    clusters,
    sharedTargetOverlaps,
    matrix,
    normalization,
  };
  const metrics =
    sensitivityVersion === "v1"
      ? buildMetricsV1({ ...metricInput, schemaVersion })
      : buildMetrics(metricInput);
  return {
    schemaVersion,
    clusters,
    sharedTargetOverlaps,
    matrix,
    matrixCsv: renderSiblingMatrixCsv(matrix),
    metrics,
  };
}
