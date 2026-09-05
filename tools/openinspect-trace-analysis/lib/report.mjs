function text(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function milliseconds(value) {
  return Number.isFinite(value) ? `${(value / 1000).toFixed(3)}s` : "—";
}

function relative(value, reference) {
  return Number.isFinite(value) && Number.isFinite(reference)
    ? `${((value - reference) / 1000).toFixed(3)}s`
    : "—";
}

function number(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(text).join(" | ")} |`),
  ].join("\n");
}

function renderWarnings(warnings) {
  if (warnings.length === 0) return "- None.";
  return warnings.map((warning) => `- ${warning}`).join("\n");
}

function renderBlockABReport(summary) {
  const reference = summary.lifecycle.reference.timestampMs;
  const topologyRows = summary.topology.nodes.map((node) => [
    node.sessionId.slice(0, 8),
    node.parentSessionId?.slice(0, 8) ?? "ROOT",
    node.spawnDepth,
    node.outDegree,
    node.title,
  ]);
  const lifecycleRows = summary.lifecycle.sessions.map((session) => [
    session.sessionId.slice(0, 8),
    session.spawnDepth,
    relative(session.createdAtMs, reference),
    relative(session.firstReadyAtMs, reference),
    milliseconds(session.platformReadyLatencyMs),
    relative(session.firstMessageStartedAtMs, reference),
    relative(session.lastMessageCompletedAtMs, reference),
    session.messageCount,
    session.toolInvocationCount,
    session.uniqueSandboxIds.length,
  ]);
  const concurrencyRows = Object.entries(summary.concurrency).map(([name, metric]) => [
    name,
    metric.intervalCount,
    metric.participatingSessionCount,
    metric.peakConcurrentIntervals,
    metric.peakConcurrentSessions,
    milliseconds(metric.spanMs),
    number(metric.meanConcurrentIntervalsOverSpan),
    number(metric.meanConcurrentSessionsOverSpan),
  ]);

  return `# OpenInspect Trace Analysis — Block A + B

## Input and scope

- Root session: \`${summary.input.rootSessionId}\`
- Input fingerprint: \`${summary.input.fingerprint}\`
- Bundle schema: \`${summary.input.bundleSchemaVersion}\`
- Analysis schema: \`${summary.analysisSchemaVersion}\`
- Repository: ${text(summary.input.repository)}
- Raw unit: \`tool_invocation\`
- LLM used for parsing/statistics: **no**
- Normalized-operation rules: **not implemented (reserved for Block C)**
- Semantic redundancy/candidates/batch aggregation: **out of scope**

## Validation

- Valid: **${summary.validation.valid ? "yes" : "no"}**
- Verified hashed files: ${summary.validation.verifiedFileCount}
- Sessions: ${summary.validation.counts.sessions}
- Messages: ${summary.validation.counts.messages}
- Events: ${summary.validation.counts.events}

Warnings:

${renderWarnings(summary.validation.warnings)}

## Topology

- Roots: ${summary.topology.rootSessionIds.length}
- Nodes / edges: ${summary.topology.nodeCount} / ${summary.topology.edgeCount}
- Maximum spawn depth: ${summary.topology.maxSpawnDepth}
- Root out-degree: ${summary.topology.rootOutDegree}
- Leaves: ${summary.topology.leafCount}

${table(["Session", "Parent", "Depth", "Children", "Title"], topologyRows)}

## Lifecycle

Reference: \`${summary.lifecycle.reference.kind}\` at \`${summary.lifecycle.reference.timestampMs}\`.

${table(
  [
    "Session",
    "Depth",
    "Created t",
    "First ready t",
    "Ready latency",
    "First message t",
    "Last completion t",
    "Messages",
    "Tool calls",
    "Sandboxes",
  ],
  lifecycleRows
)}

Tool timing repairs: ${summary.lifecycle.run.toolTimingRepairCount}. Tool finish times use final persisted
sandbox timestamps and are lower-confidence than message lifecycle timestamps.

## Concurrency

${table(
  [
    "Definition",
    "Intervals",
    "Sessions",
    "Peak intervals",
    "Peak sessions",
    "Span",
    "Mean intervals",
    "Mean sessions",
  ],
  concurrencyRows
)}

Definitions:

${Object.entries(summary.concurrency)
  .map(([name, metric]) => `- \`${name}\`: ${metric.definition}`)
  .join("\n")}

## Intermediate representation checkpoint

- Tool invocations: ${summary.operationNormalization.toolInvocationCount}
- Normalized operations: ${summary.operationNormalization.normalizedOperationCount}
- Parser coverage: ${number(summary.operationNormalization.parserCoverage * 100, 1)}%
- Fallback/unparsed invocations: ${summary.operationNormalization.fallbackCount}

