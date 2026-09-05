const PNPM_SCRIPT_SHORTHANDS = new Set(["build", "test"]);
const NPM_SCRIPT_SHORTHANDS = new Set(["start", "test"]);

function failure(code, details = {}) {
  return { ok: false, diagnostics: [{ code, ...details }] };
}

function present(value) {
  return { present: value !== undefined, ...(value === undefined ? {} : { value }) };
}

function consumeValue(tokens, index, option) {
  const value = tokens[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    return failure("missing_package_manager_option_value", { option });
  }
  return { ok: true, value, nextIndex: index + 1 };
}

function parseOptions(tokens, specification, { allowPositionals = true } = {}) {
  const values = {};
  const positionals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    const equalsIndex = token.startsWith("--") ? token.indexOf("=") : -1;
    const optionToken = equalsIndex > 0 ? token.slice(0, equalsIndex) : token;
    const spec = specification[optionToken];
    if (spec) {
      const key = spec.key;
      if (spec.type === "boolean") {
        if (equalsIndex > 0) return failure("boolean_option_with_value", { option: optionToken });
        values[key] = true;
      } else {
        const consumed =
          equalsIndex > 0
            ? { ok: true, value: token.slice(equalsIndex + 1), nextIndex: index }
            : consumeValue(tokens, index, optionToken);
        if (!consumed.ok) return consumed;
        if (consumed.value === "") {
          return failure("missing_package_manager_option_value", { option: optionToken });
        }
        if (spec.repeat) {
          values[key] = [...(values[key] ?? []), consumed.value];
        } else if (values[key] !== undefined) {
          return failure("duplicate_package_manager_option", { option: optionToken });
        } else {
          values[key] = consumed.value;
        }
        index = consumed.nextIndex;
      }
      continue;
    }
    if (token.startsWith("-")) {
      return failure("unsupported_package_manager_option", { option: token });
    }
    if (!allowPositionals) return failure("unexpected_package_manager_argument");
    positionals.push(token);
  }
  return { ok: true, values, positionals };
}

const FILTER_OPTIONS = {
  "--filter": { key: "filters", type: "value", repeat: true },
  "-F": { key: "filters", type: "value", repeat: true },
};

function consumePnpmPrefix(tokens) {
  const filters = [];
  let workspaceRoot = false;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--filter" || token === "-F") {
      const consumed = consumeValue(tokens, index, token);
      if (!consumed.ok) return consumed;
      filters.push(consumed.value);
      index = consumed.nextIndex + 1;
      continue;
    }
    if (token.startsWith("--filter=")) {
      const value = token.slice("--filter=".length);
      if (!value) return failure("missing_package_manager_option_value", { option: "--filter" });
      filters.push(value);
      index += 1;
      continue;
    }
    if (token === "--workspace-root" || token === "-w") {
      workspaceRoot = true;
      index += 1;
      continue;
    }
    break;
  }
  if (tokens[index]?.startsWith("-")) {
    return failure("unsupported_pnpm_global_option", { option: tokens[index] });
  }
  return {
    ok: true,
    command: tokens[index] ?? null,
    rest: tokens.slice(index + 1),
    filters,
    workspaceRoot,
  };
}

function mergeFilters(prefix, values) {
  return [...prefix, ...(values.filters ?? [])];
}

function installDescriptor(manager, rest, prefix = {}) {
  const parsed = parseOptions(rest, {
    "--filter": FILTER_OPTIONS["--filter"],
    "-F": FILTER_OPTIONS["-F"],
    "--frozen-lockfile": { key: "frozenLockfile", type: "boolean" },
    "--prefer-offline": { key: "preferOffline", type: "boolean" },
    "--offline": { key: "offline", type: "boolean" },
    "--prod": { key: "production", type: "boolean" },
    "--production": { key: "production", type: "boolean" },
    "--global": { key: "global", type: "boolean" },
    "-g": { key: "global", type: "boolean" },
    "--ignore-scripts": { key: "ignoreScripts", type: "boolean" },
  });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    descriptor: {
      manager,
      form: "install",
      filters: mergeFilters(prefix.filters ?? [], parsed.values),
      packages: parsed.positionals,
      options: {
        frozenLockfile: present(parsed.values.frozenLockfile),
        preferOffline: present(parsed.values.preferOffline),
        offline: present(parsed.values.offline),
        production: present(parsed.values.production),
        global: present(parsed.values.global),
        ignoreScripts: present(parsed.values.ignoreScripts),
        workspaceRoot: present(prefix.workspaceRoot || undefined),
      },
    },
  };
}

function auditDescriptor(manager, rest, prefix = {}) {
  const parsed = parseOptions(rest, {
    ...FILTER_OPTIONS,
    "--audit-level": { key: "auditLevel", type: "value" },
    "--json": { key: "json", type: "boolean" },
    "--prod": { key: "production", type: "boolean" },
    "--production": { key: "production", type: "boolean" },
  });
  if (!parsed.ok) return parsed;
  if (parsed.positionals.length > 0) return failure("unexpected_audit_argument");
  return {
    ok: true,
    descriptor: {
      manager,
      form: "audit",
      filters: mergeFilters(prefix.filters ?? [], parsed.values),
      options: {
        auditLevel: present(parsed.values.auditLevel),
        json: present(parsed.values.json),
        production: present(parsed.values.production),
        workspaceRoot: present(prefix.workspaceRoot || undefined),
      },
    },
  };
}

