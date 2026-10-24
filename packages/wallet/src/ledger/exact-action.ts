import {
  decode,
  deriveAddress,
  encodeForSigning,
  hashes,
  isValidClassicAddress,
  verifyKeypairSignature,
  type Transaction,
} from "xrpl";

import { ledgerSigningMode, type LedgerSigningMode } from "./clear-sign.js";

export type ExactActionNetwork = "testnet" | "devnet";
export type LedgerRuntime = "ledger-webhid" | "speculos";

/**
 * A valid signature proves control of the selected signing key. It does not
 * prove that the signer was a physical Ledger: Speculos produces equally valid
 * signatures, and WebHID identifies a transport rather than attesting hardware.
 */
export type LedgerRuntimeProvenance = Readonly<{
  runtime: LedgerRuntime;
  signatureEvidence: "signing-key-control-only";
  physicalDeviceInferred: false;
  emulator: boolean;
}>;

export function ledgerRuntimeProvenance(
  runtime: LedgerRuntime,
): LedgerRuntimeProvenance {
  return Object.freeze({
    runtime,
    signatureEvidence: "signing-key-control-only",
    physicalDeviceInferred: false,
    emulator: runtime === "speculos",
  });
}

type CommonExpectation = Readonly<{
  network: ExactActionNetwork;
  account: string;
  sequence: number;
  validatedLedgerIndex: number;
  maxLedgerWindow: number;
  maxFeeDrops: string;
  approvalExpiresAtMs: number;
  quoteExpiresAtMs?: number;
  sourceTag?: number;
  memos?: readonly unknown[];
}>;

export type ExactLedgerActionExpectation = CommonExpectation & (
  | Readonly<{
    kind: "payment";
    destination: string;
    amountDrops: string;
    destinationTag?: number;
    invoiceId?: string;
  }>
  | Readonly<{
    kind: "delegate-grant";
    delegate: string;
    permissions: readonly number[];
    blindSigning: "explicitly-reviewed-delegateset";
  }>
  | Readonly<{
    kind: "delegate-revoke";
    delegate: string;
    blindSigning: "explicitly-reviewed-delegateset";
  }>
  | Readonly<{
    kind: "escrow-create";
    destination: string;
    amountDrops: string;
    finishAfter?: number;
    cancelAfter?: number;
    condition?: string;
    destinationTag?: number;
  }>
  | Readonly<{
    kind: "escrow-finish";
    escrowId: Readonly<{ owner: string; offerSequence: number }>;
    condition?: string;
    fulfillment?: string;
  }>
  | Readonly<{
    kind: "escrow-cancel";
    escrowId: Readonly<{ owner: string; offerSequence: number }>;
  }>
);

export type ExactActionValidationPhase = "before-sign" | "after-sign";

export type VerifiedExactLedgerSignedBlob = Readonly<{
  transaction: Readonly<Record<string, unknown>>;
  hash: string;
  signingMode: LedgerSigningMode;
}>;

export type ExactLedgerActionReview = Readonly<{
  action: ExactLedgerActionExpectation["kind"];
  network: ExactActionNetwork;
  account: string;
  signingMode: LedgerSigningMode;
  digest: string;
  provenance: LedgerRuntimeProvenance;
  approvalExpiresAtMs: number;
  quoteExpiresAtMs?: number;
}>;

export type ExactActionPolicyErrorCode =
  | "INVALID_EXPECTATION"
  | "EXPIRED_APPROVAL"
  | "STALE_QUOTE"
  | "UNSUPPORTED_TRANSACTION"
  | "BLIND_SIGNING_NOT_APPROVED"
  | "UNEXPECTED_FIELD"
  | "SEMANTIC_MISMATCH"
  | "INVALID_SIGNATURE_SHAPE";

export class ExactActionPolicyError extends Error {
  constructor(
    readonly code: ExactActionPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExactActionPolicyError";
  }
}

const UINT32_MAX = 0xffff_ffff;
const HEX = /^(?:[A-Fa-f0-9]{2})+$/;
const BASE_FIELDS = [
  "TransactionType",
  "Account",
  "Fee",
  "Sequence",
  "LastLedgerSequence",
  "SigningPubKey",
  "TxnSignature",
  "SourceTag",
  "Memos",
] as const;

