# Trace Analysis Status

Current implementation summary. Commands live in [README.md](README.md); historical stage-by-stage
validation is retained in [history/CHECKPOINTS.md](history/CHECKPOINTS.md). This page does not
select or authorize the next experiment.

## Implemented workflows

| Workflow               | Current capability                                                                                                                | Definition / evidence                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Per-bundle analysis    | Hash/structure validation, session topology, lifecycle, concurrency, versioned normalization and strict sibling duplication       | [Measurement contract](MEASUREMENT_CONTRACT.md), [IR](INTERMEDIATE_REPRESENTATION.md) |
| Duplication batches    | Recursive bundle discovery, isolated failures, versioned cache, equal-weight run-level macro summaries; defaults to `block-d0-v1` | [Measurement contract](MEASUREMENT_CONTRACT.md)                                       |
| F0 experiment protocol | Documented sampling, metadata, quality gates, and bounded claim rules for the `block-d0-v1` baseline                              | [Protocol](EXPERIMENT_PROTOCOL.md), [claim matrix](CLAIM_EVIDENCE_MATRIX.md)          |

The per-bundle CLI still defaults to `block-ab-v0`, which emits no normalized operations. F0 is a
protocol for a separate collection campaign, not another executable profile.

## Evidence limits

- Only `openinspect-trace-v0` bundles are supported by the current loader.
- Tool snapshots are upserted, step events are not persisted, and invocation endpoints use
  uncalibrated clocks. See the [collection path](../../docs/TRACE_PIPELINE.md).
- Shell segments describe requested syntax; there is no independent timing for each derived
  operation. Synthetic/clamped intervals in the IR are not observed durations.
- Count-based duplication, cumulative invocation time, task wall time, and resource use have
  distinct meanings. Current outputs do not establish removable work or critical-path savings.
- The original pilot lacks resource time series. Current profiles do not compute CPU, memory, or I/O
  attribution.
- Other unimplemented analysis includes semantic action/episode grouping, relaxed similarity,
  execution-outcome parsing, and git/npx/yarn semantic normalization.

## Results and verification records

- [Historical checkpoints](history/CHECKPOINTS.md): the two-run pilot, A–F development stages,
  profile compatibility checks, and batch results.

Local trace bundles and generated analysis are ignored by Git. Their availability differs by
machine. The test suite has synthetic fixtures and optional real-pilot checks; use
`npm run test:trace-analysis` for the current checkout rather than treating a historical test count
as a live test result. No new collection or inference was performed when writing the F0 protocol.