The 0% parser coverage is intentional in Block A + B; no operation rules are executed.

## Known evidence limits

${Object.entries(summary.missingness)
  .map(([key, value]) => `- \`${key}\`: ${value}`)
  .join("\n")}

## Checkpoint and next step

Block A measurement contract and Block B deterministic core are complete for this output. Stop here
before normalized-operation rules, semantic grouping, redundancy candidates, or batch aggregation.

Next:

${summary.checkpoint.nextSteps.map((step) => `1. ${step}`).join("\n")}
`;
}

function percentage(metric) {
  return `${metric.numerator}/${metric.denominator} (${number(metric.value * 100, 1)}%)`;
}

function renderBlockCReport(summary) {
  const reference = summary.lifecycle.reference.timestampMs;
  const topologyRows = summary.topology.nodes.map((node) => [
    node.sessionId.slice(0, 8),
    node.parentSessionId?.slice(0, 8) ?? "ROOT",
    node.spawnDepth,
    node.outDegree,
    node.title,
  ]);
  const lifecycleRows = summary.lifecycle.sessions.map((session) => [
    session.sessionId.slice(0, 8),
    session.spawnDepth,
    relative(session.createdAtMs, reference),
    relative(session.firstReadyAtMs, reference),
    milliseconds(session.platformReadyLatencyMs),
    relative(session.firstMessageStartedAtMs, reference),
    relative(session.lastMessageCompletedAtMs, reference),
    session.messageCount,
    session.toolInvocationCount,
    session.uniqueSandboxIds.length,
  ]);
  const concurrencyRows = Object.entries(summary.concurrency).map(([name, metric]) => [
    name,
    metric.intervalCount,
    metric.participatingSessionCount,
    metric.peakConcurrentIntervals,
    metric.peakConcurrentSessions,
    milliseconds(metric.spanMs),
    number(metric.meanConcurrentIntervalsOverSpan),
    number(metric.meanConcurrentSessionsOverSpan),
  ]);
  const coverage = summary.normalization.totals;
  const toolRows = summary.normalization.byTool.map((row) => [
    row.key,
    row.counts.total,
    row.counts.specific,
    row.counts.syntactic,
    row.counts.fallback,
    row.counts.error,
    `${number(row.specificCoverage.value * 100, 1)}%`,
    `${number(row.syntacticCoverage.value * 100, 1)}%`,
  ]);
  const parserRows = summary.normalization.byParser.map((row) => [
    row.key,
    row.counts.total,
    row.counts.specific,
    row.counts.syntactic,
    row.counts.fallback,
    row.counts.error,
  ]);
  const sessionRows = summary.normalization.bySession.map((row) => [
    row.key.slice(0, 8),
    row.counts.total,
    row.counts.specific,
    row.counts.syntactic,
    row.counts.fallback,
    row.counts.error,
    `${number(row.specificCoverage.value * 100, 1)}%`,
    `${number(row.syntacticCoverage.value * 100, 1)}%`,
  ]);
  const inventoryRows = summary.normalization.ruleInventory.map((rule) => [
    rule.id,
    rule.version,
    rule.priority,
    rule.supportedTools.join(", "),
    summary.normalization.usedRules.includes(`${rule.id}@${rule.version}`) ? "yes" : "no",
  ]);

  return `# OpenInspect Trace Analysis — Block C Normalization Foundation

## Input and scope

