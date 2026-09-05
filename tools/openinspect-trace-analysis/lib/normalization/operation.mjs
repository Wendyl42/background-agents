import { sha256Bytes } from "../hash.mjs";

export const NORMALIZATION_LEVELS = new Set(["specific", "syntactic", "fallback"]);
export const NORMALIZATION_CONFIDENCE = new Set(["high", "medium", "low"]);

function assertString(value, field) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`NormalizedOperation ${field} must be a non-empty string`);
  }
}

function sanitizeDetails(value, field) {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`NormalizedOperation ${field} must be an object`);
  }
  const text = JSON.stringify(value);
  if (text.length > 8_192) {
    throw new Error(`NormalizedOperation ${field} exceeds the 8192-byte JSON cap`);
  }
  return structuredClone(value);
}

export function createNormalizedOperation({ invocation, parser, rulesetVersion, ordinal, draft }) {
  if (!Number.isInteger(ordinal) || ordinal < 0)
    throw new Error("Operation ordinal must be non-negative");
  assertString(draft.kind, "kind");
  assertString(draft.targetType, "targetType");
  assertString(draft.target, "target");
  assertString(draft.scope, "scope");
  assertString(draft.effect, "effect");
  if (!NORMALIZATION_LEVELS.has(draft.normalizationLevel)) {
    throw new Error(`Invalid normalizationLevel: ${String(draft.normalizationLevel)}`);
  }
  if (!NORMALIZATION_CONFIDENCE.has(draft.confidence)) {
    throw new Error(`Invalid confidence: ${String(draft.confidence)}`);
  }
  if (draft.inputFingerprint !== null && typeof draft.inputFingerprint !== "string") {
    throw new Error("inputFingerprint must be a string or null");
  }

  const sourceInvocationIds = [invocation.invocationId];
  const identity = {
    rulesetVersion,
    parserId: parser.id,
    parserVersion: parser.version,
    sourceInvocationIds,
    ordinal,
    kind: draft.kind,
    targetType: draft.targetType,
    target: draft.target,
    scope: draft.scope,
    effect: draft.effect,
    inputFingerprint: draft.inputFingerprint,
    normalizationLevel: draft.normalizationLevel,
  };
  const operationId = `op_${sha256Bytes(Buffer.from(JSON.stringify(identity))).slice(0, 32)}`;

  return {
    operationId,
    sourceInvocationIds,
    kind: draft.kind,
    targetType: draft.targetType,
    target: draft.target,
    scope: draft.scope,
    effect: draft.effect,
    inputFingerprint: draft.inputFingerprint,
    parserId: parser.id,
    parserVersion: parser.version,
    normalizationLevel: draft.normalizationLevel,
    confidence: draft.confidence,
    evidence: sanitizeDetails(draft.evidence, "evidence"),
    diagnostics: sanitizeDetails(draft.diagnostics, "diagnostics"),
  };
}

