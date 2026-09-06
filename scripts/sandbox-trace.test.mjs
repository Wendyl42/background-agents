import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachSandboxObservations, resolveTraceSandboxBackend } from "./lib/sandbox-trace.mjs";
import { createSyntheticBundle } from "../tools/openinspect-trace-analysis/test/fixture.mjs";
import { loadTraceBundle } from "../tools/openinspect-trace-analysis/lib/loader.mjs";
import { validateTraceBundle } from "../tools/openinspect-trace-analysis/lib/validator.mjs";
import { hashFile } from "../tools/openinspect-trace-analysis/lib/hash.mjs";

test("backend selection prefers persisted run evidence over current deployment", () => {
  const events = [{ type: "ready", data: { sandboxBackend: "local" } }];
  assert.deepEqual(resolveTraceSandboxBackend({ events, configured: "modal" }), {
    backend: "local",
    source: "ready_events",
    observed: ["local"],
  });
  assert.throws(() => resolveTraceSandboxBackend({ events, requested: "modal" }), /conflicts/);
  assert.equal(
    resolveTraceSandboxBackend({ configured: "modal" }).source,
    "deployment_configuration_unverified"
  );
  assert.equal(resolveTraceSandboxBackend({}).backend, "unknown");
  assert.equal(
    resolveTraceSandboxBackend({
      events: [...events, { type: "ready", data: { sandboxBackend: "modal" } }],
    }).backend,
    "mixed"
  );
});

test("attachments preserve bytes and remain compatible with the v0 loader", (t) => {
  const root = mkdtempSync(join(tmpdir(), "oi-observations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundleDir = createSyntheticBundle(join(root, "bundle"));
  // Old bundles still work with no infrastructure attachment fields.
  assert.equal(validateTraceBundle(loadTraceBundle(bundleDir)).valid, true);
  const input = join(root, "runtime.jsonl");
  const raw = '{"ts":1234,"event":"setup.start","startup_attempt_id":"a"}\r\n';
  writeFileSync(input, raw);
  const observations = attachSandboxObservations({
    outputDir: bundleDir,
    runtimeLogs: [input],
    hostObservations: [input],
  });
  assert.equal(observations.status, "attached");
  assert.equal(observations.hostObservations, "attached");
  const manifestPath = join(bundleDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath));
  manifest.infrastructureLogs = { sandbox: { backend: "local", ...observations } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const hashesPath = join(bundleDir, "hashes.json");
  const hashes = JSON.parse(readFileSync(hashesPath));
  for (const attachment of observations.attachments) {
    const path = join(bundleDir, attachment.path);
    assert.equal(readFileSync(path, "utf8"), raw);
    hashes.files.push({ path: attachment.path, ...hashFile(path) });
  }
  writeFileSync(hashesPath, JSON.stringify(hashes));
  assert.equal(validateTraceBundle(loadTraceBundle(bundleDir)).valid, true);
  writeFileSync(join(bundleDir, observations.attachments[0].path), "tampered");
  assert.throws(() => loadTraceBundle(bundleDir), /Hash verification failed/);
});

test("missing observations stay unavailable; invalid input cannot masquerade as evidence", (t) => {
  const root = mkdtempSync(join(tmpdir(), "oi-invalid-observations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(attachSandboxObservations({ outputDir: root }).status, "unavailable");
  const input = join(root, "invalid.jsonl");
  for (const contents of ["not json", "[]", "null", "123"]) {
    writeFileSync(input, contents);
    assert.throws(() => attachSandboxObservations({ outputDir: root, runtimeLogs: [input] }));
  }
});