- Root session: \`${summary.input.rootSessionId}\`
- Input fingerprint: \`${summary.input.fingerprint}\`
- Analysis profile: \`${summary.analysisProfile}\`
- Bundle schema: \`${summary.input.bundleSchemaVersion}\`
- Analysis schema: \`${summary.analysisSchemaVersion}\`
- Ruleset: \`${summary.normalization.rulesetVersion}\`
- Repository: ${text(summary.input.repository)}
- Raw unit: \`tool_invocation\`
- LLM used for parsing/statistics: **no**
- Semantic grouping, candidate generation, eliminability, and batch aggregation: **not implemented**

## Validation

- Valid: **${summary.validation.valid ? "yes" : "no"}**
- Verified hashed files: ${summary.validation.verifiedFileCount}
- Sessions / messages / events: ${summary.validation.counts.sessions} / ${summary.validation.counts.messages} / ${summary.validation.counts.events}

Warnings:

${renderWarnings(summary.validation.warnings)}

## Topology

- Roots: ${summary.topology.rootSessionIds.length}
- Nodes / edges: ${summary.topology.nodeCount} / ${summary.topology.edgeCount}
- Maximum spawn depth: ${summary.topology.maxSpawnDepth}
- Root out-degree: ${summary.topology.rootOutDegree}

${table(["Session", "Parent", "Depth", "Children", "Title"], topologyRows)}

## Lifecycle

Reference: \`${summary.lifecycle.reference.kind}\` at \`${summary.lifecycle.reference.timestampMs}\`.

${table(
  [
    "Session",
    "Depth",
    "Created t",
    "First ready t",
    "Ready latency",
    "First message t",
    "Last completion t",
    "Messages",
    "Tool calls",
    "Sandboxes",
  ],
  lifecycleRows
)}

Tool timing repairs: ${summary.lifecycle.run.toolTimingRepairCount}. Timing and missingness retain the
Block A + B definitions.

## Concurrency

${table(
  [
    "Definition",
    "Intervals",
    "Sessions",
    "Peak intervals",
    "Peak sessions",
    "Span",
    "Mean intervals",
    "Mean sessions",
  ],
  concurrencyRows
)}

## Operation Normalization

- Total tool invocations: ${summary.operationNormalization.toolInvocationCount}
- Emitted operations: ${summary.operationNormalization.normalizedOperationCount}
- Specific: ${coverage.counts.specific}
- Syntactic: ${coverage.counts.syntactic}
- Fallback: ${coverage.counts.fallback}
- Error: ${coverage.counts.error}
- Specific coverage: ${percentage(coverage.specificCoverage)}
- Syntactic coverage: ${percentage(coverage.syntacticCoverage)}
- Parsed coverage: ${percentage(coverage.parsedCoverage)}
- Fallback rate: ${percentage(coverage.fallbackRate)}

Coverage definitions:

${Object.entries(summary.normalization.coverageDefinitions)
  .map(([key, value]) => `- \`${key}\`: ${value}`)
  .join("\n")}

Generic shell segmentation is always **syntactic**, never specific/target-aware coverage.

### By tool

${table(
  ["Tool", "Total", "Specific", "Syntactic", "Fallback", "Error", "Specific %", "Syntactic %"],
  toolRows
)}

### By parser

${table(["Parser", "Total", "Specific", "Syntactic", "Fallback", "Error"], parserRows)}

### By session

${table(
  ["Session", "Total", "Specific", "Syntactic", "Fallback", "Error", "Specific %", "Syntactic %"],
  sessionRows
)}

### Rule inventory

${table(["Rule", "Version", "Priority", "Tools", "Used"], inventoryRows)}

### Fallback tools

${
  summary.normalization.fallbackToolTopK.length > 0
    ? table(
        ["Tool", "Count"],
        summary.normalization.fallbackToolTopK.map((row) => [row.tool, row.count])
      )
    : "- None."
}

### Shell/parser diagnostics

${
  summary.normalization.diagnostics.length > 0
    ? table(
        ["Diagnostic", "Count"],
        summary.normalization.diagnostics.map((row) => [row.code, row.count])
      )
    : "- None."
}

## Known evidence limits

${Object.entries(summary.missingness)
  .map(([key, value]) => `- \`${key}\`: ${value}`)
  .join("\n")}

## Checkpoint and next step

Block C establishes deterministic operation normalization and parser coverage only. Stop before
semantic grouping, candidate generation, eliminability judgments, or batch aggregation.

Next:

${summary.checkpoint.nextSteps.map((step) => `1. ${step}`).join("\n")}
`;
}

function renderBlockC1Report(summary) {
  return renderBlockCReport(summary)
    .replace(
      "# OpenInspect Trace Analysis — Block C Normalization Foundation",
      "# OpenInspect Trace Analysis — Block C.1 Operation Identity Hardening"
    )
    .replace(
      "Generic shell segmentation is always **syntactic**, never specific/target-aware coverage.",
      `Generic shell segmentation is always **syntactic**, never specific/target-aware coverage.

### Operation input identity

- \`target\` identifies the normalized resource/request target.
- \`parameters\` contains bounded structural selectors or plaintext-free SHA-256/byte-length identities.
- \`inputFingerprint\` deterministically hashes the normalized target and relevant parameters.
- A matching fingerprint means matching normalized input identity under this ruleset; it does **not**
  establish semantic equivalence, redundancy, or eliminability.
- File write/edit content and child prompts are hashed only and never copied into operations, evidence,
  fallback previews, or this report.
- Coordination operations represent requests. Their tool outputs are not parsed as success/failure outcomes.`
    )
    .replace(
      "Block C establishes deterministic operation normalization and parser coverage only. Stop before",
      "Block C.1 hardens operation input identity and coordination requests only. Stop before"
    );
}

