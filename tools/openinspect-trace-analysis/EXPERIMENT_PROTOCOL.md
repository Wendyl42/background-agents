# Block F0 Large-Scale Experiment Protocol

Status: **protocol baseline for future collection; no new traces are collected by this document.**

Frozen initial analysis profile: `block-d0-v1`

This protocol defines the evidence, metadata, collection workflow, and quality gates for a
large-scale OpenInspect study. It does not authorize parser changes, new metrics, replay,
eliminability experiments, or inferential claims.

## 1. Research scope and statistical units

### Primary statistical unit: parent-rooted run

One run is one exported trace tree rooted at one parent/root session. A repeated trial of the same
task is a different run and must have a different `runId` and `trialIndex`.

Batch summaries use unweighted per-run macro values. Operations from different runs are never pooled
into one numerator or denominator.

### Sibling group

A sibling group is the set of different child sessions sharing one non-null `parentSessionId` inside
one run. A run can contain more than one sibling group when nested fan-out occurs.

D0.1 exact signatures and presence denominators are computed inside a parent/sibling group and never
cross run boundaries.

### Units used only as evidence

- message execution: lifecycle/concurrency evidence inside one run;
- tool invocation: objective raw operation source;
- shell segment and normalized operation: derived deterministic evidence;
- strict cluster: observed exact normalized-input duplication, not a statistical unit for campaign
  inference.

## 2. Frozen initial analysis baseline

The first large-scale campaign must use:

```text
per-run profile: block-d0-v1
operation ruleset: openinspect-operation-rules-block-c-v2
semantic ruleset: openinspect-package-command-rules-block-c-v2
duplication schema: openinspect-observed-duplication-block-d0-v1
batch schema: openinspect-trace-batch-aggregate-e0-v0
```

Rules:

1. Never silently re-run historical bundles with a changed parser/metric and replace old results.
2. Any parser, signature, denominator, or metric change requires a new explicit profile/schema.
3. New-profile results must be written beside, not over, the frozen baseline.
4. Every metadata record stores its exact profile, schemas, rulesets, input fingerprint, output
   path, and summary digest.
5. Campaign reports must state whether they use the frozen baseline or a later sensitivity profile.

## 3. Claim boundary

The campaign starts with the claim statuses in
[CLAIM_EVIDENCE_MATRIX.md](./CLAIM_EVIDENCE_MATRIX.md).

`GO` means the current trace/analyzer can support a bounded descriptive claim over the sampled runs.
It does not mean population generalization or causal interpretation is automatic.

`LIMITED` means the evidence can be reported only with an explicit proxy/coverage limitation.

`BLOCKED` means the claim must not appear as a result until a future evidence-producing protocol is
defined and executed.

## 4. Campaign and sampling design

Before collection, create a campaign ID and freeze a sampling plan. Record planned and realized
counts for every stratum; do not fill available capacity opportunistically without updating the
campaign log.

### Required sampling dimensions

- task type: bug fix, feature, refactor, test generation, dependency/security audit, performance,
  review, documentation, or declared `other`;
- repository type: language, monorepo/single-package, application/library, approximate size, and
  domain;
- fan-out origin: `prompt_prescribed`, `agent_emergent`, `hybrid`, `none`, or `unknown`;
- configured and observed child width/depth;
- model and reasoning configuration;
- sandbox provider plus cold/warm and image/snapshot state;
- task-success/ground-truth status;
- repeated-trial group and trial index.

### Separation rules

1. Prompt-prescribed and agent-emergent fan-out are separate strata. They may be shown side by side
   but must not be merged under an unlabeled “natural fan-out” claim.
2. Configured child limits and observed topology are separate fields.
3. Runs at different commits are different task instances unless a deliberate longitudinal design
   says otherwise.
4. Repeated trials preserve repo commit, prompt, model, reasoning, limits, sandbox condition, and
   validation method; any deviation is recorded.
5. Failed/partial/successful tasks remain visible and are stratified rather than silently discarded.

### Avoiding domination by one source

