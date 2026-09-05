import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { analyzeTraceBundle } from "../lib/analyze.mjs";
import { renderReport } from "../lib/report.mjs";
import { stableJson } from "../lib/json.mjs";
import { createSyntheticBundle } from "./fixture.mjs";

const CLI = resolve("tools/openinspect-trace-analysis/cli.mjs");
const REAL_CASES = [
  {
    trace: resolve(
      "traces/openinspect/2026-08-19-template-typescript-monorepo-security-audit-4fd2789a"
    ),
    baseline: resolve(
      "analysis/openinspect/4fd2789a968301d04feea8c5cd2a4628/block-ab-v0-99fd024fea2c"
    ),
    blockCBaseline: resolve(
      "analysis/openinspect/4fd2789a968301d04feea8c5cd2a4628/block-c-v0-99fd024fea2c"
    ),
    blockCV1Baseline: resolve(
      "analysis/openinspect/4fd2789a968301d04feea8c5cd2a4628/block-c-v1-99fd024fea2c"
    ),
    blockCV2Baseline: resolve(
      "analysis/openinspect/4fd2789a968301d04feea8c5cd2a4628/block-c-v2-99fd024fea2c"
    ),
    blockD0Baseline: resolve(
      "analysis/openinspect/4fd2789a968301d04feea8c5cd2a4628/block-d0-v0-99fd024fea2c"
    ),
    blockD01Baseline: resolve(
      "analysis/openinspect/4fd2789a968301d04feea8c5cd2a4628/block-d0-v1-99fd024fea2c"
    ),
  },
  {
    trace: resolve("traces/openinspect/1c929e3aed7c97b57563c73e242e603a-2026-08-20T05-38-31-813Z"),
    baseline: resolve(
      "analysis/openinspect/1c929e3aed7c97b57563c73e242e603a/block-ab-v0-df2390e5b457"
    ),
    blockCBaseline: resolve(
      "analysis/openinspect/1c929e3aed7c97b57563c73e242e603a/block-c-v0-df2390e5b457"
    ),
    blockCV1Baseline: resolve(
      "analysis/openinspect/1c929e3aed7c97b57563c73e242e603a/block-c-v1-df2390e5b457"
    ),
    blockCV2Baseline: resolve(
      "analysis/openinspect/1c929e3aed7c97b57563c73e242e603a/block-c-v2-df2390e5b457"
    ),
    blockD0Baseline: resolve(
      "analysis/openinspect/1c929e3aed7c97b57563c73e242e603a/block-d0-v0-df2390e5b457"
    ),
    blockD01Baseline: resolve(
      "analysis/openinspect/1c929e3aed7c97b57563c73e242e603a/block-d0-v1-df2390e5b457"
    ),
  },
];

test(
  "default profile remains block-ab-v0 with byte-identical real output",
  {
    skip: REAL_CASES.some(({ trace, baseline }) => !existsSync(trace) || !existsSync(baseline)),
  },
  () => {
    for (const { trace, baseline } of REAL_CASES) {
      const summary = analyzeTraceBundle(trace);
      assert.deepEqual(
        Buffer.from(stableJson(summary)),
        readFileSync(join(baseline, "summary.json"))
      );
      assert.deepEqual(
        Buffer.from(renderReport(summary)),
        readFileSync(join(baseline, "report.md"))
      );
    }
  }
);

test(
  "block-ab-v0 remains byte-identical for all real artifacts",
  {
    skip: REAL_CASES.some(({ trace, baseline }) => !existsSync(trace) || !existsSync(baseline)),
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oi-block-ab-v0-compat-"));
    const files = ["summary.json", "report.md", "checkpoint.json", "output-hashes.json"];
    for (const [index, { trace, baseline }] of REAL_CASES.entries()) {
      const output = join(root, `case-${index}`);
      execFileSync(process.execPath, [CLI, "analyze", trace, "--out", output]);
      for (const file of files) {
        assert.deepEqual(readFileSync(join(output, file)), readFileSync(join(baseline, file)));
      }
    }
  }
);

