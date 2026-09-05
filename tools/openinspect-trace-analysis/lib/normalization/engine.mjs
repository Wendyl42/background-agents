import {
  createNormalizedOperation,
  createNormalizedOperationV1,
  createNormalizedOperationV2,
} from "./operation.mjs";
import { computeParserCoverage, computeParserCoverageV2 } from "./coverage.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fallbackEvidence(invocation, diagnostics, matchedParser) {
  const evidence = {
    invocationId: invocation.invocationId,
    sourceEventId: invocation.sourceEventId,
    sessionId: invocation.sessionId,
    tool: invocation.tool,
    matchedParser,
    diagnostics,
    argKeys: Object.keys(invocation.args ?? {}).sort(),
  };
  if (invocation.tool === "bash" && typeof invocation.args?.command === "string") {
    evidence.commandPreview = invocation.args.command.slice(0, 240);
    evidence.commandTruncated = invocation.args.command.length > 240;
  }
  return evidence;
}

function normalizeOne(invocation, registry) {
  const frozenInvocation = deepFreeze(structuredClone(invocation));
  const rule = registry.select(frozenInvocation);
  if (!rule) {
    const result = {
      invocationId: invocation.invocationId,
      sourceEventId: invocation.sourceEventId,
      sessionId: invocation.sessionId,
      tool: invocation.tool,
      status: "fallback",
      matchedParser: null,
      emittedOperationIds: [],
      diagnostics: [{ code: "unknown_tool" }],
    };
    if (registry.operationSchemaVersion === "v2") result.emittedShellSegmentIds = [];
    return {
      operations: [],
      segments: [],
      result,
    };
  }

  let normalized;
  try {
    normalized = rule.normalize(frozenInvocation);
  } catch (error) {
    throw new Error(
      `Normalization rule ${rule.id}@${rule.version} failed for ${invocation.invocationId}: ` +
        `${error instanceof Error ? error.message : error}`
    );
  }
  const allowedStatuses =
    registry.operationSchemaVersion === "v2"
      ? new Set(["specific", "mixed", "syntactic", "fallback"])
      : new Set(["specific", "syntactic", "fallback"]);
  if (!allowedStatuses.has(normalized?.status)) {
    throw new Error(`Rule ${rule.id}@${rule.version} returned invalid status`);
  }
  if (!Array.isArray(normalized.operations) || !Array.isArray(normalized.diagnostics ?? [])) {
    throw new Error(`Rule ${rule.id}@${rule.version} returned an invalid normalization result`);
  }
  if (normalized.status === "fallback" && normalized.operations.length > 0) {
    throw new Error(`Fallback rule ${rule.id}@${rule.version} must not emit operations`);
  }
  if (normalized.status !== "fallback" && normalized.operations.length === 0) {
    throw new Error(`Parsed rule ${rule.id}@${rule.version} emitted no operations`);
  }

  const parser = { id: rule.id, version: rule.version };
  const operationFactory =
    registry.operationSchemaVersion === "v2"
      ? createNormalizedOperationV2
      : registry.operationSchemaVersion === "v1"
        ? createNormalizedOperationV1
        : createNormalizedOperation;
  const operations = normalized.operations.map((draft, ordinal) => {
    if (registry.operationSchemaVersion !== "v2") {
      return operationFactory({
        invocation,
        parser,
        rulesetVersion: registry.rulesetVersion,
        ordinal,
        draft,
      });
    }
    const operationParser = draft.parser ?? parser;
    const operationDraft = { ...draft };
    delete operationDraft.parser;
    return operationFactory({
      invocation,
      parser: operationParser,
      rulesetVersion: registry.rulesetVersion,
      ordinal,
      draft: operationDraft,
    });
  });
  const segments = registry.operationSchemaVersion === "v2" ? (normalized.segments ?? []) : [];
  if (registry.operationSchemaVersion === "v2" && !Array.isArray(segments)) {
    throw new Error(`Rule ${rule.id}@${rule.version} returned invalid shell segments`);
  }
  const finalizedSegments = segments.map((segment) => ({
    ...segment,
    emittedOperationIds: operations
      .filter((operation) => operation.sourceShellSegmentIds.includes(segment.shellSegmentId))
      .map((operation) => operation.operationId),
  }));
  const result = {
    invocationId: invocation.invocationId,
    sourceEventId: invocation.sourceEventId,
    sessionId: invocation.sessionId,
    tool: invocation.tool,
    status: normalized.status,
    matchedParser: parser,
    emittedOperationIds: operations.map((operation) => operation.operationId),
    diagnostics: normalized.diagnostics ?? [],
  };
  if (registry.operationSchemaVersion === "v2") {
    result.emittedShellSegmentIds = finalizedSegments.map((segment) => segment.shellSegmentId);
  }
  return {
    operations,
    segments: finalizedSegments,
    result,
  };
}

export function normalizeInvocations(toolInvocations, registry) {
  const operations = [];
  const results = [];
  const operationIds = new Set();
  const segments = [];
  const segmentIds = new Set();
  const usedRules = new Set();
  const usedOperationRules = new Set();

  for (const invocation of toolInvocations) {
    const normalized = normalizeOne(invocation, registry);
    for (const operation of normalized.operations) {
      if (operation.sourceInvocationIds.length !== 1) {
        throw new Error(
          `Block C operation ${operation.operationId} must have one source invocation`
        );
      }
      if (operationIds.has(operation.operationId)) {
        throw new Error(`Duplicate deterministic operation ID: ${operation.operationId}`);
      }
      operationIds.add(operation.operationId);
      operations.push(operation);
      if (registry.operationSchemaVersion === "v2") {
        usedOperationRules.add(`${operation.parserId}@${operation.parserVersion}`);
      }
    }
    for (const segment of normalized.segments ?? []) {
      if (segment.sourceInvocationId !== invocation.invocationId) {
        throw new Error(`Shell segment ${segment.shellSegmentId} has the wrong source invocation`);
      }
      if (segmentIds.has(segment.shellSegmentId)) {
        throw new Error(`Duplicate deterministic shell segment ID: ${segment.shellSegmentId}`);
      }
      segmentIds.add(segment.shellSegmentId);
      segments.push(segment);
    }
    if (normalized.result.matchedParser) {
      usedRules.add(
        `${normalized.result.matchedParser.id}@${normalized.result.matchedParser.version}`
      );
    }
    results.push(normalized.result);
  }

  const ruleInventory = registry.inventory();
  const coverage =
    registry.operationSchemaVersion === "v2"
      ? computeParserCoverageV2({
          results,
          segments,
          operations,
          ruleInventory,
          semanticRuleInventory: registry.semanticRuleInventory ?? [],
          rulesetVersion: registry.rulesetVersion,
          semanticRulesetVersion: registry.semanticRulesetVersion,
        })
      : computeParserCoverage({
          results,
          ruleInventory,
          rulesetVersion: registry.rulesetVersion,
        });
  const fallbackInvocations = results
    .filter((result) => result.status === "fallback")
    .map((result) => {
      const invocation = toolInvocations.find((item) => item.invocationId === result.invocationId);
      return fallbackEvidence(invocation, result.diagnostics, result.matchedParser);
    });

  return {
    rulesetVersion: registry.rulesetVersion,
    ruleInventory,
    usedRules: [...usedRules].sort(),
    usedOperationRules: [...usedOperationRules].sort(),
    operations,
    segments,
    results,
    coverage,
    fallbackInvocations,
  };
}
