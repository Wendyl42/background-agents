function minimum(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length > 0 ? Math.min(...finite) : null;
}

function maximum(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length > 0 ? Math.max(...finite) : null;
}

function duration(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function messageTiming(message) {
  return {
    messageId: message.messageId,
    status: message.status,
    createdAtMs: message.createdAtMs,
    startedAtMs: message.startedAtMs,
    completedAtMs: message.completedAtMs,
    queueWaitMs: duration(message.createdAtMs, message.startedAtMs),
    executionDurationMs: duration(message.startedAtMs, message.completedAtMs),
  };
}

export function computeLifecycle(ir) {
  const roots = ir.sessions.filter((session) => session.parentSessionId === null);
  const rootReferenceCandidates = roots.flatMap((session) =>
    session.messages.map((message) => message.startedAtMs)
  );
  const referenceTimeMs =
    minimum(rootReferenceCandidates) ?? minimum(roots.map((session) => session.createdAtMs));

  const sessions = ir.sessions.map((session) => {
    const firstReadyAtMs = minimum(session.readyEvents.map((event) => event.createdAtMs));
    const firstMessageCreatedAtMs = minimum(session.messages.map((message) => message.createdAtMs));
    const firstMessageStartedAtMs = minimum(session.messages.map((message) => message.startedAtMs));
    const lastMessageCompletedAtMs = maximum(
      session.messages.map((message) => message.completedAtMs)
    );
    const firstToolStartedAtMs = minimum(
      session.toolInvocations.map((invocation) => invocation.startedAtMs)
    );
    const lastToolFinishedAtMs = maximum(
      session.toolInvocations.map((invocation) => invocation.finishedAtMs)
    );
    const timingRepairCounts = session.toolInvocations.reduce((counts, invocation) => {
      if (invocation.timingRepair) {
        counts[invocation.timingRepair] = (counts[invocation.timingRepair] ?? 0) + 1;
      }
      return counts;
    }, {});

    return {
      sessionId: session.sessionId,
      parentSessionId: session.parentSessionId,
      spawnDepth: session.spawnDepth,
      title: session.title,
      status: session.status,
      createdAtMs: session.createdAtMs,
      updatedAtMs: session.updatedAtMs,
      firstReadyAtMs,
      platformReadyLatencyMs: duration(session.createdAtMs, firstReadyAtMs),
      firstMessageCreatedAtMs,
      firstMessageStartedAtMs,
      lastMessageCompletedAtMs,
      firstToolStartedAtMs,
      lastToolFinishedAtMs,
      messageCount: session.messages.length,
      toolInvocationCount: session.toolInvocations.length,
      readyEventCount: session.readyEvents.length,
      uniqueSandboxIds: [
        ...new Set(session.readyEvents.map((event) => event.sandboxId).filter(Boolean)),
      ].sort(),
      activeDurationMs: session.activeDurationMs,
      totalCost: session.totalCost,
      messages: session.messages.map(messageTiming),
      timingRepairCounts: Object.fromEntries(Object.entries(timingRepairCounts).sort()),
    };
  });

  const allMessages = sessions.flatMap((session) => session.messages);
  const nonRootSessions = sessions.filter((session) => session.parentSessionId !== null);
  return {
    reference: {
      kind: rootReferenceCandidates.some(Number.isFinite)
        ? "first_root_message_started"
        : "root_session_created",
      timestampMs: referenceTimeMs,
    },
    run: {
      firstSessionCreatedAtMs: minimum(sessions.map((session) => session.createdAtMs)),
      firstMessageStartedAtMs: minimum(allMessages.map((message) => message.startedAtMs)),
      lastMessageCompletedAtMs: maximum(allMessages.map((message) => message.completedAtMs)),
      firstChildCreatedAtMs: minimum(nonRootSessions.map((session) => session.createdAtMs)),
      lastChildCompletedAtMs: maximum(
        nonRootSessions.map((session) => session.lastMessageCompletedAtMs)
      ),
      aggregateMessageExecutionMs: allMessages.reduce(
        (total, message) => total + (message.executionDurationMs ?? 0),
        0
      ),
      aggregatePlatformReadyLatencyMs: nonRootSessions.reduce(
        (total, session) => total + (session.platformReadyLatencyMs ?? 0),
        0
      ),
      toolTimingRepairCount: sessions.reduce(
        (total, session) =>
          total + Object.values(session.timingRepairCounts).reduce((sum, count) => sum + count, 0),
        0
      ),
    },
    sessions,
  };
}