function fail(code: ExactActionPolicyErrorCode, message: string): never {
  throw new ExactActionPolicyError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function exact(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function canonicalDrops(value: unknown, label: string, allowZero = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    fail("SEMANTIC_MISMATCH", `${label} must be canonical XRP drops.`);
  }
  const parsed = BigInt(value);
  if (parsed < (allowZero ? 0n : 1n)) {
    fail("SEMANTIC_MISMATCH", `${label} is outside the supported range.`);
  }
  return parsed;
}

function safeUint32(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > UINT32_MAX) {
    fail("INVALID_EXPECTATION", `${label} must be an unsigned 32-bit integer.`);
  }
  return Number(value);
}

function requiredAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !isValidClassicAddress(value)) {
    fail("INVALID_EXPECTATION", `${label} must be a classic XRPL address.`);
  }
  return value;
}

function allowedFields(
  transaction: Record<string, unknown>,
  actionFields: readonly string[],
): void {
  const allowed = new Set([...BASE_FIELDS, ...actionFields]);
  const unexpected = Object.keys(transaction).find((field) => !allowed.has(field));
  if (unexpected !== undefined) {
    fail("UNEXPECTED_FIELD", `Unsupported transaction field: ${unexpected}.`);
  }
}

function validateCommon(
  transaction: Record<string, unknown>,
  expectation: ExactLedgerActionExpectation,
  phase: ExactActionValidationPhase,
  now: number,
): void {
  if (expectation.network !== "testnet" && expectation.network !== "devnet") {
    fail("INVALID_EXPECTATION", "Ledger exact-action approval is test-network only.");
  }
  requiredAddress(expectation.account, "Expected account");
  if (transaction.Account !== expectation.account) {
    fail("SEMANTIC_MISMATCH", "Transaction account changed.");
  }
  if (!Number.isSafeInteger(expectation.sequence) || expectation.sequence < 0 ||
      transaction.Sequence !== expectation.sequence) {
    fail("SEMANTIC_MISMATCH", "Transaction sequence changed.");
  }
  if (!Number.isSafeInteger(expectation.validatedLedgerIndex) ||
      expectation.validatedLedgerIndex < 1 ||
      !Number.isSafeInteger(expectation.maxLedgerWindow) ||
      expectation.maxLedgerWindow < 1 || expectation.maxLedgerWindow > 256) {
    fail("INVALID_EXPECTATION", "Validated-ledger bounds are invalid.");
  }
  const lastLedger = transaction.LastLedgerSequence;
  if (!Number.isSafeInteger(lastLedger) ||
      Number(lastLedger) <= expectation.validatedLedgerIndex ||
      Number(lastLedger) > expectation.validatedLedgerIndex + expectation.maxLedgerWindow) {
    fail("SEMANTIC_MISMATCH", "Transaction ledger window is stale or too broad.");
  }
  const fee = canonicalDrops(transaction.Fee, "Transaction fee", true);
  const maximumFee = canonicalDrops(expectation.maxFeeDrops, "Maximum fee", true);
  if (fee > maximumFee) fail("SEMANTIC_MISMATCH", "Transaction fee exceeds the reviewed cap.");
  if (!Number.isSafeInteger(expectation.approvalExpiresAtMs) ||
      expectation.approvalExpiresAtMs <= now) {
    fail("EXPIRED_APPROVAL", "The exact-action approval expired.");
  }
  if (expectation.quoteExpiresAtMs !== undefined &&
      (!Number.isSafeInteger(expectation.quoteExpiresAtMs) || expectation.quoteExpiresAtMs <= now)) {
    fail("STALE_QUOTE", "The exact-action quote is stale.");
  }
  if (expectation.sourceTag === undefined) {
    if (transaction.SourceTag !== undefined) {
      fail("UNEXPECTED_FIELD", "An unreviewed SourceTag was added.");
    }
  } else if (transaction.SourceTag !== safeUint32(expectation.sourceTag, "SourceTag")) {
    fail("SEMANTIC_MISMATCH", "Transaction SourceTag changed.");
  }
  if (expectation.memos === undefined) {
    if (transaction.Memos !== undefined) fail("UNEXPECTED_FIELD", "Unreviewed memos were added.");
  } else if (!exact(transaction.Memos, expectation.memos)) {
    fail("SEMANTIC_MISMATCH", "Transaction memos changed.");
  }
  if (transaction.Signers !== undefined) {
    fail("UNEXPECTED_FIELD", "Multi-sign transactions are not supported.");
  }
  if (phase === "before-sign") {
    if ((transaction.SigningPubKey !== undefined && transaction.SigningPubKey !== "") ||
        transaction.TxnSignature !== undefined) {
      fail("INVALID_SIGNATURE_SHAPE", "The transaction must be unsigned before Ledger review.");
    }
  } else if (
    typeof transaction.SigningPubKey !== "string" ||
    !/^(?:02|03)[A-Fa-f0-9]{64}$/.test(transaction.SigningPubKey) ||
    typeof transaction.TxnSignature !== "string" || !HEX.test(transaction.TxnSignature)
  ) {
    fail("INVALID_SIGNATURE_SHAPE", "The post-sign transaction lacks a valid signature shape.");
  } else {
    try {
      if (
        deriveAddress(transaction.SigningPubKey) !== expectation.account ||
        !verifyKeypairSignature(
          encodeForSigning(transaction as Transaction),
          transaction.TxnSignature,
          transaction.SigningPubKey,
        )
      ) {
        fail("INVALID_SIGNATURE_SHAPE", "The post-sign transaction signature does not match the reviewed account.");
      }
    } catch (error) {
      if (error instanceof ExactActionPolicyError) throw error;
      fail("INVALID_SIGNATURE_SHAPE", "The post-sign transaction signature is invalid.");
    }
  }
}

