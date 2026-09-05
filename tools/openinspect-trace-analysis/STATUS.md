# Block F0 Large-Scale Experiment Protocol Status Checkpoint

Profiles: `block-ab-v0` (default), `block-c-v0`, `block-c-v1`, `block-c-v2`, `block-d0-v0`,
`block-d0-v1`

Status: **Block F0 large-scale protocol and metadata contract complete; new collection not
started.**

## Completed

### Block A

- independent modular offline tool directory;
- measurement contract;
- versioned IR documentation;
- immutable-evidence and deterministic-output boundaries;
- explicit `block-ab-v0` zero-operation compatibility profile.

### Block B

- bundle loader and SHA-256 verification;
- fail-closed structural/completeness validator;
- topology metrics;
- lifecycle metrics;
- separate message/setup/tool concurrency sweeps;
- deterministic `summary.json`, `report.md`, `checkpoint.json`, and output hashes;
- synthetic unit tests and two-real-trace integration tests.

### Block B validation hardening

- required consumed evidence must have exactly one `hashes.json` entry;
- trust anchors are explicit (`manifest.json`, `hashes.json`) and need not self-hash;
- trust anchors, required evidence, and every listed hash entry reject symlinks/non-regular files;
- lexical containment is followed by realpath containment inside the bundle real root;
- `completeness.sessions` and optional `completeness.sessionIds` require exact set equality;
- `openinspect-trace-v0` requires exactly one root matching manifest and completeness roots;
- synthetic fault-injection coverage was added for each confirmed gap.

### Block C normalization foundation

- explicit profile/config boundary preserving `block-ab-v0` bytes;
- ruleset `openinspect-operation-rules-block-c-v0`;
- versioned registry with deterministic priority and conflict failure;
- concrete `NormalizedOperation` and per-invocation `NormalizationResult`;
- target-aware filesystem rules for `read`, `glob`, `grep`, and `write`;
- conservative quote/escape-aware `bash` segmentation, always syntactic;
- specific/syntactic/fallback/error coverage globally and by tool/session/parser;
- deterministic operations/results/coverage/fallback artifacts;
- bounded evidence with no raw tool output or `write.content`.

### Block C.1 operation identity hardening

- separate `block-c-v1` profile and ruleset `openinspect-operation-rules-block-c-v1`;
- bounded `parameters` included in deterministic operation identity;
- read offset/limit selectors with missing-vs-explicit representation;
- write content and edit old/new identities as SHA-256 plus UTF-8 byte length;
- filesystem `edit` rule;
- spawn/status/send child coordination request rules without output outcome parsing;
- grep query identity as SHA-256/bytes plus explicit include selector;
- plaintext leak checks across every C.1 artifact and report.

### Block C.2 package-command normalization

- separate `block-c-v2` profile and versioned invocation/semantic rulesets;
- deterministic `ShellSegmentIR` between invocation and operation;
- operation back-links to source invocation and shell segment;
- mixed coverage with separate invocation, segment, and operation denominators;
- first-safe-pipeline-stage parsing with syntactic tail preservation;
- deterministic pnpm/npm install, audit, outdated, script, and exec request rules;
- pnpm `licenses list` and npm `view` request rules;
- tool output excluded from command identity and execution/success claims.

### Block D0 strict observed duplication

- separate `block-d0-v0` profile without changing earlier profile outputs;
- sibling universe defined by different child sessions sharing one parent;
- strict specific and syntactic exact signatures/clusters kept separate;
- deterministic cluster IDs, signatures, members, parser/ruleset evidence;
- shared-target/different-input overlap excluded from duplicate numerators;
- sibling-pair matrix in JSON and CSV;
- explicit numerator, denominator, coverage, run/parent/pair metrics;
- bounded evidence only and no removability/eliminability claims.

### Block D0.1 sibling-presence sensitivity

- separate `block-d0-v1` profile preserving D0 v0 and every earlier output;
- per-cluster all/cross-sibling/within-sibling excess decomposition;
- invariant `allExcess = crossSiblingExcess + withinSiblingExcess`;
- primary denominator deduplicated by parent/sibling/strict signature presence;
- D0 v0 `total - 1` retained only as all-instance sensitivity;
- within-sibling repetition ratio reported separately;
- specific metrics stratified by operation kind and parser;
- syntactic metrics isolated without automatic target-value labels;
- shared-target overlap unchanged and independent.

