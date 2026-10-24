import { deriveAddress, isValidClassicAddress, verifySignature } from "xrpl";
import { z } from "zod";

import { requestXrpl, XrplRpcError } from "../adapters/xrpl-rpc";
import type { OpContext, OpDef } from "../catalog/registry";
import {
  DEFAULT_POLICY,
  ExecutionCapabilitySchema,
  ExecResultSchema,
  SignerSchema,
  type ExecutionCapability,
  type ExecutionContract,
  type ExecResult,
  type Network,
  type Policy,
  type PolicyResult,
  type Signer,
  type TxBuild,
} from "../contracts";
import { readKmsMode, type KmsEnv } from "../aws/kms";
import {
  RLUSD_HEX_CURRENCY,
  TESTNET_RLUSD_ISSUER,
  autofillUnsignedTransaction,
  canonicalizeJson,
  revalidateStoredBuild,
  validatePreparedTransaction,
  v2CanonicalBindings,
} from "../exec/build";
import {
  evaluate,
  gatherPolicyContext,
  type PolicyFactsAdapter,
} from "../exec/policy";
import {
  collectIssuedPolicyAssets,
  configuredStablePolicyAsset,
} from "../exec/transaction/facts";
import {
  Store,
  type AcquisitionBalanceInvariant,
  type ApprovalRow,
  type BuildRevisionRow,
  type BuildRow,
  type ExecutionRow,
  type ExecutionSnapshotInsert,
  type ExecutionSnapshotRow,
  type LinkRow,
} from "../exec/store";
import {
  DelegatedSigningError,
  signDelegatedTransaction,
} from "../exec/sign";
import { isHarborDelegableTransactionType } from "../exec/delegation";
import {
  SubmitValidationError,
  submitApprovedBlob,
  submitSignedBlob,
  decodeSignedBlob,
  signedTransactionHash,
  validateApprovedBlob,
  type SubmitDependencies,
  type SubmitResult,
} from "../exec/submit";
import {
  ApprovalExpiredError,
  ExecutionLifetimeError,
  type ExecutionLifetimeErrorCode,
} from "../executor/errors";
import {
  assertLocalTradingTestnet,
  isReviewedLocalTradingContext,
  LOCAL_TRADING_BUILD_ORIGIN,
  localTradingMarkersPresent,
  localTradingSafetyMarkersPresent,
} from "../local-trading";
import {
  isReviewedLocalTradingIsolatedV1Context,
  LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN,
  localTradingIsolatedV1MarkersPresent,
} from "../local-trading-isolated-v1";
import {
  isReviewedLocalTradingIsolatedOnboardingV1Context,
  LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
  localTradingIsolatedOnboardingV1MarkersPresent,
} from "../local-trading-isolated-onboarding-v1";
import { projectExecutionConfirmation } from "../quicknode/webhook";
import {
  AccountSequenceLeaseAuthority,
  accountSequenceIdentity,
  type AccountSequenceLeaseRow,
} from "../exec/account-sequence-lease";
import {
  LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
  isReviewedLocalTradingOnboardingContext,
  localTradingOnboardingMarkersPresent,
} from "../local-trading-onboarding";

const ExecutionNetworkSchema = z.enum(["testnet", "devnet"]);
const HashSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const BlobSchema = z.string().regex(/^[A-Fa-f0-9]+$/).min(2);
const SAFE_ENGINE_RESULT = /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/;
const AccountSchema = z
  .string()
  .refine(isValidClassicAddress, "must be a valid XRPL classic address");
const IdempotencyKeySchema = z.string().trim().min(1).max(200);
const ExecutionContractSchema = z.enum([
  "xrpl_execution_v1",
  "xrpl_execution_v2",
]);
const UpperHashSchema = z.string().regex(/^[A-F0-9]{64}$/);
const REQUIRE_AUTH_FLAG = 0x0004_0000;
const APPROVAL_TTL_MS = 10 * 60 * 1_000;
const V2_APPROVAL_TTL_MS = 90 * 1_000;
const V2_MINIMUM_REMAINING_LEDGERS = 8;
const APPROVAL_RECOVERY_ACCOUNT_TX_LIMIT = 200;
const APPROVAL_RECOVERY_MAX_PAGES = 100;
const ApprovalRecoveryMarkerSchema = z.union([
  z.string().min(1),
  z.number().int().nonnegative(),
  z.record(z.string(), z.unknown()),
]);
const STALE_PENDING_MS = 10 * 60 * 1_000;
const OFFER_TF_FILL_OR_KILL = 0x0004_0000;
const OFFER_TF_SELL = 0x0008_0000;
// Harbor autofills LastLedgerSequence at validated ledger + 4. The build
// ledger is already closed, so the first possible inclusion ledger is the
// following ledger (LastLedgerSequence - 3).
const RELIABLE_SUBMISSION_LEDGER_WINDOW = 4;
const DIRECT_OWNER_MAX_LEDGER_WINDOW = 50;
const LSF_DISABLE_MASTER = 0x0010_0000;
const ExecutionClaimModeSchema = z.enum([
  "policy",
  "require_owner_approval",
]);
type ExecutionClaimMode = z.infer<typeof ExecutionClaimModeSchema>;

const PREFLIGHT_REJECTION_CODES = new Set<ExecutionLifetimeErrorCode>([
  "EXECUTION_SNAPSHOT_STALE",
  "EXECUTION_SNAPSHOT_INVALID",
  "TRANSACTION_WINDOW_TOO_SHORT",
  "FEE_LOAD_UNSAFE",
  "ACCOUNT_SEQUENCE_CHANGED",
  "BALANCE_INVARIANT_CHANGED",
]);
type PreflightRejectionCode =
  | "EXECUTION_SNAPSHOT_STALE"
  | "EXECUTION_SNAPSHOT_INVALID"
  | "TRANSACTION_WINDOW_TOO_SHORT"
  | "FEE_LOAD_UNSAFE"
  | "ACCOUNT_SEQUENCE_CHANGED"
  | "BALANCE_INVARIANT_CHANGED";

export const TxExecuteArgsSchema = z
  .object({
    build_id: z.string().trim().min(1),
    idempotency_key: IdempotencyKeySchema,
    require_owner_approval: z.literal(true).optional(),
    execution_contract: ExecutionContractSchema.optional(),
    build_revision: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, issueContext) => {
    if (value.execution_contract === "xrpl_execution_v2") {
      if (value.build_revision === undefined) {
        issueContext.addIssue({
          code: "custom",
          path: ["build_revision"],
          message: "build_revision is required for xrpl_execution_v2",
        });
      }
      return;
    }
    if (value.build_revision !== undefined) {
      issueContext.addIssue({
        code: "custom",
        path: ["build_revision"],
        message: "build_revision is accepted only for xrpl_execution_v2",
      });
    }
  });

export const TxSubmitArgsSchema = z
  .object({
    tx_blob: BlobSchema,
    approval_id: z.string().trim().min(1).optional(),
    network: ExecutionNetworkSchema.optional(),
    execution_contract: ExecutionContractSchema.optional(),
    build_revision: z.number().int().positive().optional(),
    unsigned_tx_digest: UpperHashSchema.optional(),
    economic_fingerprint: UpperHashSchema.optional(),
  })
  .strict()
  .superRefine((value, issueContext) => {
    const { approval_id, network } = value;
    if (approval_id === undefined && network === undefined) {
      issueContext.addIssue({
        code: "custom",
        message: "network is required for a direct owner submission",
      });
    }
    const v2Fields = [
      value.build_revision,
      value.unsigned_tx_digest,
      value.economic_fingerprint,
    ];
    if (value.execution_contract === "xrpl_execution_v2") {
      if (approval_id === undefined) {
        issueContext.addIssue({
          code: "custom",
          path: ["approval_id"],
          message: "approval_id is required for xrpl_execution_v2",
        });
      }
      v2Fields.forEach((field, index) => {
        if (field === undefined) {
          issueContext.addIssue({
            code: "custom",
            path: [
              ["build_revision", "unsigned_tx_digest", "economic_fingerprint"][
                index
              ],
            ],
            message: "complete v2 canonical binding is required",
          });
        }
      });
    } else if (v2Fields.some((field) => field !== undefined)) {
      issueContext.addIssue({
        code: "custom",
        message: "v2 canonical binding fields require xrpl_execution_v2",
      });
    }
  });

export const TxApprovalPreflightArgsSchema = z
  .object({
    approval_id: z.string().trim().min(1),
    execution_contract: z.literal("xrpl_execution_v2"),
    build_revision: z.number().int().positive(),
    unsigned_tx_digest: UpperHashSchema,
    economic_fingerprint: UpperHashSchema,
  })
  .strict();

export const TxApprovalReconcileArgsSchema = z
  .object({
    approval_id: z.string().trim().min(1),
    execution_contract: z.literal("xrpl_execution_v2"),
    build_revision: z.number().int().positive(),
    unsigned_tx_digest: UpperHashSchema,
    economic_fingerprint: UpperHashSchema,
  })
  .strict();

export const TxStatusArgsSchema = z
  .object({
    hash: HashSchema,
    network: ExecutionNetworkSchema.optional(),
    account: AccountSchema.optional(),
  })
  .strict()
  .superRefine(({ account, network }, issueContext) => {
    if ((account === undefined) !== (network === undefined)) {
      issueContext.addIssue({
        code: "custom",
        message: "account and network must be provided together",
      });
    }
  });

export type TxExecuteArgs = z.infer<typeof TxExecuteArgsSchema>;
export type TxSubmitArgs = z.infer<typeof TxSubmitArgsSchema>;
export type TxApprovalPreflightArgs = z.infer<
  typeof TxApprovalPreflightArgsSchema
>;
export type TxApprovalReconcileArgs = z.infer<
  typeof TxApprovalReconcileArgsSchema
>;
export type TxStatusArgs = z.infer<typeof TxStatusArgsSchema>;

export interface SignedDelegateBlob {
  tx_blob: string;
  hash: string;
}

export interface ValidatedSubmission {
  hash: string;
  ledger_index: number;
  engine_result: string;
  validated: true;
  tx_json?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

const OwnerExecutedResultSchema = z
  .object({
    status: z.literal("executed"),
    hash: HashSchema,
    ledger_index: z.number().int().positive(),
    result: z.literal("success"),
    signed_by: z.literal("owner"),
  })
  .strict();

type OwnerExecutedResult = z.infer<typeof OwnerExecutedResultSchema>;
type FailedExecutionResult = Extract<ExecResult, { status: "failed" }>;
type ReplayExecutionResult = ExecResult | OwnerExecutedResult;
type ApprovalSubmissionResult = ValidatedSubmission | FailedExecutionResult;

export interface TransactionStatus {
  hash: string;
  network: "testnet" | "devnet";
  validated: boolean;
  ledger_index?: number;
  engine_result?: string;
}

export interface ExecutionSignerInput {
  ctx: OpContext;
  build: TxBuild;
  link: LinkRow;
  executionContract?: ExecutionContract;
}

export interface SubmissionInput {
  ctx: OpContext;
  network: "testnet" | "devnet";
  txBlob: string;
  executionContract?: ExecutionContract;
}

export interface ApprovalSubmissionInput extends SubmissionInput {
  approval: ApprovalRow;
}

export interface ExecutionServices {
  store?: Store;
  facts?: PolicyFactsAdapter;
  signDelegate?: (input: ExecutionSignerInput) => Promise<SignedDelegateBlob>;
  submitSigned?: (input: SubmissionInput) => Promise<ValidatedSubmission>;
  submitApproval?: (
    input: ApprovalSubmissionInput,
  ) => Promise<ValidatedSubmission>;
  status?: (
    ctx: OpContext,
    network: "testnet" | "devnet",
    hash: string,
  ) => Promise<TransactionStatus>;
  reserveDailyBudget?: (
    input: DailyBudgetReservation,
  ) => Promise<
    | "reserved"
    | "duplicate"
    | "over-cap"
    | "link-inactive"
    | "link-frozen"
    | "busy"
  >;
  now?: () => Date;
  randomUUID?: () => string;
}

type ExecutionContext = OpContext & {
  db?: D1Database;
  env?: Record<string, unknown> & { DB?: D1Database; EXEC_NETWORK?: string };
  executionServices?: ExecutionServices;
  signingServices?: { withDelegateSigner?: unknown; kmsClient?: unknown };
};

export interface DailyBudgetReservation {
  db: D1Database;
  principal: string;
  executionId: string;
  build: BuildRow;
  idempotencyKey: string;
  usdValue: number;
  dailyCapUsd: number;
  createdAt: string;
  snapshot?: ExecutionSnapshotInsert;
}

function executionContext(ctx: OpContext): ExecutionContext {
  return ctx as ExecutionContext;
}

function configuredServices(ctx: OpContext): ExecutionServices {
  const injected = executionContext(ctx).executionServices ?? {};
  return {
    signDelegate: async ({ ctx: signingContext, build, executionContract }) =>
      signDelegatedTransaction(signingContext, {
        network: build.network,
        owner: build.summary.account,
        txJson: build.tx_json,
        executionContract,
      }),
    submitSigned: async ({
      ctx: submitContext,
      network,
      txBlob,
      executionContract,
    }) =>
      requireValidatedSubmission(
        await submitSignedBlob(
          { network, tx_blob: txBlob, executionContract },
          submitDependencies(submitContext),
        ),
      ),
    submitApproval: async ({
      ctx: submitContext,
      network,
      txBlob,
      approval,
      executionContract,
    }) =>
      requireValidatedSubmission(
        await submitApprovedBlob(
          {
            network,
            tx_blob: txBlob,
            approval:
              executionContract === "xrpl_execution_v2"
                ? { ...approval, status: "pending" as const }
                : approval,
            now: injected.now?.(),
            executionContract,
          },
          submitDependencies(submitContext),
        ),
      ),
    status: readTransactionStatus,
    ...injected,
  };
}

function submitDependencies(ctx: OpContext): SubmitDependencies {
  return {
    rpc: {
      request: (network, command, params, options) =>
        requestXrpl(ctx, network, command, params, options),
    },
  };
}

function requireValidatedSubmission(result: SubmitResult): ValidatedSubmission {
  if (result.status === "failed") {
    throw new SubmissionOutcomeError(
      result.engine_result,
      result.hash,
      isDefinitiveSubmissionFailure(result.engine_result),
    );
  }
  if (result.engine_result !== "tesSUCCESS") {
    throw new SubmissionOutcomeError(
      result.engine_result,
      result.hash,
      true,
    );
  }
  return {
    hash: result.hash,
    ledger_index: result.ledger_index,
    engine_result: result.engine_result,
    validated: true,
  };
}

class SubmissionOutcomeError extends Error {
  constructor(
    readonly engineResult: string,
    readonly hash: string,
    readonly definitive: boolean,
  ) {
    super("Transaction submission did not produce a successful validation");
    this.name = "SubmissionOutcomeError";
  }
}

function isDefinitiveSubmissionFailure(engineResult: string): boolean {
  return (
    engineResult === "tefMAX_LEDGER" ||
    engineResult.startsWith("tel") ||
    engineResult.startsWith("tem") ||
    engineResult.startsWith("tec")
  );
}

async function readTransactionStatus(
  ctx: OpContext,
  network: "testnet" | "devnet",
  hash: string,
): Promise<TransactionStatus> {
  let response: Record<string, unknown>;
  try {
    // The tx method and validated response field are documented at:
    // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/tx
    response = await requestXrpl(ctx, network, "tx", {
      transaction: hash,
      binary: false,
    });
  } catch (error) {
    if (error instanceof XrplRpcError && error.kind === "soft-empty") {
      return { hash, network, validated: false };
    }
    throw error;
  }
  const metadata = isRecord(response.meta) ? response.meta : undefined;
  const engineResult = metadata?.TransactionResult;
  const ledgerIndex = response.ledger_index;
  if (
    typeof response.hash !== "string" ||
    response.hash.toUpperCase() !== hash.toUpperCase()
  ) {
    throw new Error("XRPL transaction status returned a mismatched hash");
  }
  if (response.validated === false) {
    return { hash, network, validated: false };
  }
  if (
    response.validated !== true ||
    !Number.isSafeInteger(ledgerIndex) ||
    (ledgerIndex as number) < 1 ||
    typeof engineResult !== "string"
  ) {
    throw new Error("XRPL transaction status response is malformed");
  }
  return {
    hash,
    network,
    validated: true,
    ledger_index: ledgerIndex as number,
    engine_result: engineResult,
  };
}

async function latestValidatedLedger(
  ctx: OpContext,
  network: "testnet" | "devnet",
): Promise<number> {
  // Reliable submission resolves absence only after LastLedgerSequence:
  // https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission
  const response = await requestXrpl(ctx, network, "ledger", {
    ledger_index: "validated",
    transactions: false,
    expand: false,
  });
  const nested = isRecord(response.ledger) ? response.ledger : undefined;
  const candidate = response.ledger_index ?? nested?.ledger_index ?? nested?.seqNum;
  const parsed =
    typeof candidate === "string" && /^[1-9][0-9]*$/.test(candidate)
      ? Number(candidate)
      : candidate;
  if (
    response.validated !== true ||
    !Number.isSafeInteger(parsed) ||
    (parsed as number) < 1
  ) {
    throw new Error("validated ledger response is malformed");
  }
  return parsed as number;
}

type FinalTransactionStatus = TransactionStatus & {
  validated: true;
  ledger_index: number;
  engine_result: string;
};

type ExpiredTransactionProof =
  | { state: "included"; status: FinalTransactionStatus }
  | { state: "absent"; validatedHead: number; checkedFrom: number;
      checkedThrough: number; searchedAll: true }
  | { state: "pending" };

function persistedLedgerWindow(
  source: BuildRow | ExecutionSnapshotRow,
): { firstLedger: number; lastLedger: number } | null {
  if ("snapshotOwner" in source) {
    if (
      source.executionContract !== "xrpl_execution_v2" ||
      !Number.isSafeInteger(source.firstInclusionLedger) ||
      !Number.isSafeInteger(source.lastLedgerSequence) ||
      source.firstInclusionLedger < 1 ||
      source.lastLedgerSequence !== source.firstInclusionLedger + 63
    ) {
      return null;
    }
    return {
      firstLedger: source.firstInclusionLedger,
      lastLedger: source.lastLedgerSequence,
    };
  }
  const persistedLastLedger = source.txJson.LastLedgerSequence;
  if (
    !Number.isSafeInteger(persistedLastLedger) ||
    persistedLastLedger !== source.lastLedgerSeq ||
    source.lastLedgerSeq < 1
  ) {
    return null;
  }
  return {
    firstLedger: Math.max(
      1,
      source.lastLedgerSeq - RELIABLE_SUBMISSION_LEDGER_WINDOW + 1,
    ),
    lastLedger: source.lastLedgerSeq,
  };
}

function finalStatusFromService(
  status: TransactionStatus,
  network: "testnet" | "devnet",
  hash: string,
  source: BuildRow | ExecutionSnapshotRow,
): FinalTransactionStatus | null {
  const window = persistedLedgerWindow(source);
  if (window === null) {
    if (!status.validated) return null;
    throw new Error("validated transaction status is incomplete");
  }
  return finalStatusWithinWindow(status, network, hash, window);
}

function finalStatusWithinWindow(
  status: TransactionStatus,
  network: "testnet" | "devnet",
  hash: string,
  window: { firstLedger: number; lastLedger: number },
): FinalTransactionStatus | null {
  if (
    status.network !== network ||
    status.hash.toUpperCase() !== hash
  ) {
    throw new Error("transaction status does not match the persisted submission");
  }
  if (!status.validated) return null;
  if (
    !Number.isSafeInteger(status.ledger_index) ||
    Number(status.ledger_index) < window.firstLedger ||
    Number(status.ledger_index) > window.lastLedger ||
    typeof status.engine_result !== "string" ||
    !SAFE_ENGINE_RESULT.test(status.engine_result)
  ) {
    throw new Error("validated transaction status is incomplete");
  }
  return {
    hash,
    network,
    validated: true,
    ledger_index: Number(status.ledger_index),
    engine_result: status.engine_result,
  };
}

function completeRangeNotFound(error: unknown): boolean {
  if (!isRecord(error) && !(error instanceof XrplRpcError)) return false;
  const code = error instanceof XrplRpcError ? error.code : error.code;
  const searchedAll =
    error instanceof XrplRpcError
      ? error.searchedAll
      : error.searched_all === true || error.searchedAll === true;
  return (
    (code === "txnNotFound" || code === "transactionNotFound") &&
    searchedAll === true
  );
}

function exactValidatedStatus(
  response: Readonly<Record<string, unknown>>,
  network: "testnet" | "devnet",
  hash: string,
  firstLedger: number,
  lastLedger: number,
): FinalTransactionStatus | null {
  const metadata = isRecord(response.meta) ? response.meta : undefined;
  const engineResult = metadata?.TransactionResult;
  const ledgerIndex = response.ledger_index;
  if (
    response.validated !== true ||
    typeof response.hash !== "string" ||
    response.hash.toUpperCase() !== hash ||
    !Number.isSafeInteger(ledgerIndex) ||
    (ledgerIndex as number) < firstLedger ||
    (ledgerIndex as number) > lastLedger ||
    typeof engineResult !== "string" ||
    !SAFE_ENGINE_RESULT.test(engineResult)
  ) {
    return null;
  }
  return {
    hash,
    network,
    validated: true,
    ledger_index: ledgerIndex as number,
    engine_result: engineResult,
  };
}

async function proveExpiredTransaction(
  ctx: OpContext,
  network: "testnet" | "devnet",
  hash: string,
  source: BuildRow | ExecutionSnapshotRow,
): Promise<ExpiredTransactionProof> {
  const window = persistedLedgerWindow(source);
  if (window === null) return { state: "pending" };
  return proveExpiredTransactionWindow(ctx, network, hash, window);
}

async function proveExpiredTransactionWindow(
  ctx: OpContext,
  network: "testnet" | "devnet",
  hash: string,
  window: { firstLedger: number; lastLedger: number },
): Promise<ExpiredTransactionProof> {
  let validatedHead: number;
  try {
    // Establish advancement first. A prior soft-empty tx lookup can race with
    // inclusion in the final eligible ledger and is never absence proof.
    validatedHead = await latestValidatedLedger(ctx, network);
  } catch {
    return { state: "pending" };
  }
  if (validatedHead <= window.lastLedger) return { state: "pending" };

  try {
    // The tx range fields are documented to return searched_all when the
    // server could inspect the entire requested range:
    // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/tx
    const response = await requestXrpl(
      ctx,
      network,
      "tx",
      {
        transaction: hash,
        binary: false,
        min_ledger: window.firstLedger,
        max_ledger: window.lastLedger,
        api_version: 1,
      },
      { intent: "read" },
    );
    const status = exactValidatedStatus(
      response,
      network,
      hash,
      window.firstLedger,
      window.lastLedger,
    );
    return status ? { state: "included", status } : { state: "pending" };
  } catch (error) {
    return completeRangeNotFound(error)
      ? { state: "absent", validatedHead, checkedFrom: window.firstLedger,
          checkedThrough: window.lastLedger, searchedAll: true }
      : { state: "pending" };
  }
}

function database(ctx: OpContext): D1Database {
  const typed = executionContext(ctx);
  const db = typed.db ?? typed.env?.DB;
  if (!db) throw new Error("execution database is not configured");
  return db;
}

function storeFor(ctx: OpContext, services: ExecutionServices): Store {
  return services.store ?? new Store(database(ctx), ctx.principal);
}

function nowFor(services: ExecutionServices): Date {
  return (services.now ?? (() => new Date()))();
}

function uuidFor(services: ExecutionServices): string {
  return (services.randomUUID ?? (() => crypto.randomUUID()))();
}

async function sequenceLeaseToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`harbor-account-sequence-v1:${value}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("").toUpperCase();
}

function sequenceSource(idempotencyKey: string): "manual" | "strategy" {
  return idempotencyKey.includes("strategy:") ? "strategy" : "manual";
}

async function releaseAccountSequenceValidated(
  db: D1Database,
  execution: ExecutionRow,
  network: "testnet" | "devnet",
  owner: string,
  hash: string,
  ledgerIndex: number,
  engineResult: string,
  at: string,
): Promise<void> {
  const authority = new AccountSequenceLeaseAuthority(db);
  const lease = await authority.get({ network, account: owner });
  if (!lease || lease.attemptId !== execution.id || lease.hash !== hash) return;
  const released = await authority.releaseValidated({
    ...accountSequenceIdentity(lease), hash, ledgerIndex, engineResult, at,
  });
  if (released.outcome === "blocked") {
    throw new Error("account sequence lease could not be released from validated evidence");
  }
}

async function releaseAccountSequenceAbsent(
  db: D1Database,
  execution: ExecutionRow,
  network: "testnet" | "devnet",
  owner: string,
  hash: string,
  validatedHead: number,
  checkedFrom: number,
  checkedThrough: number,
  at: string,
): Promise<void> {
  const authority = new AccountSequenceLeaseAuthority(db);
  const lease = await authority.get({ network, account: owner });
  if (!lease || lease.attemptId !== execution.id || lease.hash !== hash) return;
  const released = await authority.releaseAbsent({
    ...accountSequenceIdentity(lease), hash, validatedHead, checkedFrom,
    checkedThrough, searchedAll: true, at,
  });
  if (released.outcome === "blocked") {
    throw new Error("account sequence lease could not be released from absence evidence");
  }
}

async function markAccountSequenceAmbiguous(
  db: D1Database,
  execution: ExecutionRow,
  network: "testnet" | "devnet",
  owner: string,
  hash: string,
  at: string,
): Promise<void> {
  const authority = new AccountSequenceLeaseAuthority(db);
  const lease = await authority.get({ network, account: owner });
  if (!lease || lease.attemptId !== execution.id || lease.hash !== hash) return;
  const marked = await authority.markAmbiguous({
    ...accountSequenceIdentity(lease), hash, at,
  });
  if (marked.outcome === "blocked") {
    throw new Error("account sequence lease could not preserve ambiguous submission state");
  }
}

async function ensureOwnerAccountSequenceLease(input: {
  db: D1Database;
  principal: string;
  execution: ExecutionRow;
  network: "testnet" | "devnet";
  owner: string;
  source: BuildRow | ExecutionSnapshotRow;
  tx: Readonly<Record<string, unknown>>;
  hash: string;
  at: string;
}): Promise<boolean> {
  const sequence = input.tx.Sequence;
  const window = persistedLedgerWindow(input.source);
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 0 || window === null ||
      input.tx.LastLedgerSequence !== window.lastLedger) {
    throw new ExecutionLifetimeError(
      "The owner-signed transaction has no valid persisted sequence window",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  const authority = new AccountSequenceLeaseAuthority(input.db);
  const acquired = await authority.acquire({
    principal: input.principal, network: input.network, account: input.owner,
    source: "manual", attemptId: input.execution.id,
    token: await sequenceLeaseToken(input.execution.id), at: input.at,
  });
  if (acquired.outcome === "blocked") return false;
  let lease = acquired.lease;
  if (lease.state === "preparing") {
    const signing = await authority.markSigning({
      ...accountSequenceIdentity(lease), sequence: Number(sequence),
      firstLedgerSequence: window.firstLedger,
      lastLedgerSequence: window.lastLedger, at: input.at,
    });
    if (signing.outcome === "blocked") return false;
    lease = signing.lease;
  }
  if (lease.state === "signing") {
    const signed = await authority.markSigned({
      ...accountSequenceIdentity(lease), hash: input.hash, at: input.at,
    });
    if (signed.outcome === "blocked") return false;
    lease = signed.lease;
  }
  if (lease.state === "signed") {
    const submitted = await authority.markSubmitted({
      ...accountSequenceIdentity(lease), hash: input.hash, at: input.at,
    });
    if (submitted.outcome === "blocked") return false;
    lease = submitted.lease;
  }
  return (lease.state === "submitted" || lease.state === "ambiguous") &&
    lease.hash === input.hash && lease.sequence === Number(sequence) &&
    lease.firstLedgerSequence === window.firstLedger &&
    lease.lastLedgerSequence === window.lastLedger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function executionNetwork(value: Network): "testnet" | "devnet" {
  return ExecutionNetworkSchema.parse(value);
}

function defaultExecutionNetwork(ctx: OpContext): "testnet" | "devnet" {
  return ExecutionNetworkSchema.parse(
    executionContext(ctx).env?.EXEC_NETWORK ?? "testnet",
  );
}

function utcDayStart(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

function principalIdempotencyKey(principal: string, key: string): string {
  if (!principal || principal.includes(":")) {
    throw new Error("principal is invalid for idempotent execution");
  }
  return `${principal}:${key}`;
}

function requestedExecutionMode(args: TxExecuteArgs): ExecutionClaimMode {
  return args.require_owner_approval === true
    ? "require_owner_approval"
    : "policy";
}

function changes(result: D1Result): number {
  const value = result.meta?.changes;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requestedContract(
  value: { execution_contract?: ExecutionContract },
): ExecutionContract {
  return value.execution_contract ?? "xrpl_execution_v1";
}

function assertV2LocalProfile(ctx: OpContext): void {
  if (
    !isReviewedLocalTradingContext(ctx) &&
    !isReviewedLocalTradingIsolatedV1Context(ctx) &&
    !isReviewedLocalTradingIsolatedOnboardingV1Context(ctx) &&
    !isReviewedLocalTradingOnboardingContext(ctx)
  ) {
    throw new ExecutionLifetimeError(
      "xrpl_execution_v2 requires an exact reviewed local profile",
      "EXECUTION_CONTRACT_UNSUPPORTED",
    );
  }
}

function isOnboardingBuildOrigin(origin: BuildRow["originProfile"]): boolean {
  return (
    origin === LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN ||
    origin === LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN
  );
}

function assertApprovalRecoveryLocalProfile(ctx: OpContext): void {
  if (
    !isReviewedLocalTradingContext(ctx) &&
    !isReviewedLocalTradingIsolatedV1Context(ctx)
  ) {
    throw new ExecutionLifetimeError(
      "approval reconciliation requires the exact reviewed local trading profile",
      "EXECUTION_CONTRACT_UNSUPPORTED",
    );
  }
}

function v2CapabilityFromRevision(
  revision: BuildRevisionRow,
): ExecutionCapability {
  const parsed = ExecutionCapabilitySchema.safeParse({
    execution_contract: revision.executionContract,
    build_revision: revision.buildRevision,
    unsigned_tx_digest: revision.unsignedTxDigest,
    unsigned_tx_digest_alg: revision.unsignedTxDigestAlg,
    economic_fingerprint: revision.economicFingerprint,
    economic_fingerprint_alg: revision.economicFingerprintAlg,
    build_ledger: revision.buildLedger,
    first_inclusion_ledger: revision.firstInclusionLedger,
    last_ledger_sequence: revision.lastLedgerSequence,
    minimum_remaining_ledgers: revision.minimumRemainingLedgers,
    approval_expires_in_seconds: revision.approvalExpiresInSeconds,
    ...(revision.quoteLedger === null
      ? {}
      : {
          quote_ledger: revision.quoteLedger,
          quote_valid_through_ledger: revision.quoteValidThroughLedger,
        }),
    ...(revision.acquisitionBalanceInvariant === null
      ? {}
      : {
          acquisition_balance_invariant: {
            kind: revision.acquisitionBalanceInvariant.kind,
            currency: revision.acquisitionBalanceInvariant.currency,
            issuer: revision.acquisitionBalanceInvariant.issuer,
            balance: revision.acquisitionBalanceInvariant.balance,
            ledger_index: revision.acquisitionBalanceInvariant.ledgerIndex,
          },
        }),
  });
  if (!parsed.success) {
    throw new ExecutionLifetimeError(
      "The stored v2 execution capability is malformed",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  return parsed.data;
}

async function exactV2Revision(
  store: Store,
  build: BuildRow,
  revisionNumber: number,
): Promise<BuildRevisionRow> {
  if (
    build.executionContract !== "xrpl_execution_v2" ||
    build.buildRevision !== revisionNumber
  ) {
    throw new ExecutionLifetimeError(
      "The mutable build pointer does not select the requested v2 revision",
      "EXECUTION_CONTRACT_MISMATCH",
    );
  }
  const revision = await store.getBuildRevision(build.id, revisionNumber);
  if (!revision) {
    throw new ExecutionLifetimeError(
      "The requested immutable build revision does not exist",
      "EXECUTION_SNAPSHOT_STALE",
    );
  }
  if (
    revision.executionContract !== "xrpl_execution_v2" ||
    revision.buildId !== build.id ||
    revision.owner !== build.owner ||
    revision.network !== build.network ||
    revision.lastLedgerSequence !== revision.buildLedger + 64 ||
    revision.firstInclusionLedger !== revision.buildLedger + 1 ||
    revision.minimumRemainingLedgers !== V2_MINIMUM_REMAINING_LEDGERS ||
    revision.approvalExpiresInSeconds !== 90
  ) {
    throw new ExecutionLifetimeError(
      "The stored v2 build revision is inconsistent",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  v2CapabilityFromRevision(revision);
  const bindings = await v2CanonicalBindings(
    revision.txJson,
    revision.owner,
    revision.network,
  );
  if (
    bindings.unsignedTxDigest !== revision.unsignedTxDigest ||
    bindings.economicFingerprint !== revision.economicFingerprint
  ) {
    throw new ExecutionLifetimeError(
      "The immutable v2 canonical bindings do not match the transaction",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  return revision;
}

async function assertV2DelegatedBlobMatchesRevision(
  txBlob: string,
  delegate: string,
  revision: BuildRevisionRow,
): Promise<void> {
  const decoded = decodeSignedBlob(txBlob);
  if (decoded.Delegate !== delegate) {
    throw new ExecutionLifetimeError(
      "The delegated transaction does not contain the exact linked delegate",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  const normalized = { ...decoded };
  delete normalized.Delegate;
  delete normalized.SigningPubKey;
  delete normalized.TxnSignature;
  delete normalized.Signers;
  if (canonicalizeJson(normalized) !== canonicalizeJson(revision.txJson)) {
    throw new ExecutionLifetimeError(
      "The delegated transaction differs from the immutable revision",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  const bindings = await v2CanonicalBindings(
    normalized,
    revision.owner,
    revision.network,
  );
  if (
    bindings.unsignedTxDigest !== revision.unsignedTxDigest ||
    bindings.economicFingerprint !== revision.economicFingerprint
  ) {
    throw new ExecutionLifetimeError(
      "The delegated transaction canonical bindings changed",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
}

function assertV2Binding(
  input: {
    execution_contract: "xrpl_execution_v2";
    build_revision: number;
    unsigned_tx_digest: string;
    economic_fingerprint: string;
  },
  snapshot: ExecutionSnapshotRow,
): void {
  if (
    snapshot.executionContract !== input.execution_contract ||
    snapshot.buildRevision !== input.build_revision ||
    snapshot.unsignedTxDigest !== input.unsigned_tx_digest ||
    snapshot.economicFingerprint !== input.economic_fingerprint
  ) {
    throw new ExecutionLifetimeError(
      "The request does not match the immutable execution snapshot",
      "EXECUTION_CONTRACT_MISMATCH",
    );
  }
}

function assertSnapshotMatchesRevision(
  snapshot: ExecutionSnapshotRow,
  revision: BuildRevisionRow,
): void {
  if (
    snapshot.executionContract !== revision.executionContract ||
    snapshot.buildId !== revision.buildId ||
    snapshot.buildRevision !== revision.buildRevision ||
    snapshot.unsignedTxDigest !== revision.unsignedTxDigest ||
    snapshot.unsignedTxDigestAlg !== revision.unsignedTxDigestAlg ||
    snapshot.economicFingerprint !== revision.economicFingerprint ||
    snapshot.economicFingerprintAlg !== revision.economicFingerprintAlg ||
    snapshot.snapshotOwner !== revision.owner ||
    snapshot.snapshotNetwork !== revision.network ||
    snapshot.snapshotSequence !== revision.txJson.Sequence ||
    snapshot.firstInclusionLedger !== revision.firstInclusionLedger ||
    snapshot.lastLedgerSequence !== revision.lastLedgerSequence ||
    JSON.stringify(snapshot.acquisitionBalanceInvariant) !==
      JSON.stringify(revision.acquisitionBalanceInvariant)
  ) {
    throw new ExecutionLifetimeError(
      "The execution snapshot does not match its immutable build revision",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
}

function snapshotFromRevision(
  executionId: string,
  revision: BuildRevisionRow,
  policy: Policy,
  policyRevision: string,
  createdAt: string,
  approval?: { id: string; expiresAt: string },
): ExecutionSnapshotInsert {
  const sequence = revision.txJson.Sequence;
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) {
    throw new ExecutionLifetimeError(
      "The immutable revision has no canonical owner Sequence",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  return {
    executionId,
    buildId: revision.buildId,
    executionContract: "xrpl_execution_v2",
    buildRevision: revision.buildRevision,
    policySnapshot: structuredClone(policy),
    policyRevision,
    unsignedTxDigest: revision.unsignedTxDigest,
    unsignedTxDigestAlg: revision.unsignedTxDigestAlg,
    economicFingerprint: revision.economicFingerprint,
    economicFingerprintAlg: revision.economicFingerprintAlg,
    snapshotOwner: revision.owner,
    snapshotNetwork: revision.network,
    snapshotSequence: Number(sequence),
    firstInclusionLedger: revision.firstInclusionLedger,
    lastLedgerSequence: revision.lastLedgerSequence,
    approvalId: approval?.id ?? null,
    approvalExpiresAt: approval?.expiresAt ?? null,
    acquisitionBalanceInvariant: revision.acquisitionBalanceInvariant,
    createdAt,
  };
}

function prepareConditionalSnapshotInsert(
  db: D1Database,
  principal: string,
  snapshot: ExecutionSnapshotInsert,
  expected: { status: "pending" | "needs_approval"; signedBy: "delegate" | null },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO execution_snapshots
        (execution_id, principal, build_id, execution_contract, build_revision,
         policy_snapshot, policy_revision, unsigned_tx_digest,
         unsigned_tx_digest_alg, economic_fingerprint, economic_fingerprint_alg,
         snapshot_owner, snapshot_network, snapshot_sequence,
         first_inclusion_ledger, last_ledger_sequence, approval_id,
         approval_expires_at, acquisition_balance_invariant, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM executions
           WHERE principal = ? AND id = ? AND build_id = ? AND status = ?
             AND ((? IS NULL AND signed_by IS NULL) OR signed_by = ?)
        )
          AND NOT EXISTS (
            SELECT 1 FROM execution_snapshots
             WHERE principal = ? AND execution_id = ?
          )`,
    )
    .bind(
      snapshot.executionId,
      principal,
      snapshot.buildId,
      snapshot.executionContract,
      snapshot.buildRevision,
      JSON.stringify(snapshot.policySnapshot),
      snapshot.policyRevision,
      snapshot.unsignedTxDigest,
      snapshot.unsignedTxDigestAlg,
      snapshot.economicFingerprint,
      snapshot.economicFingerprintAlg,
      snapshot.snapshotOwner,
      snapshot.snapshotNetwork,
      snapshot.snapshotSequence,
      snapshot.firstInclusionLedger,
      snapshot.lastLedgerSequence,
      snapshot.approvalId,
      snapshot.approvalExpiresAt,
      snapshot.acquisitionBalanceInvariant === null
        ? null
        : JSON.stringify({
            kind: snapshot.acquisitionBalanceInvariant.kind,
            currency: snapshot.acquisitionBalanceInvariant.currency,
            issuer: snapshot.acquisitionBalanceInvariant.issuer,
            balance: snapshot.acquisitionBalanceInvariant.balance,
            ledger_index: snapshot.acquisitionBalanceInvariant.ledgerIndex,
          }),
      snapshot.createdAt,
      principal,
      snapshot.executionId,
      snapshot.buildId,
      expected.status,
      expected.signedBy,
      expected.signedBy,
      principal,
      snapshot.executionId,
    );
}

