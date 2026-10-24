import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import { createHarborRestClient } from "@pilot/harbor-client";
import {
  ExecutionCapabilitySchema,
  type ExecutionCapability,
  type ExecutionContract,
} from "@pilot/contracts";
import { hashes } from "xrpl";
import { PILOT_ISOLATED_DEPLOYMENT_PROFILE } from "@pilot/wallet/isolation-profile";
import {
  isLocalWalletProfile,
  resolvePilotRequestAuthority,
  resolvePilotDeploymentProfile,
  resolveProfileHarborBaseUrl,
} from "../../../../lib/runtime-profile";

import {
  readWalletSession,
  verifiedSignedBlobTransaction,
  type WalletSession,
} from "../../../../lib/wallet-session";
import {
  createRlusdAcquisitionIdentity,
  createRlusdAcquisitionQuote,
  assertExactRlusdBalanceDelta,
  rlusdAcquisitionExecuteArgs,
  rlusdAcquisitionSwapArgs,
  rlusdAcquisitionTransactionDigest,
  validateRlusdAcquisitionBuild,
  RLUSD_ACQUISITION_LEDGER_WINDOW,
  RLUSD_ACQUISITION_MIN_FEE_DROPS,
  RLUSD_ACQUISITION_MAX_QUOTE_AGE_LEDGERS,
  RLUSD_ACQUISITION_V2_APPROVAL_TTL_SECONDS,
  RLUSD_ACQUISITION_V2_LEDGER_WINDOW,
  RLUSD_ACQUISITION_V2_MIN_REMAINING_LEDGERS,
  RlusdAcquisitionQuoteSchema,
  RlusdAcquisitionBuildValidationError,
  type RlusdAcquisitionAccountState,
  type RlusdAcquisitionQuote,
  type RlusdAcquisitionTransactionDigest,
} from "../../../../lib/rlusd-acquisition";

const RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
const RLUSD_AMOUNT = "75";
const XRP_CAP_DROPS = 275_000_000n;
const FILL_OR_KILL_FLAG = 0x0004_0000;
const MIN_SIGNING_REMAINING_LEDGERS = 2;
const V2_EXECUTION_CONTRACT = "xrpl_execution_v2" as const;
const ACCOUNT_LSF_REQUIRE_AUTH = 0x0004_0000;
const ACCOUNT_LSF_GLOBAL_FREEZE = 0x0040_0000;
const TESTNET_RPC = "https://s.altnet.rippletest.net:51234/";
const MAX_BODY_BYTES = 1_048_576;
const LOCK_LEASE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_COMPACT_AFTER_GENERATIONS = 128;
const MAX_LOCK_ACQUIRE_ATTEMPTS = 3;
const PROCESS_INSTANCE_ID = randomUUID();
const FORBIDDEN_STATE_KEY = /^(?:tx_?blob|signed_?blob|seed|secret|api_?key|private_?key)$/i;

type Environment = Readonly<Record<string, string | undefined>>;
type PublicStatus =
  | "initializing"
  | "built"
  | "prepared"
  | "signed_pending"
  | "validated"
  | "expired_unsubmitted"
  | "expired_unincluded"
  | "failed";

export type AcquisitionState = {
  version: 1;
  operation_id: string;
  owner: string;
  network: "testnet";
  status: PublicStatus;
  intent_id: string;
  created_at: string;
  updated_at: string;
  refresh_attempt?: number;
  requested_execution_contract?: typeof V2_EXECUTION_CONTRACT;
  build_id?: string;
  build_tx_json?: Record<string, unknown>;
  build_tx_digest?: RlusdAcquisitionTransactionDigest;
  quote?: RlusdAcquisitionQuote;
  account_state?: RlusdAcquisitionAccountState;
  approval_id?: string;
  approval_expires_at?: string;
  tx_json?: Record<string, unknown>;
  last_ledger_sequence?: number;
  hash?: string;
  ledger_index?: number;
  engine_result?: string;
  balance_before?: string;
  balance_before_ledger_index?: number;
  balance_after?: string;
  balance_after_ledger_index?: number;
  execution_capability?: ExecutionCapability;
  approval_received_at?: string;
  approval_preflight_started_at?: string;
  approval_preflight_completed_at?: string;
  approval_preflight_ledger?: number;
  approval_preflight_remaining_ledgers?: number;
  approval_reconcile_completed_at?: string;
  approval_reconcile_execution_id?: string;
  approval_reconcile_validated_ledger?: number;
  approval_reconcile_first_inclusion_ledger?: number;
  approval_reconcile_last_ledger_sequence?: number;
};

export interface AcquisitionStateStore {
  assertReady(): Promise<void>;
  load(owner: string): Promise<AcquisitionState | undefined>;
  save(owner: string, state: AcquisitionState): Promise<void>;
  withOwnerLock<T>(owner: string, callback: () => Promise<T>): Promise<T>;
}

type LegacyPersistedAcquisitionState = {
  version: 1;
  state: AcquisitionState;
  integrity: string;
};

type IsolatedPersistedAcquisitionState = {
  version: 2;
  deployment_profile: typeof PILOT_ISOLATED_DEPLOYMENT_PROFILE;
  state: AcquisitionState;
  integrity: string;
};

type PersistedAcquisitionState =
  | LegacyPersistedAcquisitionState
  | IsolatedPersistedAcquisitionState;

export type BuiltAcquisition = {
  buildId: string;
  transaction: Record<string, unknown>;
  transactionDigest: RlusdAcquisitionTransactionDigest;
  quote: RlusdAcquisitionQuote;
  accountState: RlusdAcquisitionAccountState;
  balanceBefore: string;
  balanceBeforeLedgerIndex: number;
  executionCapability?: ExecutionCapability;
};

export type ExecutedAcquisition = {
  approvalId: string;
  approvalExpiresAt: string;
  transaction: Record<string, unknown>;
};

export type AcquisitionCompletionProof = {
  hash: string;
  ledgerIndex: number;
  engineResult: "tesSUCCESS";
  balanceAfter: string;
  balanceAfterLedgerIndex: number;
};

export type AcquisitionLookup = {
  hash: string;
  validated: boolean;
  ledgerIndex?: number;
  engineResult?: string;
};

export type AcquisitionRefreshPrecheck = {
  ledgerIndex: number;
  sequence: number;
  balance: string;
};

export type AcquisitionTimingEvent = Readonly<{
  operationId: string;
  refreshAttempt: number;
  stage:
    | "preflight_snapshot_completed"
    | "post_sign_proof_completed"
    | "harbor_submit_started"
    | "harbor_submit_responded";
  at: string;
  lastLedgerSequence: number;
  ledgerIndex?: number;
  remainingLedgers?: number;
  engineResult?: string;
}>;

export type AcquisitionRelayResult =
  | { hash: string; validated: true; ledgerIndex: number; engineResult: string }
  | { failed: true; engineResult: string };

export type AcquisitionApprovalPreflight = {
  approvalId: string;
  expiresAt: string;
  validatedLedger: number;
  remainingLedgers: number;
  executionCapability: ExecutionCapability;
};

export type AcquisitionApprovalReconcile = {
  status: "expired_nonincluded";
  approvalId: string;
  executionId: string;
  validatedLedger: number;
  firstInclusionLedger: number;
  lastLedgerSequence: number;
  nextAction: "request_fresh_build";
};

export interface HarborAcquisitionActions {
  refreshPrecheck(owner: string): Promise<AcquisitionRefreshPrecheck>;
  build(
    owner: string,
    operationId: string,
    executionContract: ExecutionContract,
  ): Promise<BuiltAcquisition>;
  execute(
    owner: string,
    operationId: string,
    built: BuiltAcquisition,
    attempt: number,
  ): Promise<ExecutedAcquisition>;
  approvalPreflight(
    approvalId: string,
    capability: ExecutionCapability,
  ): Promise<AcquisitionApprovalPreflight>;
  approvalReconcile(
    approvalId: string,
    capability: ExecutionCapability,
  ): Promise<AcquisitionApprovalReconcile>;
  relay(
    txBlob: string,
    approvalId: string,
    capability?: ExecutionCapability,
  ): Promise<AcquisitionRelayResult>;
  status(hash: string, owner: string): Promise<AcquisitionLookup>;
  proveCompletion(
    hash: string,
    owner: string,
    approvedTransaction: Record<string, unknown>,
    balanceBefore: string,
  ): Promise<AcquisitionCompletionProof>;
}

export interface AcquisitionHandlerDependencies {
  env: Environment;
  harbor: HarborAcquisitionActions;
  now(): Date;
  randomUUID(): string;
  recordTiming(event: AcquisitionTimingEvent): void;
  readSession(request: Request): WalletSession | null;
  stateStore: AcquisitionStateStore;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class HarborOperationError extends Error {
  constructor(
    readonly code: string | undefined,
    readonly kind: "error" | "soft-empty",
  ) {
    super("Harbor operation failed");
    this.name = "HarborOperationError";
  }
}

function acquisitionBuildRequestError(
  error: RlusdAcquisitionBuildValidationError,
): RequestError {
  switch (error.code) {
    case "ACCOUNT_STATE_CHANGED":
      return new RequestError(
        409,
        "ACQUISITION_ACCOUNT_CHANGED",
        "The owner account changed while the RLUSD acquisition was being built. Request a fresh quote and build.",
      );
    case "BUILD_EXPIRED":
      return new RequestError(
        409,
        "ACQUISITION_BUILD_EXPIRED",
        "The RLUSD acquisition build expired before it could be offered for approval.",
      );
    case "QUOTE_LEDGER_MISMATCH":
    case "QUOTE_STALE":
      return new RequestError(
        409,
        "ACQUISITION_QUOTE_STALE",
        "The independently validated RLUSD quote is no longer current enough for this build.",
      );
    case "EXCESS_LEDGER_HORIZON":
    case "EXECUTION_CONTRACT_MISMATCH":
      return new RequestError(
        502,
        "UNSAFE_HARBOR_BUILD",
        "Harbor returned an RLUSD acquisition build that does not match the requested execution contract.",
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function transactionFingerprint(transaction: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(transaction), "utf8").digest("hex");
}

function canonicalSha256Upper(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex").toUpperCase();
}

function economicTransaction(transaction: Record<string, unknown>): Record<string, unknown> {
  const economic = { ...transaction };
  for (const field of [
    "Fee", "Sequence", "LastLedgerSequence", "SigningPubKey", "TxnSignature", "Signers", "Delegate",
  ]) delete economic[field];
  return economic;
}

function executionContractForState(state: AcquisitionState): ExecutionContract {
  return state.requested_execution_contract ?? "xrpl_execution_v1";
}

function executionContractForBuilt(built: BuiltAcquisition): ExecutionContract {
  return built.executionCapability?.execution_contract ?? "xrpl_execution_v1";
}

function assertV2CapabilityBinding(
  capability: ExecutionCapability,
  transaction: Record<string, unknown>,
  owner: string,
  balanceBefore: string,
  balanceLedgerIndex: number,
): void {
  const balanceInvariant = capability.acquisition_balance_invariant;
  if (
    capability.build_revision !== 1 ||
    capability.unsigned_tx_digest_alg !== "sha256-jcs-v1" ||
    capability.economic_fingerprint_alg !== "sha256-jcs-economic-v1" ||
    capability.unsigned_tx_digest !== canonicalSha256Upper(unsignedTransaction(transaction)) ||
    capability.economic_fingerprint !== canonicalSha256Upper({
      owner,
      network: "testnet",
      transaction: economicTransaction(transaction),
    }) ||
    balanceInvariant?.kind !== "issued_balance_unchanged" ||
    balanceInvariant.currency !== RLUSD_CURRENCY ||
    balanceInvariant.issuer !== RLUSD_ISSUER ||
    balanceInvariant.balance !== balanceBefore ||
    balanceInvariant.ledger_index > capability.build_ledger ||
    capability.build_ledger - balanceInvariant.ledger_index > 1 ||
    balanceLedgerIndex < capability.build_ledger
  ) {
    throw new RlusdAcquisitionBuildValidationError(
      "EXECUTION_CONTRACT_MISMATCH",
      "Harbor v2 canonical transaction binding does not match the exact build",
    );
  }
}

function minimumSigningRemainingLedgers(state: AcquisitionState): number {
  return state.execution_capability?.minimum_remaining_ledgers ??
    MIN_SIGNING_REMAINING_LEDGERS;
}

function approvalDeadlineMs(state: AcquisitionState): number {
  const harborDeadline = Date.parse(state.approval_expires_at ?? "");
  if (executionContractForState(state) !== V2_EXECUTION_CONTRACT) return harborDeadline;
  const receivedAt = Date.parse(state.approval_received_at ?? "");
  return Math.min(
    harborDeadline,
    receivedAt + RLUSD_ACQUISITION_V2_APPROVAL_TTL_SECONDS * 1_000,
  );
}

function approvalBinding(state: AcquisitionState): string {
  return createHash("sha256").update(canonicalJson({
    operationId: state.operation_id,
    buildId: state.build_id,
    refreshAttempt: acquisitionAttempt(state),
    executionContract: executionContractForState(state),
    executionCapability: state.execution_capability,
    transactionFingerprint: transactionFingerprint(state.tx_json!),
  }), "utf8").digest("hex");
}

function assertNoPersistedSecret(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoPersistedSecret(entry);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_STATE_KEY.test(key)) throw new Error("Acquisition state contains non-public material");
    assertNoPersistedSecret(entry);
  }
}

function unsignedTransaction(transaction: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...transaction };
  delete copy.SigningPubKey;
  delete copy.TxnSignature;
  delete copy.Signers;
  return copy;
}

function transactionMatches(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return canonicalJson(unsignedTransaction(actual)) === canonicalJson(unsignedTransaction(expected));
}

function validatedTransactionMatches(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const normalized = { ...actual };
  delete normalized.hash;
  delete normalized.date;
  delete normalized.ledger_index;
  delete normalized.ctid;
  if ("Delegate" in normalized) return false;
  return transactionMatches(normalized, expected);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[A-F0-9]{64}$/.test(value);
}

function assertExactAcquisitionTransaction(
  transaction: Record<string, unknown>,
  owner: string,
): number {
  const allowedFields = new Set([
    "TransactionType", "Account", "TakerGets", "TakerPays", "Fee", "Sequence",
    "LastLedgerSequence", "Flags", "Expiration", "SourceTag", "Memos", "SigningPubKey",
  ]);
  const pays = transaction.TakerPays;
  const spends = transaction.TakerGets;
  const fee = typeof transaction.Fee === "string" && /^\d+$/.test(transaction.Fee)
    ? Number(transaction.Fee)
    : Number.NaN;
  const lastLedgerSequence = transaction.LastLedgerSequence;
  if (
    Object.keys(transaction).some((field) => !allowedFields.has(field)) ||
    transaction.TransactionType !== "OfferCreate" ||
    transaction.Account !== owner ||
    transaction.Flags !== FILL_OR_KILL_FLAG ||
    typeof spends !== "string" || !/^[1-9]\d*$/.test(spends) ||
    BigInt(spends) > XRP_CAP_DROPS ||
    !isRecord(pays) || pays.currency !== RLUSD_CURRENCY ||
    pays.issuer !== RLUSD_ISSUER || pays.value !== RLUSD_AMOUNT ||
    !Number.isSafeInteger(fee) || fee < Number(RLUSD_ACQUISITION_MIN_FEE_DROPS) || fee > 100 ||
    !Number.isSafeInteger(transaction.Sequence) || Number(transaction.Sequence) < 0 ||
    !Number.isSafeInteger(lastLedgerSequence) || Number(lastLedgerSequence) < 1 ||
    (transaction.SigningPubKey !== undefined && transaction.SigningPubKey !== "")
  ) {
    throw new RequestError(
      502,
      "UNSAFE_HARBOR_APPROVAL",
      "Harbor did not return the exact approved RLUSD acquisition transaction.",
    );
  }
  return Number(lastLedgerSequence);
}

