# Measurement Contract — Block E0 Batch Workflow Foundation

Status: **Block E0 deterministic pilot batch workflow complete; inferential analysis not started.**

Analysis profiles:

- `block-ab-v0` (default): existing zero-operation behavior and byte-compatible output;
- `block-c-v0`: deterministic normalization using ruleset `openinspect-operation-rules-block-c-v0`.
- `block-c-v1`: bounded operation parameters and identity-aware filesystem/coordination rules using
  ruleset `openinspect-operation-rules-block-c-v1`.
- `block-c-v2`: compositional shell segments and deterministic pnpm/npm command requests using
  invocation ruleset `openinspect-operation-rules-block-c-v2` and semantic ruleset
  `openinspect-package-command-rules-block-c-v2`.
- `block-d0-v0`: reuses Block C.2 operations and adds strict sibling exact-duplication analysis
  under schema `openinspect-observed-duplication-block-d0-v0`.
- `block-d0-v1`: keeps D0 strict signatures and separates sibling presence from within-sibling
  repetition under schema `openinspect-observed-duplication-block-d0-v1`.

This contract defines what the offline analyzer may claim from an OpenInspect trace bundle. It is a
measurement boundary, not a redundancy taxonomy.

## 1. Evidence and immutability

The exported trace bundle is immutable evidence.

- `manifest.json` and `hashes.json` are trust anchors. They are required regular, non-symlink files
  inside the bundle real root, but are not required to self-hash.
- The analyzer-consumed evidence paths are exactly:
  - `completeness.json`
  - `missingness.json`
  - `raw/session-index.json`
  - `normalized/events.jsonl`
  - `normalized/messages.jsonl`
- Every required evidence path must appear exactly once in `hashes.json`.
- Every additional entry listed in `hashes.json` is also verified even when the analyzer does not
  otherwise consume it.
- The analyzer opens it read-only and writes to a separate analysis directory.
- Every listed file in `hashes.json` is verified before analysis.
- Unknown events and fields remain present in the loaded bundle; validation must not silently drop
  them.
- Derived outputs record the bundle fingerprint and analysis schema version.
- No LLM participates in parsing, classification, or numerical computation.

## 2. Observational units

### Session

A control-plane session identified by `session.id`. Parent links and `spawnDepth` define topology.

### Message execution

One persisted message with `startedAt` and `completedAt`. Its interval is a broad execution
interval: it includes model computation, tool work, and waits that the trace cannot decompose.

### Tool invocation — primary raw unit

One persisted `tool_call` event, identified within a session by its event/call identity. This is an
objective runtime boundary, not a semantic action or episode.

The inferred finish time uses the final persisted sandbox event timestamp when valid. Because tool
state transitions are upserted and sandbox/control-plane clocks are not calibrated, tool duration
and tool-level concurrency are explicitly lower-confidence than message-level timing.

### Normalized operation

A deterministic representation emitted by a versioned parser. It contains operation/source IDs,
kind, target type/target/scope/effect, optional input fingerprint, parser identity/version,
normalization level, confidence, and bounded evidence/diagnostics.

- `block-ab-v0` emits zero operations.
- `block-c-v0` permits one invocation to emit zero or more operations.
- Every Block C operation has exactly one source invocation.
- Every Block C.2 semantic shell operation also has exactly one source shell segment.
- Multi-invocation grouping remains a future interface and is not implemented.
- Raw `ToolInvocationIR` is never mutated.

### Block C normalization status

Every tool invocation produces one result:

- `specific`: a target-aware deterministic rule emitted explicit operation kind/target;
- `syntactic`: only deterministic structure was extracted, without domain/target semantics;
- `fallback`: no reliable operation was emitted, while raw identity and bounded diagnostics remain;
- `error`: parser failure; the analyzer fails closed rather than emitting a successful report.

`block-c-v2` additionally permits `mixed`: at least one shell segment has semantic command coverage
while another segment or pipeline tail remains syntactic. Earlier profiles never emit `mixed`.

Coverage always records numerator, denominator, and value globally and by tool/session/parser.
Generic shell segmentation is `syntactic`, never `specific`.

Rules are registered with unique ID/version, integer priority, supported tools, `match()`, and
`normalize()`. Registry order is deterministic; equal-priority matching conflicts fail closed.

### Block C.1 target, parameters, and input fingerprint

- `target` identifies the normalized resource/request target.
- `parameters` contains only bounded normalized selectors or plaintext-free content identities.
- `inputFingerprint` is SHA-256 over canonical normalized target+parameters relevant to the rule.
- Missing selector fields and explicit values are different parameter states.
- A matching fingerprint means matching normalized input identity under this ruleset only; it is not
  a semantic-equivalence, redundancy, or eliminability judgment.

