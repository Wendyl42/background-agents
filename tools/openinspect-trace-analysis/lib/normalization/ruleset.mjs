import {
  BLOCK_C_RULESET_VERSION,
  BLOCK_C_V1_RULESET_VERSION,
  BLOCK_C_V2_RULESET_VERSION,
} from "../constants.mjs";
import { RuleRegistry } from "./registry.mjs";
import { bashRule } from "./rules/bash.mjs";
import { bashCompositeRuleV2 } from "./rules/bash-v2.mjs";
import { coordinationRulesV1 } from "./rules/coordination-v1.mjs";
import { editRuleV1, grepRuleV1, readRuleV1, writeRuleV1 } from "./rules/filesystem-v1.mjs";
import { filesystemRules, globRule } from "./rules/filesystem.mjs";
import { createPackageManagerSemanticRegistry } from "./rules/package-manager-v2.mjs";

export function createBlockCRuleRegistry() {
  return new RuleRegistry({
    rulesetVersion: BLOCK_C_RULESET_VERSION,
    rules: [...filesystemRules(), bashRule()],
  });
}

export function createBlockCV1RuleRegistry() {
  return new RuleRegistry({
    rulesetVersion: BLOCK_C_V1_RULESET_VERSION,
    operationSchemaVersion: "v1",
    rules: [
      readRuleV1(),
      globRule(),
      grepRuleV1(),
      writeRuleV1(),
      editRuleV1(),
      ...coordinationRulesV1(),
      bashRule(),
    ],
  });
}

export function createBlockCV2RuleRegistry() {
  const semanticRegistry = createPackageManagerSemanticRegistry();
  const registry = new RuleRegistry({
    rulesetVersion: BLOCK_C_V2_RULESET_VERSION,
    operationSchemaVersion: "v2",
    rules: [
      readRuleV1(),
      globRule(),
      grepRuleV1(),
      writeRuleV1(),
      editRuleV1(),
      ...coordinationRulesV1(),
      bashCompositeRuleV2(semanticRegistry),
    ],
  });
  registry.semanticRulesetVersion = semanticRegistry.rulesetVersion;
  registry.semanticRuleInventory = semanticRegistry.inventory();
  return registry;
}

export function createRuleRegistryForProfile(profileId) {
  if (profileId === "block-c-v0") return createBlockCRuleRegistry();
  if (profileId === "block-c-v1") return createBlockCV1RuleRegistry();
  if (profileId === "block-c-v2") return createBlockCV2RuleRegistry();
  if (profileId === "block-d0-v0") return createBlockCV2RuleRegistry();
  if (profileId === "block-d0-v1") return createBlockCV2RuleRegistry();
  throw new Error(`No operation ruleset for profile: ${profileId}`);
}