function canonicalNonnegativeInteger(value: unknown): bigint | null {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
    ? BigInt(value)
    : null;
}

async function exactIssuedBalance(
  ctx: OpContext,
  network: "testnet" | "devnet",
  owner: string,
  invariant: AcquisitionBalanceInvariant,
  validatedLedger: number,
): Promise<void> {
  const response = await requestXrpl(ctx, network, "account_lines", {
    account: owner,
    peer: invariant.issuer,
    ledger_index: validatedLedger,
  });
  if (
    response.validated !== true ||
    response.ledger_index !== validatedLedger ||
    !Array.isArray(response.lines)
  ) {
    throw new ExecutionLifetimeError(
      "The acquisition balance could not be read from validated state",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  const line = response.lines.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.account === invariant.issuer &&
      String(candidate.currency).toUpperCase() ===
        invariant.currency.toUpperCase(),
  );
  if (!isRecord(line) || line.balance !== invariant.balance) {
    throw new ExecutionLifetimeError(
      "The acquisition balance changed after the build",
      "BALANCE_INVARIANT_CHANGED",
    );
  }
}

async function validateV2LiveEvidence(
  ctx: OpContext,
  snapshot: Pick<
    ExecutionSnapshotRow,
    | "snapshotNetwork"
    | "snapshotOwner"
    | "snapshotSequence"
    | "lastLedgerSequence"
    | "acquisitionBalanceInvariant"
  >,
  txJson: Readonly<Record<string, unknown>>,
): Promise<{ validatedLedger: number; remainingLedgers: number }> {
  const validatedLedger = await latestValidatedLedger(
    ctx,
    snapshot.snapshotNetwork,
  );
  const [accountInfo, fee] = await Promise.all([
    requestXrpl(ctx, snapshot.snapshotNetwork, "account_info", {
      account: snapshot.snapshotOwner,
      ledger_index: validatedLedger,
    }),
    requestXrpl(ctx, snapshot.snapshotNetwork, "fee"),
  ]);
  const remainingLedgers = snapshot.lastLedgerSequence - validatedLedger;
  if (remainingLedgers < V2_MINIMUM_REMAINING_LEDGERS) {
    throw new ExecutionLifetimeError(
      "Fewer than eight validated ledgers remain",
      "TRANSACTION_WINDOW_TOO_SHORT",
    );
  }
  const accountData = isRecord(accountInfo.account_data)
    ? accountInfo.account_data
    : null;
  if (
    accountInfo.validated !== true ||
    accountInfo.ledger_index !== validatedLedger ||
    accountData === null ||
    accountData.Account !== snapshot.snapshotOwner ||
    accountData.Sequence !== snapshot.snapshotSequence ||
    txJson.Sequence !== snapshot.snapshotSequence
  ) {
    throw new ExecutionLifetimeError(
      "The owner Sequence changed after the build",
      "ACCOUNT_SEQUENCE_CHANGED",
    );
  }
  const immutableFee = canonicalNonnegativeInteger(txJson.Fee);
  const drops = isRecord(fee.drops) ? fee.drops : null;
  const openFee = canonicalNonnegativeInteger(drops?.open_ledger_fee);
  const currentQueue = canonicalNonnegativeInteger(fee.current_queue_size);
  const maxQueue = canonicalNonnegativeInteger(fee.max_queue_size);
  if (
    immutableFee === null ||
    immutableFee < 1n ||
    openFee === null ||
    openFee < 1n ||
    currentQueue === null ||
    maxQueue === null ||
    maxQueue < 1n
  ) {
    throw new ExecutionLifetimeError(
      "Current fee/load evidence is malformed",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  if (openFee > immutableFee || currentQueue >= maxQueue) {
    throw new ExecutionLifetimeError(
      "Current fee or queue load is unsafe",
      "FEE_LOAD_UNSAFE",
    );
  }
  if (snapshot.acquisitionBalanceInvariant !== null) {
    await exactIssuedBalance(
      ctx,
      snapshot.snapshotNetwork,
      snapshot.snapshotOwner,
      snapshot.acquisitionBalanceInvariant,
      validatedLedger,
    );
  }
  return { validatedLedger, remainingLedgers };
}

async function claimV2Relay(
  store: Store,
  executionId: string,
  hash: string,
  attemptedAt: string,
): Promise<void> {
  try {
    await store.insertRelayClaim({ executionId, hash, attemptedAt });
  } catch {
    const existing = await store.getRelayClaim(executionId);
    if (existing) {
      throw new ExecutionLifetimeError(
        "A relay was already attempted for this execution",
        "RELAY_ALREADY_ATTEMPTED",
      );
    }
    throw new ExecutionLifetimeError(
      "The relay claim could not be persisted",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
}

async function assertApprovalMargin(
  db: D1Database,
  principal: string,
  executionId: string,
  owner: string,
  network: Network,
  usdValue: number,
  dailyCapUsd: number,
  now: Date,
): Promise<void> {
  const spendDay = now.toISOString().slice(0, 10);
  const row = await db
    .prepare(
      `SELECT COALESCE((
         SELECT SUM(e.usd_value)
           FROM executions AS e
           LEFT JOIN execution_snapshots AS s
             ON s.principal = e.principal AND s.execution_id = e.id
           LEFT JOIN builds AS b
             ON b.principal = e.principal AND b.id = e.build_id
          WHERE e.principal = ? AND e.id <> ?
            AND COALESCE(s.snapshot_owner, b.owner) = ?
            AND COALESCE(s.snapshot_network, b.network) = ?
            AND e.status IN ('pending', 'submitted', 'executed', 'needs_approval')
            AND e.created_at >= ?
       ), 0) + COALESCE((
         SELECT SUM(spend.amount_microusd) / 1000000.0
           FROM ap4m_spend AS spend
           JOIN ap4m_mandates AS mandate
             ON mandate.principal = spend.principal AND mandate.id = spend.mandate_id
          WHERE spend.principal = ? AND mandate.owner = ? AND mandate.network = ?
            AND spend.spend_day = ? AND spend.status IN ('reserved', 'committed')
       ), 0) AS total`,
    )
    .bind(
      principal,
      executionId,
      owner,
      network,
      utcDayStart(now),
      principal,
      owner,
      network,
      spendDay,
    )
    .first<{ total: number | null }>();
  const total = row?.total ?? 0;
  if (
    !Number.isFinite(total) ||
    total < 0 ||
    total + usdValue > dailyCapUsd
  ) {
    throw new ExecutionLifetimeError(
      "Current daily policy margin is insufficient for this approval",
      "EXECUTION_SNAPSHOT_STALE",
    );
  }
}

/**
 * Reserve the auto-execution amount before any key is unwrapped or signature is
 * produced. The conditional INSERT and aggregate run as one SQLite statement,
 * so concurrent requests cannot both pass the same remaining daily allowance.
 * Pending/submitted rows remain reserved; failed/blocked/approval rows do not.
 */
export async function reserveDailyBudgetAtomic(
  input: DailyBudgetReservation,
): Promise<
  | "reserved"
  | "duplicate"
  | "over-cap"
  | "link-inactive"
  | "link-frozen"
  | "busy"
> {
  if (
    !Number.isFinite(input.usdValue) ||
    input.usdValue < 0 ||
    !Number.isFinite(input.dailyCapUsd) ||
    input.dailyCapUsd < 0
  ) {
    throw new TypeError("daily budget values must be finite and nonnegative");
  }
  const reservationDate = new Date(input.createdAt);
  const dayStart = utcDayStart(reservationDate);
  const spendDay = reservationDate.toISOString().slice(0, 10);
  const reservationOwner = input.snapshot?.snapshotOwner ?? input.build.owner;
  const reservationNetwork = input.snapshot?.snapshotNetwork ?? input.build.network;
  const reservationStatement = input.db.prepare(
      `INSERT INTO executions
        (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
       SELECT ?, ?, ?, ?, 'pending', NULL, ?, 'delegate', ?
       WHERE NOT EXISTS (
         SELECT 1 FROM executions WHERE idempotency_key = ?
       )
       AND EXISTS (
         SELECT 1 FROM links
          WHERE principal = ? AND owner = ? AND network = ?
            AND status = 'active' AND frozen_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1
           FROM executions AS active_e
           LEFT JOIN execution_snapshots AS active_s
             ON active_s.principal = active_e.principal
            AND active_s.execution_id = active_e.id
           LEFT JOIN builds AS active_b
             ON active_b.id = active_e.build_id
            AND active_b.principal = active_e.principal
          WHERE active_e.principal = ?
            AND COALESCE(active_s.snapshot_owner, active_b.owner) = ?
            AND COALESCE(active_s.snapshot_network, active_b.network) = ?
            AND active_e.status IN ('pending', 'submitted')
       )
       AND COALESCE((
         SELECT SUM(e.usd_value)
           FROM executions AS e
           LEFT JOIN execution_snapshots AS s
             ON s.principal = e.principal AND s.execution_id = e.id
           LEFT JOIN builds AS b ON b.id = e.build_id AND b.principal = e.principal
          WHERE e.principal = ?
            AND COALESCE(s.snapshot_owner, b.owner) = ?
            AND COALESCE(s.snapshot_network, b.network) = ?
            AND e.status IN ('pending', 'submitted', 'executed')
            AND e.created_at >= ?
       ), 0) + COALESCE((
         SELECT SUM(spend.amount_microusd) / 1000000.0
           FROM ap4m_spend AS spend
           JOIN ap4m_mandates AS mandate
             ON mandate.principal = spend.principal AND mandate.id = spend.mandate_id
          WHERE spend.principal = ? AND mandate.owner = ? AND mandate.network = ?
            AND spend.spend_day = ? AND spend.status IN ('reserved', 'committed')
       ), 0) + ? <= ?`,
    )
    .bind(
      input.executionId,
      input.principal,
      input.build.id,
      input.idempotencyKey,
      input.usdValue,
      input.createdAt,
      input.idempotencyKey,
      input.principal,
      reservationOwner,
      reservationNetwork,
      input.principal,
      reservationOwner,
      reservationNetwork,
      input.principal,
      reservationOwner,
      reservationNetwork,
      dayStart,
      input.principal,
      reservationOwner,
      reservationNetwork,
      spendDay,
      input.usdValue,
      input.dailyCapUsd,
    )
    ;
  const results = input.snapshot
    ? await input.db.batch([
        reservationStatement,
        prepareConditionalSnapshotInsert(
          input.db,
          input.principal,
          input.snapshot,
          { status: "pending", signedBy: "delegate" },
        ),
      ])
    : [await reservationStatement.run()];
  const result = results[0];
  if (input.snapshot && changes(results[1]) !== 1) {
    throw new ExecutionLifetimeError(
      "The immutable execution snapshot could not be reserved atomically",
      "EXECUTION_SNAPSHOT_STALE",
    );
  }
  if (changes(result) === 1) return "reserved";
  const duplicate = await input.db
    .prepare(
      "SELECT id FROM executions WHERE principal = ? AND idempotency_key = ?",
    )
    .bind(input.principal, input.idempotencyKey)
    .first<{ id: string }>();
  if (duplicate) return "duplicate";
  const activeLink = await input.db
    .prepare(
      "SELECT status, frozen_at FROM links WHERE principal = ? AND owner = ? AND network = ? LIMIT 1",
    )
    .bind(
      input.principal,
      reservationOwner,
      reservationNetwork,
    )
    .first<{ status: string; frozen_at: string | null }>();
  if (!activeLink || activeLink.status !== "active") return "link-inactive";
  if (activeLink.frozen_at !== null) return "link-frozen";
  const inFlight = await input.db
    .prepare(
      `SELECT 1 AS present
         FROM executions AS e
         LEFT JOIN execution_snapshots AS s
           ON s.principal = e.principal AND s.execution_id = e.id
         LEFT JOIN builds AS b ON b.id = e.build_id AND b.principal = e.principal
        WHERE e.principal = ?
          AND COALESCE(s.snapshot_owner, b.owner) = ?
          AND COALESCE(s.snapshot_network, b.network) = ?
          AND e.status IN ('pending', 'submitted')
        LIMIT 1`,
    )
    .bind(input.principal, reservationOwner, reservationNetwork)
    .first<{ present: number }>();
  return inFlight ? "busy" : "over-cap";
}

async function reserveClaimedDailyBudgetAtomic(
  input: DailyBudgetReservation,
): Promise<
  | "reserved"
  | "duplicate"
  | "over-cap"
  | "link-inactive"
  | "link-frozen"
  | "busy"
> {
  if (
    !Number.isFinite(input.usdValue) ||
    input.usdValue < 0 ||
    !Number.isFinite(input.dailyCapUsd) ||
    input.dailyCapUsd < 0
  ) {
    throw new TypeError("daily budget values must be finite and nonnegative");
  }
  const reservationDate = new Date(input.createdAt);
  const dayStart = utcDayStart(reservationDate);
  const spendDay = reservationDate.toISOString().slice(0, 10);
  const reservationOwner = input.snapshot?.snapshotOwner ?? input.build.owner;
  const reservationNetwork = input.snapshot?.snapshotNetwork ?? input.build.network;
  const reservationStatement = input.db.prepare(
      `UPDATE executions AS target
          SET usd_value = ?, signed_by = 'delegate', created_at = ?
        WHERE target.principal = ? AND target.id = ?
          AND target.build_id = ? AND target.idempotency_key = ?
          AND target.status = 'pending' AND target.hash IS NULL
          AND target.usd_value IS NULL AND target.signed_by IS NULL
          AND EXISTS (
            SELECT 1 FROM events AS claim
             WHERE claim.principal = target.principal
               AND claim.id = ? AND claim.kind = 'execution_claim'
               AND json_extract(claim.detail, '$.build_id') = ?
               AND json_extract(claim.detail, '$.execution_mode') = 'policy'
          )
          AND EXISTS (
            SELECT 1 FROM links
             WHERE principal = target.principal AND owner = ?
               AND network = ? AND status = 'active' AND frozen_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1
              FROM executions AS active_e
              LEFT JOIN execution_snapshots AS active_s
                ON active_s.principal = active_e.principal
               AND active_s.execution_id = active_e.id
              LEFT JOIN builds AS active_b
                ON active_b.id = active_e.build_id
               AND active_b.principal = active_e.principal
             WHERE active_e.principal = target.principal
               AND active_e.id <> target.id
               AND COALESCE(active_s.snapshot_owner, active_b.owner) = ?
               AND COALESCE(active_s.snapshot_network, active_b.network) = ?
               AND active_e.status IN ('pending', 'submitted')
          )
          AND COALESCE((
            SELECT SUM(e.usd_value)
              FROM executions AS e
              LEFT JOIN execution_snapshots AS s
                ON s.principal = e.principal AND s.execution_id = e.id
              LEFT JOIN builds AS b
                ON b.id = e.build_id AND b.principal = e.principal
             WHERE e.principal = target.principal
               AND e.id <> target.id
               AND COALESCE(s.snapshot_owner, b.owner) = ?
               AND COALESCE(s.snapshot_network, b.network) = ?
               AND e.status IN ('pending', 'submitted', 'executed')
               AND e.created_at >= ?
          ), 0) + COALESCE((
            SELECT SUM(spend.amount_microusd) / 1000000.0
              FROM ap4m_spend AS spend
              JOIN ap4m_mandates AS mandate
                ON mandate.principal = spend.principal AND mandate.id = spend.mandate_id
             WHERE spend.principal = target.principal
               AND mandate.owner = ? AND mandate.network = ?
               AND spend.spend_day = ? AND spend.status IN ('reserved', 'committed')
          ), 0) + ? <= ?`,
    )
    .bind(
      input.usdValue,
      input.createdAt,
      input.principal,
      input.executionId,
      input.build.id,
      input.idempotencyKey,
      claimEventId(input.executionId),
      input.build.id,
      reservationOwner,
      reservationNetwork,
      reservationOwner,
      reservationNetwork,
      reservationOwner,
      reservationNetwork,
      dayStart,
      reservationOwner,
      reservationNetwork,
      spendDay,
      input.usdValue,
      input.dailyCapUsd,
    );
  const results = input.snapshot
    ? await input.db.batch([
        reservationStatement,
        prepareConditionalSnapshotInsert(
          input.db,
          input.principal,
          input.snapshot,
          { status: "pending", signedBy: "delegate" },
        ),
      ])
    : [await reservationStatement.run()];
  const result = results[0];
  if (input.snapshot && changes(results[1]) !== 1) {
    throw new ExecutionLifetimeError(
      "The immutable execution snapshot could not be reserved atomically",
      "EXECUTION_SNAPSHOT_STALE",
    );
  }
  if (changes(result) === 1) return "reserved";

  const existing = await input.db
    .prepare(
      `SELECT id, build_id, status, usd_value, signed_by
         FROM executions WHERE principal = ? AND idempotency_key = ?`,
    )
    .bind(input.principal, input.idempotencyKey)
    .first<{
      id: string;
      build_id: string;
      status: string;
      usd_value: number | null;
      signed_by: string | null;
    }>();
  if (
    !existing ||
    existing.id !== input.executionId ||
    existing.build_id !== input.build.id
  ) {
    return "duplicate";
  }
  if (
    existing.status !== "pending" ||
    existing.usd_value !== null ||
    existing.signed_by !== null
  ) {
    return "duplicate";
  }
  const activeLink = await input.db
    .prepare(
      "SELECT status, frozen_at FROM links WHERE principal = ? AND owner = ? AND network = ? LIMIT 1",
    )
    .bind(
      input.principal,
      reservationOwner,
      reservationNetwork,
    )
    .first<{ status: string; frozen_at: string | null }>();
  if (!activeLink || activeLink.status !== "active") return "link-inactive";
  if (activeLink.frozen_at !== null) return "link-frozen";
  const inFlight = await input.db
    .prepare(
      `SELECT 1 AS present
         FROM executions AS e
         LEFT JOIN execution_snapshots AS s
           ON s.principal = e.principal AND s.execution_id = e.id
         LEFT JOIN builds AS b ON b.id = e.build_id AND b.principal = e.principal
        WHERE e.principal = ? AND e.id <> ?
          AND COALESCE(s.snapshot_owner, b.owner) = ?
          AND COALESCE(s.snapshot_network, b.network) = ?
          AND e.status IN ('pending', 'submitted')
        LIMIT 1`,
    )
    .bind(
      input.principal,
      input.executionId,
      reservationOwner,
      reservationNetwork,
    )
    .first<{ present: number }>();
  return inFlight ? "busy" : "over-cap";
}

export function createPolicyFactsAdapter(ctx: OpContext): PolicyFactsAdapter {
  return {
    async getPolicyFacts(build) {
      const assets = collectIssuedPolicyAssets(build.tx_json);
      const issuerFacts = await Promise.all(
        assets.map(async (asset) => {
          // AccountRoot Flags includes lsfRequireAuth (0x00040000):
          // https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot#accountroot-flags
          const result = await requestXrpl(
            ctx,
            build.network,
            "account_info",
            { account: asset.issuer, ledger_index: "validated" },
          );
          if (!isRecord(result.account_data)) {
            throw new Error("issuer account_info response is malformed");
          }
          const flags = result.account_data.Flags;
          if (!Number.isSafeInteger(flags) || (flags as number) < 0) {
            throw new Error("issuer AccountRoot flags are malformed");
          }
          const flagObject = isRecord(result.account_flags)
            ? result.account_flags
            : undefined;
          return {
            ...asset,
            requireAuth:
              flagObject?.requireAuth === true ||
              flagObject?.lsfRequireAuth === true ||
              (((flags as number) & REQUIRE_AUTH_FLAG) !== 0),
          };
        }),
      );
      const stableAsset = configuredStablePolicyAsset(
        executionContext(ctx).env,
        build.network,
        { currency: RLUSD_HEX_CURRENCY, issuer: TESTNET_RLUSD_ISSUER },
      );
      return {
        usdValue: build.summary.usd_value ?? "0",
        issuerFacts,
        ...(stableAsset ? { stableAsset } : {}),
      };
    },
  };
}

function unsignedOwnerTransaction(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...value };
  delete result.Delegate;
  delete result.SigningPubKey;
  delete result.TxnSignature;
  delete result.Signers;
  return result;
}

function rehydratedBuild(
  row: BuildRow,
  link: LinkRow | null,
  revalidated: Awaited<ReturnType<typeof revalidateStoredBuild>>,
): TxBuild {
  const transactionType = row.txJson.TransactionType;
  return {
    build_id: row.id,
    network: row.network,
    tx_json: row.txJson,
    delegable:
      link?.status === "active" &&
      isHarborDelegableTransactionType(transactionType) &&
      link.permissions.includes(transactionType),
    preflight: revalidated.preflight,
    simulate: revalidated.simulate,
    summary: row.summary,
  };
}

async function refreshedBuild(
  ctx: OpContext,
  store: Store,
  row: BuildRow,
): Promise<
  | { status: "ready"; row: BuildRow }
  | { status: "quote-expired" }
> {
  const network = executionNetwork(row.network);
  // ledger_current fields: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_current
  const current = await requestXrpl(ctx, network, "ledger_current");
  const ledgerIndex = current.ledger_current_index;
  if (!Number.isSafeInteger(ledgerIndex) || (ledgerIndex as number) < 1) {
    throw new Error("ledger_current response is malformed");
  }
  if ((ledgerIndex as number) <= row.lastLedgerSeq) {
    return { status: "ready", row };
  }

  const flags = row.txJson.Flags;
  if (
    row.summary.action === "swap" &&
    row.txJson.TransactionType === "OfferCreate" &&
    typeof flags === "number" &&
    (flags & OFFER_TF_FILL_OR_KILL) !== 0 &&
    (flags & OFFER_TF_SELL) === 0
  ) {
    // Fixed-buy FOK swaps are bound to the exact-output quote that created
    // TakerGets. Once LastLedgerSequence passes, refreshing only the common
    // fields would revive a stale quote without re-running pathfinding.
    return { status: "quote-expired" };
  }

  const base = { ...row.txJson };
  for (const field of [
    "Fee",
    "Sequence",
    "LastLedgerSequence",
    "SigningPubKey",
    "TxnSignature",
    "Signers",
    "Delegate",
  ]) {
    delete base[field];
  }
  validatePreparedTransaction(base, row.owner);
  const txJson = await autofillUnsignedTransaction(ctx, network, base);
  const sequence = txJson.LastLedgerSequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    throw new Error("refreshed build is missing LastLedgerSequence");
  }
  const updated = await store.updateBuild(row.id, {
    txJson,
    lastLedgerSeq: sequence as number,
    summary: {
      ...row.summary,
      fee_drops:
        typeof txJson.Fee === "string" ? txJson.Fee : row.summary.fee_drops,
    },
  });
  if (!updated) throw new Error("refreshed build could not be stored");
  return { status: "ready", row: updated };
}

function policyWithDailyCapFailure(policy: PolicyResult): PolicyResult {
  const reasons = policy.reasons.map((reason) =>
    reason.rule === "daily_cap_usd"
      ? {
          ...reason,
          pass: false,
          detail:
            "Daily USD allowance was consumed by another execution before signing",
        }
      : reason,
  );
  return { verdict: "block", reasons };
}

function policyWithLinkFrozen(policy: PolicyResult): PolicyResult {
  return {
    verdict: "block",
    reasons: [
      ...policy.reasons.filter((reason) => reason.rule !== "link_frozen"),
      {
        rule: "link_frozen",
        pass: false,
        detail: "QuickNode watchdog froze the account link before submission",
      },
    ],
  };
}

async function linkFrozenAt(
  db: D1Database,
  principal: string,
  owner: string,
  network: Network,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT frozen_at FROM links
        WHERE principal = ? AND owner = ? AND network = ?
        LIMIT 1`,
    )
    .bind(principal, owner, network)
    .first<{ frozen_at: string | null }>();
  return row?.frozen_at ?? null;
}

function policyWithRequiredOwnerApproval(policy: PolicyResult): PolicyResult {
  if (policy.verdict !== "execute") return policy;
  return {
    verdict: "needs_approval",
    reasons: [
      ...policy.reasons,
      {
        rule: "require_owner_approval",
        pass: false,
        detail: "Owner approval was explicitly required by tx.execute",
      },
    ],
  };
}

function resultEventId(executionId: string): string {
  return `execution-result:${executionId}`;
}

function claimEventId(executionId: string): string {
  return `execution-claim:${executionId}`;
}

function claimDetail(build: BuildRow, mode: ExecutionClaimMode) {
  return {
    build_id: build.id,
    execution_mode: mode,
    ...(build.executionContract === "xrpl_execution_v2" && build.buildRevision
      ? {
          execution_contract: "xrpl_execution_v2" as const,
          build_revision: build.buildRevision,
        }
      : {}),
  };
}

function signerEventId(executionId: string): string {
  return `execution-signer:${executionId}`;
}

function signerForExecution(ctx: OpContext, link: LinkRow): Signer | undefined {
  const configured = executionContext(ctx);
  if (
    configured.executionServices?.signDelegate !== undefined ||
    configured.signingServices?.withDelegateSigner !== undefined ||
    configured.signingServices?.kmsClient !== undefined
  ) {
    return undefined;
  }
  const mode = readKmsMode((configured.env ?? {}) as KmsEnv);
  if (mode === "sign" && link.keyBackend === "kms") {
    return { kind: "aws-kms", key_ref: link.kmsAlias };
  }
  if (mode === "kek" && link.keyBackend === "local") {
    return { kind: "aws-kms-kek", key_ref: "alias/harbor/kek" };
  }
  return undefined;
}

async function readDelegatedSigner(
  store: Store,
  execution: ExecutionRow,
): Promise<Signer | undefined> {
  const event = await store.getEvent(signerEventId(execution.id));
  if (!event || event.kind !== "execution_signer") return undefined;
  const parsed = z.object({ signer: SignerSchema }).strict().safeParse(event.detail);
  return parsed.success ? parsed.data.signer : undefined;
}

async function readExecutionClaim(
  store: Store,
  execution: ExecutionRow,
): Promise<{
  buildId: string;
  mode: ExecutionClaimMode;
  executionContract: ExecutionContract;
  buildRevision: number | null;
} | null> {
  const event = await store.getEvent(claimEventId(execution.id));
  if (!event || event.kind !== "execution_claim") return null;
  const parsed = z
    .object({
      build_id: z.string().trim().min(1),
      execution_mode: ExecutionClaimModeSchema,
      execution_contract: z.literal("xrpl_execution_v2").optional(),
      build_revision: z.number().int().positive().optional(),
    })
    .strict()
    .superRefine((value, issueContext) => {
      if ((value.execution_contract === undefined) !== (value.build_revision === undefined)) {
        issueContext.addIssue({ code: "custom", message: "partial execution contract claim" });
      }
    })
    .safeParse(event.detail);
  return parsed.success
    ? {
        buildId: parsed.data.build_id,
        mode: parsed.data.execution_mode,
        executionContract:
          parsed.data.execution_contract ?? "xrpl_execution_v1",
        buildRevision: parsed.data.build_revision ?? null,
      }
    : null;
}

type ExecutionClaim = {
  execution: ExecutionRow;
  mode: ExecutionClaimMode | null;
  claimed: boolean;
};

type BuildConsumption = {
  idempotency_key: string;
  status: "claimed" | "consumed";
};

async function readBuildConsumption(
  db: D1Database,
  principal: string,
  buildId: string,
): Promise<BuildConsumption | null> {
  return db
    .prepare(
      `SELECT idempotency_key, status
         FROM build_consumptions
        WHERE principal = ? AND build_id = ?`,
    )
    .bind(principal, buildId)
    .first<BuildConsumption>();
}

async function claimExecutionAtomic(
  db: D1Database,
  store: Store,
  input: {
    id: string;
    build: BuildRow;
    idempotencyKey: string;
    mode: ExecutionClaimMode;
    createdAt: string;
  },
): Promise<ExecutionClaim> {
  const statements: D1PreparedStatement[] = [];
  if (isOnboardingBuildOrigin(input.build.originProfile)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO build_consumptions
            (principal, build_id, idempotency_key, status, claimed_at, consumed_at)
           VALUES (?, ?, ?, 'claimed', ?, NULL)`,
        )
        .bind(
          store.principal,
          input.build.id,
          input.idempotencyKey,
          input.createdAt,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO executions
          (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?)`,
      )
      .bind(
        input.id,
        store.principal,
        input.build.id,
        input.idempotencyKey,
        input.createdAt,
      ),
    db
      .prepare(
        `INSERT INTO events (id, principal, owner, kind, detail, created_at)
         VALUES (?, ?, ?, 'execution_claim', ?, ?)`,
      )
      .bind(
        claimEventId(input.id),
        store.principal,
        input.build.owner,
        JSON.stringify(claimDetail(input.build, input.mode)),
        input.createdAt,
      ),
  );
  try {
    await db.batch(statements);
    const execution = await store.getExecution(input.id);
    if (!execution) throw new Error("execution claim could not be read");
    if (isOnboardingBuildOrigin(input.build.originProfile)) {
      const consumption = await readBuildConsumption(
        db,
        store.principal,
        input.build.id,
      );
      if (consumption?.idempotency_key !== input.idempotencyKey) {
        throw new Error("onboarding build claim could not be read");
      }
    }
    return { execution, mode: input.mode, claimed: true };
  } catch (error) {
    const execution = await store.findExecutionByIdempotencyKey(
      input.idempotencyKey,
    );
    if (!execution) {
      if (isOnboardingBuildOrigin(input.build.originProfile)) {
        const consumption = await readBuildConsumption(
          db,
          store.principal,
          input.build.id,
        );
        if (
          consumption &&
          consumption.idempotency_key !== input.idempotencyKey
        ) {
          throw new Error(
            "onboarding build is already bound to a different idempotency key",
          );
        }
      }
      throw error;
    }
    const receipt = await readExecutionClaim(store, execution);
    return { execution, mode: receipt?.mode ?? null, claimed: false };
  }
}

async function replayResult(
  store: Store,
  execution: ExecutionRow,
): Promise<ReplayExecutionResult | null> {
  const event = await store.getEvent(resultEventId(execution.id));
  if (!event) return null;
  const parsed = z
    .union([ExecResultSchema, OwnerExecutedResultSchema])
    .safeParse(event.detail.result);
  return parsed.success ? parsed.data : null;
}

async function replayOrRecover(
  ctx: OpContext,
  services: ExecutionServices,
  store: Store,
  execution: ExecutionRow,
): Promise<ReplayExecutionResult> {
  if (execution.status === "submitted" && execution.hash && services.status) {
    const snapshot = await store.getExecutionSnapshot(execution.id);
    const baseBuild = await store.getBuild(execution.buildId);
    assertIsolatedBuildCapability(ctx, baseBuild);
    assertIsolatedSnapshotTestnet(ctx, snapshot);
    const build = snapshot ? null : baseBuild;
    const source = snapshot ?? build;
    if (source) {
      if (snapshot) {
        const revision = await store.getBuildRevision(
          snapshot.buildId,
          snapshot.buildRevision,
        );
        if (!revision) {
          throw new ExecutionLifetimeError(
            "The execution snapshot has no immutable build revision",
            "EXECUTION_SNAPSHOT_INVALID",
          );
        }
        assertSnapshotMatchesRevision(snapshot, revision);
      }
      const sourceNetwork = executionNetwork(
        snapshot ? snapshot.snapshotNetwork : build!.network,
      );
      const sourceOwner = snapshot ? snapshot.snapshotOwner : build!.owner;
      if (execution.signedBy === "owner") {
        const approvalRow = await database(ctx)
          .prepare(
            `SELECT id FROM approvals
              WHERE principal = ? AND build_id = ?
                AND ((? IS NOT NULL AND execution_id = ?)
                  OR (? IS NULL AND execution_id IS NULL AND id LIKE ?))
              ORDER BY id LIMIT 2`,
          )
          .bind(
            ctx.principal,
            execution.buildId,
            snapshot?.executionId ?? null,
            execution.id,
            snapshot?.executionId ?? null,
            `${execution.id}.%`,
          )
          .all<{ id: string }>();
        if (approvalRow.results.length === 1) {
          const recovery = await reconcileApprovedExecution(
            ctx,
            services,
            database(ctx),
            approvalRow.results[0].id,
            execution,
            source,
            execution.hash,
          );
          if (recovery.state !== "pending") {
            const terminal = await replayResult(store, execution);
            if (terminal) return terminal;
            throw new Error("owner execution terminal replay is unavailable");
          }
        }
        return {
          status: "failed",
          engine_result: "SUBMISSION_PENDING",
          detail: "The owner-signed transaction does not yet have a final validated result",
        };
      }
      let status: Awaited<ReturnType<NonNullable<ExecutionServices["status"]>>>;
      try {
        status = await services.status(ctx, sourceNetwork, execution.hash);
      } catch {
        return {
          status: "failed",
          engine_result: "SUBMISSION_PENDING",
          detail: "Transaction status is unavailable; the account sequence remains fenced",
        };
      }
      const network = sourceNetwork;
      const finalStatus = finalStatusFromService(
        status,
        network,
        execution.hash,
        source,
      );
      if (finalStatus) {
        const signer = await readDelegatedSigner(store, execution);
        const result: ExecResult =
          finalStatus.engine_result === "tesSUCCESS"
            ? {
                status: "executed",
                hash: execution.hash,
                ledger_index: finalStatus.ledger_index,
                result: "success",
                signed_by: "delegate",
                ...(signer ? { signer } : {}),
              }
            : {
                status: "failed",
                engine_result: finalStatus.engine_result,
                detail: "Transaction reached a validated ledger without tesSUCCESS",
              };
        await releaseAccountSequenceValidated(
          database(ctx), execution, network, sourceOwner, execution.hash,
          finalStatus.ledger_index, finalStatus.engine_result,
          nowFor(services).toISOString(),
        );
        await completeDelegatedExecution(
          database(ctx),
          ctx.principal,
          execution,
          sourceOwner,
          result,
          new Date().toISOString(),
        );
        return result;
      }
      let proof: Awaited<ReturnType<typeof proveExpiredTransaction>>;
      try {
        proof = await proveExpiredTransaction(ctx, network, execution.hash, source);
      } catch {
        return {
          status: "failed",
          engine_result: "SUBMISSION_PENDING",
          detail: "Ledger reconciliation is unavailable; the account sequence remains fenced",
        };
      }
      if (proof.state === "included") {
        const result: ExecResult =
          proof.status.engine_result === "tesSUCCESS"
            ? {
                status: "executed",
                hash: execution.hash,
                ledger_index: proof.status.ledger_index,
                result: "success",
                signed_by: "delegate",
              }
            : {
                status: "failed",
                engine_result: proof.status.engine_result,
                detail: "Transaction reached a validated ledger without tesSUCCESS",
              };
        await releaseAccountSequenceValidated(
          database(ctx), execution, network, sourceOwner, execution.hash,
          proof.status.ledger_index, proof.status.engine_result,
          nowFor(services).toISOString(),
        );
        await completeDelegatedExecution(
          database(ctx),
          ctx.principal,
          execution,
          sourceOwner,
          result,
          nowFor(services).toISOString(),
        );
        return result;
      }
      if (proof.state === "absent") {
        const result: ExecResult = {
          status: "failed",
          engine_result: "tefMAX_LEDGER",
          detail: "Transaction was absent after its LastLedgerSequence",
        };
        await releaseAccountSequenceAbsent(
          database(ctx), execution, network, sourceOwner, execution.hash,
          proof.validatedHead, proof.checkedFrom, proof.checkedThrough,
          nowFor(services).toISOString(),
        );
        await completeDelegatedExecution(
          database(ctx),
          ctx.principal,
          execution,
          sourceOwner,
          result,
          nowFor(services).toISOString(),
        );
        return result;
      }
    }
    return {
      status: "failed",
      engine_result: "SUBMISSION_PENDING",
      detail: "The submitted transaction does not yet have a final validated result",
    };
  }
  if (execution.status === "pending") {
    const snapshot = await store.getExecutionSnapshot(execution.id);
    const baseBuild = await store.getBuild(execution.buildId);
    const owner = snapshot?.snapshotOwner ?? baseBuild?.owner;
    const storedNetwork = snapshot?.snapshotNetwork ?? baseBuild?.network;
    if (owner && storedNetwork) {
      const sequenceLease = await new AccountSequenceLeaseAuthority(
        database(ctx),
      ).get({ network: executionNetwork(storedNetwork), account: owner });
      if (sequenceLease?.attemptId === execution.id && sequenceLease.state !== "released") {
        return {
          status: "failed",
          engine_result: "SUBMISSION_PENDING",
          detail: "The account sequence remains fenced pending operator reconciliation",
        };
      }
    }
  }
  const replay = await replayResult(store, execution);
  if (replay) return replay;
  if (
    execution.status === "pending" &&
    nowFor(services).getTime() - Date.parse(execution.createdAt) >= STALE_PENDING_MS
  ) {
    const snapshot = await store.getExecutionSnapshot(execution.id);
    const baseBuild = await store.getBuild(execution.buildId);
    assertIsolatedBuildCapability(ctx, baseBuild);
    assertIsolatedSnapshotTestnet(ctx, snapshot);
    const build = snapshot ? null : baseBuild;
    const owner = snapshot?.snapshotOwner ?? build?.owner;
    if (owner) {
      const sequenceLease = await new AccountSequenceLeaseAuthority(
        database(ctx),
      ).get({
        network: executionNetwork(snapshot?.snapshotNetwork ?? build!.network),
        account: owner,
      });
      if (
        sequenceLease?.attemptId === execution.id &&
        sequenceLease.state !== "released"
      ) {
        return {
          status: "failed",
          engine_result: "SUBMISSION_PENDING",
          detail: "The account sequence remains fenced pending ledger reconciliation",
        };
      }
      const result: ExecResult = {
        status: "failed",
        engine_result: "EXECUTION_INTERRUPTED",
        detail: "The worker stopped before the transaction was submitted",
      };
      if (execution.usdValue === null && execution.signedBy === null) {
        const receipt = await readExecutionClaim(store, execution);
        if (receipt) {
          return failStaleNeutralClaim(
            database(ctx),
            store,
            execution,
            owner,
            receipt,
            result,
            nowFor(services).toISOString(),
          );
        }
      }
      await completeDelegatedExecution(
        database(ctx),
        ctx.principal,
        execution,
        owner,
        result,
        new Date().toISOString(),
      );
      return result;
    }
  }
  return {
    status: "failed",
    engine_result: "EXECUTION_IN_PROGRESS",
    detail: "The first request for this idempotency key is still in progress",
  };
}

async function completeClaimedTerminalExecutionAtomic(
  db: D1Database,
  store: Store,
  input: {
    id: string;
    buildId: string;
    idempotencyKey: string;
    status: "blocked" | "needs_approval" | "failed";
    usdValue: number;
    createdAt: string;
    owner: string;
    result: ExecResult;
    mode: ExecutionClaimMode;
    approval?: {
      id: string;
      txJson: Record<string, unknown>;
      expiresAt: string;
      executionContract?: "xrpl_execution_v2";
      buildRevision?: number;
    };
    snapshot?: ExecutionSnapshotInsert;
    dailyCapUsd?: number;
  },
): Promise<boolean> {
  const completionDate = new Date(input.createdAt);
  const spendDay = completionDate.toISOString().slice(0, 10);
  const statements = [
    db
      .prepare(
        `UPDATE executions AS target
            SET status = ?, usd_value = ?, signed_by = NULL
          WHERE target.principal = ? AND target.id = ?
            AND target.build_id = ? AND target.idempotency_key = ?
            AND target.status = 'pending' AND target.hash IS NULL
            AND target.usd_value IS NULL AND target.signed_by IS NULL
            AND EXISTS (
              SELECT 1 FROM events AS claim
               WHERE claim.principal = target.principal
                 AND claim.id = ? AND claim.kind = 'execution_claim'
                 AND json_extract(claim.detail, '$.build_id') = ?
                 AND json_extract(claim.detail, '$.execution_mode') = ?
            )
            AND (? IS NULL OR COALESCE((
              SELECT SUM(e.usd_value)
                FROM executions AS e
                LEFT JOIN execution_snapshots AS s
                  ON s.principal = e.principal AND s.execution_id = e.id
                LEFT JOIN builds AS b
                  ON b.principal = e.principal AND b.id = e.build_id
               WHERE e.principal = target.principal AND e.id <> target.id
                 AND COALESCE(s.snapshot_owner, b.owner) = ?
                 AND COALESCE(s.snapshot_network, b.network) = ?
                 AND e.status IN ('pending', 'submitted', 'executed', 'needs_approval')
                 AND e.created_at >= ?
            ), 0) + COALESCE((
              SELECT SUM(spend.amount_microusd) / 1000000.0
                FROM ap4m_spend AS spend
                JOIN ap4m_mandates AS mandate
                  ON mandate.principal = spend.principal AND mandate.id = spend.mandate_id
               WHERE spend.principal = target.principal
                 AND mandate.owner = ? AND mandate.network = ?
                 AND spend.spend_day = ? AND spend.status IN ('reserved', 'committed')
            ), 0) + ? <= ?)`,
      )
      .bind(
        input.status,
        input.usdValue,
        store.principal,
        input.id,
        input.buildId,
        input.idempotencyKey,
        claimEventId(input.id),
        input.buildId,
        input.mode,
        input.dailyCapUsd ?? null,
        input.owner,
        input.snapshot?.snapshotNetwork ?? null,
        utcDayStart(completionDate),
        input.owner,
        input.snapshot?.snapshotNetwork ?? null,
        spendDay,
        input.usdValue,
        input.dailyCapUsd ?? null,
      ),
    db
      .prepare(
        `INSERT INTO events (id, principal, owner, kind, detail, created_at)
         SELECT ?, ?, ?, 'execution_result', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM executions
             WHERE principal = ? AND id = ? AND build_id = ?
               AND idempotency_key = ? AND status = ? AND usd_value = ?
          )
            AND NOT EXISTS (
              SELECT 1 FROM events WHERE principal = ? AND id = ?
            )`,
      )
      .bind(
        resultEventId(input.id),
        store.principal,
        input.owner,
        JSON.stringify({ result: input.result }),
        input.createdAt,
        store.principal,
        input.id,
        input.buildId,
        input.idempotencyKey,
        input.status,
        input.usdValue,
        store.principal,
        resultEventId(input.id),
      ),
  ];
  if (input.approval) {
    statements.push(
      db
        .prepare(
          `INSERT INTO approvals
            (id, principal, build_id, tx_json, expires_at, status,
             execution_id, execution_contract, build_revision)
           SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM executions
               WHERE principal = ? AND id = ? AND build_id = ?
                 AND idempotency_key = ? AND status = 'needs_approval'
                 AND usd_value = ?
            )
              AND EXISTS (
                SELECT 1 FROM events
                 WHERE principal = ? AND id = ? AND kind = 'execution_result'
              )`,
        )
        .bind(
          input.approval.id,
          store.principal,
          input.buildId,
          JSON.stringify(input.approval.txJson),
          input.approval.expiresAt,
          input.approval.executionContract === "xrpl_execution_v2"
            ? input.id
            : null,
          input.approval.executionContract ?? null,
          input.approval.buildRevision ?? null,
          store.principal,
          input.id,
          input.buildId,
          input.idempotencyKey,
          input.usdValue,
          store.principal,
          resultEventId(input.id),
        ),
    );
  }
  if (input.snapshot) {
    statements.push(
      prepareConditionalSnapshotInsert(
        db,
        store.principal,
        input.snapshot,
        { status: "needs_approval", signedBy: null },
      ),
    );
  }
  const results = await db.batch(statements);
  return results.every((result) => changes(result) === 1);
}

async function failStaleNeutralClaim(
  db: D1Database,
  store: Store,
  execution: ExecutionRow,
  owner: string,
    receipt: {
      buildId: string;
      mode: ExecutionClaimMode;
      executionContract: ExecutionContract;
      buildRevision: number | null;
    },
  result: Extract<ExecResult, { status: "failed" }>,
  createdAt: string,
): Promise<ReplayExecutionResult> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE executions AS target
            SET status = 'failed'
          WHERE target.principal = ? AND target.id = ?
            AND target.build_id = ? AND target.idempotency_key = ?
            AND target.status = 'pending' AND target.hash IS NULL
            AND target.usd_value IS NULL AND target.signed_by IS NULL
            AND EXISTS (
              SELECT 1 FROM events AS claim
               WHERE claim.principal = target.principal
                 AND claim.id = ? AND claim.kind = 'execution_claim'
                 AND json_extract(claim.detail, '$.build_id') = ?
                 AND json_extract(claim.detail, '$.execution_mode') = ?
            )`,
      )
      .bind(
        store.principal,
        execution.id,
        receipt.buildId,
        execution.idempotencyKey,
        claimEventId(execution.id),
        receipt.buildId,
        receipt.mode,
      ),
    db
      .prepare(
        `INSERT INTO events (id, principal, owner, kind, detail, created_at)
         SELECT ?, ?, ?, 'execution_result', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM executions
             WHERE principal = ? AND id = ? AND build_id = ?
               AND idempotency_key = ? AND status = 'failed'
               AND hash IS NULL AND usd_value IS NULL AND signed_by IS NULL
          )
            AND NOT EXISTS (
              SELECT 1 FROM events WHERE principal = ? AND id = ?
            )`,
      )
      .bind(
        resultEventId(execution.id),
        store.principal,
        owner,
        JSON.stringify({ result }),
        createdAt,
        store.principal,
        execution.id,
        receipt.buildId,
        execution.idempotencyKey,
        store.principal,
        resultEventId(execution.id),
      ),
  ]);
  if (results.every((statement) => changes(statement) === 1)) {
    return result;
  }
  const replay = await replayResult(store, execution);
  if (!replay) throw new Error("stale execution claim could not be failed");
  return replay;
}

