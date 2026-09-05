import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInvocations } from "../lib/normalization/engine.mjs";
import { createBlockCV1RuleRegistry } from "../lib/normalization/ruleset.mjs";

function invocation(id, tool, args, output = null) {
  return {
    invocationId: `session:${id}`,
    sourceEventId: id,
    sessionId: "session",
    messageId: "message",
    callId: id,
    tool,
    args,
    output,
    status: "completed",
    startedAtMs: 1,
    finishedAtMs: 2,
    rawFinishedAtMs: 2,
    timingQuality: "sandbox_final_timestamp",
    timingRepair: null,
    operations: [],
  };
}

function normalizeOne(item) {
  const result = normalizeInvocations([item], createBlockCV1RuleRegistry());
  return { operation: result.operations[0] ?? null, result: result.results[0], all: result };
}

test("read selector parameters distinguish missing and explicit values", () => {
  const missing = normalizeOne(invocation("missing", "read", { filePath: "/a" })).operation;
  const explicit = normalizeOne(
    invocation("explicit", "read", { filePath: "/a", offset: 0, limit: 100 })
  ).operation;
  assert.deepEqual(missing.parameters, {
    selector: { offset: { present: false }, limit: { present: false } },
  });
  assert.deepEqual(explicit.parameters, {
    selector: {
      offset: { present: true, value: 0 },
      limit: { present: true, value: 100 },
    },
  });
  assert.notEqual(missing.inputFingerprint, explicit.inputFingerprint);
});

test("read fingerprints are stable for identical ranges and differ for selectors", () => {
  const first = normalizeOne(
    invocation("first", "read", { filePath: "/a", offset: 10, limit: 20 })
  ).operation;
  const same = normalizeOne(
    invocation("same", "read", { filePath: "/a", offset: 10, limit: 20 })
  ).operation;
  const differentOffset = normalizeOne(
    invocation("offset", "read", { filePath: "/a", offset: 11, limit: 20 })
  ).operation;
  const differentLimit = normalizeOne(
    invocation("limit", "read", { filePath: "/a", offset: 10, limit: 21 })
  ).operation;
  assert.equal(first.inputFingerprint, same.inputFingerprint);
  assert.notEqual(first.inputFingerprint, differentOffset.inputFingerprint);
  assert.notEqual(first.inputFingerprint, differentLimit.inputFingerprint);
});

test("invalid read selectors fall back without correction", () => {
  for (const args of [
    { filePath: "/a", offset: -1 },
    { filePath: "/a", offset: 1.5 },
    { filePath: "/a", limit: 0 },
    { filePath: "/a", limit: "10" },
  ]) {
    const normalized = normalizeOne(invocation(JSON.stringify(args), "read", args));
    assert.equal(normalized.operation, null);
    assert.equal(normalized.result.status, "fallback");
  }
});

test("grep v1 stores bounded query identity instead of plaintext", () => {
  const pattern = "GREP_QUERY_PLAINTEXT";
  const normalized = normalizeOne(
    invocation("grep", "grep", { path: "/src", pattern, include: "*.ts" })
  ).operation;
  assert.equal(normalized.parserVersion, "2.0.0");
  assert.equal(normalized.parameters.patternBytes, Buffer.byteLength(pattern));
  assert.deepEqual(normalized.parameters.include, { present: true, value: "*.ts" });
  assert.doesNotMatch(JSON.stringify(normalized), /GREP_QUERY_PLAINTEXT/);
});