function validatePermissions(value: unknown, expected: readonly number[]): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    fail("SEMANTIC_MISMATCH", "Delegate permissions changed.");
  }
  const seen = new Set<number>();
  for (let index = 0; index < expected.length; index += 1) {
    const permission = expected[index];
    if (!Number.isSafeInteger(permission) || permission! < 1 || permission! > 65_535 || seen.has(permission!)) {
      fail("INVALID_EXPECTATION", "Expected delegate permissions are invalid.");
    }
    seen.add(permission!);
    const entry = value[index];
    if (!isRecord(entry) || !isRecord(entry.Permission) ||
        Object.keys(entry).length !== 1 || Object.keys(entry.Permission).length !== 1 ||
        entry.Permission.PermissionValue !== permission) {
      fail("SEMANTIC_MISMATCH", "Delegate permissions changed.");
    }
  }
}

function validateAction(
  transaction: Record<string, unknown>,
  expectation: ExactLedgerActionExpectation,
): void {
  const expectedType: Readonly<Record<ExactLedgerActionExpectation["kind"], string>> = {
    "payment": "Payment",
    "delegate-grant": "DelegateSet",
    "delegate-revoke": "DelegateSet",
    "escrow-create": "EscrowCreate",
    "escrow-finish": "EscrowFinish",
    "escrow-cancel": "EscrowCancel",
  };
  if (transaction.TransactionType !== expectedType[expectation.kind]) {
    fail("UNSUPPORTED_TRANSACTION", "The transaction type is not the reviewed exact action.");
  }
  switch (expectation.kind) {
    case "payment":
      allowedFields(transaction, ["Destination", "Amount", "DestinationTag", "InvoiceID"]);
      if (transaction.TransactionType !== "Payment" ||
          transaction.Destination !== requiredAddress(expectation.destination, "Payment destination") ||
          transaction.Amount !== expectation.amountDrops) {
        fail("SEMANTIC_MISMATCH", "Payment destination or amount changed.");
      }
      canonicalDrops(expectation.amountDrops, "Payment amount");
      if (expectation.destinationTag === undefined) {
        if (transaction.DestinationTag !== undefined) {
          fail("UNEXPECTED_FIELD", "An unreviewed DestinationTag was added.");
        }
      } else if (transaction.DestinationTag !== safeUint32(expectation.destinationTag, "DestinationTag")) {
        fail("SEMANTIC_MISMATCH", "Payment DestinationTag changed.");
      }
      if (expectation.invoiceId === undefined) {
        if (transaction.InvoiceID !== undefined) {
          fail("UNEXPECTED_FIELD", "An unreviewed InvoiceID was added.");
        }
      } else if (!/^[A-Fa-f0-9]{64}$/.test(expectation.invoiceId) ||
          transaction.InvoiceID !== expectation.invoiceId) {
        fail("SEMANTIC_MISMATCH", "Payment InvoiceID changed.");
      }
      return;
    case "delegate-grant":
      allowedFields(transaction, ["Authorize", "Permissions"]);
      if (expectation.permissions.length === 0 || expectation.permissions.length > 10 ||
          transaction.TransactionType !== "DelegateSet" ||
          transaction.Authorize !== requiredAddress(expectation.delegate, "Delegate")) {
        fail("SEMANTIC_MISMATCH", "DelegateSet grant changed.");
      }
      validatePermissions(transaction.Permissions, expectation.permissions);
      return;
    case "delegate-revoke":
      allowedFields(transaction, ["Authorize", "Permissions"]);
      if (transaction.TransactionType !== "DelegateSet" ||
          transaction.Authorize !== requiredAddress(expectation.delegate, "Delegate") ||
          !Array.isArray(transaction.Permissions) || transaction.Permissions.length !== 0) {
        fail("SEMANTIC_MISMATCH", "DelegateSet revocation changed.");
      }
      return;
    case "escrow-create": {
      allowedFields(transaction, [
        "Destination", "Amount", "FinishAfter", "CancelAfter", "Condition", "DestinationTag",
      ]);
      if (transaction.TransactionType !== "EscrowCreate" ||
          transaction.Destination !== requiredAddress(expectation.destination, "Escrow destination") ||
          transaction.Amount !== expectation.amountDrops) {
        fail("SEMANTIC_MISMATCH", "EscrowCreate destination or amount changed.");
      }
      canonicalDrops(expectation.amountDrops, "Escrow amount");
      if (expectation.finishAfter === undefined && expectation.cancelAfter === undefined) {
        fail("INVALID_EXPECTATION", "EscrowCreate requires a reviewed time bound.");
      }
      for (const [field, expected] of [
        ["FinishAfter", expectation.finishAfter],
        ["CancelAfter", expectation.cancelAfter],
        ["Condition", expectation.condition],
        ["DestinationTag", expectation.destinationTag],
      ] as const) {
        if (expected === undefined ? transaction[field] !== undefined : transaction[field] !== expected) {
          fail("SEMANTIC_MISMATCH", `EscrowCreate ${field} changed.`);
        }
      }
      if (expectation.finishAfter !== undefined) safeUint32(expectation.finishAfter, "FinishAfter");
      if (expectation.cancelAfter !== undefined) safeUint32(expectation.cancelAfter, "CancelAfter");
      if (expectation.finishAfter !== undefined && expectation.cancelAfter !== undefined &&
          expectation.cancelAfter <= expectation.finishAfter) {
        fail("INVALID_EXPECTATION", "Escrow cancellation must follow its finish time.");
      }
      if (expectation.destinationTag !== undefined) safeUint32(expectation.destinationTag, "DestinationTag");
      if (expectation.condition !== undefined && !HEX.test(expectation.condition)) {
        fail("INVALID_EXPECTATION", "Escrow condition must be even-length hex.");
      }
      return;
    }
    case "escrow-finish": {
      allowedFields(transaction, ["Owner", "OfferSequence", "Condition", "Fulfillment"]);
      const { owner, offerSequence } = expectation.escrowId;
      if (transaction.TransactionType !== "EscrowFinish" ||
          transaction.Owner !== requiredAddress(owner, "Escrow owner") ||
          transaction.OfferSequence !== safeUint32(offerSequence, "Escrow offer sequence")) {
        fail("SEMANTIC_MISMATCH", "EscrowFinish identifier changed.");
      }
      const paired = expectation.condition !== undefined || expectation.fulfillment !== undefined;
      if (paired && (expectation.condition === undefined || expectation.fulfillment === undefined)) {
        fail("INVALID_EXPECTATION", "Escrow condition and fulfillment must be reviewed together.");
      }
      for (const [field, expected] of [
        ["Condition", expectation.condition], ["Fulfillment", expectation.fulfillment],
      ] as const) {
        if (expected === undefined ? transaction[field] !== undefined : transaction[field] !== expected) {
          fail("SEMANTIC_MISMATCH", `EscrowFinish ${field} changed.`);
        }
        if (expected !== undefined && !HEX.test(expected)) {
          fail("INVALID_EXPECTATION", `EscrowFinish ${field} must be even-length hex.`);
        }
      }
      return;
    }
    case "escrow-cancel": {
      allowedFields(transaction, ["Owner", "OfferSequence"]);
      const { owner, offerSequence } = expectation.escrowId;
      if (transaction.TransactionType !== "EscrowCancel" ||
          transaction.Owner !== requiredAddress(owner, "Escrow owner") ||
          transaction.OfferSequence !== safeUint32(offerSequence, "Escrow offer sequence")) {
        fail("SEMANTIC_MISMATCH", "EscrowCancel identifier changed.");
      }
    }
  }
}

