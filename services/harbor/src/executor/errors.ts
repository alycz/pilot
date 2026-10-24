/** A fixed, non-sensitive approval lifecycle error safe for provider clients. */
export class ApprovalExpiredError extends Error {
  readonly code = "APPROVAL_EXPIRED";

  constructor() {
    super("Approval expired");
    this.name = "ApprovalExpiredError";
  }
}

export type ExecutionLifetimeErrorCode =
  | "EXECUTION_CONTRACT_UNSUPPORTED"
  | "EXECUTION_CONTRACT_MISMATCH"
  | "EXECUTION_SNAPSHOT_STALE"
  | "EXECUTION_SNAPSHOT_INVALID"
  | "TRANSACTION_WINDOW_TOO_SHORT"
  | "APPROVAL_EXPIRED"
  | "FEE_LOAD_UNSAFE"
  | "ACCOUNT_SEQUENCE_CHANGED"
  | "BALANCE_INVARIANT_CHANGED"
  | "APPROVAL_PREFLIGHT_REQUIRED"
  | "APPROVAL_ALREADY_PREFLIGHTED"
  | "APPROVAL_INVALIDATED"
  | "APPROVAL_RECOVERY_NOT_READY"
  | "APPROVAL_RECOVERY_STATE_CHANGED"
  | "APPROVAL_RECOVERY_INCOMPLETE"
  | "APPROVAL_RECOVERY_CONFLICT"
  | "APPROVAL_TRANSACTION_MISMATCH"
  | "RELAY_ALREADY_ATTEMPTED"
  | "SUBMISSION_PENDING";

/** A fixed, non-sensitive v2 execution-lifetime error safe for provider clients. */
export class ExecutionLifetimeError extends Error {
  constructor(
    message: string,
    readonly code: ExecutionLifetimeErrorCode,
  ) {
    super(message);
    this.name = "ExecutionLifetimeError";
  }
}
