import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInvocations } from "../lib/normalization/engine.mjs";
import { parsePackageManagerCommand } from "../lib/normalization/package-command-parser.mjs";
import {
  parseSafeCommandStage,
  splitPipelineStages,
  tokenizeShellStage,
} from "../lib/normalization/shell-command-parser.mjs";
import { createBlockCV2RuleRegistry } from "../lib/normalization/ruleset.mjs";
import { createPackageManagerSemanticRegistry } from "../lib/normalization/rules/package-manager-v2.mjs";

function invocation(id, command, output = null, workdir = undefined) {
  return {
    invocationId: `session:${id}`,
    sourceEventId: id,
    sessionId: "session",
    messageId: "message",
    callId: id,
    tool: "bash",
    args: { command, ...(workdir ? { workdir } : {}) },
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

function normalize(command, options = {}) {
  return normalizeInvocations(
    [invocation(options.id ?? "bash", command, options.output, options.workdir)],
    createBlockCV2RuleRegistry()
  );
}

function semanticOperations(normalized) {
  return normalized.operations.filter((operation) => operation.normalizationLevel === "specific");
}

test("semantic rule inventory is versioned, unique, and deterministic", () => {
  const first = createPackageManagerSemanticRegistry().inventory();
  const second = createPackageManagerSemanticRegistry().inventory();
  assert.deepEqual(first, second);
  assert.equal(first.length, 12);
  assert.equal(new Set(first.map((rule) => rule.id)).size, first.length);
  assert.ok(first.every((rule) => rule.version === "1.0.0"));
});

test("pipeline splitter and tokenizer are quote-aware", () => {
  const pipeline = splitPipelineStages('pnpm exec tool "a|b" | tail -3');
  assert.equal(pipeline.ok, true);
  assert.deepEqual(pipeline.stages, ['pnpm exec tool "a|b"', "tail -3"]);
  const tokens = tokenizeShellStage('npm view "@scope/pkg" version');
  assert.deepEqual(tokens, { ok: true, tokens: ["npm", "view", "@scope/pkg", "version"] });
});

test("redirections are removed without executing or changing command arguments", () => {
  const parsed = parseSafeCommandStage("pnpm audit --json 2>/tmp/audit.err > /tmp/audit.json");
  assert.deepEqual(parsed, {
    ok: true,
    program: "pnpm",
    args: ["audit", "--json"],
    wrapper: null,
  });
  assert.deepEqual(parseSafeCommandStage('grep -n "cli>" report.txt'), {
    ok: true,
    program: "grep",
    args: ["-n", "cli>", "report.txt"],
    wrapper: null,
  });
});

test("dynamic and ambiguous shell stages stay unparsed", () => {
  assert.equal(parseSafeCommandStage('npm view "$pkg" version').ok, false);
  assert.equal(parseSafeCommandStage("timeout --signal KILL 10 pnpm install").ok, false);
});

test("package command grammar covers deterministic pnpm and npm forms", () => {
  const cases = [
    ["pnpm install --frozen-lockfile --prefer-offline", "install"],
    ["npm install -g yarn", "install"],
    ["pnpm --filter api audit --audit-level moderate", "audit"],
    ["npm audit --json", "audit"],
    ["pnpm --filter api outdated", "outdated"],
    ["npm outdated axios --json", "outdated"],
    ["pnpm licenses list --filter api --json", "licenses"],
    ["pnpm --filter api build", "script"],
    ["pnpm run lint -- --fix", "script"],
    ["npm run test -- --watch=false", "script"],
    ["pnpm --filter api exec tsc --noEmit", "exec"],
    ["npm exec -- eslint src", "exec"],
    ["npm view axios@1.2.3 version deprecated --json", "view"],
    ["timeout 100 pnpm install --frozen-lockfile", "install"],
  ];
  for (const [command, form] of cases) {
    const stage = parseSafeCommandStage(command);
    assert.equal(stage.ok, true, command);
    const parsed = parsePackageManagerCommand(stage);
    assert.equal(parsed.ok, true, command);
    assert.equal(parsed.descriptor.form, form, command);
  }
});

test("unknown package-manager builtins and git/npx/yarn remain syntactic", () => {
  for (const command of [
    "pnpm list --depth 0",
    "pnpm store path",
    "npm config get registry",
    "git status",
    "npx eslint .",
    "yarn install",
  ]) {
    const normalized = normalize(command, { id: command });
    assert.equal(normalized.results[0].status, "syntactic", command);
    assert.equal(semanticOperations(normalized).length, 0, command);
  }
});

test("mixed invocation coverage preserves semantic and syntactic segments", () => {
  const normalized = normalize("pnpm install --frozen-lockfile && echo done");
  assert.equal(normalized.results[0].status, "mixed");
  assert.deepEqual(
    normalized.segments.map((segment) => segment.normalizationStatus),
    ["specific", "syntactic"]
  );
  assert.deepEqual(
    normalized.operations.map((operation) => operation.kind),
    ["package_install_request", "shell_segment"]
  );
  assert.deepEqual(normalized.coverage.layers.invocation.totals.counts, {
    total: 1,
    specific: 0,
    mixed: 1,
    syntactic: 0,
    fallback: 0,
    error: 0,
  });
  assert.equal(normalized.coverage.layers.segment.counts.total, 2);
  assert.equal(normalized.coverage.layers.operation.counts.semanticCommand, 1);
});

test("a fully semantic multi-segment invocation is specific", () => {
  const normalized = normalize("pnpm audit; npm view axios version");
  assert.equal(normalized.results[0].status, "specific");
  assert.ok(normalized.segments.every((segment) => segment.normalizationStatus === "specific"));
  assert.deepEqual(
    semanticOperations(normalized).map((operation) => operation.kind),
    ["package_audit_request", "package_metadata_view_request"]
  );
});

test("only the first safe pipeline stage is semantically parsed", () => {
  const firstSemantic = normalize("pnpm audit --json | python3 report.py");
  assert.equal(firstSemantic.results[0].status, "mixed");
  assert.equal(firstSemantic.segments[0].normalizationStatus, "mixed");
  assert.equal(semanticOperations(firstSemantic)[0].kind, "package_audit_request");
  assert.equal(firstSemantic.segments[0].pipeline.tailStageCount, 1);

  const laterSemantic = normalize("cat package.json | npm view axios version");
  assert.equal(laterSemantic.results[0].status, "syntactic");
  assert.equal(semanticOperations(laterSemantic).length, 0);
});

test("semantic operations link to invocation and shell segment", () => {
  const normalized = normalize("pnpm --filter api exec tsc --noEmit", {
    workdir: "/workspace/repo",
  });
  const operation = semanticOperations(normalized)[0];
  const segment = normalized.segments[0];
  assert.deepEqual(operation.sourceInvocationIds, ["session:bash"]);
  assert.deepEqual(operation.sourceShellSegmentIds, [segment.shellSegmentId]);
  assert.deepEqual(segment.emittedOperationIds, [operation.operationId]);
  assert.equal(operation.parameters.workingDirectory.value, "/workspace/repo");
});

test("preceding cd and timeout wrapper are retained as request parameters", () => {
  const normalized = normalize("cd /workspace/repo && timeout 100 pnpm install --frozen-lockfile");
  const operation = semanticOperations(normalized)[0];
  assert.equal(operation.target, "/workspace/repo");
  assert.equal(operation.parameters.workingDirectory.source, "preceding_cd_and");
  assert.deepEqual(operation.parameters.wrapper, { kind: "timeout", duration: "100" });
});

test("command output never changes request identity or claims an outcome", () => {
  const success = normalize("npm install -g yarn", { id: "same", output: "installed" });
  const failure = normalize("npm install -g yarn", { id: "same", output: "failed" });
  const left = semanticOperations(success)[0];
  const right = semanticOperations(failure)[0];
  assert.equal(left.operationId, right.operationId);
  assert.equal(left.inputFingerprint, right.inputFingerprint);
  assert.equal(left.evidence.outcomeParsing, "not_implemented");
  assert.doesNotMatch(JSON.stringify([left, right]), /installed|failed/);
});

test("operation and segment identities are deterministic and sensitive to request parameters", () => {
  const first = normalize("pnpm --filter api audit", { id: "same" });
  const repeated = normalize("pnpm --filter api audit", { id: "same" });
  const changed = normalize("pnpm --filter cli audit", { id: "same" });
  assert.equal(first.segments[0].shellSegmentId, repeated.segments[0].shellSegmentId);
  assert.equal(first.operations[0].operationId, repeated.operations[0].operationId);
  assert.notEqual(first.operations[0].operationId, changed.operations[0].operationId);
  assert.notEqual(first.operations[0].inputFingerprint, changed.operations[0].inputFingerprint);
});

test("unsafe top-level shell remains fallback rather than guessed", () => {
  const normalized = normalize("pnpm audit <<EOF\ninput\nEOF");
  assert.equal(normalized.results[0].status, "fallback");
  assert.equal(normalized.segments.length, 0);
  assert.equal(normalized.operations.length, 0);
});