function assertBuiltAcquisitionState(state: AcquisitionState): BuiltAcquisition {
  if (
    typeof state.build_id !== "string" || !state.build_id.trim() || state.build_id.length > 256 ||
    !isRecord(state.build_tx_json) || !isRecord(state.build_tx_digest) ||
    !isRecord(state.quote) || !isRecord(state.account_state) ||
    typeof state.balance_before !== "string" ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(state.balance_before) ||
    !Number.isSafeInteger(state.balance_before_ledger_index) ||
    Number(state.balance_before_ledger_index) < 1
  ) throw new Error("Invalid built acquisition state");
  const quote = RlusdAcquisitionQuoteSchema.parse(state.quote);
  const accountState = state.account_state as RlusdAcquisitionAccountState;
  const executionContract = executionContractForState(state);
  let executionCapability: ExecutionCapability | undefined;
  if (executionContract === V2_EXECUTION_CONTRACT) {
    executionCapability = ExecutionCapabilitySchema.parse(state.execution_capability);
  } else if (state.execution_capability !== undefined) {
    throw new Error("Legacy acquisition state cannot contain a v2 capability");
  }
  if (
    quote.account !== state.owner || quote.network !== "testnet" ||
    !Number.isSafeInteger(accountState.ledgerIndex) || accountState.ledgerIndex < 1 ||
    !Number.isSafeInteger(accountState.sequence) || accountState.sequence < 0 ||
    quote.ledger_index > accountState.ledgerIndex ||
    accountState.ledgerIndex - quote.ledger_index > RLUSD_ACQUISITION_MAX_QUOTE_AGE_LEDGERS ||
    state.balance_before_ledger_index !== accountState.ledgerIndex
  ) throw new Error("Invalid built acquisition binding");
  const lastLedgerSequence = assertExactAcquisitionTransaction(state.build_tx_json, state.owner);
  if (
    state.build_tx_json.Sequence !== accountState.sequence ||
    lastLedgerSequence <= accountState.ledgerIndex ||
    (executionContract === V2_EXECUTION_CONTRACT
      ? lastLedgerSequence !==
        Number(executionCapability?.build_ledger) + RLUSD_ACQUISITION_V2_LEDGER_WINDOW
      : lastLedgerSequence > accountState.ledgerIndex + RLUSD_ACQUISITION_LEDGER_WINDOW) ||
    typeof state.build_tx_json.TakerGets !== "string" ||
    BigInt(state.build_tx_json.TakerGets) > BigInt(quote.maximum_input_drops)
  ) throw new Error("Invalid built acquisition transaction binding");
  if (executionCapability) {
    if (
      executionCapability.build_revision !== 1 ||
      executionCapability.build_ledger > accountState.ledgerIndex ||
      executionCapability.first_inclusion_ledger !== executionCapability.build_ledger + 1 ||
      executionCapability.last_ledger_sequence !== lastLedgerSequence ||
      executionCapability.quote_ledger === undefined ||
      executionCapability.quote_valid_through_ledger === undefined ||
      executionCapability.build_ledger < quote.ledger_index
    ) throw new Error("Invalid v2 acquisition capability binding");
    assertV2CapabilityBinding(
      executionCapability,
      state.build_tx_json,
      state.owner,
      state.balance_before,
      state.balance_before_ledger_index,
    );
  }
  const digest = rlusdAcquisitionTransactionDigest(state.build_tx_json);
  if (canonicalJson(digest) !== canonicalJson(state.build_tx_digest)) {
    throw new Error("Invalid built acquisition transaction digest");
  }
  return {
    buildId: state.build_id,
    transaction: state.build_tx_json,
    transactionDigest: state.build_tx_digest,
    quote,
    accountState,
    balanceBefore: state.balance_before,
    balanceBeforeLedgerIndex: state.balance_before_ledger_index,
    ...(executionCapability ? { executionCapability } : {}),
  };
}

function stateFileName(owner: string): string {
  return `${createHash("sha256").update(`testnet:${owner}`, "utf8").digest("hex")}.json`;
}

function assertState(value: unknown, owner: string): AcquisitionState {
  if (!isRecord(value)) throw new Error("Invalid acquisition state");
  assertNoPersistedSecret(value);
  const allowedStateFields = new Set([
    "version", "operation_id", "owner", "network", "status", "intent_id", "created_at",
    "updated_at", "refresh_attempt", "requested_execution_contract", "build_id", "build_tx_json", "build_tx_digest", "quote", "account_state",
    "approval_id", "approval_expires_at", "approval_received_at", "approval_preflight_started_at", "approval_preflight_completed_at",
    "approval_preflight_ledger", "approval_preflight_remaining_ledgers", "approval_reconcile_completed_at",
    "approval_reconcile_execution_id", "approval_reconcile_validated_ledger",
    "approval_reconcile_first_inclusion_ledger", "approval_reconcile_last_ledger_sequence",
    "tx_json", "execution_capability",
    "last_ledger_sequence", "hash", "ledger_index", "engine_result", "balance_before",
    "balance_before_ledger_index", "balance_after", "balance_after_ledger_index",
  ]);
  if (Object.keys(value).some((key) => !allowedStateFields.has(key))) {
    throw new Error("Invalid acquisition state");
  }
  const state = value as AcquisitionState;
  if (
    state.version !== 1 || state.owner !== owner || state.network !== "testnet" ||
    !isUuid(state.operation_id) || state.intent_id !== `p-live-acquire-rlusd-${state.operation_id}` ||
    (state.refresh_attempt !== undefined && (!Number.isSafeInteger(state.refresh_attempt) || state.refresh_attempt < 0)) ||
    !["initializing", "built", "prepared", "signed_pending", "validated", "expired_unsubmitted", "expired_unincluded", "failed"].includes(state.status)
  ) throw new Error("Invalid acquisition state");
  if (
    state.requested_execution_contract !== undefined &&
    state.requested_execution_contract !== V2_EXECUTION_CONTRACT
  ) throw new Error("Invalid acquisition execution contract");
  if (["built", "prepared", "signed_pending", "validated", "expired_unsubmitted", "expired_unincluded", "failed"].includes(state.status)) {
    assertBuiltAcquisitionState(state);
  }
  if (["prepared", "signed_pending", "validated", "expired_unsubmitted", "expired_unincluded", "failed"].includes(state.status)) {
    if (
      typeof state.approval_id !== "string" || !state.approval_id || state.approval_id.length > 256 ||
      typeof state.approval_expires_at !== "string" || !Number.isFinite(Date.parse(state.approval_expires_at)) ||
      !isRecord(state.tx_json) ||
      state.last_ledger_sequence !== assertExactAcquisitionTransaction(state.tx_json, owner) ||
      canonicalJson(state.tx_json) !== canonicalJson(state.build_tx_json) ||
      canonicalJson(rlusdAcquisitionTransactionDigest(state.tx_json)) !==
        canonicalJson(state.build_tx_digest) ||
      typeof state.balance_before !== "string" ||
      !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(state.balance_before) ||
      !Number.isSafeInteger(state.balance_before_ledger_index) ||
      Number(state.balance_before_ledger_index) < 1
    ) throw new Error("Invalid acquisition state");
    if (executionContractForState(state) === V2_EXECUTION_CONTRACT) {
      const receivedAt = Date.parse(state.approval_received_at ?? "");
      const expiresAt = Date.parse(state.approval_expires_at);
      if (
        !Number.isFinite(receivedAt) || expiresAt <= receivedAt ||
        expiresAt > receivedAt + RLUSD_ACQUISITION_V2_APPROVAL_TTL_SECONDS * 1_000
      ) throw new Error("Invalid v2 acquisition approval lifetime");
      const startedAt = Date.parse(state.approval_preflight_started_at ?? "");
      const hasStartedPreflight = state.approval_preflight_started_at !== undefined;
      if (hasStartedPreflight && (
        !Number.isFinite(startedAt) || startedAt >= approvalDeadlineMs(state)
      )) throw new Error("Invalid v2 acquisition approval preflight start");
      const hasAnyCompletedPreflight = state.approval_preflight_completed_at !== undefined ||
        state.approval_preflight_ledger !== undefined ||
        state.approval_preflight_remaining_ledgers !== undefined;
      if (hasAnyCompletedPreflight) {
        const completedAt = Date.parse(state.approval_preflight_completed_at ?? "");
        if (
          !hasStartedPreflight || !Number.isFinite(completedAt) || completedAt < startedAt ||
          completedAt >= approvalDeadlineMs(state) ||
          !Number.isSafeInteger(state.approval_preflight_ledger) ||
          Number(state.approval_preflight_ledger) < Number(state.account_state?.ledgerIndex) ||
          !Number.isSafeInteger(state.approval_preflight_remaining_ledgers) ||
          state.approval_preflight_remaining_ledgers !==
            Number(state.last_ledger_sequence) - Number(state.approval_preflight_ledger) ||
          Number(state.approval_preflight_remaining_ledgers) <
            RLUSD_ACQUISITION_V2_MIN_REMAINING_LEDGERS
        ) throw new Error("Invalid v2 acquisition approval preflight");
      }
      const reconcileFields = [
        state.approval_reconcile_completed_at,
        state.approval_reconcile_execution_id,
        state.approval_reconcile_validated_ledger,
        state.approval_reconcile_first_inclusion_ledger,
        state.approval_reconcile_last_ledger_sequence,
      ];
      const reconcileFieldCount = reconcileFields.filter((entry) => entry !== undefined).length;
      if (reconcileFieldCount !== 0) {
        const capability = state.execution_capability;
        const completedAt = Date.parse(state.approval_reconcile_completed_at ?? "");
        if (
          reconcileFieldCount !== reconcileFields.length || !hasStartedPreflight ||
          state.status !== "expired_unsubmitted" || !Number.isFinite(completedAt) || completedAt < startedAt ||
          typeof state.approval_reconcile_execution_id !== "string" ||
          !state.approval_reconcile_execution_id.trim() || state.approval_reconcile_execution_id.length > 256 ||
          !Number.isSafeInteger(state.approval_reconcile_validated_ledger) ||
          Number(state.approval_reconcile_validated_ledger) <= Number(state.last_ledger_sequence) ||
          state.approval_reconcile_first_inclusion_ledger !== capability?.first_inclusion_ledger ||
          state.approval_reconcile_last_ledger_sequence !== capability?.last_ledger_sequence ||
          state.approval_reconcile_last_ledger_sequence !== state.last_ledger_sequence
        ) throw new Error("Invalid v2 acquisition approval recovery proof");
      }
      if (["signed_pending", "validated", "expired_unincluded", "failed"].includes(state.status) && !hasAnyCompletedPreflight) {
        throw new Error("Signed v2 acquisition state is missing approval preflight evidence");
      }
    } else if (state.approval_received_at !== undefined) {
      throw new Error("Legacy acquisition state cannot contain a v2 approval clock");
    } else if (
      state.approval_preflight_started_at !== undefined ||
      state.approval_preflight_completed_at !== undefined ||
      state.approval_preflight_ledger !== undefined ||
      state.approval_preflight_remaining_ledgers !== undefined ||
      state.approval_reconcile_completed_at !== undefined ||
      state.approval_reconcile_execution_id !== undefined ||
      state.approval_reconcile_validated_ledger !== undefined ||
      state.approval_reconcile_first_inclusion_ledger !== undefined ||
      state.approval_reconcile_last_ledger_sequence !== undefined
    ) {
      throw new Error("Legacy acquisition state cannot contain v2 approval preflight evidence");
    }
  }
  if (["signed_pending", "validated", "expired_unincluded", "failed"].includes(state.status) && !isHash(state.hash)) {
    throw new Error("Invalid acquisition state");
  }
  if (["initializing", "built", "prepared", "expired_unsubmitted"].includes(state.status) && (
    state.hash !== undefined || state.ledger_index !== undefined || state.engine_result !== undefined ||
    state.balance_after !== undefined || state.balance_after_ledger_index !== undefined
  )) throw new Error("Unsigned acquisition state contains signed or completion evidence");
  if (state.status === "validated" && (
    !Number.isSafeInteger(state.ledger_index) || Number(state.ledger_index) < 1 ||
    state.engine_result !== "tesSUCCESS" ||
    typeof state.balance_after !== "string" ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(state.balance_after) ||
    !Number.isSafeInteger(state.balance_after_ledger_index) ||
    Number(state.balance_after_ledger_index) < Number(state.ledger_index)
  )) throw new Error("Invalid acquisition state");
  if (state.status === "validated") {
    assertExactRlusdBalanceDelta(state.balance_before!, state.balance_after!, RLUSD_AMOUNT);
  }
  if (state.status === "failed" && (
    typeof state.engine_result !== "string" || !state.engine_result ||
    state.engine_result === "tesSUCCESS" ||
    (state.ledger_index !== undefined &&
      (!Number.isSafeInteger(state.ledger_index) || Number(state.ledger_index) < 1))
  )) throw new Error("Invalid failed acquisition state");
  return state;
}

export class FileAcquisitionStateStore implements AcquisitionStateStore {
  private readonly activeStateLeases = new Map<string, {
    load(): Promise<AcquisitionState | undefined>;
    save(state: AcquisitionState): Promise<void>;
  }>();

  constructor(
    private readonly directory: string | undefined,
    private readonly integritySecret: string | undefined,
    private readonly lockRuntime: {
      pid?: number;
      processInstanceId?: string;
      leaseMs?: number;
      heartbeatMs?: number;
      compactAfterGenerations?: number;
      now?: () => number;
      beforePublish?: (
        kind: "acquire" | "renew" | "release" | "save",
        predecessorToken?: string,
      ) => Promise<void>;
      beforeCompactionStep?: (
        step: "replace_root" | "cleanup",
      ) => Promise<void>;
      afterActiveCompactionPublish?: () => Promise<void>;
      deploymentProfile?: typeof PILOT_ISOLATED_DEPLOYMENT_PROFILE;
    } = {},
  ) {}

  private lockPid(): number {
    return this.lockRuntime.pid ?? process.pid;
  }

  private lockProcessInstanceId(): string {
    return this.lockRuntime.processInstanceId ?? PROCESS_INSTANCE_ID;
  }

