import type { ExecResult, ExecutionCapability, ExecutionContract, TxBuild } from "@pilot/contracts";
import type { ArgsFor } from "@pilot/harbor-client";
import { z } from "zod";

export const OFFICIAL_TESTNET_RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
export const OFFICIAL_TESTNET_RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
export const RLUSD_ACQUISITION_EXACT_OUTPUT = "75";
export const RLUSD_ACQUISITION_MAX_SLIPPAGE_BPS = 100;
export const RLUSD_ACQUISITION_ABSOLUTE_CAP_DROPS = 275_000_000n;
export const OFFER_TF_FILL_OR_KILL = 0x0004_0000;
export const RLUSD_ACQUISITION_MAX_FEE_DROPS = 100n;
export const RLUSD_ACQUISITION_MIN_FEE_DROPS = 10n;
export const RLUSD_ACQUISITION_LEDGER_WINDOW = 4;
export const RLUSD_ACQUISITION_V2_LEDGER_WINDOW = 64;
export const RLUSD_ACQUISITION_V2_MIN_REMAINING_LEDGERS = 8;
export const RLUSD_ACQUISITION_V2_APPROVAL_TTL_SECONDS = 90;
export const RLUSD_ACQUISITION_MAX_QUOTE_AGE_LEDGERS = 1;
export const RLUSD_ACQUISITION_ROUNDING_REFERENCE =
  "xrpl-exact-output-rounding-v1";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/;
const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const TRANSACTION_HASH = /^[A-F0-9]{64}$/;
const FORBIDDEN_PERSISTED_KEY = /^(?:tx_?blob|signed_?blob|seed|secret|api_?key|private_?key)$/i;

