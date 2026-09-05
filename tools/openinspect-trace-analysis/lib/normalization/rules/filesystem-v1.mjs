import { posix } from "node:path";
import { normalizedInputFingerprint, textIdentity } from "../inputs.mjs";

function validPath(value) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !value.includes("\0") &&
    value.length <= 4096
  );
}

function pathTarget(value) {
  return validPath(value) ? posix.normalize(value.trim()) : null;
}

function scopeForPath(value) {
  return value.startsWith("/") ? "absolute_path" : "invocation_relative";
}

function fallback(code, argument) {
  return { status: "fallback", operations: [], diagnostics: [{ code, argument }] };
}

function presentSelector(args, key, validate) {
  if (!Object.hasOwn(args ?? {}, key)) return { ok: true, value: { present: false } };
  const value = args[key];
  if (!validate(value)) return { ok: false };
  return { ok: true, value: { present: true, value } };
}

function specificOperation(invocation, draft) {
  return {
    status: "specific",
    diagnostics: [],
    operations: [
      {
        ...draft,
        normalizationLevel: "specific",
        confidence: "high",
        evidence: {
          sourceEventId: invocation.sourceEventId,
          sourceSessionId: invocation.sessionId,
          ...draft.evidence,
        },
        diagnostics: {},
      },
    ],
  };
}

export function readRuleV1() {
  return {
    id: "filesystem.read",
    version: "2.0.0",
    priority: 10,
    supportedTools: ["read"],
    match: () => true,
    normalize(invocation) {
      const target = pathTarget(invocation.args?.filePath);
      if (!target) return fallback("missing_or_invalid_file_path", "filePath");
      const offset = presentSelector(
        invocation.args,
        "offset",
        (value) => Number.isInteger(value) && value >= 0
      );
      if (!offset.ok) return fallback("invalid_read_offset", "offset");
      const limit = presentSelector(
        invocation.args,
        "limit",
        (value) => Number.isInteger(value) && value > 0
      );
      if (!limit.ok) return fallback("invalid_read_limit", "limit");
      const parameters = { selector: { offset: offset.value, limit: limit.value } };
      return specificOperation(invocation, {
        kind: "file_read",
        targetType: "file_path",
        target,
        scope: scopeForPath(target),
        effect: "read",
        parameters,
        inputFingerprint: normalizedInputFingerprint({ target, parameters }),
        evidence: { targetArgument: "filePath", selectorArguments: ["offset", "limit"] },
      });
    },
  };
}

export function writeRuleV1() {
  return {
    id: "filesystem.write",
    version: "2.0.0",
    priority: 10,
    supportedTools: ["write"],
    match: () => true,
    normalize(invocation) {
      const target = pathTarget(invocation.args?.filePath);
      if (!target) return fallback("missing_or_invalid_file_path", "filePath");
      const content = textIdentity(invocation.args?.content);
      if (!content) return fallback("missing_or_invalid_write_content", "content");
      const parameters = { contentSha256: content.sha256, contentBytes: content.bytes };
      return specificOperation(invocation, {
        kind: "file_write",
        targetType: "file_path",
        target,
        scope: scopeForPath(target),
        effect: "write",
        parameters,
        inputFingerprint: normalizedInputFingerprint({ target, parameters }),
        evidence: { targetArgument: "filePath", omittedArguments: ["content"] },
      });
    },
  };
}

export function editRuleV1() {
  return {
    id: "filesystem.edit",
    version: "1.0.0",
    priority: 10,
    supportedTools: ["edit"],
    match: () => true,
    normalize(invocation) {
      const target = pathTarget(invocation.args?.filePath);
      if (!target) return fallback("missing_or_invalid_file_path", "filePath");
      const oldIdentity = textIdentity(invocation.args?.oldString);
      if (!oldIdentity) return fallback("missing_or_invalid_old_string", "oldString");
      const newIdentity = textIdentity(invocation.args?.newString);
      if (!newIdentity) return fallback("missing_or_invalid_new_string", "newString");
      const parameters = {
        oldSha256: oldIdentity.sha256,
        oldBytes: oldIdentity.bytes,
        newSha256: newIdentity.sha256,
        newBytes: newIdentity.bytes,
      };
      return specificOperation(invocation, {
        kind: "file_edit",
        targetType: "file_path",
        target,
        scope: scopeForPath(target),
        effect: "write",
        parameters,
        inputFingerprint: normalizedInputFingerprint({ target, parameters }),
        evidence: {
          targetArgument: "filePath",
          omittedArguments: ["oldString", "newString"],
        },
      });
    },
  };
}

export function grepRuleV1() {
  return {
    id: "filesystem.grep",
    version: "2.0.0",
    priority: 10,
    supportedTools: ["grep"],
    match: () => true,
    normalize(invocation) {
      const target = pathTarget(invocation.args?.path);
      if (!target) return fallback("missing_or_invalid_search_path", "path");
      const pattern = textIdentity(invocation.args?.pattern);
      if (!pattern) return fallback("missing_or_invalid_search_pattern", "pattern");
      const include = presentSelector(
        invocation.args,
        "include",
        (value) => typeof value === "string" && value.trim() !== "" && value.length <= 4096
      );
      if (!include.ok) return fallback("invalid_search_include", "include");
      const parameters = {
        patternSha256: pattern.sha256,
        patternBytes: pattern.bytes,
        include: include.value,
      };
      return specificOperation(invocation, {
        kind: "content_search",
        targetType: "search_path",
        target,
        scope: scopeForPath(target),
        effect: "read",
        parameters,
        inputFingerprint: normalizedInputFingerprint({ target, parameters }),
        evidence: {
          targetArgument: "path",
          omittedArguments: ["pattern"],
          parameterArguments: ["include"],
        },
      });
    },
  };
}