function executionIdForApproval(approval: ApprovalRow): string {
  if (approval.executionContract === "xrpl_execution_v2") {
    if (!approval.executionId) {
      throw new ExecutionLifetimeError(
        "The v2 approval has no explicit execution binding",
        "EXECUTION_SNAPSHOT_INVALID",
      );
    }
    return approval.executionId;
  }
  const separator = approval.id.indexOf(".");
  if (separator < 1) throw new Error("approval is not linked to an execution");
  return approval.id.slice(0, separator);
}

type ApprovalClaim = {
  execution: ExecutionRow;
  mode: "claimed" | "resume";
};

/**
 * Atomically bind an owner-signed blob to its exact execution and reserve the
 * current daily allowance before the first network submission. The persisted
 * hash makes ambiguous retries safe: another blob can never reuse the claim.
 */
async function claimApprovalBudget(
  db: D1Database,
  store: Store,
  principal: string,
  approval: ApprovalRow,
  build: BuildRow,
  hash: string,
  dailyCapUsd: number,
  now: Date,
  v2 = false,
): Promise<ApprovalClaim> {
  if (!Number.isFinite(dailyCapUsd) || dailyCapUsd < 0) {
    throw new Error("daily cap is invalid");
  }
  const spendDay = now.toISOString().slice(0, 10);
  const executionId = executionIdForApproval(approval);
  const execution = await store.getExecution(executionId);
  if (!execution || execution.buildId !== approval.buildId) {
    throw new Error("approval execution not found");
  }

  if (approval.status === "submitted") {
    if (
      execution.status !== "submitted" ||
      execution.signedBy !== "owner" ||
      execution.hash?.toUpperCase() !== hash
    ) {
      throw new Error("approval submission does not match its reserved transaction");
    }
    return { execution, mode: "resume" };
  }
  const claimableStatus = v2 ? "preflighted" : "pending";
  if (approval.status !== claimableStatus) {
    throw new Error("approval is not available for submission");
  }

  const results = await db.batch([
    db
      .prepare(
        `UPDATE executions AS target
            SET status = 'submitted', hash = ?, signed_by = 'owner', created_at = ?
          WHERE target.principal = ? AND target.id = ? AND target.build_id = ?
            AND target.status = 'needs_approval'
            AND target.usd_value IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM approvals AS a
               WHERE a.principal = target.principal AND a.id = ?
                 AND a.build_id = target.build_id AND a.status = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM approval_preflight_rejections AS r
               WHERE r.principal = target.principal
                 AND r.execution_id = target.id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM executions AS active_e
                LEFT JOIN execution_snapshots AS active_s
                  ON active_s.principal = active_e.principal
                 AND active_s.execution_id = active_e.id
                LEFT JOIN builds AS active_b
                  ON active_b.id = active_e.build_id
                 AND active_b.principal = active_e.principal
               WHERE active_e.principal = target.principal
                 AND active_e.id <> target.id
                 AND COALESCE(active_s.snapshot_owner, active_b.owner) = ?
                 AND COALESCE(active_s.snapshot_network, active_b.network) = ?
                 AND active_e.status IN ('pending', 'submitted')
            )
            AND COALESCE((
              SELECT SUM(e.usd_value)
                FROM executions AS e
                LEFT JOIN execution_snapshots AS s
                  ON s.principal = e.principal AND s.execution_id = e.id
                LEFT JOIN builds AS b
                  ON b.id = e.build_id AND b.principal = e.principal
               WHERE e.principal = target.principal
                 AND e.id <> target.id
                 AND COALESCE(s.snapshot_owner, b.owner) = ?
                 AND COALESCE(s.snapshot_network, b.network) = ?
                 AND e.status IN ('pending', 'submitted', 'executed')
                 AND e.created_at >= ?
            ), 0) + COALESCE((
              SELECT SUM(spend.amount_microusd) / 1000000.0
                FROM ap4m_spend AS spend
                JOIN ap4m_mandates AS mandate
                  ON mandate.principal = spend.principal AND mandate.id = spend.mandate_id
               WHERE spend.principal = target.principal
                 AND mandate.owner = ? AND mandate.network = ?
                 AND spend.spend_day = ? AND spend.status IN ('reserved', 'committed')
            ), 0) + target.usd_value <= ?`,
      )
      .bind(
        hash,
        now.toISOString(),
        principal,
        executionId,
        approval.buildId,
        approval.id,
        claimableStatus,
        build.owner,
        build.network,
        build.owner,
        build.network,
        utcDayStart(now),
        build.owner,
        build.network,
        spendDay,
        dailyCapUsd,
      ),
    db
      .prepare(
        `UPDATE approvals
            SET status = 'submitted'
          WHERE principal = ? AND id = ? AND build_id = ? AND status = ?
            AND NOT EXISTS (
              SELECT 1 FROM approval_preflight_rejections AS r
               WHERE r.principal = approvals.principal
                 AND r.approval_id = approvals.id
            )
            AND EXISTS (
              SELECT 1 FROM executions
               WHERE principal = ? AND id = ? AND build_id = ?
                 AND status = 'submitted' AND signed_by = 'owner' AND hash = ?
            )`,
      )
      .bind(
        principal,
        approval.id,
        approval.buildId,
        claimableStatus,
        principal,
        executionId,
        approval.buildId,
        hash,
      ),
  ]);
  if (changes(results[0]) === 1 && changes(results[1]) === 1) {
    const claimed = await store.getExecution(executionId);
    if (!claimed) throw new Error("reserved approval execution was not found");
    return { execution: claimed, mode: "claimed" };
  }

  const [currentApproval, currentExecution] = await Promise.all([
    store.getApproval(approval.id),
    store.getExecution(executionId),
  ]);
  if (
    currentApproval?.status === "submitted" &&
    currentExecution?.status === "submitted" &&
    currentExecution.signedBy === "owner" &&
    currentExecution.hash?.toUpperCase() === hash
  ) {
    return { execution: currentExecution, mode: "resume" };
  }
  throw new Error(
    "approval budget could not be reserved because its cap or execution slot is unavailable",
  );
}

