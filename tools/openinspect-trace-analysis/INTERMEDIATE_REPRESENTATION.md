# Intermediate Representation — Block E0 Batch Workflow Foundation

Raw IR schema version: `openinspect-trace-ir-block-ab-v0`

Operation schema versions:

- `block-c-v0`: original operation shape, preserved byte-for-byte;
- `block-c-v1`: adds bounded deterministic `parameters` and includes them in operation identity.
- `block-c-v2`: adds source shell-segment back-links for compositional command normalization.

Duplication schema version:

- `block-d0-v0`: `openinspect-observed-duplication-block-d0-v0` over Block C.2 operations.
- `block-d0-v1`: `openinspect-observed-duplication-block-d0-v1`, with presence/repetition fields.

The IR isolates deterministic analysis from the exported bundle's storage layout. It is constructed
in memory and is not a replacement for raw evidence.

## RunIR

```text
irSchemaVersion
inputFingerprint
source
rootSessionIds[]
sessions[]
messages[]
toolInvocations[]
operations[]
operationNormalization
missingness
```

`operations` remains empty in the raw IR. Block C normalization is a separate derived stage and does
not mutate `ToolInvocationIR`.

## SessionIR

```text
sessionId
parentSessionId
spawnDepth
title / status / repository / model
createdAtMs / updatedAtMs
activeDurationMs / totalCost
messages[]
readyEvents[]
toolInvocations[]
eventCount
```

Session order is deterministic: `createdAtMs`, then `sessionId`.

## MessageIR

```text
messageId / sessionId
status / source / content
createdAtMs / startedAtMs / completedAtMs
```

Messages remain raw persisted executions. No model-step or semantic-episode grouping is inferred.

## ToolInvocationIR — primary raw unit

```text
invocationId = sessionId:eventId
sourceEventId
sessionId / messageId / callId
tool / args / output / status
startedAtMs
finishedAtMs
rawFinishedAtMs
timingQuality
timingRepair
operations[]
```

`startedAtMs` is the control-plane event `createdAt`. `rawFinishedAtMs` is the final sandbox event
timestamp persisted in the upserted tool event. When it is missing or not later than `startedAtMs`,
the analyzer creates a one-millisecond half-open interval and records the repair. This keeps the
sweep deterministic but makes tool-level duration/concurrency explicitly lower-confidence.

The complete raw args and persisted output stay attached in memory. Reports do not print them.

## ShellSegmentIR — Block C.2 bridge

```text
schemaVersion = openinspect-shell-segment-block-c-v2
shellSegmentId
sourceInvocationId / sourceEventId / sessionId
segmentIndex / text / separatorBefore
workdir { present, value?, source? }
pipeline { stageCount, firstStage, tailStageCount }
normalizationStatus (specific, mixed, syntactic)
matchedSemanticParser (ID/version or null)
emittedOperationIds[]
diagnostics[]
```

Top-level segment boundaries reuse the conservative quote/escape-aware shell extractor. Segment IDs
are deterministic. A safely recognized preceding `cd PATH &&` may provide bounded workdir evidence
to the immediately following segment; no repository root or successful `cd` is inferred.

For pipelines, `text` retains the entire segment. Only `firstStage` is eligible for semantic command
parsing; later stages remain visible and force `normalizationStatus=mixed` when the first stage is
recognized.

## NormalizedOperation — Block C schema

```text
operationId
sourceInvocationIds[]
sourceShellSegmentIds[] (block-c-v2 only)
kind
targetType
target
scope
effect
parameters (block-c-v1 and later)
inputFingerprint (string or null)
parserId
parserVersion
normalizationLevel (specific or syntactic)
confidence
evidence
diagnostics
```

`operationId` is a deterministic hash of ruleset/parser/source invocation/ordinal and normalized
identity fields. Every operation links to one source invocation in Block C. The array shape reserves
future multi-invocation grouping without implementing it.

In Block C.2, a shell-derived operation also links to exactly one shell segment. Non-shell
filesystem and coordination operations use an empty `sourceShellSegmentIds` array.

Evidence and diagnostics are bounded JSON objects. They may contain source IDs, argument names,
segment index, and workdir, but never raw tool output or `write.content`.

`parameters` exists in `block-c-v1` and later. It may contain selectors, SHA-256 digests, byte
lengths, or bounded deterministic command-request arguments, but not large plaintext content. It
participates in deterministic operation ID construction.

`inputFingerprint` is a deterministic hash of the normalized target and relevant parameters. It does
not hash actual file contents for reads and does not claim semantic equivalence.

## NormalizationResult — one per invocation

```text
invocationId
sourceEventId
sessionId
tool
status (specific, mixed in v2, syntactic, fallback, error)
matchedParser (ID/version or null)
emittedOperationIds[]
emittedShellSegmentIds[] (block-c-v2)
diagnostics[]
```

Unknown tools and conservative parse refusals emit fallback results with zero operations. Parser
errors fail closed.