export async function validateExactLedgerAction(input: Readonly<{
  transaction: Readonly<Record<string, unknown>>;
  expectation: ExactLedgerActionExpectation;
  provenance: LedgerRuntimeProvenance;
  phase?: ExactActionValidationPhase;
  now?: number;
}>): Promise<ExactLedgerActionReview> {
  const transaction = { ...input.transaction };
  const phase = input.phase ?? "before-sign";
  const now = input.now ?? Date.now();
  if (input.provenance.physicalDeviceInferred !== false ||
      input.provenance.signatureEvidence !== "signing-key-control-only" ||
      input.provenance.emulator !== (input.provenance.runtime === "speculos")) {
    fail("INVALID_EXPECTATION", "Ledger runtime provenance is inconsistent.");
  }
  validateCommon(transaction, input.expectation, phase, now);
  validateAction(transaction, input.expectation);
  const signingMode = ledgerSigningMode(transaction);
  if (signingMode === "blind") {
    const explicitDelegateReview =
      (input.expectation.kind === "delegate-grant" || input.expectation.kind === "delegate-revoke") &&
      input.expectation.blindSigning === "explicitly-reviewed-delegateset";
    if (!explicitDelegateReview) {
      fail("BLIND_SIGNING_NOT_APPROVED", "This blind-sign transaction is not an explicitly supported Ledger action.");
    }
  }
  const unsigned = { ...transaction };
  delete unsigned.SigningPubKey;
  delete unsigned.TxnSignature;
  const digest = await sha256Hex(canonical({
    version: 1,
    action: input.expectation,
    transaction: unsigned,
  }));
  return Object.freeze({
    action: input.expectation.kind,
    network: input.expectation.network,
    account: input.expectation.account,
    signingMode,
    digest,
    provenance: input.provenance,
    approvalExpiresAtMs: input.expectation.approvalExpiresAtMs,
    ...(input.expectation.quoteExpiresAtMs === undefined
      ? {} : { quoteExpiresAtMs: input.expectation.quoteExpiresAtMs }),
  });
}

