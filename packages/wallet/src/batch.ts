/**
 * Pre-signing selection and signing for AP4M mandate setup transactions.
 *
 * A provider capability decision is required before any wallet prompt opens.
 * This module deliberately has no submission API and never retries, changes
 * mode, or falls back after a signing attempt has started.
 */

export type WalletBatchCapability = "supported" | "unsupported" | "unknown";
export type MandateSigningMode = "batch" | "sequential";

export interface MandateSetupAlternatives {
  readonly unsignedBatch?: Readonly<Record<string, unknown>>;
  readonly unsignedSequential?: readonly Readonly<Record<string, unknown>>[];
}

export interface MandateSigningPlan {
  readonly mode: MandateSigningMode;
  readonly promptCount: number;
  readonly transactions: readonly Readonly<Record<string, unknown>>[];
}

export interface SignOnlyWallet {
  signOnly(transaction: Record<string, unknown>): Promise<string>;
}

export interface SignedMandateSetup {
  readonly mode: MandateSigningMode;
  readonly signedBlobs: readonly string[];
}

export type MandateBatchErrorCode =
  | "BATCH_CAPABILITY_UNKNOWN"
  | "BATCH_TRANSACTION_MISSING"
  | "SEQUENTIAL_TRANSACTIONS_MISSING"
  | "INVALID_TRANSACTION_SET"
  | "INVALID_SIGNED_BLOB";

export class MandateBatchError extends Error {
  readonly code: MandateBatchErrorCode;

  constructor(code: MandateBatchErrorCode, message: string) {
    super(message);
    this.name = "MandateBatchError";
    this.code = code;
  }
}

/**
 * Lock the setup mode before signing based on an explicit provider capability.
 * Unknown capability is fail-closed: probing must finish before a prompt opens.
 */
export function createMandateSigningPlan(
  capability: WalletBatchCapability,
  alternatives: MandateSetupAlternatives,
): MandateSigningPlan {
  if (capability === "unknown") {
    throw new MandateBatchError(
      "BATCH_CAPABILITY_UNKNOWN",
      "Confirm whether the selected wallet supports XRPL Batch before signing.",
    );
  }

  if (capability === "supported") {
    const batch = alternatives.unsignedBatch;
    if (batch === undefined) {
      throw new MandateBatchError(
        "BATCH_TRANSACTION_MISSING",
        "The mandate setup does not contain an unsigned Batch transaction.",
      );
    }
    assertTransaction(batch, "Batch");
    return freezePlan("batch", [batch]);
  }

  const sequential = alternatives.unsignedSequential;
  if (sequential === undefined || sequential.length === 0) {
    throw new MandateBatchError(
      "SEQUENTIAL_TRANSACTIONS_MISSING",
      "The mandate setup does not contain an unsigned sequential transaction set.",
    );
  }
  for (const transaction of sequential) {
    assertTransaction(transaction);
    if (transaction.TransactionType === "Batch") {
      throw new MandateBatchError(
        "INVALID_TRANSACTION_SET",
        "A sequential mandate setup cannot contain a Batch transaction.",
      );
    }
  }
  return freezePlan("sequential", sequential);
}

/**
 * Sign the already-selected plan exactly once, in order, using sign-only.
 *
 * Rejections (including cancellation and uncertain provider responses) are
 * propagated immediately. The remaining transactions are not prompted and no
 * alternate plan is attempted.
 */
export async function signMandateSetup(
  plan: MandateSigningPlan,
  wallet: SignOnlyWallet,
): Promise<SignedMandateSetup> {
  assertPlan(plan);
  const signedBlobs: string[] = [];

  for (const transaction of plan.transactions) {
    // Copy the immutable plan transaction because wallet implementations may
    // normalize their input internally. No submit method is available here.
    const signedBlob = await wallet.signOnly(cloneTransaction(transaction));
    if (typeof signedBlob !== "string" || signedBlob.length === 0) {
      throw new MandateBatchError(
        "INVALID_SIGNED_BLOB",
        "The wallet did not return a signed transaction blob.",
      );
    }
    signedBlobs.push(signedBlob);
  }

  return Object.freeze({
    mode: plan.mode,
    signedBlobs: Object.freeze(signedBlobs),
  });
}

function assertPlan(plan: MandateSigningPlan): void {
  if (
    (plan.mode !== "batch" && plan.mode !== "sequential") ||
    !Array.isArray(plan.transactions) ||
    plan.transactions.length === 0 ||
    plan.promptCount !== plan.transactions.length ||
    (plan.mode === "batch" && plan.transactions.length !== 1)
  ) {
    throw new MandateBatchError(
      "INVALID_TRANSACTION_SET",
      "The mandate signing plan is invalid.",
    );
  }
  for (const transaction of plan.transactions) {
    assertTransaction(transaction, plan.mode === "batch" ? "Batch" : undefined);
    if (plan.mode === "sequential" && transaction.TransactionType === "Batch") {
      throw new MandateBatchError(
        "INVALID_TRANSACTION_SET",
        "A sequential mandate setup cannot contain a Batch transaction.",
      );
    }
  }
}

function assertTransaction(
  transaction: Readonly<Record<string, unknown>>,
  expectedType?: string,
): void {
  if (
    transaction === null ||
    Array.isArray(transaction) ||
    typeof transaction !== "object" ||
    typeof transaction.TransactionType !== "string" ||
    transaction.TransactionType.length === 0 ||
    (expectedType !== undefined && transaction.TransactionType !== expectedType)
  ) {
    throw new MandateBatchError(
      "INVALID_TRANSACTION_SET",
      "The mandate setup contains an invalid unsigned transaction.",
    );
  }
}

function freezePlan(
  mode: MandateSigningMode,
  transactions: readonly Readonly<Record<string, unknown>>[],
): MandateSigningPlan {
  const copies = transactions.map((transaction) =>
    Object.freeze(cloneTransaction(transaction)),
  );
  return Object.freeze({
    mode,
    promptCount: copies.length,
    transactions: Object.freeze(copies),
  });
}

function cloneTransaction(
  transaction: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return structuredClone(transaction);
}