test("block-c-v0 writes all deterministic normalization artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-block-c-profile-"));
  const bundle = createSyntheticBundle(join(root, "bundle"));
  const first = join(root, "first");
  const second = join(root, "second");
  for (const output of [first, second]) {
    execFileSync(process.execPath, [
      CLI,
      "analyze",
      bundle,
      "--profile",
      "block-c-v0",
      "--out",
      output,
    ]);
  }
  const files = [
    "summary.json",
    "report.md",
    "checkpoint.json",
    "output-hashes.json",
    "operations.jsonl",
    "normalization-results.jsonl",
    "parser-coverage.json",
    "fallback-invocations.jsonl",
  ];
  for (const file of files) {
    assert.deepEqual(readFileSync(join(first, file)), readFileSync(join(second, file)));
  }
  const report = readFileSync(join(first, "report.md"), "utf8");
  const operations = readFileSync(join(first, "operations.jsonl"), "utf8");
  assert.match(report, /Operation Normalization/);
  assert.match(report, /Generic shell segmentation is always \*\*syntactic\*\*/);
  assert.match(report, /### By session/);
  assert.doesNotMatch(report, /DO_NOT_COPY/);
  assert.doesNotMatch(operations, /DO_NOT_COPY/);
});

test(
  "block-c-v0 remains byte-identical for all real artifacts",
  {
    skip: REAL_CASES.some(
      ({ trace, blockCBaseline }) => !existsSync(trace) || !existsSync(blockCBaseline)
    ),
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oi-block-c-v0-compat-"));
    const files = [
      "summary.json",
      "report.md",
      "checkpoint.json",
      "output-hashes.json",
      "operations.jsonl",
      "normalization-results.jsonl",
      "parser-coverage.json",
      "fallback-invocations.jsonl",
    ];
    for (const [index, { trace, blockCBaseline }] of REAL_CASES.entries()) {
      const output = join(root, `case-${index}`);
      execFileSync(process.execPath, [
        CLI,
        "analyze",
        trace,
        "--profile",
        "block-c-v0",
        "--out",
        output,
      ]);
      for (const file of files) {
        assert.deepEqual(
          readFileSync(join(output, file)),
          readFileSync(join(blockCBaseline, file))
        );
      }
    }
  }
);

test("block-c-v1 repeated runs are byte-identical and plaintext-free", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-block-c-v1-profile-"));
  const bundle = createSyntheticBundle(join(root, "bundle"));
  const first = join(root, "first");
  const second = join(root, "second");
  for (const output of [first, second]) {
    execFileSync(process.execPath, [
      CLI,
      "analyze",
      bundle,
      "--profile",
      "block-c-v1",
      "--out",
      output,
    ]);
  }
  const files = [
    "summary.json",
    "report.md",
    "checkpoint.json",
    "output-hashes.json",
    "operations.jsonl",
    "normalization-results.jsonl",
    "parser-coverage.json",
    "fallback-invocations.jsonl",
  ];
  for (const file of files) {
    const firstBytes = readFileSync(join(first, file));
    assert.deepEqual(firstBytes, readFileSync(join(second, file)));
    assert.doesNotMatch(firstBytes.toString("utf8"), /DO_NOT_COPY/);
  }
  const summary = JSON.parse(readFileSync(join(first, "summary.json"), "utf8"));
  assert.equal(summary.analysisProfile, "block-c-v1");
  assert.equal(summary.normalization.rulesetVersion, "openinspect-operation-rules-block-c-v1");
});

test(
  "block-c-v1 remains byte-identical for all real artifacts",
  {
    skip: REAL_CASES.some(
      ({ trace, blockCV1Baseline }) => !existsSync(trace) || !existsSync(blockCV1Baseline)
    ),
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oi-block-c-v1-compat-"));
    const files = [
      "summary.json",
      "report.md",
      "checkpoint.json",
      "output-hashes.json",
      "operations.jsonl",
      "normalization-results.jsonl",
      "parser-coverage.json",
      "fallback-invocations.jsonl",
    ];
    for (const [index, { trace, blockCV1Baseline }] of REAL_CASES.entries()) {
      const output = join(root, `case-${index}`);
      execFileSync(process.execPath, [
        CLI,
        "analyze",
        trace,
        "--profile",
        "block-c-v1",
        "--out",
        output,
      ]);
      for (const file of files) {
        assert.deepEqual(
          readFileSync(join(output, file)),
          readFileSync(join(blockCV1Baseline, file))
        );
      }
    }
  }
);