/** Decode, cryptographically verify, and hash one exact signed transaction. */
export function verifyExactLedgerSignedBlob(input: Readonly<{
  signedBlob: string;
  expectation: ExactLedgerActionExpectation;
  now?: number;
}>): VerifiedExactLedgerSignedBlob {
  if (typeof input.signedBlob !== "string" || input.signedBlob.length === 0 ||
      input.signedBlob.length % 2 !== 0 || !/^[A-Fa-f0-9]+$/.test(input.signedBlob)) {
    fail("INVALID_SIGNATURE_SHAPE", "The signed transaction blob is invalid.");
  }
  let transaction: Record<string, unknown>;
  try {
    transaction = decode(input.signedBlob) as Record<string, unknown>;
  } catch {
    fail("INVALID_SIGNATURE_SHAPE", "The signed transaction blob cannot be decoded.");
  }
  validateCommon(transaction, input.expectation, "after-sign", input.now ?? Date.now());
  validateAction(transaction, input.expectation);
  const signingMode = ledgerSigningMode(transaction);
  if (signingMode === "blind") {
    const explicitDelegateReview =
      (input.expectation.kind === "delegate-grant" || input.expectation.kind === "delegate-revoke") &&
      input.expectation.blindSigning === "explicitly-reviewed-delegateset";
    if (!explicitDelegateReview) {
      fail("BLIND_SIGNING_NOT_APPROVED", "This blind-sign transaction is not an explicitly supported Ledger action.");
    }
  }
  let hash: string;
  try {
    hash = hashes.hashSignedTx(input.signedBlob).toUpperCase();
  } catch {
    fail("INVALID_SIGNATURE_SHAPE", "The signed transaction hash is invalid.");
  }
  return Object.freeze({ transaction: Object.freeze(transaction), hash, signingMode });
}