function outdatedDescriptor(manager, rest, prefix = {}) {
  const parsed = parseOptions(rest, {
    ...FILTER_OPTIONS,
    "--json": { key: "json", type: "boolean" },
    "--long": { key: "long", type: "boolean" },
    "--recursive": { key: "recursive", type: "boolean" },
    "-r": { key: "recursive", type: "boolean" },
  });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    descriptor: {
      manager,
      form: "outdated",
      filters: mergeFilters(prefix.filters ?? [], parsed.values),
      packages: parsed.positionals,
      options: {
        json: present(parsed.values.json),
        long: present(parsed.values.long),
        recursive: present(parsed.values.recursive),
        workspaceRoot: present(prefix.workspaceRoot || undefined),
      },
    },
  };
}

function licensesDescriptor(rest, prefix) {
  if (rest[0] !== "list") return failure("unsupported_pnpm_licenses_form");
  const parsed = parseOptions(rest.slice(1), {
    ...FILTER_OPTIONS,
    "--json": { key: "json", type: "boolean" },
    "--prod": { key: "production", type: "boolean" },
    "--production": { key: "production", type: "boolean" },
  });
  if (!parsed.ok) return parsed;
  if (parsed.positionals.length > 0) return failure("unexpected_licenses_argument");
  return {
    ok: true,
    descriptor: {
      manager: "pnpm",
      form: "licenses",
      filters: mergeFilters(prefix.filters, parsed.values),
      options: {
        json: present(parsed.values.json),
        production: present(parsed.values.production),
        workspaceRoot: present(prefix.workspaceRoot || undefined),
      },
    },
  };
}

function scriptDescriptor(manager, command, rest, prefix = {}) {
  let script;
  let commandArgs;
  if (command === "run" || command === "run-script") {
    script = rest[0];
    commandArgs = rest.slice(1);
  } else {
    const allowed = manager === "pnpm" ? PNPM_SCRIPT_SHORTHANDS : NPM_SCRIPT_SHORTHANDS;
    if (!allowed.has(command)) return failure(`unsupported_${manager}_command`, { command });
    script = command;
    commandArgs = rest;
  }
  if (!script || script.startsWith("-") || /[$?*[]/.test(script)) {
    return failure("missing_or_ambiguous_package_script");
  }
  if (commandArgs[0] === "--") commandArgs = commandArgs.slice(1);
  return {
    ok: true,
    descriptor: {
      manager,
      form: "script",
      filters: prefix.filters ?? [],
      script,
      commandArgs,
      options: { workspaceRoot: present(prefix.workspaceRoot || undefined) },
    },
  };
}

function execDescriptor(manager, rest, prefix = {}) {
  const command = rest[0] === "--" ? rest[1] : rest[0];
  const start = rest[0] === "--" ? 2 : 1;
  if (!command || command.startsWith("-") || /[$?*[]/.test(command)) {
    return failure("missing_or_ambiguous_exec_command");
  }
  return {
    ok: true,
    descriptor: {
      manager,
      form: "exec",
      filters: prefix.filters ?? [],
      executable: command,
      commandArgs: rest.slice(start),
      options: { workspaceRoot: present(prefix.workspaceRoot || undefined) },
    },
  };
}

function viewDescriptor(rest) {
  const parsed = parseOptions(rest, {
    "--json": { key: "json", type: "boolean" },
  });
  if (!parsed.ok) return parsed;
  const [packageSpec, ...fields] = parsed.positionals;
  if (!packageSpec || /[$?*[]/.test(packageSpec)) {
    return failure("missing_or_ambiguous_npm_view_package");
  }
  return {
    ok: true,
    descriptor: {
      manager: "npm",
      form: "view",
      packageSpec,
      fields,
      options: { json: present(parsed.values.json) },
    },
  };
}

function parsePnpm(args) {
  const prefix = consumePnpmPrefix(args);
  if (!prefix.ok) return prefix;
  if (!prefix.command) return failure("missing_pnpm_command");
  if (prefix.command === "install") return installDescriptor("pnpm", prefix.rest, prefix);
  if (prefix.command === "audit") return auditDescriptor("pnpm", prefix.rest, prefix);
  if (prefix.command === "outdated") return outdatedDescriptor("pnpm", prefix.rest, prefix);
  if (prefix.command === "licenses") return licensesDescriptor(prefix.rest, prefix);
  if (prefix.command === "exec") return execDescriptor("pnpm", prefix.rest, prefix);
  return scriptDescriptor("pnpm", prefix.command, prefix.rest, prefix);
}

function parseNpm(args) {
  const [command, ...rest] = args;
  if (!command) return failure("missing_npm_command");
  if (command === "install") return installDescriptor("npm", rest);
  if (command === "audit") return auditDescriptor("npm", rest);
  if (command === "outdated") return outdatedDescriptor("npm", rest);
  if (command === "exec") return execDescriptor("npm", rest);
  if (command === "view") return viewDescriptor(rest);
  return scriptDescriptor("npm", command, rest);
}

export function parsePackageManagerCommand(parsedStage) {
  if (parsedStage.program === "pnpm") {
    const parsed = parsePnpm(parsedStage.args);
    if (!parsed.ok) return parsed;
    return { ...parsed, descriptor: { ...parsed.descriptor, wrapper: parsedStage.wrapper } };
  }
  if (parsedStage.program === "npm") {
    const parsed = parseNpm(parsedStage.args);
    if (!parsed.ok) return parsed;
    return { ...parsed, descriptor: { ...parsed.descriptor, wrapper: parsedStage.wrapper } };
  }
  return failure("no_supported_package_manager", { program: parsedStage.program });
}