test("block-c-v2 repeated runs are byte-identical across all artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-block-c-v2-profile-"));
  const bundle = createSyntheticBundle(join(root, "bundle"));
  const first = join(root, "first");
  const second = join(root, "second");
  for (const output of [first, second]) {
    execFileSync(process.execPath, [
      CLI,
      "analyze",
      bundle,
      "--profile",
      "block-c-v2",
      "--out",
      output,
    ]);
  }
  const files = [
    "summary.json",
    "report.md",
    "checkpoint.json",
    "output-hashes.json",
    "operations.jsonl",
    "normalization-results.jsonl",
    "parser-coverage.json",
    "fallback-invocations.jsonl",
    "shell-segments.jsonl",
    "layer-coverage.json",
  ];
  for (const file of files) {
    assert.deepEqual(readFileSync(join(first, file)), readFileSync(join(second, file)));
  }
  const summary = JSON.parse(readFileSync(join(first, "summary.json"), "utf8"));
  assert.equal(summary.analysisProfile, "block-c-v2");
  assert.equal(summary.normalization.rulesetVersion, "openinspect-operation-rules-block-c-v2");
  assert.match(readFileSync(join(first, "report.md"), "utf8"), /Three-layer normalization/);
});

test(
  "block-c-v2 remains byte-identical for all real artifacts",
  {
    skip: REAL_CASES.some(
      ({ trace, blockCV2Baseline }) => !existsSync(trace) || !existsSync(blockCV2Baseline)
    ),
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oi-block-c-v2-compat-"));
    const files = [
      "summary.json",
      "report.md",
      "checkpoint.json",
      "output-hashes.json",
      "operations.jsonl",
      "normalization-results.jsonl",
      "parser-coverage.json",
      "fallback-invocations.jsonl",
      "shell-segments.jsonl",
      "layer-coverage.json",
    ];
    for (const [index, { trace, blockCV2Baseline }] of REAL_CASES.entries()) {
      const output = join(root, `case-${index}`);
      execFileSync(process.execPath, [
        CLI,
        "analyze",
        trace,
        "--profile",
        "block-c-v2",
        "--out",
        output,
      ]);
      for (const file of files) {
        assert.deepEqual(
          readFileSync(join(output, file)),
          readFileSync(join(blockCV2Baseline, file))
        );
      }
    }
  }
);

test("block-d0-v0 repeated runs are byte-identical across all artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-block-d0-profile-"));
  const bundle = createSyntheticBundle(join(root, "bundle"));
  const first = join(root, "first");
  const second = join(root, "second");
  for (const output of [first, second]) {
    execFileSync(process.execPath, [
      CLI,
      "analyze",
      bundle,
      "--profile",
      "block-d0-v0",
      "--out",
      output,
    ]);
  }
  const files = [
    "summary.json",
    "report.md",
    "checkpoint.json",
    "output-hashes.json",
    "operations.jsonl",
    "normalization-results.jsonl",
    "parser-coverage.json",
    "fallback-invocations.jsonl",
    "shell-segments.jsonl",
    "layer-coverage.json",
    "exact-duplication-clusters.jsonl",
    "shared-target-overlaps.jsonl",
    "sibling-duplication-matrix.json",
    "sibling-duplication-matrix.csv",
    "duplication-metrics.json",
  ];
  for (const file of files) {
    assert.deepEqual(readFileSync(join(first, file)), readFileSync(join(second, file)));
  }
  const summary = JSON.parse(readFileSync(join(first, "summary.json"), "utf8"));
  assert.equal(summary.analysisProfile, "block-d0-v0");
  assert.equal(
    summary.observedDuplication.schemaVersion,
    "openinspect-observed-duplication-block-d0-v0"
  );
  const report = readFileSync(join(first, "report.md"), "utf8");
  assert.match(report, /Strict observed duplication/);
  assert.match(report, /does \*\*not\*\* claim result equivalence/);
});

