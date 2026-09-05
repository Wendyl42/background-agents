import { operationNormalizationStatus } from "./operations.mjs";

function sandboxTimestampMs(timestamp) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  return timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

function buildToolInvocation(event) {
  const startedAtMs = event.createdAt;
  const rawFinishedAtMs = sandboxTimestampMs(event.data?.timestamp);
  let finishedAtMs = rawFinishedAtMs;
  let timingQuality = "sandbox_final_timestamp";
  let timingRepair = null;

  if (!Number.isFinite(startedAtMs)) {
    throw new Error(`Tool event ${event.id} has invalid createdAt`);
  }
  if (finishedAtMs === null) {
    finishedAtMs = startedAtMs + 1;
    timingQuality = "synthetic_minimum_interval";
    timingRepair = "missing_final_timestamp";
  } else if (finishedAtMs <= startedAtMs) {
    finishedAtMs = startedAtMs + 1;
    timingQuality = "clamped_sandbox_timestamp";
    timingRepair = "final_timestamp_not_after_created_at";
  }

  return {
    invocationId: `${event.sessionId}:${event.id}`,
    sourceEventId: event.id,
    sessionId: event.sessionId,
    messageId: event.messageId ?? event.data?.messageId ?? null,
    callId: event.data?.callId ?? null,
    tool: event.data?.tool ?? "unknown",
    args: event.data?.args ?? {},
    output: event.data?.output ?? null,
    status: event.data?.status ?? null,
    startedAtMs,
    finishedAtMs,
    rawFinishedAtMs,
    timingQuality,
    timingRepair,
    operations: [],
  };
}

function buildMessage(message) {
  return {
    messageId: message.id,
    sessionId: message.sessionId,
    status: message.status,
    source: message.source,
    createdAtMs: message.createdAt,
    startedAtMs: message.startedAt,
    completedAtMs: message.completedAt,
    content: message.content,
  };
}

export function buildIntermediateRepresentation(bundle, validation) {
  const toolInvocations = bundle.events
    .filter((event) => event.type === "tool_call")
    .map(buildToolInvocation)
    .sort(
      (left, right) =>
        left.startedAtMs - right.startedAtMs || left.invocationId.localeCompare(right.invocationId)
    );
  const messages = bundle.messages.map(buildMessage).sort((left, right) => {
    return left.createdAtMs - right.createdAtMs || left.messageId.localeCompare(right.messageId);
  });

  const sessions = [...bundle.sessions]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((session) => {
      const sessionEvents = bundle.events.filter((event) => event.sessionId === session.id);
      const readyEvents = sessionEvents
        .filter((event) => event.type === "ready")
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      return {
        sessionId: session.id,
        parentSessionId: session.parentSessionId,
        spawnDepth: session.spawnDepth,
        title: session.title,
        status: session.status,
        repoOwner: session.repoOwner,
        repoName: session.repoName,
        model: session.model,
        createdAtMs: session.createdAt,
        updatedAtMs: session.updatedAt,
        activeDurationMs: session.activeDurationMs ?? null,
        totalCost: session.totalCost ?? null,
        messages: messages.filter((message) => message.sessionId === session.id),
        readyEvents: readyEvents.map((event) => ({
          eventId: event.id,
          createdAtMs: event.createdAt,
          sandboxId: event.data?.sandboxId ?? null,
          sandboxTimestampMs: sandboxTimestampMs(event.data?.timestamp),
        })),
        toolInvocations: toolInvocations.filter(
          (invocation) => invocation.sessionId === session.id
        ),
        eventCount: sessionEvents.length,
      };
    });

  return {
    irSchemaVersion: "openinspect-trace-ir-block-ab-v0",
    inputFingerprint: bundle.inputFingerprint,
    source: bundle.manifest.source,
    rootSessionIds: validation.rootSessionIds,
    sessions,
    messages,
    toolInvocations,
    operations: [],
    operationNormalization: operationNormalizationStatus(toolInvocations.length),
    missingness: bundle.missingness,
  };
}
