import assert from "node:assert/strict";
import test from "node:test";
import { extractShellSegments } from "../lib/normalization/shell-extractor.mjs";

test("shell extractor splits safe top-level separators", () => {
  const result = extractShellSegments("echo a; echo b && echo c || echo d\necho e");
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.segments.map((item) => item.segment),
    ["echo a", "echo b", "echo c", "echo d", "echo e"]
  );
});

test("quoted separators are not split", () => {
  const result = extractShellSegments('echo "a;b && c"; echo done');
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.segments.map((item) => item.segment),
    ['echo "a;b && c"', "echo done"]
  );
});

test("escaped separators are not split and redirection ampersands remain valid", () => {
  const result = extractShellSegments("echo a\\;b 2>&1; echo done");
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.segments.map((item) => item.segment),
    ["echo a\\;b 2>&1", "echo done"]
  );
});

test("pipeline stays one syntactic segment", () => {
  const result = extractShellSegments("cat file | grep value | tail -1");
  assert.equal(result.ok, true);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].segment, "cat file | grep value | tail -1");
  assert.deepEqual(result.diagnostics, [{ code: "pipeline_preserved" }]);
});

test("quoted pipe is not reported as a pipeline", () => {
  const result = extractShellSegments('echo "a|b"');
  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.segments[0].pipelinePreserved, false);
});

test("unsafe shell constructs fall back without guessing", () => {
  const cases = [
    ["cat <<'EOF'\nhello\nEOF", "heredoc"],
    ["echo $(date)", "command_substitution"],
    ["(echo grouped)", "subshell_or_grouping"],
    ["for x in a b; do echo $x; done", "shell_control_structure"],
  ];
  for (const [command, code] of cases) {
    const result = extractShellSegments(command);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, code);
  }
});