const ALLOWED_OFFER_CREATE_FIELDS = new Set([
  "TransactionType",
  "Account",
  "TakerGets",
  "TakerPays",
  "Fee",
  "Sequence",
  "LastLedgerSequence",
  "Flags",
  "Expiration",
  "SourceTag",
  "Memos",
  "SigningPubKey",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(context: z.RefinementCtx, path: Array<string | number>, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function intentIdFor(operationId: string): string {
  return `p-live-acquire-rlusd-${operationId}`;
}

const ExactRlusdAmountSchema = z
  .object({
    currency: z.literal(OFFICIAL_TESTNET_RLUSD_CURRENCY),
    issuer: z.literal(OFFICIAL_TESTNET_RLUSD_ISSUER),
    value: z.literal(RLUSD_ACQUISITION_EXACT_OUTPUT),
  })
  .strict();

const RlusdAssetSchema = z
  .object({
    currency: z.literal(OFFICIAL_TESTNET_RLUSD_CURRENCY),
    issuer: z.literal(OFFICIAL_TESTNET_RLUSD_ISSUER),
  })
  .strict();

const IdentityShapeSchema = z
  .object({
    operation_id: z.string().regex(CANONICAL_UUID),
    owner: z.string().regex(CLASSIC_ADDRESS),
    network: z.literal("testnet"),
    asset: RlusdAssetSchema,
    amount: z.literal(RLUSD_ACQUISITION_EXACT_OUTPUT),
    cap_drops: z.literal(RLUSD_ACQUISITION_ABSOLUTE_CAP_DROPS.toString()),
    intent_id: z.string(),
  })
  .strict();

export const RlusdAcquisitionIdentitySchema = IdentityShapeSchema.superRefine((identity, context) => {
  if (identity.intent_id !== intentIdFor(identity.operation_id)) {
    issue(context, ["intent_id"], "intent id is not bound to the operation UUID");
  }
});

export type RlusdAcquisitionIdentity = z.infer<typeof RlusdAcquisitionIdentitySchema>;

export function createRlusdAcquisitionIdentity(
  owner: string,
  operationId: string = globalThis.crypto.randomUUID(),
): RlusdAcquisitionIdentity {
  return RlusdAcquisitionIdentitySchema.parse({
    operation_id: operationId,
    owner,
    network: "testnet",
    asset: {
      currency: OFFICIAL_TESTNET_RLUSD_CURRENCY,
      issuer: OFFICIAL_TESTNET_RLUSD_ISSUER,
    },
    amount: RLUSD_ACQUISITION_EXACT_OUTPUT,
    cap_drops: RLUSD_ACQUISITION_ABSOLUTE_CAP_DROPS.toString(),
    intent_id: intentIdFor(operationId),
  });
}

export function maximumRlusdAcquisitionInputDrops(sourceAmountDrops: bigint): bigint {
  if (typeof sourceAmountDrops !== "bigint" || sourceAmountDrops <= 0n) {
    throw new Error("RLUSD quote source amount must be positive drops");
  }
  return (
    sourceAmountDrops * BigInt(10_000 + RLUSD_ACQUISITION_MAX_SLIPPAGE_BPS) + 9_999n
  ) / 10_000n;
}

const QuoteShapeSchema = z
  .object({
    source: z.literal("ripple_path_find.validated.exact_output"),
    rounding_reference: z.literal(RLUSD_ACQUISITION_ROUNDING_REFERENCE),
    network: z.literal("testnet"),
    account: z.string().regex(CLASSIC_ADDRESS),
    ledger_index: z.number().int().positive().safe(),
    ledger_hash: z.string().regex(TRANSACTION_HASH),
    source_asset: z.object({ currency: z.literal("XRP") }).strict(),
    source_amount_drops: z.string().regex(POSITIVE_INTEGER),
    max_slippage_bps: z.literal(RLUSD_ACQUISITION_MAX_SLIPPAGE_BPS),
    maximum_input_drops: z.string().regex(POSITIVE_INTEGER),
    destination_amount: ExactRlusdAmountSchema,
  })
  .strict();

export const RlusdAcquisitionQuoteSchema = QuoteShapeSchema.superRefine((quote, context) => {
  const maximum = maximumRlusdAcquisitionInputDrops(BigInt(quote.source_amount_drops));
  if (quote.maximum_input_drops !== maximum.toString()) {
    issue(context, ["maximum_input_drops"], "quote cap is not the exact rounded one-percent ceiling");
  }
  if (maximum > RLUSD_ACQUISITION_ABSOLUTE_CAP_DROPS) {
    issue(context, ["maximum_input_drops"], "quote cap exceeds the absolute acquisition cap");
  }
});

export type RlusdAcquisitionQuote = z.infer<typeof RlusdAcquisitionQuoteSchema>;

export function createRlusdAcquisitionQuote(
  identity: RlusdAcquisitionIdentity,
  sourceAmountDrops: bigint,
  ledgerIndex: number,
  ledgerHash: string,
): RlusdAcquisitionQuote {
  const bound = RlusdAcquisitionIdentitySchema.parse(identity);
  return RlusdAcquisitionQuoteSchema.parse({
    source: "ripple_path_find.validated.exact_output",
    rounding_reference: RLUSD_ACQUISITION_ROUNDING_REFERENCE,
    network: bound.network,
    account: bound.owner,
    ledger_index: ledgerIndex,
    ledger_hash: ledgerHash,
    source_asset: { currency: "XRP" },
    source_amount_drops: sourceAmountDrops.toString(),
    max_slippage_bps: RLUSD_ACQUISITION_MAX_SLIPPAGE_BPS,
    maximum_input_drops: maximumRlusdAcquisitionInputDrops(sourceAmountDrops).toString(),
    destination_amount: {
      currency: OFFICIAL_TESTNET_RLUSD_CURRENCY,
      issuer: OFFICIAL_TESTNET_RLUSD_ISSUER,
      value: RLUSD_ACQUISITION_EXACT_OUTPUT,
    },
  });
}

export function rlusdAcquisitionSwapArgs(
  identity: RlusdAcquisitionIdentity,
  executionContract: ExecutionContract = "xrpl_execution_v1",
): ArgsFor<"tx.swap"> {
  const bound = RlusdAcquisitionIdentitySchema.parse(identity);
  return {
    account: bound.owner,
    network: bound.network,
    intent_id: bound.intent_id,
    sell: { currency: "XRP" },
    buy: bound.asset,
    amount: { ...bound.asset, value: bound.amount },
    side: "buy",
    max_slippage_bps: RLUSD_ACQUISITION_MAX_SLIPPAGE_BPS,
    execution_mode: "fill_or_kill",
    ...(executionContract === "xrpl_execution_v2"
      ? { execution_contract: executionContract }
      : {}),
  };
}

export function rlusdAcquisitionExecuteArgs(
  identity: RlusdAcquisitionIdentity,
  buildId: string,
  attempt = 0,
  executionCapability?: ExecutionCapability,
): ArgsFor<"tx.execute"> {
  const bound = RlusdAcquisitionIdentitySchema.parse(identity);
  if (typeof buildId !== "string" || buildId.trim().length === 0 || buildId.length > 256) {
    throw new Error("RLUSD acquisition build id is invalid");
  }
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error("RLUSD acquisition attempt is invalid");
  }
  const common = {
    build_id: buildId,
    idempotency_key: attempt === 0
      ? bound.intent_id
      : `${bound.intent_id}:attempt:${attempt}`,
    require_owner_approval: true,
  } as const;
  if (!executionCapability) return common;
  return {
    ...common,
    execution_contract: executionCapability.execution_contract,
    build_revision: executionCapability.build_revision,
  };
}

export type RlusdAcquisitionAccountState = Readonly<{
  ledgerIndex: number;
  sequence: number;
}>;

export type RlusdAcquisitionBuildValidationCode =
  | "ACCOUNT_STATE_CHANGED"
  | "BUILD_EXPIRED"
  | "EXCESS_LEDGER_HORIZON"
  | "EXECUTION_CONTRACT_MISMATCH"
  | "QUOTE_LEDGER_MISMATCH"
  | "QUOTE_STALE";

export class RlusdAcquisitionBuildValidationError extends Error {
  constructor(
    readonly code: RlusdAcquisitionBuildValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "RlusdAcquisitionBuildValidationError";
  }
}

export type RlusdAcquisitionTransactionDigest = Readonly<Record<string, unknown>>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]),
    );
  }
  return Object.is(left, right);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) {
    return Object.entries(value).every(([key, item]) => key.length > 0 && isJsonValue(item));
  }
  return false;
}

