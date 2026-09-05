export class TraceBundleError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TraceBundleError";
    this.details = details;
  }
}

export class TraceValidationError extends Error {
  constructor(errors, warnings = []) {
    super(`Trace validation failed with ${errors.length} error(s)`);
    this.name = "TraceValidationError";
    this.errors = errors;
    this.warnings = warnings;
  }
}
