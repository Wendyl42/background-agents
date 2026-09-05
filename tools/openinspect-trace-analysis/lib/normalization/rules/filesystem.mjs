import { posix } from "node:path";
import { sha256Bytes } from "../../hash.mjs";

function validString(value) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !value.includes("\0") &&
    value.length <= 4096
  );
}

function pathTarget(value) {
  if (!validString(value)) return null;
  return posix.normalize(value.trim());
}

function scopeForPath(value) {
  return value.startsWith("/") ? "absolute_path" : "invocation_relative";
}

function fallback(code, argument) {
  return { status: "fallback", operations: [], diagnostics: [{ code, argument }] };
}

function operation(invocation, kind, targetType, target, effect, targetArgument, extra = {}) {
  return {
    status: "specific",
    diagnostics: [],
    operations: [
      {
        kind,
        targetType,
        target,
        scope: scopeForPath(target),
        effect,
        inputFingerprint: extra.inputFingerprint ?? null,
        normalizationLevel: "specific",
        confidence: "high",
        evidence: {
          sourceEventId: invocation.sourceEventId,
          sourceSessionId: invocation.sessionId,
          targetArgument,
          ...(extra.evidence ?? {}),
        },
        diagnostics: {},
      },
    ],
  };
}

function readRule() {
  return {
    id: "filesystem.read",
    version: "1.0.0",
    priority: 10,
    supportedTools: ["read"],
    match: () => true,
    normalize(invocation) {
      const target = pathTarget(invocation.args?.filePath);
      return target
        ? operation(invocation, "file_read", "file_path", target, "read", "filePath")
        : fallback("missing_or_invalid_file_path", "filePath");
    },
  };
}

export function globRule() {
  return {
    id: "filesystem.glob",
    version: "1.0.0",
    priority: 10,
    supportedTools: ["glob"],
    match: () => true,
    normalize(invocation) {
      const pattern = invocation.args?.pattern;
      if (!validString(pattern)) return fallback("missing_or_invalid_glob_pattern", "pattern");
      const target = pattern.trim();
      return operation(invocation, "file_glob", "glob_pattern", target, "read", "pattern", {
        inputFingerprint: sha256Bytes(Buffer.from(target)),
      });
    },
  };
}

export function grepRule() {
  return {
    id: "filesystem.grep",
    version: "1.0.0",
    priority: 10,
    supportedTools: ["grep"],
    match: () => true,
    normalize(invocation) {
      const target = pathTarget(invocation.args?.path);
      if (!target) return fallback("missing_or_invalid_search_path", "path");
      const pattern = invocation.args?.pattern;
      if (!validString(pattern)) return fallback("missing_or_invalid_search_pattern", "pattern");
      const fingerprintSource = JSON.stringify({
        pattern,
        include: validString(invocation.args?.include) ? invocation.args.include : null,
      });
      return operation(invocation, "content_search", "search_path", target, "read", "path", {
        inputFingerprint: sha256Bytes(Buffer.from(fingerprintSource)),
        evidence: { queryArgument: "pattern", includeArgument: "include" },
      });
    },
  };
}

function writeRule() {
  return {
    id: "filesystem.write",
    version: "1.0.0",
    priority: 10,
    supportedTools: ["write"],
    match: () => true,
    normalize(invocation) {
      const target = pathTarget(invocation.args?.filePath);
      return target
        ? operation(invocation, "file_write", "file_path", target, "write", "filePath", {
            evidence: { omittedArguments: ["content"] },
          })
        : fallback("missing_or_invalid_file_path", "filePath");
    },
  };
}

export function filesystemRules() {
  return [readRule(), globRule(), grepRule(), writeRule()];
}