export function createNormalizedOperationV1({
  invocation,
  parser,
  rulesetVersion,
  ordinal,
  draft,
}) {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error("Operation ordinal must be non-negative");
  }
  assertString(draft.kind, "kind");
  assertString(draft.targetType, "targetType");
  assertString(draft.target, "target");
  assertString(draft.scope, "scope");
  assertString(draft.effect, "effect");
  if (!NORMALIZATION_LEVELS.has(draft.normalizationLevel)) {
    throw new Error(`Invalid normalizationLevel: ${String(draft.normalizationLevel)}`);
  }
  if (!NORMALIZATION_CONFIDENCE.has(draft.confidence)) {
    throw new Error(`Invalid confidence: ${String(draft.confidence)}`);
  }
  if (draft.inputFingerprint !== null && typeof draft.inputFingerprint !== "string") {
    throw new Error("inputFingerprint must be a string or null");
  }

  const parameters = sanitizeDetails(draft.parameters, "parameters");
  const sourceInvocationIds = [invocation.invocationId];
  const identity = {
    operationSchemaVersion: "v1",
    rulesetVersion,
    parserId: parser.id,
    parserVersion: parser.version,
    sourceInvocationIds,
    ordinal,
    kind: draft.kind,
    targetType: draft.targetType,
    target: draft.target,
    scope: draft.scope,
    effect: draft.effect,
    parameters,
    inputFingerprint: draft.inputFingerprint,
    normalizationLevel: draft.normalizationLevel,
  };
  const operationId = `op_${sha256Bytes(Buffer.from(JSON.stringify(identity))).slice(0, 32)}`;

  return {
    operationId,
    sourceInvocationIds,
    kind: draft.kind,
    targetType: draft.targetType,
    target: draft.target,
    scope: draft.scope,
    effect: draft.effect,
    parameters,
    inputFingerprint: draft.inputFingerprint,
    parserId: parser.id,
    parserVersion: parser.version,
    normalizationLevel: draft.normalizationLevel,
    confidence: draft.confidence,
    evidence: sanitizeDetails(draft.evidence, "evidence"),
    diagnostics: sanitizeDetails(draft.diagnostics, "diagnostics"),
  };
}

export function createNormalizedOperationV2({
  invocation,
  parser,
  rulesetVersion,
  ordinal,
  draft,
}) {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error("Operation ordinal must be non-negative");
  }
  assertString(draft.kind, "kind");
  assertString(draft.targetType, "targetType");
  assertString(draft.target, "target");
  assertString(draft.scope, "scope");
  assertString(draft.effect, "effect");
  if (!NORMALIZATION_LEVELS.has(draft.normalizationLevel)) {
    throw new Error(`Invalid normalizationLevel: ${String(draft.normalizationLevel)}`);
  }
  if (!NORMALIZATION_CONFIDENCE.has(draft.confidence)) {
    throw new Error(`Invalid confidence: ${String(draft.confidence)}`);
  }
  if (draft.inputFingerprint !== null && typeof draft.inputFingerprint !== "string") {
    throw new Error("inputFingerprint must be a string or null");
  }

  const parameters = sanitizeDetails(draft.parameters, "parameters");
  const sourceInvocationIds = [invocation.invocationId];
  const sourceShellSegmentIds = draft.sourceShellSegmentIds ?? [];
  if (
    !Array.isArray(sourceShellSegmentIds) ||
    sourceShellSegmentIds.some((value) => typeof value !== "string" || value === "") ||
    sourceShellSegmentIds.length > 1
  ) {
    throw new Error("Block C.2 sourceShellSegmentIds must contain zero or one segment ID");
  }
  const identity = {
    operationSchemaVersion: "v2",
    rulesetVersion,
    parserId: parser.id,
    parserVersion: parser.version,
    sourceInvocationIds,
    sourceShellSegmentIds,
    ordinal,
    kind: draft.kind,
    targetType: draft.targetType,
    target: draft.target,
    scope: draft.scope,
    effect: draft.effect,
    parameters,
    inputFingerprint: draft.inputFingerprint,
    normalizationLevel: draft.normalizationLevel,
  };
  const operationId = `op_${sha256Bytes(Buffer.from(JSON.stringify(identity))).slice(0, 32)}`;

  return {
    operationId,
    sourceInvocationIds,
    sourceShellSegmentIds,
    kind: draft.kind,
    targetType: draft.targetType,
    target: draft.target,
    scope: draft.scope,
    effect: draft.effect,
    parameters,
    inputFingerprint: draft.inputFingerprint,
    parserId: parser.id,
    parserVersion: parser.version,
    normalizationLevel: draft.normalizationLevel,
    confidence: draft.confidence,
    evidence: sanitizeDetails(draft.evidence, "evidence"),
    diagnostics: sanitizeDetails(draft.diagnostics, "diagnostics"),
  };
}