  private lockNow(): number {
    return (this.lockRuntime.now ?? Date.now)();
  }

  private lockBelongsToThisProcessInstance(pid: number, processInstanceId: string): boolean {
    return pid === this.lockPid() && processInstanceId === this.lockProcessInstanceId();
  }

  private integrity(value: AcquisitionState): string {
    if (!this.integritySecret || this.integritySecret.length < 32) {
      throw new Error("SESSION_SECRET is unavailable for acquisition state integrity");
    }
    return createHmac("sha256", this.integritySecret)
      .update(
        this.lockRuntime.deploymentProfile === PILOT_ISOLATED_DEPLOYMENT_PROFILE
          ? `pilot.rlusd-acquisition.public-state.v2\0${PILOT_ISOLATED_DEPLOYMENT_PROFILE}\0`
          : "pilot.rlusd-acquisition.public-state.v1\0",
        "utf8",
      )
      .update(canonicalJson(value), "utf8")
      .digest("hex");
  }

  private async resolvedDirectory(): Promise<string> {
    if (!this.directory || !isAbsolute(this.directory)) {
      throw new Error("A preexisting absolute RLUSD acquisition state directory is required");
    }
    const linkInfo = await lstat(this.directory);
    if (linkInfo.isSymbolicLink()) {
      throw new Error("The RLUSD acquisition state directory must not be a symbolic link");
    }
    const info = await stat(this.directory);
    if (!info.isDirectory()) throw new Error("The RLUSD acquisition state path is not a directory");
    const getuid = process.getuid;
    if (typeof getuid === "function" && info.uid !== getuid.call(process)) {
      throw new Error("The RLUSD acquisition state directory must be owned by the current user");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error("The RLUSD acquisition state directory must not be accessible by group or world");
    }
    // Reject a symlink at the configured boundary. Ancestor aliases such as
    // macOS /var -> /private/var are permitted; every file opened inside this
    // directory is independently required to be a private regular file.
    return this.directory;
  }

  async assertReady(): Promise<void> {
    await this.resolvedDirectory();
    this.integrity({} as AcquisitionState);
  }

  private async path(owner: string): Promise<string> {
    return join(await this.resolvedDirectory(), stateFileName(owner));
  }

  private parsePersistedState(value: unknown, owner: string): PersistedAcquisitionState {
    const isolated = this.lockRuntime.deploymentProfile === PILOT_ISOLATED_DEPLOYMENT_PROFILE;
    if (
      !isRecord(value) ||
      (isolated
        ? value.version !== 2 ||
          value.deployment_profile !== PILOT_ISOLATED_DEPLOYMENT_PROFILE
        : value.version !== 1 || "deployment_profile" in value) ||
      !isRecord(value.state) ||
      typeof value.integrity !== "string" || !/^[a-f0-9]{64}$/.test(value.integrity)
    ) throw new Error("Acquisition state integrity is missing");
    const state = assertState(value.state, owner);
    const expected = Buffer.from(this.integrity(state), "hex");
    const actual = Buffer.from(value.integrity, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("Acquisition state integrity check failed");
    }
    return isolated
      ? {
        version: 2,
        deployment_profile: PILOT_ISOLATED_DEPLOYMENT_PROFILE,
        state,
        integrity: value.integrity,
      }
      : { version: 1, state, integrity: value.integrity };
  }

  private stateEnvelope(owner: string, state: AcquisitionState): PersistedAcquisitionState {
    assertState(state, owner);
    return this.lockRuntime.deploymentProfile === PILOT_ISOLATED_DEPLOYMENT_PROFILE
      ? {
        version: 2,
        deployment_profile: PILOT_ISOLATED_DEPLOYMENT_PROFILE,
        state,
        integrity: this.integrity(state),
      }
      : { version: 1, state, integrity: this.integrity(state) };
  }

  private async loadLegacyState(owner: string): Promise<AcquisitionState | undefined> {
    try {
      const path = await this.path(owner);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
        throw new Error("The acquisition state file is not a private regular file");
      }
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new Error("The acquisition state file is not owned by the current user");
      }
      return this.parsePersistedState(JSON.parse(await readFile(path, "utf8")), owner).state;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async load(owner: string): Promise<AcquisitionState | undefined> {
    const lease = this.activeStateLeases.get(owner);
    if (!lease) throw new Error("Acquisition state reads require the active owner lease");
    return lease.load();
  }

  async save(owner: string, state: AcquisitionState): Promise<void> {
    const lease = this.activeStateLeases.get(owner);
    if (!lease) throw new Error("Acquisition state writes require the active owner lease");
    await lease.save(state);
  }

