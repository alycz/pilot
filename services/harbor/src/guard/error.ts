export class GuardError extends Error {
  constructor(
    message: string,
    readonly code:
      | "SENSITIVE_INPUT"
      | "INVALID_ARGUMENTS"
      | "OUTPUT_SERIALIZATION_FAILED",
  ) {
    super(message);
    this.name = "GuardError";
  }
}