export function rlusdAcquisitionTransactionDigest(
  transaction: Readonly<Record<string, unknown>>,
): RlusdAcquisitionTransactionDigest {
  const digest = { ...transaction };
  delete digest.Fee;
  delete digest.Sequence;
  delete digest.LastLedgerSequence;
  return canonicalize(digest) as RlusdAcquisitionTransactionDigest;
}

function parseSafeAccountState(value: RlusdAcquisitionAccountState): RlusdAcquisitionAccountState {
  if (
    !Number.isSafeInteger(value.ledgerIndex) || value.ledgerIndex < 1 ||
    !Number.isSafeInteger(value.sequence) || value.sequence < 0
  ) {
    throw new Error("Validated account state is invalid");
  }
  return value;
}

function assertIdentityQuoteBinding(
  identity: RlusdAcquisitionIdentity,
  quote: RlusdAcquisitionQuote,
): void {
  if (
    quote.network !== identity.network || quote.account !== identity.owner ||
    !jsonEqual(quote.destination_amount, { ...identity.asset, value: identity.amount })
  ) {
    throw new Error("RLUSD quote is not bound to the approved operation");
  }
}

function validateTransaction(
  transaction: unknown,
  identityInput: RlusdAcquisitionIdentity,
  quoteInput: RlusdAcquisitionQuote,
  accountStateInput: RlusdAcquisitionAccountState,
  executionContract: ExecutionContract,
  v2BuildLedger?: number,
): Record<string, unknown> {
  const identity = RlusdAcquisitionIdentitySchema.parse(identityInput);
  const quote = RlusdAcquisitionQuoteSchema.parse(quoteInput);
  const accountState = parseSafeAccountState(accountStateInput);
  assertIdentityQuoteBinding(identity, quote);

  if (!isRecord(transaction)) throw new Error("RLUSD acquisition transaction is missing");
  if (!isJsonValue(transaction)) {
    throw new Error("RLUSD acquisition transaction is not safe JSON");
  }
  if (Object.keys(transaction).some((field) => !ALLOWED_OFFER_CREATE_FIELDS.has(field))) {
    throw new Error("RLUSD acquisition transaction contains unsupported fields");
  }
  if ("Delegate" in transaction || "TxnSignature" in transaction) {
    throw new Error("RLUSD acquisition transaction must be unsigned and owner-approved");
  }
  if (transaction.TransactionType !== "OfferCreate" || transaction.Account !== identity.owner) {
    throw new Error("RLUSD acquisition transaction type or owner is invalid");
  }
  if (transaction.Flags !== OFFER_TF_FILL_OR_KILL) {
    throw new Error("RLUSD acquisition transaction must use the exact fill-or-kill flag");
  }
  if (!jsonEqual(transaction.TakerPays, { ...identity.asset, value: identity.amount })) {
    throw new Error("RLUSD acquisition transaction does not buy exactly 75 official Testnet RLUSD");
  }
  if (typeof transaction.TakerGets !== "string" || !POSITIVE_INTEGER.test(transaction.TakerGets)) {
    throw new Error("RLUSD acquisition XRP spend must be positive drops");
  }
  const independentCap = maximumRlusdAcquisitionInputDrops(BigInt(quote.source_amount_drops));
  const spend = BigInt(transaction.TakerGets);
  if (spend > independentCap || spend > RLUSD_ACQUISITION_ABSOLUTE_CAP_DROPS) {
    throw new Error("RLUSD acquisition XRP spend exceeds its independently rounded cap");
  }
  if (typeof transaction.Fee !== "string" || !NON_NEGATIVE_INTEGER.test(transaction.Fee)) {
    throw new Error("RLUSD acquisition fee is invalid");
  }
  const fee = BigInt(transaction.Fee);
  if (fee < RLUSD_ACQUISITION_MIN_FEE_DROPS || fee > RLUSD_ACQUISITION_MAX_FEE_DROPS) {
    throw new Error("RLUSD acquisition fee is outside the immutable safe range");
  }
  if (!Number.isSafeInteger(transaction.Sequence) || transaction.Sequence !== accountState.sequence) {
    throw new RlusdAcquisitionBuildValidationError(
      "ACCOUNT_STATE_CHANGED",
      "RLUSD acquisition sequence is not current",
    );
  }
  if (!Number.isSafeInteger(transaction.LastLedgerSequence)) {
    throw new Error("RLUSD acquisition ledger deadline is invalid");
  }
  if ((transaction.LastLedgerSequence as number) <= accountState.ledgerIndex) {
    throw new RlusdAcquisitionBuildValidationError(
      "BUILD_EXPIRED",
      "RLUSD acquisition build is expired at the validated account ledger",
    );
  }
  const maximumLastLedgerSequence = executionContract === "xrpl_execution_v2"
    ? Number(v2BuildLedger) + RLUSD_ACQUISITION_V2_LEDGER_WINDOW
    : accountState.ledgerIndex + RLUSD_ACQUISITION_LEDGER_WINDOW;
  if (
    !Number.isSafeInteger(maximumLastLedgerSequence) ||
    (transaction.LastLedgerSequence as number) > maximumLastLedgerSequence
  ) {
    throw new RlusdAcquisitionBuildValidationError(
      "EXCESS_LEDGER_HORIZON",
      "RLUSD acquisition build exceeds the bounded ledger horizon",
    );
  }
  if (
    executionContract === "xrpl_execution_v2" &&
    (transaction.LastLedgerSequence as number) !== maximumLastLedgerSequence
  ) {
    throw new RlusdAcquisitionBuildValidationError(
      "EXECUTION_CONTRACT_MISMATCH",
      "RLUSD acquisition build does not use the exact execution-contract ledger horizon",
    );
  }
  if (quote.ledger_index > accountState.ledgerIndex) {
    throw new RlusdAcquisitionBuildValidationError(
      "QUOTE_LEDGER_MISMATCH",
      "RLUSD acquisition quote ledger is newer than the validated account ledger",
    );
  }
  if (accountState.ledgerIndex - quote.ledger_index > RLUSD_ACQUISITION_MAX_QUOTE_AGE_LEDGERS) {
    throw new RlusdAcquisitionBuildValidationError(
      "QUOTE_STALE",
      "RLUSD acquisition quote is stale",
    );
  }
  if (transaction.SigningPubKey !== undefined && transaction.SigningPubKey !== "") {
    throw new Error("RLUSD acquisition transaction must not contain a signing key");
  }
  if (
    transaction.Expiration !== undefined &&
    (!Number.isSafeInteger(transaction.Expiration) || (transaction.Expiration as number) < 0)
  ) {
    throw new Error("RLUSD acquisition expiration is invalid");
  }
  if (
    transaction.SourceTag !== undefined &&
    (!Number.isSafeInteger(transaction.SourceTag) || (transaction.SourceTag as number) < 0 ||
      (transaction.SourceTag as number) > 0xffff_ffff)
  ) {
    throw new Error("RLUSD acquisition source tag is invalid");
  }
  if (transaction.Memos !== undefined && !Array.isArray(transaction.Memos)) {
    throw new Error("RLUSD acquisition memos are invalid");
  }
  return transaction;
}

