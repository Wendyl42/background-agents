# OpenInspect Trace Analysis

Offline, deterministic analysis for exported OpenInspect trace bundles. The analyzers read immutable
evidence and write derived results outside the input bundle. They do not collect runtime events. For
collection, storage, and code ownership, start with
[the trace pipeline](../../docs/TRACE_PIPELINE.md).

## Choose a workflow

| Input and purpose                                                                                                            | Command         | Main unit / denominator                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------- |
| One exported session-tree bundle: validate, inspect topology/lifecycle, optionally normalize operations and compare siblings | `trace:analyze` | One parent-rooted run; metrics depend on the selected profile                     |
| A directory of bundles: batch duplication analysis                                                                           | `trace:batch`   | Equal-weight macro summaries of per-run ratios                                    |
| A benchmark campaign `run.json`: time distribution and optional wait alignment                                               | `trace:time`    | Tool invocation; task-level shares plus a separately labeled pooled workload view |

These are separate entrypoints. The time CLI resolves attempts from the campaign manifest;
recursively scanning the same campaign with the batch CLI is not equivalent.

## Usage

Requires Node.js 22 or newer. Run commands from the repository root.

### Per-bundle and duplication analysis

```bash
# Default: validation, topology, lifecycle, and concurrency; zero normalized operations
npm run trace:analyze -- /path/to/trace-bundle --out /path/to/analysis

# Strict sibling duplication, including command normalization
npm run trace:analyze -- /path/to/trace-bundle --profile block-d0-v1

# Recursive batch workflow; defaults to block-d0-v1
npm run trace:batch -- /path/to/bundles --profile block-d0-v1
```

Without `--out`, per-bundle output goes to
`analysis/openinspect/<root-session-id>/<profile>-<input-fingerprint-prefix>/`; batch output goes to
`analysis/openinspect/batches/<profile>-<batch-fingerprint-prefix>/`. Cache identity includes the
input fingerprint, profile, schemas, and rulesets. Reports retain per-run numerators and
denominators; operations are not pooled into one batch duplication ratio.

### Campaign time distribution

```bash
npm run trace:time -- /path/to/campaign/run.json \
  --out analysis/openinspect/time-distribution/my-analysis

# Add root-parent wait alignment and an interactive, standalone HTML timeline
npm run trace:time -- /path/to/campaign/run.json \
  --out analysis/openinspect/time-distribution/my-wait-analysis \
  --wait-timeline
```

Without npm, use `node tools/openinspect-trace-analysis/time-cli.mjs` with the same arguments.
`--out` must be new or empty and outside the source runs tree. Existing results are not overwritten.
`--top N` controls the evidence shortlist (default 30). `--trace trace-001` explicitly selects an
export; otherwise the recorded trace or a unique export is used. To relocate a dataset, supply both
`--old-runs-root OLD` and `--runs-root NEW`; identity and hash validation still apply. Partial
reports retain failed-attempt dispositions and return exit code 1.

Read `report.md` and `coverage.json`, then CSV tables and `top-invocations.jsonl` /
`top-ambiguous.jsonl`. Evidence records point to exact source paths and lines, without copying
command arguments or outputs. `invocations.jsonl` is the complete compact ledger;
`input-manifest.json` records input and analyzer hashes. With `--wait-timeline`, also read
`wait-report.md` and open `wait-timeline.html`.

Machine-readable durations use milliseconds; Markdown uses seconds. Percentages describe known
cumulative invocation time, not task wall time or CPU time. Unknown timing is not zero; a mixed
command is counted once. Wait-completion overlap does not establish removable waiting. The existing
CLI does not perform CPU/memory/I/O attribution.

## Per-bundle profiles

Profiles preserve earlier output semantics; they are compatibility versions, not steps that every
analysis must run in sequence. Exact rules and formulas are in
[MEASUREMENT_CONTRACT.md](MEASUREMENT_CONTRACT.md).

| Profile                            | Capability added                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `block-ab-v0` (per-bundle default) | Validation, IR, topology, lifecycle, concurrency; zero operations                    |
| `block-c-v0`                       | Filesystem rules and conservative syntactic shell segmentation                       |
| `block-c-v1`                       | Operation identity hardening, read/write/edit selectors, child-coordination requests |
| `block-c-v2`                       | Invocation → shell segment → semantic command request; deterministic pnpm/npm rules  |
| `block-d0-v0`                      | Strict sibling duplication and separate same-target/different-input overlaps         |
| `block-d0-v1` (batch default)      | Cross-sibling signature presence separated from within-sibling repetition            |