  async withOwnerLock<T>(owner: string, callback: () => Promise<T>): Promise<T> {
    const lockPath = `${await this.path(owner)}.lock`;
    const pid = this.lockPid();
    const processInstanceId = this.lockProcessInstanceId();
    const leaseMs = this.lockRuntime.leaseMs ?? LOCK_LEASE_MS;
    const heartbeatMs = this.lockRuntime.heartbeatMs ?? LOCK_HEARTBEAT_MS;
    const compactAfter = this.lockRuntime.compactAfterGenerations ?? LOCK_COMPACT_AFTER_GENERATIONS;
    if (leaseMs < 20 || heartbeatMs < 1 || heartbeatMs * 2 >= leaseMs) {
      throw new Error("Acquisition lock lease configuration is unsafe");
    }
    if (!Number.isSafeInteger(compactAfter) || compactAfter < 4) {
      throw new Error("Acquisition lock compaction threshold is unsafe");
    }
    type LockRecord = {
      version: 3;
      released: boolean;
      compacting?: true;
      checkpoint_token?: string;
      checkpoint_released?: boolean;
      pid: number;
      process_instance_id: string;
      token: string;
      acquired_at: number;
      heartbeat_at: number;
      lease_expires_at: number;
      state?: PersistedAcquisitionState;
    };
    const nextPath = (token: string) => `${lockPath}.next-${token}`;
    const syncLockDirectory = async (): Promise<void> => {
      const directoryHandle = await open(await this.resolvedDirectory(), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    };
    const parseRecord = (value: unknown): LockRecord => {
      if (
        !isRecord(value) || value.version !== 3 || typeof value.released !== "boolean" ||
        !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 ||
        typeof value.process_instance_id !== "string" || !isUuid(value.process_instance_id) ||
        typeof value.token !== "string" || !isUuid(value.token) ||
        !Number.isSafeInteger(value.acquired_at) || !Number.isSafeInteger(value.heartbeat_at) ||
        !Number.isSafeInteger(value.lease_expires_at) ||
        Number(value.heartbeat_at) < Number(value.acquired_at) ||
        (!value.released && Number(value.lease_expires_at) <= Number(value.heartbeat_at)) ||
        (value.compacting === true &&
          (value.released || typeof value.checkpoint_token !== "string" || !isUuid(value.checkpoint_token) ||
            typeof value.checkpoint_released !== "boolean")) ||
        (value.compacting !== undefined && value.compacting !== true)
      ) throw new Error("Invalid acquisition lock generation");
      const state = value.state === undefined
        ? undefined
        : this.parsePersistedState(value.state, owner);
      return { ...value, ...(state ? { state } : {}) } as LockRecord;
    };
    const readRecord = async (path: string): Promise<LockRecord | undefined> => {
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
          throw new Error("Acquisition lock generation is not a private regular file");
        }
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
          throw new Error("Acquisition lock generation is not owned by the current user");
        }
        return parseRecord(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return undefined;
        throw error;
      }
    };
    const publish = async (path: string, value: unknown, token: string): Promise<boolean> => {
      const candidatePath = `${lockPath}.candidate-${randomUUID()}`;
      const candidate = await open(
        candidatePath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      try {
        await candidate.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await candidate.sync();
      } finally {
        await candidate.close();
      }
      try {
        await link(candidatePath, path);
        await syncLockDirectory();
        return true;
      } catch (error) {
        if (isRecord(error) && error.code === "EEXIST") return false;
        throw error;
      } finally {
        await unlink(candidatePath).catch((error: unknown) => {
          if (!isRecord(error) || error.code !== "ENOENT") throw error;
        });
        await syncLockDirectory();
      }
    };
    const tail = async (): Promise<{
      path: string;
      record: LockRecord;
      paths: string[];
      tokens: string[];
    } | undefined> => {
      let path = lockPath;
      let record = await readRecord(path);
      if (!record) return undefined;
      const paths = [path];
      const tokens: string[] = [];
      const seen = new Set<string>();
      for (let depth = 0; depth < 4096; depth += 1) {
        if (seen.has(record.token)) throw new Error("Cyclic acquisition lock generations");
        seen.add(record.token);
        tokens.push(record.token);
        const successorPath = nextPath(record.token);
        const successor = await readRecord(successorPath);
        if (!successor) return { path, record, paths, tokens };
        path = successorPath;
        record = successor;
        paths.push(path);
      }
      throw new Error("Acquisition lock generation limit exceeded");
    };
    type CompactionMarker = {
      version: 1;
      compaction_token: string;
      checkpoint: LockRecord;
      old_paths: string[];
    };
    const markerPathFor = (token: string) => `${lockPath}.compacting-${token}`;
    const parseMarker = (value: unknown): CompactionMarker => {
      if (
        !isRecord(value) || value.version !== 1 ||
        typeof value.compaction_token !== "string" || !isUuid(value.compaction_token) ||
        !Array.isArray(value.old_paths) || value.old_paths.length < 1 ||
        value.old_paths.some((path) => {
          if (typeof path !== "string") return true;
          const prefix = `${lockPath}.next-`;
          const token = path.slice(prefix.length);
          return !isUuid(token) || path !== nextPath(token);
        }) ||
        new Set(value.old_paths).size !== value.old_paths.length
      ) throw new Error("Invalid acquisition lock compaction marker");
      const checkpoint = parseRecord(value.checkpoint);
      if (checkpoint.compacting === true) {
        throw new Error("Invalid acquisition lock compaction checkpoint");
      }
      return { ...value, checkpoint } as CompactionMarker;
    };
    const readMarker = async (markerPath: string): Promise<CompactionMarker | undefined> => {
      try {
        const info = await lstat(markerPath);
        if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
          throw new Error("Acquisition lock compaction marker is not private");
        }
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
          throw new Error("Acquisition lock compaction marker has the wrong owner");
        }
        const marker = parseMarker(JSON.parse(await readFile(markerPath, "utf8")));
        if (markerPath !== markerPathFor(marker.compaction_token)) {
          throw new Error("Acquisition lock compaction marker has the wrong identity");
        }
        return marker;
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return undefined;
        throw error;
      }
    };
    const readMarkers = async (): Promise<CompactionMarker[]> => {
      const directory = await this.resolvedDirectory();
      const prefix = `${basename(lockPath)}.compacting-`;
      const markerPaths = (await readdir(directory))
        .filter((entry) => {
          if (!entry.startsWith(prefix)) return false;
          return isUuid(entry.slice(prefix.length));
        })
        .sort()
        .map((entry) => join(directory, entry));
      const markers: CompactionMarker[] = [];
      for (const markerPath of markerPaths) {
        const marker = await readMarker(markerPath);
        if (marker) markers.push(marker);
      }
      return markers;
    };
    const scavengeCrashCandidates = async (): Promise<void> => {
      const directory = await this.resolvedDirectory();
      const prefix = `${basename(lockPath)}.candidate-`;
      const candidates = (await readdir(directory))
        .filter((entry) => entry.startsWith(prefix) && isUuid(entry.slice(prefix.length)))
        .map((entry) => join(directory, entry));
      let removed = false;
      for (const candidatePath of candidates) {
        let info: Awaited<ReturnType<typeof lstat>>;
        try {
          info = await lstat(candidatePath);
        } catch (error) {
          if (isRecord(error) && error.code === "ENOENT") continue;
          throw error;
        }
        if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
          throw new Error("Acquisition lock candidate is not a private regular file");
        }
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
          throw new Error("Acquisition lock candidate is not owned by the current user");
        }
        // An in-flight publisher gets a full lease before its private staging
        // file is considered crash residue. If it resumes later, link fails
        // closed because the candidate pathname is gone.
        if (this.lockNow() - info.mtimeMs <= leaseMs) continue;
        try {
          await unlink(candidatePath);
          removed = true;
        } catch (error) {
          if (!isRecord(error) || error.code !== "ENOENT") throw error;
        }
      }
      if (removed) await syncLockDirectory();
    };
    const scavengeDetachedGenerations = async (): Promise<void> => {
      const directory = await this.resolvedDirectory();
      const prefix = `${basename(lockPath)}.next-`;
      const entries = (await readdir(directory))
        .filter((entry) => entry.startsWith(prefix) && isUuid(entry.slice(prefix.length)));
      const first = await tail();
      const firstTokens = new Set(first?.tokens ?? []);
      let removed = false;
      for (const entry of entries) {
        const predecessor = entry.slice(prefix.length);
        if (firstTokens.has(predecessor)) continue;
        const path = join(directory, entry);
        let info: Awaited<ReturnType<typeof lstat>>;
        try {
          info = await lstat(path);
        } catch (error) {
          if (isRecord(error) && error.code === "ENOENT") continue;
          throw error;
        }
        if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
          throw new Error("Detached acquisition lock generation is not a private regular file");
        }
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
          throw new Error("Detached acquisition lock generation is not owned by the current user");
        }
        if (this.lockNow() - info.mtimeMs <= leaseMs) continue;
        const second = await tail();
        const secondTokens = new Set(second?.tokens ?? []);
        if (firstTokens.has(predecessor) || secondTokens.has(predecessor)) continue;
        try {
          await unlink(path);
          removed = true;
        } catch (error) {
          if (!isRecord(error) || error.code !== "ENOENT") throw error;
        }
      }
      if (removed) await syncLockDirectory();
    };
    const removeCompactionArtifacts = async (
      marker: CompactionMarker,
      removeOldPaths: boolean,
    ): Promise<void> => {
      const markerPath = markerPathFor(marker.compaction_token);
      if (removeOldPaths) {
        for (const oldPath of marker.old_paths) {
          await unlink(oldPath).catch((error: unknown) => {
            if (!isRecord(error) || error.code !== "ENOENT") throw error;
          });
        }
      }
      await unlink(`${markerPath}.checkpoint-${marker.checkpoint.token}`).catch((error: unknown) => {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      });
      await unlink(markerPath).catch((error: unknown) => {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      });
      await syncLockDirectory();
    };
    const finishCompaction = async (marker: CompactionMarker): Promise<boolean> => {
      await this.lockRuntime.beforeCompactionStep?.("replace_root");
      const markerPath = markerPathFor(marker.compaction_token);
      const checkpointPath = `${markerPath}.checkpoint-${marker.checkpoint.token}`;
      const root = await readRecord(lockPath);
      if (root?.token !== marker.checkpoint.token) {
        const chain = await tail();
        const successor = await readRecord(nextPath(marker.compaction_token));
        if (
          !chain || chain.record.token !== marker.compaction_token ||
          chain.record.compacting !== true ||
          chain.record.checkpoint_token !== marker.checkpoint.token ||
          chain.record.checkpoint_released !== marker.checkpoint.released ||
          chain.record.pid !== marker.checkpoint.pid ||
          chain.record.process_instance_id !== marker.checkpoint.process_instance_id ||
          successor ||
          (this.lockNow() > chain.record.lease_expires_at &&
            !this.lockBelongsToThisProcessInstance(
              chain.record.pid,
              chain.record.process_instance_id,
            ))
        ) {
          // An expired compaction generation is a lease boundary, not authority to
          // orphan a later takeover. Keep the immutable chain and remove only the
          // marker/checkpoint owned by this compaction attempt.
          await removeCompactionArtifacts(marker, false);
          return false;
        }
        try {
          await rename(checkpointPath, lockPath);
        } catch (error) {
          if (!isRecord(error) || error.code !== "ENOENT") throw error;
        }
        await syncLockDirectory();
        const replaced = await readRecord(lockPath);
        if (replaced?.token !== marker.checkpoint.token) {
          throw new Error("Acquisition lock compaction did not install its checkpoint");
        }
      }
      await this.lockRuntime.beforeCompactionStep?.("cleanup");
      await removeCompactionArtifacts(marker, true);
      return true;
    };
    const compact = async (chain: {
      path: string;
      record: LockRecord;
      paths: string[];
    }): Promise<void> => {
      if (chain.record.compacting !== true || !chain.record.checkpoint_token) {
        throw new Error("Acquisition lock compaction generation is missing");
      }
      const checkpoint: LockRecord = {
        version: 3,
        released: chain.record.checkpoint_released ?? true,
        pid: chain.record.pid,
        process_instance_id: chain.record.process_instance_id,
        token: chain.record.checkpoint_token,
        acquired_at: chain.record.acquired_at,
        heartbeat_at: chain.record.heartbeat_at,
        lease_expires_at: chain.record.checkpoint_released === false
          ? chain.record.lease_expires_at
          : chain.record.heartbeat_at,
        ...(chain.record.state ? { state: chain.record.state } : {}),
      };
      const marker: CompactionMarker = {
        version: 1,
        compaction_token: chain.record.token,
        checkpoint,
        old_paths: chain.paths.slice(1),
      };
      const markerPath = markerPathFor(marker.compaction_token);
      const checkpointPath = `${markerPath}.checkpoint-${checkpoint.token}`;
      if (!await publish(checkpointPath, checkpoint, checkpoint.token)) {
        const existingCheckpoint = await readRecord(checkpointPath);
        if (
          existingCheckpoint?.token !== checkpoint.token ||
          existingCheckpoint.released !== checkpoint.released
        ) {
          throw new Error("Another acquisition lock checkpoint is in progress");
        }
      }
      if (!await publish(markerPath, marker, chain.record.token)) {
        const existing = await readMarker(markerPath);
        if (!existing || existing.compaction_token !== marker.compaction_token) {
          throw new Error("Another acquisition lock compaction is in progress");
        }
        await finishCompaction(existing);
        return;
      }
      await finishCompaction(marker);
    };
    const ownerRecord = (
      at: number,
      state: PersistedAcquisitionState | undefined,
    ): LockRecord => ({
      version: 3,
      released: false,
      pid,
      process_instance_id: processInstanceId,
      token: randomUUID(),
      acquired_at: at,
      heartbeat_at: at,
      lease_expires_at: at + leaseMs,
      ...(state ? { state } : {}),
    });
    let current: { path: string; record: LockRecord; depth: number } | undefined;
    const finishAcquisitionCompaction = async (
      operation: () => Promise<unknown>,
    ): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError(
          409,
          "OPERATION_IN_PROGRESS",
          "The acquisition lock compaction is currently in progress.",
        );
      }
    };
    for (let attempt = 0; attempt < MAX_LOCK_ACQUIRE_ATTEMPTS * 4 && !current; attempt += 1) {
      const pendingCompactions = await readMarkers().catch(() => {
        throw new RequestError(409, "OPERATION_IN_PROGRESS", "The acquisition lock compaction requires manual inspection.");
      });
      if (pendingCompactions.length > 0) {
        for (const pendingCompaction of pendingCompactions) {
          await finishAcquisitionCompaction(() => finishCompaction(pendingCompaction));
        }
        continue;
      }
      await scavengeCrashCandidates().catch(() => {
        throw new RequestError(409, "OPERATION_IN_PROGRESS", "The acquisition lock candidates require manual inspection.");
      });
      await scavengeDetachedGenerations().catch(() => {
        throw new RequestError(409, "OPERATION_IN_PROGRESS", "Detached acquisition lock generations require manual inspection.");
      });
      const existing = await tail().catch(() => {
        throw new RequestError(409, "OPERATION_IN_PROGRESS", "The existing acquisition lock requires manual inspection.");
      });
      if (existing?.record.compacting === true) {
        if (
          this.lockBelongsToThisProcessInstance(
            existing.record.pid,
            existing.record.process_instance_id,
          ) || this.lockNow() <= existing.record.lease_expires_at
        ) {
          await finishAcquisitionCompaction(() => compact(existing));
          continue;
        }
        // A crashed/paused compactor has no authority after its lease. It is a
        // normal stale predecessor, so takeover remains a successor CAS.
      }
      if (existing && !existing.record.released) {
        const sameProcessInstance = this.lockBelongsToThisProcessInstance(
          existing.record.pid,
          existing.record.process_instance_id,
        );
        // The lease is the cross-process fencing boundary: CAS prevents a
        // takeover while a renewal is current, and this process instance is
        // never considered dead even if its clock lease passes. A foreign
        // process paused longer than its lease cannot be distinguished from a
        // dead process; recovery may begin only after expiry, and the stale
        // callback then fails its next renewal/release CAS. Callers therefore
        // keep external work durably idempotent under the operation identity.
        if (sameProcessInstance || this.lockNow() <= existing.record.lease_expires_at) {
          throw new RequestError(409, "OPERATION_IN_PROGRESS", "This wallet already has an RLUSD acquisition request in progress.");
        }
      }
      if (existing && existing.paths.length >= compactAfter) {
        const at = this.lockNow();
        const compaction: LockRecord = {
          version: 3,
          released: false,
          compacting: true,
          checkpoint_token: randomUUID(),
          checkpoint_released: true,
          pid,
          process_instance_id: processInstanceId,
          token: randomUUID(),
          acquired_at: at,
          heartbeat_at: at,
          lease_expires_at: at + leaseMs,
          ...(existing.record.state ? { state: existing.record.state } : {}),
        };
        const path = nextPath(existing.record.token);
        if (await publish(path, compaction, compaction.token)) {
          await finishAcquisitionCompaction(() =>
            compact({
              path,
              record: compaction,
              paths: [...existing.paths, path],
            }),
          );
        }
        continue;
      }
      await this.lockRuntime.beforePublish?.("acquire", existing?.record.token);
      const record = ownerRecord(this.lockNow(), existing?.record.state);
      const path = existing ? nextPath(existing.record.token) : lockPath;
      if (await publish(path, record, record.token)) {
        const canonical = await tail();
        if (canonical?.path === path && canonical.record.token === record.token) {
          // An unexpired active generation is now the canonical tail, so a
          // compliant contender cannot compact or supersede it between this
          // validation and callback entry.
          current = { path, record, depth: (existing?.paths.length ?? 0) + 1 };
        } else {
          // Compaction may have deleted and later freed this predecessor path
          // while we were paused before link. A successful link is detached in
          // that ABA case and conveys no ownership. Never unlink a provisional
          // mismatch: it may have become a canonical interior generation with
          // a live successor after this traversal. The immutable tombstone is
          // safer than a non-conditional read-then-unlink cleanup.
        }
      }
    }
    if (!current) throw new RequestError(409, "OPERATION_IN_PROGRESS", "The acquisition lock could not be safely acquired.");
    let heartbeatError: unknown;
    let mutationTail = Promise.resolve();
    const serializeMutation = <R>(operation: () => Promise<R>): Promise<R> => {
      const result = mutationTail.then(operation);
      mutationTail = result.then(() => undefined, () => undefined);
      return result;
    };
    const publishState = async (
      state: AcquisitionState,
      allowLegacyMigration = false,
    ): Promise<void> => {
      if (!current) throw new Error("Acquisition lock ownership is unavailable");
      assertState(state, owner);
      const observed = current;
      const previous = observed.record.state?.state;
      if (!allowLegacyMigration) assertAcquisitionStateTransition(previous, state);
      await this.lockRuntime.beforePublish?.("save", observed.record.token);
      const savedAt = this.lockNow();
      const canonicalBeforeSave = await tail();
      if (
        observed.record.released || observed.record.compacting === true ||
        canonicalBeforeSave?.path !== observed.path ||
        canonicalBeforeSave.record.token !== observed.record.token
      ) {
        throw new Error("Acquisition state write was fenced from the active owner lease");
      }
      // Expiry permits a foreign process to compete for this exact successor;
      // it does not revoke the predecessor by itself. The hard-link below is
      // the ownership linearization point: either this save wins and extends
      // the generation, or a takeover/renewal already occupied the pathname
      // and this stale callback is fenced. This avoids an impossible promise
      // that a wall-clock sample taken before filesystem I/O remains current.
      const saved: LockRecord = {
        ...observed.record,
        token: randomUUID(),
        heartbeat_at: savedAt,
        lease_expires_at: savedAt + leaseMs,
        state: this.stateEnvelope(owner, state),
      };
      const savedPath = nextPath(observed.record.token);
      if (!await publish(savedPath, saved, saved.token)) {
        throw new Error("Acquisition state write lost its owner lease generation");
      }
      const canonicalAfterSave = await tail();
      if (
        canonicalAfterSave?.path !== savedPath ||
        canonicalAfterSave.record.token !== saved.token
      ) {
        throw new Error("Acquisition state write was fenced from the canonical chain");
      }
      current = { path: savedPath, record: saved, depth: observed.depth + 1 };
    };
    const renewLease = async (): Promise<void> => {
      if (!current) throw new Error("Acquisition lock ownership is unavailable");
      const observed = current;
      const recoverableMarkers = await readMarkers();
      for (const marker of recoverableMarkers) {
        if (marker.checkpoint.token === observed.record.token) {
          await finishCompaction(marker);
        }
      }
      await this.lockRuntime.beforePublish?.("renew", observed.record.token);
      const heartbeatAt = this.lockNow();
      if (observed.depth >= compactAfter - 1) {
        const compaction: LockRecord = {
          version: 3,
          released: false,
          compacting: true,
          checkpoint_token: randomUUID(),
          checkpoint_released: false,
          pid,
          process_instance_id: processInstanceId,
          token: randomUUID(),
          acquired_at: observed.record.acquired_at,
          heartbeat_at: heartbeatAt,
          lease_expires_at: heartbeatAt + leaseMs,
          ...(observed.record.state ? { state: observed.record.state } : {}),
        };
        const path = nextPath(observed.record.token);
        if (!await publish(path, compaction, compaction.token)) {
          throw new Error("Acquisition lock ownership changed before active compaction");
        }
        await this.lockRuntime.afterActiveCompactionPublish?.();
        const chain = await tail();
        const isInstalledCheckpoint = (candidate: typeof chain): boolean =>
          Boolean(
            candidate && candidate.path === lockPath && !candidate.record.released &&
            candidate.record.compacting !== true &&
            candidate.record.token === compaction.checkpoint_token &&
            candidate.record.pid === pid &&
            candidate.record.process_instance_id === processInstanceId &&
            candidate.record.acquired_at === compaction.acquired_at &&
            candidate.record.heartbeat_at === compaction.heartbeat_at &&
            candidate.record.lease_expires_at === compaction.lease_expires_at,
          );
        if (chain && isInstalledCheckpoint(chain)) {
          current = { path: lockPath, record: chain.record, depth: 1 };
          const marker = await readMarker(markerPathFor(compaction.token));
          if (marker) {
            // Root installation is the ownership boundary. Cleanup is
            // idempotent and recoverable by the next heartbeat/contender.
            await finishCompaction(marker).catch(() => undefined);
          }
          return;
        }
        if (chain?.path !== path || chain.record.token !== compaction.token) {
          throw new Error("Acquisition lock active compaction is detached");
        }
        try {
          await compact(chain);
        } catch (error) {
          const installed = await tail();
          if (installed && isInstalledCheckpoint(installed)) {
            current = { path: lockPath, record: installed.record, depth: 1 };
            return;
          }
          throw error;
        }
        const canonical = await tail();
        if (!canonical || !isInstalledCheckpoint(canonical)) {
          throw new Error("Acquisition lock active compaction lost ownership");
        }
        current = { path: lockPath, record: canonical.record, depth: 1 };
        return;
      }
      const renewed: LockRecord = {
        ...observed.record,
        token: randomUUID(),
        heartbeat_at: heartbeatAt,
        lease_expires_at: heartbeatAt + leaseMs,
      };
      const path = nextPath(observed.record.token);
      if (!await publish(path, renewed, renewed.token)) {
        throw new Error("Acquisition lock ownership changed before lease renewal");
      }
      const canonical = await tail();
      if (canonical?.path !== path || canonical.record.token !== renewed.token) {
        throw new Error("Acquisition lock lease renewal was fenced from the canonical chain");
      }
      current = { path, record: renewed, depth: observed.depth + 1 };
    };
    let heartbeatStopped = false;
    const heartbeat = setInterval(() => {
      if (heartbeatStopped || heartbeatError) return;
      void serializeMutation(renewLease).catch((error: unknown) => {
        heartbeatError = error;
      });
    }, heartbeatMs);
    heartbeat.unref?.();
    const stateLease = {
      load: async (): Promise<AcquisitionState | undefined> => {
        if (!current) throw new Error("Acquisition lock ownership is unavailable");
        return current.record.state
          ? structuredClone(current.record.state.state)
          : undefined;
      },
      save: async (state: AcquisitionState): Promise<void> => {
        const durableState = structuredClone(state);
        await serializeMutation(() => publishState(durableState));
      },
    };
    let result!: T;
    try {
      if (!current.record.state) {
        const legacyState = await this.loadLegacyState(owner);
        if (legacyState) {
          await serializeMutation(() => publishState(structuredClone(legacyState), true));
        }
      }
      if (this.activeStateLeases.has(owner)) {
        throw new Error("Acquisition state already has an active owner lease");
      }
      this.activeStateLeases.set(owner, stateLease);
      result = await callback();
    } finally {
      if (this.activeStateLeases.get(owner) === stateLease) {
        this.activeStateLeases.delete(owner);
      }
      heartbeatStopped = true;
      clearInterval(heartbeat);
      await mutationTail;
      if (!current) throw new Error("Acquisition lock ownership is unavailable");
      const observed = current;
      await this.lockRuntime.beforePublish?.("release", observed.record.token);
      const releasedAt = this.lockNow();
      const released: LockRecord = {
        ...observed.record,
        released: true,
        token: randomUUID(),
        heartbeat_at: releasedAt,
        lease_expires_at: releasedAt,
      };
      const releasedPath = nextPath(observed.record.token);
      if (!await publish(releasedPath, released, released.token)) {
        throw new Error("Acquisition lock ownership changed before release");
      }
      const canonicalAfterRelease = await tail();
      if (!canonicalAfterRelease?.paths.includes(releasedPath)) {
        throw new Error("Acquisition lock release was fenced from the canonical chain");
      }
      current = undefined;
      const releasedChain = await tail();
      if (
        releasedChain?.record.token === released.token && releasedChain.record.released &&
        releasedChain.paths.length >= compactAfter
      ) {
        const at = this.lockNow();
        const compaction: LockRecord = {
          version: 3,
          released: false,
          compacting: true,
          checkpoint_token: randomUUID(),
          checkpoint_released: true,
          pid,
          process_instance_id: processInstanceId,
          token: randomUUID(),
          acquired_at: at,
          heartbeat_at: at,
          lease_expires_at: at + leaseMs,
          ...(released.state ? { state: released.state } : {}),
        };
        const path = nextPath(released.token);
        if (await publish(path, compaction, compaction.token)) {
          await compact({
            path,
            record: compaction,
            paths: [...releasedChain.paths, path],
          });
        }
      }
    }
    if (heartbeatError) throw heartbeatError;
    return result;
  }
}

