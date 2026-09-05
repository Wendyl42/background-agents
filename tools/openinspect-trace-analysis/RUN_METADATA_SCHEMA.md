# Block F0 Run Metadata Contract

Machine schema: [RUN_METADATA_SCHEMA.json](./RUN_METADATA_SCHEMA.json)

Editable starting point: [RUN_METADATA_TEMPLATE.json](./RUN_METADATA_TEMPLATE.json)

Schema version: `openinspect-run-metadata-f0-v0`

One metadata document describes one parent-rooted run. It lives outside the immutable trace bundle.

## Required identity

### Campaign

- `campaignId`: stable campaign identifier;
- `protocolVersion`: `block-f0-v0` for the initial campaign;
- `repeatGroupId`: shared by repeated trials of one frozen task/configuration;
- `trialIndex`: zero- or one-based convention fixed by the campaign plan;
- `plannedStrata[]`: explicit sampling-stratum labels.

### Run and task

- `run.runId`: unique experimental run ID, not silently reused after failure;
- `run.taskId`: stable task definition ID;
- `run.rootSessionId`: observed OpenInspect root after launch;
- start/completion timestamps;
- `task.type`: controlled task-type category;
- task source/reference, subtype, description, and ground-truth availability.

### Repository

- provider, owner, name;
- immutable commit SHA;
- language/domain/architecture and approximate size bucket;
- fork/private flags without credentials or clone tokens.

A moving branch name is not a substitute for commit SHA.

## Full prompt and secret boundary

`prompt.text` is the full prompt sent to the parent. Record its SHA-256 independently. Set:

```text
captureStatus = complete
containsSecrets = false
```

Metadata must not contain API keys, tokens, passwords, private keys, signed URLs, cookies, or secret
environment values. Sanitize prompts before running the task. If later redaction is required,
`captureStatus=redacted` and the run cannot support primary prompt-conditioned claims.

The schema records a separate `secretReview` with method, reviewer, and finding count.

## Model and reasoning configuration

Record parent and child configurations separately:

- provider and exact model ID;
- normalized reasoning effort (`none/low/medium/high/xhigh/unknown`);
- raw provider setting;
- temperature/max-output settings when applicable;
- assignment policy when children vary.

Do not write provider credentials.

## Orchestration and fan-out

Record configured limits and observed topology separately:

- maximum children/depth/concurrent children;
- timeout limits with units;
- fan-out origin: `prompt_prescribed`, `agent_emergent`, `hybrid`, `none`, or `unknown`;
- origin evidence/adjudicator;
- prescribed child count/strategies if present;
- actual child count, maximum depth, sibling-group count, and width by depth.

Prompt-prescribed and agent-emergent runs remain separate strata.

## Sandbox condition

Required:

- provider;
- isolation unit;
- thermal start state: `cold`, `warm`, `mixed`, or `unknown`;
- environment materialization: `base_image`, `prebuilt_image`, `snapshot_restore`, `reused_live`,
  `mixed`, or `unknown`;
- image/snapshot identifiers when non-secret;
- region and cache-state notes.

These fields describe observed/configured conditions; they are not resource measurements.

## Outcome and ground truth

Record:

- status: success/partial/failure/unknown;
- validation methods;
- ground-truth availability/source;
- validation commands or procedure;
- concise evidence and limitations;
- evaluator identity/type and whether adjudication was blinded.

Never infer success solely from an agent saying it succeeded.

## Export and analysis provenance

### Trace export

- immutable bundle path outside metadata;
- root ID, bundle fingerprint, manifest schema;
- export status/timestamp;
- exporter repository commit or script digest;
- raw validation output path/digest;
- `hashesVerified` result.

### Frozen analysis

Initial baseline values:

```text
profileId = block-d0-v1
analysisSchemaVersion = openinspect-trace-analysis-block-d0-v1
operationRulesetVersion = openinspect-operation-rules-block-c-v2
semanticRulesetVersion = openinspect-package-command-rules-block-c-v2
duplicationSchemaVersion = openinspect-observed-duplication-block-d0-v1
```

Also record output path, summary SHA-256, invocation parser coverage, shell semantic reach, fallback
rate, and whether D0.1 metrics are available.

## Missingness

Copy no large raw payload into metadata. Record the missingness source path/digest and bounded
items:

```text
code
status = present | partial | missing | not_applicable | unknown
claimImpact
notes
```

There is no automatic parser-coverage threshold in F0.

## Quality gate

The metadata stores:

- overall disposition: `pending`, `primary`, `sensitivity_only`, or `excluded`;
- claim-specific dispositions for topology, concurrency, duplication, and outcome association;
- machine reason codes and human notes;
- adjudicator and timestamp.

Recommended reason codes:

```text
RAW_VALID
RAW_HASH_FAILURE
RAW_COMPLETENESS_FAILURE
DUPLICATE_ROOT_OR_INPUT
METADATA_COMPLETE
METADATA_INCOMPLETE
PROMPT_COMPLETE
PROMPT_REDACTED
SECRET_RISK
COMMIT_RESOLVED
COMMIT_UNKNOWN
FANOUT_ORIGIN_KNOWN
FANOUT_ORIGIN_UNKNOWN
NO_SIBLING_GROUP
ANALYSIS_SUCCESS
ANALYSIS_FAILURE
PARSER_COVERAGE_REVIEW
OUTCOME_VALIDATED
OUTCOME_UNKNOWN
SANDBOX_STATE_UNKNOWN
```

No run is deleted because of its disposition. Excluded/failed records remain in campaign logs.

## Metadata completion checklist

Before `adjudicated`:

1. full safe prompt and prompt hash agree;
2. repo commit is immutable and resolvable;
3. root session ID equals manifest/completeness/analysis root;
4. bundle fingerprint equals per-run analysis input fingerprint;
5. analysis profile/schemas/rulesets match the output;
6. coverage/missingness are copied from deterministic artifacts;
7. outcome validator is recorded or explicitly unknown;
8. fan-out origin is adjudicated or explicitly unknown;
9. claim-specific quality gates contain reasons;
10. secret review reports zero stored secrets.