export type ValidatedRlusdAcquisitionBuild = Readonly<{
  identity: RlusdAcquisitionIdentity;
  build: TxBuild;
  transaction: Record<string, unknown>;
  transactionDigest: RlusdAcquisitionTransactionDigest;
  quote: RlusdAcquisitionQuote;
  accountState: RlusdAcquisitionAccountState;
  executionCapability?: ExecutionCapability;
}>;

function validateExecutionCapability(
  capability: ExecutionCapability | undefined,
  executionContract: ExecutionContract,
  transaction: Record<string, unknown>,
  quote: RlusdAcquisitionQuote,
  accountState: RlusdAcquisitionAccountState,
): ExecutionCapability | undefined {
  if (executionContract === "xrpl_execution_v1") {
    if (capability !== undefined) {
      throw new RlusdAcquisitionBuildValidationError(
        "EXECUTION_CONTRACT_MISMATCH",
        "Legacy RLUSD acquisition build unexpectedly advertised a v2 capability",
      );
    }
    return undefined;
  }
  if (
    capability === undefined ||
    capability.execution_contract !== "xrpl_execution_v2" ||
    capability.build_revision !== 1 ||
    capability.unsigned_tx_digest_alg !== "sha256-jcs-v1" ||
    capability.economic_fingerprint_alg !== "sha256-jcs-economic-v1" ||
    capability.build_ledger > accountState.ledgerIndex ||
    capability.first_inclusion_ledger !== capability.build_ledger + 1 ||
    capability.last_ledger_sequence !== capability.build_ledger + RLUSD_ACQUISITION_V2_LEDGER_WINDOW ||
    capability.last_ledger_sequence !== transaction.LastLedgerSequence ||
    capability.minimum_remaining_ledgers !== RLUSD_ACQUISITION_V2_MIN_REMAINING_LEDGERS ||
    capability.approval_expires_in_seconds !== RLUSD_ACQUISITION_V2_APPROVAL_TTL_SECONDS ||
    capability.quote_ledger === undefined ||
    capability.quote_valid_through_ledger === undefined ||
    capability.quote_valid_through_ledger !== capability.quote_ledger + 1 ||
    capability.quote_ledger > capability.build_ledger ||
    capability.build_ledger < quote.ledger_index ||
    capability.build_ledger > capability.quote_valid_through_ledger
    || capability.acquisition_balance_invariant?.kind !== "issued_balance_unchanged"
    || capability.acquisition_balance_invariant.currency !== OFFICIAL_TESTNET_RLUSD_CURRENCY
    || capability.acquisition_balance_invariant.issuer !== OFFICIAL_TESTNET_RLUSD_ISSUER
    || capability.acquisition_balance_invariant.ledger_index > capability.build_ledger
    || capability.build_ledger - capability.acquisition_balance_invariant.ledger_index > 1
  ) {
    throw new RlusdAcquisitionBuildValidationError(
      "EXECUTION_CONTRACT_MISMATCH",
      "Harbor did not return the exact v2 RLUSD execution capability",
    );
  }
  return capability;
}