async function expirePendingApprovalAtomic(
  db: D1Database,
  store: Store,
  approval: ApprovalRow,
): Promise<ApprovalRow> {
  const expired = await db
    .prepare(
      `UPDATE approvals
          SET status = 'expired'
        WHERE principal = ? AND id = ? AND build_id = ?
          AND status IN ('pending', 'preflighted')`,
    )
    .bind(store.principal, approval.id, approval.buildId)
    .run();
  const current = await store.getApproval(approval.id);
  if (!current || current.buildId !== approval.buildId) {
    throw new Error("approval state could not be read after expiry claim");
  }
  if (changes(expired) === 1) {
    if (current.status !== "expired") {
      throw new Error("approval expiry transition is inconsistent");
    }
    return current;
  }
  if (current.status === "pending" || current.status === "preflighted") {
    throw new Error("approval expiry transition did not resolve");
  }
  return current;
}

async function completeApprovedExecution(
  db: D1Database,
  principal: string,
  approvalId: string,
  executionId: string,
  expectedHash: string,
  result: ValidatedSubmission,
): Promise<void> {
  const replay: OwnerExecutedResult = {
    status: "executed",
    hash: result.hash.toUpperCase(),
    ledger_index: result.ledger_index,
    result: "success",
    signed_by: "owner",
  };
  const results = await db.batch([
    db
      .prepare(
        `UPDATE executions
            SET status = 'executed'
          WHERE principal = ? AND id = ? AND status = 'submitted'
            AND signed_by = 'owner' AND hash = ?`,
      )
      .bind(principal, executionId, expectedHash),
    db
      .prepare(
        `UPDATE approvals
            SET status = 'approved'
          WHERE principal = ? AND id = ? AND status = 'submitted'
            AND EXISTS (
              SELECT 1 FROM executions
               WHERE principal = ? AND id = ? AND status = 'executed'
                 AND signed_by = 'owner' AND hash = ?
            )`,
      )
      .bind(principal, approvalId, principal, executionId, expectedHash),
    db
      .prepare(
        `UPDATE events
            SET detail = ?
          WHERE principal = ? AND id = ? AND kind = 'execution_result'
            AND EXISTS (
              SELECT 1 FROM executions AS e
              JOIN approvals AS a ON a.principal = e.principal
               AND a.id = ? AND a.build_id = e.build_id
             WHERE e.principal = ? AND e.id = ? AND e.status = 'executed'
               AND e.signed_by = 'owner' AND e.hash = ?
               AND a.status = 'approved'
            )`,
      )
      .bind(
        JSON.stringify({ result: replay }),
        principal,
        resultEventId(executionId),
        approvalId,
        principal,
        executionId,
        expectedHash,
      ),
  ]);
  if (
    changes(results[0]) === 1 &&
    changes(results[1]) === 1 &&
    changes(results[2]) === 1
  ) {
    return;
  }
  const rows = await db
    .prepare(
      `SELECT e.status AS execution_status, e.hash, a.status AS approval_status,
              ev.detail AS event_detail
         FROM executions AS e
         JOIN approvals AS a ON a.principal = e.principal AND a.id = ?
         JOIN events AS ev ON ev.principal = e.principal AND ev.id = ?
        WHERE e.principal = ? AND e.id = ?`,
    )
    .bind(approvalId, resultEventId(executionId), principal, executionId)
    .first<{
      execution_status: string;
      hash: string | null;
      approval_status: string;
      event_detail: string;
    }>();
  let replayMatches = false;
  try {
    const detail = JSON.parse(rows?.event_detail ?? "null") as unknown;
    const parsed = OwnerExecutedResultSchema.safeParse(
      isRecord(detail) ? detail.result : undefined,
    );
    replayMatches =
      parsed.success &&
      parsed.data.hash.toUpperCase() === result.hash.toUpperCase() &&
      parsed.data.ledger_index === result.ledger_index;
  } catch {
    replayMatches = false;
  }
  if (
    rows?.execution_status !== "executed" ||
    rows.approval_status !== "approved" ||
    rows.hash?.toUpperCase() !== result.hash.toUpperCase() ||
    !replayMatches
  ) {
    throw new Error("approved execution could not be completed consistently");
  }
}