`block-c-v1` rules:

- `filesystem.read@2.0.0`: path plus explicit present/missing offset/limit selectors;
- `filesystem.grep@2.0.0`: search path plus hashed pattern and explicit include selector;
- `filesystem.write@2.0.0`: path plus content SHA-256/UTF-8 bytes;
- `filesystem.edit@1.0.0`: path plus old/new SHA-256/UTF-8 bytes;
- `coordination.spawn-child@1.0.0`: normalized title plus prompt SHA-256/bytes;
- `coordination.get-child-status@1.0.0`: child/all-children target plus explicit query selectors,
  with effect fixed as `read`;
- `coordination.send-child-prompt@1.0.0`: child target plus prompt SHA-256/bytes.

Content, old/new strings, and prompts are never copied into operations, evidence, fallback previews,
or reports. Coordination rules normalize requests only; tool output is not interpreted as a success,
rate-limit, or other outcome.

### Block C.2 shell segment and semantic command request

`ShellSegmentIR` is a bounded deterministic bridge between a bash invocation and command semantics.
It records source invocation/event/session, segment index/text, separator, effective workdir
evidence, pipeline stage count, normalization status, semantic parser identity, operation IDs, and
diagnostics.

The three coverage layers must never share an implicit denominator:

1. invocation coverage: all tool invocations, with specific/mixed/syntactic/fallback/error states;
2. segment coverage: safely extracted top-level bash segments, with specific/mixed/syntactic states;
3. operation coverage: emitted derived operations, separated into semantic command requests,
   non-shell specific operations, and syntactic shell operations.

At the segment layer:

- `specific` means the only pipeline stage matched one semantic command rule;
- `mixed` means the first pipeline stage matched, while later stages remain syntactic;
- `syntactic` means the segment was structurally retained but no rule matched reliably.

In this ruleset, each safely extracted segment emits exactly one derived operation: a semantic
command request when recognized, otherwise a syntactic `shell_segment`. A mixed pipeline does not
emit guessed operations for its tail; the tail is represented by segment evidence and mixed status.

Semantic operations describe **command requests**, not observed execution. Their `effect` describes
the requested effect class. Tool output, exit status, success, failure, and rate limiting are not
parsed into the operation or its identity.

Supported C.2 forms are deliberately bounded:

- pnpm/npm `install`;
- pnpm/npm `audit` and `outdated`;
- pnpm `licenses list`;
- pnpm/npm explicit scripts, plus the observed pnpm `build`/`test` shorthands;
- pnpm/npm `exec`;
- npm `view`.

The grammar accepts only explicitly supported flags. Unsupported pnpm/npm built-ins, unknown flags,
dynamic shell expansion, and ambiguous tokenization remain syntactic. Git, npx, and yarn have no
semantic rules in this profile.

### Block D0 strict observed duplication

A sibling is a different child session with the same non-null `parentSessionId`. Parent/root
operations and child sessions whose parent has fewer than two children are outside the duplication
universe.

Every exact cluster:

- is partitioned by `parentSessionId`;
- spans at least two distinct sibling sessions;
- retains deterministic member session/invocation/operation IDs;
- records parser and ruleset evidence;
- uses bounded target evidence rather than copying large raw content.

Specific and syntactic clusters use separate signatures and numerators:

- specific exact identity: `kind + targetType + target + scope + parameters + inputFingerprint`;
- syntactic exact identity: a `shell_segment` with the same `kind`, `targetType`, `target`, `scope`,
  `parameters`, and `inputFingerprint`.

Parser identity is evidence but is not part of the user-defined exact signature. A deterministic
cluster ID hashes the parent, strictness, and full normalized-input signature.

Within a qualifying cluster:

```text
duplicateInstances = totalInstances - 1
```

This is an observed count only. It does not mean removable, eliminable, unnecessary, or
outcome-equivalent. Once a signature spans siblings, additional same-child repeats are also included
by the specified `total - 1` definition and must be called out during interpretation.

Metric denominators:

- specific ratio denominator: all sibling-eligible specific C.2 operations;
- syntactic ratio denominator: all sibling-eligible syntactic `shell_segment` operations;
- parent denominator: parent groups with at least two child sessions;
- run denominator: the single trace bundle represented by one D0 output;
- sibling-pair matrix denominator: every unordered pair in each eligible parent group.

Each metric carries numerator, denominator, value, and normalization coverage. Fallback invocations
do not enter operation denominators and remain visible in coverage.