export function validateRlusdAcquisitionBuild(
  build: TxBuild,
  identity: RlusdAcquisitionIdentity,
  quote: RlusdAcquisitionQuote,
  accountState: RlusdAcquisitionAccountState,
  executionContract: ExecutionContract = "xrpl_execution_v1",
): ValidatedRlusdAcquisitionBuild {
  const boundIdentity = RlusdAcquisitionIdentitySchema.parse(identity);
  if (!isRecord(build) || typeof build.build_id !== "string" || build.build_id.trim().length === 0) {
    throw new Error("RLUSD acquisition build id is invalid");
  }
  if (build.network !== "testnet" || build.summary?.account !== boundIdentity.owner) {
    throw new Error("RLUSD acquisition build owner or network is invalid");
  }
  if (build.simulate?.applied !== false || build.simulate.engine_result !== "tesSUCCESS") {
    throw new Error("RLUSD acquisition build simulation is unsafe");
  }
  if (
    !Array.isArray(build.preflight) || build.preflight.length === 0 ||
    build.preflight.some((check) =>
      !isRecord(check) || typeof check.check !== "string" || check.check.length === 0 || check.pass !== true
    )
  ) {
    throw new Error("RLUSD acquisition build did not pass every preflight check");
  }
  if (
    (executionContract === "xrpl_execution_v2") !==
      (build.execution_capability !== undefined)
  ) {
    throw new RlusdAcquisitionBuildValidationError(
      "EXECUTION_CONTRACT_MISMATCH",
      "Harbor build capability does not match the requested execution contract",
    );
  }
  const transaction = validateTransaction(
    build.tx_json,
    boundIdentity,
    quote,
    accountState,
    executionContract,
    build.execution_capability?.build_ledger,
  );
  const executionCapability = validateExecutionCapability(
    build.execution_capability,
    executionContract,
    transaction,
    quote,
    accountState,
  );
  return {
    identity: boundIdentity,
    build,
    transaction,
    transactionDigest: rlusdAcquisitionTransactionDigest(transaction),
    quote: RlusdAcquisitionQuoteSchema.parse(quote),
    accountState: parseSafeAccountState(accountState),
    ...(executionCapability ? { executionCapability } : {}),
  };
}

type ApprovalResult = Extract<ExecResult, { status: "needs_approval" }>;