function renderBlockC2Report(summary) {
  const reference = summary.lifecycle.reference.timestampMs;
  const invocation = summary.normalization.layers.invocation;
  const segment = summary.normalization.layers.segment;
  const operation = summary.normalization.layers.operation;
  const invocationRows = invocation.byTool.map((row) => [
    row.key,
    row.counts.total,
    row.counts.specific,
    row.counts.mixed,
    row.counts.syntactic,
    row.counts.fallback,
    row.counts.error,
    `${number(row.semanticReach.value * 100, 1)}%`,
  ]);
  const sessionRows = invocation.bySession.map((row) => [
    row.key.slice(0, 8),
    row.counts.total,
    row.counts.specific,
    row.counts.mixed,
    row.counts.syntactic,
    row.counts.fallback,
    `${number(row.semanticReach.value * 100, 1)}%`,
  ]);
  const inventoryRows = summary.normalization.semanticRuleInventory.map((rule) => [
    rule.id,
    rule.version,
    rule.supportedTools.join(", "),
    summary.normalization.usedOperationRules.includes(`${rule.id}@${rule.version}`) ? "yes" : "no",
  ]);
  const topologyRows = summary.topology.nodes.map((node) => [
    node.sessionId.slice(0, 8),
    node.parentSessionId?.slice(0, 8) ?? "ROOT",
    node.spawnDepth,
    node.outDegree,
    node.title,
  ]);
  const lifecycleRows = summary.lifecycle.sessions.map((session) => [
    session.sessionId.slice(0, 8),
    session.spawnDepth,
    relative(session.createdAtMs, reference),
    relative(session.firstReadyAtMs, reference),
    milliseconds(session.platformReadyLatencyMs),
    relative(session.firstMessageStartedAtMs, reference),
    relative(session.lastMessageCompletedAtMs, reference),
    session.messageCount,
    session.toolInvocationCount,
  ]);
  const concurrencyRows = Object.entries(summary.concurrency).map(([name, metric]) => [
    name,
    metric.intervalCount,
    metric.participatingSessionCount,
    metric.peakConcurrentIntervals,
    metric.peakConcurrentSessions,
    milliseconds(metric.spanMs),
    number(metric.meanConcurrentIntervalsOverSpan),
  ]);

  return `# OpenInspect Trace Analysis — Block C.2 Package Command Normalization

## Input and scope

- Root session: \`${summary.input.rootSessionId}\`
- Input fingerprint: \`${summary.input.fingerprint}\`
- Analysis profile: \`${summary.analysisProfile}\`
- Analysis schema: \`${summary.analysisSchemaVersion}\`
- Invocation ruleset: \`${summary.normalization.rulesetVersion}\`
- Semantic command ruleset: \`${summary.normalization.semanticRulesetVersion}\`
- Repository: ${text(summary.input.repository)}
- LLM used for parsing/statistics: **no**
- Command semantics represent deterministic **requests only**; actual execution and success/failure are not inferred.
- Redundancy candidates, semantic episodes, eliminability, and batch aggregation: **not implemented**

## Validation

- Valid: **${summary.validation.valid ? "yes" : "no"}**
- Verified hashed files: ${summary.validation.verifiedFileCount}
- Sessions / messages / events: ${summary.validation.counts.sessions} / ${summary.validation.counts.messages} / ${summary.validation.counts.events}

Warnings:

${renderWarnings(summary.validation.warnings)}

## Topology

- Roots: ${summary.topology.rootSessionIds.length}
- Nodes / edges: ${summary.topology.nodeCount} / ${summary.topology.edgeCount}
- Maximum spawn depth: ${summary.topology.maxSpawnDepth}
- Root out-degree: ${summary.topology.rootOutDegree}

${table(["Session", "Parent", "Depth", "Children", "Title"], topologyRows)}

## Lifecycle

Reference: \`${summary.lifecycle.reference.kind}\` at \`${summary.lifecycle.reference.timestampMs}\`.

${table(
  [
    "Session",
    "Depth",
    "Created t",
    "First ready t",
    "Ready latency",
    "First message t",
    "Last completion t",
    "Messages",
    "Tool calls",
  ],
  lifecycleRows
)}

Tool timing repairs: ${summary.lifecycle.run.toolTimingRepairCount}. Timing and missingness retain the
Block A + B evidence limits.

## Concurrency

${table(
  [
    "Definition",
    "Intervals",
    "Sessions",
    "Peak intervals",
    "Peak sessions",
    "Span",
    "Mean intervals",
  ],
  concurrencyRows
)}

## Three-layer normalization coverage

The denominators are deliberately different. Invocation coverage measures all tool calls; segment
coverage measures safely extracted top-level bash segments; operation coverage describes emitted
derived operations and must not be substituted for source-event coverage.

### Invocation layer

- Total: ${invocation.totals.counts.total}
- Specific: ${percentage(invocation.totals.specificCoverage)}
- Mixed: ${percentage(invocation.totals.mixedCoverage)}
- Syntactic: ${percentage(invocation.totals.syntacticCoverage)}
- Semantic reach: ${percentage(invocation.totals.semanticReach)}
- Fallback: ${percentage(invocation.totals.fallbackRate)}

${table(
  ["Tool", "Total", "Specific", "Mixed", "Syntactic", "Fallback", "Error", "Semantic reach"],
  invocationRows
)}

By session:

${table(
  ["Session", "Total", "Specific", "Mixed", "Syntactic", "Fallback", "Semantic reach"],
  sessionRows
)}

### Shell-segment layer

- Safely extracted segments: ${segment.counts.total}
- Specific: ${percentage(segment.specificCoverage)}
- Mixed: ${percentage(segment.mixedCoverage)}
- Syntactic: ${percentage(segment.syntacticCoverage)}
- Semantic reach: ${percentage(segment.semanticReach)}
- Bash invocations with segments: ${segment.segmentedInvocationCount}
- Bash invocations rejected before segmentation: ${segment.unsegmentedBashInvocationCount}

Semantic parser coverage:

${table(
  ["Parser", "Segments"],
  segment.bySemanticParser.map((row) => [row.key, row.count])
)}

### Operation layer

- Emitted operations: ${operation.counts.total}
- Semantic command-request operations: ${operation.counts.semanticCommand}
- Other tool-specific operations: ${operation.counts.specificNonShell}
- Syntactic shell operations: ${operation.counts.syntacticShell}
- Semantic commands / shell-derived operations: ${percentage(
    operation.semanticCommandShareOfShellDerivedOperations
  )}

Semantic command kinds:

${table(
  ["Kind", "Operations"],
  operation.byKind
    .filter((row) => row.key.startsWith("package_"))
    .map((row) => [row.key, row.count])
)}

## Composition and command boundary

- Every semantic command operation links to one source invocation and one \`shellSegmentId\`.
- Top-level \`;\`, newline, \`&&\`, and \`||\` segments remain quote-aware.
- For a pipeline, only the first safely tokenized command stage is eligible for semantic parsing.
  Later stages remain visible in the segment artifact and make that segment/invocation \`mixed\`.
- Unsupported or ambiguous pnpm/npm forms remain syntactic. The parser does not guess.
- Tool output is never used to decide whether the requested command ran or succeeded.

Supported deterministic forms in this ruleset:

- pnpm/npm install;
- pnpm/npm audit and outdated;
- pnpm \`licenses list\`;
- explicit package scripts, plus observed pnpm \`build\`/\`test\` shorthands;
- pnpm/npm exec;
- npm view.

Explicitly unsupported here: git, npx, yarn, arbitrary pnpm/npm built-ins, dynamic shell expansion,
and semantic parsing of pipeline stages after the first.

### Semantic rule inventory

${table(["Rule", "Version", "Programs", "Used"], inventoryRows)}

### Remaining fallback invocations

${
  invocation.fallbackToolTopK.length > 0
    ? table(
        ["Tool", "Count"],
        invocation.fallbackToolTopK.map((row) => [row.tool, row.count])
      )
    : "- None."
}

### Segment diagnostics

${
  segment.diagnostics.length > 0
    ? table(
        ["Diagnostic", "Count"],
        segment.diagnostics.map((row) => [row.code, row.count])
      )
    : "- None."
}

## Known evidence limits

${Object.entries(summary.missingness)
  .map(([key, value]) => `- \`${key}\`: ${value}`)
  .join("\n")}