async function failApprovedExecution(
  db: D1Database,
  principal: string,
  approvalId: string,
  executionId: string,
  expectedHash: string,
  result: FailedExecutionResult,
): Promise<void> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE executions
            SET status = 'failed'
          WHERE principal = ? AND id = ? AND status = 'submitted'
            AND signed_by = 'owner' AND hash = ?`,
      )
      .bind(principal, executionId, expectedHash),
    db
      .prepare(
        `UPDATE approvals
            SET status = 'rejected'
          WHERE principal = ? AND id = ? AND status = 'submitted'
            AND EXISTS (
              SELECT 1 FROM executions
               WHERE principal = ? AND id = ? AND status = 'failed'
                 AND signed_by = 'owner' AND hash = ?
            )`,
      )
      .bind(principal, approvalId, principal, executionId, expectedHash),
    db
      .prepare(
        `UPDATE events
            SET detail = ?
          WHERE principal = ? AND id = ? AND kind = 'execution_result'
            AND EXISTS (
              SELECT 1 FROM executions AS e
              JOIN approvals AS a ON a.principal = e.principal
               AND a.id = ? AND a.build_id = e.build_id
             WHERE e.principal = ? AND e.id = ? AND e.status = 'failed'
               AND e.signed_by = 'owner' AND e.hash = ?
               AND a.status = 'rejected'
            )`,
      )
      .bind(
        JSON.stringify({ result }),
        principal,
        resultEventId(executionId),
        approvalId,
        principal,
        executionId,
        expectedHash,
      ),
  ]);
  if (
    changes(results[0]) === 1 &&
    changes(results[1]) === 1 &&
    changes(results[2]) === 1
  ) {
    return;
  }
  const row = await db
    .prepare(
      `SELECT e.status AS execution_status, e.hash, a.status AS approval_status,
              ev.detail AS event_detail
         FROM executions AS e
         JOIN approvals AS a ON a.principal = e.principal AND a.id = ?
         JOIN events AS ev ON ev.principal = e.principal AND ev.id = ?
        WHERE e.principal = ? AND e.id = ?`,
    )
    .bind(approvalId, resultEventId(executionId), principal, executionId)
    .first<{
      execution_status: string;
      hash: string | null;
      approval_status: string;
      event_detail: string;
    }>();
  let replayMatches = false;
  try {
    const detail = JSON.parse(row?.event_detail ?? "null") as unknown;
    const parsed = ExecResultSchema.safeParse(
      isRecord(detail) ? detail.result : undefined,
    );
    replayMatches =
      parsed.success &&
      parsed.data.status === "failed" &&
      parsed.data.engine_result === result.engine_result;
  } catch {
    replayMatches = false;
  }
  if (
    row?.execution_status !== "failed" ||
    row.approval_status !== "rejected" ||
    row.hash?.toUpperCase() !== expectedHash ||
    !replayMatches
  ) {
    throw new Error("rejected execution could not be completed consistently");
  }
}

type ApprovalReconciliation =
  | { state: "pending" }
  | { state: "failed" }
  | { state: "validated"; result: ValidatedSubmission };

async function reconcileApprovedExecution(
  ctx: OpContext,
  services: ExecutionServices,
  db: D1Database,
  approvalId: string,
  execution: ExecutionRow,
  source: BuildRow | ExecutionSnapshotRow,
  hash: string,
): Promise<ApprovalReconciliation> {
  if (!services.status) {
    throw new Error("transaction status service is not configured");
  }
  const network = executionNetwork(
    "snapshotOwner" in source ? source.snapshotNetwork : source.network,
  );
  const owner = "snapshotOwner" in source ? source.snapshotOwner : source.owner;
  const status = await services.status(ctx, network, hash);
  let finalStatus = finalStatusFromService(status, network, hash, source);
  if (!finalStatus) {
    const proof = await proveExpiredTransaction(ctx, network, hash, source);
    if (proof.state === "included") finalStatus = proof.status;
    if (proof.state === "absent") {
      await releaseAccountSequenceAbsent(
        db, execution, network, owner, hash, proof.validatedHead,
        proof.checkedFrom, proof.checkedThrough, nowFor(services).toISOString(),
      );
      await failApprovedExecution(
        db,
        ctx.principal,
        approvalId,
        execution.id,
        hash,
        {
          status: "failed",
          engine_result: "tefMAX_LEDGER",
          detail: "Owner-signed transaction was absent after its LastLedgerSequence",
        },
      );
      return { state: "failed" };
    }
  }
  if (finalStatus) {
    await releaseAccountSequenceValidated(
      db, execution, network, owner, hash, finalStatus.ledger_index,
      finalStatus.engine_result, nowFor(services).toISOString(),
    );
    if (finalStatus.engine_result === "tesSUCCESS") {
      const result: ValidatedSubmission = {
        hash,
        ledger_index: finalStatus.ledger_index,
        engine_result: finalStatus.engine_result,
        validated: true,
      };
      await completeApprovedExecution(
        db,
        ctx.principal,
        approvalId,
        execution.id,
        hash,
        result,
      );
      return { state: "validated", result };
    }
    await failApprovedExecution(
      db,
      ctx.principal,
      approvalId,
      execution.id,
      hash,
      {
        status: "failed",
        engine_result: finalStatus.engine_result,
        detail: "Owner-signed transaction reached a validated ledger without tesSUCCESS",
      },
    );
    return { state: "failed" };
  }
  return { state: "pending" };
}

async function completeDelegatedExecution(
  db: D1Database,
  principal: string,
  execution: ExecutionRow,
  owner: string,
  result: ExecResult,
  createdAt: string,
): Promise<void> {
  if (
    result.status !== "executed" &&
    result.status !== "failed" &&
    result.status !== "blocked"
  ) {
    throw new Error("delegated terminal result is invalid");
  }
  const status = result.status;
  const hash = result.status === "executed" ? result.hash : execution.hash;
  await db.batch([
    db
      .prepare(
        `UPDATE executions
            SET status = ?, hash = ?, signed_by = 'delegate'
          WHERE principal = ? AND id = ?
            AND status IN ('pending', 'submitted')
            AND (hash = ? OR (hash IS NULL AND ? IS NULL))`,
      )
      .bind(
        status,
        hash,
        principal,
        execution.id,
        execution.hash,
        execution.hash,
      ),
    db
      .prepare(
        `INSERT INTO events (id, principal, owner, kind, detail, created_at)
         SELECT ?, ?, ?, 'execution_result', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM executions
             WHERE principal = ? AND id = ? AND status = ?
               AND (hash = ? OR (hash IS NULL AND ? IS NULL))
          )
            AND NOT EXISTS (
              SELECT 1 FROM events WHERE principal = ? AND id = ?
            )`,
      )
      .bind(
        resultEventId(execution.id),
        principal,
        owner,
        JSON.stringify({ result }),
        createdAt,
        principal,
        execution.id,
        status,
        hash,
        hash,
        principal,
        resultEventId(execution.id),
      ),
  ]);
  if (result.status === "executed") {
    result.confirmation = await projectExecutionConfirmation(db, {
      principal,
      executionId: execution.id,
      hash: result.hash,
      pollAt: createdAt,
    });
  }
}

async function releaseStalePendingReservations(
  db: D1Database,
  principal: string,
  owner: string,
  network: Network,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - STALE_PENDING_MS).toISOString();
  const rows = await db
    .prepare(
      `SELECT e.id
         FROM executions AS e
         LEFT JOIN execution_snapshots AS s
           ON s.principal = e.principal AND s.execution_id = e.id
         LEFT JOIN builds AS b
           ON b.id = e.build_id AND b.principal = e.principal
        WHERE e.principal = ?
          AND COALESCE(s.snapshot_owner, b.owner) = ?
          AND COALESCE(s.snapshot_network, b.network) = ?
          AND e.status = 'pending' AND e.created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM account_sequence_leases AS l
             WHERE l.network = COALESCE(s.snapshot_network, b.network)
               AND l.account = COALESCE(s.snapshot_owner, b.owner)
               AND l.attempt_id = e.id AND l.state <> 'released'
          )`,
    )
    .bind(principal, owner, network, cutoff)
    .all<{ id: string }>();
  const result: ExecResult = {
    status: "failed",
    engine_result: "EXECUTION_INTERRUPTED",
    detail: "The worker stopped before the transaction was submitted",
  };
  for (const row of rows.results) {
    await db.batch([
      db
        .prepare(
          "UPDATE executions SET status = 'failed' WHERE principal = ? AND id = ? AND status = 'pending'",
        )
        .bind(principal, row.id),
      db
        .prepare(
          `INSERT INTO events (id, principal, owner, kind, detail, created_at)
           SELECT ?, ?, ?, 'execution_result', ?, ?
            WHERE EXISTS (
              SELECT 1 FROM executions
               WHERE principal = ? AND id = ? AND status = 'failed'
            )
              AND NOT EXISTS (
                SELECT 1 FROM events WHERE principal = ? AND id = ?
              )`,
        )
        .bind(
          resultEventId(row.id),
          principal,
          owner,
          JSON.stringify({ result }),
          now.toISOString(),
          principal,
          row.id,
          principal,
          resultEventId(row.id),
        ),
    ]);
  }
}

async function inFlightExecution(
  db: D1Database,
  store: Store,
  principal: string,
  owner: string,
  network: Network,
  excludeExecutionId: string,
): Promise<ExecutionRow | null> {
  const row = await db
    .prepare(
      `SELECT e.id
         FROM executions AS e
         LEFT JOIN execution_snapshots AS s
           ON s.principal = e.principal AND s.execution_id = e.id
         LEFT JOIN builds AS b
           ON b.id = e.build_id AND b.principal = e.principal
        WHERE e.principal = ? AND e.id <> ?
          AND COALESCE(s.snapshot_owner, b.owner) = ?
          AND COALESCE(s.snapshot_network, b.network) = ?
          AND e.status IN ('pending', 'submitted')
        ORDER BY e.created_at, e.id
        LIMIT 1`,
    )
    .bind(principal, excludeExecutionId, owner, network)
    .first<{ id: string }>();
  return row ? store.getExecution(row.id) : null;
}

function finiteUsdValue(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("policy USD value is invalid");
  }
  return value;
}

async function markDelegatedSubmitted(
  db: D1Database,
  input: {
    principal: string;
    executionId: string;
    owner: string;
    hash: string;
    createdAt: string;
    signer?: Signer;
  },
): Promise<boolean> {
  const update = db
    .prepare(
      `UPDATE executions
          SET status = 'submitted', hash = ?, signed_by = 'delegate', created_at = ?
        WHERE principal = ? AND id = ? AND status = 'pending'
          AND hash IS NULL AND signed_by = 'delegate'`,
    )
    .bind(input.hash, input.createdAt, input.principal, input.executionId);
  if (!input.signer) {
    return changes(await update.run()) === 1;
  }
  const results = await db.batch([
    update,
    db
      .prepare(
        `INSERT INTO events (id, principal, owner, kind, detail, created_at)
         SELECT ?, ?, ?, 'execution_signer', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM executions
             WHERE principal = ? AND id = ? AND status = 'submitted'
               AND hash = ? AND signed_by = 'delegate'
          )
            AND NOT EXISTS (
              SELECT 1 FROM events WHERE principal = ? AND id = ?
            )`,
      )
      .bind(
        signerEventId(input.executionId),
        input.principal,
        input.owner,
        JSON.stringify({ signer: input.signer }),
        input.createdAt,
        input.principal,
        input.executionId,
        input.hash,
        input.principal,
        signerEventId(input.executionId),
      ),
  ]);
  if (changes(results[0]) === 1 && changes(results[1]) === 1) return true;
  if (changes(results[0]) === 0 && changes(results[1]) === 0) return false;
  throw new Error("delegated signer provenance could not be persisted consistently");
}

function submissionResult(
  submission: ValidatedSubmission,
  signer?: Signer,
): Extract<ExecResult, { status: "executed" }> {
  return {
    status: "executed",
    hash: submission.hash,
    ledger_index: submission.ledger_index,
    result: "success",
    signed_by: "delegate",
    ...(signer ? { signer } : {}),
  };
}

async function replayRequiredOwnerApproval(
  store: Store,
  execution: ExecutionRow,
  buildId: string,
): Promise<ReplayExecutionResult> {
  if (execution.buildId !== buildId) {
    throw new Error(
      "owner-approval idempotency key belongs to a different build",
    );
  }
  if (!["needs_approval", "blocked", "failed"].includes(execution.status)) {
    throw new Error(
      "owner approval cannot be required after delegated execution has started",
    );
  }
  const replay = await replayResult(store, execution);
  if (!replay || replay.status === "executed") {
    throw new Error("owner-approval execution replay is unavailable");
  }
  return replay;
}

async function assertLocalBuildCapability(
  ctx: OpContext,
  store: Store,
  build: BuildRow,
  idempotencyKey?: string,
): Promise<void> {
  assertIsolatedBuildCapability(ctx, build);
  if (localTradingIsolatedV1MarkersPresent(ctx.env)) {
    return;
  }
  if (localTradingIsolatedOnboardingV1MarkersPresent(ctx.env)) {
    await assertOnboardingBuildCapability(
      ctx,
      store,
      build,
      LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
      idempotencyKey,
      "Isolated local trading onboarding requires a build created by the isolated onboarding profile",
    );
    return;
  }
  if (localTradingMarkersPresent(ctx.env)) {
    if (build.originProfile !== LOCAL_TRADING_BUILD_ORIGIN) {
      throw new Error(
        "Local trading requires a build created by the trading profile",
      );
    }
    return;
  }
  if (!localTradingOnboardingMarkersPresent(ctx.env)) return;
  await assertOnboardingBuildCapability(
    ctx,
    store,
    build,
    LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
    idempotencyKey,
    "Local trading onboarding requires a build created by the onboarding profile",
  );
}

async function assertOnboardingBuildCapability(
  ctx: OpContext,
  store: Store,
  build: BuildRow,
  expectedOrigin: BuildRow["originProfile"],
  idempotencyKey: string | undefined,
  originError: string,
): Promise<void> {
  if (build.originProfile !== expectedOrigin) {
    throw new Error(originError);
  }
  if (build.txJson.TransactionType !== "TrustSet") {
    throw new Error("Local trading onboarding executes only TrustSet builds");
  }
  if (idempotencyKey !== undefined) {
    const consumption = await readBuildConsumption(
      database(ctx),
      store.principal,
      build.id,
    );
    if (!consumption || consumption.idempotency_key !== idempotencyKey) {
      throw new Error("Onboarding build replay has no matching durable claim");
    }
  }
  const link = await store.getLink(build.owner, build.network);
  if (!link || link.status !== "active") {
    throw new Error("Local trading onboarding requires an active account link");
  }
}

function assertIsolatedBuildCapability(
  ctx: OpContext,
  build: BuildRow | null,
): asserts build is BuildRow {
  if (localTradingSafetyMarkersPresent(ctx.env) && build === null) {
    throw new Error(
      "Local trading requires an origin-bearing base build",
    );
  }
  const isolatedOnboardingMarkers =
    localTradingIsolatedOnboardingV1MarkersPresent(ctx.env);
  const isolatedOnboardingOrigin =
    build?.originProfile ===
    LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN;
  if (isolatedOnboardingMarkers || isolatedOnboardingOrigin) {
    if (
      !isolatedOnboardingMarkers ||
      !isolatedOnboardingOrigin ||
      !isReviewedLocalTradingIsolatedOnboardingV1Context(ctx) ||
      build?.network !== "testnet" ||
      build.txJson.TransactionType !== "TrustSet"
    ) {
      throw new Error(
        "Isolated local trading onboarding requires a TrustSet build created by the isolated onboarding profile on Testnet under the exact isolated onboarding context",
      );
    }
    return;
  }
  const isolatedMarkers = localTradingIsolatedV1MarkersPresent(ctx.env);
  const isolatedOrigin =
    build?.originProfile === LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN;
  if (!isolatedMarkers && !isolatedOrigin) return;
  if (
    !isolatedMarkers ||
    !isolatedOrigin ||
    !isReviewedLocalTradingIsolatedV1Context(ctx) ||
    build?.network !== "testnet"
  ) {
    throw new Error(
      "Isolated local trading requires a build created by the isolated profile on Testnet under the exact isolated context",
    );
  }
}

function assertIsolatedSnapshotTestnet(
  ctx: OpContext,
  snapshot: Pick<ExecutionSnapshotRow, "snapshotNetwork"> | null,
): void {
  if (
    (localTradingIsolatedV1MarkersPresent(ctx.env) ||
      localTradingIsolatedOnboardingV1MarkersPresent(ctx.env)) &&
    snapshot !== null &&
    snapshot.snapshotNetwork !== "testnet"
  ) {
    throw new Error(
      "Isolated local trading requires an authoritative Testnet snapshot",
    );
  }
}

async function exactLocalTradingPolicy(
  ctx: OpContext,
  store: Store,
  build: BuildRow,
): Promise<Policy | undefined> {
  if (!localTradingSafetyMarkersPresent(ctx.env)) return undefined;
  const policy = await store.getPolicy(build.owner, build.network);
  if (!policy) {
    throw new Error(
      "Local trading requires an exact principal, owner, and network policy before execution",
    );
  }
  return policy.json;
}

function preflightRejectionError(code: PreflightRejectionCode): ExecutionLifetimeError {
  const messages: Record<PreflightRejectionCode, string> = {
    EXECUTION_SNAPSHOT_STALE:
      "The approval preflight was rejected because its policy snapshot became stale",
    EXECUTION_SNAPSHOT_INVALID:
      "The approval preflight was rejected because its validated evidence was invalid",
    TRANSACTION_WINDOW_TOO_SHORT:
      "The approval preflight was rejected because too few validated ledgers remain",
    FEE_LOAD_UNSAFE:
      "The approval preflight was rejected because current fee or queue load is unsafe",
    ACCOUNT_SEQUENCE_CHANGED:
      "The approval preflight was rejected because the owner Sequence changed",
    BALANCE_INVARIANT_CHANGED:
      "The approval preflight was rejected because the acquisition balance changed",
  };
  return new ExecutionLifetimeError(messages[code], code);
}

async function readPreflightRejection(
  db: D1Database,
  principal: string,
  approvalId: string,
): Promise<PreflightRejectionCode | null> {
  const row = await db
    .prepare(
      `SELECT r.error_code, a.status AS approval_status,
              e.status AS execution_status, e.hash, e.signed_by,
              ev.detail AS result_detail
         FROM approval_preflight_rejections AS r
         LEFT JOIN approvals AS a
           ON a.principal = r.principal
          AND a.id = r.approval_id
          AND a.execution_id = r.execution_id
         LEFT JOIN executions AS e
           ON e.principal = r.principal AND e.id = r.execution_id
         LEFT JOIN events AS ev
           ON ev.principal = r.principal
          AND ev.id = 'execution-result:' || r.execution_id
          AND ev.kind = 'execution_result'
        WHERE r.principal = ? AND r.approval_id = ?`,
    )
    .bind(principal, approvalId)
    .first<{
      error_code: string;
      approval_status: string | null;
      execution_status: string | null;
      hash: string | null;
      signed_by: string | null;
      result_detail: string | null;
    }>();
  if (!row) return null;
  const validCode = PREFLIGHT_REJECTION_CODES.has(
    row.error_code as ExecutionLifetimeErrorCode,
  );
  let detail: { result?: Partial<ExecResult> } | null = null;
  try {
    detail = row.result_detail === null
      ? null
      : JSON.parse(row.result_detail) as { result?: Partial<ExecResult> };
  } catch {
    detail = null;
  }
  if (
    !validCode ||
    row.approval_status !== "rejected" ||
    row.execution_status !== "failed" ||
    row.hash !== null ||
    row.signed_by !== null ||
    detail?.result?.status !== "failed" ||
    detail.result.engine_result !== row.error_code ||
    detail.result.detail !== "Owner approval failed preflight before signing"
  ) {
    throw new ExecutionLifetimeError(
      "The immutable approval preflight rejection is incomplete or inconsistent",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  return row.error_code as PreflightRejectionCode;
}

async function claimPreflightRejectionAtomic(
  db: D1Database,
  store: Store,
  approval: ApprovalRow,
  code: PreflightRejectionCode,
  rejectedAt: string,
): Promise<"authorized" | PreflightRejectionCode> {
  try {
    await db
      .prepare(
        `INSERT INTO approval_preflight_rejections
            (principal, approval_id, execution_id, error_code, rejected_at)
           SELECT ?, a.id, a.execution_id, ?, ?
             FROM approvals AS a
             JOIN executions AS e
               ON e.principal = a.principal AND e.id = a.execution_id
             JOIN execution_snapshots AS s
               ON s.principal = a.principal AND s.execution_id = a.execution_id
            WHERE a.principal = ? AND a.id = ? AND a.build_id = ?
              AND a.execution_id = ? AND a.execution_contract = 'xrpl_execution_v2'
              AND a.build_revision = ? AND a.status = 'pending'
              AND e.build_id = a.build_id AND e.status = 'needs_approval'
              AND e.hash IS NULL AND e.signed_by IS NULL
              AND s.build_id = a.build_id AND s.build_revision = a.build_revision
              AND s.approval_id = a.id AND s.approval_expires_at = a.expires_at`,
      )
      .bind(
        store.principal,
        code,
        rejectedAt,
        store.principal,
        approval.id,
        approval.buildId,
        approval.executionId,
        approval.buildRevision,
      )
      .run();
  } catch {
    // A concurrent authorization/rejection can make this conditional insert
    // lose. Resolve only from the durable winner below.
  }

  const rejection = await readPreflightRejection(db, store.principal, approval.id);
  if (rejection !== null) return rejection;
  const currentApproval = await store.getApproval(approval.id);
  if (currentApproval?.status === "preflighted") return "authorized";
  throw new ExecutionLifetimeError(
    "The approval preflight rejection did not resolve atomically",
    "EXECUTION_SNAPSHOT_STALE",
  );
}

export async function handleTxApprovalPreflight(
  ctx: OpContext,
  rawArgs: TxApprovalPreflightArgs,
): Promise<{
  status: "ready";
  approval_id: string;
  expires_at: string;
  validated_ledger: number;
  remaining_ledgers: number;
  execution_capability: ExecutionCapability;
}> {
  const args = TxApprovalPreflightArgsSchema.parse(rawArgs);
  assertV2LocalProfile(ctx);
  const services = configuredServices(ctx);
  const store = storeFor(ctx, services);
  let approval = await store.getApproval(args.approval_id);
  if (!approval) throw new Error("approval not found");
  assertIsolatedBuildCapability(
    ctx,
    await store.getBuild(approval.buildId),
  );
  if (
    approval.executionContract !== "xrpl_execution_v2" ||
    approval.executionId === null ||
    approval.buildRevision === null
  ) {
    throw new ExecutionLifetimeError(
      "The approval is not a complete v2 approval",
      "EXECUTION_CONTRACT_MISMATCH",
    );
  }
  const [execution, snapshot, revision] = await Promise.all([
    store.getExecution(approval.executionId),
    store.getExecutionSnapshot(approval.executionId),
    store.getBuildRevision(approval.buildId, approval.buildRevision),
  ]);
  assertIsolatedSnapshotTestnet(ctx, snapshot);
  if (
    !execution ||
    !snapshot ||
    !revision ||
    execution.buildId !== approval.buildId ||
    snapshot.buildId !== approval.buildId ||
    snapshot.approvalId !== approval.id ||
    snapshot.approvalExpiresAt !== approval.expiresAt ||
    snapshot.snapshotOwner !== revision.owner ||
    snapshot.snapshotNetwork !== revision.network
  ) {
    throw new ExecutionLifetimeError(
      "The approval snapshot is missing or inconsistent",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  assertSnapshotMatchesRevision(snapshot, revision);
  assertV2Binding(args, snapshot);
  assertLocalTradingTestnet(ctx, snapshot.snapshotNetwork);
  const durableRejection = await readPreflightRejection(
    database(ctx),
    ctx.principal,
    approval.id,
  );
  if (durableRejection !== null) throw preflightRejectionError(durableRejection);
  if (approval.status === "rejected") {
    throw new ExecutionLifetimeError(
      "The rejected approval has no immutable preflight outcome",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  const now = nowFor(services);
  if (now.getTime() >= Date.parse(approval.expiresAt)) {
    if (approval.status === "pending") {
      approval = await expirePendingApprovalAtomic(
        database(ctx),
        store,
        approval,
      );
    }
    throw new ExecutionLifetimeError(
      "The owner approval has expired",
      "APPROVAL_EXPIRED",
    );
  }
  if (approval.status === "invalidated") {
    throw new ExecutionLifetimeError(
      "The approval was invalidated by a revision refresh",
      "APPROVAL_INVALIDATED",
    );
  }
  if (approval.status === "preflighted") {
    throw new ExecutionLifetimeError(
      "The approval was already preflighted; its prior response may have been lost",
      "APPROVAL_ALREADY_PREFLIGHTED",
    );
  }
  if (approval.status !== "pending") {
    throw new ExecutionLifetimeError(
      "The approval cannot be preflighted in its current state",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  let evidence: { validatedLedger: number; remainingLedgers: number };
  try {
    await assertApprovalMargin(
      database(ctx),
      ctx.principal,
      execution.id,
      snapshot.snapshotOwner,
      snapshot.snapshotNetwork,
      finiteUsdValue(execution.usdValue ?? 0),
      snapshot.policySnapshot.daily_cap_usd,
      now,
    );
    evidence = await validateV2LiveEvidence(
      ctx,
      snapshot,
      revision.txJson,
    );
  } catch (error) {
    if (
      !(error instanceof ExecutionLifetimeError) ||
      !PREFLIGHT_REJECTION_CODES.has(error.code)
    ) {
      throw error;
    }
    const winner = await claimPreflightRejectionAtomic(
      database(ctx),
      store,
      approval,
      error.code as PreflightRejectionCode,
      nowFor(services).toISOString(),
    );
    if (winner === "authorized") {
      throw new ExecutionLifetimeError(
        "The approval was concurrently preflighted; its other response is authoritative",
        "APPROVAL_ALREADY_PREFLIGHTED",
      );
    }
    throw preflightRejectionError(winner);
  }
  const transitioned = await database(ctx)
    .prepare(
      `UPDATE approvals
          SET status = 'preflighted'
        WHERE principal = ? AND id = ? AND build_id = ?
          AND execution_id = ? AND execution_contract = 'xrpl_execution_v2'
          AND build_revision = ? AND status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM approval_preflight_rejections AS r
             WHERE r.principal = approvals.principal
               AND r.approval_id = approvals.id
          )
          AND EXISTS (
            SELECT 1 FROM execution_snapshots AS s
             WHERE s.principal = approvals.principal
               AND s.execution_id = approvals.execution_id
               AND s.build_id = approvals.build_id
               AND s.build_revision = approvals.build_revision
               AND s.approval_id = approvals.id
               AND s.approval_expires_at = approvals.expires_at
          )`,
    )
    .bind(
      ctx.principal,
      approval.id,
      approval.buildId,
      approval.executionId,
      approval.buildRevision,
    )
    .run();
  if (changes(transitioned) !== 1) {
    const current = await store.getApproval(approval.id);
    if (current?.status === "preflighted") {
      throw new ExecutionLifetimeError(
        "The approval was concurrently preflighted; its other response is authoritative",
        "APPROVAL_ALREADY_PREFLIGHTED",
      );
    }
    if (current?.status === "rejected") {
      const rejection = await readPreflightRejection(
        database(ctx),
        ctx.principal,
        approval.id,
      );
      if (rejection !== null) throw preflightRejectionError(rejection);
    }
    throw new ExecutionLifetimeError(
      "The approval preflight transition lost its atomic claim",
      "EXECUTION_SNAPSHOT_STALE",
    );
  }
  return {
    status: "ready",
    approval_id: approval.id,
    expires_at: approval.expiresAt,
    validated_ledger: evidence.validatedLedger,
    remaining_ledgers: evidence.remainingLedgers,
    execution_capability: v2CapabilityFromRevision(revision),
  };
}

export type ApprovalRecoveryResult = {
  status: "expired_nonincluded";
  approval_id: string;
  execution_id: string;
  validated_ledger: number;
  first_inclusion_ledger: number;
  last_ledger_sequence: number;
  next_action: "request_fresh_build";
};

type ApprovalRecoveryRow = {
  approval_id: string;
  execution_id: string;
  build_id: string;
  build_revision: number;
  unsigned_tx_digest: string;
  economic_fingerprint: string;
  validated_ledger: number;
  first_inclusion_ledger: number;
  last_ledger_sequence: number;
  approval_status: string | null;
  execution_status: string | null;
  hash: string | null;
  signed_by: string | null;
  result_detail: string | null;
};

function approvalRecoveryError(
  code:
    | "APPROVAL_RECOVERY_NOT_READY"
    | "APPROVAL_RECOVERY_STATE_CHANGED"
    | "APPROVAL_RECOVERY_INCOMPLETE"
    | "APPROVAL_RECOVERY_CONFLICT",
  message: string,
): ExecutionLifetimeError {
  return new ExecutionLifetimeError(message, code);
}

function recoveryResult(row: ApprovalRecoveryRow): ApprovalRecoveryResult {
  return {
    status: "expired_nonincluded",
    approval_id: row.approval_id,
    execution_id: row.execution_id,
    validated_ledger: row.validated_ledger,
    first_inclusion_ledger: row.first_inclusion_ledger,
    last_ledger_sequence: row.last_ledger_sequence,
    next_action: "request_fresh_build",
  };
}

async function readApprovalRecovery(
  db: D1Database,
  principal: string,
  approvalId: string,
): Promise<ApprovalRecoveryRow | null> {
  const row = await db
    .prepare(
      `SELECT r.approval_id, r.execution_id, r.build_id, r.build_revision,
              r.unsigned_tx_digest, r.economic_fingerprint,
              r.validated_ledger, r.first_inclusion_ledger,
              r.last_ledger_sequence, a.status AS approval_status,
              e.status AS execution_status, e.hash, e.signed_by,
              ev.detail AS result_detail
         FROM approval_recoveries AS r
         LEFT JOIN approvals AS a
           ON a.principal = r.principal
          AND a.id = r.approval_id
          AND a.execution_id = r.execution_id
         LEFT JOIN executions AS e
           ON e.principal = r.principal AND e.id = r.execution_id
         LEFT JOIN events AS ev
           ON ev.principal = r.principal
          AND ev.id = 'execution-result:' || r.execution_id
          AND ev.kind = 'execution_result'
        WHERE r.principal = ? AND r.approval_id = ?`,
    )
    .bind(principal, approvalId)
    .first<ApprovalRecoveryRow>();
  if (!row) return null;
  let detail: { result?: Partial<ExecResult> } | null = null;
  try {
    detail = row.result_detail === null
      ? null
      : JSON.parse(row.result_detail) as { result?: Partial<ExecResult> };
  } catch {
    detail = null;
  }
  if (
    row.approval_status !== "expired" ||
    row.execution_status !== "failed" ||
    row.hash !== null ||
    row.signed_by !== null ||
    detail?.result?.status !== "failed" ||
    detail.result.engine_result !== "APPROVAL_RECOVERED_NONINCLUSION"
  ) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_INCOMPLETE",
      "The durable approval recovery outcome is incomplete or inconsistent",
    );
  }
  return row;
}

async function recoveredBuildExists(
  db: D1Database,
  principal: string,
  buildId: string,
  buildRevision: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS present FROM approval_recoveries
        WHERE principal = ? AND build_id = ? AND build_revision = ?`,
    )
    .bind(principal, buildId, buildRevision)
    .first<{ present: number }>();
  return row !== null;
}

function assertRecoveryBinding(
  args: TxApprovalReconcileArgs,
  row: Pick<
    ApprovalRecoveryRow,
    "build_revision" | "unsigned_tx_digest" | "economic_fingerprint"
  >,
): void {
  if (
    row.build_revision !== args.build_revision ||
    row.unsigned_tx_digest !== args.unsigned_tx_digest ||
    row.economic_fingerprint !== args.economic_fingerprint
  ) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_CONFLICT",
      "The approval recovery request is bound to another immutable tuple",
    );
  }
}

async function recoveryExactHeadState(
  ctx: OpContext,
  snapshot: ExecutionSnapshotRow,
  validatedLedger: number,
): Promise<void> {
  let accountInfo: Record<string, unknown>;
  let accountLines: Record<string, unknown>;
  try {
    [accountInfo, accountLines] = await Promise.all([
      requestXrpl(ctx, snapshot.snapshotNetwork, "account_info", {
        account: snapshot.snapshotOwner,
        ledger_index: validatedLedger,
      }),
      requestXrpl(ctx, snapshot.snapshotNetwork, "account_lines", {
        account: snapshot.snapshotOwner,
        peer: TESTNET_RLUSD_ISSUER,
        ledger_index: validatedLedger,
      }),
    ]);
  } catch {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_INCOMPLETE",
      "The exact-head owner state could not be read completely",
    );
  }
  const accountData = isRecord(accountInfo.account_data)
    ? accountInfo.account_data
    : null;
  if (
    accountInfo.validated !== true ||
    accountInfo.ledger_index !== validatedLedger ||
    accountData === null ||
    accountData.Account !== snapshot.snapshotOwner ||
    !Number.isSafeInteger(accountData.Sequence)
  ) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_INCOMPLETE",
      "The exact-head owner Sequence evidence is malformed or unvalidated",
    );
  }
  if (accountData.Sequence !== snapshot.snapshotSequence) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_STATE_CHANGED",
      "The owner Sequence changed before recovery",
    );
  }
  if (
    accountLines.validated !== true ||
    accountLines.ledger_index !== validatedLedger ||
    accountLines.account !== snapshot.snapshotOwner ||
    !Array.isArray(accountLines.lines)
  ) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_INCOMPLETE",
      "The exact-head RLUSD balance evidence is malformed or unvalidated",
    );
  }
  const invariant = snapshot.acquisitionBalanceInvariant!;
  const line = accountLines.lines.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.account === TESTNET_RLUSD_ISSUER &&
      String(candidate.currency).toUpperCase() === RLUSD_HEX_CURRENCY,
  );
  if (!isRecord(line) || typeof line.balance !== "string") {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_STATE_CHANGED",
      "The official Testnet RLUSD trust line is no longer present",
    );
  }
  if (line.balance !== invariant.balance) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_STATE_CHANGED",
      "The official Testnet RLUSD balance changed before recovery",
    );
  }
}