test("write stores content identity but never plaintext", () => {
  const secret = "WRITE_PLAINTEXT_SECRET";
  const first = normalizeOne(
    invocation("first", "write", { filePath: "/a", content: secret })
  ).operation;
  const same = normalizeOne(
    invocation("same", "write", { filePath: "/a", content: secret })
  ).operation;
  const different = normalizeOne(
    invocation("different", "write", { filePath: "/a", content: `${secret}!` })
  ).operation;
  assert.equal(first.parameters.contentBytes, Buffer.byteLength(secret));
  assert.match(first.parameters.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(first.inputFingerprint, same.inputFingerprint);
  assert.notEqual(first.inputFingerprint, different.inputFingerprint);
  assert.doesNotMatch(JSON.stringify([first, same, different]), new RegExp(secret));
});

test("write missing content falls back", () => {
  const normalized = normalizeOne(invocation("write", "write", { filePath: "/a" }));
  assert.equal(normalized.operation, null);
  assert.equal(normalized.result.diagnostics[0].code, "missing_or_invalid_write_content");
});

test("edit stores old/new hashes and byte lengths without plaintext", () => {
  const oldString = "EDIT_OLD_PLAINTEXT";
  const newString = "EDIT_NEW_PLAINTEXT_LONGER";
  const normalized = normalizeOne(
    invocation("edit", "edit", { filePath: "/a", oldString, newString })
  );
  assert.equal(normalized.operation.kind, "file_edit");
  assert.equal(normalized.operation.parameters.oldBytes, Buffer.byteLength(oldString));
  assert.equal(normalized.operation.parameters.newBytes, Buffer.byteLength(newString));
  assert.match(normalized.operation.parameters.oldSha256, /^[0-9a-f]{64}$/);
  assert.match(normalized.operation.parameters.newSha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(normalized.all), /EDIT_(?:OLD|NEW)_PLAINTEXT/);
});

test("invalid edit args fall back", () => {
  for (const args of [
    { oldString: "a", newString: "b" },
    { filePath: "/a", newString: "b" },
    { filePath: "/a", oldString: "a" },
  ]) {
    const normalized = normalizeOne(invocation(JSON.stringify(args), "edit", args));
    assert.equal(normalized.operation, null);
    assert.equal(normalized.result.status, "fallback");
  }
});

test("spawn-child hashes prompt and ignores output outcome", () => {
  const prompt = "SPAWN_PROMPT_PLAINTEXT";
  const success = normalizeOne(
    invocation("success", "spawn-child", { title: "  Child   A  ", prompt }, "Child spawned")
  ).operation;
  const limited = normalizeOne(
    invocation("limited", "spawn-child", { title: "Child A", prompt }, "Rate limited")
  ).operation;
  assert.equal(success.kind, "child_spawn_request");
  assert.equal(success.target, "Child A");
  assert.equal(success.parameters.promptBytes, Buffer.byteLength(prompt));
  assert.equal(success.inputFingerprint, limited.inputFingerprint);
  assert.equal(success.evidence.outcomeParsing, "not_implemented");
  assert.doesNotMatch(
    JSON.stringify([success, limited]),
    /SPAWN_PROMPT_PLAINTEXT|Rate limited|Child spawned/
  );
});

test("get-child-status distinguishes aggregate and child-specific targets", () => {
  const aggregate = normalizeOne(invocation("aggregate", "get-child-status", {})).operation;
  const child = normalizeOne(
    invocation("child", "get-child-status", {
      childId: "child-1",
      includeResponse: false,
      includeTrajectory: true,
      trajectoryLimit: 10,
    })
  ).operation;
  assert.equal(aggregate.targetType, "child_collection");
  assert.equal(aggregate.target, "all_children");
  assert.equal(child.targetType, "child_session");
  assert.equal(child.target, "child-1");
  assert.equal(child.effect, "read");
  assert.deepEqual(child.parameters.includeResponse, { present: true, value: false });
});

test("send-child-prompt hashes prompt and requires child ID", () => {
  const prompt = "SEND_PROMPT_PLAINTEXT";
  const valid = normalizeOne(
    invocation("valid", "send-child-prompt", { childId: "child-1", prompt })
  ).operation;
  assert.equal(valid.kind, "child_prompt_request");
  assert.equal(valid.parameters.promptBytes, Buffer.byteLength(prompt));
  assert.doesNotMatch(JSON.stringify(valid), /SEND_PROMPT_PLAINTEXT/);
  const invalid = normalizeOne(invocation("invalid", "send-child-prompt", { prompt }));
  assert.equal(invalid.operation, null);
  assert.equal(invalid.result.status, "fallback");
});

test("parameters participate in deterministic operation identity", () => {
  const base = invocation("same-source", "read", { filePath: "/a", offset: 1, limit: 2 });
  const first = normalizeOne(base).operation;
  const changed = normalizeOne({
    ...base,
    args: { filePath: "/a", offset: 2, limit: 2 },
  }).operation;
  assert.notEqual(first.operationId, changed.operationId);
});
