export function computeTopology(ir) {
  const sessions = ir.sessions;
  const childrenByParent = new Map(sessions.map((session) => [session.sessionId, []]));
  for (const session of sessions) {
    if (session.parentSessionId !== null) {
      childrenByParent.get(session.parentSessionId)?.push(session);
    }
  }

  const nodes = sessions.map((session) => {
    const children = [...(childrenByParent.get(session.sessionId) ?? [])].sort(
      (left, right) =>
        left.createdAtMs - right.createdAtMs || left.sessionId.localeCompare(right.sessionId)
    );
    return {
      sessionId: session.sessionId,
      parentSessionId: session.parentSessionId,
      spawnDepth: session.spawnDepth,
      title: session.title,
      childIds: children.map((child) => child.sessionId),
      outDegree: children.length,
    };
  });

  const roots = nodes.filter((node) => node.parentSessionId === null);
  return {
    rootSessionIds: roots.map((root) => root.sessionId).sort(),
    nodeCount: nodes.length,
    edgeCount: nodes.length - roots.length,
    maxSpawnDepth: Math.max(...nodes.map((node) => node.spawnDepth), 0),
    rootOutDegree: roots.reduce((total, root) => total + root.outDegree, 0),
    leafCount: nodes.filter((node) => node.outDegree === 0).length,
    nodes,
  };
}
