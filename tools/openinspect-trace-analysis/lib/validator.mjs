import { TraceValidationError } from "./errors.mjs";

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function countBy(values, key) {
  const counts = {};
  for (const value of values) {
    const item = value?.[key];
    counts[item] = (counts[item] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function compareIdSets(label, reportedIds, actualIds, errors) {
  const reportedSet = new Set(reportedIds);
  const actualSet = new Set(actualIds);
  const missing = [...actualSet].filter((id) => !reportedSet.has(id)).sort();
  const extra = [...reportedSet].filter((id) => !actualSet.has(id)).sort();
  if (missing.length > 0 || extra.length > 0) {
    errors.push(
      `${label} session ID set does not match raw/session-index.json` +
        ` (missing=[${missing.join(",")}], extra=[${extra.join(",")}])`
    );
  }
}

function validateTopology(sessions, errors) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = sessions.filter((session) => session.parentSessionId === null);
  for (const session of sessions) {
    if (session.parentSessionId !== null && !byId.has(session.parentSessionId)) {
      errors.push(`Session ${session.id} references missing parent ${session.parentSessionId}`);
      continue;
    }
    if (session.parentSessionId !== null) {
      const parent = byId.get(session.parentSessionId);
      if (Number.isInteger(parent?.spawnDepth) && session.spawnDepth !== parent.spawnDepth + 1) {
        errors.push(
          `Session ${session.id} spawnDepth=${session.spawnDepth} does not follow parent ` +
            `${parent.id} spawnDepth=${parent.spawnDepth}`
        );
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      errors.push(`Topology cycle detected at session ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const parentId = byId.get(id)?.parentSessionId;
    if (parentId && byId.has(parentId)) visit(parentId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const session of sessions) visit(session.id);
  return roots;
}

export function validateTraceBundle(bundle, { throwOnError = true } = {}) {
  const errors = [];
  const warnings = [];
  const sessions = Array.isArray(bundle.sessions) ? bundle.sessions : [];
  const events = Array.isArray(bundle.events) ? bundle.events : [];
  const messages = Array.isArray(bundle.messages) ? bundle.messages : [];

  if (!Array.isArray(bundle.sessions))
    errors.push("raw/session-index.json must contain sessions[]");
  if (sessions.length === 0) errors.push("Trace bundle contains no sessions");

  const sessionIds = sessions.map((session) => session?.id);
  for (const duplicate of duplicateValues(sessionIds)) {
    errors.push(`Duplicate session ID: ${duplicate}`);
  }
  const sessionIdSet = new Set(sessionIds);
  const roots = validateTopology(sessions, errors);
  if (bundle.manifest?.schemaVersion === "openinspect-trace-v0" && roots.length !== 1) {
    errors.push(`openinspect-trace-v0 requires exactly one topology root (found ${roots.length})`);
  }
  if (roots.length === 1) {
    const actualRootId = roots[0].id;
    const manifestRootId = bundle.manifest?.source?.rootSessionId;
    const completenessRootId = bundle.completeness?.rootSessionId;
    if (manifestRootId !== actualRootId) {
      errors.push(
        `manifest.source.rootSessionId=${String(manifestRootId)} does not match topology root ${actualRootId}`
      );
    }
    if (completenessRootId !== actualRootId) {
      errors.push(
        `completeness.rootSessionId=${String(completenessRootId)} does not match topology root ${actualRootId}`
      );
    }
  }

  const eventCompositeIds = [];
  for (const event of events) {
    if (!sessionIdSet.has(event?.sessionId)) {
      errors.push(
        `Event ${String(event?.id)} references unknown session ${String(event?.sessionId)}`
      );
    }
    eventCompositeIds.push(`${event?.sessionId}:${event?.id}`);
  }
  for (const duplicate of duplicateValues(eventCompositeIds)) {
    errors.push(`Duplicate composite event ID: ${duplicate}`);
  }

  const messageCompositeIds = [];
  for (const message of messages) {
    if (!sessionIdSet.has(message?.sessionId)) {
      errors.push(
        `Message ${String(message?.id)} references unknown session ${String(message?.sessionId)}`
      );
    }
    messageCompositeIds.push(`${message?.sessionId}:${message?.id}`);
  }
  for (const duplicate of duplicateValues(messageCompositeIds)) {
    errors.push(`Duplicate composite message ID: ${duplicate}`);
  }

  const manifestCounts = bundle.manifest?.counts ?? {};
  const completeness = bundle.completeness ?? {};
  const actualCounts = {
    sessions: sessions.length,
    events: events.length,
    messages: messages.length,
  };
  for (const [key, actual] of Object.entries(actualCounts)) {
    if (manifestCounts[key] !== actual) {
      errors.push(`manifest counts.${key}=${manifestCounts[key]} does not match actual ${actual}`);
    }
  }
  if (completeness.sessionCount !== sessions.length) {
    errors.push("completeness sessionCount does not match actual sessions");
  }
  if (completeness.eventCount !== events.length) {
    errors.push("completeness eventCount does not match actual events");
  }
  if (completeness.messageCount !== messages.length) {
    errors.push("completeness messageCount does not match actual messages");
  }
  const eventCountsBySession = countBy(events, "sessionId");
  const messageCountsBySession = countBy(messages, "sessionId");
  if (Array.isArray(completeness.sessions)) {
    const reportedIds = completeness.sessions.map((entry) => entry.sessionId);
    for (const duplicate of duplicateValues(reportedIds)) {
      errors.push(`Duplicate completeness session entry: ${duplicate}`);
    }
    compareIdSets("completeness.sessions", reportedIds, sessionIds, errors);
    for (const entry of completeness.sessions) {
      if (!sessionIdSet.has(entry.sessionId)) {
        errors.push(`Completeness references unknown session ${entry.sessionId}`);
        continue;
      }
      if (entry.eventCount !== (eventCountsBySession[entry.sessionId] ?? 0)) {
        errors.push(`Completeness eventCount mismatch for session ${entry.sessionId}`);
      }
      if (entry.messageCount !== (messageCountsBySession[entry.sessionId] ?? 0)) {
        errors.push(`Completeness messageCount mismatch for session ${entry.sessionId}`);
      }
    }
  } else {
    errors.push("completeness.sessions must be an array");
  }

  if (completeness.sessionIds !== undefined) {
    if (!Array.isArray(completeness.sessionIds)) {
      errors.push("completeness.sessionIds must be an array when present");
    } else {
      for (const duplicate of duplicateValues(completeness.sessionIds)) {
        errors.push(`Duplicate completeness.sessionIds entry: ${duplicate}`);
      }
      compareIdSets("completeness.sessionIds", completeness.sessionIds, sessionIds, errors);
    }
  }

  const eventTypes = countBy(events, "type");
  if (JSON.stringify(eventTypes) !== JSON.stringify(completeness.eventTypes ?? {})) {
    errors.push("Completeness eventTypes does not match normalized events");
  }

  for (const session of sessions) {
    const readyCount = events.filter(
      (event) => event.sessionId === session.id && event.type === "ready"
    ).length;
    if (readyCount === 0) warnings.push(`Session ${session.id} has no persisted ready event`);
    if ((messageCountsBySession[session.id] ?? 0) === 0) {
      warnings.push(`Session ${session.id} has no normalized messages`);
    }
  }

  const result = {
    valid: errors.length === 0,
    errors,
    warnings: [...new Set(warnings)].sort(),
    verifiedFileCount: bundle.verifiedFiles.length,
    counts: actualCounts,
    rootSessionIds: roots.map((root) => root.id).sort(),
    eventTypes,
  };
  if (!result.valid && throwOnError) throw new TraceValidationError(errors, result.warnings);
  return result;
}