- report run counts by repo and task type before any aggregate;
- use unweighted run-level macro summaries;
- publish per-stratum summaries where sample sizes allow descriptive comparison;
- pre-register per-repo/per-task caps or quotas before large collection;
- do not let one very large repository or one prompt family provide most runs without labeling the
  campaign as such;
- retain repeated trials as separate runs but identify their `repeatGroupId` so readers can audit
  dependence.

F0 deliberately does not choose numeric quotas or repeat counts. Those are campaign decisions listed
under “Open decisions.”

## 5. Metadata location and lifecycle

Raw trace bundles are immutable. Never add metadata files inside an exported bundle after its
`hashes.json` is frozen.

Recommended registry layout:

```text
experiments/openinspect/<campaign-id>/
  campaign-plan.md
  run-metadata/
    <run-id>.json
  failure-log.jsonl
```

Use [RUN_METADATA_TEMPLATE.json](./RUN_METADATA_TEMPLATE.json) and validate against
[RUN_METADATA_SCHEMA.json](./RUN_METADATA_SCHEMA.json). The human-readable contract is
[RUN_METADATA_SCHEMA.md](./RUN_METADATA_SCHEMA.md).

Lifecycle:

1. `draft`: task/repo/prompt/config are frozen before launch;
2. `exported`: bundle path/fingerprint and raw validation result are attached;
3. `analyzed`: frozen per-run profile output and coverage are attached;
4. `adjudicated`: claim-specific quality-gate dispositions are final;
5. `failed`: a preserved run/export/analysis failure record, never deleted to improve results.

Full prompts must be recorded, but metadata must contain no secrets. Prompts must be sanitized
before the run. If a secret is discovered later, do not persist it in metadata; mark prompt capture
as redacted and make the run ineligible for primary prompt-conditioned analyses.

## 6. Fixed collection workflow

### Step 1 — Run the task

Before launch, create the draft metadata and freeze:

- run/task/repeat IDs;
- repository and commit SHA;
- full prompt and its SHA-256;
- task type;
- model/reasoning settings;
- parent/child limits;
- prescribed/emergent fan-out classification plan;
- sandbox state;
- intended success validator.

After completion, record observed root ID, topology, outcome status, and validation evidence.

### Step 2 — Export the trace

Use an explicit immutable output path:

```bash
node scripts/export-openinspect-trace.mjs \
  --session "<root-session-id-or-url>" \
  --out "traces/openinspect/<run-id>"
```

Do not reuse an existing output directory. Do not wake a closed sandbox merely to improve optional
evidence without recording that intervention.

### Step 3 — Validate raw evidence

Run the zero-operation compatibility profile as the raw/structural gate:

```bash
npm run trace:analyze -- \
  "traces/openinspect/<run-id>" \
  --profile block-ab-v0 \
  --out "analysis/openinspect/validation/<run-id>"
```

Require hash verification, completeness equality, unique topology root, and structural validity.
Record the bundle fingerprint and missingness. Validation failure does not delete the bundle; it
creates an excluded failure record.

### Step 4 — Attach metadata outside the bundle

Complete the exported-state metadata record with:

- relative bundle path;
- root session ID and fingerprint;
- bundle/manifest schema;
- raw validation output and digest;
- missingness inventory;
- secret review.

### Step 5 — Run the frozen per-run analysis

```bash
npm run trace:analyze -- \
  "traces/openinspect/<run-id>" \
  --profile block-d0-v1
```

Record the output path, profile/schemas/rulesets, summary SHA-256, parser coverage, fallback rate,
and D0.1 metric availability in metadata.

### Step 6 — Run incremental batch aggregation

```bash
npm run trace:batch -- traces/openinspect --profile block-d0-v1
```

The batch workflow discovers recursively, isolates failures, rejects duplicate roots/inputs, reuses
versioned caches, and emits unweighted per-run macro summaries. It never pools operation
denominators.

### Step 7 — Apply the quality gate

