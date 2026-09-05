# Block F0 Claim–Evidence Matrix

This matrix is the authorization boundary for claims made from the initial large-scale campaign. The
frozen baseline is `block-d0-v1`; the statistical unit is one parent-rooted run.

Status meanings:

- **GO**: bounded descriptive claim supported for quality-gated sampled runs;
- **LIMITED**: report only as an explicitly labeled proxy or coverage-conditional result;
- **BLOCKED**: do not claim until new evidence and a new protocol exist.

## GO — bounded descriptive claims

| Claim                                                   | Unit                                               | Current evidence                                                                                     | Allowed wording                                                                                                         | Conditions and still-missing evidence                                                                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observed topology and fan-out                           | Run; sibling group within run                      | Validated session IDs, parent links, spawn depth, root identity                                      | Distribution of observed child count, parent groups, depth, leaves, and fan-out in sampled runs                         | Does not establish why fan-out occurred. Prompt-prescribed/emergent classification requires complete prompt metadata. Population generalization still requires a sampling frame. |
| Message-level concurrency                               | Run                                                | Persisted message `startedAt/completedAt`; deterministic interval sweep                              | Peak/mean concurrent message executions and participating sessions in sampled runs                                      | Message intervals include model/tool/wait time. This is not model-compute, CPU, sandbox, or resource concurrency. Clock/missingness must be reported.                            |
| Strict specific sibling-presence duplication            | Run; exact signature presence within sibling group | `block-d0-v1` specific operations, strict signatures, parent/session/invocation/operation back-links | Fraction of eligible distinct specific `(parent, sibling, signature)` presences that are cross-sibling excess presences | Bounded by parser/normalization coverage. It is identical requested normalized input, not identical result, necessity, or eliminability. Requires at least one sibling group.    |
| Syntactic sibling-presence and all-instance sensitivity | Run                                                | Exact `shell_segment` signatures plus D0.1 presence/all/within decomposition                         | Descriptive syntactic presence ratio, all-instance sensitivity, and within-sibling repetition                           | Must stay separate from specific metrics. Do not assign semantic value to command text. Parser and shell-extractor limits remain explicit.                                       |
| Run-level macro pilot summaries                         | Run                                                | E0 per-run numerator/denominator/value; unweighted macro mean/median/min/max                         | Descriptive macro summaries across quality-gated sampled runs                                                           | No operation pooling. N=2 remains pilot only; broader claims need the planned sampling frame and sufficient realized strata.                                                     |

## LIMITED — proxy or coverage-conditioned claims

| Claim                                                        | Why limited                                                                                                       | What may be said now                                                                                                            | Missing evidence needed to upgrade                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| “Computation redundancy” interpretation                      | A repeated normalized request may fail, return different data, or be independently necessary in isolated siblings | Strict request duplication is a proxy/candidate observation for repeated computation; report kind/parser strata and sensitivity | Result/output identity, state/version identity, actual execution outcome, work performed, dependency on later decisions, and intervention evidence |
| Operation-level comparisons under incomplete parser coverage | Unsupported/fallback shell forms and tool-state loss create non-random missing operation semantics                | Compare supported specific operations with per-run parser/fallback coverage and missingness beside every result                 | Additional versioned parsers validated on the affected command/tool distribution, plus sensitivity showing conclusions are stable                  |
| Comparisons across task/repo/model/fan-out strata            | Imbalanced sampling and repeated trials can confound differences                                                  | Descriptive per-stratum tables when realized counts and metadata are shown                                                      | Pre-registered strata/quotas, repeated trials, stable task validators, dependence-aware analysis plan, and enough runs per comparison              |
| Relationship between duplication and task success            | Outcome validation can differ across task types; failed runs may be behaviorally informative                      | Descriptive success-stratified values with validator type and unknown outcomes shown                                            | Comparable ground truth/validators, adequate repeated trials, and a pre-specified association model                                                |
| Agent-emergent fan-out rate                                  | Runtime topology alone cannot distinguish prompt instruction from agent choice                                    | Report only runs whose full prompts and origin adjudication are complete; keep prescribed/emergent separate                     | Prompt family design, adjudication procedure, inter-rater or deterministic classification check, and representative sampling                       |

## BLOCKED — prohibited claims under F0

| Claim                                            | Why blocked                                                                                          | Evidence required before claim becomes eligible                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Eliminability/removable duplication              | Exact repeated request does not prove one instance can be removed safely                             | Explicit deduplication policy, counterfactual/replay or controlled ablation, unchanged downstream behavior, task-quality validation, and failure analysis          |
| Resource or monetary cost savings                | Traces lack complete CPU/memory/network/cache/billing attribution and no removal intervention exists | Calibrated per-run/per-child resource and billing telemetry plus controlled intervention measuring net savings and overhead                                        |
| Critical-path or wall-time savings               | Temporal overlap and duplicate requests do not identify dependencies or causal schedule effects      | Dependency/causal execution model and controlled schedule/replay showing the removed work changes critical-path completion time                                    |
| Quality-preserving deduplication                 | The current analyzer measures requests, not final answer/code quality under deduplication            | Ground-truth quality suite, task-specific acceptance checks, baseline versus deduplicated executions, non-inferiority/equivalence criterion, and sufficient trials |
| Finding/result overlap as computation redundancy | Same findings may arise from different work; same work may produce different findings                | Versioned finding/result representation, attribution from operations to results, evaluator agreement, and a separate claim contract                                |
| General population prevalence                    | Current campaigns do not yet define a representative population or probability sample                | Target population, sampling frame, inclusion probabilities or defensible design, realized response/failure analysis, and inferential protocol                      |

## Required reporting footer

Every paper table/figure derived from this campaign must state:

1. claim status (`GO`, `LIMITED`, or `BLOCKED`);
2. run count and quality-gate dispositions;
3. analysis profile/schema/rulesets;
4. statistical unit and whether aggregation is macro;
5. per-run parser/fallback coverage;
6. prescribed versus emergent fan-out composition;
7. missingness and outcome-validation composition;
8. that observed duplication is not eliminability unless a later authorized protocol provides that
   evidence.