function unwrap<T>(envelope: {
  ok: boolean;
  data?: T;
  error?: { code?: string; kind: "error" | "soft-empty" };
}): T {
  if (!envelope.ok) {
    throw new HarborOperationError(envelope.error?.code, envelope.error?.kind ?? "error");
  }
  if (envelope.data === undefined) throw new Error("Harbor operation returned no data");
  return envelope.data;
}

async function xrplRpc(
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const upstream = await globalThis.fetch(endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ method, params: [params], api_version: 2 }),
    cache: "no-store",
  });
  if (!upstream.ok) throw new Error("The Testnet ledger provider is unavailable");
  const payload: unknown = await upstream.json();
  if (!isRecord(payload) || !isRecord(payload.result) || typeof payload.result.error === "string") {
    throw new Error("The Testnet ledger provider returned an invalid result");
  }
  return payload.result;
}

async function validatedOfficialRlusdBalance(
  owner: string,
  ledger: { ledger_hash: string } | { ledger_index: "validated" },
  minimumLedgerIndex = 1,
): Promise<{ balance: string; ledgerIndex: number; ledgerHash: string }> {
  const lines = await xrplRpc(TESTNET_RPC, "account_lines", {
    account: owner,
    peer: RLUSD_ISSUER,
    ...ledger,
  });
  if (
    lines.validated !== true || !Number.isSafeInteger(lines.ledger_index) ||
    Number(lines.ledger_index) < minimumLedgerIndex ||
    typeof lines.ledger_hash !== "string" || !/^[A-Fa-f0-9]{64}$/.test(lines.ledger_hash) ||
    !Array.isArray(lines.lines)
  ) throw new Error("The official RLUSD line is not from a sufficiently recent validated ledger");
  const line = lines.lines.find((candidate) =>
    isRecord(candidate) && candidate.account === RLUSD_ISSUER &&
    (candidate.currency === "RLUSD" || candidate.currency === RLUSD_CURRENCY)
  );
  if (
    !isRecord(line) || typeof line.balance !== "string" ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(line.balance) ||
    line.limit !== "10000" || line.freeze === true || line.freeze_peer === true ||
    line.deep_freeze === true || line.deep_freeze_peer === true
  ) throw new Error("The official Testnet RLUSD trust line is missing, frozen, or invalid");
  const issuer = await xrplRpc(TESTNET_RPC, "account_info", {
    account: RLUSD_ISSUER,
    ledger_hash: lines.ledger_hash,
    strict: true,
  });
  const issuerData = issuer.account_data;
  const issuerFlags = isRecord(issuerData) ? issuerData.Flags : undefined;
  if (
    issuer.validated !== true || issuer.ledger_index !== lines.ledger_index ||
    typeof issuer.ledger_hash !== "string" ||
    issuer.ledger_hash.toUpperCase() !== lines.ledger_hash.toUpperCase() ||
    !isRecord(issuerData) || issuerData.Account !== RLUSD_ISSUER ||
    !Number.isSafeInteger(issuerFlags) || Number(issuerFlags) < 0 ||
    (Number(issuerFlags) & ACCOUNT_LSF_GLOBAL_FREEZE) !== 0 ||
    ((Number(issuerFlags) & ACCOUNT_LSF_REQUIRE_AUTH) !== 0 && line.peer_authorized !== true)
  ) throw new Error("The official Testnet RLUSD issuer or authorization state is unusable");
  return {
    balance: line.balance,
    ledgerIndex: Number(lines.ledger_index),
    ledgerHash: lines.ledger_hash.toUpperCase(),
  };
}

async function validatedAcquisitionSnapshot(owner: string): Promise<AcquisitionRefreshPrecheck> {
  const accountResult = await xrplRpc(TESTNET_RPC, "account_info", {
    account: owner,
    ledger_index: "validated",
    strict: true,
  });
  const accountData = accountResult.account_data;
  if (
    accountResult.validated !== true ||
    !Number.isSafeInteger(accountResult.ledger_index) ||
    typeof accountResult.ledger_hash !== "string" ||
    !/^[A-Fa-f0-9]{64}$/.test(accountResult.ledger_hash) ||
    !isRecord(accountData) || accountData.Account !== owner ||
    !Number.isSafeInteger(accountData.Sequence) || Number(accountData.Sequence) < 0
  ) throw new Error("The validated acquisition account state is unavailable");
  const ledgerIndex = Number(accountResult.ledger_index);
  const balance = await validatedOfficialRlusdBalance(
    owner,
    { ledger_hash: accountResult.ledger_hash },
    ledgerIndex,
  );
  if (
    balance.ledgerIndex !== ledgerIndex ||
    balance.ledgerHash !== accountResult.ledger_hash.toUpperCase()
  ) throw new Error("The validated acquisition balance is not ledger-bound");
  return {
    ledgerIndex,
    sequence: Number(accountData.Sequence),
    balance: balance.balance,
  };
}

export function createDefaultHarborActions(env: Environment, now: () => Date): HarborAcquisitionActions {
  const client = createHarborRestClient({
    baseUrl: resolveProfileHarborBaseUrl(env),
    apiKey: env.HARBOR_API_KEY,
    mock: false,
  });
  return {
    async refreshPrecheck(owner) {
      return validatedAcquisitionSnapshot(owner);
    },
    async build(owner, operationId, executionContract) {
      const identity = createRlusdAcquisitionIdentity(owner, operationId);
      const quoteResult = await xrplRpc(TESTNET_RPC, "ripple_path_find", {
        source_account: owner,
        destination_account: owner,
        destination_amount: {
          currency: RLUSD_CURRENCY,
          issuer: RLUSD_ISSUER,
          value: RLUSD_AMOUNT,
        },
        source_currencies: [{ currency: "XRP" }],
        ledger_index: "validated",
      });
      if (
        quoteResult.validated !== true || quoteResult.full_reply !== true ||
        quoteResult.source_account !== owner || quoteResult.destination_account !== owner ||
        !Number.isSafeInteger(quoteResult.ledger_index) ||
        typeof quoteResult.ledger_hash !== "string" || !/^[A-Fa-f0-9]{64}$/.test(quoteResult.ledger_hash) ||
        !isRecord(quoteResult.destination_amount) ||
        quoteResult.destination_amount.currency !== RLUSD_CURRENCY ||
        quoteResult.destination_amount.issuer !== RLUSD_ISSUER ||
        quoteResult.destination_amount.value !== RLUSD_AMOUNT ||
        !Array.isArray(quoteResult.alternatives)
      ) throw new Error("The exact-output RLUSD quote is incomplete");
      const sourceAmounts = quoteResult.alternatives.flatMap((alternative) => {
        if (!isRecord(alternative)) return [];
        const amount = alternative.source_amount;
        return typeof amount === "string" && /^[1-9]\d*$/.test(amount) ? [BigInt(amount)] : [];
      });
      if (sourceAmounts.length === 0) throw new Error("The exact-output RLUSD quote has no XRP route");
      const sourceAmount = sourceAmounts.reduce((lowest, candidate) => candidate < lowest ? candidate : lowest);
      const quote = createRlusdAcquisitionQuote(
        identity,
        sourceAmount,
        Number(quoteResult.ledger_index),
        quoteResult.ledger_hash.toUpperCase(),
      );
      const build = unwrap(await client.op(
        "tx.swap",
        rlusdAcquisitionSwapArgs(identity, executionContract),
      ));
      const snapshot = await validatedAcquisitionSnapshot(owner);
      const accountState = {
        ledgerIndex: snapshot.ledgerIndex,
        sequence: snapshot.sequence,
      };
      const validatedBuild = validateRlusdAcquisitionBuild(
        build,
        identity,
        quote,
        accountState,
        executionContract,
      );
      if (validatedBuild.executionCapability) {
        assertV2CapabilityBinding(
          validatedBuild.executionCapability,
          validatedBuild.transaction,
          owner,
          snapshot.balance,
          snapshot.ledgerIndex,
        );
      }
      return {
        buildId: build.build_id,
        transaction: validatedBuild.transaction,
        transactionDigest: validatedBuild.transactionDigest,
        quote: validatedBuild.quote,
        accountState: validatedBuild.accountState,
        balanceBefore: snapshot.balance,
        balanceBeforeLedgerIndex: snapshot.ledgerIndex,
        ...(validatedBuild.executionCapability
          ? { executionCapability: validatedBuild.executionCapability }
          : {}),
      };
    },
    async execute(owner, operationId, built, attempt) {
      const identity = createRlusdAcquisitionIdentity(owner, operationId);
      const execution = unwrap(await client.op(
        "tx.execute",
        rlusdAcquisitionExecuteArgs(
          identity,
          built.buildId,
          attempt,
          built.executionCapability,
        ),
      ));
      if (
        !isRecord(execution) || execution.status !== "needs_approval" ||
        typeof execution.approval_id !== "string" || !execution.approval_id.trim() ||
        execution.approval_id.length > 256 || execution.policy?.verdict !== "needs_approval" ||
        typeof execution.expires_at !== "string" ||
        !Number.isFinite(Date.parse(execution.expires_at)) || Date.parse(execution.expires_at) <= now().getTime() ||
        (executionContractForBuilt(built) === V2_EXECUTION_CONTRACT &&
          Date.parse(execution.expires_at) >
            now().getTime() + RLUSD_ACQUISITION_V2_APPROVAL_TTL_SECONDS * 1_000) ||
        !isRecord(execution.tx_json) ||
        canonicalJson(execution.tx_json) !== canonicalJson(built.transaction) ||
        canonicalJson(rlusdAcquisitionTransactionDigest(execution.tx_json)) !==
          canonicalJson(built.transactionDigest)
      ) throw new Error("Harbor approval does not match the durable validated build");
      assertExactAcquisitionTransaction(execution.tx_json, owner);
      return {
        approvalId: execution.approval_id,
        approvalExpiresAt: execution.expires_at,
        transaction: execution.tx_json,
      };
    },
    async approvalPreflight(approvalId, capability) {
      const result = unwrap(await client.op("tx.approvalPreflight", {
        approval_id: approvalId,
        execution_contract: capability.execution_contract,
        build_revision: capability.build_revision,
        unsigned_tx_digest: capability.unsigned_tx_digest,
        economic_fingerprint: capability.economic_fingerprint,
      }));
      return {
        approvalId: result.approval_id,
        expiresAt: result.expires_at,
        validatedLedger: result.validated_ledger,
        remainingLedgers: result.remaining_ledgers,
        executionCapability: result.execution_capability,
      };
    },
    async approvalReconcile(approvalId, capability) {
      const result = unwrap(await client.op("tx.approvalReconcile", {
        approval_id: approvalId,
        execution_contract: capability.execution_contract,
        build_revision: capability.build_revision,
        unsigned_tx_digest: capability.unsigned_tx_digest,
        economic_fingerprint: capability.economic_fingerprint,
      }));
      return {
        status: result.status,
        approvalId: result.approval_id,
        executionId: result.execution_id,
        validatedLedger: result.validated_ledger,
        firstInclusionLedger: result.first_inclusion_ledger,
        lastLedgerSequence: result.last_ledger_sequence,
        nextAction: result.next_action,
      };
    },
    async relay(txBlob, approvalId, capability) {
      const result = unwrap(await client.op("tx.submit", capability ? {
        tx_blob: txBlob,
        approval_id: approvalId,
        network: "testnet",
        execution_contract: capability.execution_contract,
        build_revision: capability.build_revision,
        unsigned_tx_digest: capability.unsigned_tx_digest,
        economic_fingerprint: capability.economic_fingerprint,
      } : {
        tx_blob: txBlob,
        approval_id: approvalId,
        network: "testnet",
      }));
      if ("status" in result) {
        return { failed: true, engineResult: result.engine_result };
      }
      return {
        hash: result.hash.toUpperCase(),
        validated: true,
        ledgerIndex: result.ledger_index,
        engineResult: result.engine_result,
      };
    },
    async status(hash, owner) {
      const statusResult = unwrap(await client.op("tx.status", {
        hash,
        account: owner,
        network: "testnet",
      }));
      return {
        hash: statusResult.hash.toUpperCase(),
        validated: statusResult.validated,
        ledgerIndex: statusResult.ledger_index,
        engineResult: statusResult.engine_result,
      };
    },
    async proveCompletion(hash, owner, approvedTransaction, balanceBefore) {
      const result = await xrplRpc(TESTNET_RPC, "tx", {
        transaction: hash,
        binary: false,
      });
      const transaction = result.tx_json;
      const meta = result.meta;
      const returnedHash = typeof result.hash === "string"
        ? result.hash
        : isRecord(transaction) && typeof transaction.hash === "string"
          ? transaction.hash
          : undefined;
      if (
        result.validated !== true || returnedHash?.toUpperCase() !== hash ||
        !Number.isSafeInteger(result.ledger_index) || Number(result.ledger_index) < 1 ||
        !isRecord(meta) || meta.TransactionResult !== "tesSUCCESS" ||
        !isRecord(transaction) || transaction.Account !== owner ||
        !validatedTransactionMatches(transaction, approvedTransaction)
      ) throw new Error("The validated acquisition transaction does not match the exact owner approval");
      const normalized = { ...transaction };
      delete normalized.hash;
      delete normalized.date;
      delete normalized.ledger_index;
      delete normalized.ctid;
      delete normalized.SigningPubKey;
      delete normalized.TxnSignature;
      assertExactAcquisitionTransaction(normalized, owner);
      const balanceAfter = await validatedOfficialRlusdBalance(
        owner,
        { ledger_index: "validated" },
        Number(result.ledger_index),
      );
      assertExactRlusdBalanceDelta(balanceBefore, balanceAfter.balance, RLUSD_AMOUNT);
      return {
        hash,
        ledgerIndex: Number(result.ledger_index),
        engineResult: "tesSUCCESS",
        balanceAfter: balanceAfter.balance,
        balanceAfterLedgerIndex: balanceAfter.ledgerIndex,
      };
    },
  };
}