### Block E0 batch workflow foundation

- recursive deterministic bundle discovery from `manifest.json` + `hashes.json`;
- symlink, `.git`, `node_modules`, and `analysis` discovery exclusion;
- per-run failure isolation and duplicate root/fingerprint rejection;
- versioned cache identity covering input/profile/schema/rulesets;
- incremental cache reuse without cache-state output drift;
- run-level macro aggregation with no operation-denominator pooling;
- per-run numerator/denominator/value retained for every metric;
- parser/fallback coverage aggregation;
- deterministic batch artifacts and reusable identical output directories;
- explicit N=2 pilot/no-inference report boundary.

### Block F0 large-scale experiment protocol

- parent-rooted run frozen as the primary statistical unit;
- sibling groups and no-cross-run denominator pooling fixed in the protocol;
- initial large-scale baseline frozen to `block-d0-v1`;
- new parser/metric changes require new side-by-side profile/schema versions;
- GO/LIMITED/BLOCKED claim–evidence matrix;
- secret-free per-run metadata contract with full prompt and immutable repo commit;
- machine-readable Draft-07 schema plus validated editable template;
- fixed run → export → raw validation → metadata → D0.1 → batch → quality-gate workflow;
- claim-specific primary/sensitivity/excluded dispositions without arbitrary coverage threshold;
- sampling concerns and unresolved campaign decisions recorded before collection;
- no new trace, parser, metric, or statistical result produced.

## Real-trace checkpoint

| Root        | Sessions | Events | Messages | Root children | Peak child messages | Tool timing repairs |
| ----------- | -------: | -----: | -------: | ------------: | ------------------: | ------------------: |
| `4fd2789a…` |        8 |    439 |        8 |             7 |                   5 |                  90 |
| `1c929e3a…` |        4 |    936 |        6 |             3 |                   3 |                 384 |

Both bundles passed listed-file hashes, count equality, topology invariants, composite-ID
uniqueness, and raw-evidence before/after digest checks.

After hardening, both bundles were re-analyzed in new output directories. Their `summary.json` and
`report.md` remained byte-identical to the pre-hardening Block A + B outputs:

| Root        | summary SHA-256 | report SHA-256  |
| ----------- | --------------- | --------------- |
| `4fd2789a…` | `713d1c7ee99f…` | `a7fe3ae63493…` |
| `1c929e3a…` | `4329c58e6cb4…` | `b10927b33392…` |

Current test checkpoint: **106 passed, 0 failed**.

The high tool timing-repair counts confirm the contract boundary: message-level lifecycle and
concurrency are primary; tool duration/concurrency are timing-qualified and conservative.

## Block C real-trace checkpoint

| Root        | Invocations | Operations |    Specific |   Syntactic |    Fallback | Parsed coverage |
| ----------- | ----------: | ---------: | ----------: | ----------: | ----------: | --------------: |
| `4fd2789a…` |         407 |        794 | 133 (32.7%) | 223 (54.8%) |  51 (12.5%) |           87.5% |
| `1c929e3a…` |         911 |      1,233 | 261 (28.6%) | 458 (50.3%) | 192 (21.1%) |           78.9% |

Filesystem samples resolved expected paths/patterns; every operation retained one invocation link,
and no duplicate operation ID or write-content leakage was found. Shell samples preserved quoted
separators and pipelines and rejected heredocs, substitutions, subshells, control structures, and
background execution. A pre-check false-positive in `pipeline_preserved` diagnostics for quoted
literal pipes was corrected before this checkpoint; no obvious remaining misparse was found.

Primary conservative false negatives are intentional: grep without an explicit path, complex shell
syntax, and unsupported `edit`, coordination, and todo tools.

## Block C.1 real-trace checkpoint

| Root        | Invocations | Operations |    Specific |   Syntactic |  Fallback | Parsed coverage |
| ----------- | ----------: | ---------: | ----------: | ----------: | --------: | --------------: |
| `4fd2789a…` |         407 |        814 | 153 (37.6%) | 223 (54.8%) | 31 (7.6%) |           92.4% |
| `1c929e3a…` |         911 |      1,364 | 392 (43.0%) | 458 (50.3%) | 61 (6.7%) |           93.3% |

