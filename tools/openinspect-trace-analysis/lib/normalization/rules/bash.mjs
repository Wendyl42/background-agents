import { posix } from "node:path";
import { sha256Bytes } from "../../hash.mjs";
import { extractShellSegments } from "../shell-extractor.mjs";

function normalizedWorkdir(value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) return null;
  return posix.normalize(value.trim());
}

export function bashRule() {
  return {
    id: "shell.segment",
    version: "1.0.0",
    priority: 20,
    supportedTools: ["bash"],
    match: () => true,
    normalize(invocation) {
      const extracted = extractShellSegments(invocation.args?.command);
      if (!extracted.ok) {
        return { status: "fallback", operations: [], diagnostics: extracted.diagnostics };
      }
      const workdir = normalizedWorkdir(invocation.args?.workdir);
      return {
        status: "syntactic",
        diagnostics: extracted.diagnostics,
        operations: extracted.segments.map((item, index) => ({
          kind: "shell_segment",
          targetType: "shell_command",
          target: item.segment,
          scope: workdir ? "explicit_workdir" : "invocation_default",
          effect: "unknown",
          inputFingerprint: sha256Bytes(Buffer.from(item.segment)),
          normalizationLevel: "syntactic",
          confidence: "high",
          evidence: {
            sourceEventId: invocation.sourceEventId,
            sourceSessionId: invocation.sessionId,
            commandArgument: "command",
            segmentIndex: index,
            separatorBefore: item.separatorBefore,
            ...(workdir ? { workdir } : {}),
          },
          diagnostics: {
            pipelinePreserved: item.pipelinePreserved,
          },
        })),
      };
    },
  };
}