async function proveApprovalWindowUnused(
  ctx: OpContext,
  snapshot: ExecutionSnapshotRow,
): Promise<void> {
  const seenMarkers = new Set<string>();
  let marker: unknown;
  for (let page = 0; page < APPROVAL_RECOVERY_MAX_PAGES; page += 1) {
    let response: Record<string, unknown>;
    try {
      response = await requestXrpl(ctx, snapshot.snapshotNetwork, "account_tx", {
        account: snapshot.snapshotOwner,
        ledger_index_min: snapshot.firstInclusionLedger,
        ledger_index_max: snapshot.lastLedgerSequence,
        binary: false,
        forward: true,
        limit: APPROVAL_RECOVERY_ACCOUNT_TX_LIMIT,
        ...(marker === undefined ? {} : { marker }),
      });
    } catch {
      throw approvalRecoveryError(
        "APPROVAL_RECOVERY_INCOMPLETE",
        "The bounded account transaction scan did not complete",
      );
    }
    if (
      response.account !== snapshot.snapshotOwner ||
      response.ledger_index_min !== snapshot.firstInclusionLedger ||
      response.ledger_index_max !== snapshot.lastLedgerSequence ||
      !Array.isArray(response.transactions)
    ) {
      throw approvalRecoveryError(
        "APPROVAL_RECOVERY_INCOMPLETE",
        "The bounded account transaction page has incomplete range evidence",
      );
    }
    for (const candidate of response.transactions) {
      if (!isRecord(candidate) || candidate.validated !== true) {
        throw approvalRecoveryError(
          "APPROVAL_RECOVERY_INCOMPLETE",
          "The bounded account transaction page contains unvalidated evidence",
        );
      }
      const tx = isRecord(candidate.tx_json)
        ? candidate.tx_json
        : isRecord(candidate.tx)
          ? candidate.tx
          : null;
      const ledgerIndex = candidate.ledger_index ?? tx?.ledger_index;
      if (
        tx === null ||
        typeof tx.Account !== "string" ||
        !Number.isSafeInteger(ledgerIndex) ||
        (ledgerIndex as number) < snapshot.firstInclusionLedger ||
        (ledgerIndex as number) > snapshot.lastLedgerSequence
      ) {
        throw approvalRecoveryError(
          "APPROVAL_RECOVERY_INCOMPLETE",
          "The bounded account transaction entry is malformed or out of range",
        );
      }
      if (
        tx.Account === snapshot.snapshotOwner &&
        !Number.isSafeInteger(tx.Sequence)
      ) {
        throw approvalRecoveryError(
          "APPROVAL_RECOVERY_INCOMPLETE",
          "A validated owner transaction has a malformed Sequence",
        );
      }
      if (
        tx.Account === snapshot.snapshotOwner &&
        tx.Sequence === snapshot.snapshotSequence
      ) {
        throw approvalRecoveryError(
          "APPROVAL_RECOVERY_CONFLICT",
          "A validated transaction consumed the immutable owner Sequence",
        );
      }
    }
    const nextMarker = Object.hasOwn(response, "marker")
      ? response.marker
      : undefined;
    if (nextMarker === undefined || nextMarker === null) return;
    const parsedMarker = ApprovalRecoveryMarkerSchema.safeParse(nextMarker);
    const markerKey = parsedMarker.success
      ? JSON.stringify(parsedMarker.data)
      : undefined;
    if (markerKey === undefined || seenMarkers.has(markerKey)) {
      throw approvalRecoveryError(
        "APPROVAL_RECOVERY_INCOMPLETE",
        "The bounded account transaction scan returned an invalid marker",
      );
    }
    seenMarkers.add(markerKey);
    marker = parsedMarker.data;
  }
  throw approvalRecoveryError(
    "APPROVAL_RECOVERY_INCOMPLETE",
    "The bounded account transaction scan exceeded its page limit",
  );
}

export async function handleTxApprovalReconcile(
  ctx: OpContext,
  rawArgs: TxApprovalReconcileArgs,
): Promise<ApprovalRecoveryResult> {
  const args = TxApprovalReconcileArgsSchema.parse(rawArgs);
  assertApprovalRecoveryLocalProfile(ctx);
  const services = configuredServices(ctx);
  const store = storeFor(ctx, services);
  const db = database(ctx);
  const replay = await readApprovalRecovery(db, ctx.principal, args.approval_id);
  if (replay) {
    assertIsolatedBuildCapability(
      ctx,
      await store.getBuild(replay.build_id),
    );
    assertRecoveryBinding(args, replay);
    return recoveryResult(replay);
  }
  const approval = await store.getApproval(args.approval_id);
  if (
    !approval ||
    approval.executionContract !== "xrpl_execution_v2" ||
    approval.executionId === null ||
    approval.buildRevision === null
  ) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_CONFLICT",
      "The approval is not an exact v2 recovery candidate",
    );
  }
  assertIsolatedBuildCapability(
    ctx,
    await store.getBuild(approval.buildId),
  );
  const [execution, snapshot, revision] = await Promise.all([
    store.getExecution(approval.executionId),
    store.getExecutionSnapshot(approval.executionId),
    store.getBuildRevision(approval.buildId, approval.buildRevision),
  ]);
  assertIsolatedSnapshotTestnet(ctx, snapshot);
  if (
    !execution ||
    !snapshot ||
    !revision ||
    execution.buildId !== approval.buildId ||
    snapshot.buildId !== approval.buildId ||
    snapshot.approvalId !== approval.id ||
    snapshot.approvalExpiresAt !== approval.expiresAt
  ) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_INCOMPLETE",
      "The immutable approval recovery tuple is missing or inconsistent",
    );
  }
  assertRecoveryBinding(args, {
    build_revision: snapshot.buildRevision,
    unsigned_tx_digest: snapshot.unsignedTxDigest,
    economic_fingerprint: snapshot.economicFingerprint,
  });
  try {
    assertSnapshotMatchesRevision(snapshot, revision);
  } catch {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_INCOMPLETE",
      "The immutable approval snapshot and build revision do not match",
    );
  }
  const invariant = snapshot.acquisitionBalanceInvariant;
  const acquisitionAmount = isRecord(revision.txJson.TakerPays)
    ? revision.txJson.TakerPays
    : null;
  if (
    snapshot.snapshotNetwork !== "testnet" ||
    revision.txJson.TransactionType !== "OfferCreate" ||
    acquisitionAmount === null ||
    String(acquisitionAmount.currency).toUpperCase() !== RLUSD_HEX_CURRENCY ||
    acquisitionAmount.issuer !== TESTNET_RLUSD_ISSUER ||
    invariant === null ||
    invariant.kind !== "issued_balance_unchanged" ||
    invariant.currency.toUpperCase() !== RLUSD_HEX_CURRENCY ||
    invariant.issuer !== TESTNET_RLUSD_ISSUER
  ) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_CONFLICT",
      "Recovery is limited to official Testnet RLUSD acquisition approvals",
    );
  }
  const approvalExpiresAt = Date.parse(approval.expiresAt);
  if (!Number.isFinite(approvalExpiresAt)) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_INCOMPLETE",
      "The immutable approval wall deadline is malformed",
    );
  }
  if (nowFor(services).getTime() < approvalExpiresAt) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_NOT_READY",
      "The approval wall deadline has not expired",
    );
  }
  const [relayClaim, rejection, resultEvent] = await Promise.all([
    store.getRelayClaim(execution.id),
    db.prepare(
      `SELECT 1 AS present FROM approval_preflight_rejections
        WHERE principal = ? AND approval_id = ?`,
    ).bind(ctx.principal, approval.id).first<{ present: number }>(),
    store.getEvent(resultEventId(execution.id)),
  ]);
  let resultIsNeedsApproval = false;
  try {
    const parsed = ExecResultSchema.safeParse(
      isRecord(resultEvent?.detail) ? resultEvent.detail.result : undefined,
    );
    resultIsNeedsApproval = parsed.success && parsed.data.status === "needs_approval";
  } catch {
    resultIsNeedsApproval = false;
  }
  if (
    approval.status !== "preflighted" ||
    execution.status !== "needs_approval" ||
    execution.hash !== null ||
    execution.signedBy !== null ||
    relayClaim !== null ||
    rejection !== null ||
    !resultIsNeedsApproval
  ) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_CONFLICT",
      "The approval tuple already has a conflicting authorization or terminal state",
    );
  }
  let validatedLedger: number;
  try {
    validatedLedger = await latestValidatedLedger(ctx, snapshot.snapshotNetwork);
  } catch {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_INCOMPLETE",
      "The validated ledger head could not be established",
    );
  }
  if (validatedLedger <= snapshot.lastLedgerSequence) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_NOT_READY",
      "The validated ledger head has not passed LastLedgerSequence",
    );
  }
  await recoveryExactHeadState(ctx, snapshot, validatedLedger);
  await proveApprovalWindowUnused(ctx, snapshot);
  try {
    await db
      .prepare(
        `INSERT INTO approval_recoveries
          (principal, approval_id, execution_id, build_id, build_revision,
           unsigned_tx_digest, economic_fingerprint, validated_ledger,
           first_inclusion_ledger, last_ledger_sequence, recovered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ctx.principal,
        approval.id,
        execution.id,
        approval.buildId,
        approval.buildRevision,
        snapshot.unsignedTxDigest,
        snapshot.economicFingerprint,
        validatedLedger,
        snapshot.firstInclusionLedger,
        snapshot.lastLedgerSequence,
        nowFor(services).toISOString(),
      )
      .run();
  } catch {
    const winner = await readApprovalRecovery(db, ctx.principal, approval.id);
    if (winner) {
      assertRecoveryBinding(args, winner);
      return recoveryResult(winner);
    }
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_CONFLICT",
      "The approval tuple changed while recovery was being committed",
    );
  }
  const recovered = await readApprovalRecovery(db, ctx.principal, approval.id);
  if (!recovered) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_INCOMPLETE",
      "The committed approval recovery outcome could not be read",
    );
  }
  return recoveryResult(recovered);
}

export async function handleTxExecute(
  ctx: OpContext,
  rawArgs: TxExecuteArgs,
): Promise<ReplayExecutionResult> {
  const args = TxExecuteArgsSchema.parse(rawArgs);
  const executionContract = requestedContract(args);
  const v2 = executionContract === "xrpl_execution_v2";
  if (v2) assertV2LocalProfile(ctx);
  const services = configuredServices(ctx);
  const store = storeFor(ctx, services);
  const idempotencyKey = principalIdempotencyKey(
    ctx.principal,
    args.idempotency_key,
  );
  if (
    v2 &&
    await recoveredBuildExists(
      database(ctx),
      ctx.principal,
      args.build_id,
      args.build_revision!,
    )
  ) {
    throw approvalRecoveryError(
      "APPROVAL_RECOVERY_CONFLICT",
      "The recovered build tuple is permanently burned",
    );
  }
  const executionMode = requestedExecutionMode(args);
  const existing = await store.findExecutionByIdempotencyKey(
    idempotencyKey,
  );
  if (existing) {
    assertIsolatedBuildCapability(
      ctx,
      await store.getBuild(existing.buildId),
    );
    const receipt = await readExecutionClaim(store, existing);
    const existingSnapshot = await store.getExecutionSnapshot(existing.id);
    assertIsolatedSnapshotTestnet(ctx, existingSnapshot);
    if (v2) {
      if (!existingSnapshot) {
        const terminalWithoutSnapshot =
          existing.status === "blocked" || existing.status === "failed";
        const pointer = terminalWithoutSnapshot
          ? await store.getBuild(existing.buildId)
          : null;
        const durableV2Claim =
          receipt?.executionContract === "xrpl_execution_v2" &&
          receipt.buildId === args.build_id &&
          receipt.buildRevision === args.build_revision;
        if (!durableV2Claim && (
          !pointer ||
          pointer.executionContract !== "xrpl_execution_v2" ||
          pointer.buildRevision !== args.build_revision
        )) {
          throw new ExecutionLifetimeError(
            "The v2 idempotent execution has no immutable snapshot",
            "EXECUTION_SNAPSHOT_INVALID",
          );
        }
      }
      if (existingSnapshot && (
        existingSnapshot.buildId !== args.build_id ||
        existingSnapshot.buildRevision !== args.build_revision
      )) {
        throw new ExecutionLifetimeError(
          "The idempotency key is bound to another v2 revision",
          "EXECUTION_CONTRACT_MISMATCH",
        );
      }
    } else {
      const existingBuild = await store.getBuild(existing.buildId);
      if (
        existingSnapshot ||
        receipt?.executionContract === "xrpl_execution_v2" ||
        existingBuild?.executionContract === "xrpl_execution_v2"
      ) {
        throw new ExecutionLifetimeError(
          "A v2 execution cannot be replayed as v1",
          "EXECUTION_CONTRACT_MISMATCH",
        );
      }
    }
    if (localTradingSafetyMarkersPresent(ctx.env) && !v2) {
      const existingBuild = await store.getBuild(existing.buildId);
      if (!existingBuild) throw new Error("execution build not found");
      assertLocalTradingTestnet(ctx, existingBuild.network);
      await assertLocalBuildCapability(
        ctx,
        store,
        existingBuild,
        idempotencyKey,
      );
      await exactLocalTradingPolicy(ctx, store, existingBuild);
    }
    if (receipt) {
      if (receipt.buildId !== args.build_id || existing.buildId !== args.build_id) {
        throw new Error("idempotency key belongs to a different build");
      }
      if (receipt.mode !== executionMode) {
        throw new Error("idempotency key belongs to a different execution mode");
      }
      if (
        receipt.executionContract !== executionContract ||
        (v2 && receipt.buildRevision !== args.build_revision)
      ) {
        throw new ExecutionLifetimeError(
          "The idempotency key is bound to another execution contract",
          "EXECUTION_CONTRACT_MISMATCH",
        );
      }
      return replayOrRecover(ctx, services, store, existing);
    }
    if (args.require_owner_approval === true) {
      return replayRequiredOwnerApproval(store, existing, args.build_id);
    }
    return replayOrRecover(ctx, services, store, existing);
  }

  let row = await store.getBuild(args.build_id);
  if (!row) throw new Error("build not found");
  if (!v2) {
    if (row.executionContract === "xrpl_execution_v2") {
      throw new ExecutionLifetimeError(
        "A v2 build cannot be executed under the legacy contract",
        "EXECUTION_CONTRACT_MISMATCH",
      );
    }
    const v2Revision = await database(ctx)
      .prepare(
        `SELECT 1 AS present FROM build_revisions
          WHERE principal = ? AND build_id = ?
          LIMIT 1`,
      )
      .bind(ctx.principal, row.id)
      .first<{ present: number }>();
    if (v2Revision) {
      throw new ExecutionLifetimeError(
        "A v2 build cannot be executed under the legacy contract",
        "EXECUTION_CONTRACT_MISMATCH",
      );
    }
  }
  const revision = v2
    ? await exactV2Revision(store, row, args.build_revision!)
    : null;
  assertLocalTradingTestnet(ctx, row.network);
  await assertLocalBuildCapability(ctx, store, row);
  const policyRow = await store.getPolicy(row.owner, row.network);
  const requiredLocalPolicy = await exactLocalTradingPolicy(ctx, store, row);
  if (v2 && !policyRow) {
    throw new ExecutionLifetimeError(
      "v2 requires an exact stored policy revision",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  if (revision && policyRow) {
    const preclaimSnapshot = snapshotFromRevision(
      "preclaim",
      revision,
      policyRow.json,
      policyRow.updatedAt,
      nowFor(services).toISOString(),
    );
    await validateV2LiveEvidence(ctx, preclaimSnapshot, revision.txJson);
  }
  executionNetwork(row.network);
  const startedAt = nowFor(services);
  const executionId = uuidFor(services);
  let claim: Awaited<ReturnType<typeof claimExecutionAtomic>>;
  try {
    claim = await claimExecutionAtomic(database(ctx), store, {
      id: executionId,
      build: row,
      idempotencyKey,
      mode: executionMode,
      createdAt: startedAt.toISOString(),
    });
  } catch (error) {
    if (
      v2 &&
      await recoveredBuildExists(
        database(ctx),
        ctx.principal,
        args.build_id,
        args.build_revision!,
      )
    ) {
      throw approvalRecoveryError(
        "APPROVAL_RECOVERY_CONFLICT",
        "The recovered build tuple is permanently burned",
      );
    }
    throw error;
  }
  if (!claim.claimed) {
    if (claim.execution.buildId !== row.id) {
      throw new Error("idempotency key belongs to a different build");
    }
    if (claim.mode !== executionMode) {
      throw new Error("idempotency key belongs to a different execution mode");
    }
    return replayOrRecover(ctx, services, store, claim.execution);
  }
  const refresh = v2
    ? { status: "ready" as const, row }
    : await refreshedBuild(ctx, store, row);
  if (refresh.status === "quote-expired") {
    const result: ExecResult = {
      status: "failed",
      engine_result: "QUOTE_EXPIRED",
      detail: "Exact-output FOK quote expired; request a fresh tx.swap build",
    };
    const usdValue = finiteUsdValue(Number(row.summary.usd_value ?? "0"));
    const completed = await completeClaimedTerminalExecutionAtomic(
      database(ctx),
      store,
      {
        id: executionId,
        buildId: row.id,
        idempotencyKey,
        status: "failed",
        usdValue,
        createdAt: startedAt.toISOString(),
        owner: row.owner,
        result,
        mode: executionMode,
      },
    );
    if (!completed) throw new Error("expired quote claim could not be completed");
    return result;
  }
  row = refresh.row;
  const link = await store.getLink(row.owner, row.network);
  const effectiveRow = revision
    ? {
        ...row,
        owner: revision.owner,
        network: revision.network,
        txJson: revision.txJson,
        summary: revision.summary,
        lastLedgerSeq: revision.lastLedgerSequence,
      }
    : row;
  const revalidated = await revalidateStoredBuild(ctx, effectiveRow);
  const build = {
    ...rehydratedBuild(effectiveRow, link, revalidated),
    ...(revision
      ? { execution_capability: v2CapabilityFromRevision(revision) }
      : {}),
  };
  const policy = requiredLocalPolicy ??
    policyRow?.json ?? {
      ...DEFAULT_POLICY,
      allowed_tx_types: [...DEFAULT_POLICY.allowed_tx_types],
      issuer_allowlist: [...DEFAULT_POLICY.issuer_allowlist],
      networks: [...DEFAULT_POLICY.networks],
    };
  const gathered = await gatherPolicyContext(
    build,
    policy,
    store,
    services.facts ?? createPolicyFactsAdapter(ctx),
  );
  const evaluationAt = nowFor(services);
  const dailyUsdTotal = await store.dailyUsdTotal(
    row.owner,
    row.network,
    utcDayStart(evaluationAt),
  );
  if (!Number.isFinite(dailyUsdTotal) || dailyUsdTotal < 0) {
    throw new Error("current daily USD total is invalid");
  }
  const currentGathered = { ...gathered, dailyUsdTotal };
  const evaluatedPolicy = evaluate(build, currentGathered);
  const policyResult =
    args.require_owner_approval === true
      ? policyWithRequiredOwnerApproval(evaluatedPolicy)
      : evaluatedPolicy;
  const usdValue = finiteUsdValue(currentGathered.usdValue);

  if (policyResult.verdict === "block") {
    const result: ExecResult = { status: "blocked", policy: policyResult };
    const completed = await completeClaimedTerminalExecutionAtomic(database(ctx), store, {
      id: executionId,
      buildId: row.id,
      idempotencyKey,
      status: "blocked",
      usdValue,
      createdAt: startedAt.toISOString(),
      owner: row.owner,
      result,
      mode: executionMode,
    });
    if (!completed) throw new Error("execution claim could not be completed");
    return result;
  }

  if (policyResult.verdict === "needs_approval") {
    const approvalId = `${executionId}.${uuidFor(services)}`;
    const approvalCreatedAt = v2 ? nowFor(services) : startedAt;
    const expiresAt = new Date(
      approvalCreatedAt.getTime() +
        (v2 ? V2_APPROVAL_TTL_MS : APPROVAL_TTL_MS),
    ).toISOString();
    const txJson = unsignedOwnerTransaction(build.tx_json);
    const snapshot =
      revision && policyRow
        ? snapshotFromRevision(
            executionId,
            revision,
            policy,
            policyRow.updatedAt,
            approvalCreatedAt.toISOString(),
            { id: approvalId, expiresAt },
          )
        : undefined;
    if (snapshot) {
      await validateV2LiveEvidence(ctx, snapshot, revision!.txJson);
      await assertApprovalMargin(
        database(ctx),
        ctx.principal,
        executionId,
        snapshot.snapshotOwner,
        snapshot.snapshotNetwork,
        usdValue,
        policy.daily_cap_usd,
        approvalCreatedAt,
      );
    }
    const result: ExecResult = {
      status: "needs_approval",
      approval_id: approvalId,
      tx_json: txJson,
      expires_at: expiresAt,
      policy: policyResult,
    };
    const completed = await completeClaimedTerminalExecutionAtomic(database(ctx), store, {
      id: executionId,
      buildId: row.id,
      idempotencyKey,
      status: "needs_approval",
      usdValue,
      createdAt: approvalCreatedAt.toISOString(),
      owner: row.owner,
      result,
      mode: executionMode,
      approval: {
        id: approvalId,
        txJson,
        expiresAt,
        ...(revision
          ? {
              executionContract: "xrpl_execution_v2" as const,
              buildRevision: revision.buildRevision,
            }
          : {}),
      },
      snapshot,
      dailyCapUsd: v2 ? policy.daily_cap_usd : undefined,
    });
    if (!completed) throw new Error("execution claim could not be completed");
    return result;
  }

  if (!link || link.status !== "active") {
    throw new Error("active account link is required for delegated signing");
  }
  await releaseStalePendingReservations(
    database(ctx),
    ctx.principal,
    row.owner,
    row.network,
    startedAt,
  );
  const inFlight = await inFlightExecution(
    database(ctx),
    store,
    ctx.principal,
    row.owner,
    row.network,
    executionId,
  );
  if (inFlight) {
    await replayOrRecover(ctx, services, store, inFlight);
  }
  const reserve = services.reserveDailyBudget ?? reserveClaimedDailyBudgetAtomic;
  const reservationAt = nowFor(services);
  const delegatedSnapshot =
    revision && policyRow
      ? snapshotFromRevision(
          executionId,
          revision,
          policy,
          policyRow.updatedAt,
          reservationAt.toISOString(),
        )
      : undefined;
  const reservation = await reserve({
    db: database(ctx),
    principal: ctx.principal,
    executionId,
    build: row,
    idempotencyKey,
    usdValue,
    dailyCapUsd: policy.daily_cap_usd,
    createdAt: reservationAt.toISOString(),
    snapshot: delegatedSnapshot,
  });
  if (reservation === "duplicate") {
    const raced = await store.findExecutionByIdempotencyKey(
      idempotencyKey,
    );
    if (!raced) throw new Error("idempotency reservation failed");
    const receipt = await readExecutionClaim(store, raced);
    if (
      raced.buildId !== row.id ||
      receipt?.buildId !== row.id ||
      receipt.mode !== executionMode
    ) {
      throw new Error("idempotency reservation does not match its execution claim");
    }
    return replayOrRecover(ctx, services, store, raced);
  }
  if (reservation === "busy") {
    const result: ExecResult = {
      status: "failed",
      engine_result: "EXECUTION_BUSY",
      detail: "Another delegated transaction is still awaiting a final ledger result",
    };
    const completed = await completeClaimedTerminalExecutionAtomic(database(ctx), store, {
      id: executionId,
      buildId: row.id,
      idempotencyKey,
      status: "failed",
      usdValue,
      createdAt: startedAt.toISOString(),
      owner: row.owner,
      result,
      mode: executionMode,
    });
    if (!completed) throw new Error("execution claim could not be completed");
    return result;
  }
  if (reservation === "link-frozen") {
    const result: ExecResult = {
      status: "blocked",
      policy: policyWithLinkFrozen(policyResult),
    };
    const completed = await completeClaimedTerminalExecutionAtomic(database(ctx), store, {
      id: executionId,
      buildId: row.id,
      idempotencyKey,
      status: "blocked",
      usdValue,
      createdAt: startedAt.toISOString(),
      owner: row.owner,
      result,
      mode: executionMode,
    });
    if (!completed) throw new Error("frozen link claim could not be completed");
    return result;
  }
  if (reservation === "link-inactive") {
    const blockedPolicy: PolicyResult = {
      verdict: "block",
      reasons: policyResult.reasons.map((reason) =>
        reason.rule === "link_active"
          ? {
              ...reason,
              pass: false,
              detail: "Account link stopped being active before signing",
            }
          : reason,
      ),
    };
    const result: ExecResult = { status: "blocked", policy: blockedPolicy };
    const completed = await completeClaimedTerminalExecutionAtomic(database(ctx), store, {
      id: executionId,
      buildId: row.id,
      idempotencyKey,
      status: "blocked",
      usdValue,
      createdAt: startedAt.toISOString(),
      owner: row.owner,
      result,
      mode: executionMode,
    });
    if (!completed) throw new Error("execution claim could not be completed");
    return result;
  }
  if (reservation === "over-cap") {
    const blockedPolicy = policyWithDailyCapFailure(policyResult);
    const result: ExecResult = { status: "blocked", policy: blockedPolicy };
    const completed = await completeClaimedTerminalExecutionAtomic(database(ctx), store, {
      id: executionId,
      buildId: row.id,
      idempotencyKey,
      status: "blocked",
      usdValue,
      createdAt: startedAt.toISOString(),
      owner: row.owner,
      result,
      mode: executionMode,
    });
    if (!completed) throw new Error("execution claim could not be completed");
    return result;
  }

  const execution = await store.getExecution(executionId);
  if (!execution) throw new Error("reserved execution could not be read");
  if (
    await linkFrozenAt(
      database(ctx),
      ctx.principal,
      row.owner,
      row.network,
    ) !== null
  ) {
    const result: ExecResult = {
      status: "blocked",
      policy: policyWithLinkFrozen(policyResult),
    };
    await completeDelegatedExecution(
      database(ctx),
      ctx.principal,
      execution,
      row.owner,
      result,
      nowFor(services).toISOString(),
    );
    return result;
  }
  const durableSnapshot = delegatedSnapshot
    ? await store.getExecutionSnapshot(executionId)
    : null;
  assertIsolatedSnapshotTestnet(ctx, durableSnapshot);
  if (delegatedSnapshot && !durableSnapshot) {
    throw new ExecutionLifetimeError(
      "The delegated reservation has no immutable execution snapshot",
      "EXECUTION_SNAPSHOT_INVALID",
    );
  }
  if (durableSnapshot) {
    await validateV2LiveEvidence(ctx, durableSnapshot, revision!.txJson);
  }
  if (!services.signDelegate || !services.submitSigned) {
    const result: ExecResult = {
      status: "failed",
      engine_result: "EXECUTION_FAILED",
      detail: "Delegated execution services are not configured",
    };
    await completeDelegatedExecution(
      database(ctx),
      ctx.principal,
      execution,
      row.owner,
      result,
      nowFor(services).toISOString(),
    );
    return result;
  }

  const leaseTx = revision?.txJson ?? row.txJson;
  const leaseSequence = leaseTx.Sequence;
  const leaseLastLedger = leaseTx.LastLedgerSequence;
  if (
    !Number.isSafeInteger(leaseSequence) || Number(leaseSequence) < 0 ||
    !Number.isSafeInteger(leaseLastLedger) || Number(leaseLastLedger) < 1
  ) {
    const result: ExecResult = {
      status: "failed",
      engine_result: "EXECUTION_SNAPSHOT_INVALID",
      detail: "The transaction has no valid account sequence window",
    };
    await completeDelegatedExecution(database(ctx), ctx.principal, execution,
      row.owner, result, nowFor(services).toISOString());
    return result;
  }
  const sequenceAuthority = new AccountSequenceLeaseAuthority(database(ctx));
  const acquiredSequence = await sequenceAuthority.acquire({
    principal: ctx.principal,
    network: executionNetwork(row.network),
    account: row.owner,
    source: sequenceSource(args.idempotency_key),
    attemptId: execution.id,
    token: await sequenceLeaseToken(execution.id),
    at: nowFor(services).toISOString(),
  });
  if (acquiredSequence.outcome === "blocked") {
    const result: ExecResult = {
      status: "failed",
      engine_result: "ACCOUNT_SEQUENCE_BUSY",
      detail: "Another transaction for this XRPL account owns the sequence lease",
    };
    await completeDelegatedExecution(database(ctx), ctx.principal, execution,
      row.owner, result, nowFor(services).toISOString());
    return result;
  }
  let accountLease = acquiredSequence.lease;
  const signingLease = await sequenceAuthority.markSigning({
    ...accountSequenceIdentity(accountLease),
    sequence: Number(leaseSequence),
    firstLedgerSequence: durableSnapshot?.firstInclusionLedger ??
      Math.max(1, Number(leaseLastLedger) - RELIABLE_SUBMISSION_LEDGER_WINDOW + 1),
    lastLedgerSequence: Number(leaseLastLedger),
    at: nowFor(services).toISOString(),
  });
  if (signingLease.outcome === "blocked") {
    const result: ExecResult = {
      status: "failed",
      engine_result: "ACCOUNT_SEQUENCE_FENCED",
      detail: "The account sequence lease changed before signing",
    };
    await completeDelegatedExecution(database(ctx), ctx.principal, execution,
      row.owner, result, nowFor(services).toISOString());
    return result;
  }
  accountLease = signingLease.lease;

  let signed: SignedDelegateBlob;
  let signer: Signer | undefined;
  try {
    signer = signerForExecution(ctx, link);
    signed = await services.signDelegate({
      ctx,
      build,
      link,
      executionContract,
    });
  } catch (error) {
    await sequenceAuthority.markAmbiguous({
      ...accountSequenceIdentity(accountLease),
      at: nowFor(services).toISOString(),
    });
    return {
      status: "failed",
      engine_result: "SUBMISSION_PENDING",
      detail:
        error instanceof XrplRpcError
          ? "Signing inputs failed after the account sequence was fenced; operator reconciliation is required"
          : error instanceof DelegatedSigningError
            ? `Signing stopped after the account sequence was fenced (${error.code}); operator reconciliation is required`
            : "Signing stopped after the account sequence was fenced; operator reconciliation is required",
    };
  }

  let signedHash: string;
  try {
    if (durableSnapshot && revision) {
      await assertV2DelegatedBlobMatchesRevision(
        signed.tx_blob,
        link.delegate,
        revision,
      );
    }
    signedHash = signedTransactionHash(signed.tx_blob).toUpperCase();
    if (HashSchema.parse(signed.hash).toUpperCase() !== signedHash) {
      throw new Error("delegate signer returned inconsistent transaction hashes");
    }
  } catch {
    await sequenceAuthority.markAmbiguous({
      ...accountSequenceIdentity(accountLease),
      at: nowFor(services).toISOString(),
    });
    return {
      status: "failed",
      engine_result: "SUBMISSION_PENDING",
      detail: "The signer response was invalid after the account sequence was fenced; operator reconciliation is required",
    };
  }
  const signedLease = await sequenceAuthority.markSigned({
    ...accountSequenceIdentity(accountLease),
    hash: signedHash,
    at: nowFor(services).toISOString(),
  });
  if (signedLease.outcome === "blocked") {
    return {
      status: "failed",
      engine_result: "SUBMISSION_PENDING",
      detail: "The signed transaction is fenced pending sequence reconciliation",
    };
  }
  accountLease = signedLease.lease;
  const submitted = await markDelegatedSubmitted(database(ctx), {
    principal: ctx.principal,
    executionId: execution.id,
    owner: row.owner,
    hash: signedHash,
    createdAt: nowFor(services).toISOString(),
    signer,
  });
  if (!submitted) {
    const current = await store.getExecution(execution.id);
    if (!current) throw new Error("delegated execution reservation was lost");
    return replayOrRecover(ctx, services, store, current);
  }
  const submittedLease = await sequenceAuthority.markSubmitted({
    ...accountSequenceIdentity(accountLease),
    hash: signedHash,
    at: nowFor(services).toISOString(),
  });
  if (submittedLease.outcome === "blocked") {
    return {
      status: "failed",
      engine_result: "SUBMISSION_PENDING",
      detail: "The persisted transaction is fenced pending sequence reconciliation",
    };
  }
  accountLease = submittedLease.lease;

  const submittedExecution = {
    ...execution,
    status: "submitted" as const,
    hash: signedHash,
    signedBy: "delegate" as const,
  };
  if (durableSnapshot) {
    await validateV2LiveEvidence(ctx, durableSnapshot, revision!.txJson);
    await claimV2Relay(
      store,
      execution.id,
      signedHash,
      nowFor(services).toISOString(),
    );
  }
  if (
    await linkFrozenAt(
      database(ctx),
      ctx.principal,
      row.owner,
      row.network,
    ) !== null
  ) {
    await sequenceAuthority.markAmbiguous({
      ...accountSequenceIdentity(accountLease), hash: signedHash,
      at: nowFor(services).toISOString(),
    });
    return {
      status: "failed",
      engine_result: "SUBMISSION_PENDING",
      detail: "The link froze after signing; submission was stopped and the sequence remains fenced until ledger reconciliation",
    };
  }
  let submission: ValidatedSubmission;
  try {
    submission = await services.submitSigned({
      ctx,
      network: executionNetwork(row.network),
      txBlob: signed.tx_blob,
      executionContract,
    });
    if (submission.hash.toUpperCase() !== signedHash) {
      throw new SubmissionOutcomeError(
        "XRPL_HASH_MISMATCH",
        signedHash,
        false,
      );
    }
  } catch (error) {
    await sequenceAuthority.markAmbiguous({
      ...accountSequenceIdentity(accountLease), hash: signedHash,
      at: nowFor(services).toISOString(),
    });
    return {
      status: "failed",
      engine_result: "SUBMISSION_PENDING",
      detail: error instanceof SubmitValidationError
        ? `Submission validation stopped (${error.code}); the reserved amount and account sequence remain held until ledger reconciliation`
        : error instanceof SubmissionOutcomeError
          ? `Submission did not validate (${error.engineResult}); the reserved amount and account sequence remain held until ledger reconciliation`
          : "Submission is ambiguous; the reserved amount and account sequence remain held until ledger reconciliation",
    };
  }
  const result = submissionResult(submission, signer);
  await releaseAccountSequenceValidated(
    database(ctx), submittedExecution, executionNetwork(row.network), row.owner,
    signedHash, submission.ledger_index, submission.engine_result,
    nowFor(services).toISOString(),
  );
  await completeDelegatedExecution(
    database(ctx),
    ctx.principal,
    submittedExecution,
    row.owner,
    result,
    nowFor(services).toISOString(),
  );
  return result;
}

async function replayTerminalApprovalSubmission(
  store: Store,
  approval: ApprovalRow,
  txBlob: string,
): Promise<ApprovalSubmissionResult | null> {
  if (approval.status !== "approved" && approval.status !== "rejected") {
    return null;
  }
  const execution = await store.getExecution(executionIdForApproval(approval));
  const hash = signedTransactionHash(txBlob).toUpperCase();
  if (
    !execution ||
    execution.buildId !== approval.buildId ||
    execution.signedBy !== "owner" ||
    execution.hash?.toUpperCase() !== hash
  ) {
    throw new Error("approval retry does not match its terminal transaction");
  }
  const replay = await replayResult(store, execution);
  if (
    approval.status === "approved" &&
    execution.status === "executed" &&
    replay?.status === "executed" &&
    replay.signed_by === "owner"
  ) {
    return {
      hash: replay.hash,
      ledger_index: replay.ledger_index,
      engine_result: "tesSUCCESS",
      validated: true,
    };
  }
  if (
    approval.status === "rejected" &&
    execution.status === "failed" &&
    replay?.status === "failed"
  ) {
    return replay;
  }
  throw new Error("approval terminal replay is inconsistent");
}

function directDelegateSetPermissions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const permissions: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.Permission)) return null;
    const permission = entry.Permission.PermissionValue;
    if (typeof permission !== "string" || permission.length === 0) return null;
    permissions.push(permission);
  }
  return permissions;
}

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function validateDirectOwnerDelegateSet(
  transaction: Readonly<Record<string, unknown>>,
  link: LinkRow,
): void {
  const permissions = directDelegateSetPermissions(transaction.Permissions);
  if (
    transaction.TransactionType !== "DelegateSet" ||
    transaction.Account !== link.owner ||
    transaction.Authorize !== link.delegate ||
    transaction.Delegate !== undefined ||
    permissions === null
  ) {
    throw new Error("direct owner submission does not match the scoped account link");
  }
  const isGrant = permissions.length > 0;
  if (
    (isGrant &&
      !exactStrings(permissions, link.permissions)) ||
    (isGrant && link.status !== "pending" && link.status !== "active") ||
    (!isGrant && link.status !== "suspended" && link.status !== "revoked")
  ) {
    throw new Error("direct owner submission does not match the scoped link state");
  }
}

async function authorizeDirectOwnerSignature(
  ctx: OpContext,
  network: "testnet" | "devnet",
  txBlob: string,
  transaction: Readonly<Record<string, unknown>>,
): Promise<number> {
  const account = transaction.Account;
  const publicKey = transaction.SigningPubKey;
  if (
    typeof account !== "string" ||
    !isValidClassicAddress(account) ||
    typeof publicKey !== "string" ||
    publicKey.length === 0 ||
    transaction.Signers !== undefined
  ) {
    throw new Error(
      "direct owner submission requires one verifiable owner signature",
    );
  }

  let signer: string;
  try {
    if (!verifySignature(txBlob)) {
      throw new Error("signature verification failed");
    }
    signer = deriveAddress(publicKey);
  } catch {
    throw new Error("direct owner submission has an invalid signature");
  }

  const validatedLedger = await latestValidatedLedger(ctx, network);
  const response = await requestXrpl(ctx, network, "account_info", {
    account,
    ledger_index: validatedLedger,
  });
  const accountData = isRecord(response.account_data)
    ? response.account_data
    : null;
  const flags = accountData?.Flags;
  if (
    response.validated !== true ||
    response.ledger_index !== validatedLedger ||
    accountData?.Account !== account ||
    !Number.isSafeInteger(flags) ||
    Number(flags) < 0 ||
    Number(flags) > 0xffff_ffff
  ) {
    throw new Error(
      "direct owner submission could not verify owner authority from validated state",
    );
  }

  const masterAuthorized =
    signer === account && (Number(flags) & LSF_DISABLE_MASTER) === 0;
  const regularAuthorized = accountData.RegularKey === signer;
  if (!masterAuthorized && !regularAuthorized) {
    throw new Error(
      "direct owner submission signature is not authorized by the owner account",
    );
  }
  return validatedLedger;
}

function directSubmissionEventId(principal: string, hash: string): string {
  return `direct-owner-submit:${principal}:${hash.toUpperCase()}`;
}

function directSubmissionAttemptId(hash: string): string {
  return `direct:${hash.toUpperCase()}`;
}

function directLeaseMatches(
  lease: AccountSequenceLeaseRow,
  principal: string,
  hash: string,
): boolean {
  return lease.principal === principal && lease.source === "manual" &&
    lease.attemptId === directSubmissionAttemptId(hash) &&
    (lease.hash === null || lease.hash === hash.toUpperCase());
}

function directLeaseWindow(
  lease: AccountSequenceLeaseRow,
): { firstLedger: number; lastLedger: number } {
  if (
    lease.firstLedgerSequence === null ||
    lease.lastLedgerSequence === null ||
    lease.firstLedgerSequence > lease.lastLedgerSequence
  ) {
    throw new Error("direct owner submission has no durable ledger window");
  }
  return {
    firstLedger: lease.firstLedgerSequence,
    lastLedger: lease.lastLedgerSequence,
  };
}

function directTerminalReplay(
  lease: AccountSequenceLeaseRow,
  hash: string,
): ApprovalSubmissionResult {
  const evidence = lease.releaseEvidence;
  const window = directLeaseWindow(lease);
  if (
    lease.state !== "released" ||
    lease.hash !== hash.toUpperCase() ||
    evidence === null
  ) {
    throw new Error("direct owner submission terminal replay is inconsistent");
  }
  if (
    evidence.kind === "validated_terminal" &&
    evidence.hash === hash.toUpperCase() &&
    Number.isSafeInteger(evidence.ledger_index) &&
    Number(evidence.ledger_index) >= window.firstLedger &&
    Number(evidence.ledger_index) <= window.lastLedger &&
    typeof evidence.engine_result === "string" &&
    SAFE_ENGINE_RESULT.test(evidence.engine_result)
  ) {
    if (evidence.engine_result === "tesSUCCESS") {
      return {
        hash: hash.toUpperCase(),
        ledger_index: Number(evidence.ledger_index),
        engine_result: evidence.engine_result,
        validated: true,
      };
    }
    return {
      status: "failed",
      engine_result: evidence.engine_result,
      detail: "Direct owner transaction reached a validated ledger without tesSUCCESS",
    };
  }
  if (
    evidence.kind === "expired_absent" &&
    evidence.hash === hash.toUpperCase() &&
    evidence.searched_all === true &&
    evidence.checked_from === window.firstLedger &&
    evidence.checked_through === window.lastLedger &&
    Number.isSafeInteger(evidence.validated_head) &&
    Number(evidence.validated_head) > window.lastLedger
  ) {
    return {
      status: "failed",
      engine_result: "tefMAX_LEDGER",
      detail: "Direct owner transaction was absent after its LastLedgerSequence",
    };
  }
  throw new Error("direct owner submission terminal evidence is malformed");
}

type DirectSubmissionResolution =
  | { state: "pending" }
  | { state: "absent" }
  | { state: "validated"; status: FinalTransactionStatus };

async function resolveDirectSubmission(
  ctx: OpContext,
  lease: AccountSequenceLeaseRow,
  hash: string,
  status: TransactionStatus,
  at: string,
): Promise<DirectSubmissionResolution> {
  const window = directLeaseWindow(lease);
  let finalStatus = finalStatusWithinWindow(
    status,
    lease.network,
    hash.toUpperCase(),
    window,
  );
  let absence: Extract<ExpiredTransactionProof, { state: "absent" }> | null = null;
  if (!finalStatus) {
    const proof = await proveExpiredTransactionWindow(
      ctx,
      lease.network,
      hash.toUpperCase(),
      window,
    );
    if (proof.state === "included") finalStatus = proof.status;
    if (proof.state === "absent") absence = proof;
  }
  const authority = new AccountSequenceLeaseAuthority(database(ctx));
  if (finalStatus) {
    const released = await authority.releaseValidated({
      ...accountSequenceIdentity(lease),
      hash: hash.toUpperCase(),
      ledgerIndex: finalStatus.ledger_index,
      engineResult: finalStatus.engine_result,
      at,
    });
    if (released.outcome === "blocked") {
      throw new Error("direct owner sequence lease rejected validated evidence");
    }
    return { state: "validated", status: finalStatus };
  }
  if (absence) {
    const released = await authority.releaseAbsent({
      ...accountSequenceIdentity(lease),
      hash: hash.toUpperCase(),
      validatedHead: absence.validatedHead,
      checkedFrom: absence.checkedFrom,
      checkedThrough: absence.checkedThrough,
      searchedAll: true,
      at,
    });
    if (released.outcome === "blocked") {
      throw new Error("direct owner sequence lease rejected absence evidence");
    }
    return { state: "absent" };
  }
  return { state: "pending" };
}

function directResolutionResult(
  resolution: Exclude<DirectSubmissionResolution, { state: "pending" }>,
): ApprovalSubmissionResult {
  if (resolution.state === "absent") {
    return {
      status: "failed",
      engine_result: "tefMAX_LEDGER",
      detail: "Direct owner transaction was absent after its LastLedgerSequence",
    };
  }
  if (resolution.status.engine_result !== "tesSUCCESS") {
    return {
      status: "failed",
      engine_result: resolution.status.engine_result,
      detail: "Direct owner transaction reached a validated ledger without tesSUCCESS",
    };
  }
  return {
    hash: resolution.status.hash,
    ledger_index: resolution.status.ledger_index,
    engine_result: resolution.status.engine_result,
    validated: true,
  };
}

async function reconcileDirectSubmission(
  ctx: OpContext,
  services: ExecutionServices,
  lease: AccountSequenceLeaseRow,
  hash: string,
): Promise<ApprovalSubmissionResult | null> {
  if (!services.status) return null;
  let status: TransactionStatus;
  try {
    status = await services.status(ctx, lease.network, hash.toUpperCase());
  } catch {
    return null;
  }
  const resolution = await resolveDirectSubmission(
    ctx,
    lease,
    hash,
    status,
    nowFor(services).toISOString(),
  );
  return resolution.state === "pending"
    ? null
    : directResolutionResult(resolution);
}

async function bindDirectOwnerSubmission(
  ctx: OpContext,
  store: Store,
  principal: string,
  owner: string,
  network: "testnet" | "devnet",
  hash: string,
  createdAt: string,
): Promise<void> {
  const id = directSubmissionEventId(principal, hash);
  const localOrigin = localTradingIsolatedOnboardingV1MarkersPresent(ctx.env)
    ? LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN
    : localTradingSafetyMarkersPresent(ctx.env)
      ? LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN
      : null;

  if (localOrigin !== null) {
    const detail = JSON.stringify({ hash: hash.toUpperCase(), network });
    try {
      const results = await database(ctx).batch([
        database(ctx)
          .prepare(
            `INSERT INTO events (id, principal, owner, kind, detail, created_at)
             VALUES (?, ?, ?, 'direct_owner_submission', ?, ?)`,
          )
          .bind(id, principal, owner, detail, createdAt),
        database(ctx)
          .prepare(
            `INSERT INTO direct_submission_bindings
              (principal, hash, owner, network, origin_profile, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            principal,
            hash.toUpperCase(),
            owner,
            network,
            localOrigin,
            createdAt,
          ),
      ]);
      if (!results.every((result) => changes(result) === 1)) {
        throw new Error("direct owner submission could not be bound safely");
      }
      return;
    } catch {
      const [event, binding] = await Promise.all([
        store.getEvent(id),
        readLocalDirectSubmissionBinding(
          database(ctx),
          principal,
          hash,
        ),
      ]);
      if (
        !event ||
        event.kind !== "direct_owner_submission" ||
        event.owner !== owner ||
        event.detail.hash !== hash.toUpperCase() ||
        event.detail.network !== network ||
        !binding ||
        binding.owner !== owner ||
        binding.network !== network ||
        binding.origin_profile !== localOrigin
      ) {
        throw new Error("direct owner submission could not be bound safely");
      }
      return;
    }
  }

  const existing = await store.getEvent(id);
  if (existing) {
    if (
      existing.kind !== "direct_owner_submission" ||
      existing.owner !== owner ||
      existing.detail.hash !== hash.toUpperCase() ||
      existing.detail.network !== network
    ) {
      throw new Error("direct owner submission binding is inconsistent");
    }
    return;
  }
  try {
    await store.insertEvent({
      id,
      owner,
      kind: "direct_owner_submission",
      detail: { hash: hash.toUpperCase(), network },
      createdAt,
    });
  } catch {
    const raced = await store.getEvent(id);
    if (
      !raced ||
      raced.kind !== "direct_owner_submission" ||
      raced.owner !== owner ||
      raced.detail.hash !== hash.toUpperCase() ||
      raced.detail.network !== network
    ) {
      throw new Error("direct owner submission could not be bound safely");
    }
  }
}