Normalization describes requested operations. It does not prove execution, success, semantic
equivalence, independent operation duration, or eliminability. Specific and syntactic duplication
remain separate. Semantic action grouping, relaxed similarity, git/npx/yarn semantic parsing, and
inferential statistics are not implemented.

## Output families

| Workflow / profile      | Principal artifacts                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| All per-bundle profiles | `summary.json`, `report.md`, `checkpoint.json`, output hashes                                                                              |
| Block C profiles        | `operations.jsonl`, `normalization-results.jsonl`, `parser-coverage.json`, `fallback-invocations.jsonl`                                    |
| C.2 and D profiles      | `shell-segments.jsonl`, `layer-coverage.json`                                                                                              |
| D profiles              | `exact-duplication-clusters.jsonl`, `shared-target-overlaps.jsonl`, `sibling-duplication-matrix.json` / `.csv`, `duplication-metrics.json` |
| Batch                   | `batch-manifest.json`, `runs.jsonl`, `failures.jsonl`, `aggregate-summary.json`, `report.md`, `output-hashes.json`                         |
| Time / wait             | Reports, invocation/evidence JSONL, coverage and input manifest, CSV summaries; optional wait timeline HTML/JSON                           |

Parser coverage measures normalization capability, not redundancy. Invocation, shell-segment, and
operation coverage have different denominators. See the contracts below before comparing them.

## Documentation

| Document                                                         | Owns                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [STATUS.md](STATUS.md)                                           | Current capabilities, evidence limits, and result navigation                                         |
| [MEASUREMENT_CONTRACT.md](MEASUREMENT_CONTRACT.md)               | Per-bundle/batch definitions, formulas, and evidence boundaries                                      |
| [INTERMEDIATE_REPRESENTATION.md](INTERMEDIATE_REPRESENTATION.md) | Versioned IR and derived record fields                                                               |
| [TIME_DISTRIBUTION_PLAN.md](TIME_DISTRIBUTION_PLAN.md)           | Existing time workflow's dataset resolution, measurement, and classification contract                |
| [TIME_DISTRIBUTION_RESULTS.md](TIME_DISTRIBUTION_RESULTS.md)     | Dated 30-task campaign results and local artifact locations                                          |
| [WAIT_TIMELINE_RESULTS.md](WAIT_TIMELINE_RESULTS.md)             | Existing wait-alignment definitions and dated results                                                |
| [EXPERIMENT_PROTOCOL.md](EXPERIMENT_PROTOCOL.md)                 | F0 sampling, quality gates, and unresolved campaign decisions                                        |
| [CLAIM_EVIDENCE_MATRIX.md](CLAIM_EVIDENCE_MATRIX.md)             | F0 GO/LIMITED/BLOCKED claim boundaries                                                               |
| [RUN_METADATA_SCHEMA.md](RUN_METADATA_SCHEMA.md)                 | Per-run metadata; [JSON schema](RUN_METADATA_SCHEMA.json) and [template](RUN_METADATA_TEMPLATE.json) |
| [history/CHECKPOINTS.md](history/CHECKPOINTS.md)                 | Archived implementation stages and pilot validation                                                  |

The time contract retains its original filename for existing links. Detailed experiment documents
are needed when applying that protocol; they are not a prerequisite for using every CLI.

## Tests

For newly captured execution evidence, use the independently accepted
[process-v1 profile](PROCESS_PROFILE.md): `npm run trace:process -- BUNDLE --out NEW_DIRECTORY`.
It measures process/exec boundaries and self CPU, and produces a standalone interactive timeline.
The [capture tool](../openinspect-trace-capture/README.md) can run capture, export and this analysis
as one local experiment workflow; old bundles explicitly lack this evidence.

```bash
npm run test:trace-analysis
```

Uses `node:test`, with synthetic fixtures and optional checks against local pilot bundles. The root
workspace `npm test` does not include this separate tool suite. To check exporter attachment
behavior, run `npm run test:trace-export`.
