import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInvocations } from "../lib/normalization/engine.mjs";
import { RuleRegistry } from "../lib/normalization/registry.mjs";
import { createBlockCRuleRegistry } from "../lib/normalization/ruleset.mjs";

function invocation(id, tool, args, sessionId = "session") {
  return {
    invocationId: `${sessionId}:${id}`,
    sourceEventId: id,
    sessionId,
    messageId: "message",
    callId: id,
    tool,
    args,
    output: tool === "write" ? "Wrote file successfully." : null,
    status: "completed",
    startedAtMs: 1,
    finishedAtMs: 2,
    rawFinishedAtMs: 2,
    timingQuality: "sandbox_final_timestamp",
    timingRepair: null,
    operations: [],
  };
}

test("filesystem tools emit specific target-aware operations", () => {
  const invocations = [
    invocation("read", "read", { filePath: "/workspace/./src/a.ts" }),
    invocation("glob", "glob", { pattern: "src/**/*.ts" }),
    invocation("grep", "grep", { path: "/workspace/src", pattern: "TODO" }),
    invocation("write", "write", { filePath: "/workspace/out.md", content: "DO_NOT_COPY" }),
  ];
  const normalized = normalizeInvocations(invocations, createBlockCRuleRegistry());
  assert.deepEqual(
    normalized.operations.map((operation) => operation.kind),
    ["file_read", "file_glob", "content_search", "file_write"]
  );
  assert.ok(normalized.results.every((result) => result.status === "specific"));
  assert.equal(normalized.operations[0].target, "/workspace/src/a.ts");
  assert.doesNotMatch(JSON.stringify(normalized.operations), /DO_NOT_COPY/);
  assert.doesNotMatch(JSON.stringify(normalized.results), /DO_NOT_COPY/);
});

test("missing or invalid filesystem targets fall back", () => {
  const invocations = [
    invocation("read", "read", {}),
    invocation("glob", "glob", { pattern: "" }),
    invocation("grep", "grep", { pattern: "TODO" }),
    invocation("write", "write", { content: "secret" }),
  ];
  const normalized = normalizeInvocations(invocations, createBlockCRuleRegistry());
  assert.equal(normalized.operations.length, 0);
  assert.ok(normalized.results.every((result) => result.status === "fallback"));
});

test("one bash invocation may emit multiple syntactic operations with stable unique IDs", () => {
  const source = [invocation("bash", "bash", { command: "echo a; echo b && echo c" })];
  const first = normalizeInvocations(source, createBlockCRuleRegistry());
  const second = normalizeInvocations(source, createBlockCRuleRegistry());
  assert.equal(first.operations.length, 3);
  assert.equal(new Set(first.operations.map((operation) => operation.operationId)).size, 3);
  assert.deepEqual(
    first.operations.map((operation) => operation.operationId),
    second.operations.map((operation) => operation.operationId)
  );
  assert.ok(first.operations.every((operation) => operation.normalizationLevel === "syntactic"));
  assert.ok(
    first.operations.every(
      (operation) =>
        operation.sourceInvocationIds.length === 1 &&
        operation.sourceInvocationIds[0] === "session:bash"
    )
  );
});

test("normalization does not mutate invocation or raw args", () => {
  const source = [invocation("write", "write", { filePath: "/workspace/a", content: "content" })];
  const before = structuredClone(source);
  normalizeInvocations(source, createBlockCRuleRegistry());
  assert.deepEqual(source, before);
});

test("unknown tools remain evidence-linked fallback invocations", () => {
  const normalized = normalizeInvocations(
    [invocation("unknown", "todowrite", { todos: [{ content: "x" }] })],
    createBlockCRuleRegistry()
  );
  assert.equal(normalized.operations.length, 0);
  assert.equal(normalized.results[0].status, "fallback");
  assert.equal(normalized.results[0].matchedParser, null);
  assert.deepEqual(normalized.results[0].diagnostics, [{ code: "unknown_tool" }]);
  assert.equal(normalized.fallbackInvocations[0].invocationId, "session:unknown");
});

test("coverage keeps specific, syntactic, and fallback numerators distinct", () => {
  const normalized = normalizeInvocations(
    [
      invocation("read", "read", { filePath: "/workspace/a" }, "s1"),
      invocation("bash", "bash", { command: "echo ok" }, "s1"),
      invocation("grep", "grep", { pattern: "missing path" }, "s2"),
      invocation("unknown", "edit", {}, "s2"),
    ],
    createBlockCRuleRegistry()
  );
  const totals = normalized.coverage.totals;
  assert.deepEqual(totals.counts, {
    total: 4,
    specific: 1,
    syntactic: 1,
    fallback: 2,
    error: 0,
  });
  assert.deepEqual(totals.specificCoverage, { numerator: 1, denominator: 4, value: 0.25 });
  assert.deepEqual(totals.syntacticCoverage, { numerator: 1, denominator: 4, value: 0.25 });
  const bash = normalized.coverage.byTool.find((entry) => entry.key === "bash");
  assert.equal(bash.counts.specific, 0);
  assert.equal(bash.counts.syntactic, 1);
  assert.equal(normalized.coverage.bySession.length, 2);
});

test("identical inputs and ruleset produce byte-identical normalization", () => {
  const source = [
    invocation("read", "read", { filePath: "/workspace/a" }),
    invocation("bash", "bash", { command: 'echo "a;b"; echo c' }),
  ];
  const first = normalizeInvocations(source, createBlockCRuleRegistry());
  const second = normalizeInvocations(source, createBlockCRuleRegistry());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("normalization fails closed when a matched parser throws", () => {
  const registry = new RuleRegistry({
    rulesetVersion: "throwing-ruleset",
    rules: [
      {
        id: "throwing.rule",
        version: "1.0.0",
        priority: 1,
        supportedTools: ["read"],
        match: () => true,
        normalize: () => {
          throw new Error("intentional parser failure");
        },
      },
    ],
  });
  assert.throws(
    () => normalizeInvocations([invocation("read", "read", { filePath: "/a" })], registry),
    /intentional parser failure/
  );
});
