export const ANALYSIS_SCHEMA_VERSION = "openinspect-trace-analysis-block-ab-v0";
export const DEFAULT_ANALYSIS_PROFILE = "block-ab-v0";
export const BLOCK_C_RULESET_VERSION = "openinspect-operation-rules-block-c-v0";
export const BLOCK_C_V1_RULESET_VERSION = "openinspect-operation-rules-block-c-v1";
export const BLOCK_C_V2_RULESET_VERSION = "openinspect-operation-rules-block-c-v2";
export const BLOCK_C_V2_SEMANTIC_RULESET_VERSION = "openinspect-package-command-rules-block-c-v2";
export const BLOCK_D0_DUPLICATION_SCHEMA_VERSION = "openinspect-observed-duplication-block-d0-v0";
export const BLOCK_D0_V1_DUPLICATION_SCHEMA_VERSION =
  "openinspect-observed-duplication-block-d0-v1";
export const ANALYSIS_PROFILES = Object.freeze({
  "block-ab-v0": Object.freeze({
    id: "block-ab-v0",
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    operationNormalization: false,
    outputPrefix: "block-ab-v0",
  }),
  "block-c-v0": Object.freeze({
    id: "block-c-v0",
    analysisSchemaVersion: "openinspect-trace-analysis-block-c-v0",
    operationNormalization: true,
    outputPrefix: "block-c-v0",
    rulesetVersion: BLOCK_C_RULESET_VERSION,
  }),
  "block-c-v1": Object.freeze({
    id: "block-c-v1",
    analysisSchemaVersion: "openinspect-trace-analysis-block-c-v1",
    operationNormalization: true,
    operationSchemaVersion: "v1",
    outputPrefix: "block-c-v1",
    rulesetVersion: BLOCK_C_V1_RULESET_VERSION,
  }),
  "block-c-v2": Object.freeze({
    id: "block-c-v2",
    analysisSchemaVersion: "openinspect-trace-analysis-block-c-v2",
    operationNormalization: true,
    operationSchemaVersion: "v2",
    outputPrefix: "block-c-v2",
    rulesetVersion: BLOCK_C_V2_RULESET_VERSION,
    semanticRulesetVersion: BLOCK_C_V2_SEMANTIC_RULESET_VERSION,
  }),
  "block-d0-v0": Object.freeze({
    id: "block-d0-v0",
    analysisSchemaVersion: "openinspect-trace-analysis-block-d0-v0",
    operationNormalization: true,
    operationSchemaVersion: "v2",
    duplicationAnalysis: true,
    outputPrefix: "block-d0-v0",
    rulesetVersion: BLOCK_C_V2_RULESET_VERSION,
    semanticRulesetVersion: BLOCK_C_V2_SEMANTIC_RULESET_VERSION,
    duplicationSchemaVersion: BLOCK_D0_DUPLICATION_SCHEMA_VERSION,
  }),
  "block-d0-v1": Object.freeze({
    id: "block-d0-v1",
    analysisSchemaVersion: "openinspect-trace-analysis-block-d0-v1",
    operationNormalization: true,
    operationSchemaVersion: "v2",
    duplicationAnalysis: true,
    duplicationSensitivityVersion: "v1",
    outputPrefix: "block-d0-v1",
    rulesetVersion: BLOCK_C_V2_RULESET_VERSION,
    semanticRulesetVersion: BLOCK_C_V2_SEMANTIC_RULESET_VERSION,
    duplicationSchemaVersion: BLOCK_D0_V1_DUPLICATION_SCHEMA_VERSION,
  }),
});
export const SUPPORTED_BUNDLE_SCHEMA_VERSIONS = new Set(["openinspect-trace-v0"]);

export const TRUST_ANCHOR_PATHS = ["manifest.json", "hashes.json"];

export const REQUIRED_HASHED_EVIDENCE_PATHS = [
  "completeness.json",
  "missingness.json",
  "raw/session-index.json",
  "normalized/events.jsonl",
  "normalized/messages.jsonl",
];

export const REQUIRED_BUNDLE_PATHS = [...TRUST_ANCHOR_PATHS, ...REQUIRED_HASHED_EVIDENCE_PATHS];

export const TIMING_DEFINITIONS = {
  allMessageExecutions: "All persisted message [startedAt, completedAt) intervals.",
  childMessageExecutions: "Non-root persisted message [startedAt, completedAt) intervals.",
  childPlatformSetup: "Non-root session [createdAt, first ready event) intervals.",
  childToolInvocations:
    "Non-root tool intervals using event createdAt and the final persisted sandbox timestamp.",
};

export function getAnalysisProfile(profileId = DEFAULT_ANALYSIS_PROFILE) {
  const profile = ANALYSIS_PROFILES[profileId];
  if (!profile) {
    throw new Error(
      `Unknown analysis profile: ${profileId}. Expected one of: ${Object.keys(ANALYSIS_PROFILES).join(", ")}`
    );
  }
  return profile;
}