## Checkpoint and next step

Block C.2 establishes compositional deterministic command-request normalization only. Stop before
git/npx/yarn rules, semantic episodes, redundancy candidates, eliminability, or batch aggregation.

Next:

${summary.checkpoint.nextSteps.map((step) => `1. ${step}`).join("\n")}
`;
}

function renderD0Report(summary) {
  const duplication = summary.observedDuplication;
  const clusterRows = duplication.topExactClusters.map((cluster) => [
    cluster.clusterId,
    cluster.strictness,
    cluster.kind,
    cluster.target.preview,
    cluster.distinctSiblingCount,
    cluster.totalInstances,
    cluster.duplicateInstances,
    `${cluster.memberOperationIds.map((operationId) => operationId.slice(0, 11)).join(", ")}${
      cluster.memberOperationIdCount > cluster.memberOperationIds.length
        ? `, +${cluster.memberOperationIdCount - cluster.memberOperationIds.length}`
        : ""
    }`,
  ]);
  const sharedTargetRows = duplication.topSharedTargetOverlaps.map((overlap) => [
    overlap.overlapId,
    overlap.targetType,
    overlap.target.preview,
    overlap.kinds.join(", "),
    overlap.distinctSiblingCount,
    overlap.totalInstances,
    overlap.distinctNormalizedInputCount,
  ]);
  const section = `## Strict observed duplication

