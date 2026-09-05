import { TIMING_DEFINITIONS } from "./constants.mjs";

function validIntervals(intervals) {
  return intervals
    .filter(
      (interval) =>
        Number.isFinite(interval.startMs) &&
        Number.isFinite(interval.endMs) &&
        interval.endMs > interval.startMs
    )
    .sort(
      (left, right) =>
        left.startMs - right.startMs ||
        left.endMs - right.endMs ||
        left.intervalId.localeCompare(right.intervalId)
    );
}

export function sweepConcurrency(inputIntervals) {
  const intervals = validIntervals(inputIntervals);
  if (intervals.length === 0) {
    return {
      intervalCount: 0,
      participatingSessionCount: 0,
      spanMs: 0,
      activeWallMs: 0,
      intervalIntegralMs: 0,
      sessionIntegralMs: 0,
      peakConcurrentIntervals: 0,
      peakConcurrentSessions: 0,
      meanConcurrentIntervalsOverSpan: 0,
      meanConcurrentSessionsOverSpan: 0,
      meanConcurrentIntervalsWhileActive: 0,
      meanConcurrentSessionsWhileActive: 0,
      peakIntervalSegments: [],
      peakSessionSegments: [],
    };
  }

  const changes = new Map();
  const addChange = (time, kind, interval) => {
    const change = changes.get(time) ?? { starts: [], ends: [] };
    change[kind].push(interval);
    changes.set(time, change);
  };
  for (const interval of intervals) {
    addChange(interval.startMs, "starts", interval);
    addChange(interval.endMs, "ends", interval);
  }

  const times = [...changes.keys()].sort((left, right) => left - right);
  const activeIntervals = new Set();
  const activeSessionCounts = new Map();
  const segments = [];
  let intervalIntegralMs = 0;
  let sessionIntegralMs = 0;
  let activeWallMs = 0;

  for (let index = 0; index < times.length - 1; index += 1) {
    const time = times[index];
    const next = times[index + 1];
    const change = changes.get(time);

    // Half-open semantics: intervals ending at time are inactive for [time, next).
    for (const interval of change.ends) {
      activeIntervals.delete(interval.intervalId);
      const count = (activeSessionCounts.get(interval.sessionId) ?? 0) - 1;
      if (count <= 0) activeSessionCounts.delete(interval.sessionId);
      else activeSessionCounts.set(interval.sessionId, count);
    }
    for (const interval of change.starts) {
      activeIntervals.add(interval.intervalId);
      activeSessionCounts.set(
        interval.sessionId,
        (activeSessionCounts.get(interval.sessionId) ?? 0) + 1
      );
    }

    const durationMs = next - time;
    const concurrentIntervals = activeIntervals.size;
    const concurrentSessions = activeSessionCounts.size;
    intervalIntegralMs += concurrentIntervals * durationMs;
    sessionIntegralMs += concurrentSessions * durationMs;
    if (concurrentIntervals > 0) activeWallMs += durationMs;
    segments.push({ startMs: time, endMs: next, concurrentIntervals, concurrentSessions });
  }

  const spanMs = times.at(-1) - times[0];
  const peakConcurrentIntervals = Math.max(
    ...segments.map((segment) => segment.concurrentIntervals)
  );
  const peakConcurrentSessions = Math.max(...segments.map((segment) => segment.concurrentSessions));
  const peakIntervalSegments = segments.filter(
    (segment) =>
      segment.concurrentIntervals === peakConcurrentIntervals && peakConcurrentIntervals > 0
  );
  const peakSessionSegments = segments.filter(
    (segment) => segment.concurrentSessions === peakConcurrentSessions && peakConcurrentSessions > 0
  );

  return {
    intervalCount: intervals.length,
    participatingSessionCount: new Set(intervals.map((interval) => interval.sessionId)).size,
    spanMs,
    activeWallMs,
    intervalIntegralMs,
    sessionIntegralMs,
    peakConcurrentIntervals,
    peakConcurrentSessions,
    meanConcurrentIntervalsOverSpan: spanMs ? intervalIntegralMs / spanMs : 0,
    meanConcurrentSessionsOverSpan: spanMs ? sessionIntegralMs / spanMs : 0,
    meanConcurrentIntervalsWhileActive: activeWallMs ? intervalIntegralMs / activeWallMs : 0,
    meanConcurrentSessionsWhileActive: activeWallMs ? sessionIntegralMs / activeWallMs : 0,
    peakIntervalSegments,
    peakSessionSegments,
  };
}

function messageIntervals(ir, childOnly) {
  const childIds = new Set(
    ir.sessions
      .filter((session) => session.parentSessionId !== null)
      .map((session) => session.sessionId)
  );
  return ir.messages
    .filter((message) => !childOnly || childIds.has(message.sessionId))
    .map((message) => ({
      intervalId: `${message.sessionId}:message:${message.messageId}`,
      sessionId: message.sessionId,
      startMs: message.startedAtMs,
      endMs: message.completedAtMs,
    }));
}

function setupIntervals(ir) {
  return ir.sessions
    .filter((session) => session.parentSessionId !== null && session.readyEvents.length > 0)
    .map((session) => ({
      intervalId: `${session.sessionId}:platform-setup`,
      sessionId: session.sessionId,
      startMs: session.createdAtMs,
      endMs: session.readyEvents[0].createdAtMs,
    }));
}

function toolIntervals(ir) {
  const childIds = new Set(
    ir.sessions
      .filter((session) => session.parentSessionId !== null)
      .map((session) => session.sessionId)
  );
  return ir.toolInvocations
    .filter((invocation) => childIds.has(invocation.sessionId))
    .map((invocation) => ({
      intervalId: invocation.invocationId,
      sessionId: invocation.sessionId,
      startMs: invocation.startedAtMs,
      endMs: invocation.finishedAtMs,
    }));
}

function withDefinition(name, result) {
  return { definition: TIMING_DEFINITIONS[name], ...result };
}

export function computeConcurrency(ir) {
  return {
    allMessageExecutions: withDefinition(
      "allMessageExecutions",
      sweepConcurrency(messageIntervals(ir, false))
    ),
    childMessageExecutions: withDefinition(
      "childMessageExecutions",
      sweepConcurrency(messageIntervals(ir, true))
    ),
    childPlatformSetup: withDefinition("childPlatformSetup", sweepConcurrency(setupIntervals(ir))),
    childToolInvocations: withDefinition(
      "childToolInvocations",
      sweepConcurrency(toolIntervals(ir))
    ),
  };
}
