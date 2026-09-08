import { test } from "node:test";
import assert from "node:assert/strict";
import { assertToolEvidence, discoverSessionTree, CHILD_COMMAND } from "./experiment-checks.mjs";

const call = (tool, args, callId = "c1") => ({
  type: "tool_call",
  data: { tool, args, callId, messageId: "m1" },
});
const result = (text, callId = "c1") => ({
  type: "tool_result",
  data: { result: text, callId, messageId: "m1" },
});

test("discovers grandchildren as well as direct children", async () => {
  const tree = { root: [{ id: "child" }], child: [{ id: "grandchild" }], grandchild: [] };
  assert.deepEqual(
    [...(await discoverSessionTree("root", async (id) => tree[id]))],
    [
      ["root", null],
      ["child", "root"],
      ["grandchild", "child"],
    ]
  );
});
test("requires the exact command and its own successful result", () => {
  const options = { command: CHILD_COMMAND, marker: "CHILD_OK" };
  assert.doesNotThrow(() =>
    assertToolEvidence([call("bash", { command: CHILD_COMMAND }), result("CHILD_OK")], options)
  );
  assert.throws(() =>
    assertToolEvidence([call("bash", { command: "echo CHILD_OK" }), result("CHILD_OK")], options)
  );
  assert.throws(() =>
    assertToolEvidence(
      [call("bash", { command: CHILD_COMMAND }), result("CHILD_OK", "different-call")],
      options
    )
  );
  assert.throws(() =>
    assertToolEvidence(
      [
        call("bash", { command: CHILD_COMMAND }),
        { ...result("CHILD_OK"), data: { ...result("CHILD_OK").data, error: "failed" } },
      ],
      options
    )
  );
});
test("accepts persisted completed tool output but rejects running and failed output", () => {
  const event = call("bash", { command: CHILD_COMMAND });
  const options = { command: CHILD_COMMAND, marker: "CHILD_OK" };
  event.data.output = "CHILD_OK\n";
  for (const status of ["running", "error", "failed"]) {
    event.data.status = status;
    assert.throws(() => assertToolEvidence([event], options));
  }
  event.data.status = "completed";
  assert.doesNotThrow(() => assertToolEvidence([event], options));
  event.data.error = "failed";
  assert.throws(() => assertToolEvidence([event], options));
});
test("parent must retrieve every child's final response, not a marker in a tool summary", () => {
  const response = (id) =>
    `Child: ${id}\n  Final response:\n    Success: yes\n    Text:\n      CHILD_OK`;
  const events = [
    call("get-child-status", { childId: "a", includeResponse: true }),
    result(response("a")),
  ];
  const options = { childIds: ["a", "b"], marker: "CHILD_OK" };
  assert.throws(() => assertToolEvidence(events, options));
  events.push(
    call("get-child-status", { childId: "b", includeResponse: true }, "c2"),
    result(response("b"), "c2")
  );
  assert.doesNotThrow(() => assertToolEvidence(events, options));
  events[3] = result(
    "Child: b\n Final response:\n Success: yes\n Text:\n (empty)\n Tool summary:\n CHILD_OK",
    "c2"
  );
  assert.throws(() => assertToolEvidence(events, options));
});