type DirectSubmissionBindingRow = {
  owner: string;
  network: string;
  origin_profile: string | null;
};

async function readLocalDirectSubmissionBinding(
  db: D1Database,
  principal: string,
  hash: string,
): Promise<DirectSubmissionBindingRow | null> {
  return db
    .prepare(
      `SELECT owner, network, origin_profile
         FROM direct_submission_bindings
        WHERE principal = ? AND hash = ?`,
    )
    .bind(principal, hash.toUpperCase())
    .first<DirectSubmissionBindingRow>();
}

async function directSubmissionBinding(
  ctx: OpContext,
  store: Store,
  principal: string,
  hash: string,
): Promise<{ owner: string; network: "testnet" | "devnet" } | null> {
  if (localTradingIsolatedV1MarkersPresent(ctx.env)) {
    throw new Error(
      "Isolated local trading does not permit direct owner submission bindings",
    );
  }
  const event = await store.getEvent(directSubmissionEventId(principal, hash));
  if (!event) return null;
  const network = ExecutionNetworkSchema.safeParse(event.detail.network);
  if (
    event.kind !== "direct_owner_submission" ||
    event.detail.hash !== hash.toUpperCase() ||
    !isValidClassicAddress(event.owner) ||
    !network.success
  ) {
    throw new Error("direct owner submission binding is malformed");
  }
  if (localTradingSafetyMarkersPresent(ctx.env)) {
    const expectedOrigin = localTradingIsolatedOnboardingV1MarkersPresent(ctx.env)
      ? LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN
      : localTradingMarkersPresent(ctx.env)
        ? LOCAL_TRADING_BUILD_ORIGIN
        : LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN;
    const binding = await readLocalDirectSubmissionBinding(
      database(ctx),
      principal,
      hash,
    );
    if (
      !binding ||
      binding.owner !== event.owner ||
      binding.network !== network.data ||
      binding.origin_profile !== expectedOrigin
    ) {
      throw new Error(
        "direct owner submission binding does not match the active local profile",
      );
    }
  }
  const link = await store.getLink(event.owner, network.data);
  if (!link || link.owner !== event.owner || link.network !== network.data) {
    throw new Error("direct owner submission binding has no matching account link");
  }
  return { owner: event.owner, network: network.data };
}

