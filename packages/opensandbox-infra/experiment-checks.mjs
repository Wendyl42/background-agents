import assert from "node:assert/strict";

export const CHILD_COMMAND = `python3 -c 'import time; time.sleep(20); print("CHILD_OK")'`;
export const SINGLE_COMMAND = `python3 -c 'print("SINGLE_OK")'`;

export async function discoverSessionTree(rootId, listChildren) {
  const parents = new Map([[rootId, null]]);
  for (const id of parents.keys()) {
    for (const child of await listChildren(id)) {
      assert(!parents.has(child.id), "Repeated session in child tree");
      parents.set(child.id, id);
    }
  }
  return parents;
}

export function assertToolEvidence(events, { childIds, command, marker }) {
  const calls = events.filter((event) => event.type === "tool_call").map((event) => event.data);
  const results = events.filter((event) => event.type === "tool_result").map((event) => event.data);
  const output = (call) => {
    // The current runtime persists completed output on the tool_call itself.
    if (call.status === "completed" && !call.error && typeof call.output === "string")
      return call.output;
    return results.find(
      (result) =>
        result.callId === call.callId &&
        result.messageId === call.messageId &&
        !result.error &&
        typeof result.result === "string"
    )?.result;
  };
  assert(
    !calls.some((call) => call.tool?.toLowerCase() === "task"),
    "Unexpected in-process Task delegation"
  );
  if (command) {
    const commands = calls.filter(
      (call) => call.tool === "bash" && call.args?.command === command && !call.isSubtask
    );
    assert.equal(commands.length, 1, "Expected the exact experiment command once");
    assert(output(commands[0])?.includes(marker), "Missing matching successful command result");
  }
  for (const id of childIds ?? []) {
    assert(
      calls.some((call) => {
        if (
          call.tool !== "get-child-status" ||
          call.args?.childId !== id ||
          call.args.includeResponse !== true
        )
          return false;
        const text = output(call) ?? "";
        const finalText = text.match(
          /Final response:\s*Success: yes\s*Text:\s*([\s\S]*?)(?:\n\s*Tool summary:|\n\s*Recent events:|$)/
        )?.[1];
        return text.includes(`Child: ${id}`) && finalText?.includes(marker);
      }),
      `Parent did not retrieve the successful final response of ${id}`
    );
  }
}
