import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createSyntheticBundle } from "./fixture.mjs";

const CLI = resolve("tools/openinspect-trace-analysis/cli.mjs");

test("CLI writes deterministic output outside the bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-trace-cli-"));
  const bundle = createSyntheticBundle(join(root, "bundle"));
  const outputA = join(root, "analysis-a");
  const outputB = join(root, "analysis-b");
  execFileSync(process.execPath, [CLI, "analyze", bundle, "--out", outputA]);
  execFileSync(process.execPath, [CLI, "analyze", bundle, "--out", outputB]);
  for (const file of ["summary.json", "report.md", "checkpoint.json", "output-hashes.json"]) {
    assert.deepEqual(readFileSync(join(outputA, file)), readFileSync(join(outputB, file)));
  }
});

test("CLI refuses to write inside the immutable trace bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "oi-trace-cli-inside-"));
  const bundle = createSyntheticBundle(join(root, "bundle"));
  const result = spawnSync(
    process.execPath,
    [CLI, "analyze", bundle, "--out", join(bundle, "analysis")],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Analysis output must be outside/);
});