Shared-target overlap is separate. Operations may enter `shared-target-overlaps.jsonl` only when at
least two sibling sessions access the same target type/target with at least two distinct normalized
input fingerprints. Shared-target instances are never counted in exact duplicate numerators merely
because the target matches.

### Block D0.1 sibling-presence sensitivity

D0.1 does not change exact signatures or cluster membership. For each strict cluster:

```text
allExcessInstances = totalInstances - 1
crossSiblingExcessPresences = distinctSiblingCount - 1
withinSiblingExcessInstances = totalInstances - distinctSiblingCount
```

The analyzer fails closed if this invariant does not hold:

```text
allExcessInstances = crossSiblingExcessPresences + withinSiblingExcessInstances
```

The primary sibling-presence metric first deduplicates each exact signature within each sibling. Its
denominator is the count of distinct `(parentSessionId, siblingSessionId, strictSignature)`
presences across all eligible operations at that normalization level. Its numerator is the sum of
`distinctSiblingCount - 1` over strict clusters.

Specific and syntactic primary metrics remain separate. The D0 v0 `totalInstances - 1` ratio is
retained as `allInstanceExcessSensitivity`, with the original eligible operation-instance
denominator. It is no longer the primary sibling metric.

Within-sibling repetition uses `totalInstances - distinctSiblingCount` over strict clusters and the
same eligible operation-instance denominator as all-instance sensitivity. Signatures observed in
only one sibling do not become D0 clusters and therefore do not enter any of the three excess
numerators, although their distinct presences remain in the primary denominator.

Specific sensitivity is reported overall and recomputed within operation-kind and parser strata.
Syntactic sensitivity remains an independent layer. D0.1 does not automatically label `cd`, `echo`,
or any other syntactic target as valuable, valueless, setup, or scaffolding.

Shared-target overlap is unchanged, remains independent, and contributes to none of the exact
presence/all-instance/within-sibling numerators.

### Block E0 batch workflow

E0 orchestrates existing per-run profiles and does not change their semantics. The default profile
is `block-d0-v1`; callers may explicitly select another registered profile.

Discovery is recursive and deterministic:

- a candidate directory contains both `manifest.json` and `hashes.json`;
- directory entries and candidates are sorted by relative path;
- symlink directories are not followed;
- `.git`, `node_modules`, and `analysis` directories are excluded;
- once a bundle root is found, its internal directories are not searched for nested bundles.

Each candidate is validated and analyzed independently. A malformed or failed run produces one
deterministic failure record and does not prevent other runs. Duplicate root session IDs or input
fingerprints are rejected so one exported run cannot be counted twice.

The per-run cache identity contains:

```text
inputFingerprint
profileId
analysisSchemaVersion
operationSchemaVersion
rulesetVersion
semanticRulesetVersion
duplicationSchemaVersion
```

Cache hit/miss state is not persisted in batch artifacts because it differs between the first and
subsequent executions. Identical collection/profile bytes therefore produce identical outputs.

The run is the statistical unit. Every aggregate metric retains a per-run numerator, denominator,
and value. Aggregate mean/median/min/max are unweighted macros over per-run values; operation counts
and denominators are never pooled across runs.

E0 summarizes specific/syntactic sibling-presence ratios, all-instance sensitivity, within-sibling
repetition, invocation parser coverage, shell semantic reach, and fallback rate. Unavailable metrics
for a selected older profile remain missing rather than being invented.

For N=2, the report is explicitly a descriptive pilot. E0 computes no confidence interval,
significance test, causal result, or paper-level statistical inference.

## 3. Time reference

Absolute timestamps remain epoch milliseconds. A run-relative reference uses the first started
message of a root session; if absent, it falls back to root session creation.

Timing sources, strongest first:

1. D1/session/message timestamps for creation, queue, start, and completion;
2. control-plane event `createdAt` for event arrival/persistence;
3. sandbox event timestamp for the final state of an upserted tool invocation.

The analyzer records timing repairs such as a sandbox timestamp earlier than control-plane arrival.

## 4. Topology metrics

- root count and root IDs;
- node and edge count;
- maximum spawn depth;
- root out-degree;
- leaf count;
- ordered child IDs for each parent;
- structural errors: missing parent, cycle, or inconsistent spawn depth.

Block A + B describe observed topology only. They do not infer whether fan-out was spontaneous or
prompt-prescribed.

## 5. Lifecycle metrics

Per session:

- session creation/update/status;
- first `ready` and unique sandbox IDs;
- message count, first message start, last message completion;
- tool invocation count, first tool start, last inferred tool finish;
- platform-ready latency: `firstReadyAt - sessionCreatedAt`;
- per-message queue wait and execution duration;
- timing-quality counters.