For Block C.2 bash invocations, `mixed` means at least one semantic command request was emitted
while another segment or pipeline tail remains syntactic. This status is not emitted by earlier
profiles.

## Three-layer coverage — Block C.2

```text
invocation: all ToolInvocationIR records
segment: safely extracted ShellSegmentIR records
operation: emitted NormalizedOperation records
```

Each layer records its own numerator and denominator. Operation counts cannot be used as invocation
or segment coverage. Semantic command operations are requests only and do not encode execution or
success outcomes.

## ExactDuplicationCluster — Block D0

```text
schemaVersion
clusterId / strictSignatureSha256
strictness (specific_exact or syntactic_exact)
normalizationLevel
parentSessionId
normalizedIdentity {
  kind / targetType / bounded target / scope
  parametersSha256 / inputFingerprint
}
distinctSiblingCount
totalInstances / duplicateInstances
memberSessionIds[] / memberInvocationIds[] / memberOperationIds[]
firstInstance / members[]
parserEvidence[] / rulesetEvidence
claimBoundary
```

The strict signature hashes the full target and parameters even though the cluster stores only a
bounded target preview and parameter digest. Every member links back to `operations.jsonl` and its
source invocation. A cluster must span at least two different child sessions with the same parent.

D0.1 replaces the ambiguous v0 `duplicateInstances` presentation with:

```text
allExcessInstances
crossSiblingExcessPresences
withinSiblingExcessInstances
instancesBySibling[] {
  sessionId / instanceCount / withinSiblingExcessInstances
}
```

All three fields are deterministic, and every cluster validates `all = cross + within`.

## SharedTargetOverlap — Block D0

```text
overlapId / classification=shared_target_overlap
parentSessionId
targetType / bounded target
distinctSiblingCount / totalInstances
distinctNormalizedInputCount / inputFingerprints[]
kinds[] / normalizationLevels[]
member session/invocation/operation IDs
parserEvidence[] / rulesetEvidence
claimBoundary
```

This artifact requires multiple normalized inputs for one target and is explicitly not an exact
duplicate cluster.

## Sibling matrix and duplication metrics

The JSON/CSV matrix contains every unordered sibling pair for every parent with at least two child
sessions. Each row separately counts specific clusters, syntactic clusters, total exact clusters,
and shared-target overlaps.

`duplication-metrics.json` records all numerators, denominators, ratios, parser coverage, eligible
parent/session/operation counts, pair incidences, and bounded Top-K evidence summaries.

In D0.1 it additionally records presence denominators, all-instance sensitivity, within-sibling
repetition, specific by-kind/by-parser strata, and a separate syntactic layer. A presence
denominator deduplicates one exact signature within one sibling before counting.

## BatchRunRecord — Block E0

```text
schemaVersion = openinspect-trace-batch-run-e0-v0
runId / relativePath / inputFingerprint / repository
analysisProfile / analysisSchemaVersion
cacheKey / cacheIdentity
summarySha256
counts { sessions, messages, events, toolInvocations, normalizedOperations, fallbackInvocations }
parserEvidence { usedRules[], usedOperationRules[] }
metrics {
  per-run numerator / denominator / value
}
```

The cache identity includes every profile/schema/ruleset version that can change per-run semantics.
The bundle path is adapted at cache read time and is not part of cache identity.

## Batch aggregate — Block E0

```text
batch-manifest.json
runs.jsonl
failures.jsonl
aggregate-summary.json
report.md
output-hashes.json
```

`aggregate-summary.json` stores unweighted run-level macro mean/median/min/max plus all per-run
numerators, denominators, and values. It explicitly records `denominatorPooling=not_performed` and
contains no confidence interval.

Cache hit/miss counts are returned as ephemeral execution metadata and never written into these
artifacts.

## Invariants

- Every session/message/tool invocation retains its source identity.
- Unknown tools remain tool invocations.
- IR construction never mutates the loaded bundle.
- Derived arrays have explicit deterministic ordering.
- Timing repairs are counted and surfaced rather than silently treated as observed durations.
- Block C operations/results never replace or rewrite source tool invocations.
- Every Block C.2 semantic command operation links to exactly one invocation and one shell segment.
- Unknown or ambiguous extracted command forms remain syntactic and retain their segment evidence.
- D0 never clusters operations from one session alone or across different parents.
- Specific and syntactic signatures, clusters, numerators, and matrix columns remain separate.
- Shared-target overlaps never contribute to exact duplicate-instance numerators.
- `duplicateInstances` is observed `totalInstances - 1`, not an eliminability judgment.
- D0.1 uses cross-sibling excess presence as primary and retains v0 `total - 1` only as sensitivity.
- D0.1 never automatically assigns value labels to syntactic targets.
- E0 never counts a duplicate root/input fingerprint twice.
- E0 isolates per-run failure and never pools operation denominators across runs.
- E0 cache use cannot change persisted batch artifact bytes.
