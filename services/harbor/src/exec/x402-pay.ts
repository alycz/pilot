import { isValidClassicAddress, type Payment, type Transaction } from "xrpl";

import {
  validateX402Challenge,
  validateX402ResourceInfo,
  X402_INVOICE_ID_MAX_BYTES,
  X402_MAX_TIMEOUT_SECONDS,
  type ValidatedX402Challenge,
} from "../adapters/x402";
import type { XrplRpc } from "../adapters/xrpl-rpc";
import {
  LOCAL_X402_COMPARE_PRICE_DROPS,
  LOCAL_X402_PROBE_URL,
} from "../local-x402";
import { LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO } from "../local-x402-isolated-v1";
import {
  X402_MERCHANT_BODY_MAX_BYTES,
  parseX402MerchantJsonBody,
} from "../x402-contract";
import type { DelegateSigner, SignedTransaction } from "./keys";
import type {
  PayerSequenceLeaseAuthority,
  PayerSequenceLeaseIdentity,
  PayerSequenceLeaseRow,
} from "./payer-sequence-lease";
import type {
  ClaimX402Input,
  ClaimX402Result,
  JsonObject,
  ReserveX402Input,
  ReserveX402Result,
  TransitionResult,
  X402ExpiredAbsentProof,
  X402PaymentRow,
  X402SigningAbandonedProof,
  X402SettlementProof,
  X402ValidatedFailureProof,
} from "./x402-store";

export const X402_COMPARE_URL = LOCAL_X402_PROBE_URL;
export const X402_PER_CALL_CAP_DROPS = "100000";
export const X402_DAILY_CAP_DROPS = "1000000";
export const X402_MAX_FEE_DROPS = "100";
export const X402_BALANCE_CUSHION_DROPS = "1000000";
export const X402_MAX_LEDGER_WINDOW = 20;
export const X402_FETCH_TIMEOUT_MS = 8_000;
export const X402_CLAIM_RECOVERY_MS = 120_000;

const UINT32_MAX = 0xffff_ffff;
const HASH = /^[A-F0-9]{64}$/;
const HEX = /^[A-F0-9]+$/;
const DROPS = /^(?:0|[1-9][0-9]*)$/;
const XRP = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;
const INITIAL_HEADERS = Object.freeze({ accept: "application/json" });

function randomLeaseToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export type X402PayerIdentity = Readonly<{
  principal: string;
  owner: string;
  network: "testnet";
  payer: string;
  sourceTag: number;
}>;

/**
 * X402Store atomically reserves amount + feeCap, not merely the merchant
 * amount. Keep the concrete input/result contract here so an adapter cannot
 * silently weaken that accounting rule.
 */
export interface X402PaymentStore {
  getByIdempotencyKey(idempotencyKey: string): Promise<X402PaymentRow | null>;
  claim(input: ClaimX402Input): Promise<ClaimX402Result>;
  acquireClaimRecovery(
    idempotencyKey: string,
    expectedLeaseAcquiredAt: string,
    staleBefore: string,
    acquiredAt: string,
  ): Promise<TransitionResult>;
  reserve(input: ReserveX402Input): Promise<ReserveX402Result>;
  markSigningStarted(
    idempotencyKey: string,
    at: string,
  ): Promise<TransitionResult>;
  markSigningAbandoned(
    idempotencyKey: string,
    proof: X402SigningAbandonedProof,
    at: string,
  ): Promise<TransitionResult>;
  markSigned(
    idempotencyKey: string,
    value: { hash: string; signedBlob: string; signedAt: string },
  ): Promise<TransitionResult>;
  markSettlementUnknown(
    idempotencyKey: string,
    at: string,
    pendingDelivery?: JsonObject & {
      http_status: 200;
      content_type: "application/json";
    },
  ): Promise<TransitionResult>;
  markSettled(
    idempotencyKey: string,
    proof: X402SettlementProof,
    at: string,
  ): Promise<TransitionResult>;
  markValidatedFailure(
    idempotencyKey: string,
    proof: X402ValidatedFailureProof,
    at: string,
  ): Promise<TransitionResult>;
  markDelivered(
    idempotencyKey: string,
    delivery: JsonObject & { http_status: number },
    at: string,
  ): Promise<TransitionResult>;
  markFailed(
    idempotencyKey: string,
    failure: JsonObject,
    at: string,
  ): Promise<TransitionResult>;
  markClaimFailed(
    idempotencyKey: string,
    failure: JsonObject,
    at: string,
    leaseAcquiredAt: string,
  ): Promise<TransitionResult>;
  markExpiredAbsentFailed(
    idempotencyKey: string,
    proof: X402ExpiredAbsentProof,
    at: string,
  ): Promise<TransitionResult>;
}

export type ResolvedX402Payer = Readonly<{
  dedicated: true;
  identity: X402PayerIdentity;
  merchantPayTo: string;
  store: X402PaymentStore;
  policyPerCallCapDrops: string;
  dailyCapDrops: string;
}>;

export interface X402PayerLock {
  withLock<T>(key: string, callback: () => Promise<T>): Promise<T>;
}

export type EncodePaymentSignatureInput = Readonly<{
  challenge: ValidatedX402Challenge;
  transaction: Readonly<JsonObject>;
  signedBlob: string;
  hash: string;
}>;

export type ExecuteX402PaymentInput = Readonly<{
  principal: string;
  owner: string;
  network: "testnet";
  idempotencyKey: string;
  maxPriceDrops: string;
  /** Internal fixed-price binding used only by the isolated compare rail. */
  exactPriceDrops?: typeof LOCAL_X402_COMPARE_PRICE_DROPS;
  /** Public receiver binding used only by the isolated compare rail. */
  payTo?: typeof LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO;
  /** Callers may repeat the fixed URL, but cannot select another target. */
  url?: typeof X402_COMPARE_URL;
}>;

export type X402PaymentResult =
  | Readonly<{
      status: "settlement_unknown";
      hash: string;
      row: X402PaymentRow;
    }>
  | Readonly<{
      status: "delivered";
      hash: string;
      httpStatus: number;
      body: unknown;
      replayed: boolean;
      row: X402PaymentRow;
    }>;

export type X402PaymentDependencies = Readonly<{
  /** This must be explicitly true; production is disabled by default. */
  enabled?: boolean;
  fetch: typeof globalThis.fetch;
  xrpl: XrplRpc;
  lock: X402PayerLock;
  /** Required by the combined AP4M+x402 profile; absent on legacy isolated-v1. */
  sequenceLeases?: PayerSequenceLeaseAuthority;
  resolvePayer(
    binding: Readonly<{
      principal: string;
      owner: string;
      network: "testnet";
    }>,
  ): Promise<ResolvedX402Payer>;
  withDelegateSigner<T>(
    identity: X402PayerIdentity,
    callback: (signer: DelegateSigner) => T | Promise<T>,
  ): Promise<T>;
  encodePaymentSignature(input: EncodePaymentSignatureInput): string;
  now?: () => Date;
  newId?: () => string;
  newLeaseToken?: () => string;
}>;

export type X402PaymentErrorCode =
  | "X402_DISABLED"
  | "INVALID_INPUT"
  | "UNSUPPORTED_NETWORK"
  | "PAYER_BINDING_MISMATCH"
  | "IDEMPOTENCY_MISMATCH"
  | "INITIAL_RESPONSE_NOT_402"
  | "PAYMENT_REQUIRED_MISSING"
  | "LEDGER_RESPONSE_INVALID"
  | "FEE_CAP_EXCEEDED"
  | "INSUFFICIENT_SPENDABLE_BALANCE"
  | "RESERVATION_REJECTED"
  | "SIGNER_MISMATCH"
  | "SIGNING_OUTCOME_UNKNOWN"
  | "SIGNATURE_INVALID"
  | "STORE_TRANSITION_REJECTED"
  | "SETTLEMENT_EVIDENCE_MISMATCH"
  | "SETTLEMENT_EXPIRED"
  | "PAYMENT_SIGNATURE_INVALID"
  | "PAID_RESPONSE_REJECTED"
  | "TERMINAL_PAYMENT";