export async function handleTxSubmit(
  ctx: OpContext,
  rawArgs: TxSubmitArgs,
): Promise<ApprovalSubmissionResult> {
  const args = TxSubmitArgsSchema.parse(rawArgs);
  const services = configuredServices(ctx);
  const store = storeFor(ctx, services);
  if (args.approval_id) {
    const requestV2 = args.execution_contract === "xrpl_execution_v2";
    if (requestV2) assertV2LocalProfile(ctx);
    let approval = await store.getApproval(args.approval_id);
    if (!approval) throw new Error("approval not found");
    const approvalV2 = approval.executionContract === "xrpl_execution_v2";
    if (requestV2 !== approvalV2) {
      throw new ExecutionLifetimeError(
        "The submit request and approval execution contracts disagree",
        "EXECUTION_CONTRACT_MISMATCH",
      );
    }
    const build = approvalV2 ? null : await store.getBuild(approval.buildId);
    if (approvalV2) {
      assertIsolatedBuildCapability(
        ctx,
        await store.getBuild(approval.buildId),
      );
    }
    if (!approvalV2 && !build) throw new Error("approval build not found");
    const approvalExecution = await store.getExecution(
      executionIdForApproval(approval),
    );
    if (!approvalExecution || approvalExecution.buildId !== approval.buildId) {
      throw new Error("approval execution not found");
    }
    const snapshot = approvalV2
      ? await store.getExecutionSnapshot(approvalExecution.id)
      : null;
    assertIsolatedSnapshotTestnet(ctx, snapshot);
    const revision = approvalV2
      ? await store.getBuildRevision(approval.buildId, approval.buildRevision!)
      : null;
    if (approvalV2) {
      if (
        !snapshot ||
        !revision ||
        approval.executionId !== approvalExecution.id ||
        snapshot.approvalId !== approval.id ||
        snapshot.approvalExpiresAt !== approval.expiresAt
      ) {
        throw new ExecutionLifetimeError(
          "The approval snapshot is missing or inconsistent",
          "EXECUTION_SNAPSHOT_INVALID",
        );
      }
      assertSnapshotMatchesRevision(snapshot, revision);
      if (
        canonicalizeJson(approval.txJson) !==
        canonicalizeJson(unsignedOwnerTransaction(revision.txJson))
      ) {
        throw new ExecutionLifetimeError(
          "The approved owner transaction differs from the immutable revision",
          "APPROVAL_TRANSACTION_MISMATCH",
        );
      }
      assertV2Binding(
        args as TxSubmitArgs & {
          execution_contract: "xrpl_execution_v2";
          build_revision: number;
          unsigned_tx_digest: string;
          economic_fingerprint: string;
        },
        snapshot,
      );
      if (await readApprovalRecovery(database(ctx), ctx.principal, approval.id)) {
        throw approvalRecoveryError(
          "APPROVAL_RECOVERY_CONFLICT",
          "The approval tuple was permanently burned after complete non-inclusion proof",
        );
      }
      const durableRejection = await readPreflightRejection(
        database(ctx),
        ctx.principal,
        approval.id,
      );
      if (durableRejection !== null) {
        throw preflightRejectionError(durableRejection);
      }
      if (approval.status === "rejected") {
        throw new ExecutionLifetimeError(
          "The rejected approval has no immutable preflight outcome",
          "EXECUTION_SNAPSHOT_INVALID",
        );
      }
    }
    const effectiveBuild: BuildRow = snapshot && revision
      ? {
          id: approval.buildId,
          principal: ctx.principal,
          owner: snapshot.snapshotOwner,
          network: snapshot.snapshotNetwork,
          txJson: revision.txJson,
          summary: {
            action: "v2 immutable approval",
            account: snapshot.snapshotOwner,
            amounts: [],
            fee_drops: String(revision.txJson.Fee),
            reserve_delta_drops: "0",
            usd_value: String(approvalExecution.usdValue ?? 0),
          },
          lastLedgerSeq: snapshot.lastLedgerSequence,
          createdAt: snapshot.createdAt,
          originProfile: null,
          executionContract: "xrpl_execution_v2",
          buildRevision: snapshot.buildRevision,
        }
      : build!;
    assertLocalTradingTestnet(ctx, effectiveBuild.network);
    if (!approvalV2) {
      await assertLocalBuildCapability(
        ctx,
        store,
        build!,
        approvalExecution.idempotencyKey,
      );
    }
    const requiredLocalPolicy = approvalV2
      ? undefined
      : await exactLocalTradingPolicy(ctx, store, build!);
    if (args.network !== undefined && args.network !== effectiveBuild.network) {
      throw new Error("submitted network does not match the stored approval network");
    }
    const terminalReplay = await replayTerminalApprovalSubmission(
      store,
      approval,
      args.tx_blob,
    );
    if (terminalReplay) return terminalReplay;
    if (approval.status === "expired") {
      throw new ApprovalExpiredError();
    }
    if (approval.status === "invalidated") {
      throw new ExecutionLifetimeError(
        "The approval was invalidated by a revision refresh",
        "APPROVAL_INVALIDATED",
      );
    }
    const claimableStatus = approvalV2 ? "preflighted" : "pending";
    if (approval.status !== claimableStatus && approval.status !== "submitted") {
      throw new ExecutionLifetimeError(
        approvalV2
          ? "A v2 approval must be preflighted before submission"
          : "The approval is not pending",
        approvalV2
          ? "APPROVAL_PREFLIGHT_REQUIRED"
          : "EXECUTION_SNAPSHOT_INVALID",
      );
    }
    const now = nowFor(services);
    const db = database(ctx);
    if (
      approval.status === claimableStatus &&
      new Date(approval.expiresAt).getTime() <= now.getTime()
    ) {
      if (approvalV2) {
        // A preflighted v2 approval may represent a lost authorization
        // response. Wall expiry freezes it for proof-based reconciliation;
        // submit must not destroy that evidence by changing its status.
        throw new ApprovalExpiredError();
      }
      approval = await expirePendingApprovalAtomic(db, store, approval);
      if (approval.status === "expired") throw new ApprovalExpiredError();
      const racedReplay = await replayTerminalApprovalSubmission(
        store,
        approval,
        args.tx_blob,
      );
      if (racedReplay) return racedReplay;
      if (approval.status !== "submitted") {
        throw new Error("approval changed state while expiry was being claimed");
      }
    }
    if (!services.submitApproval || !services.submitSigned) {
      throw new Error("approval submission service is not configured");
    }
    const hash = signedTransactionHash(args.tx_blob).toUpperCase();
    const ownerSignedTx = decodeSignedBlob(args.tx_blob);
    if (ownerSignedTx.Account !== effectiveBuild.owner) {
      throw new ExecutionLifetimeError(
        "The owner-signed transaction account differs from the approved build",
        "APPROVAL_TRANSACTION_MISMATCH",
      );
    }
    if (approval.status === claimableStatus) {
      validateApprovedBlob(
        args.tx_blob,
        approvalV2
          ? { ...approval, status: "pending" as const }
          : approval,
        now,
      );
    }
    const policy =
      snapshot?.policySnapshot ??
      requiredLocalPolicy ??
      (await store.getPolicy(effectiveBuild.owner, effectiveBuild.network))?.json ??
      DEFAULT_POLICY;
    if (snapshot && revision) {
      await validateV2LiveEvidence(ctx, snapshot, revision.txJson);
    }
    let claim: ApprovalClaim;
    try {
      claim = await claimApprovalBudget(
        db,
        store,
        ctx.principal,
        approval,
        effectiveBuild,
        hash,
        policy.daily_cap_usd,
        now,
        approvalV2,
      );
    } catch (error) {
      if (
        approvalV2 &&
        await readApprovalRecovery(db, ctx.principal, approval.id)
      ) {
        throw approvalRecoveryError(
          "APPROVAL_RECOVERY_CONFLICT",
          "The approval tuple was permanently burned after complete non-inclusion proof",
        );
      }
      const currentApproval = await store.getApproval(approval.id);
      if (currentApproval) {
        const terminalWinner = await replayTerminalApprovalSubmission(
          store,
          currentApproval,
          args.tx_blob,
        );
        if (terminalWinner) return terminalWinner;
      }
      throw error;
    }
    if (!await ensureOwnerAccountSequenceLease({
      db, principal: ctx.principal, execution: claim.execution,
      network: executionNetwork(effectiveBuild.network), owner: effectiveBuild.owner,
      source: snapshot ?? build!, tx: ownerSignedTx, hash,
      at: nowFor(services).toISOString(),
    })) {
      throw new ExecutionLifetimeError(
        "Another transaction for this XRPL account owns the sequence lease",
        "SUBMISSION_PENDING",
      );
    }
    if (claim.mode === "resume") {
      let recovery: ApprovalReconciliation;
      try {
        recovery = await reconcileApprovedExecution(
          ctx,
          services,
          db,
          approval.id,
          claim.execution,
          snapshot ?? build!,
          hash,
        );
      } catch {
        throw new ExecutionLifetimeError(
          "The owner-signed submission remains pending ledger reconciliation",
          "SUBMISSION_PENDING",
        );
      }
      if (recovery.state === "validated") return recovery.result;
      if (recovery.state === "failed") {
        throw new Error("Approved transaction did not validate before expiration");
      }
      throw new ExecutionLifetimeError(
        approvalV2
          ? "The sole owner relay remains pending reconciliation"
          : "The owner-signed submission remains pending ledger reconciliation",
        "SUBMISSION_PENDING",
      );
    }
    if (snapshot && revision) {
      await validateV2LiveEvidence(ctx, snapshot, revision.txJson);
      await claimV2Relay(
        store,
        claim.execution.id,
        hash,
        nowFor(services).toISOString(),
      );
    }
    let result: ValidatedSubmission;
    try {
      result =
        claim.mode === "claimed"
          ? await services.submitApproval({
              ctx,
              network: executionNetwork(effectiveBuild.network),
              txBlob: args.tx_blob,
              approval,
              executionContract: approvalV2
                ? "xrpl_execution_v2"
                : "xrpl_execution_v1",
            })
          : await services.submitSigned({
              ctx,
              network: executionNetwork(effectiveBuild.network),
              txBlob: args.tx_blob,
              executionContract: approvalV2
                ? "xrpl_execution_v2"
                : "xrpl_execution_v1",
            });
      if (result.hash.toUpperCase() !== hash) {
        throw new Error("validated transaction hash did not match the reserved approval");
      }
    } catch (error) {
      await markAccountSequenceAmbiguous(
        db, claim.execution, executionNetwork(effectiveBuild.network),
        effectiveBuild.owner, hash, nowFor(services).toISOString(),
      );
      let recovery: ApprovalReconciliation;
      try {
        recovery = await reconcileApprovedExecution(
          ctx,
          services,
          db,
          approval.id,
          claim.execution,
          snapshot ?? build!,
          hash,
        );
      } catch {
        throw new ExecutionLifetimeError(
          "The owner-signed submission remains pending ledger reconciliation",
          "SUBMISSION_PENDING",
        );
      }
      if (recovery.state === "validated") return recovery.result;
      if (recovery.state === "failed") {
        throw new Error("Approved transaction did not validate before expiration");
      }
      throw new ExecutionLifetimeError(
        approvalV2
          ? "The sole owner relay outcome remains pending reconciliation"
          : "The owner-signed submission remains pending ledger reconciliation",
        "SUBMISSION_PENDING",
      );
    }
    await releaseAccountSequenceValidated(
      db, claim.execution, executionNetwork(effectiveBuild.network),
      effectiveBuild.owner, hash, result.ledger_index, result.engine_result,
      nowFor(services).toISOString(),
    );
    await completeApprovedExecution(
      db,
      ctx.principal,
      approval.id,
      claim.execution.id,
      hash,
      result,
    );
    return result;
  }
  if (!services.submitSigned) {
    throw new Error("submission service is not configured");
  }
  if (args.network === undefined) {
    throw new Error("network is required for a direct owner submission");
  }
  if (
    localTradingIsolatedV1MarkersPresent(ctx.env) ||
    (localTradingIsolatedOnboardingV1MarkersPresent(ctx.env)
      ? !isReviewedLocalTradingIsolatedOnboardingV1Context(ctx)
      : localTradingSafetyMarkersPresent(ctx.env) &&
        !isReviewedLocalTradingOnboardingContext(ctx))
  ) {
    throw new Error(
      "Direct owner submission is permitted only in the reviewed local trading onboarding profile",
    );
  }
  assertLocalTradingTestnet(ctx, args.network);
  const decoded = decodeSignedBlob(args.tx_blob);
  const account = decoded.Account;
  if (typeof account !== "string" || !isValidClassicAddress(account)) {
    throw new Error("direct owner submission has an invalid account");
  }
  const link = await store.getLink(account, args.network);
  if (!link || link.network !== args.network) {
    throw new Error("direct owner submission has no matching account link on the selected network");
  }
  validateDirectOwnerDelegateSet(decoded, link);
  const hash = signedTransactionHash(args.tx_blob).toUpperCase();
  const sequence = decoded.Sequence;
  const lastLedgerSequence = decoded.LastLedgerSequence;
  if (
    !Number.isSafeInteger(sequence) ||
    Number(sequence) < 0 ||
    !Number.isSafeInteger(lastLedgerSequence) ||
    Number(lastLedgerSequence) < 1
  ) {
    throw new Error("direct owner submission has no bounded sequence window");
  }
  const bound = await directSubmissionBinding(
    ctx,
    store,
    ctx.principal,
    hash,
  );
  if (bound && (bound.owner !== account || bound.network !== args.network)) {
    throw new Error("direct owner submission binding is inconsistent");
  }
  const authority = new AccountSequenceLeaseAuthority(database(ctx));
  let validatedHead: number | undefined;
  let lease = await authority.get({ network: args.network, account });
  if (lease && directLeaseMatches(lease, ctx.principal, hash)) {
    if (
      bound === null &&
      (lease.state === "submitted" || lease.state === "ambiguous" ||
        lease.state === "released")
    ) {
      throw new ExecutionLifetimeError(
        "The direct owner submission has a sequence lease without durable provenance",
        "SUBMISSION_PENDING",
      );
    }
    if (lease.state === "released") return directTerminalReplay(lease, hash);
    if (lease.state === "submitted" || lease.state === "ambiguous") {
      const reconciled = await reconcileDirectSubmission(
        ctx,
        services,
        lease,
        hash,
      );
      if (reconciled) return reconciled;
      throw new ExecutionLifetimeError(
        "The direct owner submission remains pending ledger reconciliation",
        "SUBMISSION_PENDING",
      );
    }
  } else {
    if (bound !== null) {
      throw new ExecutionLifetimeError(
        "The legacy direct owner submission has no matching sequence lease",
        "SUBMISSION_PENDING",
      );
    }
    // A pending link is not proof that this principal controls its owner.
    // Verify the exact signature against validated AccountRoot authority before
    // creating a global account-sequence lease or durable submission binding.
    validatedHead = await authorizeDirectOwnerSignature(
      ctx,
      args.network,
      args.tx_blob,
      decoded,
    );
    const acquired = await authority.acquire({
      principal: ctx.principal,
      network: args.network,
      account,
      source: "manual",
      attemptId: directSubmissionAttemptId(hash),
      token: await sequenceLeaseToken(directSubmissionAttemptId(hash)),
      at: nowFor(services).toISOString(),
    });
    if (acquired.outcome === "blocked") {
      throw new ExecutionLifetimeError(
        "Another transaction for this XRPL account owns the sequence lease",
        "SUBMISSION_PENDING",
      );
    }
    lease = acquired.lease;
  }
  if (lease.state === "preparing") {
    try {
      validatedHead ??= await authorizeDirectOwnerSignature(
        ctx,
        args.network,
        args.tx_blob,
        decoded,
      );
    } catch (error) {
      await authority.releasePreSign({
        ...accountSequenceIdentity(lease),
        at: nowFor(services).toISOString(),
        proof: "signing_never_began",
      });
      throw error;
    }
    const firstLedgerSequence = validatedHead + 1;
    if (
      firstLedgerSequence > Number(lastLedgerSequence) ||
      Number(lastLedgerSequence) > validatedHead + DIRECT_OWNER_MAX_LEDGER_WINDOW
    ) {
      await authority.releasePreSign({
        ...accountSequenceIdentity(lease),
        at: nowFor(services).toISOString(),
        proof: "signing_never_began",
      });
      throw new Error("direct owner submission has no safe bounded ledger window");
    }
    const signing = await authority.markSigning({
      ...accountSequenceIdentity(lease),
      sequence: Number(sequence),
      firstLedgerSequence,
      lastLedgerSequence: Number(lastLedgerSequence),
      at: nowFor(services).toISOString(),
    });
    if (signing.outcome === "blocked") {
      throw new ExecutionLifetimeError(
        "The direct owner sequence lease could not begin signing",
        "SUBMISSION_PENDING",
      );
    }
    lease = signing.lease;
  }
  if (
    lease.sequence !== Number(sequence) ||
    lease.lastLedgerSequence !== Number(lastLedgerSequence)
  ) {
    throw new ExecutionLifetimeError(
      "The direct owner transaction does not match its sequence lease",
      "SUBMISSION_PENDING",
    );
  }
  if (lease.state === "signing") {
    const signed = await authority.markSigned({
      ...accountSequenceIdentity(lease),
      hash,
      at: nowFor(services).toISOString(),
    });
    if (signed.outcome === "blocked") {
      throw new ExecutionLifetimeError(
        "The direct owner signed transaction could not be fenced",
        "SUBMISSION_PENDING",
      );
    }
    lease = signed.lease;
  }
  if (lease.state !== "signed") {
    throw new ExecutionLifetimeError(
      "The direct owner transaction has unresolved sequence state",
      "SUBMISSION_PENDING",
    );
  }
  if (bound === null) {
    await bindDirectOwnerSubmission(
      ctx,
      store,
      ctx.principal,
      account,
      args.network,
      hash,
      nowFor(services).toISOString(),
    );
  }
  const submitted = await authority.markSubmitted({
    ...accountSequenceIdentity(lease),
    hash,
    at: nowFor(services).toISOString(),
  });
  if (submitted.outcome !== "transitioned") {
    const reconciled = await reconcileDirectSubmission(
      ctx,
      services,
      submitted.lease,
      hash,
    );
    if (reconciled) return reconciled;
    throw new ExecutionLifetimeError(
      "The direct owner submission remains pending ledger reconciliation",
      "SUBMISSION_PENDING",
    );
  }
  lease = submitted.lease;
  let result: ValidatedSubmission;
  try {
    result = await services.submitSigned({
      ctx,
      network: args.network,
      txBlob: args.tx_blob,
    });
    if (result.hash.toUpperCase() !== hash) {
      throw new Error("validated transaction hash did not match the direct owner submission");
    }
  } catch {
    const ambiguous = await authority.markAmbiguous({
      ...accountSequenceIdentity(lease),
      hash,
      at: nowFor(services).toISOString(),
    });
    if (
      ambiguous.lease.state === "released" &&
      directLeaseMatches(ambiguous.lease, ctx.principal, hash)
    ) {
      return directTerminalReplay(ambiguous.lease, hash);
    }
    if (ambiguous.outcome === "blocked") {
      throw new ExecutionLifetimeError(
        "The direct owner submission remains pending ledger reconciliation",
        "SUBMISSION_PENDING",
      );
    }
    const reconciled = await reconcileDirectSubmission(
      ctx,
      services,
      ambiguous.lease,
      hash,
    );
    if (reconciled) return reconciled;
    throw new ExecutionLifetimeError(
      "The direct owner submission remains pending ledger reconciliation",
      "SUBMISSION_PENDING",
    );
  }
  const resolution = await resolveDirectSubmission(
    ctx,
    lease,
    hash,
    { ...result, network: args.network },
    nowFor(services).toISOString(),
  );
  if (resolution.state === "pending") {
    throw new ExecutionLifetimeError(
      "The direct owner submission returned incomplete validation evidence",
      "SUBMISSION_PENDING",
    );
  }
  return directResolutionResult(resolution);
}

export async function handleTxStatus(
  ctx: OpContext,
  rawArgs: TxStatusArgs,
): Promise<TransactionStatus> {
  const args = TxStatusArgsSchema.parse(rawArgs);
  const services = configuredServices(ctx);
  const store = storeFor(ctx, services);
  const execution = await store.findExecutionByHash(args.hash.toUpperCase());
  let network = defaultExecutionNetwork(ctx);
  let owner: string | undefined;
  let build: BuildRow | null = null;
  let snapshot: ExecutionSnapshotRow | null = null;
  let directBinding: { owner: string; network: "testnet" | "devnet" } | null = null;
  if (execution) {
    snapshot = await store.getExecutionSnapshot(execution.id);
    assertIsolatedSnapshotTestnet(ctx, snapshot);
    build = snapshot ? null : await store.getBuild(execution.buildId);
    if (snapshot) {
      assertIsolatedBuildCapability(
        ctx,
        await store.getBuild(execution.buildId),
      );
    }
    if (!snapshot && !build) {
      throw new Error("transaction status execution build not found");
    }
    const authoritativeNetwork = snapshot?.snapshotNetwork ?? build!.network;
    const authoritativeOwner = snapshot?.snapshotOwner ?? build!.owner;
    assertLocalTradingTestnet(ctx, authoritativeNetwork);
    if (snapshot) {
      assertV2LocalProfile(ctx);
      if (snapshot.buildId !== execution.buildId) {
        throw new ExecutionLifetimeError(
          "The execution snapshot does not match its execution",
          "EXECUTION_SNAPSHOT_INVALID",
        );
      }
      const revision = await store.getBuildRevision(
        snapshot.buildId,
        snapshot.buildRevision,
      );
      if (!revision) {
        throw new ExecutionLifetimeError(
          "The execution snapshot has no immutable build revision",
          "EXECUTION_SNAPSHOT_INVALID",
        );
      }
      assertSnapshotMatchesRevision(snapshot, revision);
    } else {
      await assertLocalBuildCapability(
        ctx,
        store,
        build!,
        execution.idempotencyKey,
      );
    }
    network = executionNetwork(authoritativeNetwork);
    owner = authoritativeOwner;
  } else {
    directBinding = await directSubmissionBinding(
      ctx,
      store,
      ctx.principal,
      args.hash,
    );
    if (directBinding) {
      assertLocalTradingTestnet(ctx, directBinding.network);
      network = directBinding.network;
      owner = directBinding.owner;
    }
  }
  if (localTradingSafetyMarkersPresent(ctx.env) && owner === undefined) {
    throw new Error(
      "Local trading transaction status requires a profile-matching authenticated submission",
    );
  }
  if (
    args.network !== undefined &&
    (owner === undefined || args.network !== network || args.account !== owner)
  ) {
    throw new Error("status account or network does not match the authenticated submission");
  }
  assertLocalTradingTestnet(ctx, network);
  if (!services.status) throw new Error("status service is not configured");
  let status = await services.status(ctx, network, args.hash.toUpperCase());
  if (!execution && directBinding) {
    const authority = new AccountSequenceLeaseAuthority(database(ctx));
    const lease = await authority.get({
      network: directBinding.network,
      account: directBinding.owner,
    });
    if (
      lease &&
      directLeaseMatches(lease, ctx.principal, args.hash) &&
      lease.hash === args.hash.toUpperCase() &&
      lease.state !== "released" &&
      lease.state !== "preparing" &&
      lease.state !== "signing"
    ) {
      const resolution = await resolveDirectSubmission(
        ctx,
        lease,
        args.hash,
        status,
        nowFor(services).toISOString(),
      );
      if (resolution.state === "validated") status = resolution.status;
    }
    return status;
  }
  if (execution?.status !== "submitted" || (!build && !snapshot)) return status;

  const db = database(ctx);
  const source = snapshot ?? build!;
  let finalStatus = finalStatusFromService(
    status,
    network,
    args.hash.toUpperCase(),
    source,
  );
  let absenceProof: Extract<ExpiredTransactionProof, { state: "absent" }> | null = null;
  if (!finalStatus) {
    const proof = await proveExpiredTransaction(
      ctx,
      network,
      args.hash.toUpperCase(),
      source,
    );
    if (proof.state === "included") {
      finalStatus = proof.status;
      status = proof.status;
    } else if (proof.state === "absent") {
      absenceProof = proof;
    }
  }
  if (execution.signedBy === "owner") {
    const approvals = await db
      .prepare(
        `SELECT id FROM approvals
          WHERE principal = ? AND build_id = ?
            AND ((? IS NOT NULL AND execution_id = ?)
              OR (? IS NULL AND execution_id IS NULL AND id LIKE ?))
          ORDER BY id LIMIT 2`,
      )
      .bind(
        ctx.principal,
        execution.buildId,
        snapshot?.executionId ?? null,
        execution.id,
        snapshot?.executionId ?? null,
        `${execution.id}.%`,
      )
      .all<{ id: string }>();
    if (approvals.results.length !== 1) return status;
    const approvalId = approvals.results[0].id;
    if (finalStatus) {
      await releaseAccountSequenceValidated(
        db, execution, network, owner!, args.hash.toUpperCase(),
        finalStatus.ledger_index, finalStatus.engine_result,
        nowFor(services).toISOString(),
      );
      if (finalStatus.engine_result === "tesSUCCESS") {
        await completeApprovedExecution(
          db,
          ctx.principal,
          approvalId,
          execution.id,
          args.hash.toUpperCase(),
          {
            hash: args.hash.toUpperCase(),
            ledger_index: finalStatus.ledger_index,
            engine_result: finalStatus.engine_result,
            validated: true,
          },
        );
      } else {
        await failApprovedExecution(
          db,
          ctx.principal,
          approvalId,
          execution.id,
          args.hash.toUpperCase(),
          {
            status: "failed",
            engine_result: finalStatus.engine_result,
            detail: "Owner-signed transaction reached a validated ledger without tesSUCCESS",
          },
        );
      }
    } else if (absenceProof !== null) {
      await releaseAccountSequenceAbsent(
        db, execution, network, owner!, args.hash.toUpperCase(),
        absenceProof.validatedHead, absenceProof.checkedFrom,
        absenceProof.checkedThrough, nowFor(services).toISOString(),
      );
      await failApprovedExecution(
        db,
        ctx.principal,
        approvalId,
        execution.id,
        args.hash.toUpperCase(),
        {
          status: "failed",
          engine_result: "tefMAX_LEDGER",
          detail: "Owner-signed transaction was absent after its LastLedgerSequence",
        },
      );
    }
    return status;
  }

  if (finalStatus) {
    const signer = await readDelegatedSigner(store, execution);
    const result: ExecResult =
      finalStatus.engine_result === "tesSUCCESS"
        ? {
            status: "executed",
            hash: args.hash.toUpperCase(),
            ledger_index: finalStatus.ledger_index,
            result: "success",
            signed_by: "delegate",
            ...(signer ? { signer } : {}),
          }
        : {
            status: "failed",
            engine_result: finalStatus.engine_result,
            detail: "Transaction reached a validated ledger without tesSUCCESS",
          };
    await releaseAccountSequenceValidated(
      db, execution, network, owner!, args.hash.toUpperCase(),
      finalStatus.ledger_index, finalStatus.engine_result,
      nowFor(services).toISOString(),
    );
    await completeDelegatedExecution(
      db,
      ctx.principal,
      execution,
      owner!,
      result,
      nowFor(services).toISOString(),
    );
  } else if (absenceProof !== null) {
    await releaseAccountSequenceAbsent(
      db, execution, network, owner!, args.hash.toUpperCase(),
      absenceProof.validatedHead, absenceProof.checkedFrom,
      absenceProof.checkedThrough, nowFor(services).toISOString(),
    );
    await completeDelegatedExecution(
      db,
      ctx.principal,
      execution,
      owner!,
      {
        status: "failed",
        engine_result: "tefMAX_LEDGER",
        detail: "Transaction was absent after its LastLedgerSequence",
      },
      nowFor(services).toISOString(),
    );
  }
  return status;
}

export const ops: OpDef[] = [
  {
    name: "tx.execute",
    family: "tx",
    summary: "Evaluate policy and idempotently execute or prepare owner approval for a stored build, with an explicit force-approval option.",
    tags: ["transaction", "execution", "policy", "delegation"],
    args: TxExecuteArgsSchema,
    returns: "ExecResult",
    caveats: [],
    example:
      'await harbor.tx.execute({ build_id: "build-id", idempotency_key: "intent-id", require_owner_approval: true })',
    handler: (ctx, args) =>
      handleTxExecute(ctx, TxExecuteArgsSchema.parse(args)),
  },
  {
    name: "tx.approvalPreflight",
    family: "tx",
    summary:
      "Atomically preflight an exact v2 owner approval immediately before signing.",
    tags: ["transaction", "approval", "preflight"],
    args: TxApprovalPreflightArgsSchema,
    returns: "v2 owner approval readiness",
    caveats: [],
    example:
      'await harbor.tx.approvalPreflight({ approval_id: "approval-id", execution_contract: "xrpl_execution_v2", build_revision: 1, unsigned_tx_digest: "...", economic_fingerprint: "..." })',
    handler: (ctx, args) =>
      handleTxApprovalPreflight(
        ctx,
        TxApprovalPreflightArgsSchema.parse(args),
      ),
  },
  {
    name: "tx.approvalReconcile",
    family: "tx",
    summary:
      "Burn an expired unsigned v2 approval only after complete exact-ledger non-inclusion proof.",
    tags: ["transaction", "approval", "reconciliation", "recovery"],
    args: TxApprovalReconcileArgsSchema,
    returns: "terminal expired non-inclusion proof",
    caveats: [],
    example:
      'await harbor.tx.approvalReconcile({ approval_id: "approval-id", execution_contract: "xrpl_execution_v2", build_revision: 1, unsigned_tx_digest: "...", economic_fingerprint: "..." })',
    handler: (ctx, args) =>
      handleTxApprovalReconcile(
        ctx,
        TxApprovalReconcileArgsSchema.parse(args),
      ),
  },
  {
    name: "tx.submit",
    family: "tx",
    summary: "Relay a signed test-network transaction, verifying an approval when supplied.",
    tags: ["transaction", "submit", "approval"],
    args: TxSubmitArgsSchema,
    returns: "validated submission result",
    caveats: [],
    example:
      'await harbor.tx.submit({ tx_blob: "1200...", network: "devnet" })',
    handler: (ctx, args) =>
      handleTxSubmit(ctx, TxSubmitArgsSchema.parse(args)),
  },
  {
    name: "tx.status",
    family: "tx",
    summary: "Read the validated status of a submitted transaction hash.",
    tags: ["transaction", "status", "validation"],
    args: TxStatusArgsSchema,
    returns: "transaction validation status",
    caveats: [],
    example:
      'await harbor.tx.status({ hash: "64_HEX_TRANSACTION_HASH", network: "devnet", account: "r..." })',
    handler: (ctx, args) =>
      handleTxStatus(ctx, TxStatusArgsSchema.parse(args)),
  },
];