export function validateRlusdAcquisitionApproval(
  approval: ExecResult,
  validatedBuild: ValidatedRlusdAcquisitionBuild,
  identity: RlusdAcquisitionIdentity,
  accountState: RlusdAcquisitionAccountState,
  now = Date.now(),
): ApprovalResult {
  if (
    !isRecord(approval) || approval.status !== "needs_approval" ||
    typeof approval.approval_id !== "string" || approval.approval_id.trim().length === 0 ||
    approval.approval_id.length > 256 || approval.policy?.verdict !== "needs_approval"
  ) {
    throw new Error("Harbor did not return a valid owner approval");
  }
  const expiresAt = Date.parse(approval.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("RLUSD acquisition approval is expired");
  }
  const executionContract = validatedBuild.executionCapability?.execution_contract ??
    "xrpl_execution_v1";
  if (
    executionContract === "xrpl_execution_v2" &&
    expiresAt > now + RLUSD_ACQUISITION_V2_APPROVAL_TTL_SECONDS * 1_000
  ) {
    throw new Error("RLUSD acquisition approval exceeds the exact v2 wall-clock lifetime");
  }
  if (
    isRecord(approval.tx_json) &&
    approval.tx_json.LastLedgerSequence !== validatedBuild.transaction.LastLedgerSequence
  ) {
    throw new Error("RLUSD acquisition approval changed the exact ledger deadline");
  }
  const transaction = validateTransaction(
    approval.tx_json,
    identity,
    validatedBuild.quote,
    accountState,
    executionContract,
    validatedBuild.executionCapability?.build_ledger,
  );
  if (
    transaction.Fee !== validatedBuild.transaction.Fee ||
    transaction.Sequence !== validatedBuild.transaction.Sequence
  ) {
    throw new Error("RLUSD acquisition approval changed exact build envelope fields");
  }
  if (!jsonEqual(
    rlusdAcquisitionTransactionDigest(transaction),
    validatedBuild.transactionDigest,
  )) {
    throw new Error("RLUSD acquisition approval changed the build transaction digest");
  }
  return approval as ApprovalResult;
}

const CommonStateSchema = IdentityShapeSchema.extend({
  version: z.literal(1),
  balance_before: z.string().regex(CANONICAL_DECIMAL),
});

const BuiltStateFields = {
  build_id: z.string().trim().min(1).max(256),
  tx_json: z.record(z.string(), z.unknown()),
  transaction_digest: z.record(z.string(), z.unknown()),
  quote: QuoteShapeSchema,
  validated_ledger_index: z.number().int().positive().safe(),
  account_sequence: z.number().int().nonnegative().safe(),
  execution_capability: z.object({
    execution_contract: z.literal("xrpl_execution_v2"),
    build_revision: z.number().int().positive().safe(),
    unsigned_tx_digest: z.string().regex(TRANSACTION_HASH),
    unsigned_tx_digest_alg: z.literal("sha256-jcs-v1"),
    economic_fingerprint: z.string().regex(TRANSACTION_HASH),
    economic_fingerprint_alg: z.literal("sha256-jcs-economic-v1"),
    build_ledger: z.number().int().positive().safe(),
    first_inclusion_ledger: z.number().int().positive().safe(),
    last_ledger_sequence: z.number().int().positive().safe(),
    minimum_remaining_ledgers: z.literal(RLUSD_ACQUISITION_V2_MIN_REMAINING_LEDGERS),
    approval_expires_in_seconds: z.literal(RLUSD_ACQUISITION_V2_APPROVAL_TTL_SECONDS),
    quote_ledger: z.number().int().positive().safe().optional(),
    quote_valid_through_ledger: z.number().int().positive().safe().optional(),
    acquisition_balance_invariant: z.object({
      kind: z.literal("issued_balance_unchanged"),
      currency: z.literal(OFFICIAL_TESTNET_RLUSD_CURRENCY),
      issuer: z.literal(OFFICIAL_TESTNET_RLUSD_ISSUER),
      balance: z.string().regex(CANONICAL_DECIMAL),
      ledger_index: z.number().int().positive().safe(),
    }).strict().optional(),
  }).strict().optional(),
} as const;

const BuiltStateSchema = CommonStateSchema.extend({
  status: z.literal("built"),
  ...BuiltStateFields,
}).strict();

const SignedPendingStateSchema = CommonStateSchema.extend({
  status: z.literal("signed_pending"),
  ...BuiltStateFields,
  hash: z.string().regex(TRANSACTION_HASH),
  last_ledger_sequence: z.number().int().positive().safe(),
}).strict();

