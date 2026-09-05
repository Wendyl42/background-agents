function assertRule(rule) {
  if (typeof rule?.id !== "string" || rule.id === "") throw new Error("Rule ID is required");
  if (typeof rule.version !== "string" || rule.version === "") {
    throw new Error(`Rule ${rule.id} version is required`);
  }
  if (!Number.isInteger(rule.priority))
    throw new Error(`Rule ${rule.id} priority must be an integer`);
  if (!Array.isArray(rule.supportedTools) || rule.supportedTools.length === 0) {
    throw new Error(`Rule ${rule.id} supportedTools must be non-empty`);
  }
  if (typeof rule.match !== "function" || typeof rule.normalize !== "function") {
    throw new Error(`Rule ${rule.id} must implement match() and normalize()`);
  }
}

export class RuleRegistry {
  constructor({ rulesetVersion, rules, operationSchemaVersion = "v0" }) {
    if (typeof rulesetVersion !== "string" || rulesetVersion === "") {
      throw new Error("rulesetVersion is required");
    }
    this.rulesetVersion = rulesetVersion;
    this.operationSchemaVersion = operationSchemaVersion;
    const ids = new Set();
    const pairs = new Set();
    for (const rule of rules) {
      assertRule(rule);
      const pair = `${rule.id}@${rule.version}`;
      if (ids.has(rule.id)) throw new Error(`Duplicate rule ID in ruleset: ${rule.id}`);
      if (pairs.has(pair)) throw new Error(`Duplicate rule ID/version in ruleset: ${pair}`);
      ids.add(rule.id);
      pairs.add(pair);
    }
    this.rules = [...rules].sort(
      (left, right) =>
        left.priority - right.priority ||
        left.id.localeCompare(right.id) ||
        left.version.localeCompare(right.version)
    );
  }

  inventory() {
    return this.rules.map((rule) => ({
      id: rule.id,
      version: rule.version,
      priority: rule.priority,
      supportedTools: [...rule.supportedTools].sort(),
    }));
  }

  select(invocation) {
    const matching = this.rules.filter(
      (rule) => rule.supportedTools.includes(invocation.tool) && rule.match(invocation)
    );
    if (matching.length === 0) return null;
    const highestPriority = matching[0].priority;
    const winners = matching.filter((rule) => rule.priority === highestPriority);
    if (winners.length > 1) {
      throw new Error(
        `Rule conflict for ${invocation.invocationId} at priority ${highestPriority}: ` +
          winners.map((rule) => `${rule.id}@${rule.version}`).join(", ")
      );
    }
    return winners[0];
  }
}