Read selector coverage: 18/116 reads in the first trace and 34/197 in the second had explicit offset
and/or limit. The second trace's 95 edit invocations normalized specific 95/95. Coordination
coverage was 20/20 in the first trace and 36/36 in the second.

Real plaintext identities were recomputed from raw evidence for 225 write/edit/prompt components: 0
hash/byte mismatches and 0 missing source invocations. No write/edit/prompt plaintext appeared in
any C.1 operation, normalization result, coverage, fallback inventory, checkpoint, or report.

No obvious C.1 misparse was found. Remaining fallback is conservative shell syntax, grep without an
explicit path, one invalid write invocation, and 13 unsupported `todowrite` calls.

## Block C.2 real-trace checkpoint

Invocation layer:

| Root        | Invocations | Specific | Mixed | Syntactic | Fallback | Semantic reach |
| ----------- | ----------: | -------: | ----: | --------: | -------: | -------------: |
| `4fd2789a…` |         407 |      157 |   106 |       113 |       31 |  263/407 64.6% |
| `1c929e3a…` |         911 |      392 |     2 |       456 |       61 |  394/911 43.2% |

Shell-segment and operation layers:

| Root        | Segments | Segment specific | Segment mixed | Segment syntactic | Semantic command ops |
| ----------- | -------: | ---------------: | ------------: | ----------------: | -------------------: |
| `4fd2789a…` |      661 |               55 |            75 |               531 |                  130 |
| `1c929e3a…` |      972 |                1 |             1 |               970 |                    2 |

The first trace emitted 5 pnpm install, 30 audit, 11 outdated, 18 licenses, 16 script, 31 exec, and
19 npm-view requests. The second emitted 2 npm-install requests. Unsupported pnpm version, config,
store, list, why, and dlx forms remained syntactic; git/npx/yarn received no semantic rule.

Manual samples confirmed package filters, workdir evidence, install flags, script/executable
targets, npm-view fields, pipeline-tail mixed status, and invocation/segment back-links. No obvious
semantic misparse was found. Command outputs do not affect identity and no operation claims
execution success.

## Block D0 real-trace checkpoint

| Root        | Eligible siblings | Specific duplicate instances | Syntactic duplicate instances | Clusters (S/T) | Shared targets |
| ----------- | ----------------: | ---------------------------: | ----------------------------: | -------------: | -------------: |
| `4fd2789a…` |                 7 |               23/260 (8.85%) |              133/516 (25.78%) |     25 (12/13) |              9 |
| `1c929e3a…` |                 3 |              56/289 (19.38%) |                53/662 (8.01%) |     52 (33/19) |              7 |

Both runs and both eligible parent groups had at least one exact cluster. The first run had 18/21
sibling pairs with a cluster; the second had 3/3. Pair-cluster incidences were 28 specific + 35
syntactic in the first and 79 specific + 21 syntactic in the second.

The first run's specific clusters were 9 file-read, 2 license-inventory, and 1 package-script
cluster. The second run's 33 specific clusters were all file reads. Syntactic numerators were
dominated by workflow scaffolding such as `cd`, separator `echo`, exit-code echo, and git status
commands; these are strict repeats but not evidence that useful work is removable.

Shared-target overlap was reported separately: the first run included build/oxlint/depcheck/tsc
targets with different filters/workdirs/arguments; the second included heavily read/edited source
files with different read selectors or edit hashes. None entered exact duplicate numerators solely
because the target matched.

## Block D0.1 real-trace checkpoint

| Root        | Specific presence | Syntactic presence | Specific all-instance | Syntactic all-instance | Specific within | Syntactic within |
| ----------- | ----------------: | -----------------: | --------------------: | ---------------------: | --------------: | ---------------: |
| `4fd2789a…` |    19/220 (8.64%) |     21/377 (5.57%) |        23/260 (8.85%) |       133/516 (25.78%) |   4/260 (1.54%) | 112/516 (21.71%) |
| `1c929e3a…` |   56/287 (19.51%) |     20/578 (3.46%) |       56/289 (19.38%) |         53/662 (8.01%) |    0/289 (0.0%) |   33/662 (4.98%) |

Required decompositions were reproduced exactly:

- first: specific `23 = 19 + 4`; syntactic `133 = 21 + 112`;
- second: specific `56 = 56 + 0`; syntactic `53 = 20 + 33`.

Specific strata in the first trace: file reads contributed 15/115 presence excess, license inventory
3/9, and package scripts 1/13; all other specific kinds contributed zero. In the second trace, file
reads contributed all 56 cross-sibling excess presences over 161 file-read presences.

Syntactic results remain one separate layer. The analyzer reports their targets and counts but does
not automatically classify `cd`, `echo`, git, or any other command as valuable or valueless.

## Block E0 real pilot checkpoint

The recursive collection run discovered exactly the two valid trace bundles, produced 2 successful
runs and 0 failures, and used `block-d0-v1` as the default/explicit profile. A second identical run
reported 2 cache hits, 0 misses, and reused byte-identical output.

Unweighted per-run macro summaries:

| Metric                              | Mean/median |    Min |    Max |
| ----------------------------------- | ----------: | -----: | -----: |
| specific sibling presence           |      14.07% |  8.64% | 19.51% |
| syntactic sibling presence          |       4.52% |  3.46% |  5.57% |
| specific all-instance sensitivity   |      14.11% |  8.85% | 19.38% |
| syntactic all-instance sensitivity  |      16.89% |  8.01% | 25.78% |
| specific within-sibling repetition  |       0.77% |  0.00% |  1.54% |
| syntactic within-sibling repetition |      13.35% |  4.98% | 21.71% |
| invocation parsed coverage          |      92.84% | 92.38% | 93.30% |
| shell-segment semantic reach        |       9.94% |  0.21% | 19.67% |
| fallback invocation rate            |       7.16% |  6.70% |  7.62% |

The aggregate retained both runs' exact numerators/denominators and did not compute a pooled ratio,
confidence interval, significance test, or paper-level inference.

## Intentionally not started

- git/npx/yarn semantic parsers;
- package-manager execution/success outcome parsing;
- semantic episode/action boundaries;
- semantic-similarity or relaxed duplication candidates;
- finding/result overlap;
- duration/resource/critical-path weighting;
- eliminability or optimization-value judgments;
- pooled-operation aggregation or inferential cross-run statistics;
- LLM parsing or numerical computation;
- new F0 campaign trace collection.

## Known gaps

- OpenInspect does not persist `step_start` / `step_finish` in these bundles.
- Tool state transitions are upserted; start/final clocks are not calibrated.
- Large OpenCode tool-output side files may be unavailable after sandbox shutdown.
- CPU, memory, network, cache, and billing time series are absent.
- The analyzer supports only bundle schema `openinspect-trace-v0`.
- Real trace bundles are local/ignored; CI relies on synthetic fixtures unless those bundles exist.

## Block F0 protocol checkpoint

Documents:

- `EXPERIMENT_PROTOCOL.md`;
- `CLAIM_EVIDENCE_MATRIX.md`;
- `RUN_METADATA_SCHEMA.md`;
- `RUN_METADATA_SCHEMA.json`;
- `RUN_METADATA_TEMPLATE.json`.

Claim boundary:

- GO: observed topology/fan-out, message-level concurrency, strict specific sibling-presence
  duplication, and syntactic/all-instance sensitivity within sampled quality-gated runs;
- LIMITED: computation-redundancy semantics, incomplete-parser operation comparisons, and
  cross-stratum/outcome associations;
- BLOCKED: eliminability, resource/cost savings, critical-path savings, quality-preserving
  deduplication, and population inference.

The metadata template validates against the machine schema. Metadata lives outside immutable trace
bundles and records repo commit, full safe prompt, task/model/orchestration/sandbox/outcome/export,
analysis versions, missingness, secret review, and claim-specific quality gates.

No new trace was collected and no new metric was computed for F0.

## Recommended next step

Choose and freeze the campaign-level open decisions in `EXPERIMENT_PROTOCOL.md`: target population,
repo/task strata, per-stratum counts, prompt families, prescribed/emergent conditions, width/depth,
model settings, repeat counts, sandbox conditions, success validators, failed-run treatment,
ordering/randomization, and stopping rule. Only then start new collection.

Do not start new collection until the F0 campaign decisions and sampling plan are accepted.
