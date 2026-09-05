const STATUSES = ["specific", "syntactic", "fallback", "error"];

function emptyCounts() {
  return { total: 0, specific: 0, syntactic: 0, fallback: 0, error: 0 };
}

function add(counts, result) {
  counts.total += 1;
  counts[result.status] += 1;
}

function finalize(counts) {
  const denominator = counts.total;
  return {
    counts,
    specificCoverage: {
      numerator: counts.specific,
      denominator,
      value: denominator ? counts.specific / denominator : 0,
    },
    syntacticCoverage: {
      numerator: counts.syntactic,
      denominator,
      value: denominator ? counts.syntactic / denominator : 0,
    },
    fallbackRate: {
      numerator: counts.fallback,
      denominator,
      value: denominator ? counts.fallback / denominator : 0,
    },
    errorRate: {
      numerator: counts.error,
      denominator,
      value: denominator ? counts.error / denominator : 0,
    },
    parsedCoverage: {
      numerator: counts.specific + counts.syntactic,
      denominator,
      value: denominator ? (counts.specific + counts.syntactic) / denominator : 0,
    },
  };
}

function breakdown(results, keyFn) {
  const groups = new Map();
  for (const result of results) {
    const key = keyFn(result);
    const counts = groups.get(key) ?? emptyCounts();
    add(counts, result);
    groups.set(key, counts);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, counts]) => ({ key, ...finalize(counts) }));
}

export function computeParserCoverage({ results, ruleInventory, rulesetVersion }) {
  const totals = emptyCounts();
  for (const result of results) add(totals, result);
  const diagnosticCounts = {};
  for (const result of results) {
    for (const diagnostic of result.diagnostics) {
      diagnosticCounts[diagnostic.code] = (diagnosticCounts[diagnostic.code] ?? 0) + 1;
    }
  }
  const fallbackTools = results
    .filter((result) => result.status === "fallback")
    .reduce((counts, result) => {
      counts[result.tool] = (counts[result.tool] ?? 0) + 1;
      return counts;
    }, {});

  return {
    schemaVersion: "openinspect-parser-coverage-block-c-v0",
    rulesetVersion,
    definitions: {
      specific: "A target-aware deterministic rule emitted an explicit operation kind and target.",
      syntactic:
        "A deterministic structural parser emitted operations without domain/target semantics; generic shell segments are syntactic.",
      fallback: "No reliable operation was emitted; raw invocation identity remains available.",
      error: "A matched parser failed; Block C fails closed before emitting a successful analysis.",
    },
    totals: finalize(totals),
    byTool: breakdown(results, (result) => result.tool),
    bySession: breakdown(results, (result) => result.sessionId),
    byParser: breakdown(results, (result) =>
      result.matchedParser?.id
        ? `${result.matchedParser.id}@${result.matchedParser.version}`
        : "<no-parser>"
    ),
    fallbackToolTopK: Object.entries(fallbackTools)
      .map(([tool, count]) => ({ tool, count }))
      .sort((left, right) => right.count - left.count || left.tool.localeCompare(right.tool)),
    diagnostics: Object.entries(diagnosticCounts)
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
    ruleInventory,
    statuses: STATUSES,
  };
}

const V2_INVOCATION_STATUSES = ["specific", "mixed", "syntactic", "fallback", "error"];
const V2_SEGMENT_STATUSES = ["specific", "mixed", "syntactic", "error"];

function emptyV2InvocationCounts() {
  return { total: 0, specific: 0, mixed: 0, syntactic: 0, fallback: 0, error: 0 };
}

function addV2Invocation(counts, result) {
  counts.total += 1;
  counts[result.status] += 1;
}

function ratio(numerator, denominator) {
  return { numerator, denominator, value: denominator ? numerator / denominator : 0 };
}

function finalizeV2Invocation(counts) {
  return {
    counts,
    specificCoverage: ratio(counts.specific, counts.total),
    mixedCoverage: ratio(counts.mixed, counts.total),
    syntacticCoverage: ratio(counts.syntactic, counts.total),
    semanticReach: ratio(counts.specific + counts.mixed, counts.total),
    parsedCoverage: ratio(counts.specific + counts.mixed + counts.syntactic, counts.total),
    fallbackRate: ratio(counts.fallback, counts.total),
    errorRate: ratio(counts.error, counts.total),
  };
}

function breakdownV2(results, keyFn) {
  const groups = new Map();
  for (const result of results) {
    const key = keyFn(result);
    const counts = groups.get(key) ?? emptyV2InvocationCounts();
    addV2Invocation(counts, result);
    groups.set(key, counts);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, counts]) => ({ key, ...finalizeV2Invocation(counts) }));
}

