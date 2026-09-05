/** Preserve the exact Block A + B zero-operation checkpoint shape. */
export function operationNormalizationStatus(toolInvocationCount) {
  return {
    implemented: false,
    rulesetVersion: null,
    toolInvocationCount,
    normalizedOperationCount: 0,
    parserCoverage: 0,
    fallbackCount: toolInvocationCount,
    note: "Normalized-operation rules are reserved for Block C and are not executed in Block A + B.",
  };
}
