import { normalizedInputFingerprint, textIdentity } from "../inputs.mjs";

function validString(value, { max = 4096, nonEmpty = true } = {}) {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    value.length <= max &&
    (!nonEmpty || value.trim() !== "")
  );
}

function validChildId(value) {
  return validString(value, { max: 256 }) && /^[A-Za-z0-9_-]+$/.test(value);
}

function fallback(code, argument) {
  return { status: "fallback", operations: [], diagnostics: [{ code, argument }] };
}

function presentParameter(args, key, validate) {
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

function promptParameters(prompt) {
  const identity = textIdentity(prompt);
  return identity ? { promptSha256: identity.sha256, promptBytes: identity.bytes } : null;
}

export function spawnChildRuleV1() {
  return {
    id: "coordination.spawn-child",
    version: "1.0.0",
    priority: 10,
    supportedTools: ["spawn-child"],
    match: () => true,
    normalize(invocation) {
      if (!validString(invocation.args?.title, { max: 1024 })) {
        return fallback("missing_or_invalid_child_title", "title");
      }
      const target = invocation.args.title.trim().replace(/\s+/g, " ");
      if (!validString(invocation.args?.prompt, { max: 1_000_000 })) {
        return fallback("missing_or_invalid_child_prompt", "prompt");
      }
      const parameters = promptParameters(invocation.args.prompt);
      return specificOperation(invocation, {
        kind: "child_spawn_request",
        targetType: "child_title",
        target,
        scope: "coordination",
        effect: "coordination",
        parameters,
        inputFingerprint: normalizedInputFingerprint({ target, parameters }),
        evidence: {
          targetArgument: "title",
          omittedArguments: ["prompt"],
          outcomeParsing: "not_implemented",
        },
      });
    },
  };
}

export function getChildStatusRuleV1() {
  return {
    id: "coordination.get-child-status",
    version: "1.0.0",
    priority: 10,
    supportedTools: ["get-child-status"],
    match: () => true,
    normalize(invocation) {
      const hasChildId = Object.hasOwn(invocation.args ?? {}, "childId");
      if (hasChildId && !validChildId(invocation.args.childId)) {
        return fallback("invalid_child_id", "childId");
      }
      const includeResponse = presentParameter(
        invocation.args,
        "includeResponse",
        (value) => typeof value === "boolean"
      );
      if (!includeResponse.ok) return fallback("invalid_include_response", "includeResponse");
      const includeTrajectory = presentParameter(
        invocation.args,
        "includeTrajectory",
        (value) => typeof value === "boolean"
      );
      if (!includeTrajectory.ok) {
        return fallback("invalid_include_trajectory", "includeTrajectory");
      }
      const trajectoryLimit = presentParameter(
        invocation.args,
        "trajectoryLimit",
        (value) => Number.isInteger(value) && value > 0
      );
      if (!trajectoryLimit.ok) return fallback("invalid_trajectory_limit", "trajectoryLimit");
      const target = hasChildId ? invocation.args.childId.trim() : "all_children";
      const parameters = {
        includeResponse: includeResponse.value,
        includeTrajectory: includeTrajectory.value,
        trajectoryLimit: trajectoryLimit.value,
      };
      return specificOperation(invocation, {
        kind: "child_status_read",
        targetType: hasChildId ? "child_session" : "child_collection",
        target,
        scope: "coordination",
        effect: "read",
        parameters,
        inputFingerprint: normalizedInputFingerprint({ target, parameters }),
        evidence: {
          targetArgument: hasChildId ? "childId" : null,
          parameterArguments: ["includeResponse", "includeTrajectory", "trajectoryLimit"],
          outcomeParsing: "not_implemented",
        },
      });
    },
  };
}

export function sendChildPromptRuleV1() {
  return {
    id: "coordination.send-child-prompt",
    version: "1.0.0",
    priority: 10,
    supportedTools: ["send-child-prompt"],
    match: () => true,
    normalize(invocation) {
      if (!validChildId(invocation.args?.childId)) {
        return fallback("missing_or_invalid_child_id", "childId");
      }
      if (!validString(invocation.args?.prompt, { max: 1_000_000 })) {
        return fallback("missing_or_invalid_child_prompt", "prompt");
      }
      const target = invocation.args.childId.trim();
      const parameters = promptParameters(invocation.args.prompt);
      return specificOperation(invocation, {
        kind: "child_prompt_request",
        targetType: "child_session",
        target,
        scope: "coordination",
        effect: "coordination",
        parameters,
        inputFingerprint: normalizedInputFingerprint({ target, parameters }),
        evidence: {
          targetArgument: "childId",
          omittedArguments: ["prompt"],
          outcomeParsing: "not_implemented",
        },
      });
    },
  };
}

export function coordinationRulesV1() {
  return [spawnChildRuleV1(), getChildStatusRuleV1(), sendChildPromptRuleV1()];
}