Adjudicate claim-specific eligibility and set the final lifecycle state. Preserve excluded and
failed runs in metadata/failure logs. Regenerate the batch only after metadata and failure logs are
complete.

## 7. Quality gates

Quality gates are claim-specific. One run can be primary for topology but ineligible for
duplication. Do not introduce a parser-coverage threshold in F0; record exact coverage and
missingness first.

### Primary analysis

A run is eligible for at least one primary descriptive claim when:

- raw bundle hashes/structure/completeness/root identity pass;
- run ID, task ID, repo commit, full safe prompt, model/reasoning, and fan-out origin are recorded;
- it is not a duplicate root/input;
- the relevant frozen analysis succeeds;
- claim-required evidence is present.

Claim-specific additions:

- topology/fan-out: valid session tree; zero-child runs remain eligible and must not be dropped;
- message concurrency: valid message start/completion intervals and timing missingness recorded;
- strict sibling duplication: at least one sibling group with two children and successful
  `block-d0-v1` output;
- task-outcome association: outcome validator and ground-truth status must be recorded.

Task failure is not automatically excluded from behavior/topology/duplication descriptions; report
it as an outcome stratum to avoid survivorship bias.

### Sensitivity only

Use sensitivity-only disposition when raw evidence remains valid but interpretation is materially
limited, for example:

- fan-out origin is unknown;
- prompt was safely redacted and is no longer complete;
- repo commit or sandbox thermal/image state is uncertain but recoverable identity remains;
- task outcome or validation method is unknown;
- an unusual parser/fallback pattern requires review;
- optional infrastructure logs or tool state transitions are missing.

Low parser coverage alone has no automatic numeric cutoff in F0. Record it, explain affected kinds,
and adjudicate consistently.

### Excluded but preserved

Exclude from the affected primary analysis while retaining the bundle/failure record when:

- hashes, required evidence, completeness, or root topology fail validation;
- root/input duplicates an already registered run;
- repo/commit/run identity cannot be resolved;
- secrets cannot be safely removed from stored metadata;
- export or frozen per-run analysis fails;
- metadata is irrecoverably incomplete for the claim;
- the run was not actually launched or contains no meaningful execution evidence.

An excluded run must include machine-readable reason codes and human notes. Exclusion never deletes
raw evidence.

## 8. Reporting contract

Every campaign report includes:

- realized sampling table by task/repo/fan-out/model/width/depth/outcome;
- counts of primary, sensitivity-only, excluded, and failed runs;
- per-run numerator/denominator/value;
- unweighted macro mean/median/min/max;
- parser/fallback coverage and missingness;
- prescribed and emergent fan-out reported separately;
- frozen profile/schema/ruleset identities;
- explicit claim status from the claim matrix.

No confidence interval is required by F0, and an N=2 pilot must not be presented as inferential
evidence.

## 9. Open decisions for the campaign owner

The protocol is ready, but the following must be chosen before new collection:

1. campaign research question and target population;
2. repository list, licenses/privacy constraints, and per-repo caps;
3. task-type strata and target counts;
4. prompt families and which are prescribed versus emergent fan-out experiments;
5. configured width/depth conditions;
6. model/reasoning configurations and whether they are crossed with task strata;
7. number of repeated trials per frozen task/configuration;
8. sandbox cold/warm/prebuilt/snapshot conditions included in this observational campaign;
9. task-specific success validators and ground-truth sources;
10. whether failed tasks enter the main duplication table as a reported stratum or only a dedicated
    sensitivity table;
11. ordering/randomization plan to reduce provider/cache/time confounding;
12. campaign stopping rule and how deviations are documented.

These choices must be recorded in the campaign plan. They are not silently inferred by the analyzer.

## 10. Explicit non-goals

F0 does not:

- collect any trace;
- add or change a parser/metric;
- compute new experimental statistics;
- pool operations across runs;
- define semantic similarity or finding overlap;
- design replay/eliminability experiments;
- estimate resource, cost, quality, or critical-path savings;
- use an LLM for parsing or numerical analysis.