test(
  "block-d0-v0 remains byte-identical for all real artifacts",
  {
    skip: REAL_CASES.some(
      ({ trace, blockD0Baseline }) => !existsSync(trace) || !existsSync(blockD0Baseline)
    ),
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oi-block-d0-v0-compat-"));
    const files = [
      "summary.json",
      "report.md",
      "checkpoint.json",
      "output-hashes.json",
      "operations.jsonl",
      "normalization-results.jsonl",
      "parser-coverage.json",
      "fallback-invocations.jsonl",
      "shell-segments.jsonl",
      "layer-coverage.json",
      "exact-duplication-clusters.jsonl",
      "shared-target-overlaps.jsonl",
      "sibling-duplication-matrix.json",
      "sibling-duplication-matrix.csv",
      "duplication-metrics.json",
    ];
    for (const [index, { trace, blockD0Baseline }] of REAL_CASES.entries()) {
      const output = join(root, `case-${index}`);
      execFileSync(process.execPath, [
        CLI,
        "analyze",
        trace,
        "--profile",
        "block-d0-v0",
        "--out",
        output,
      ]);
      for (const file of files) {
        assert.deepEqual(
          readFileSync(join(output, file)),
          readFileSync(join(blockD0Baseline, file))
        );
      }
    }
  }
);

test("block-d0-v1 repeated runs are byte-identical across all artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-block-d0-v1-profile-"));
  const bundle = createSyntheticBundle(join(root, "bundle"));
  const first = join(root, "first");
  const second = join(root, "second");
  for (const output of [first, second]) {
    execFileSync(process.execPath, [
      CLI,
      "analyze",
      bundle,
      "--profile",
      "block-d0-v1",
      "--out",
      output,
    ]);
  }
  const files = [
    "summary.json",
    "report.md",
    "checkpoint.json",
    "output-hashes.json",
    "operations.jsonl",
    "normalization-results.jsonl",
    "parser-coverage.json",
    "fallback-invocations.jsonl",
    "shell-segments.jsonl",
    "layer-coverage.json",
    "exact-duplication-clusters.jsonl",
    "shared-target-overlaps.jsonl",
    "sibling-duplication-matrix.json",
    "sibling-duplication-matrix.csv",
    "duplication-metrics.json",
  ];
  for (const file of files) {
    assert.deepEqual(readFileSync(join(first, file)), readFileSync(join(second, file)));
  }
  const summary = JSON.parse(readFileSync(join(first, "summary.json"), "utf8"));
  assert.equal(summary.analysisProfile, "block-d0-v1");
  assert.equal(
    summary.observedDuplication.schemaVersion,
    "openinspect-observed-duplication-block-d0-v1"
  );
  assert.match(readFileSync(join(first, "report.md"), "utf8"), /Sibling-presence sensitivity/);
});

test(
  "block-d0-v1 remains byte-identical for all real artifacts",
  {
    skip: REAL_CASES.some(
      ({ trace, blockD01Baseline }) => !existsSync(trace) || !existsSync(blockD01Baseline)
    ),
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oi-block-d0-v1-compat-"));
    const files = [
      "summary.json",
      "report.md",
      "checkpoint.json",
      "output-hashes.json",
      "operations.jsonl",
      "normalization-results.jsonl",
      "parser-coverage.json",
      "fallback-invocations.jsonl",
      "shell-segments.jsonl",
      "layer-coverage.json",
      "exact-duplication-clusters.jsonl",
      "shared-target-overlaps.jsonl",
      "sibling-duplication-matrix.json",
      "sibling-duplication-matrix.csv",
      "duplication-metrics.json",
    ];
    for (const [index, { trace, blockD01Baseline }] of REAL_CASES.entries()) {
      const output = join(root, `case-${index}`);
      execFileSync(process.execPath, [
        CLI,
        "analyze",
        trace,
        "--profile",
        "block-d0-v1",
        "--out",
        output,
      ]);
      for (const file of files) {
        assert.deepEqual(
          readFileSync(join(output, file)),
          readFileSync(join(blockD01Baseline, file))
        );
      }
    }
  }
);
