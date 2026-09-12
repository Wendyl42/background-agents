# Collaboration package utilities

These utilities assembled the September 2026 primary-30 and supplement-4 research dataset. They do
not publish a GitHub release or run benchmark models.

- `build.py --out <new-directory> [--lab-root <benchmark-lab>]` assembles a sanitized candidate from
  local original evidence. It preserves provenance and cohort indices, removes private runtime
  stores and Git internals, and scans retained content. It is an assembly step, not a complete
  publication pipeline: the reviewed README, root verifier, final manifest and archive checksums
  must be added and checked before distributing a new candidate. A new build is not the already
  reviewed dataset.
- `verify.py` runs from a completed bundle root (or accepts `--root`) to verify its manifest,
  required evidence and cohort identities. See `--help` for path resolution and cohort listing
  options.
- `test_build.py` covers credential handling, identity preservation and archive safety. Run
  `python3 -m pytest tools/benchmark-release/test_build.py -q` with pytest installed.

The completed package and its checksums remain outside Git under
`.cache/benchmark-releases/benchmark-collaboration-2026-09-11-v1/`. The user chose local transfer to
a Mac; no data assets were uploaded or published. See `docs/benchmark/README.md` and
`docs/benchmark/RELEASE_PACKAGE_REVIEW.md` for the dataset scope and review. Do not edit original
evidence or substitute later formatted source files for the historical snapshots retained in that
package.
