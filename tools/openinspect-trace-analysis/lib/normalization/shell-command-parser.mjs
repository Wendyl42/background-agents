const MAX_STAGE_LENGTH = 4_096;
const MAX_TOKEN_COUNT = 256;
const MAX_TOKEN_LENGTH = 4_096;
const QUOTED_LESS_THAN = "\uE000";
const QUOTED_GREATER_THAN = "\uE001";

function failure(code, details = {}) {
  return { ok: false, diagnostics: [{ code, ...details }] };
}

export function splitPipelineStages(segment) {
  if (typeof segment !== "string" || segment.trim() === "") {
    return failure("missing_shell_segment");
  }
  if (segment.length > MAX_STAGE_LENGTH) return failure("shell_segment_too_large");

  const stages = [];
  let buffer = "";
  let quote = null;
  let escaped = false;
  const push = (offset) => {
    const stage = buffer.trim();
    if (stage === "") return failure("empty_pipeline_stage", { offset });
    stages.push(stage);
    buffer = "";
    return null;
  };

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (escaped) {
      buffer += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      buffer += char;
      escaped = true;
      continue;
    }
    if (quote === "single") {
      buffer += char;
      if (char === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      buffer += char;
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'") {
      quote = "single";
      buffer += char;
      continue;
    }
    if (char === '"') {
      quote = "double";
      buffer += char;
      continue;
    }
    if (char === "|") {
      const failed = push(index);
      if (failed) return failed;
      continue;
    }
    buffer += char;
  }

  if (escaped) return failure("dangling_escape");
  if (quote !== null) return failure("unterminated_quote");
  const failed = push(segment.length);
  if (failed) return failed;
  return { ok: true, stages };
}

function restoreQuotedMetacharacters(value) {
  return value.replaceAll(QUOTED_LESS_THAN, "<").replaceAll(QUOTED_GREATER_THAN, ">");
}

function tokenizeShellStageInternal(stage) {
  if (typeof stage !== "string" || stage.trim() === "") return failure("missing_command_stage");
  if (stage.length > MAX_STAGE_LENGTH) return failure("command_stage_too_large");
  if (stage.includes(QUOTED_LESS_THAN) || stage.includes(QUOTED_GREATER_THAN)) {
    return failure("reserved_shell_token_character");
  }

  const tokens = [];
  let buffer = "";
  let quote = null;
  let escaped = false;
  let dynamic = false;
  let comment = false;
  const push = () => {
    if (buffer === "") return;
    if (buffer.length > MAX_TOKEN_LENGTH) throw new Error("shell_token_too_large");
    tokens.push(buffer);
    buffer = "";
  };

  try {
    for (let index = 0; index < stage.length; index += 1) {
      const char = stage[index];
      if (escaped) {
        buffer += char;
        escaped = false;
        continue;
      }
      if (char === "\\" && quote !== "single") {
        escaped = true;
        continue;
      }
      if (quote === "single") {
        if (char === "'") quote = null;
        else if (char === "<") buffer += QUOTED_LESS_THAN;
        else if (char === ">") buffer += QUOTED_GREATER_THAN;
        else buffer += char;
        continue;
      }
      if (quote === "double") {
        if (char === '"') quote = null;
        else {
          if (char === "$" || char === "`") dynamic = true;
          if (char === "<") buffer += QUOTED_LESS_THAN;
          else if (char === ">") buffer += QUOTED_GREATER_THAN;
          else buffer += char;
        }
        continue;
      }
      if (/\s/.test(char)) {
        push();
        continue;
      }
      if (char === "'") {
        quote = "single";
        continue;
      }
      if (char === '"') {
        quote = "double";
        continue;
      }
      if (char === "$" || char === "`") dynamic = true;
      if (char === "#" && buffer === "") comment = true;
      buffer += char;
    }
    push();
  } catch (error) {
    return failure(error instanceof Error ? error.message : "shell_tokenization_error");
  }

  if (escaped) return failure("dangling_escape");
  if (quote !== null) return failure("unterminated_quote");
  if (tokens.length === 0) return failure("empty_command_stage");
  if (tokens.length > MAX_TOKEN_COUNT) return failure("too_many_shell_tokens");
  if (comment) return failure("shell_comment_ambiguous");
  if (dynamic) return failure("dynamic_shell_expansion");
  return { ok: true, tokens };
}

export function tokenizeShellStage(stage) {
  const tokenized = tokenizeShellStageInternal(stage);
  if (!tokenized.ok) return tokenized;
  return { ok: true, tokens: tokenized.tokens.map(restoreQuotedMetacharacters) };
}

function splitRedirectionToken(token) {
  const match = /^(\d*)(>>?|<)(.*)$/.exec(token);
  if (!match) return null;
  return { attachedTarget: match[3] !== "", target: match[3] };
}

export function stripShellRedirections(tokens) {
  const commandTokens = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const redirection = splitRedirectionToken(token);
    if (redirection) {
      if (!redirection.attachedTarget) {
        const target = tokens[index + 1];
        if (!target || /[<>]/.test(target)) return failure("missing_redirection_target");
        index += 1;
      }
      continue;
    }
    if (/[<>]/.test(token) || token.startsWith("&>")) {
      return failure("unsupported_redirection_form", { tokenIndex: index });
    }
    commandTokens.push(restoreQuotedMetacharacters(token));
  }
  if (commandTokens.length === 0) return failure("empty_command_after_redirection");
  return { ok: true, tokens: commandTokens };
}

function unwrapTimeout(tokens) {
  if (tokens[0] !== "timeout") return { ok: true, tokens, wrapper: null };
  if (tokens.length < 3 || !/^\d+(?:\.\d+)?(?:[smhd])?$/.test(tokens[1])) {
    return failure("ambiguous_timeout_wrapper");
  }
  return {
    ok: true,
    tokens: tokens.slice(2),
    wrapper: { kind: "timeout", duration: tokens[1] },
  };
}

export function parseSafeCommandStage(stage) {
  const tokenized = tokenizeShellStageInternal(stage);
  if (!tokenized.ok) return tokenized;
  const withoutRedirections = stripShellRedirections(tokenized.tokens);
  if (!withoutRedirections.ok) return withoutRedirections;
  const unwrapped = unwrapTimeout(withoutRedirections.tokens);
  if (!unwrapped.ok) return unwrapped;
  const [program, ...args] = unwrapped.tokens;
  if (!program) return failure("missing_command_program");
  if (/[?*[]/.test(program)) return failure("ambiguous_command_program");
  return {
    ok: true,
    program,
    args,
    wrapper: unwrapped.wrapper,
  };
}
