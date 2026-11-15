import { basename } from "node:path";
import { extractShellSegments } from "../normalization/shell-extractor.mjs";
import {
  parseSafeCommandStage,
  splitPipelineStages,
} from "../normalization/shell-command-parser.mjs";

export const RULESET_VERSION = "openinspect-time-categories-v1";
export const CATEGORIES = [
  "explicit_wait",
  "test_build",
  "environment",
  "search_read",
  "write_edit",
  "git",
  "coordination",
  "network",
  "context_setup",
  "script_execution",
  "output",
  "mixed",
  "unknown",
];
const TOOL_CATEGORIES = {
  read: "search_read",
  grep: "search_read",
  glob: "search_read",
  write: "write_edit",
  edit: "write_edit",
  apply_patch: "write_edit",
  "spawn-child": "coordination",
  "get-child-status": "coordination",
  "send-child-prompt": "coordination",
  todowrite: "coordination",
  webfetch: "network",
};

function commandCategory(program, args) {
  const p = basename(program);
  if (p === "sleep") return "explicit_wait";
  if (["cd", "pwd", "export", "unset"].includes(p)) return "context_setup";
  if (["echo", "printf", "true", "false"].includes(p)) return "output";
  if (["pytest", "py.test", "make", "cmake", "ninja", "tox", "ruff", "mypy"].includes(p))
    return "test_build";
  if (p === "git") return "git";
  if (["curl", "wget"].includes(p)) return "network";
  if (
    ["rg", "grep", "cat", "head", "tail", "ls", "wc", "diff", "file", "stat", "which"].includes(p)
  )
    return "search_read";
  // sed can execute commands and write files; only support the common read-only -n form.
  if (p === "sed" && args[0] === "-n" && /^\d+(?:,\d+)?p$/.test(args[1] ?? ""))
    return "search_read";
  if (["mkdir", "cp", "mv", "rm", "touch", "apply_patch", "patch"].includes(p)) return "write_edit";
  if (
    /^pip(?:\d(?:\.\d+)?)?$/.test(p) &&
    ["install", "download", "wheel", "uninstall"].includes(args[0])
  )
    return "environment";
  if (["npm", "pnpm", "yarn"].includes(p)) {
    if (["install", "ci", "add", "remove", "update"].includes(args[0])) return "environment";
    if (["test", "build", "lint", "typecheck"].includes(args[0])) return "test_build";
    if (args[0] === "run" && ["test", "build", "lint", "typecheck"].includes(args[1]))
      return "test_build";
  }
  if (p === "go" && ["test", "build", "vet"].includes(args[0])) return "test_build";
  if (p === "cargo" && ["test", "build", "check", "clippy"].includes(args[0])) return "test_build";
  if (p === "uv" && ["sync", "venv"].includes(args[0])) return "environment";
  if (p === "uv" && args[0] === "pip") return commandCategory("pip", args.slice(1));
  if (/^python(?:\d(?:\.\d+)?)?$/.test(p)) {
    if (args[0] === "-m" && ["pytest", "unittest", "compileall"].includes(args[1]))
      return "test_build";
    if (args[0] === "-m" && args[1] === "pip") return commandCategory("pip", args.slice(2));
    return "script_execution";
  }
  if (["node", "ruby", "perl", "bash", "sh"].includes(p)) return "script_execution";
  return "unknown";
}

function segmentCategory(segment) {
  // The shared tokenizer omits empty words; fail closed instead of shifting positional arguments.
  if (/(?:^|\s)(?:''|"")(?:\s|$)/.test(segment.segment))
    return { category: "unknown", reason: "empty_quoted_word" };
  if (segment.separatorBefore === "||")
    return { category: "mixed", reason: "conditional_fallback" };
  // Only explicitly supported output truncation may accompany a classified producer.
  // The category still describes the entire pipeline, including truncation/SIGPIPE effects.
  if (segment.pipelinePreserved) {
    const pipeline = splitPipelineStages(segment.segment);
    if (!pipeline.ok || !pipeline.stages.slice(1).every(isOutputTruncation)) {
      return { category: "mixed", reason: "pipeline" };
    }
    const producer = segmentCategory({ segment: pipeline.stages[0] });
    return { category: producer.category, reason: `${producer.reason}:output_truncation` };
  }
  const parsed = parseSafeCommandStage(segment.segment);
  if (!parsed.ok) return { category: "unknown", reason: parsed.diagnostics[0].code };
  let tokens = [parsed.program, ...parsed.args];
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) tokens = tokens.slice(1);
  if (tokens.length === 0) return { category: "context_setup", reason: "assignment" };
  // parseSafeCommandStage unwraps an unprefixed timeout. Support it after assignments too.
  if (tokens[0] === "timeout") {
    if (!/^\d+(?:\.\d+)?[smhd]?$/.test(tokens[1] ?? "") || tokens.length < 3) {
      return { category: "unknown", reason: "timeout_options" };
    }
    tokens = tokens.slice(2);
  }
  const category = commandCategory(tokens[0], tokens.slice(1));
  return { category, reason: `command:${basename(tokens[0])}` };
}

function isOutputTruncation(stage) {
  if (/[<>]/.test(stage)) return false;
  const parsed = parseSafeCommandStage(stage);
  if (!parsed.ok || parsed.wrapper || !["head", "tail"].includes(parsed.program)) return false;
  const args = parsed.args;
  return (
    args.length === 0 ||
    (args.length === 1 && /^-\d+$/.test(args[0])) ||
    (args.length === 2 && ["-n", "-c"].includes(args[0]) && /^\d+$/.test(args[1]))
  );
}

export function classifyInvocation(tool, args = {}) {
  if (tool !== "bash") {
    const category = TOOL_CATEGORIES[tool] ?? "unknown";
    return { category, tags: [], ruleId: `tool:${tool}`, reasons: [], segmentCount: null };
  }
  const extracted = extractShellSegments(args.command);
  if (!extracted.ok) {
    return {
      category: "unknown",
      tags: [],
      ruleId: "shell:unsupported",
      reasons: extracted.diagnostics.map((d) => d.code),
      segmentCount: null,
    };
  }
  const classified = extracted.segments.map(segmentCategory);
  const tags = [...new Set(classified.map((s) => s.category))].sort();
  const substantive = tags.filter((tag) => !["context_setup", "output"].includes(tag));
  let category;
  if (substantive.length === 0)
    category = tags.includes("context_setup") ? "context_setup" : "output";
  else if (substantive.length === 1) category = substantive[0];
  else category = "mixed";
  return {
    category,
    tags,
    ruleId: `shell:${extracted.segments.length > 1 ? "compound" : "single"}:${category}`,
    reasons: [...new Set(classified.map((s) => s.reason))].sort(),
    segmentCount: extracted.segments.length,
  };
}