This section reports exact repeated normalized inputs across different child sessions sharing the
same parent. It does **not** claim result equivalence, removability, eliminability, or savings.

Coverage:

- Eligible parent groups: ${duplication.coverage.eligibleParentCount}
- Eligible sibling sessions: ${duplication.coverage.eligibleSiblingSessionCount}
- Eligible specific operations: ${duplication.coverage.eligibleSpecificOperationCount}
- Eligible syntactic shell operations: ${duplication.coverage.eligibleSyntacticOperationCount}
- Excluded fallback invocations: ${duplication.coverage.excludedFallbackInvocationCount}
- C.2 invocation parsed coverage: ${percentage(duplication.coverage.c2InvocationParsedCoverage)}
- C.2 shell-segment semantic reach: ${percentage(duplication.coverage.c2ShellSegmentSemanticReach)}

Strict duplicate-instance metrics:

- Specific exact: ${percentage(duplication.specificExactDuplicateInstanceRatio)}
- Syntactic exact: ${percentage(duplication.syntacticExactDuplicateInstanceRatio)}
- Runs with at least one exact cluster: ${percentage(duplication.runsWithAtLeastOneExactCluster)}
- Parents with at least one exact cluster: ${percentage(
    duplication.parentsWithAtLeastOneExactCluster
  )}
- Clusters: ${duplication.clusters.total} total = ${duplication.clusters.specificExact} specific + ${duplication.clusters.syntacticExact} syntactic
- Sibling pairs with a cluster: ${duplication.siblingPairs.pairsWithAtLeastOneExactCluster}/${duplication.siblingPairs.totalPairs}
- Pair-cluster incidences: ${duplication.siblingPairs.specificExactClusterIncidences} specific + ${duplication.siblingPairs.syntacticExactClusterIncidences} syntactic

\`duplicateInstances\` is defined as \`totalInstances - 1\` within a qualifying cluster. It is an
observed count only and is never labeled removable or eliminable.

### Top exact clusters

${
  clusterRows.length > 0
    ? table(
        [
          "Cluster ID",
          "Strictness",
          "Kind",
          "Target preview",
          "Siblings",
          "Instances",
          "Duplicate instances",
          "Operation IDs",
        ],
        clusterRows
      )
    : "- None."
}

Full member session/invocation/operation IDs, signatures, parsers, and rulesets are in
\`exact-duplication-clusters.jsonl\`.

### Shared-target overlap — not exact duplication

- Overlaps: ${duplication.sharedTargetOverlap.overlapCount}
- Instances in overlap groups: ${duplication.sharedTargetOverlap.totalInstances}
- Sibling pairs with overlap: ${duplication.sharedTargetOverlap.pairsWithAtLeastOneOverlap}
- Pair-overlap incidences: ${duplication.sharedTargetOverlap.pairOverlapIncidences}

${
  sharedTargetRows.length > 0
    ? table(
        [
          "Overlap ID",
          "Target type",
          "Target preview",
          "Kinds",
          "Siblings",
          "Instances",
          "Distinct inputs",
        ],
        sharedTargetRows
      )
    : "- None."
}

Same-target operations with different input fingerprints are evidence of shared target access only.
They are excluded from both exact duplicate-instance numerators.

### Interpretation limits

Potential false positives or overstatement risks:

- an identical request may fail, be rate-limited, or produce a different result;
- once a cluster spans siblings, \`total - 1\` also counts additional repeats within one child;
- \`invocation_default\` does not prove that two commands had the same physical working directory;
- package registry state and filesystem contents may change between otherwise identical requests;
- an identical write/edit content hash does not establish that removing either request is safe.

Blind spots and conservative false negatives:

- fallback invocations and unsupported parser forms are outside the operation denominator;
- semantically equivalent commands with different normalized inputs do not cluster;
- path aliases, symlinks, shell environment, and resolved file contents are not canonicalized;
- finding/result overlap, timing, duration, resource cost, and critical-path impact are not measured.

Specific and syntactic clusters remain separate throughout metrics, matrix rows, and artifacts.
`;
  return renderBlockC2Report(summary)
    .replace(
      "# OpenInspect Trace Analysis — Block C.2 Package Command Normalization",
      "# OpenInspect Trace Analysis — Block D0 Strict Observed Duplication"
    )
    .replace(
      "- Redundancy candidates, semantic episodes, eliminability, and batch aggregation: **not implemented**",
      "- Semantic similarity, episodes, eliminability, and batch aggregation: **not implemented**"
    )
    .replace("## Known evidence limits", `${section}\n## Known evidence limits`)
    .replace(
      "Block C.2 establishes compositional deterministic command-request normalization only. Stop before",
      "Block D0 adds strict observed duplicate clusters only. Stop before"
    )
    .replace(
      "git/npx/yarn rules, semantic episodes, redundancy candidates, eliminability, or batch aggregation.",
      "new parser rules, semantic similarity/episodes, finding overlap, weighting, eliminability, or batch aggregation."
    );
}

