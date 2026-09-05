import { BLOCK_C_V2_SEMANTIC_RULESET_VERSION } from "../../constants.mjs";
import { normalizedInputFingerprint } from "../inputs.mjs";
import { RuleRegistry } from "../registry.mjs";

function workingDirectory(context) {
  return context.effectiveWorkdir
    ? { present: true, value: context.effectiveWorkdir, source: context.workdirSource }
    : { present: false };
}

function workspaceTarget(context) {
  return context.effectiveWorkdir ?? "invocation_default";
}

function baseEvidence(context) {
  return {
    sourceEventId: context.invocation.sourceEventId,
    sourceSessionId: context.invocation.sessionId,
    shellSegmentId: context.segment.shellSegmentId,
    shellSegmentIndex: context.segment.segmentIndex,
    pipelineStageIndex: 0,
    commandRequestOnly: true,
    outcomeParsing: "not_implemented",
  };
}

function operation(context, { kind, targetType, target, effect, parameters }) {
  return {
    kind,
    targetType,
    target,
    scope: context.effectiveWorkdir ? context.workdirSource : "invocation_default",
    effect,
    parameters,
    inputFingerprint: normalizedInputFingerprint({ target, parameters }),
    normalizationLevel: "specific",
    confidence: "high",
    sourceShellSegmentIds: [context.segment.shellSegmentId],
    evidence: baseEvidence(context),
    diagnostics: {},
  };
}

function workspaceParameters(context) {
  const descriptor = context.descriptor;
  return {
    packageManager: descriptor.manager,
    workingDirectory: workingDirectory(context),
    filters: descriptor.filters ?? [],
    options: descriptor.options ?? {},
    wrapper: descriptor.wrapper ?? null,
  };
}

const FORMS = {
  install: {
    kind: "package_install_request",
    targetType: "package_workspace",
    effect: "write",
    parameters(context) {
      return { ...workspaceParameters(context), packages: context.descriptor.packages ?? [] };
    },
  },
  audit: {
    kind: "package_audit_request",
    targetType: "package_workspace",
    effect: "read",
    parameters: workspaceParameters,
  },
  outdated: {
    kind: "package_outdated_request",
    targetType: "package_workspace",
    effect: "read",
    parameters(context) {
      return { ...workspaceParameters(context), packages: context.descriptor.packages ?? [] };
    },
  },
  licenses: {
    kind: "package_license_inventory_request",
    targetType: "package_workspace",
    effect: "read",
    parameters: workspaceParameters,
  },
  script: {
    kind: "package_script_request",
    targetType: "package_script",
    effect: "unknown",
    target(context) {
      return context.descriptor.script;
    },
    parameters(context) {
      return {
        ...workspaceParameters(context),
        commandArgs: context.descriptor.commandArgs ?? [],
      };
    },
  },
  exec: {
    kind: "package_exec_request",
    targetType: "executable",
    effect: "unknown",
    target(context) {
      return context.descriptor.executable;
    },
    parameters(context) {
      return {
        ...workspaceParameters(context),
        commandArgs: context.descriptor.commandArgs ?? [],
      };
    },
  },
  view: {
    kind: "package_metadata_view_request",
    targetType: "package_spec",
    effect: "read",
    target(context) {
      return context.descriptor.packageSpec;
    },
    parameters(context) {
      return {
        packageManager: context.descriptor.manager,
        workingDirectory: workingDirectory(context),
        fields: context.descriptor.fields ?? [],
        options: context.descriptor.options ?? {},
        wrapper: context.descriptor.wrapper ?? null,
      };
    },
  },
};

function semanticRule(manager, form) {
  const definition = FORMS[form];
  return {
    id: `package-manager.${manager}.${form}`,
    version: "1.0.0",
    priority: 10,
    supportedTools: [manager],
    match: (context) => context.descriptor.form === form,
    normalize(context) {
      const target = definition.target ? definition.target(context) : workspaceTarget(context);
      return operation(context, {
        kind: definition.kind,
        targetType: definition.targetType,
        target,
        effect: definition.effect,
        parameters: definition.parameters(context),
      });
    },
  };
}

export function packageManagerSemanticRules() {
  return [
    semanticRule("pnpm", "install"),
    semanticRule("pnpm", "audit"),
    semanticRule("pnpm", "outdated"),
    semanticRule("pnpm", "licenses"),
    semanticRule("pnpm", "script"),
    semanticRule("pnpm", "exec"),
    semanticRule("npm", "install"),
    semanticRule("npm", "audit"),
    semanticRule("npm", "outdated"),
    semanticRule("npm", "script"),
    semanticRule("npm", "exec"),
    semanticRule("npm", "view"),
  ];
}

export function createPackageManagerSemanticRegistry() {
  return new RuleRegistry({
    rulesetVersion: BLOCK_C_V2_SEMANTIC_RULESET_VERSION,
    rules: packageManagerSemanticRules(),
  });
}