async function requestAcquisitionBuild(
  owner: string,
  operationId: string,
  executionContract: ExecutionContract,
  dependencies: AcquisitionHandlerDependencies,
): Promise<BuiltAcquisition> {
  try {
    const built = await dependencies.harbor.build(owner, operationId, executionContract);
    if (executionContractForBuilt(built) !== executionContract) {
      throw new RlusdAcquisitionBuildValidationError(
        "EXECUTION_CONTRACT_MISMATCH",
        "Harbor did not honor the requested execution contract",
      );
    }
    if (built.executionCapability) {
      assertV2CapabilityBinding(
        built.executionCapability,
        built.transaction,
        owner,
        built.balanceBefore,
        built.balanceBeforeLedgerIndex,
      );
    }
    return built;
  } catch (error) {
    if (error instanceof RlusdAcquisitionBuildValidationError) {
      throw acquisitionBuildRequestError(error);
    }
    throw error;
  }
}

function response(status: number, body: object): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(error: RequestError): Response {
  return response(error.status, { error: { code: error.code, message: error.message } });
}

function isSameOrigin(request: Request, expectedOrigin: string): boolean {
  return request.headers.get("origin") === expectedOrigin;
}

function publicState(state: AcquisitionState): Record<string, unknown> {
  return {
    operation_id: state.operation_id,
    owner: state.owner,
    network: state.network,
    status: state.status,
    ...(executionContractForState(state) === V2_EXECUTION_CONTRACT
      ? {
          execution_contract: V2_EXECUTION_CONTRACT,
          ...(state.execution_capability
            ? { build_revision: state.execution_capability.build_revision }
            : {}),
        }
      : {}),
    ...(state.status === "prepared" ? {
      tx_json: state.tx_json,
      approval_expires_at: state.approval_expires_at,
      approval_binding: approvalBinding(state),
    } : {}),
    ...(state.hash ? { hash: state.hash } : {}),
    ...(state.ledger_index !== undefined ? { ledger_index: state.ledger_index } : {}),
    ...(state.engine_result ? { engine_result: state.engine_result } : {}),
    ...(state.balance_before !== undefined ? {
      balance_before: state.balance_before,
      balance_before_ledger_index: state.balance_before_ledger_index,
    } : {}),
    ...(state.balance_after !== undefined ? {
      balance_after: state.balance_after,
      balance_after_ledger_index: state.balance_after_ledger_index,
    } : {}),
  };
}

function recordAcquisitionTiming(
  dependencies: AcquisitionHandlerDependencies,
  state: AcquisitionState,
  stage: AcquisitionTimingEvent["stage"],
  details: Pick<AcquisitionTimingEvent, "ledgerIndex" | "remainingLedgers" | "engineResult"> = {},
): void {
  try {
    dependencies.recordTiming({
      operationId: state.operation_id,
      refreshAttempt: acquisitionAttempt(state),
      stage,
      at: dependencies.now().toISOString(),
      lastLedgerSequence: Number(state.last_ledger_sequence),
      ...details,
    });
  } catch {
    // Timing evidence is diagnostic only and must never alter signing or relay safety.
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "UNSUPPORTED_MEDIA_TYPE", "RLUSD acquisition requests must use application/json.");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new RequestError(413, "REQUEST_TOO_LARGE", "The RLUSD acquisition request is too large.");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new RequestError(413, "REQUEST_TOO_LARGE", "The RLUSD acquisition request is too large.");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RequestError(400, "INVALID_JSON", "A valid JSON request body is required.");
  }
  if (!isRecord(body)) throw new RequestError(400, "INVALID_REQUEST", "A valid RLUSD acquisition action is required.");
  return body;
}

function assertBody(body: Record<string, unknown>):
  | { action: "initialize" }
  | { action: "prepare" }
  | {
      action: "preflight";
      operationId: string;
      approvalBinding: string;
    }
  | { action: "refresh"; operationId: string }
  | { action: "status"; operationId: string }
  | { action: "submit"; operationId: string; txBlob: string } {
  if (body.action === "initialize" && exactKeys(body, ["action"])) return { action: "initialize" };
  if (body.action === "prepare" && exactKeys(body, ["action"])) return { action: "prepare" };
  if (
    body.action === "preflight" &&
    exactKeys(body, ["action", "operation_id", "approval_binding"]) &&
    isUuid(body.operation_id) && typeof body.approval_binding === "string" &&
    /^[a-f0-9]{64}$/.test(body.approval_binding)
  ) {
    return {
      action: "preflight",
      operationId: body.operation_id,
      approvalBinding: body.approval_binding,
    };
  }
  if (body.action === "refresh" && exactKeys(body, ["action", "operation_id"]) && isUuid(body.operation_id)) {
    return { action: "refresh", operationId: body.operation_id };
  }
  if (body.action === "status" && exactKeys(body, ["action", "operation_id"]) && isUuid(body.operation_id)) {
    return { action: "status", operationId: body.operation_id };
  }
  if (
    body.action === "submit" && exactKeys(body, ["action", "operation_id", "tx_blob"]) &&
    isUuid(body.operation_id) && typeof body.tx_blob === "string" &&
    /^[A-Fa-f0-9]+$/.test(body.tx_blob) && body.tx_blob.length <= MAX_BODY_BYTES
  ) return { action: "submit", operationId: body.operation_id, txBlob: body.tx_blob };
  throw new RequestError(400, "INVALID_REQUEST", "The RLUSD acquisition action or fields are invalid.");
}

function terminal(state: AcquisitionState): boolean {
  return state.status === "validated" || state.status === "expired_unsubmitted" ||
    state.status === "expired_unincluded" || state.status === "failed";
}

function acquisitionAttempt(state: AcquisitionState): number {
  return state.refresh_attempt ?? 0;
}

function builtStateForAttempt(
  state: AcquisitionState,
  built: BuiltAcquisition,
  attempt: number,
  now: Date,
): AcquisitionState {
  if (executionContractForBuilt(built) !== executionContractForState(state)) {
    throw new RlusdAcquisitionBuildValidationError(
      "EXECUTION_CONTRACT_MISMATCH",
      "The replacement build changed the operation execution contract",
    );
  }
  return {
    version: state.version,
    operation_id: state.operation_id,
    owner: state.owner,
    network: state.network,
    status: "built",
    intent_id: state.intent_id,
    created_at: state.created_at,
    updated_at: now.toISOString(),
    refresh_attempt: attempt,
    ...(state.requested_execution_contract
      ? { requested_execution_contract: state.requested_execution_contract }
      : {}),
    build_id: built.buildId,
    build_tx_json: built.transaction,
    build_tx_digest: built.transactionDigest,
    quote: built.quote,
    account_state: built.accountState,
    balance_before: built.balanceBefore,
    balance_before_ledger_index: built.balanceBeforeLedgerIndex,
    ...(built.executionCapability
      ? { execution_capability: built.executionCapability }
      : {}),
  };
}

function assertAcquisitionRefreshPrecheck(
  value: AcquisitionRefreshPrecheck,
): AcquisitionRefreshPrecheck {
  if (
    !Number.isSafeInteger(value.ledgerIndex) || value.ledgerIndex < 1 ||
    !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
    typeof value.balance !== "string" ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.balance)
  ) throw new Error("The validated acquisition refresh precheck is invalid");
  return value;
}

function assertSafeUnsignedRefreshPrecheck(
  expired: AcquisitionState,
  precheck: AcquisitionRefreshPrecheck,
): void {
  const expiredAccountState = expired.account_state;
  const expiredLastLedgerSequence = expired.last_ledger_sequence;
  if (
    expired.status !== "expired_unsubmitted" || expired.hash !== undefined ||
    !isRecord(expiredAccountState) || !Number.isSafeInteger(expiredLastLedgerSequence) ||
    expired.balance_before === undefined ||
    !Number.isSafeInteger(precheck.ledgerIndex) ||
    precheck.ledgerIndex <= Number(expiredLastLedgerSequence) ||
    (expired.approval_reconcile_validated_ledger !== undefined &&
      precheck.ledgerIndex < expired.approval_reconcile_validated_ledger) ||
    !Number.isSafeInteger(precheck.sequence) ||
    precheck.sequence !== expiredAccountState.sequence ||
    precheck.balance !== expired.balance_before
  ) {
    throw new RequestError(
      409,
      "REFRESH_NOT_SAFE",
      "The expired unsigned acquisition cannot be safely refreshed until a later validated ledger proves the owner sequence and RLUSD balance are unchanged.",
    );
  }
}

function assertReplacementMatchesPrecheck(
  expired: AcquisitionState,
  precheck: AcquisitionRefreshPrecheck,
  replacement: AcquisitionState,
): void {
  const expiredCapability = expired.execution_capability;
  const replacementCapability = replacement.execution_capability;
  if (
    replacement.status !== "built" || !isRecord(replacement.account_state) ||
    replacement.account_state.ledgerIndex < precheck.ledgerIndex ||
    replacement.account_state.sequence !== precheck.sequence ||
    replacement.balance_before !== precheck.balance ||
    replacement.account_state.ledgerIndex <= Number(expired.last_ledger_sequence) ||
    (executionContractForState(expired) === V2_EXECUTION_CONTRACT && (
      !expiredCapability || !replacementCapability ||
      expiredCapability.build_revision !== 1 || replacementCapability.build_revision !== 1 ||
      replacement.build_id === expired.build_id
    ))
  ) {
    throw new RequestError(
      409,
      "REFRESH_NOT_SAFE",
      "The refreshed acquisition build does not match the validated owner precheck.",
    );
  }
}

function assertAcquisitionStateTransition(
  previous: AcquisitionState | undefined,
  next: AcquisitionState,
): void {
  if (!previous) {
    if (next.status !== "initializing") {
      throw new Error("Acquisition state must begin at initializing");
    }
    return;
  }
  if (
    previous.status === "prepared" && next.status === "prepared" &&
    executionContractForState(previous) === V2_EXECUTION_CONTRACT &&
    previous.approval_preflight_completed_at === undefined
  ) {
    const allowedNewFields = new Set([
      "approval_preflight_started_at",
      "approval_preflight_completed_at",
      "approval_preflight_ledger",
      "approval_preflight_remaining_ledgers",
      "updated_at",
    ]);
    for (const key of Object.keys(next) as Array<keyof AcquisitionState>) {
      if (allowedNewFields.has(String(key))) continue;
      if (canonicalJson(next[key]) !== canonicalJson(previous[key])) {
        throw new Error(`Acquisition preflight cannot change its bound ${String(key)}`);
      }
    }
    if (next.approval_preflight_started_at === undefined) {
      throw new Error("Acquisition preflight start is missing");
    }
    if (
      previous.approval_preflight_started_at !== undefined &&
      next.approval_preflight_started_at !== previous.approval_preflight_started_at
    ) throw new Error("Acquisition preflight start cannot change");
    const completionFields = [
      next.approval_preflight_completed_at,
      next.approval_preflight_ledger,
      next.approval_preflight_remaining_ledgers,
    ];
    const completedCount = completionFields.filter((value) => value !== undefined).length;
    if (completedCount !== 0 && completedCount !== completionFields.length) {
      throw new Error("Acquisition preflight evidence is incomplete");
    }
    if (
      previous.approval_preflight_started_at !== undefined &&
      completedCount !== completionFields.length
    ) throw new Error("Acquisition preflight retry must complete its durable evidence");
    return;
  }
  if (
    previous.status === "prepared" && next.status === "expired_unsubmitted" &&
    executionContractForState(previous) === V2_EXECUTION_CONTRACT &&
    previous.approval_preflight_started_at !== undefined
  ) {
    const allowedNewFields = new Set([
      "status",
      "approval_reconcile_completed_at",
      "approval_reconcile_execution_id",
      "approval_reconcile_validated_ledger",
      "approval_reconcile_first_inclusion_ledger",
      "approval_reconcile_last_ledger_sequence",
      "updated_at",
    ]);
    for (const key of Object.keys(next) as Array<keyof AcquisitionState>) {
      if (allowedNewFields.has(String(key))) continue;
      if (canonicalJson(next[key]) !== canonicalJson(previous[key])) {
        throw new Error(`Acquisition approval recovery cannot change its bound ${String(key)}`);
      }
    }
    if (
      next.approval_reconcile_completed_at === undefined ||
      next.approval_reconcile_execution_id === undefined ||
      next.approval_reconcile_validated_ledger === undefined ||
      next.approval_reconcile_first_inclusion_ledger === undefined ||
      next.approval_reconcile_last_ledger_sequence === undefined
    ) throw new Error("Acquisition approval recovery proof is incomplete");
    return;
  }
  if (previous.status === "expired_unsubmitted" && next.status === "built") {
    for (const key of [
      "version", "operation_id", "owner", "network", "intent_id", "created_at",
    ] as const) {
      if (canonicalJson(next[key]) !== canonicalJson(previous[key])) {
        throw new Error(`Acquisition refresh cannot change its bound ${String(key)}`);
      }
    }
    if (previous.hash !== undefined || acquisitionAttempt(next) !== acquisitionAttempt(previous) + 1) {
      throw new Error("Acquisition refresh must advance one provably unsigned attempt");
    }
    const cleanBuiltFields = new Set([
      "version", "operation_id", "owner", "network", "status", "intent_id", "created_at",
      "updated_at", "refresh_attempt", "build_id", "build_tx_json", "build_tx_digest", "quote",
      "account_state", "balance_before", "balance_before_ledger_index",
      "requested_execution_contract", "execution_capability",
    ]);
    if (Object.keys(next).some((key) => !cleanBuiltFields.has(key))) {
      throw new Error("Acquisition refresh retained stale approval or execution state");
    }
    if (Date.parse(next.updated_at) < Date.parse(previous.updated_at)) {
      throw new Error("Acquisition state time cannot move backwards");
    }
    return;
  }
  for (const key of Object.keys(previous) as Array<keyof AcquisitionState>) {
    if (key === "status" || key === "updated_at") continue;
    if (canonicalJson(next[key]) !== canonicalJson(previous[key])) {
      throw new Error(`Acquisition state cannot change its bound ${String(key)}`);
    }
  }
  const allowed: Record<PublicStatus, readonly PublicStatus[]> = {
    initializing: ["built"],
    built: ["prepared"],
    prepared: ["signed_pending", "expired_unsubmitted"],
    signed_pending: ["validated", "expired_unincluded", "failed"],
    validated: [],
    expired_unsubmitted: ["signed_pending"],
    expired_unincluded: [],
    failed: [],
  };
  if (!allowed[previous.status].includes(next.status)) {
    throw new Error(`Acquisition state transition ${previous.status} -> ${next.status} is forbidden`);
  }
  if (Date.parse(next.updated_at) < Date.parse(previous.updated_at)) {
    throw new Error("Acquisition state time cannot move backwards");
  }
}