export class X402PaymentError extends Error {
  constructor(
    readonly code: X402PaymentErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "X402PaymentError";
  }
}

type LedgerPreparation = Readonly<{
  balanceDrops: bigint;
  reserveDrops: bigint;
  feeDrops: string;
  sequence: number;
  validatedLedgerIndex: number;
}>;

function reject(code: X402PaymentErrorCode, message?: string): never {
  throw new X402PaymentError(code, message ?? code);
}

function sequenceLeaseIdentity(
  lease: PayerSequenceLeaseRow,
): PayerSequenceLeaseIdentity {
  if (lease.rail !== "x402") reject("SIGNING_OUTCOME_UNKNOWN");
  return {
    network: lease.network,
    payer: lease.payer,
    generation: lease.generation,
    token: lease.token,
    rail: "x402",
    attemptId: lease.attemptId,
  };
}

function requireLeaseTransition(
  result: { outcome: "transitioned" | "replay" | "blocked" },
): void {
  if (result.outcome === "blocked") reject("SIGNING_OUTCOME_UNKNOWN");
}

function requireLeaseRelease(
  result: { outcome: "released" | "replay" | "blocked" },
): void {
  if (result.outcome === "blocked") reject("SIGNING_OUTCOME_UNKNOWN");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function canonicalDrops(value: unknown, allowZero = false): string {
  if (typeof value !== "string" || value.length > 16 || !DROPS.test(value)) {
    reject("LEDGER_RESPONSE_INVALID");
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    reject("LEDGER_RESPONSE_INVALID");
  }
  return value;
}

function positiveUInt32(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > UINT32_MAX
  ) {
    reject("LEDGER_RESPONSE_INVALID");
  }
  return value;
}

function nonnegativeUInt32(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > UINT32_MAX
  ) {
    reject("LEDGER_RESPONSE_INVALID");
  }
  return value;
}

