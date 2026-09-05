import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTraceBundle } from "../lib/loader.mjs";
import { validateTraceBundle } from "../lib/validator.mjs";
import { createSyntheticBundle } from "./fixture.mjs";

function fixture() {
  return createSyntheticBundle(mkdtempSync(join(tmpdir(), "oi-trace-fixture-")));
}

test("loader verifies hashes and validator accepts the fixture", () => {
  const bundle = loadTraceBundle(fixture());
  const validation = validateTraceBundle(bundle);
  assert.equal(validation.valid, true);
  assert.equal(validation.verifiedFileCount, 5);
  assert.deepEqual(validation.counts, { sessions: 2, events: 10, messages: 2 });
  assert.deepEqual(validation.rootSessionIds, ["root"]);
});

test("loader fails closed when a hashed file changes", () => {
  const root = fixture();
  const path = join(root, "normalized/messages.jsonl");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
  assert.throws(() => loadTraceBundle(root), /Hash verification failed/);
});

test("loader rejects a missing required evidence hash entry", () => {
  const root = fixture();
  const path = join(root, "hashes.json");
  const hashes = JSON.parse(readFileSync(path, "utf8"));
  hashes.files = hashes.files.filter((entry) => entry.path !== "normalized/messages.jsonl");
  writeFileSync(path, `${JSON.stringify(hashes, null, 2)}\n`);
  assert.throws(() => loadTraceBundle(root), /normalized\/messages\.jsonl \(found 0\)/);
});

test("loader rejects a duplicate required evidence hash entry", () => {
  const root = fixture();
  const path = join(root, "hashes.json");
  const hashes = JSON.parse(readFileSync(path, "utf8"));
  const required = hashes.files.find((entry) => entry.path === "normalized/messages.jsonl");
  hashes.files.push(structuredClone(required));
  writeFileSync(path, `${JSON.stringify(hashes, null, 2)}\n`);
  assert.throws(() => loadTraceBundle(root), /normalized\/messages\.jsonl \(found 2\)/);
});

test("loader rejects required evidence symlinked outside the bundle", () => {
  const root = fixture();
  const evidence = join(root, "normalized/messages.jsonl");
  const externalDir = mkdtempSync(join(tmpdir(), "oi-trace-external-"));
  const external = join(externalDir, "messages.jsonl");
  writeFileSync(external, readFileSync(evidence));
  unlinkSync(evidence);
  symlinkSync(external, evidence);
  assert.throws(() => loadTraceBundle(root), /must not contain symlinks/);
});

test("loader rejects non-regular required evidence", () => {
  const root = fixture();
  const evidence = join(root, "normalized/messages.jsonl");
  unlinkSync(evidence);
  mkdirSync(evidence);
  assert.throws(() => loadTraceBundle(root), /must be a regular file/);
});

test("loader rejects symlinks for extra hashes.json entries", () => {
  const root = fixture();
  const externalDir = mkdtempSync(join(tmpdir(), "oi-trace-extra-external-"));
  const external = join(externalDir, "extra.txt");
  writeFileSync(external, "extra\n");
  const linked = join(root, "extra.txt");
  symlinkSync(external, linked);
  const path = join(root, "hashes.json");
  const hashes = JSON.parse(readFileSync(path, "utf8"));
  hashes.files.push({
    path: "extra.txt",
    bytes: 6,
    sha256: "7d4e5c6f2e6f1f06e0b5e95f56fbe736e73a7b8a6c0f5f65e795fc5f6f4c9e82",
  });
  writeFileSync(path, `${JSON.stringify(hashes, null, 2)}\n`);
  assert.throws(() => loadTraceBundle(root), /must not contain symlinks/);
});

test("validator reports missing parents and depth mismatches", () => {
  const bundle = loadTraceBundle(fixture());
  bundle.sessions[1].parentSessionId = "missing";
  bundle.sessions[1].spawnDepth = 9;
  const result = validateTraceBundle(bundle, { throwOnError: false });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /missing parent/);
});

test("validator reports duplicate composite event IDs", () => {
  const bundle = loadTraceBundle(fixture());
  bundle.events.push(structuredClone(bundle.events[0]));
  bundle.manifest.counts.events += 1;
  bundle.completeness.eventCount += 1;
  bundle.completeness.sessions[0].eventCount += 1;
  bundle.completeness.eventTypes.ready += 1;
  const result = validateTraceBundle(bundle, { throwOnError: false });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /Duplicate composite event ID/);
});

test("validator rejects completeness.sessions missing a real session", () => {
  const bundle = loadTraceBundle(fixture());
  bundle.completeness.sessions = bundle.completeness.sessions.filter(
    (entry) => entry.sessionId !== "child"
  );
  const result = validateTraceBundle(bundle, { throwOnError: false });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /completeness\.sessions.*missing=\[child\]/);
});

test("validator rejects completeness.sessions with an extra session", () => {
  const bundle = loadTraceBundle(fixture());
  bundle.completeness.sessions.push({ sessionId: "ghost", eventCount: 0, messageCount: 0 });
  const result = validateTraceBundle(bundle, { throwOnError: false });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /completeness\.sessions.*extra=\[ghost\]/);
});

test("validator rejects duplicate completeness.sessions entries", () => {
  const bundle = loadTraceBundle(fixture());
  bundle.completeness.sessions.push(structuredClone(bundle.completeness.sessions[0]));
  const result = validateTraceBundle(bundle, { throwOnError: false });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /Duplicate completeness session entry: root/);
});

test("validator rejects completeness.sessionIds mismatch and duplicates", () => {
  const bundle = loadTraceBundle(fixture());
  bundle.completeness.sessionIds = ["root", "root"];
  const result = validateTraceBundle(bundle, { throwOnError: false });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /Duplicate completeness\.sessionIds entry: root/);
  assert.match(result.errors.join("\n"), /completeness\.sessionIds.*missing=\[child\]/);
});

test("validator rejects manifest or completeness root mismatch", () => {
  const manifestMismatch = loadTraceBundle(fixture());
  manifestMismatch.manifest.source.rootSessionId = "child";
  const manifestResult = validateTraceBundle(manifestMismatch, { throwOnError: false });
  assert.equal(manifestResult.valid, false);
  assert.match(manifestResult.errors.join("\n"), /manifest\.source\.rootSessionId=child/);

  const completenessMismatch = loadTraceBundle(fixture());
  completenessMismatch.completeness.rootSessionId = "child";
  const completenessResult = validateTraceBundle(completenessMismatch, { throwOnError: false });
  assert.equal(completenessResult.valid, false);
  assert.match(completenessResult.errors.join("\n"), /completeness\.rootSessionId=child/);
});

test("validator rejects an extra topology root", () => {
  const bundle = loadTraceBundle(fixture());
  const child = bundle.sessions.find((session) => session.id === "child");
  child.parentSessionId = null;
  child.spawnDepth = 0;
  const result = validateTraceBundle(bundle, { throwOnError: false });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /requires exactly one topology root \(found 2\)/);
});