function updated(state: AcquisitionState, next: Partial<AcquisitionState>, now: Date): AcquisitionState {
  return { ...state, ...next, updated_at: now.toISOString() };
}

async function prepareBuiltAcquisition(
  state: AcquisitionState,
  dependencies: AcquisitionHandlerDependencies,
): Promise<AcquisitionState> {
  const built = assertBuiltAcquisitionState(state);
  const prepared = await dependencies.harbor.execute(
    state.owner,
    state.operation_id,
    built,
    acquisitionAttempt(state),
  );
  const approvalReceivedAt = dependencies.now();
  const lastLedgerSequence = assertExactAcquisitionTransaction(prepared.transaction, state.owner);
  if (
    !prepared.approvalId ||
    !Number.isFinite(Date.parse(prepared.approvalExpiresAt)) ||
    Date.parse(prepared.approvalExpiresAt) <= dependencies.now().getTime()
  ) throw new RequestError(502, "INVALID_HARBOR_APPROVAL", "Harbor returned an invalid or expired owner approval.");
  if (
    executionContractForState(state) === V2_EXECUTION_CONTRACT &&
    Date.parse(prepared.approvalExpiresAt) >
      approvalReceivedAt.getTime() + RLUSD_ACQUISITION_V2_APPROVAL_TTL_SECONDS * 1_000
  ) throw new RequestError(502, "INVALID_HARBOR_APPROVAL", "Harbor returned an excessive v2 approval lifetime.");
  if (
    canonicalJson(prepared.transaction) !== canonicalJson(built.transaction) ||
    canonicalJson(rlusdAcquisitionTransactionDigest(prepared.transaction)) !==
      canonicalJson(built.transactionDigest)
  ) throw new RequestError(502, "INVALID_HARBOR_APPROVAL", "Harbor approval changed the durable validated build.");
  const next = updated(state, {
    status: "prepared",
    approval_id: prepared.approvalId,
    approval_expires_at: prepared.approvalExpiresAt,
    ...(executionContractForState(state) === V2_EXECUTION_CONTRACT
      ? { approval_received_at: approvalReceivedAt.toISOString() }
      : {}),
    tx_json: prepared.transaction,
    last_ledger_sequence: lastLedgerSequence,
  }, dependencies.now());
  await dependencies.stateStore.save(state.owner, next);
  return next;
}

async function reconcileAmbiguousApproval(
  state: AcquisitionState,
  dependencies: AcquisitionHandlerDependencies,
): Promise<AcquisitionState> {
  if (
    state.status !== "prepared" || executionContractForState(state) !== V2_EXECUTION_CONTRACT ||
    state.approval_preflight_started_at === undefined ||
    !state.approval_id || !state.execution_capability
  ) return state;
  let proof: AcquisitionApprovalReconcile;
  try {
    proof = await dependencies.harbor.approvalReconcile(
      state.approval_id,
      state.execution_capability,
    );
  } catch (error) {
    if (error instanceof HarborOperationError && error.code) {
      const status = error.code === "APPROVAL_RECOVERY_INCOMPLETE"
        ? 503
        : error.code.startsWith("APPROVAL_RECOVERY_")
          ? 409
          : 502;
      throw new RequestError(
        status,
        error.code,
        "Harbor has not produced the complete atomic non-inclusion proof required to release this approval tuple.",
      );
    }
    throw new RequestError(
      503,
      "ACQUISITION_RECOVERY_UNAVAILABLE",
      "Harbor could not reconcile the ambiguous owner approval. The exact tuple remains frozen.",
    );
  }
  const capability = state.execution_capability;
  if (
    proof.status !== "expired_nonincluded" || proof.approvalId !== state.approval_id ||
    typeof proof.executionId !== "string" || !proof.executionId.trim() || proof.executionId.length > 256 ||
    !Number.isSafeInteger(proof.validatedLedger) ||
    proof.validatedLedger <= capability.last_ledger_sequence ||
    proof.firstInclusionLedger !== capability.first_inclusion_ledger ||
    proof.lastLedgerSequence !== capability.last_ledger_sequence ||
    proof.lastLedgerSequence !== state.last_ledger_sequence ||
    proof.nextAction !== "request_fresh_build"
  ) {
    throw new RequestError(
      502,
      "INVALID_HARBOR_RECOVERY_PROOF",
      "Harbor returned recovery evidence for a different or incomplete approval window. The exact tuple remains frozen.",
    );
  }
  const next = updated(state, {
    status: "expired_unsubmitted",
    approval_reconcile_completed_at: dependencies.now().toISOString(),
    approval_reconcile_execution_id: proof.executionId,
    approval_reconcile_validated_ledger: proof.validatedLedger,
    approval_reconcile_first_inclusion_ledger: proof.firstInclusionLedger,
    approval_reconcile_last_ledger_sequence: proof.lastLedgerSequence,
  }, dependencies.now());
  await dependencies.stateStore.save(state.owner, next);
  return next;
}

async function proveValidatedCompletion(
  state: AcquisitionState,
  dependencies: AcquisitionHandlerDependencies,
  expectedLedgerIndex?: number,
): Promise<AcquisitionState> {
  if (!state.hash || !state.tx_json || state.balance_before === undefined) {
    throw new RequestError(500, "INVALID_STATE", "The signed acquisition state is incomplete.");
  }
  let proof: AcquisitionCompletionProof;
  try {
    proof = await dependencies.harbor.proveCompletion(
      state.hash,
      state.owner,
      state.tx_json,
      state.balance_before,
    );
    if (
      proof.hash.toUpperCase() !== state.hash || proof.engineResult !== "tesSUCCESS" ||
      (expectedLedgerIndex !== undefined && proof.ledgerIndex !== expectedLedgerIndex)
    ) {
      throw new Error("Completion proof identity mismatch");
    }
    assertExactRlusdBalanceDelta(state.balance_before, proof.balanceAfter, RLUSD_AMOUNT);
  } catch {
    throw new RequestError(
      502,
      "COMPLETION_NOT_PROVEN",
      "The validated transaction and exact RLUSD balance increase could not be independently proven.",
    );
  }
  const next = updated(state, {
    status: "validated",
    ledger_index: proof.ledgerIndex,
    engine_result: proof.engineResult,
    balance_after: proof.balanceAfter,
    balance_after_ledger_index: proof.balanceAfterLedgerIndex,
  }, dependencies.now());
  await dependencies.stateStore.save(state.owner, next);
  return next;
}

async function reconcile(
  state: AcquisitionState,
  dependencies: AcquisitionHandlerDependencies,
): Promise<{ state: AcquisitionState; unavailable?: true }> {
  if (state.status !== "signed_pending" || !state.hash || !state.last_ledger_sequence) return { state };
  let lookup: AcquisitionLookup;
  try {
    lookup = await dependencies.harbor.status(state.hash, state.owner);
  } catch {
    return { state, unavailable: true };
  }
  if (lookup.hash.toUpperCase() !== state.hash) {
    throw new RequestError(502, "INVALID_STATUS", "Harbor returned status for a different transaction.");
  }
  const now = dependencies.now();
  if (lookup.validated) {
    if (
      !Number.isSafeInteger(lookup.ledgerIndex) || Number(lookup.ledgerIndex) < 1 ||
      typeof lookup.engineResult !== "string" || !lookup.engineResult
    ) {
      throw new RequestError(502, "INVALID_STATUS", "Harbor returned incomplete validated transaction status.");
    }
    if (lookup.engineResult !== "tesSUCCESS") {
      const failed = updated(state, {
        status: "failed",
        hash: state.hash,
        ledger_index: lookup.ledgerIndex,
        engine_result: lookup.engineResult,
      }, now);
      await dependencies.stateStore.save(state.owner, failed);
      return { state: failed };
    }
    return { state: await proveValidatedCompletion(state, dependencies, lookup.ledgerIndex) };
  }
  let checkpoint: AcquisitionRefreshPrecheck;
  try {
    checkpoint = assertAcquisitionRefreshPrecheck(
      await dependencies.harbor.refreshPrecheck(state.owner),
    );
  } catch {
    return { state, unavailable: true };
  }
  if (
    checkpoint.ledgerIndex > state.last_ledger_sequence &&
    checkpoint.sequence === state.account_state?.sequence &&
    checkpoint.balance === state.balance_before
  ) {
    const next = updated(state, { status: "expired_unincluded" }, now);
    await dependencies.stateStore.save(state.owner, next);
    return { state: next };
  }
  return { state };
}

function configuredExecutionContract(env: Environment): ExecutionContract {
  const configured = env.P_LIVE_HARBOR_EXECUTION_V2;
  if (configured === undefined || configured === "0") return "xrpl_execution_v1";
  if (configured === "1") return V2_EXECUTION_CONTRACT;
  throw new RequestError(
    503,
    "ACQUISITION_DISABLED",
    "The local Testnet RLUSD acquisition execution contract is not recognized.",
  );
}

function requireReadyEnvironment(env: Environment): void {
  configuredExecutionContract(env);
  if (
    env.HARBOR_MOCK !== "0" || env.EXEC_NETWORK !== "testnet" ||
    env.NEXT_PUBLIC_DEV_SIGNER !== "1" || env.P_LIVE_HARBOR_FOK_DEPLOYED !== "1" ||
    env.P_LIVE_HARBOR_OWNER_APPROVAL_DEPLOYED !== "1"
  ) {
    throw new RequestError(503, "ACQUISITION_DISABLED", "The local Testnet RLUSD acquisition route is not ready.");
  }
  let profile: ReturnType<typeof resolvePilotDeploymentProfile>;
  try {
    profile = resolvePilotDeploymentProfile(env);
    resolveProfileHarborBaseUrl(env);
  } catch {
    throw new RequestError(503, "ACQUISITION_DISABLED", "The local Testnet RLUSD acquisition route is not ready.");
  }
  if (!isLocalWalletProfile(profile)) {
    throw new RequestError(503, "ACQUISITION_DISABLED", "The local Testnet RLUSD acquisition route is not ready.");
  }
  if (!env.HARBOR_API_KEY || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new RequestError(503, "ACQUISITION_DISABLED", "The local Testnet RLUSD acquisition route is not ready.");
  }
}

