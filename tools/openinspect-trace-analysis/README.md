# OpenInspect Trace Analysis

Offline, deterministic analysis for exported OpenInspect trace bundles.

This tool deliberately separates evidence collection from analysis:

```text
immutable trace bundle -> loader/validator -> IR -> deterministic metrics -> report
```

Profiles:

- `block-ab-v0` (**default**): the original validation/IR/topology/lifecycle/concurrency behavior,
  with zero normalized operations and byte-compatible output.
- `block-c-v0`: enables the versioned `openinspect-operation-rules-block-c-v0` ruleset and parser
  coverage artifacts without changing Block A + B metrics.
- `block-c-v1`: enables Operation Identity Hardening plus read/write/edit and child-coordination
  rules under ruleset `openinspect-operation-rules-block-c-v1`.
- `block-c-v2`: adds compositional shell segments and deterministic pnpm/npm command-request rules
  under `openinspect-operation-rules-block-c-v2` and `openinspect-package-command-rules-block-c-v2`.
- `block-d0-v0`: consumes the same Block C.2 operations and emits strict sibling exact-duplication
  clusters under `openinspect-observed-duplication-block-d0-v0`.
- `block-d0-v1`: keeps the same strict signatures while separating cross-sibling signature presence
  from repeated instances inside one sibling.

Block A + B provide:

- bundle hash and structural validation;
- exact required-evidence hash coverage plus symlink/realpath/regular-file hardening;
- completeness session-set equality and single-root cross-checking;
- a versioned intermediate representation whose raw unit is a tool invocation;
- topology, lifecycle, and concurrency metrics;
- deterministic `summary.json`, `report.md`, and `checkpoint.json` output;
- a reserved normalized-operation interface with no semantic rules enabled.

Block C adds:

- a versioned deterministic rule registry;
- target-aware filesystem rules for `read`, `glob`, `grep`, and `write`;
- conservative quote-aware syntactic segmentation for `bash`;
- per-invocation normalization results and specific/syntactic/fallback coverage;
- deterministic operation, coverage, and fallback evidence artifacts.

Block C.2 adds:

- an explicit `invocation -> shell segment -> semantic command operation` composition;
- deterministic, evidence-linked `ShellSegmentIR` records;
- mixed invocation/segment coverage instead of forcing one all-or-nothing shell label;
- pnpm/npm install, audit, outdated, script, and exec requests;
- pnpm `licenses list` and npm `view` requests;
- first-safe-pipeline-stage parsing while preserving later stages as syntactic evidence.

Block D0 adds:

- sibling-only exact clusters partitioned by parent;
- separate specific and syntactic signatures/metrics;
- same-target/different-input overlap kept separate from exact duplication;
- deterministic sibling-pair JSON/CSV matrices;
- evidence-linked cluster members without large raw payload copies.

Block D0.1 adds:

- cluster-level `all = cross-sibling + within-sibling` decomposition;
- a primary presence denominator deduplicated by `(parent, sibling, signature)`;
- the D0 v0 `total - 1` ratio retained as all-instance sensitivity only;
- within-sibling repetition ratios;
- specific metrics by operation kind/parser and a separate syntactic layer.

Block E0 adds a batch workflow over any explicit per-run profile. It defaults to `block-d0-v1`,
recursively discovers bundles, isolates failures, reuses versioned per-run cache entries, and emits
unweighted run-level macro summaries.

Explicitly out of scope for this checkpoint:

- semantic action/episode segmentation;
- semantic-similarity candidates or eliminability judgments;
- batch aggregation;
- LLM parsing, classification, or numerical computation.
- git, npx, or yarn semantic parsing.

## Usage

```bash
npm run trace:analyze -- /absolute/path/to/trace-bundle --out /absolute/path/to/output

# Explicit Block C profile
npm run trace:analyze -- /absolute/path/to/trace-bundle --profile block-c-v0

# Explicit Block C.1 profile
npm run trace:analyze -- /absolute/path/to/trace-bundle --profile block-c-v1

# Explicit Block C.2 profile
npm run trace:analyze -- /absolute/path/to/trace-bundle --profile block-c-v2

# Explicit Block D0 profile
npm run trace:analyze -- /absolute/path/to/trace-bundle --profile block-d0-v0

# Explicit Block D0.1 profile
npm run trace:analyze -- /absolute/path/to/trace-bundle --profile block-d0-v1

# Recursive batch workflow (defaults to block-d0-v1)
npm run trace:batch -- traces/openinspect --profile block-d0-v1
```

When `--out` is omitted, output is written outside the bundle under:

```text
analysis/openinspect/<root-session-id>/block-ab-v0-<input-fingerprint-prefix>/
analysis/openinspect/<root-session-id>/block-c-v0-<input-fingerprint-prefix>/
analysis/openinspect/<root-session-id>/block-c-v1-<input-fingerprint-prefix>/
analysis/openinspect/<root-session-id>/block-c-v2-<input-fingerprint-prefix>/
analysis/openinspect/<root-session-id>/block-d0-v0-<input-fingerprint-prefix>/
analysis/openinspect/<root-session-id>/block-d0-v1-<input-fingerprint-prefix>/
```

The analyzer refuses to write inside its input trace bundle.

Block C additionally writes:

```text
operations.jsonl
normalization-results.jsonl
parser-coverage.json
fallback-invocations.jsonl
```

Parser coverage describes normalization capability only. It is not a redundancy metric.

Block C.1 adds bounded `parameters` to its operation schema. Read selectors are stored explicitly;
write/edit content and child prompts are represented only by SHA-256 and UTF-8 byte length. An
`inputFingerprint` identifies normalized target+parameters under one ruleset—it does not establish
semantic equivalence, redundancy, or eliminability.

Block C.2 additionally writes:

```text
shell-segments.jsonl
layer-coverage.json
```

Its three coverage layers have different denominators:

- invocation: every tool invocation;
- segment: safely extracted top-level bash segments;
- operation: emitted derived operations.

Semantic command operations describe a requested command only. Tool output is not parsed to claim
that the command executed or succeeded. Unknown/ambiguous extracted segments remain syntactic. A
pipeline is eligible only through its first safely tokenized command stage; its remaining stages are
preserved in the segment artifact and make the segment `mixed`.

Block D0 additionally writes:

```text
exact-duplication-clusters.jsonl
shared-target-overlaps.jsonl
sibling-duplication-matrix.json
sibling-duplication-matrix.csv
duplication-metrics.json
```

An exact cluster must span at least two different child sessions with the same parent. Specific and
syntactic operations never share a cluster or numerator. `duplicateInstances = totalInstances - 1`
is an observed count only; it is not removability, eliminability, savings, or outcome equivalence.

In D0.1, the primary sibling metric first keeps one presence per exact signature per sibling:

```text
allExcessInstances = totalInstances - 1
crossSiblingExcessPresences = distinctSiblingCount - 1
withinSiblingExcessInstances = totalInstances - distinctSiblingCount
allExcessInstances = crossSiblingExcessPresences + withinSiblingExcessInstances
```

Only strict signatures spanning at least two siblings enter these excess numerators. Shared-target
overlap remains independent.

## Batch workflow

Batch outputs are written under:

```text
analysis/openinspect/batches/<profile>-<batch-fingerprint-prefix>/
```

and contain:

```text
batch-manifest.json
runs.jsonl
failures.jsonl
aggregate-summary.json
report.md
output-hashes.json
```

The cache identity includes the input fingerprint, profile, analysis/operation schema, operation
ruleset, semantic ruleset, and duplication schema. Cache hit/miss state is execution metadata only;
it is intentionally excluded from deterministic artifacts.

The run is the statistical unit. Aggregate ratios are unweighted macros over per-run values, while
every run retains its numerator and denominator. Operations are never pooled into one denominator.
An N=2 report is explicitly a descriptive pilot: no confidence interval, significance result, or
paper-level inference is produced.

## Large-scale experiment protocol

- [EXPERIMENT_PROTOCOL.md](./EXPERIMENT_PROTOCOL.md): frozen workflow, sampling, quality gates, and
  open campaign decisions;
- [CLAIM_EVIDENCE_MATRIX.md](./CLAIM_EVIDENCE_MATRIX.md): GO/LIMITED/BLOCKED claim boundary;
- [RUN_METADATA_SCHEMA.md](./RUN_METADATA_SCHEMA.md): human-readable per-run metadata contract;
- [RUN_METADATA_SCHEMA.json](./RUN_METADATA_SCHEMA.json): machine-readable schema;
- [RUN_METADATA_TEMPLATE.json](./RUN_METADATA_TEMPLATE.json): editable secret-free template.

## Tests

```bash
npm run test:trace-analysis
```

The test suite includes synthetic unit fixtures and optional integration checks against the two
local real trace bundles used for the Block A + B checkpoint.

See [MEASUREMENT_CONTRACT.md](./MEASUREMENT_CONTRACT.md) for definitions and evidence boundaries.
The versioned data model is documented in
[INTERMEDIATE_REPRESENTATION.md](./INTERMEDIATE_REPRESENTATION.md), and the current stop point is in
[STATUS.md](./STATUS.md).