export type LedgerApprovalStatus =
  | "review"
  | "signing"
  | "signed"
  | "submitting"
  | "settlement-unknown"
  | "validated"
  | "rejected"
  | "timed-out"
  | "expired"
  | "stale-quote"
  | "failed";

export type LedgerApprovalState = Readonly<{
  status: LedgerApprovalStatus;
  approvalExpiresAtMs: number;
  quoteExpiresAtMs?: number;
  signTimeoutMs: number;
  signDeadlineMs?: number;
}>;

export type LedgerApprovalEvent =
  | Readonly<{ type: "begin-sign" }>
  | Readonly<{ type: "user-rejected" }>
  | Readonly<{ type: "sign-succeeded" }>
  | Readonly<{ type: "begin-submit" }>
  | Readonly<{ type: "submit-validated" }>
  | Readonly<{ type: "submit-unknown" }>
  | Readonly<{ type: "failed" }>
  | Readonly<{ type: "tick" }>;

export class LedgerApprovalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerApprovalTransitionError";
  }
}

export function createLedgerApprovalState(input: Readonly<{
  approvalExpiresAtMs: number;
  quoteExpiresAtMs?: number;
  signTimeoutMs: number;
}>, now = Date.now()): LedgerApprovalState {
  if (!Number.isSafeInteger(input.approvalExpiresAtMs) ||
      !Number.isSafeInteger(input.signTimeoutMs) || input.signTimeoutMs < 1 ||
      input.signTimeoutMs > 5 * 60_000 ||
      (input.quoteExpiresAtMs !== undefined && !Number.isSafeInteger(input.quoteExpiresAtMs))) {
    throw new LedgerApprovalTransitionError("Approval timing bounds are invalid.");
  }
  if (input.approvalExpiresAtMs <= now) return { ...input, status: "expired" };
  if (input.quoteExpiresAtMs !== undefined && input.quoteExpiresAtMs <= now) {
    return { ...input, status: "stale-quote" };
  }
  return { ...input, status: "review" };
}

const TERMINAL = new Set<LedgerApprovalStatus>([
  "settlement-unknown", "validated", "rejected", "timed-out", "expired",
  "stale-quote", "failed",
]);

function timedState(state: LedgerApprovalState, now: number): LedgerApprovalState | undefined {
  // Once submission begins, a local approval/quote clock cannot establish that
  // no transaction reached the network. Only reconciliation may resolve it.
  if (state.status === "submitting") return undefined;
  if (now >= state.approvalExpiresAtMs) return { ...state, status: "expired" };
  if (state.quoteExpiresAtMs !== undefined && now >= state.quoteExpiresAtMs) {
    return { ...state, status: "stale-quote" };
  }
  if (state.status === "signing" && state.signDeadlineMs !== undefined && now >= state.signDeadlineMs) {
    return { ...state, status: "timed-out" };
  }
  return undefined;
}

export function transitionLedgerApproval(
  state: LedgerApprovalState,
  event: LedgerApprovalEvent,
  now = Date.now(),
): LedgerApprovalState {
  if (TERMINAL.has(state.status)) {
    throw new LedgerApprovalTransitionError(`Approval is terminal: ${state.status}.`);
  }
  const timed = timedState(state, now);
  if (timed !== undefined) return timed;
  if (event.type === "tick") return state;
  if (event.type === "user-rejected") {
    if (state.status !== "review" && state.status !== "signing") {
      throw new LedgerApprovalTransitionError("User rejection is no longer an available transition.");
    }
    return { ...state, status: "rejected" };
  }
  if (event.type === "failed") return { ...state, status: "failed" };
  if (state.status === "review" && event.type === "begin-sign") {
    return {
      ...state,
      status: "signing",
      signDeadlineMs: Math.min(now + state.signTimeoutMs, state.approvalExpiresAtMs),
    };
  }
  if (state.status === "signing" && event.type === "sign-succeeded") {
    return { ...state, status: "signed" };
  }
  if (state.status === "signed" && event.type === "begin-submit") {
    return { ...state, status: "submitting" };
  }
  if (state.status === "submitting" && event.type === "submit-validated") {
    return { ...state, status: "validated" };
  }
  if (state.status === "submitting" && event.type === "submit-unknown") {
    return { ...state, status: "settlement-unknown" };
  }
  throw new LedgerApprovalTransitionError(
    `Invalid approval transition: ${state.status} -> ${event.type}.`,
  );
}