export function createRlusdAcquisitionHandler(
  overrides: Partial<AcquisitionHandlerDependencies> = {},
): (request: Request) => Promise<Response> {
  const env = overrides.env ?? process.env;
  let defaultHarbor: HarborAcquisitionActions | undefined;
  const dependencies: AcquisitionHandlerDependencies = {
    env,
    get harbor() {
      return overrides.harbor ?? (defaultHarbor ??= createDefaultHarborActions(env, dependencies.now));
    },
    now: overrides.now ?? (() => new Date()),
    randomUUID: overrides.randomUUID ?? randomUUID,
    recordTiming: overrides.recordTiming ?? ((event) => {
      console.info("rlusd_acquisition_timing", JSON.stringify(event));
    }),
    readSession: overrides.readSession ?? readWalletSession,
    stateStore: overrides.stateStore ?? new FileAcquisitionStateStore(
      env.P_LIVE_RLUSD_ACQUISITION_STATE_DIR,
      env.SESSION_SECRET,
      {
        deploymentProfile: env.PILOT_DEPLOYMENT_PROFILE === PILOT_ISOLATED_DEPLOYMENT_PROFILE
          ? PILOT_ISOLATED_DEPLOYMENT_PROFILE
          : undefined,
      },
    ),
  };

  return async function POST(request: Request): Promise<Response> {
    try {
      let expectedOrigin: string;
      try {
        expectedOrigin = resolvePilotRequestAuthority(dependencies.env, request).origin;
      } catch {
        throw new RequestError(403, "LOOPBACK_REQUIRED", "RLUSD acquisition is available only from loopback.");
      }
      if (!isSameOrigin(request, expectedOrigin)) {
        throw new RequestError(403, "SAME_ORIGIN_REQUIRED", "Same-origin RLUSD acquisition access is required.");
      }
      requireReadyEnvironment(dependencies.env);
      let session: WalletSession | null;
      try {
        session = dependencies.readSession(request);
      } catch {
        session = null;
      }
      if (!session || session.network !== "testnet") {
        throw new RequestError(401, "WALLET_SESSION_REQUIRED", "A sealed Testnet wallet session is required.");
      }
      await dependencies.stateStore.assertReady().catch(() => {
        throw new RequestError(503, "STATE_STORE_NOT_READY", "The configured local acquisition state directory is unavailable.");
      });
      const action = assertBody(await parseBody(request));
      return await dependencies.stateStore.withOwnerLock(session.account, async () => {
        let state = await dependencies.stateStore.load(session.account);
        if (action.action === "initialize" || action.action === "prepare") {
          if (state && state.status !== "initializing" && state.status !== "built") {
            if (
              state.status === "prepared" &&
              state.approval_preflight_started_at === undefined &&
              approvalDeadlineMs(state) <= dependencies.now().getTime()
            ) {
              state = updated(state, { status: "expired_unsubmitted" }, dependencies.now());
              await dependencies.stateStore.save(session.account, state);
            }
            return response(terminal(state) ? 409 : 200, publicState(state));
          }
          if (!state) {
            const operationId = dependencies.randomUUID();
            if (!isUuid(operationId)) throw new Error("Invalid server operation identity");
            const now = dependencies.now();
            state = {
              version: 1,
              operation_id: operationId,
              owner: session.account,
              network: "testnet",
              status: "initializing",
              intent_id: `p-live-acquire-rlusd-${operationId}`,
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
              refresh_attempt: 0,
              ...(configuredExecutionContract(dependencies.env) === V2_EXECUTION_CONTRACT
                ? { requested_execution_contract: V2_EXECUTION_CONTRACT }
                : {}),
            };
            // Persist the durable idempotency identity before any Harbor work.
            await dependencies.stateStore.save(session.account, state);
          }
          if (action.action === "initialize") {
            return response(200, publicState(state));
          }
          if (state.status === "initializing") {
            const built = await requestAcquisitionBuild(
              session.account,
              state.operation_id,
              executionContractForState(state),
              dependencies,
            );
            const builtState = builtStateForAttempt(
              state,
              built,
              acquisitionAttempt(state),
              dependencies.now(),
            );
            // The exact build and its ledger bindings must be durable before tx.execute.
            assertBuiltAcquisitionState(builtState);
            await dependencies.stateStore.save(session.account, builtState);
            state = builtState;
          }
          state = await prepareBuiltAcquisition(state, dependencies);
          return response(200, publicState(state));
        }

        if (!state || state.operation_id !== action.operationId) {
          throw new RequestError(404, "OPERATION_NOT_FOUND", "No RLUSD acquisition operation matches this wallet session.");
        }

        if (action.action === "preflight") {
          if (
            state.status !== "prepared" || !state.tx_json || !state.build_id ||
            approvalBinding(state) !== action.approvalBinding
          ) {
            throw new RequestError(
              409,
              "STALE_ACQUISITION_APPROVAL",
              "The displayed RLUSD acquisition is no longer the current reviewed build. Review the current transaction before signing.",
            );
          }
          if (approvalDeadlineMs(state) <= dependencies.now().getTime()) {
            if (state.approval_preflight_started_at !== undefined) {
              throw new RequestError(
                409,
                "ACQUISITION_PREFLIGHT_OUTCOME_UNKNOWN",
                "The approval deadline passed after preflight dispatch. Pilot must keep this unsigned attempt frozen until Harbor proves its terminal outcome.",
              );
            }
            throw new RequestError(
              409,
              "ACQUISITION_APPROVAL_EXPIRED",
              "The RLUSD acquisition approval expired before signing. Refresh and review a new transaction.",
            );
          }
          let checkpoint: AcquisitionRefreshPrecheck;
          try {
            checkpoint = assertAcquisitionRefreshPrecheck(
              await dependencies.harbor.refreshPrecheck(session.account),
            );
          } catch {
            throw new RequestError(
              503,
              "ACQUISITION_PREFLIGHT_UNAVAILABLE",
              "A validated ledger freshness check is required immediately before signing.",
            );
          }
          if (
            checkpoint.ledgerIndex < Number(state.account_state?.ledgerIndex) ||
            checkpoint.ledgerIndex < Number(state.balance_before_ledger_index)
          ) {
            throw new RequestError(
              503,
              "ACQUISITION_PREFLIGHT_STALE",
              "The validated ledger freshness check predates the reviewed acquisition build.",
            );
          }
          if (
            checkpoint.sequence !== state.account_state?.sequence ||
            checkpoint.balance !== state.balance_before
          ) {
            throw new RequestError(
              409,
              "ACQUISITION_ACCOUNT_CHANGED",
              "The owner sequence or official RLUSD balance changed. Refresh and review a new transaction.",
            );
          }
          const remainingLedgers = Number(state.last_ledger_sequence) - checkpoint.ledgerIndex;
          recordAcquisitionTiming(dependencies, state, "preflight_snapshot_completed", {
            ledgerIndex: checkpoint.ledgerIndex,
            remainingLedgers,
          });
          if (remainingLedgers < minimumSigningRemainingLedgers(state)) {
            throw new RequestError(
              409,
              "ACQUISITION_SIGNING_WINDOW_TOO_SHORT",
              "The validated ledger window is shorter than the reviewed execution contract permits. Keep this attempt unsigned, then refresh and review a new transaction.",
            );
          }
          if (executionContractForState(state) === V2_EXECUTION_CONTRACT) {
            if (!state.execution_capability || !state.approval_id) {
              throw new RequestError(
                502,
                "INVALID_HARBOR_APPROVAL",
                "The v2 owner approval is missing its immutable execution capability.",
              );
            }
            const approvalId = state.approval_id;
            const executionCapability = state.execution_capability;
            if (state.approval_preflight_completed_at !== undefined) {
              throw new RequestError(
                409,
                "STALE_ACQUISITION_APPROVAL",
                "This owner approval has already entered signing preflight and cannot be refreshed or preflighted again.",
              );
            }
            if (state.approval_preflight_started_at !== undefined) {
              throw new RequestError(
                409,
                "ACQUISITION_PREFLIGHT_OUTCOME_UNKNOWN",
                "This approval already crossed Pilot's durable preflight dispatch boundary. It remains frozen until Harbor returns an atomic terminal recovery proof.",
              );
            }
            state = updated(state, {
              approval_preflight_started_at: dependencies.now().toISOString(),
            }, dependencies.now());
            await dependencies.stateStore.save(session.account, state);
            let harborPreflight: AcquisitionApprovalPreflight;
            try {
              harborPreflight = await dependencies.harbor.approvalPreflight(
                approvalId,
                executionCapability,
              );
            } catch (error) {
              if (error instanceof HarborOperationError && error.code) {
                throw new RequestError(
                  error.code === "APPROVAL_ALREADY_PREFLIGHTED" ? 409 : 502,
                  error.code,
                  error.code === "APPROVAL_ALREADY_PREFLIGHTED"
                    ? "Harbor reports that this approval already crossed its one-time preflight boundary. Pilot will not refresh or sign it because the first response may have been lost."
                    : "Harbor rejected this exact approval with a typed error. Pilot will not refresh or sign it because the response does not prove that no earlier authorization occurred.",
                );
              }
              throw new RequestError(
                503,
                "ACQUISITION_PREFLIGHT_UNAVAILABLE",
                "Harbor could not durably authorize this exact v2 approval for signing.",
              );
            }
            if (
              harborPreflight.approvalId !== approvalId ||
              harborPreflight.expiresAt !== state.approval_expires_at ||
              harborPreflight.validatedLedger < checkpoint.ledgerIndex ||
              harborPreflight.validatedLedger < Number(state.account_state?.ledgerIndex) ||
              harborPreflight.remainingLedgers !==
                Number(state.last_ledger_sequence) - harborPreflight.validatedLedger ||
              harborPreflight.remainingLedgers < RLUSD_ACQUISITION_V2_MIN_REMAINING_LEDGERS ||
              canonicalJson(harborPreflight.executionCapability) !==
                canonicalJson(executionCapability)
            ) {
              throw new RequestError(
                502,
                "INVALID_HARBOR_APPROVAL",
                "Harbor returned preflight evidence for a different or unsafe v2 approval snapshot.",
              );
            }
            state = updated(state, {
              approval_preflight_completed_at: dependencies.now().toISOString(),
              approval_preflight_ledger: harborPreflight.validatedLedger,
              approval_preflight_remaining_ledgers: harborPreflight.remainingLedgers,
            }, dependencies.now());
            await dependencies.stateStore.save(session.account, state);
          }
          return response(200, publicState(state));
        }

        if (action.action === "refresh") {
          if (
            executionContractForState(state) === V2_EXECUTION_CONTRACT &&
            state.approval_preflight_started_at !== undefined &&
            state.approval_reconcile_completed_at === undefined
          ) {
            return response(409, publicState(state));
          }
          let refreshPrecheck: AcquisitionRefreshPrecheck | undefined;
          if (state.status === "prepared") {
            if (approvalDeadlineMs(state) > dependencies.now().getTime()) {
              refreshPrecheck = assertAcquisitionRefreshPrecheck(
                await dependencies.harbor.refreshPrecheck(session.account),
              );
              if (refreshPrecheck.ledgerIndex <= Number(state.last_ledger_sequence)) {
                return response(acquisitionAttempt(state) > 0 ? 200 : 409, publicState(state));
              }
            }
            state = updated(state, { status: "expired_unsubmitted" }, dependencies.now());
            await dependencies.stateStore.save(session.account, state);
          }
          if (state.status === "expired_unsubmitted") {
            const expired = state;
            const attempt = acquisitionAttempt(state) + 1;
            const precheck = refreshPrecheck ?? assertAcquisitionRefreshPrecheck(
              await dependencies.harbor.refreshPrecheck(session.account),
            );
            assertSafeUnsignedRefreshPrecheck(expired, precheck);
            const built = await requestAcquisitionBuild(
              session.account,
              state.operation_id,
              executionContractForState(state),
              dependencies,
            );
            const builtState = builtStateForAttempt(state, built, attempt, dependencies.now());
            assertBuiltAcquisitionState(builtState);
            assertReplacementMatchesPrecheck(expired, precheck, builtState);
            await dependencies.stateStore.save(session.account, builtState);
            state = builtState;
          } else if (!(state.status === "built" && acquisitionAttempt(state) > 0)) {
            return response(409, publicState(state));
          }
          state = await prepareBuiltAcquisition(state, dependencies);
          return response(200, publicState(state));
        }

        if (action.action === "status") {
          if (
            state.status === "prepared" &&
            state.approval_preflight_started_at !== undefined &&
            state.approval_reconcile_completed_at === undefined
          ) {
            state = await reconcileAmbiguousApproval(state, dependencies);
          } else if (
            state.status === "prepared" &&
            state.approval_preflight_started_at === undefined &&
            approvalDeadlineMs(state) <= dependencies.now().getTime()
          ) {
            state = updated(state, { status: "expired_unsubmitted" }, dependencies.now());
            await dependencies.stateStore.save(session.account, state);
          } else if (state.status === "prepared" && state.approval_preflight_started_at === undefined) {
            const precheck = assertAcquisitionRefreshPrecheck(
              await dependencies.harbor.refreshPrecheck(session.account),
            );
            if (precheck.ledgerIndex > Number(state.last_ledger_sequence)) {
              state = updated(state, { status: "expired_unsubmitted" }, dependencies.now());
              await dependencies.stateStore.save(session.account, state);
            }
          } else if (state.status === "signed_pending") {
            state = (await reconcile(state, dependencies)).state;
          }
          return response(200, publicState(state));
        }

        if (state.status === "signed_pending") {
          const result = await reconcile(state, dependencies);
          return response(result.state.status === "signed_pending" ? 202 : 200, publicState(result.state));
        }
        if (state.status === "expired_unsubmitted") {
          if (state.approval_reconcile_completed_at !== undefined) {
            throw new RequestError(
              409,
              "ACQUISITION_APPROVAL_RECOVERED",
              "Harbor atomically burned this expired approval tuple after proving non-inclusion. A fresh reviewed build is required.",
            );
          }
          if (!state.tx_json) {
            throw new RequestError(500, "INVALID_STATE", "The expired acquisition state is incomplete.");
          }
          if (
            executionContractForState(state) === V2_EXECUTION_CONTRACT &&
            state.approval_preflight_completed_at === undefined
          ) {
            throw new RequestError(
              409,
              "ACQUISITION_PREFLIGHT_REQUIRED",
              "The v2 approval was not durably preflighted before signing.",
            );
          }
          const signed = verifiedSignedBlobTransaction(action.txBlob);
          if (!signed || signed.Account !== session.account || !transactionMatches(signed, state.tx_json)) {
            throw new RequestError(400, "SIGNED_TRANSACTION_MISMATCH", "The signed blob does not match the exact expired acquisition transaction.");
          }
          state = updated(state, {
            status: "signed_pending",
            hash: hashes.hashSignedTx(action.txBlob).toUpperCase(),
          }, dependencies.now());
          // Signature evidence permanently closes refresh even though Pilot
          // refuses to relay an approval or ledger envelope that already expired.
          await dependencies.stateStore.save(session.account, state);
          return response(202, publicState(state));
        }
        if (terminal(state)) return response(409, publicState(state));
        if (state.status !== "prepared" || !state.tx_json || !state.approval_id) {
          throw new RequestError(409, "OPERATION_NOT_READY", "The RLUSD acquisition operation is not ready for signing.");
        }
        if (
          executionContractForState(state) === V2_EXECUTION_CONTRACT &&
          state.approval_preflight_completed_at === undefined
        ) {
          throw new RequestError(
            409,
            "ACQUISITION_PREFLIGHT_REQUIRED",
            "The v2 approval was not durably preflighted before signing.",
          );
        }
        const signed = verifiedSignedBlobTransaction(action.txBlob);
        if (!signed || signed.Account !== session.account || !transactionMatches(signed, state.tx_json)) {
          throw new RequestError(400, "SIGNED_TRANSACTION_MISMATCH", "The signed blob does not match the exact approved acquisition transaction.");
        }
        const hash = hashes.hashSignedTx(action.txBlob).toUpperCase();
        const approvalId = state.approval_id;
        state = updated(state, { status: "signed_pending", hash }, dependencies.now());
        // This durable write is the point of no return. No code path relays before it,
        // and every later request recovers by the public hash without the signed blob.
        await dependencies.stateStore.save(session.account, state);
        if (approvalDeadlineMs(state) <= dependencies.now().getTime()) {
          return response(202, publicState(state));
        }
        const submissionPrecheck = assertAcquisitionRefreshPrecheck(
          await dependencies.harbor.refreshPrecheck(session.account),
        );
        const submissionRemainingLedgers =
          Number(state.last_ledger_sequence) - submissionPrecheck.ledgerIndex;
        recordAcquisitionTiming(dependencies, state, "post_sign_proof_completed", {
          ledgerIndex: submissionPrecheck.ledgerIndex,
          remainingLedgers: submissionRemainingLedgers,
        });
        if (
          (executionContractForState(state) === V2_EXECUTION_CONTRACT
            ? submissionRemainingLedgers < RLUSD_ACQUISITION_V2_MIN_REMAINING_LEDGERS
            : submissionPrecheck.ledgerIndex >= Number(state.last_ledger_sequence)) ||
          submissionPrecheck.ledgerIndex < Number(state.account_state?.ledgerIndex) ||
          submissionPrecheck.ledgerIndex < Number(state.balance_before_ledger_index) ||
          (executionContractForState(state) === V2_EXECUTION_CONTRACT &&
            submissionPrecheck.ledgerIndex < Number(state.approval_preflight_ledger)) ||
          submissionPrecheck.sequence !== state.account_state?.sequence ||
          submissionPrecheck.balance !== state.balance_before
        ) {
          return response(202, publicState(state));
        }
        let relay: AcquisitionRelayResult;
        recordAcquisitionTiming(dependencies, state, "harbor_submit_started");
        try {
          relay = await dependencies.harbor.relay(
            action.txBlob,
            approvalId,
            state.execution_capability,
          );
        } catch {
          return response(202, publicState(state));
        }
        recordAcquisitionTiming(dependencies, state, "harbor_submit_responded", {
          ...("failed" in relay ? {} : { ledgerIndex: relay.ledgerIndex }),
          engineResult: relay.engineResult,
        });
        if ("failed" in relay) {
          state = updated(state, { status: "failed", engine_result: relay.engineResult }, dependencies.now());
          await dependencies.stateStore.save(session.account, state);
          return response(422, publicState(state));
        }
        if (relay.hash.toUpperCase() !== hash) {
          throw new RequestError(502, "INVALID_RELAY", "Harbor returned a mismatched transaction hash.");
        }
        if (relay.engineResult !== "tesSUCCESS") {
          state = updated(state, {
            status: "failed",
            hash,
            ledger_index: relay.ledgerIndex,
            engine_result: relay.engineResult,
          }, dependencies.now());
          await dependencies.stateStore.save(session.account, state);
          return response(422, publicState(state));
        }
        try {
          state = await proveValidatedCompletion(state, dependencies, relay.ledgerIndex);
        } catch (error) {
          if (error instanceof RequestError && error.code === "COMPLETION_NOT_PROVEN") {
            return response(202, publicState(state));
          }
          throw error;
        }
        return response(200, publicState(state));
      });
    } catch (error) {
      if (error instanceof RequestError) return errorResponse(error);
      return response(500, {
        error: {
          code: "ACQUISITION_UNAVAILABLE",
          message: "The RLUSD acquisition request could not be completed safely.",
        },
      });
    }
  };
}

export const RLUSD_ACQUISITION = Object.freeze({
  issuer: RLUSD_ISSUER,
  currency: RLUSD_CURRENCY,
  amount: RLUSD_AMOUNT,
  capDrops: XRP_CAP_DROPS.toString(),
  fillOrKillFlag: FILL_OR_KILL_FLAG,
  minimumSigningRemainingLedgers: MIN_SIGNING_REMAINING_LEDGERS,
});
