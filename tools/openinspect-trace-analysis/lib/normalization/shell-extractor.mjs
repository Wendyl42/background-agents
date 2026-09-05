const MAX_SEGMENT_LENGTH = 4_096;

function fallback(code, offset = null) {
  return { ok: false, diagnostics: [{ code, ...(offset === null ? {} : { offset }) }] };
}

export function extractShellSegments(command) {
  if (typeof command !== "string" || command.trim() === "") return fallback("missing_command");

  const segments = [];
  let buffer = "";
  let quote = null;
  let escaped = false;
  let separatorBefore = null;
  let segmentHasPipeline = false;

  const push = (separator, offset) => {
    const value = buffer.trim();
    if (value === "") return fallback("empty_shell_segment", offset);
    if (value.length > MAX_SEGMENT_LENGTH) return fallback("shell_segment_too_large", offset);
    segments.push({ segment: value, separatorBefore, pipelinePreserved: segmentHasPipeline });
    buffer = "";
    separatorBefore = separator;
    segmentHasPipeline = false;
    return null;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

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
      else if (char === "$" && next === "(") return fallback("command_substitution", index);
      else if (char === "`") return fallback("backtick_substitution", index);
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
    if (char === "$" && next === "(") return fallback("command_substitution", index);
    if (char === "`") return fallback("backtick_substitution", index);
    if (char === "<" && next === "<") return fallback("heredoc", index);
    if (char === "(" || char === ")") return fallback("subshell_or_grouping", index);
    if (char === "{" || char === "}") return fallback("complex_grouping", index);
    if (char === "&" && next !== "&" && command[index - 1] !== ">" && next !== ">") {
      return fallback("background_or_redirection", index);
    }
    if (char === ";" && next === ";") return fallback("case_separator", index);

    let separator = null;
    let width = 1;
    if (char === ";") separator = ";";
    else if (char === "\n") separator = "newline";
    else if (char === "&" && next === "&") {
      separator = "&&";
      width = 2;
    } else if (char === "|" && next === "|") {
      separator = "||";
      width = 2;
    }

    if (separator) {
      const failed = push(separator, index);
      if (failed) return failed;
      index += width - 1;
      continue;
    }
    if (char === "|" && next !== "|") segmentHasPipeline = true;
    buffer += char;
  }

  if (escaped) return fallback("dangling_escape", command.length - 1);
  if (quote !== null) return fallback("unterminated_quote", command.length - 1);
  const failed = push(null, command.length);
  if (failed) return failed;
  const controlStructure = segments.find((item) =>
    /^(?:for|while|until|if|case|select|function|then|do)\b/.test(item.segment)
  );
  if (controlStructure) return fallback("shell_control_structure");
  return {
    ok: true,
    segments,
    diagnostics: segments.some((item) => item.pipelinePreserved)
      ? [{ code: "pipeline_preserved" }]
      : [],
  };
}