const ValidatedStateSchema = CommonStateSchema.extend({
  status: z.literal("validated"),
  ...BuiltStateFields,
  hash: z.string().regex(TRANSACTION_HASH),
  last_ledger_sequence: z.number().int().positive().safe(),
  ledger_index: z.number().int().positive().safe(),
  balance_after: z.string().regex(CANONICAL_DECIMAL),
}).strict();

const RawRlusdAcquisitionPublicStateSchema = z.discriminatedUnion("status", [
  BuiltStateSchema,
  SignedPendingStateSchema,
  ValidatedStateSchema,
]);

export type RlusdAcquisitionPublicState = z.infer<typeof RawRlusdAcquisitionPublicStateSchema>;

function assertNoPersistedSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPersistedSecrets(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_PERSISTED_KEY.test(key)) {
      throw new Error("RLUSD acquisition public state contains signed material or a secret");
    }
    assertNoPersistedSecrets(item);
  }
}

function stateIdentity(state: RlusdAcquisitionPublicState): RlusdAcquisitionIdentity {
  return RlusdAcquisitionIdentitySchema.parse({
    operation_id: state.operation_id,
    owner: state.owner,
    network: state.network,
    asset: state.asset,
    amount: state.amount,
    cap_drops: state.cap_drops,
    intent_id: state.intent_id,
  });
}

function assertStateInternals(state: RlusdAcquisitionPublicState): void {
  const identity = stateIdentity(state);
  const validated = validateRlusdAcquisitionBuild({
    build_id: state.build_id,
    network: "testnet",
    tx_json: state.tx_json,
    delegable: false,
    simulate: { engine_result: "tesSUCCESS", engine_result_message: "persisted", applied: false },
    preflight: [{ check: "persisted", pass: true }],
    summary: {
      action: "Acquire RLUSD",
      account: identity.owner,
      amounts: [],
      fee_drops: String(state.tx_json.Fee ?? ""),
      reserve_delta_drops: "0",
    },
    ...(state.execution_capability
      ? { execution_capability: state.execution_capability }
      : {}),
  }, identity, state.quote, {
    ledgerIndex: state.validated_ledger_index,
    sequence: state.account_sequence,
  }, state.execution_capability ? "xrpl_execution_v2" : "xrpl_execution_v1");
  if (!jsonEqual(validated.transactionDigest, state.transaction_digest)) {
    throw new Error("RLUSD acquisition public state transaction digest is inconsistent");
  }
  if (
    state.execution_capability &&
    state.execution_capability.acquisition_balance_invariant?.balance !== state.balance_before
  ) {
    throw new Error("RLUSD acquisition public state balance invariant is inconsistent");
  }
  if (
    state.status !== "built" &&
    (state.last_ledger_sequence !== state.tx_json.LastLedgerSequence)
  ) {
    throw new Error("RLUSD acquisition public state ledger deadline is inconsistent");
  }
  if (state.status === "validated") {
    if (
      state.ledger_index < state.validated_ledger_index ||
      state.ledger_index > state.last_ledger_sequence
    ) {
      throw new Error("RLUSD acquisition validation ledger is outside the signed transaction window");
    }
    assertExactRlusdBalanceDelta(
      state.balance_before,
      state.balance_after,
      RLUSD_ACQUISITION_EXACT_OUTPUT,
    );
  }
}

export const RlusdAcquisitionPublicStateSchema =
  RawRlusdAcquisitionPublicStateSchema.superRefine((state, context) => {
    try {
      assertNoPersistedSecrets(state);
      assertStateInternals(state);
    } catch (error) {
      issue(
        context,
        [],
        error instanceof Error ? error.message : "RLUSD acquisition public state is invalid",
      );
    }
  });

export function parseRlusdAcquisitionPublicState(
  value: unknown,
  expectedIdentity: RlusdAcquisitionIdentity,
): RlusdAcquisitionPublicState {
  assertNoPersistedSecrets(value);
  const state = RlusdAcquisitionPublicStateSchema.parse(value);
  const expected = RlusdAcquisitionIdentitySchema.parse(expectedIdentity);
  if (!jsonEqual(stateIdentity(state), expected)) {
    throw new Error("Persisted RLUSD acquisition state is bound to a different operation");
  }
  assertStateInternals(state);
  return state;
}

export type RlusdAcquisitionStateEvent =
  | Readonly<{
    type: "built";
    validatedBuild: ValidatedRlusdAcquisitionBuild;
    balanceBefore: string;
  }>
  | Readonly<{
    type: "signed_pending";
    hash: string;
  }>
  | Readonly<{
    type: "validated";
    hash: string;
    ledgerIndex: number;
    balanceAfter: string;
  }>;