function countDiagnostics(items) {
  const counts = {};
  for (const item of items) {
    for (const diagnostic of item.diagnostics ?? []) {
      counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

function computeSegmentLayer(segments, results) {
  const counts = { total: 0, specific: 0, mixed: 0, syntactic: 0, error: 0 };
  for (const segment of segments) {
    counts.total += 1;
    counts[segment.normalizationStatus] += 1;
  }
  const bashResults = results.filter((result) => result.tool === "bash");
  const bySession = new Map();
  const byParser = new Map();
  for (const segment of segments) {
    const sessionCounts = bySession.get(segment.sessionId) ?? {
      total: 0,
      specific: 0,
      mixed: 0,
      syntactic: 0,
      error: 0,
    };
    sessionCounts.total += 1;
    sessionCounts[segment.normalizationStatus] += 1;
    bySession.set(segment.sessionId, sessionCounts);
    const parser = segment.matchedSemanticParser
      ? `${segment.matchedSemanticParser.id}@${segment.matchedSemanticParser.version}`
      : "<syntactic>";
    byParser.set(parser, (byParser.get(parser) ?? 0) + 1);
  }
  return {
    definitions: {
      specific:
        "The first and only pipeline stage matched one deterministic semantic command rule.",
      mixed:
        "The first pipeline stage matched a semantic command rule while later pipeline stages remain syntactic.",
      syntactic:
        "The segment was retained structurally because its first stage was unsupported or ambiguous.",
      denominator: "Safely extracted top-level shell segments only.",
    },
    counts,
    specificCoverage: ratio(counts.specific, counts.total),
    mixedCoverage: ratio(counts.mixed, counts.total),
    syntacticCoverage: ratio(counts.syntactic, counts.total),
    semanticReach: ratio(counts.specific + counts.mixed, counts.total),
    segmentedInvocationCount: new Set(segments.map((segment) => segment.sourceInvocationId)).size,
    unsegmentedBashInvocationCount: bashResults.filter((result) => result.status === "fallback")
      .length,
    bySession: [...bySession.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, ...value })),
    bySemanticParser: [...byParser.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => ({ key, count })),
    diagnostics: countDiagnostics(segments),
    statuses: V2_SEGMENT_STATUSES,
  };
}

function computeOperationLayer(operations) {
  const counts = {
    total: operations.length,
    semanticCommand: 0,
    specificNonShell: 0,
    syntacticShell: 0,
  };
  const byParser = new Map();
  const byKind = new Map();
  for (const operation of operations) {
    const shellDerived = operation.sourceShellSegmentIds.length === 1;
    if (shellDerived && operation.normalizationLevel === "specific") counts.semanticCommand += 1;
    else if (shellDerived) counts.syntacticShell += 1;
    else counts.specificNonShell += 1;
    const parser = `${operation.parserId}@${operation.parserVersion}`;
    byParser.set(parser, (byParser.get(parser) ?? 0) + 1);
    byKind.set(operation.kind, (byKind.get(operation.kind) ?? 0) + 1);
  }
  const shellDerived = counts.semanticCommand + counts.syntacticShell;
  return {
    definitions: {
      semanticCommand:
        "A deterministic semantic command-request operation linked to one shell segment.",
      specificNonShell: "A target-aware operation from a non-shell tool-specific rule.",
      syntacticShell: "A shell-segment operation retained without semantic command classification.",
      denominator:
        "Emitted normalized operations; this is not a source-event coverage denominator.",
    },
    counts,
    semanticCommandShareOfAllOperations: ratio(counts.semanticCommand, counts.total),
    semanticCommandShareOfShellDerivedOperations: ratio(counts.semanticCommand, shellDerived),
    byParser: [...byParser.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => ({ key, count })),
    byKind: [...byKind.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => ({ key, count })),
  };
}

export function computeParserCoverageV2({
  results,
  segments,
  operations,
  ruleInventory,
  semanticRuleInventory,
  rulesetVersion,
  semanticRulesetVersion,
}) {
  const totals = emptyV2InvocationCounts();
  for (const result of results) addV2Invocation(totals, result);
  const fallbackTools = results
    .filter((result) => result.status === "fallback")
    .reduce((counts, result) => {
      counts[result.tool] = (counts[result.tool] ?? 0) + 1;
      return counts;
    }, {});
  const invocation = {
    definitions: {
      specific:
        "Every normalized unit in the invocation is specific; no syntactic shell remainder remains.",
      mixed: "The invocation contains both semantic command coverage and a syntactic remainder.",
      syntactic:
        "Only deterministic shell structure was retained; no semantic command rule matched.",
      fallback: "No reliable invocation/segment structure was emitted.",
      error: "A matched parser failed; analysis fails closed.",
      denominator: "All tool invocations, including non-shell tool-specific invocations.",
    },
    totals: finalizeV2Invocation(totals),
    byTool: breakdownV2(results, (result) => result.tool),
    bySession: breakdownV2(results, (result) => result.sessionId),
    byParser: breakdownV2(results, (result) =>
      result.matchedParser?.id
        ? `${result.matchedParser.id}@${result.matchedParser.version}`
        : "<no-parser>"
    ),
    fallbackToolTopK: Object.entries(fallbackTools)
      .map(([tool, count]) => ({ tool, count }))
      .sort((left, right) => right.count - left.count || left.tool.localeCompare(right.tool)),
    diagnostics: countDiagnostics(results),
    statuses: V2_INVOCATION_STATUSES,
  };
  const segment = computeSegmentLayer(segments, results);
  const operation = computeOperationLayer(operations);
  return {
    schemaVersion: "openinspect-parser-coverage-block-c-v2",
    rulesetVersion,
    semanticRulesetVersion,
    definitions: invocation.definitions,
    totals: invocation.totals,
    byTool: invocation.byTool,
    bySession: invocation.bySession,
    byParser: invocation.byParser,
    fallbackToolTopK: invocation.fallbackToolTopK,
    diagnostics: invocation.diagnostics,
    ruleInventory,
    semanticRuleInventory,
    statuses: V2_INVOCATION_STATUSES,
    layers: { invocation, segment, operation },
  };
}
