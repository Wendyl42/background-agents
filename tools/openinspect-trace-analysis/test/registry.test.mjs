import assert from "node:assert/strict";
import test from "node:test";
import { RuleRegistry } from "../lib/normalization/registry.mjs";

function rule(id, version, priority) {
  return {
    id,
    version,
    priority,
    supportedTools: ["test"],
    match: () => true,
    normalize: () => ({ status: "fallback", operations: [], diagnostics: [] }),
  };
}

test("registry rejects duplicate IDs even with different versions", () => {
  assert.throws(
    () =>
      new RuleRegistry({
        rulesetVersion: "test-v1",
        rules: [rule("same", "1", 10), rule("same", "2", 20)],
      }),
    /Duplicate rule ID/
  );
});

test("registry order is deterministic by priority, ID, and version", () => {
  const registry = new RuleRegistry({
    rulesetVersion: "test-v1",
    rules: [rule("z", "1", 20), rule("b", "1", 10), rule("a", "1", 10)],
  });
  assert.deepEqual(
    registry.inventory().map((entry) => entry.id),
    ["a", "b", "z"]
  );
});

test("registry fails closed when same-priority rules both match", () => {
  const registry = new RuleRegistry({
    rulesetVersion: "test-v1",
    rules: [rule("a", "1", 10), rule("b", "1", 10)],
  });
  assert.throws(
    () => registry.select({ invocationId: "invocation", tool: "test" }),
    /Rule conflict/
  );
});