export function reduceRlusdAcquisitionPublicState(
  identityInput: RlusdAcquisitionIdentity,
  state: RlusdAcquisitionPublicState | undefined,
  event: RlusdAcquisitionStateEvent,
): RlusdAcquisitionPublicState {
  const identity = RlusdAcquisitionIdentitySchema.parse(identityInput);
  if (state) parseRlusdAcquisitionPublicState(state, identity);

  if (event.type === "built") {
    if (state !== undefined) throw new Error("RLUSD acquisition build may only be recorded once");
    if (!CANONICAL_DECIMAL.test(event.balanceBefore)) {
      throw new Error("RLUSD acquisition starting balance is invalid");
    }
    const { validatedBuild } = event;
    if (!jsonEqual(validatedBuild.identity, identity)) {
      throw new Error("RLUSD acquisition build is bound to a different operation");
    }
    const next = {
      version: 1 as const,
      ...identity,
      status: "built" as const,
      balance_before: event.balanceBefore,
      build_id: validatedBuild.build.build_id,
      tx_json: validatedBuild.transaction,
      transaction_digest: validatedBuild.transactionDigest,
      quote: validatedBuild.quote,
      validated_ledger_index: validatedBuild.accountState.ledgerIndex,
      account_sequence: validatedBuild.accountState.sequence,
      ...(validatedBuild.executionCapability
        ? { execution_capability: validatedBuild.executionCapability }
        : {}),
    };
    return parseRlusdAcquisitionPublicState(next, identity);
  }

  if (!state) throw new Error("RLUSD acquisition state is missing");
  if (event.type === "signed_pending") {
    if (state.status !== "built" || !TRANSACTION_HASH.test(event.hash)) {
      throw new Error("RLUSD acquisition signed-pending transition is invalid");
    }
    return parseRlusdAcquisitionPublicState({
      ...state,
      status: "signed_pending",
      hash: event.hash,
      last_ledger_sequence: state.tx_json.LastLedgerSequence,
    }, identity);
  }

  if (
    state.status !== "signed_pending" || event.hash !== state.hash ||
    !Number.isSafeInteger(event.ledgerIndex) || event.ledgerIndex < 1
  ) {
    throw new Error("RLUSD acquisition validated transition is invalid");
  }
  assertExactRlusdBalanceDelta(
    state.balance_before,
    event.balanceAfter,
    RLUSD_ACQUISITION_EXACT_OUTPUT,
  );
  return parseRlusdAcquisitionPublicState({
    ...state,
    status: "validated",
    ledger_index: event.ledgerIndex,
    balance_after: event.balanceAfter,
  }, identity);
}

export type RlusdAcquisitionRecoveryAction =
  | Readonly<{ action: "request_approval"; resubmit: false }>
  | Readonly<{ action: "reconcile_hash"; hash: string; lastLedgerSequence: number; resubmit: false }>
  | Readonly<{ action: "complete"; hash: string; ledgerIndex: number; resubmit: false }>;

export function rlusdAcquisitionRecoveryAction(
  state: RlusdAcquisitionPublicState,
  expectedIdentity: RlusdAcquisitionIdentity,
): RlusdAcquisitionRecoveryAction {
  const parsed = parseRlusdAcquisitionPublicState(state, expectedIdentity);
  if (parsed.status === "built") return { action: "request_approval", resubmit: false };
  if (parsed.status === "signed_pending") {
    return {
      action: "reconcile_hash",
      hash: parsed.hash,
      lastLedgerSequence: parsed.last_ledger_sequence,
      resubmit: false,
    };
  }
  return {
    action: "complete",
    hash: parsed.hash,
    ledgerIndex: parsed.ledger_index,
    resubmit: false,
  };
}

type DecimalParts = Readonly<{ units: bigint; scale: number }>;

function decimalParts(value: string): DecimalParts {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    throw new Error("RLUSD balance is not a canonical decimal");
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  return {
    units: BigInt(`${integer}${fraction}`) * (negative ? -1n : 1n),
    scale: fraction.length,
  };
}

export function assertExactRlusdBalanceDelta(
  before: string,
  after: string,
  expectedIncrease = RLUSD_ACQUISITION_EXACT_OUTPUT,
): void {
  const values = [decimalParts(before), decimalParts(after), decimalParts(expectedIncrease)];
  const scale = Math.max(...values.map((value) => value.scale));
  const normalize = (value: DecimalParts) => value.units * (10n ** BigInt(scale - value.scale));
  if (normalize(values[1]!) - normalize(values[0]!) !== normalize(values[2]!)) {
    throw new Error(`Validated RLUSD balance delta was not exactly ${expectedIncrease}`);
  }
}