function renderSensitivityStrata(rows) {
  return table(
    [
      "Stratum",
      "Instances",
      "Presences",
      "Clusters",
      "Cross-sibling",
      "Within-sibling",
      "Presence ratio",
      "All-instance sensitivity",
    ],
    rows.map((row) => [
      row.key,
      row.eligibleOperationInstances,
      row.eligibleDistinctSiblingSignaturePresences,
      row.clusterCount,
      row.crossSiblingExcessPresences,
      row.withinSiblingExcessInstances,
      percentage(row.siblingPresenceDuplicateRatio),
      percentage(row.allInstanceExcessSensitivity),
    ])
  );
}

function renderD01Report(summary) {
  const sensitivity = summary.observedDuplication;
  const clusterRows = sensitivity.topExactClusters.map((cluster) => [
    cluster.clusterId,
    cluster.strictness,
    cluster.kind,
    cluster.target.preview,
    cluster.distinctSiblingCount,
    cluster.totalInstances,
    cluster.allExcessInstances,
    cluster.crossSiblingExcessPresences,
    cluster.withinSiblingExcessInstances,
  ]);
  const sharedRows = sensitivity.topSharedTargetOverlaps.map((overlap) => [
    overlap.overlapId,
    overlap.targetType,
    overlap.target.preview,
    overlap.kinds.join(", "),
    overlap.distinctSiblingCount,
    overlap.totalInstances,
    overlap.distinctNormalizedInputCount,
  ]);
  const section = `## Sibling-presence sensitivity

The primary metric first deduplicates each exact signature within each sibling. One denominator unit
is one distinct \`(parent, sibling, signature)\` presence. All-instance excess remains a sensitivity
measure and is not the primary sibling metric.

Coverage:

- Eligible sibling sessions: ${sensitivity.coverage.eligibleSiblingSessionCount}
- Specific operation instances / presences: ${sensitivity.coverage.eligibleSpecificOperationCount} / ${sensitivity.coverage.eligibleSpecificPresenceCount}
- Syntactic operation instances / presences: ${sensitivity.coverage.eligibleSyntacticOperationCount} / ${sensitivity.coverage.eligibleSyntacticPresenceCount}
- Excluded fallback invocations: ${sensitivity.coverage.excludedFallbackInvocationCount}

Primary sibling-presence ratios:

- Specific: ${percentage(sensitivity.specificSiblingPresenceDuplicateRatio)}
- Syntactic: ${percentage(sensitivity.syntacticSiblingPresenceDuplicateRatio)}

All-instance excess sensitivity (the D0 v0 \`total - 1\` view):

- Specific: ${percentage(sensitivity.specificAllInstanceExcessSensitivity)}
- Syntactic: ${percentage(sensitivity.syntacticAllInstanceExcessSensitivity)}

Within-sibling repetition ratios:

- Specific: ${percentage(sensitivity.specificWithinSiblingRepetitionRatio)}
- Syntactic: ${percentage(sensitivity.syntacticWithinSiblingRepetitionRatio)}

All three excess numerators are computed only from strict signatures that span at least two
siblings. Repetition for a signature observed in only one sibling remains outside this cluster
decomposition.

Decomposition:

| Level | All excess | Cross-sibling excess presences | Within-sibling excess instances | Invariant |
| --- | --- | --- | --- | --- |
| specific | ${sensitivity.decomposition.specific.allExcessInstances} | ${sensitivity.decomposition.specific.crossSiblingExcessPresences} | ${sensitivity.decomposition.specific.withinSiblingExcessInstances} | ${sensitivity.decomposition.specific.invariantHolds ? "yes" : "NO"} |
| syntactic | ${sensitivity.decomposition.syntactic.allExcessInstances} | ${sensitivity.decomposition.syntactic.crossSiblingExcessPresences} | ${sensitivity.decomposition.syntactic.withinSiblingExcessInstances} | ${sensitivity.decomposition.syntactic.invariantHolds ? "yes" : "NO"} |

For every cluster and aggregate:

\`allExcessInstances = crossSiblingExcessPresences + withinSiblingExcessInstances\`.

### Specific strata by operation kind

${renderSensitivityStrata(sensitivity.specificStratification.byOperationKind)}

### Specific strata by parser

${renderSensitivityStrata(sensitivity.specificStratification.byParser)}

Cross-parser exact clusters: ${sensitivity.specificStratification.crossParserClusterCount}.

### Syntactic layer

- Instances / presences: ${sensitivity.syntacticLayer.eligibleOperationInstances} / ${sensitivity.syntacticLayer.eligibleDistinctSiblingSignaturePresences}
- Clusters: ${sensitivity.syntacticLayer.clusterCount}
- Cross-sibling excess presences: ${sensitivity.syntacticLayer.crossSiblingExcessPresences}
- Within-sibling excess instances: ${sensitivity.syntacticLayer.withinSiblingExcessInstances}
- Presence ratio: ${percentage(sensitivity.syntacticLayer.siblingPresenceDuplicateRatio)}
- All-instance sensitivity: ${percentage(sensitivity.syntacticLayer.allInstanceExcessSensitivity)}

No syntactic target is automatically labeled valuable, valueless, or scaffolding.

### Top exact clusters by sibling presence

${
  clusterRows.length > 0
    ? table(
        [
          "Cluster ID",
          "Strictness",
          "Kind",
          "Target preview",
          "Siblings",
          "Instances",
          "All excess",
          "Cross-sibling",
          "Within-sibling",
        ],
        clusterRows
      )
    : "- None."
}

### Shared-target overlap — unchanged and separate

- Overlaps: ${sensitivity.sharedTargetOverlap.overlapCount}
- Instances: ${sensitivity.sharedTargetOverlap.totalInstances}
- Pair incidences: ${sensitivity.sharedTargetOverlap.pairOverlapIncidences}

${
  sharedRows.length > 0
    ? table(
        [
          "Overlap ID",
          "Target type",
          "Target preview",
          "Kinds",
          "Siblings",
          "Instances",
          "Distinct inputs",
        ],
        sharedRows
      )
    : "- None."
}

Shared-target overlaps do not contribute to presence, all-instance, or within-sibling exact
numerators.

### Interpretation boundary

- presence duplication shows that multiple siblings issued the same strict normalized request;
- within-sibling repetition shows repeated instances after one presence is retained per sibling;
- neither component establishes result equivalence, necessity, removability, or savings;
- fallback/parser blind spots, unresolved workdirs, mutable files/registries, and missing outcomes
  retain the D0 evidence limits.
`;
  return renderBlockC2Report(summary)
    .replace(
      "# OpenInspect Trace Analysis — Block C.2 Package Command Normalization",
      "# OpenInspect Trace Analysis — Block D0.1 Sibling-Presence Sensitivity"
    )
    .replace(
      "- Redundancy candidates, semantic episodes, eliminability, and batch aggregation: **not implemented**",
      "- Semantic similarity, findings, weighting, eliminability, and batch aggregation: **not implemented**"
    )
    .replace("## Known evidence limits", `${section}\n## Known evidence limits`)
    .replace(
      "Block C.2 establishes compositional deterministic command-request normalization only. Stop before",
      "Block D0.1 separates cross-sibling presence from within-sibling repetition. Stop before"
    )
    .replace(
      "git/npx/yarn rules, semantic episodes, redundancy candidates, eliminability, or batch aggregation.",
      "new parser rules, semantic similarity/episodes, findings, weighting, eliminability, or batch aggregation."
    );
}

export function renderReport(summary) {
  if (summary.analysisProfile === "block-d0-v1") return renderD01Report(summary);
  if (summary.analysisProfile === "block-d0-v0") return renderD0Report(summary);
  if (summary.analysisProfile === "block-c-v2") return renderBlockC2Report(summary);
  if (summary.analysisProfile === "block-c-v1") return renderBlockC1Report(summary);
  if (summary.analysisProfile === "block-c-v0") return renderBlockCReport(summary);
  return renderBlockABReport(summary);
}