Run-level lifecycle uses root-message start as the default zero point and exposes only deterministic
aggregates of the above fields.

## 6. Concurrency metrics

Concurrency is computed by a half-open interval sweep (`[start, end)`) with end points processed
before start points at equal timestamps.

The checkpoint reports four distinct definitions:

1. `allMessageExecutions`: all started/completed message intervals;
2. `childMessageExecutions`: non-root message intervals;
3. `childPlatformSetup`: non-root session creation to first ready;
4. `childToolInvocations`: inferred non-root tool intervals.

Each reports:

- interval count and participating-session count;
- peak concurrent intervals;
- peak concurrent sessions;
- span and integral (`interval-milliseconds` / `session-milliseconds`);
- time-weighted mean interval and session concurrency;
- deterministic peak segments.

Message concurrency is the primary result. Tool concurrency is a conservative, timing-qualified view
and must not be substituted for model activity.

## 7. Validation contract

The analyzer fails closed on:

- unsupported bundle schema;
- missing required files;
- path traversal in `hashes.json`;
- a missing or duplicate required evidence entry in `hashes.json`;
- a symlink in a required/trust-anchor path or any `hashes.json` entry;
- a non-regular evidence/hash-entry file;
- a realpath target outside the bundle's real root;
- hash or byte-size mismatch;
- manifest/completeness/actual count mismatch;
- any missing, extra, or duplicate session ID in `completeness.sessions`;
- any missing, extra, or duplicate session ID in `completeness.sessionIds` when present;
- duplicate session IDs or composite event/message IDs;
- event/message references to unknown sessions;
- missing parent, topology cycle, or spawn-depth mismatch;
- for `openinspect-trace-v0`, any topology other than exactly one root;
- disagreement among the unique topology root, `manifest.source.rootSessionId`, and
  `completeness.rootSessionId`.

Non-fatal missingness is emitted as warnings and carried into the report.

## 8. Determinism

For the same bundle bytes, analyzer version, and configuration:

- `summary.json`, `report.md`, and `checkpoint.json` must be byte-identical;
- output contains no wall-clock generation timestamp;
- arrays whose source order is not meaningful are sorted explicitly.

For `block-c-v0`, operation IDs are deterministic hashes of ruleset/parser/source invocation,
ordinal, and normalized identity fields. Operation/results/coverage/fallback artifacts and output
hashes are byte-identical for identical inputs and rulesets.

For `block-c-v1`, bounded parameters are also part of operation identity. Its artifacts are emitted
to a separate profile directory and do not alter `block-c-v0` bytes.

For `block-c-v2`, operation identity additionally includes zero or one source shell-segment ID.
Shell-segment IDs are deterministic hashes of source invocation, segment index/text, separator, and
bounded workdir evidence. Its outputs do not alter any earlier profile bytes.

For `block-d0-v0`, cluster/overlap IDs, matrices, metrics, report, and all inherited C.2 artifacts
are byte-identical for the same bundle and analyzer configuration. D0 writes to its own profile
directory and does not alter earlier profile outputs.

For `block-d0-v1`, cluster IDs are versioned under the v1 duplication schema. All D0.1 artifacts are
byte-identical for the same bundle/configuration and are written to a separate directory. D0 v0 and
all earlier profile bytes remain unchanged.

For E0, candidate ordering, cache keys, run/failure records, macro summaries, report, and output
hashes are deterministic. Re-running an unchanged batch may reuse caches and an identical existing
output directory, but persisted bytes remain unchanged.

### Conservative shell extractor boundary

The Block C shell rules do not execute commands and are not complete POSIX parsers.

- It quote/escape-aware splits only top-level `;`, newline, `&&`, and `||`.
- In Block C v0/v1, a pipeline remains one syntactic operation.
- In Block C.2, a pipeline remains one segment; only its first safe stage may produce a semantic
  request, and the unparsed tail makes the segment `mixed`.
- Separators inside quotes/escapes are not split.
- Heredocs, command/backtick substitution, subshell/process substitution, background execution,
  control structures, and complex grouping fall back with diagnostics.
- No git/npx/yarn semantic classification is present.

## 9. Explicitly out of scope

- semantic episode/action segmentation;
- git/npx/yarn semantic parsing;
- package-manager execution/success outcome parsing;
- semantic-similarity or relaxed duplication candidates;
- finding/result overlap;
- duration/resource/critical-path weighting;
- eliminability or optimization-value judgments;
- replay/counterfactual validation;
- pooled-operation aggregation or cross-run statistical inference;
- CPU, memory, network, cache, or billing inference not present in the bundle.

These are future blocks and must not be smuggled into Block A + B report prose.