function xrpToDrops(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 100_000_000_000) {
      reject("LEDGER_RESPONSE_INVALID");
    }
    const scaled = value * 1_000_000;
    if (!Number.isSafeInteger(scaled)) reject("LEDGER_RESPONSE_INVALID");
    return BigInt(scaled);
  }
  if (typeof value !== "string" || value.length > 20 || !XRP.test(value)) {
    reject("LEDGER_RESPONSE_INVALID");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function validateInput(input: ExecuteX402PaymentInput): void {
  const isolatedBindingFieldCount = [
    input.exactPriceDrops,
    input.payTo,
  ].filter((value) => value !== undefined).length;
  if (input.network !== "testnet") reject("UNSUPPORTED_NETWORK");
  if (
    typeof input.principal !== "string" ||
    input.principal.length === 0 ||
    input.principal.length > 256 ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length === 0 ||
    input.idempotencyKey.length > 200 ||
    !isValidClassicAddress(input.owner) ||
    (input.url !== undefined && input.url !== X402_COMPARE_URL) ||
    typeof input.maxPriceDrops !== "string" ||
    input.maxPriceDrops.length > 6 ||
    !DROPS.test(input.maxPriceDrops) ||
    BigInt(input.maxPriceDrops) === 0n ||
    BigInt(input.maxPriceDrops) > BigInt(X402_PER_CALL_CAP_DROPS) ||
    (isolatedBindingFieldCount !== 0 &&
      (isolatedBindingFieldCount !== 2 ||
        input.exactPriceDrops !== LOCAL_X402_COMPARE_PRICE_DROPS ||
        input.maxPriceDrops !== input.exactPriceDrops ||
        input.payTo !== LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO))
  ) {
    reject("INVALID_INPUT");
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
}

async function requestFingerprint(
  input: ExecuteX402PaymentInput,
): Promise<string> {
  return sha256(
    JSON.stringify({
      principal: input.principal,
      owner: input.owner,
      network: input.network,
      url: X402_COMPARE_URL,
      max_price_drops: input.maxPriceDrops,
      exact_price_drops: input.exactPriceDrops,
      pay_to: input.payTo,
    }),
  );
}

function assertBinding(
  input: ExecuteX402PaymentInput,
  resolved: ResolvedX402Payer,
): void {
  const identity = resolved.identity;
  if (
    resolved.dedicated !== true ||
    identity.principal !== input.principal ||
    identity.owner !== input.owner ||
    identity.network !== "testnet" ||
    !isValidClassicAddress(identity.payer) ||
    identity.payer === input.owner ||
    !isValidClassicAddress(resolved.merchantPayTo) ||
    (input.payTo !== undefined && resolved.merchantPayTo !== input.payTo) ||
    !Number.isInteger(identity.sourceTag) ||
    identity.sourceTag < 0 ||
    identity.sourceTag > UINT32_MAX
  ) {
    reject("PAYER_BINDING_MISMATCH");
  }
  for (const cap of [
    resolved.policyPerCallCapDrops,
    resolved.dailyCapDrops,
  ]) {
    if (!DROPS.test(cap)) reject("PAYER_BINDING_MISMATCH");
  }
  if (
    BigInt(resolved.policyPerCallCapDrops) > BigInt(X402_PER_CALL_CAP_DROPS) ||
    BigInt(resolved.dailyCapDrops) > BigInt(X402_DAILY_CAP_DROPS) ||
    BigInt(resolved.policyPerCallCapDrops) > BigInt(resolved.dailyCapDrops)
  ) {
    reject("PAYER_BINDING_MISMATCH");
  }
}

function assertIsolatedChallengeBinding(
  input: ExecuteX402PaymentInput,
  resolved: ResolvedX402Payer,
  challenge: ValidatedX402Challenge,
): void {
  if (input.payTo === undefined) return;
  if (
    input.exactPriceDrops !== LOCAL_X402_COMPARE_PRICE_DROPS ||
    input.maxPriceDrops !== LOCAL_X402_COMPARE_PRICE_DROPS
  ) {
    reject("RESERVATION_REJECTED");
  }
  if (challenge.amountDrops !== input.exactPriceDrops) {
    reject("RESERVATION_REJECTED");
  }
  if (
    input.payTo !== LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO ||
    resolved.merchantPayTo !== input.payTo ||
    challenge.payTo !== input.payTo
  ) {
    reject("PAYER_BINDING_MISMATCH");
  }
}

async function initialChallenge(
  deps: X402PaymentDependencies,
  maxPriceDrops: string,
  policyPerCallDrops: string,
  expectedSourceTag: number,
): Promise<ValidatedX402Challenge> {
  try {
    return await fixedGet(deps, new Headers(INITIAL_HEADERS), async (response) => {
      try {
        if (response.status !== 402) reject("INITIAL_RESPONSE_NOT_402");
        const header = response.headers.get("payment-required");
        if (header === null) reject("PAYMENT_REQUIRED_MISSING");
        return validateX402Challenge(header, {
          requestUrl: X402_COMPARE_URL,
          maxPriceDrops,
          policyPerCallDrops,
          network: "testnet",
          expectedSourceTag,
        });
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    });
  } catch (error) {
    if (error instanceof X402PaymentError) throw error;
    reject("INITIAL_RESPONSE_NOT_402");
  }
}

async function fixedGet<T>(
  deps: X402PaymentDependencies,
  headers: Headers,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), X402_FETCH_TIMEOUT_MS);
  try {
    const response = await deps.fetch(X402_COMPARE_URL, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
}

function serverLedger(result: Record<string, unknown>): {
  index: number;
  reserveBaseDrops: bigint;
  reserveIncrementDrops: bigint;
} {
  const info = result.info;
  if (!isRecord(info) || !isRecord(info.validated_ledger)) {
    reject("LEDGER_RESPONSE_INVALID");
  }
  return {
    index: positiveUInt32(info.validated_ledger.seq),
    reserveBaseDrops: xrpToDrops(info.validated_ledger.reserve_base_xrp),
    reserveIncrementDrops: xrpToDrops(info.validated_ledger.reserve_inc_xrp),
  };
}

async function prepareFromValidatedLedger(
  deps: X402PaymentDependencies,
  payer: string,
): Promise<LedgerPreparation> {
  const server = serverLedger(
    await deps.xrpl.request("testnet", "server_info", {}, { intent: "read" }),
  );
  const [accountResult, feeResult] = await Promise.all([
    deps.xrpl.request(
      "testnet",
      "account_info",
      {
        account: payer,
        ledger_index: server.index,
        queue: false,
        signer_lists: false,
      },
      { intent: "read" },
    ),
    deps.xrpl.request("testnet", "fee", {}, { intent: "read" }),
  ]);
  if (
    accountResult.ledger_index !== server.index ||
    !isRecord(accountResult.account_data) ||
    !isRecord(feeResult.drops)
  ) {
    reject("LEDGER_RESPONSE_INVALID");
  }
  const balance = BigInt(canonicalDrops(accountResult.account_data.Balance, true));
  const ownerCount = nonnegativeUInt32(accountResult.account_data.OwnerCount);
  const feeDrops = canonicalDrops(feeResult.drops.open_ledger_fee);
  if (BigInt(feeDrops) > BigInt(X402_MAX_FEE_DROPS)) {
    reject("FEE_CAP_EXCEEDED");
  }
  return {
    balanceDrops: balance,
    reserveDrops:
      server.reserveBaseDrops + server.reserveIncrementDrops * BigInt(ownerCount),
    feeDrops,
    sequence: positiveUInt32(accountResult.account_data.Sequence),
    validatedLedgerIndex: server.index,
  };
}

function transactionFor(
  identity: X402PayerIdentity,
  challenge: ValidatedX402Challenge,
  preparation: LedgerPreparation,
  invoiceId: string,
): Payment {
  const window = Math.min(
    X402_MAX_LEDGER_WINDOW,
    Math.max(4, Math.ceil(challenge.maxTimeoutSeconds / 4)),
  );
  const lastLedgerSequence = preparation.validatedLedgerIndex + window;
  if (lastLedgerSequence > UINT32_MAX) reject("LEDGER_RESPONSE_INVALID");

  // Field semantics and bounds: https://xrpl.org/docs/references/protocol/transactions/types/payment
  const transaction: Payment = {
    TransactionType: "Payment",
    Account: identity.payer,
    Destination: challenge.payTo,
    Amount: challenge.amountDrops,
    InvoiceID: invoiceId,
    SourceTag: challenge.sourceTag,
    Fee: preparation.feeDrops,
    Sequence: preparation.sequence,
    LastLedgerSequence: lastLedgerSequence,
  };
  if (challenge.destinationTag !== undefined) {
    transaction.DestinationTag = challenge.destinationTag;
  }
  return transaction;
}

function validSigned(value: SignedTransaction): SignedTransaction {
  const hash = value.hash.toUpperCase();
  const txBlob = value.tx_blob.toUpperCase();
  if (!HASH.test(hash) || !HEX.test(txBlob) || txBlob.length % 2 !== 0) {
    reject("SIGNATURE_INVALID");
  }
  return { hash, tx_blob: txBlob };
}

function exactOptional(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  key: string,
): boolean {
  return own(actual, key) === own(expected, key) && actual[key] === expected[key];
}

const LEDGER_PAYMENT_KEYS = new Set([
  "TransactionType",
  "Account",
  "Destination",
  "Amount",
  "InvoiceID",
  "SourceTag",
  "DestinationTag",
  "Fee",
  "Sequence",
  "LastLedgerSequence",
  "Flags",
  "SigningPubKey",
  "TxnSignature",
]);
const V2_LEDGER_PAYMENT_KEYS = new Set(
  [...LEDGER_PAYMENT_KEYS].map((key) => (key === "Amount" ? "DeliverMax" : key)),
);

const PREPARED_PAYMENT_KEYS = new Set([
  "TransactionType",
  "Account",
  "Destination",
  "Amount",
  "InvoiceID",
  "SourceTag",
  "DestinationTag",
  "Fee",
  "Sequence",
  "LastLedgerSequence",
]);

const TX_ENVELOPE_KEYS = new Set([
  "hash",
  "ctid",
  "ledger_index",
  "inLedger",
  "meta_blob",
  "meta",
  "validated",
  "close_time_iso",
  "date",
  "tx_json",
]);

function exactLedgerPayment(
  candidate: Record<string, unknown>,
  reserved: Record<string, unknown>,
): boolean {
  return (
    Object.keys(candidate).every((key) => LEDGER_PAYMENT_KEYS.has(key)) &&
    candidate.TransactionType === "Payment" &&
    candidate.Account === reserved.Account &&
    candidate.Destination === reserved.Destination &&
    candidate.Amount === reserved.Amount &&
    candidate.InvoiceID === reserved.InvoiceID &&
    candidate.SourceTag === reserved.SourceTag &&
    candidate.Fee === reserved.Fee &&
    candidate.Sequence === reserved.Sequence &&
    candidate.LastLedgerSequence === reserved.LastLedgerSequence &&
    exactOptional(candidate, reserved, "DestinationTag") &&
    exactOptional(candidate, reserved, "Flags") &&
    typeof candidate.SigningPubKey === "string" &&
    candidate.SigningPubKey.length > 0 &&
    HEX.test(candidate.SigningPubKey.toUpperCase()) &&
    typeof candidate.TxnSignature === "string" &&
    candidate.TxnSignature.length > 0 &&
    HEX.test(candidate.TxnSignature.toUpperCase())
  );
}

type ValidatedLedgerOutcome =
  | { kind: "success"; proof: X402SettlementProof }
  | { kind: "failure"; proof: X402ValidatedFailureProof }
  | { kind: "pending" };

function validatedLedgerOutcome(
  result: Record<string, unknown>,
  row: X402PaymentRow,
): ValidatedLedgerOutcome {
  if (result.validated === false) return { kind: "pending" };
  const hasV2Transaction = isRecord(result.tx_json);
  if (
    Object.keys(result).some(
      (key) => !TX_ENVELOPE_KEYS.has(key) && !LEDGER_PAYMENT_KEYS.has(key),
    )
  ) {
    reject("SETTLEMENT_EVIDENCE_MISMATCH");
  }
  const rawTx = hasV2Transaction
    ? (result.tx_json as Record<string, unknown>)
    : Object.fromEntries(
        Object.entries(result).filter(([key]) => LEDGER_PAYMENT_KEYS.has(key)),
      );
  if (
    hasV2Transaction &&
    Object.keys(result).some((key) => LEDGER_PAYMENT_KEYS.has(key))
  ) {
    reject("SETTLEMENT_EVIDENCE_MISMATCH");
  }
  if (
    hasV2Transaction &&
    (Object.keys(rawTx).some((key) => !V2_LEDGER_PAYMENT_KEYS.has(key)) ||
      own(rawTx, "Amount") ||
      !own(rawTx, "DeliverMax"))
  ) {
    reject("SETTLEMENT_EVIDENCE_MISMATCH");
  }
  const tx = hasV2Transaction
    ? Object.fromEntries(
        Object.entries(rawTx).map(([key, value]) => [
          key === "DeliverMax" ? "Amount" : key,
          value,
        ]),
      )
    : rawTx;
  const meta = result.meta;
  const ledgerIndex = result.ledger_index;
  if (
    result.validated !== true ||
    typeof result.hash !== "string" ||
    result.hash.toUpperCase() !== row.hash ||
    !Number.isSafeInteger(ledgerIndex) ||
    (ledgerIndex as number) < 1 ||
    row.lastLedgerSeq === null ||
    (ledgerIndex as number) > row.lastLedgerSeq ||
    !isRecord(meta) ||
    typeof meta.TransactionResult !== "string" ||
    row.transaction === null ||
    !exactLedgerPayment(tx, row.transaction)
  ) {
    reject("SETTLEMENT_EVIDENCE_MISMATCH");
  }
  const base = {
    validated: true as const,
    hash: row.hash,
    ledger_index: ledgerIndex as number,
    transaction: tx,
  };
  if (meta.TransactionResult === "tesSUCCESS") {
    return {
      kind: "success",
      proof: { ...base, engine_result: "tesSUCCESS" },
    };
  }
  // Only tec results can be included in a validated ledger while consuming a
  // fee. Other result classes here are contradictory evidence and must not
  // release or alter the reservation.
  if (!/^tec[A-Z0-9_]{1,63}$/.test(meta.TransactionResult)) {
    reject("SETTLEMENT_EVIDENCE_MISMATCH");
  }
  return {
    kind: "failure",
    proof: { ...base, engine_result: meta.TransactionResult },
  };
}

function transactionNotFound(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return (
    error.code === "txnNotFound" ||
    error.code === "TXN_NOT_FOUND" ||
    error.kind === "soft-empty"
  );
}

function ledgerIndex(value: unknown): number | null {
  if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value);
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validatedLedger(
  response: Record<string, unknown>,
  expectedIndex?: number,
): { index: number; transactions?: string[] } | null {
  if (response.validated !== true || !isRecord(response.ledger)) return null;
  const index =
    ledgerIndex(response.ledger_index) ??
    ledgerIndex(response.ledger.ledger_index) ??
    ledgerIndex(response.ledger.seqNum);
  if (index === null || (expectedIndex !== undefined && index !== expectedIndex)) {
    return null;
  }
  if (expectedIndex === undefined) return { index };
  if (!Array.isArray(response.ledger.transactions)) return null;
  const transactions: string[] = [];
  for (const value of response.ledger.transactions) {
    if (typeof value !== "string" || !HASH.test(value.toUpperCase())) return null;
    transactions.push(value.toUpperCase());
  }
  return { index, transactions };
}

async function confirmExpiredHashAbsent(
  deps: X402PaymentDependencies,
  row: X402PaymentRow,
): Promise<{
  validatedLedgerIndex: number;
  inclusionLedgersChecked: number[];
} | null> {
  if (row.hash === null || row.lastLedgerSeq === null) return null;
  let latestResponse: Record<string, unknown>;
  try {
    latestResponse = await deps.xrpl.request(
      "testnet",
      "ledger",
      { ledger_index: "validated", transactions: false, expand: false },
      { intent: "read" },
    );
  } catch {
    return null;
  }
  const latest = validatedLedger(latestResponse);
  if (latest === null || latest.index <= row.lastLedgerSeq) return null;

  const challenge = challengeFromRow(row);
  const window = Math.min(
    X402_MAX_LEDGER_WINDOW,
    Math.max(4, Math.ceil(challenge.maxTimeoutSeconds / 4)),
  );
  const firstPossibleLedger = Math.max(1, row.lastLedgerSeq - window);
  const inclusionLedgersChecked: number[] = [];
  for (let index = firstPossibleLedger; index <= row.lastLedgerSeq; index += 1) {
    let response: Record<string, unknown>;
    try {
      response = await deps.xrpl.request(
        "testnet",
        "ledger",
        { ledger_index: index, transactions: true, expand: false },
        { intent: "read" },
      );
    } catch {
      return null;
    }
    const ledger = validatedLedger(response, index);
    if (ledger === null || ledger.transactions?.includes(row.hash)) return null;
    inclusionLedgersChecked.push(index);
  }
  return {
    validatedLedgerIndex: latest.index,
    inclusionLedgersChecked,
  };
}

async function acquireSequenceLease(
  deps: X402PaymentDependencies,
  row: X402PaymentRow,
  payer: string,
  at: string,
  requestedToken: string,
): Promise<PayerSequenceLeaseRow | null> {
  if (deps.sequenceLeases === undefined) return null;
  const result = await deps.sequenceLeases.acquire({
    network: row.network,
    payer,
    rail: "x402",
    attemptId: row.id,
    token: requestedToken,
    at,
  });
  if (result.outcome === "blocked") reject("SIGNING_OUTCOME_UNKNOWN");
  return result.lease;
}

function terminalValidatedEvidence(
  row: X402PaymentRow,
): { hash: string; ledgerIndex: number } | null {
  const evidence = row.status === "settled" || row.status === "delivered"
    ? row.settlement
    : row.failure;
  if (
    evidence?.validated !== true ||
    typeof evidence.hash !== "string" ||
    !HASH.test(evidence.hash.toUpperCase()) ||
    !Number.isSafeInteger(evidence.ledger_index) ||
    Number(evidence.ledger_index) <= 0
  ) {
    return null;
  }
  return { hash: evidence.hash.toUpperCase(), ledgerIndex: Number(evidence.ledger_index) };
}

async function releaseTerminalSequenceLease(
  deps: X402PaymentDependencies,
  row: X402PaymentRow,
  at: string,
): Promise<void> {
  if (deps.sequenceLeases === undefined) return;
  const current = await deps.sequenceLeases.get({
    network: row.network,
    payer: row.delegate,
  });
  if (
    current === null ||
    current.state === "released" ||
    current.rail !== "x402" ||
    current.attemptId !== row.id
  ) {
    return;
  }
  const identity = sequenceLeaseIdentity(current);
  const abandonedBeforeSharedSigning =
    row.status === "failed" &&
    current.state === "preparing" &&
    row.failure?.code === "signing_abandoned" &&
    row.failure.signed_blob_persisted === false &&
    row.failure.hash_persisted === false;
  if (
    row.status === "failed" &&
    row.signedBlob === null &&
    row.hash === null &&
    (row.signingStartedAt === null || abandonedBeforeSharedSigning)
  ) {
    requireLeaseRelease(await deps.sequenceLeases.releasePreSign({
      ...identity,
      at,
      proof: {
        code: "signing_never_began",
        signingStarted: false,
        signedBlobPersisted: false,
        hashPersisted: false,
      },
    }));
    return;
  }
  if (
    row.status === "failed" &&
    row.failure?.code === "expired_absent" &&
    row.failure.validated === true &&
    row.failure.transaction_found === false &&
    typeof row.failure.hash === "string" &&
    Array.isArray(row.failure.inclusion_ledgers_checked) &&
    Number.isSafeInteger(row.failure.validated_ledger_index) &&
    row.lastLedgerSeq !== null
  ) {
    requireLeaseRelease(await deps.sequenceLeases.releaseExpiredAbsent({
      ...identity,
      hash: row.failure.hash,
      lastLedgerSequence: row.lastLedgerSeq,
      at,
      evidence: {
        validated: true,
        transactionFound: false,
        validatedLedgerIndex: Number(row.failure.validated_ledger_index),
        inclusionLedgersChecked: row.failure.inclusion_ledgers_checked as number[],
      },
    }));
    return;
  }
  const validated = terminalValidatedEvidence(row);
  if (validated !== null) {
    requireLeaseRelease(await deps.sequenceLeases.releaseValidatedTerminal({
      ...identity,
      hash: validated.hash,
      at,
      evidence: {
        validated: true,
        transactionFound: true,
        ledgerIndex: validated.ledgerIndex,
      },
    }));
  }
}

async function synchronizeSignedSequenceLease(
  deps: X402PaymentDependencies,
  sequenceLease: PayerSequenceLeaseRow | null,
  row: X402PaymentRow,
  at: string,
): Promise<PayerSequenceLeaseRow | null> {
  if (deps.sequenceLeases === undefined || sequenceLease === null) {
    return sequenceLease;
  }
  if (row.hash === null || (row.status !== "signed" && row.status !== "settlement_unknown")) {
    return sequenceLease;
  }
  const signed = await deps.sequenceLeases.markSigned({
    ...sequenceLeaseIdentity(sequenceLease),
    hash: row.hash,
    at,
  });
  requireLeaseTransition(signed);
  sequenceLease = signed.lease;
  if (row.status === "settlement_unknown") {
    const unknown = await deps.sequenceLeases.markSettlementUnknown({
      ...sequenceLeaseIdentity(sequenceLease),
      hash: row.hash,
      at,
    });
    requireLeaseTransition(unknown);
    sequenceLease = unknown.lease;
  }
  return sequenceLease;
}

async function reconcile(
  deps: X402PaymentDependencies,
  store: X402PaymentStore,
  row: X402PaymentRow,
  now: string,
): Promise<X402PaymentRow | null> {
  if (row.hash === null || row.lastLedgerSeq === null) {
    reject("STORE_TRANSITION_REJECTED");
  }
  let result: Record<string, unknown>;
  try {
    result = await deps.xrpl.request(
      "testnet",
      "tx",
      // Pin v1 so Payment retains its signed Amount field. The normalizer below
      // still accepts a strict v2 tx_json response for compatible providers.
      { transaction: row.hash, binary: false, api_version: 1 },
      { intent: "read" },
    );
  } catch (error) {
    if (transactionNotFound(error)) {
      // A single txnNotFound is not proof. Release only after the validated
      // ledger advanced past LLS and every possible inclusion ledger was read
      // as validated with the exact hash absent.
      const absentAt = await confirmExpiredHashAbsent(deps, row);
      if (absentAt === null) return null;
      const failed = await store.markExpiredAbsentFailed(
        row.idempotencyKey,
        {
          code: "expired_absent",
          validated: true,
          transaction_found: false,
          validated_ledger_index: absentAt.validatedLedgerIndex,
          inclusion_ledgers_checked: absentAt.inclusionLedgersChecked,
          hash: row.hash,
        },
        now,
      );
      if (failed.outcome !== "transitioned" && failed.outcome !== "replay") {
        reject("STORE_TRANSITION_REJECTED");
      }
      await releaseTerminalSequenceLease(deps, failed.row, now);
      return failed.row;
    }
    return null;
  }
  const outcome = validatedLedgerOutcome(result, row);
  if (outcome.kind === "pending") return null;
  const settled =
    outcome.kind === "success"
      ? await store.markSettled(row.idempotencyKey, outcome.proof, now)
      : await store.markValidatedFailure(
          row.idempotencyKey,
          outcome.proof,
          now,
        );
  if (settled.outcome !== "transitioned" && settled.outcome !== "replay") {
    reject(
      settled.outcome === "invalid-evidence"
        ? "SETTLEMENT_EVIDENCE_MISMATCH"
        : "STORE_TRANSITION_REJECTED",
    );
  }
  await releaseTerminalSequenceLease(deps, settled.row, now);
  return settled.row;
}

function challengeFromRow(row: X402PaymentRow): ValidatedX402Challenge {
  const requirements = row.requirements;
  const allowed = new Set([
    "x402Version",
    "resource",
    "scheme",
    "network",
    "asset",
    "payTo",
    "amountDrops",
    "maxTimeoutSeconds",
    "invoiceId",
    "sourceTag",
    "destinationTag",
  ]);
  if (
    !isRecord(requirements) ||
    Object.keys(requirements).some((key) => !allowed.has(key)) ||
    requirements.x402Version !== 2 ||
    requirements.scheme !== "exact" ||
    requirements.network !== "xrpl:1" ||
    requirements.asset !== "XRP" ||
    typeof requirements.payTo !== "string" ||
    !isValidClassicAddress(requirements.payTo) ||
    typeof requirements.amountDrops !== "string" ||
    !/^[1-9][0-9]*$/.test(requirements.amountDrops) ||
    typeof requirements.maxTimeoutSeconds !== "number" ||
    !Number.isInteger(requirements.maxTimeoutSeconds) ||
    requirements.maxTimeoutSeconds < 1 ||
    requirements.maxTimeoutSeconds > X402_MAX_TIMEOUT_SECONDS ||
    typeof requirements.invoiceId !== "string" ||
    requirements.invoiceId.length === 0 ||
    new TextEncoder().encode(requirements.invoiceId).byteLength > X402_INVOICE_ID_MAX_BYTES ||
    typeof requirements.sourceTag !== "number" ||
    !Number.isInteger(requirements.sourceTag) ||
    requirements.sourceTag < 0 ||
    requirements.sourceTag > UINT32_MAX ||
    (requirements.destinationTag !== undefined &&
      (typeof requirements.destinationTag !== "number" ||
        !Number.isInteger(requirements.destinationTag) ||
        requirements.destinationTag < 0 ||
        requirements.destinationTag > UINT32_MAX))
  ) {
    reject("STORE_TRANSITION_REJECTED");
  }
  let resource;
  try {
    resource = validateX402ResourceInfo(requirements.resource, X402_COMPARE_URL);
  } catch {
    reject("STORE_TRANSITION_REJECTED");
  }
  return {
    x402Version: 2,
    resource,
    scheme: "exact",
    network: "xrpl:1",
    asset: "XRP",
    payTo: requirements.payTo,
    amountDrops: requirements.amountDrops,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    invoiceId: requirements.invoiceId,
    sourceTag: requirements.sourceTag,
    ...(requirements.destinationTag === undefined
      ? {}
      : { destinationTag: requirements.destinationTag }),
  };
}

function payerSigningWindow(row: X402PaymentRow): {
  sequence: number;
  firstEligibleLedgerIndex: number;
  lastLedgerSequence: number;
} {
  const sequence = row.transaction?.Sequence;
  const lastLedgerSequence = row.transaction?.LastLedgerSequence;
  if (
    !Number.isSafeInteger(sequence) ||
    Number(sequence) <= 0 ||
    !Number.isSafeInteger(lastLedgerSequence) ||
    Number(lastLedgerSequence) <= 0 ||
    row.lastLedgerSeq !== Number(lastLedgerSequence)
  ) {
    reject("STORE_TRANSITION_REJECTED");
  }
  const challenge = challengeFromRow(row);
  const window = Math.min(
    X402_MAX_LEDGER_WINDOW,
    Math.max(4, Math.ceil(challenge.maxTimeoutSeconds / 4)),
  );
  const firstEligibleLedgerIndex = Number(lastLedgerSequence) - window;
  if (firstEligibleLedgerIndex <= 0) reject("STORE_TRANSITION_REJECTED");
  return {
    sequence: Number(sequence),
    firstEligibleLedgerIndex,
    lastLedgerSequence: Number(lastLedgerSequence),
  };
}

async function assertPreparedSigningRow(
  row: X402PaymentRow,
  input: ExecuteX402PaymentInput,
  requestFingerprint: string,
  resolved: ResolvedX402Payer,
): Promise<void> {
  try {
    const { identity } = resolved;
    const requirements = challengeFromRow(row);
    const transaction = row.transaction;
    const amount = row.amountDrops;
    const canonicalAmount =
      typeof amount === "string" &&
      amount.length <= 16 &&
      DROPS.test(amount) &&
      amount !== "0"
        ? amount
        : null;
    const feeCap = row.feeCapDrops;
    const fee = transaction?.Fee;
    const sequence = transaction?.Sequence;
    const lastLedgerSequence = transaction?.LastLedgerSequence;
    const expectedReservedTotal =
      canonicalAmount === null
        ? null
        : (BigInt(canonicalAmount) + BigInt(X402_MAX_FEE_DROPS)).toString();
    const expectedInvoiceHash = await sha256(requirements.invoiceId);
    if (
      row.status !== "prepared" ||
      row.signingStartedAt === null ||
      row.hash !== null ||
      row.signedBlob !== null ||
      row.principal !== input.principal ||
      row.idempotencyKey !== input.idempotencyKey ||
      row.requestFingerprint !== requestFingerprint ||
      row.owner !== input.owner ||
      row.owner !== identity.owner ||
      row.network !== "testnet" ||
      row.network !== identity.network ||
      row.principal !== identity.principal ||
      row.delegate !== identity.payer ||
      row.url !== X402_COMPARE_URL ||
      canonicalAmount === null ||
      requirements.amountDrops !== canonicalAmount ||
      (input.payTo !== undefined &&
        (input.exactPriceDrops !== LOCAL_X402_COMPARE_PRICE_DROPS ||
          input.maxPriceDrops !== LOCAL_X402_COMPARE_PRICE_DROPS ||
          canonicalAmount !== input.exactPriceDrops ||
          input.payTo !== LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO ||
          resolved.merchantPayTo !== input.payTo)) ||
      row.callerMaxDrops !== input.maxPriceDrops ||
      row.policyPerCallCapDrops !== resolved.policyPerCallCapDrops ||
      row.dailyCapDrops !== resolved.dailyCapDrops ||
      !DROPS.test(resolved.policyPerCallCapDrops) ||
      !DROPS.test(resolved.dailyCapDrops) ||
      BigInt(canonicalAmount) > BigInt(input.maxPriceDrops) ||
      BigInt(canonicalAmount) > BigInt(resolved.policyPerCallCapDrops) ||
      expectedReservedTotal === null ||
      BigInt(resolved.dailyCapDrops) < BigInt(expectedReservedTotal) ||
      requirements.payTo !== resolved.merchantPayTo ||
      row.payTo !== resolved.merchantPayTo ||
      requirements.sourceTag !== identity.sourceTag ||
      row.invoiceId !== requirements.invoiceId ||
      transaction === null ||
      Object.keys(transaction).some((key) => !PREPARED_PAYMENT_KEYS.has(key)) ||
      transaction.TransactionType !== "Payment" ||
      transaction.Account !== identity.payer ||
      transaction.Destination !== resolved.merchantPayTo ||
      transaction.Amount !== canonicalAmount ||
      transaction.InvoiceID !== expectedInvoiceHash ||
      transaction.SourceTag !== identity.sourceTag ||
      own(transaction, "DestinationTag") !==
        (requirements.destinationTag !== undefined) ||
      transaction.DestinationTag !== requirements.destinationTag ||
      feeCap !== X402_MAX_FEE_DROPS ||
      typeof fee !== "string" ||
      !DROPS.test(fee) ||
      fee === "0" ||
      fee.length > X402_MAX_FEE_DROPS.length ||
      BigInt(fee) > BigInt(feeCap) ||
      BigInt(fee) > BigInt(X402_MAX_FEE_DROPS) ||
      row.reservedTotalDrops !== expectedReservedTotal ||
      typeof sequence !== "number" ||
      !Number.isInteger(sequence) ||
      sequence < 1 ||
      sequence > UINT32_MAX ||
      typeof lastLedgerSequence !== "number" ||
      !Number.isInteger(lastLedgerSequence) ||
      lastLedgerSequence < 1 ||
      lastLedgerSequence > UINT32_MAX ||
      row.lastLedgerSeq !== lastLedgerSequence
    ) {
      throw new Error("Invalid prepared x402 signing row");
    }
  } catch {
    reject("STORE_TRANSITION_REJECTED");
  }
}

function assertPreparedIsolatedBinding(
  row: X402PaymentRow,
  input: ExecuteX402PaymentInput,
  fingerprint: string,
  resolved: ResolvedX402Payer,
): void {
  if (input.payTo === undefined) return;
  try {
    const requirements = challengeFromRow(row);
    const transaction = row.transaction;
    if (
      input.exactPriceDrops !== LOCAL_X402_COMPARE_PRICE_DROPS ||
      input.maxPriceDrops !== LOCAL_X402_COMPARE_PRICE_DROPS ||
      input.payTo !== LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO ||
      resolved.merchantPayTo !== input.payTo ||
      row.status !== "prepared" ||
      row.requestFingerprint !== fingerprint ||
      row.callerMaxDrops !== input.exactPriceDrops ||
      row.amountDrops !== input.exactPriceDrops ||
      row.payTo !== input.payTo ||
      requirements.amountDrops !== input.exactPriceDrops ||
      requirements.payTo !== input.payTo ||
      transaction === null ||
      transaction.Amount !== input.exactPriceDrops ||
      transaction.Destination !== input.payTo
    ) {
      throw new Error("Invalid isolated x402 pay-to binding");
    }
  } catch {
    reject("STORE_TRANSITION_REJECTED");
  }
}

function deliveredReplay(row: X402PaymentRow): X402PaymentResult {
  if (
    row.hash === null ||
    !isRecord(row.delivery) ||
    typeof row.delivery.http_status !== "number" ||
    !own(row.delivery, "body")
  ) {
    reject("STORE_TRANSITION_REJECTED");
  }
  return {
    status: "delivered",
    hash: row.hash,
    httpStatus: row.delivery.http_status,
    body: row.delivery.body,
    replayed: true,
    row,
  };
}

function jsonContentType(value: string | null): boolean {
  return value?.trim().toLowerCase() === "application/json";
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^[0-9]+$/.test(declared) ||
      BigInt(declared) > BigInt(X402_MERCHANT_BODY_MAX_BYTES))
  ) {
    await response.body?.cancel().catch(() => undefined);
    reject("PAID_RESPONSE_REJECTED");
  }
  if (response.body === null) reject("PAID_RESPONSE_REJECTED");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > X402_MERCHANT_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        reject("PAID_RESPONSE_REJECTED");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

async function paidGet(
  deps: X402PaymentDependencies,
  store: X402PaymentStore,
  row: X402PaymentRow,
  now: string,
): Promise<X402PaymentResult> {
  if (
    row.status !== "settled" ||
    row.hash === null ||
    row.signedBlob === null ||
    row.transaction === null
  ) {
    reject("STORE_TRANSITION_REJECTED");
  }
  const delivery = await requestMerchant(deps, row);
  const marked = await store.markDelivered(row.idempotencyKey, delivery, now);
  if (marked.outcome !== "transitioned" && marked.outcome !== "replay") {
    reject("STORE_TRANSITION_REJECTED");
  }
  return {
    status: "delivered",
    hash: row.hash,
    httpStatus: delivery.http_status,
    body: delivery.body,
    replayed: marked.outcome === "replay",
    row: marked.row,
  };
}

async function requestMerchant(
  deps: X402PaymentDependencies,
  row: X402PaymentRow,
): Promise<JsonObject & {
  http_status: 200;
  content_type: "application/json";
  body: unknown;
}> {
  if (row.hash === null || row.signedBlob === null || row.transaction === null) {
    reject("STORE_TRANSITION_REJECTED");
  }
  const paymentSignature = deps.encodePaymentSignature({
    challenge: challengeFromRow(row),
    transaction: row.transaction,
    signedBlob: row.signedBlob,
    hash: row.hash,
  });
  if (
    typeof paymentSignature !== "string" ||
    paymentSignature.length === 0 ||
    paymentSignature.length > 24 * 1024 ||
    /[\r\n]/.test(paymentSignature)
  ) {
    reject("PAYMENT_SIGNATURE_INVALID");
  }
  try {
    return await fixedGet(
      deps,
      new Headers({
        ...INITIAL_HEADERS,
        "payment-signature": paymentSignature,
      }),
      async (response) => {
        if (response.status !== 200 || !jsonContentType(response.headers.get("content-type"))) {
          await response.body?.cancel().catch(() => undefined);
          reject("PAID_RESPONSE_REJECTED");
        }
        let body: unknown;
        try {
          body = parseX402MerchantJsonBody(await readBoundedBody(response));
        } catch (error) {
          if (error instanceof X402PaymentError) throw error;
          reject("PAID_RESPONSE_REJECTED");
        }
        return {
          http_status: 200 as const,
          content_type: "application/json" as const,
          body,
        };
      },
    );
  } catch (error) {
    if (error instanceof X402PaymentError) throw error;
    reject("PAID_RESPONSE_REJECTED");
  }
}

function assertTransition(result: TransitionResult): X402PaymentRow {
  if (result.outcome !== "transitioned" && result.outcome !== "replay") {
    reject("STORE_TRANSITION_REJECTED");
  }
  return result.row;
}

async function persistSettlementUnknown(
  store: X402PaymentStore,
  idempotencyKey: string,
  at: string,
  pendingDelivery?: JsonObject & {
    http_status: 200;
    content_type: "application/json";
  },
): Promise<TransitionResult> {
  if (pendingDelivery === undefined) {
    return store.markSettlementUnknown(idempotencyKey, at);
  }
  const cached = await store.markSettlementUnknown(
    idempotencyKey,
    at,
    pendingDelivery,
  );
  if (cached.outcome !== "invalid-evidence") return cached;
  // The merchant may have received the signature already. Delivery caching is
  // secondary to durably entering hash-based settlement reconciliation.
  return store.markSettlementUnknown(idempotencyKey, at);
}

function claimRecoveryCutoff(at: Date): string {
  return new Date(at.getTime() - X402_CLAIM_RECOVERY_MS).toISOString();
}

export function createX402PaymentEngine(deps: X402PaymentDependencies): {
  execute(input: ExecuteX402PaymentInput): Promise<X402PaymentResult>;
} {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const newLeaseToken = deps.newLeaseToken ?? randomLeaseToken;

  return Object.freeze({
    async execute(
      input: ExecuteX402PaymentInput,
    ): Promise<X402PaymentResult> {
      if (deps.enabled !== true) reject("X402_DISABLED");
      validateInput(input);
      const fingerprint = await requestFingerprint(input);
      const resolved = await deps.resolvePayer({
        principal: input.principal,
        owner: input.owner,
        network: "testnet",
      });
      assertBinding(input, resolved);
      const { identity, store } = resolved;
      const lockKey = [identity.network, identity.payer].join(":");

      return deps.lock.withLock(lockKey, async () => {
        const claimedAt = now().toISOString();
        const claim = await store.claim({
          id: newId(),
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          owner: input.owner,
          network: "testnet",
          delegate: identity.payer,
          url: X402_COMPARE_URL,
          createdAt: claimedAt,
        });
        if (claim.outcome === "mismatch") reject("IDEMPOTENCY_MISMATCH");
        let row = claim.row;
        if (row.status === "delivered") {
          await releaseTerminalSequenceLease(deps, row, claimedAt);
          return deliveredReplay(row);
        }
        if (row.status === "failed") {
          await releaseTerminalSequenceLease(deps, row, claimedAt);
          reject("TERMINAL_PAYMENT");
        }
        if (row.leaseAcquiredAt === null) reject("SIGNING_OUTCOME_UNKNOWN");

        let sequenceLease: PayerSequenceLeaseRow | null = null;

        let ownsClaim = claim.outcome === "claimed";
        let ownedClaimLease = ownsClaim ? row.leaseAcquiredAt : null;
        if (row.status === "claimed" && !ownsClaim) {
          const recoveryAt = now();
          const recovered = await store.acquireClaimRecovery(
            input.idempotencyKey,
            row.leaseAcquiredAt,
            claimRecoveryCutoff(recoveryAt),
            recoveryAt.toISOString(),
          );
          row = recovered.row;
          if (recovered.outcome === "transitioned") {
            ownsClaim = true;
            ownedClaimLease = row.leaseAcquiredAt;
          } else if (row.status === "claimed") {
            // A fresh claimant (or another recovery winner) still owns all
            // pre-reservation work. A replaying isolate must not cancel it.
            reject("SIGNING_OUTCOME_UNKNOWN");
          }
        }

        if (row.status === "claimed") {
          if (!ownsClaim || ownedClaimLease === null) {
            reject("SIGNING_OUTCOME_UNKNOWN");
          }
          try {
            const challenge = await initialChallenge(
              deps,
              input.maxPriceDrops,
              resolved.policyPerCallCapDrops,
              // The payer's source tag is part of the fixed principal binding.
              // The resolver supplies it through a safe public field on identity.
              identity.sourceTag,
            );
            assertIsolatedChallengeBinding(input, resolved, challenge);
            if (challenge.payTo !== resolved.merchantPayTo) {
              reject("PAYER_BINDING_MISMATCH");
            }
            sequenceLease = await acquireSequenceLease(
              deps,
              row,
              identity.payer,
              now().toISOString(),
              newLeaseToken(),
            );
            const preparation = await prepareFromValidatedLedger(
              deps,
              identity.payer,
            );
            const invoiceId = await sha256(challenge.invoiceId);
            const transaction = transactionFor(
              identity,
              challenge,
              preparation,
              invoiceId,
            );
            const total = BigInt(challenge.amountDrops) + BigInt(preparation.feeDrops);
            if (
              preparation.balanceDrops <
              preparation.reserveDrops +
                BigInt(X402_BALANCE_CUSHION_DROPS) +
                total
            ) {
              reject("INSUFFICIENT_SPENDABLE_BALANCE");
            }
            const reservedAt = now().toISOString();
            const reserve = await store.reserve({
              idempotencyKey: input.idempotencyKey,
              requestFingerprint: fingerprint,
              leaseAcquiredAt: ownedClaimLease,
              invoiceId: challenge.invoiceId,
              amountDrops: challenge.amountDrops,
              feeCapDrops: X402_MAX_FEE_DROPS,
              callerMaxDrops: input.maxPriceDrops,
              policyPerCallCapDrops: resolved.policyPerCallCapDrops,
              dailyCapDrops: resolved.dailyCapDrops,
              payTo: challenge.payTo,
              requirements: challenge,
              transaction: transaction as unknown as JsonObject,
              lastLedgerSeq: transaction.LastLedgerSequence!,
              expiresAt: new Date(
                now().getTime() + challenge.maxTimeoutSeconds * 1_000,
              ).toISOString(),
              reservedAt,
            });
            if (reserve.outcome !== "reserved" && reserve.outcome !== "replay") {
              reject(
                reserve.outcome === "mismatch"
                  ? "IDEMPOTENCY_MISMATCH"
                  : "RESERVATION_REJECTED",
                reserve.outcome,
              );
            }
            row = reserve.row;
          } catch (error) {
            if (ownsClaim) {
              const failed = await store.markClaimFailed(
                input.idempotencyKey,
                { code: "pre_sign_failure" },
                now().toISOString(),
                ownedClaimLease,
              );
              if (failed.outcome === "transitioned" || failed.outcome === "replay") {
                if (sequenceLease !== null && deps.sequenceLeases !== undefined) {
                  requireLeaseRelease(await deps.sequenceLeases.releasePreSign({
                    ...sequenceLeaseIdentity(sequenceLease),
                    at: now().toISOString(),
                    proof: {
                      code: "signing_never_began",
                      signingStarted: false,
                      signedBlobPersisted: false,
                      hashPersisted: false,
                    },
                  }));
                }
                throw error;
              }
            }
            const durable = await store.getByIdempotencyKey(input.idempotencyKey);
            if (
              durable === null ||
              durable.requestFingerprint !== fingerprint ||
              durable.status === "claimed"
            ) {
              throw error;
            }
            row = durable;
          }
        }

        if (
          (row.status === "prepared" ||
            row.status === "signed" ||
            row.status === "settlement_unknown") &&
          sequenceLease === null
        ) {
          sequenceLease = await acquireSequenceLease(
            deps,
            row,
            identity.payer,
            now().toISOString(),
            newLeaseToken(),
          );
        }

        if (row.status === "prepared") {
          assertPreparedIsolatedBinding(row, input, fingerprint, resolved);
          if (row.payTo !== resolved.merchantPayTo) {
            const failed = await store.markFailed(
              input.idempotencyKey,
              { code: "pay_to_binding_mismatch" },
              now().toISOString(),
            );
            await releaseTerminalSequenceLease(
              deps,
              failed.row,
              now().toISOString(),
            );
            reject("PAYER_BINDING_MISMATCH");
          }
          if (row.signingStartedAt !== null) {
            if (
              sequenceLease !== null &&
              sequenceLease.state === "preparing" &&
              row.signedBlob === null &&
              row.hash === null
            ) {
              // The payment marker is written before the shared signing fence.
              // A still-preparing shared lease therefore proves signer access
              // never began, so this exact crash window is safe to terminate
              // and release as pre-sign.
              const abandoned = await store.markSigningAbandoned(
                input.idempotencyKey,
                {
                  code: "signing_abandoned",
                  signed_blob_persisted: false,
                  hash_persisted: false,
                },
                now().toISOString(),
              );
              if (
                (abandoned.outcome === "transitioned" ||
                  abandoned.outcome === "replay") &&
                abandoned.row.status === "failed"
              ) {
                await releaseTerminalSequenceLease(
                  deps,
                  abandoned.row,
                  now().toISOString(),
                );
                reject("TERMINAL_PAYMENT");
              }
              reject("SIGNING_OUTCOME_UNKNOWN");
            }
            const abandoned = await store.markSigningAbandoned(
              input.idempotencyKey,
              {
                code: "signing_abandoned",
                signed_blob_persisted: false,
                hash_persisted: false,
              },
              now().toISOString(),
            );
            if (
              (abandoned.outcome === "transitioned" ||
                abandoned.outcome === "replay") &&
              abandoned.row.status === "failed"
            ) {
              reject("TERMINAL_PAYMENT");
            }
            // A cross-process actor may have persisted the signature before
            // this CAS. Continue only from that returned durable state.
            if (
              abandoned.row.status === "signed" ||
              abandoned.row.status === "settlement_unknown" ||
              abandoned.row.status === "settled" ||
              abandoned.row.status === "delivered"
            ) {
              row = abandoned.row;
            } else {
              reject("SIGNING_OUTCOME_UNKNOWN");
            }
          }
          if (row.status === "prepared") {
            const signingStarted = await store.markSigningStarted(
              input.idempotencyKey,
              now().toISOString(),
            );
            if (signingStarted.outcome !== "transitioned") {
              reject("SIGNING_OUTCOME_UNKNOWN");
            }
            row = signingStarted.row;
            await assertPreparedSigningRow(
              row,
              input,
              fingerprint,
              resolved,
            );
            if (sequenceLease !== null && deps.sequenceLeases !== undefined) {
              const window = payerSigningWindow(row);
              const started = await deps.sequenceLeases.markSigningStarted({
                ...sequenceLeaseIdentity(sequenceLease),
                ...window,
                at: now().toISOString(),
              });
              requireLeaseTransition(started);
              sequenceLease = started.lease;
            }
            const signed = validSigned(
              await deps.withDelegateSigner(identity, (signer) => {
                if (signer.address !== identity.payer) reject("SIGNER_MISMATCH");
                return signer.sign(row.transaction as Transaction);
              }),
            );
            const marked = await store.markSigned(input.idempotencyKey, {
              hash: signed.hash,
              signedBlob: signed.tx_blob,
              signedAt: now().toISOString(),
            });
            if (marked.outcome !== "transitioned") {
              // A replay here means signing happened without this invocation owning
              // the durable transition. Let the durable signed state drive recovery.
              reject("STORE_TRANSITION_REJECTED");
            }
            row = marked.row;
            sequenceLease = await synchronizeSignedSequenceLease(
              deps,
              sequenceLease,
              row,
              now().toISOString(),
            );
          }
        }

        sequenceLease = await synchronizeSignedSequenceLease(
          deps,
          sequenceLease,
          row,
          now().toISOString(),
        );

        if (row.status === "signed") {
          if (row.signedBlob === null || row.hash === null) {
            reject("STORE_TRANSITION_REJECTED");
          }
          let pendingDelivery:
            | (JsonObject & {
                http_status: 200;
                content_type: "application/json";
              })
            | undefined;
          try {
            pendingDelivery = await requestMerchant(deps, row);
          } catch {
            // A failed resource request may still have reached the merchant and
            // triggered facilitator submission. Persist uncertainty and only
            // reconcile the already-signed hash.
          }
          row = assertTransition(
            await persistSettlementUnknown(
              store,
              input.idempotencyKey,
              now().toISOString(),
              pendingDelivery,
            ),
          );
          sequenceLease = await synchronizeSignedSequenceLease(
            deps,
            sequenceLease,
            row,
            now().toISOString(),
          );
        }

        if (row.status === "settlement_unknown") {
          const reconciled = await reconcile(
            deps,
            store,
            row,
            now().toISOString(),
          );
          if (reconciled === null) {
            return { status: "settlement_unknown", hash: row.hash!, row };
          }
          row = reconciled;
        }
        if (row.status === "settled") {
          await releaseTerminalSequenceLease(deps, row, now().toISOString());
          if (
            isRecord(row.delivery) &&
            row.delivery.http_status === 200 &&
            row.delivery.content_type === "application/json" &&
            own(row.delivery, "body")
          ) {
            const marked = await store.markDelivered(
              row.idempotencyKey,
              row.delivery as JsonObject & { http_status: number },
              now().toISOString(),
            );
            if (marked.outcome !== "transitioned" && marked.outcome !== "replay") {
              reject("STORE_TRANSITION_REJECTED");
            }
            return {
              status: "delivered",
              hash: row.hash!,
              httpStatus: 200,
              body: row.delivery.body,
              replayed: false,
              row: marked.row,
            };
          }
          return paidGet(deps, store, row, now().toISOString());
        }
        if (row.status === "delivered") return deliveredReplay(row);
        if (row.status === "failed") {
          await releaseTerminalSequenceLease(deps, row, now().toISOString());
          reject("TERMINAL_PAYMENT");
        }
        reject("STORE_TRANSITION_REJECTED");
      });
    },
  });
}
