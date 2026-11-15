import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyInvocation } from "./classify.mjs";

export function measureInvocation(invocation) {
  const { startedAtMs, rawFinishedAtMs, status } = invocation;
  const reasons = [];
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) reasons.push("invalid_start");
  if (!Number.isFinite(rawFinishedAtMs) || rawFinishedAtMs <= 0) reasons.push("missing_finish");
  if (
    Number.isFinite(rawFinishedAtMs) &&
    Number.isFinite(startedAtMs) &&
    rawFinishedAtMs <= startedAtMs
  )
    reasons.push("nonpositive_interval");
  if (!["completed", "error"].includes(status)) reasons.push("nonterminal_status");
  return {
    observedToolElapsedMs: reasons.length ? null : rawFinishedAtMs - startedAtMs,
    timingQuality: reasons.length ? "unmeasurable" : "uncalibrated_cross_clock_proxy",
    exclusionReasons: reasons,
  };
}

export function buildLedger(ir, context, bundleDir) {
  const sessions = new Map(ir.sessions.map((s) => [s.sessionId, s]));
  const sourceFile = join(bundleDir, "normalized/events.jsonl");
  const lines = new Map();
  readFileSync(sourceFile, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      lines.set(`${event.sessionId}:${event.id}`, index + 1);
    });
  return ir.toolInvocations.map((invocation) => {
    const session = sessions.get(invocation.sessionId);
    return {
      ...context,
      invocationId: invocation.invocationId,
      sessionId: invocation.sessionId,
      parentSessionId: session.parentSessionId,
      role: session.parentSessionId === null ? "parent" : "child",
      spawnDepth: session.spawnDepth,
      messageId: invocation.messageId,
      callId: invocation.callId,
      tool: invocation.tool,
      status: invocation.status,
      startedAtMs: invocation.startedAtMs,
      rawFinishedAtMs: invocation.rawFinishedAtMs,
      ...measureInvocation(invocation),
      ...classifyInvocation(invocation.tool, invocation.args),
      // Previews omit raw arguments, paths and payloads; use this exact event link for inspection.
      preview: invocation.tool === "bash" ? "bash (see source event)" : invocation.tool,
      source: {
        file: sourceFile,
        line: lines.get(invocation.invocationId),
        eventId: invocation.sourceEventId,
      },
    };
  });
}
