import {
  decode,
  deriveAddress,
  hashes,
  isValidClassicAddress,
  verifySignature,
  type Payment,
} from "xrpl";

import {
  X402_MERCHANT_BODY_MAX_BYTES,
  parseX402MerchantJsonBody,
} from "../x402-contract";
import type {
  X402IssuedReconciliationExpectation,
  X402IssuedReconciliationResult,
} from "./x402-issued-reconciliation";

const CURRENCY = /^[0-9A-F]{40}$/;
const DECIMAL = /^(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?)$/;
const DROPS = /^(?:0|[1-9][0-9]*)$/;
const HASH = /^[A-F0-9]{64}$/;
const HEX = /^[A-F0-9]+$/;
const MAX_DECIMAL_PLACES = 81;
const MAX_SIGNIFICANT_DIGITS = 15;
const UINT32_MAX = 0xffff_ffff;
const PAYMENT_HEADER_LIMIT = 24 * 1024;
const LSF_REQUIRE_AUTH = 0x0004_0000;
const LSF_GLOBAL_FREEZE = 0x0040_0000;
const LSF_DEFAULT_RIPPLE = 0x0080_0000;
const LSF_REQUIRE_DEST_TAG = 0x0002_0000;
const LSF_DISABLE_MASTER = 0x0010_0000;
const LSF_DEPOSIT_AUTH = 0x0100_0000;
const CANONICAL_TRANSFER_RATE = 1_000_000_000;

export type X402IssuedAsset = Readonly<{
  kind: "xrpl-issued";
  network: "xrpl:1";
  currency: string;
  issuer: string;
}>;

export type X402IssuedPolicy = Readonly<{
  asset: X402IssuedAsset;
  payTo: string;
  sourceTag: number;
  maxPerCall: string;
  dailyCap: string;
  lifetimeCap: string;
  maxFeeDrops: string;
  dailyFeeCapDrops: string;
  lifetimeFeeCapDrops: string;
  minimumXrpReserveDrops: string;
}>;

export type X402IssuedChallenge = Readonly<{
  x402Version: 2;
  resource: Readonly<Record<string, unknown>> & { url: string };
  scheme: "exact";
  network: "xrpl:1";
  asset: X402IssuedAsset;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
  invoiceId: string;
  sourceTag: number;
  destinationTag?: number;
}>;

export type X402IssuedLedgerPreparation = Readonly<{
  owner: string;
  approvalId: string;
  approvalDigest: string;
  quoteExpiresAt: string;
  feeDrops: string;
  validatedLedgerIndex: number;
  reserveBaseDrops: string;
  reserveIncrementDrops: string;
  issuer: Readonly<{
    account: string;
    flags: number;
    transferRate: number;
  }>;
  payer: Readonly<{
    account: string;
    balanceDrops: string;
    ownerCount: number;
    sequence: number;
    flags: number;
  }>;
  payee: Readonly<{
    account: string;
    flags: number;
  }>;
  payerLine: X402IssuedTrustLineProof;
  payeeLine: X402IssuedTrustLineProof;
}>;

export type X402IssuedTrustLineProof = Readonly<{
  holder: string;
  issuer: string;
  currency: string;
  balance: string;
  limit: string;
  frozen: boolean;
  deepFrozen: boolean;
  authorized: boolean;
  issuerNoRipple: boolean;
  qualitiesDefault: boolean;
}>;

export type X402IssuedSigningRequest = Readonly<{
  version: 1;
  approval_id: string;
  approval_digest: string;
  owner: string;
  execution_network: "testnet";
  asset: Readonly<{
    kind: "issued";
    network: "xrpl:1";
    namespace: "token";
    currency: string;
    issuer: string;
  }>;
  amount: string;
  pay_to: string;
  quote_expires_at: string;
  validated_ledger_index: number;
  sequence: number;
  last_ledger_sequence: number;
  fee_drops: string;
  source_tag: number;
  invoice_id: string;
  tx_json: Readonly<Payment>;
}>;

export type X402IssuedApprovalEnvelopeV1 = Readonly<{
  version: 1;
  domain: "pilot.x402.owner-approval";
  approval_id: string;
  network: "xrpl:1";
  execution_network: "testnet";
  session_scope: string;
  idempotency_key: string;
  merchant: Readonly<{
    id: string;
    resource_method: "POST";
    resource_url: string;
    pay_to: string;
  }>;
  asset: X402IssuedSigningRequest["asset"];
  amount: string;
  owner: string;
  quote_expires_at: string;
  merchant_invoice_id: string;
  transaction: Readonly<{
    fee_drops: string;
    sequence: number;
    last_ledger_sequence: number;
    source_tag: number;
    validated_ledger_index: number;
  }>;
}>;

export type X402IssuedSigner = Readonly<{
  sign(request: X402IssuedSigningRequest, signal: AbortSignal): Promise<{
    signedBlob: string;
    hash: string;
  }>;
}>;

export type X402IssuedMerchantTransport = Readonly<{
  challenge(signal: AbortSignal): Promise<Response>;
  pay(paymentSignature: string, signal: AbortSignal): Promise<Response>;
}>;

export type X402IssuedBudgetReservation = Readonly<{
  replay: boolean;
  state: "reserved" | "uncertain" | "committed";
}>;

export interface X402IssuedBudgetAuthority {
  reserve(input: Readonly<{
    idempotencyKey: string;
    payer: string;
    asset: X402IssuedAsset;
    amount: string;
    feeDrops: string;
    xrpBalanceDrops: string;
    minimumReserveDrops: string;
  }>): Promise<X402IssuedBudgetReservation>;
  releasePreSign(idempotencyKey: string): Promise<void>;
  markUncertain(idempotencyKey: string): Promise<void>;
  commit(idempotencyKey: string): Promise<void>;
}

type X402IssuedStateRecord = Readonly<{
  scope: string;
  binding: string;
  payer: string;
  invoiceId: string;
  sequence: number;
  approvalId: string;
  approvalDigest: string;
  status: "reserved" | "signing" | "signed" | "uncertain" | "delivered";
  hash?: string;
  signedBlob?: string;
  result?: X402IssuedFixtureResult;
}>;

export interface X402IssuedStateAuthority {
  withPayerLock<T>(payer: string, callback: () => Promise<T>): Promise<T>;
  get(idempotencyKey: string): Promise<X402IssuedStateRecord | null>;
  reserve(input: Readonly<{
    idempotencyKey: string;
    scope: string;
    binding: string;
    payer: string;
    invoiceId: string;
    sequence: number;
    approvalId: string;
    approvalDigest: string;
  }>): Promise<{ replay: boolean; record: X402IssuedStateRecord }>;
  releasePreSign(idempotencyKey: string): Promise<void>;
  markSigningStarted(idempotencyKey: string): Promise<void>;
  markSigned(
    idempotencyKey: string,
    hash: string,
    signedBlob: string,
  ): Promise<void>;
  markUncertain(idempotencyKey: string): Promise<void>;
  markDelivered(
    idempotencyKey: string,
    result: X402IssuedFixtureResult,
  ): Promise<void>;
}

export type X402IssuedFixtureResult = Readonly<{
  status: "fixture_delivered";
  evidence: "deterministic-offline-fixture";
  idempotencyKey: string;
  asset: X402IssuedAsset;
  amount: string;
  payer: string;
  payTo: string;
  invoiceId: string;
  approvalDigest: string;
  sessionScope: string;
  merchantId: string;
  feeDrops: string;
  validatedLedgerIndex: number;
  transactionHash: string;
  merchantBody: Readonly<Record<string, unknown>>;
}>;

export class X402IssuedOfflineError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "X402IssuedOfflineError";
  }
}

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  code: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, rejectPromise) => {
        timer = setTimeout(() => {
          controller.abort();
          rejectPromise(new X402IssuedOfflineError(code));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function reject(code: string): never {
  throw new X402IssuedOfflineError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

export function canonicalIssuedApprovalEnvelope(
  value: X402IssuedApprovalEnvelopeV1,
): string {
  const canonical = (item: unknown): string => {
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isSafeInteger(item)) return String(item);
    if (!record(item)) reject("INVALID_APPROVAL_ENVELOPE");
    return `{${Object.keys(item).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
  };
  return canonical(value);
}

export async function digestIssuedApprovalEnvelope(
  value: X402IssuedApprovalEnvelopeV1,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalIssuedApprovalEnvelope(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("").toUpperCase();
}

function uint32(value: unknown, code: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > UINT32_MAX
  ) reject(code);
  return value;
}

function positiveUInt32(value: unknown, code: string): number {
  const parsed = uint32(value, code);
  if (parsed === 0) reject(code);
  return parsed;
}

function canonicalDrops(value: unknown, code: string, positive = false): string {
  if (typeof value !== "string" || value.length > 18 || !DROPS.test(value)) {
    reject(code);
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n || (positive && parsed === 0n)) {
    reject(code);
  }
  return value;
}

function decimalParts(value: unknown, code = "INVALID_ISSUED_AMOUNT"): {
  canonical: string;
  atoms: bigint;
} {
  if (typeof value !== "string" || value.length > 128 || !DECIMAL.test(value)) {
    reject(code);
  }
  const [whole, fraction = ""] = value.split(".");
  const significant = `${whole}${fraction}`.replace(/^0+/, "").length;
  if (
    significant === 0 ||
    significant > MAX_SIGNIFICANT_DIGITS ||
    fraction.length > MAX_DECIMAL_PLACES ||
    whole.length > MAX_DECIMAL_PLACES
  ) reject(code);
  const digits = BigInt(`${whole}${fraction}`);
  return {
    canonical: value,
    atoms: digits * 10n ** BigInt(MAX_DECIMAL_PLACES - fraction.length),
  };
}

function ledgerAtoms(value: unknown, code: string): bigint {
  if (value === "0") return 0n;
  if (typeof value !== "string") reject(code);
  const negative = value.startsWith("-");
  const parsed = decimalParts(negative ? value.slice(1) : value, code).atoms;
  return negative ? -parsed : parsed;
}

function assetKey(asset: X402IssuedAsset): string {
  return `${asset.network}:${asset.currency}:${asset.issuer}`;
}

function paymentScope(
  requestUrl: string,
  merchantId: string,
  sessionScope: string,
  policy: X402IssuedPolicy,
): string {
  return JSON.stringify([
    requestUrl,
    merchantId,
    sessionScope,
    assetKey(policy.asset),
    policy.payTo,
    policy.sourceTag,
  ]);
}

function validateAsset(value: X402IssuedAsset): X402IssuedAsset {
  if (
    value.kind !== "xrpl-issued" ||
    value.network !== "xrpl:1" ||
    !CURRENCY.test(value.currency) ||
    !isValidClassicAddress(value.issuer)
  ) reject("INVALID_ISSUED_ASSET");
  return value;
}

function validatePolicy(policy: X402IssuedPolicy): void {
  validateAsset(policy.asset);
  if (
    !isValidClassicAddress(policy.payTo) ||
    policy.payTo === policy.asset.issuer
  ) reject("INVALID_ISSUED_POLICY");
  uint32(policy.sourceTag, "INVALID_ISSUED_POLICY");
  const perCall = decimalParts(policy.maxPerCall, "INVALID_ISSUED_POLICY").atoms;
  const daily = decimalParts(policy.dailyCap, "INVALID_ISSUED_POLICY").atoms;
  const lifetime = decimalParts(policy.lifetimeCap, "INVALID_ISSUED_POLICY").atoms;
  if (perCall > daily || daily > lifetime) reject("INVALID_ISSUED_POLICY");
  const feePerCall = BigInt(
    canonicalDrops(policy.maxFeeDrops, "INVALID_ISSUED_POLICY", true),
  );
  const feeDaily = BigInt(
    canonicalDrops(policy.dailyFeeCapDrops, "INVALID_ISSUED_POLICY", true),
  );
  const feeLifetime = BigInt(
    canonicalDrops(policy.lifetimeFeeCapDrops, "INVALID_ISSUED_POLICY", true),
  );
  if (feePerCall > feeDaily || feeDaily > feeLifetime) {
    reject("INVALID_ISSUED_POLICY");
  }
  canonicalDrops(policy.minimumXrpReserveDrops, "INVALID_ISSUED_POLICY");
}

function decodeHeader(header: string): unknown {
  if (
    header.length === 0 ||
    header.length > PAYMENT_HEADER_LIMIT ||
    header.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)
  ) reject("INVALID_PAYMENT_REQUIRED");
  try {
    const binary = atob(header);
    if (
      binary.length > 16 * 1024 ||
      btoa(binary) !== header
    ) reject("INVALID_PAYMENT_REQUIRED");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    reject("INVALID_PAYMENT_REQUIRED");
  }
}

function encodeHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  }
  return btoa(binary);
}

export function validateIssuedX402Challenge(
  header: string,
  policy: X402IssuedPolicy,
  requestUrl: string,
): X402IssuedChallenge {
  validatePolicy(policy);
  const decoded = decodeHeader(header);
  if (
    !record(decoded) ||
    decoded.x402Version !== 2 ||
    Object.keys(decoded).some(
      (key) => !["x402Version", "error", "resource", "accepts", "extensions"].includes(key),
    ) ||
    (decoded.extensions !== undefined &&
      (!record(decoded.extensions) || Object.keys(decoded.extensions).length !== 0)) ||
    !record(decoded.resource) ||
    decoded.resource.url !== requestUrl ||
    !Array.isArray(decoded.accepts) ||
    decoded.accepts.some((offer) => !record(offer))
  ) reject("INVALID_PAYMENT_REQUIRED");
  const compatible = decoded.accepts.filter((offer): offer is Record<string, unknown> =>
    record(offer) &&
    offer.scheme === "exact" &&
    offer.network === "xrpl:1" &&
    offer.asset === policy.asset.currency &&
    record(offer.extra) &&
    offer.extra.issuer === policy.asset.issuer &&
    offer.extra.areFeesSponsored === false &&
    offer.extra.assetTransferMethod === "sequence",
  );
  if (compatible.length !== 1) reject("ISSUED_REQUIREMENT_AMBIGUOUS_OR_MISSING");
  const selected = compatible[0];
  if (
    !exactKeys(selected, [
      "scheme", "network", "asset", "payTo", "amount",
      "maxTimeoutSeconds", "extra",
    ]) ||
    selected.scheme !== "exact" ||
    selected.network !== "xrpl:1" ||
    selected.asset !== policy.asset.currency ||
    selected.payTo !== policy.payTo ||
    !record(selected.extra)
  ) reject("ISSUED_REQUIREMENT_MISMATCH");
  const extraKeys = [
    "areFeesSponsored", "assetTransferMethod", "issuer", "sourceTag", "invoiceId",
    ...(Object.prototype.hasOwnProperty.call(selected.extra, "destinationTag")
      ? ["destinationTag"]
      : []),
  ];
  if (
    !exactKeys(selected.extra, extraKeys) ||
    selected.extra.areFeesSponsored !== false ||
    selected.extra.assetTransferMethod !== "sequence" ||
    selected.extra.issuer !== policy.asset.issuer ||
    selected.extra.sourceTag !== policy.sourceTag ||
    typeof selected.extra.invoiceId !== "string" ||
    selected.extra.invoiceId.trim().length === 0 ||
    new TextEncoder().encode(selected.extra.invoiceId).length > 200
  ) reject("ISSUED_REQUIREMENT_MISMATCH");
  const amount = decimalParts(selected.amount).canonical;
  if (decimalParts(amount).atoms > decimalParts(policy.maxPerCall).atoms) {
    reject("ISSUED_PER_CALL_CAP_EXCEEDED");
  }
  if (
    typeof selected.maxTimeoutSeconds !== "number" ||
    !Number.isInteger(selected.maxTimeoutSeconds) ||
    selected.maxTimeoutSeconds < 1 ||
    selected.maxTimeoutSeconds > 600
  ) reject("INVALID_PAYMENT_TIMEOUT");
  if (selected.extra.destinationTag !== undefined) {
    reject("DESTINATION_TAG_UNSUPPORTED_BY_LEDGER_BINDER");
  }
  return {
    x402Version: 2,
    resource: decoded.resource as Record<string, unknown> & { url: string },
    scheme: "exact",
    network: "xrpl:1",
    asset: policy.asset,
    payTo: policy.payTo,
    amount,
    maxTimeoutSeconds: selected.maxTimeoutSeconds,
    invoiceId: selected.extra.invoiceId,
    sourceTag: policy.sourceTag,
  };
}

function validateTrustLine(
  line: X402IssuedTrustLineProof,
  holder: string,
  asset: X402IssuedAsset,
): { balance: bigint; limit: bigint } {
  if (
    !exactKeys(line as unknown as Record<string, unknown>, [
      "holder", "issuer", "currency", "balance", "limit", "frozen",
      "deepFrozen", "authorized", "issuerNoRipple", "qualitiesDefault",
    ]) ||
    line.holder !== holder ||
    line.issuer !== asset.issuer ||
    line.currency !== asset.currency ||
    typeof line.frozen !== "boolean" || line.frozen ||
    typeof line.deepFrozen !== "boolean" || line.deepFrozen ||
    typeof line.authorized !== "boolean" || line.authorized ||
    typeof line.issuerNoRipple !== "boolean" || line.issuerNoRipple ||
    line.qualitiesDefault !== true
  ) reject("ISSUED_TRUST_LINE_REJECTED");
  return {
    balance: ledgerAtoms(line.balance, "ISSUED_TRUST_LINE_REJECTED"),
    limit: ledgerAtoms(line.limit, "ISSUED_TRUST_LINE_REJECTED"),
  };
}

function validateIssuedPreflight(
  preparation: X402IssuedLedgerPreparation,
  challenge: X402IssuedChallenge,
  policy: X402IssuedPolicy,
  now: Date,
): void {
  if (
    !record(preparation) ||
    !record(preparation.issuer) ||
    !record(preparation.payer) ||
    !record(preparation.payee) ||
    !record(preparation.payerLine) ||
    !record(preparation.payeeLine) ||
    !exactKeys(preparation as unknown as Record<string, unknown>, [
      "owner", "approvalId", "approvalDigest", "quoteExpiresAt", "feeDrops",
      "validatedLedgerIndex", "reserveBaseDrops", "reserveIncrementDrops",
      "issuer", "payer", "payee", "payerLine", "payeeLine",
    ]) ||
    !exactKeys(preparation.issuer as unknown as Record<string, unknown>, [
      "account", "flags", "transferRate",
    ]) ||
    !exactKeys(preparation.payer as unknown as Record<string, unknown>, [
      "account", "balanceDrops", "ownerCount", "sequence", "flags",
    ]) ||
    !exactKeys(preparation.payee as unknown as Record<string, unknown>, [
      "account", "flags",
    ])
  ) reject("ISSUED_PREFLIGHT_BINDING_MISMATCH");
  const issuerFlags = uint32(preparation.issuer.flags, "INVALID_ISSUER_FLAGS");
  const payerFlags = uint32(preparation.payer.flags, "INVALID_PAYER_FLAGS");
  const payeeFlags = uint32(preparation.payee.flags, "INVALID_PAYEE_FLAGS");
  const quoteExpiry = new Date(preparation.quoteExpiresAt);
  if (
    typeof preparation.approvalId !== "string" ||
    !/^[A-Za-z0-9._:-]{8,200}$/.test(preparation.approvalId) ||
    typeof preparation.approvalDigest !== "string" ||
    !HASH.test(preparation.approvalDigest) ||
    Number.isNaN(quoteExpiry.getTime()) ||
    quoteExpiry.toISOString() !== preparation.quoteExpiresAt ||
    quoteExpiry.getTime() <= now.getTime() ||
    quoteExpiry.getTime() > now.getTime() + 5 * 60_000 ||
    preparation.owner !== preparation.payer.account ||
    !isValidClassicAddress(preparation.owner) ||
    preparation.owner === policy.asset.issuer ||
    preparation.owner === policy.payTo ||
    preparation.issuer.account !== policy.asset.issuer ||
    preparation.payee.account !== policy.payTo ||
    typeof preparation.issuer.transferRate !== "number" ||
    !Number.isSafeInteger(preparation.issuer.transferRate)
  ) reject("ISSUED_PREFLIGHT_BINDING_MISMATCH");
  if (
    issuerFlags & LSF_GLOBAL_FREEZE ||
    issuerFlags & LSF_REQUIRE_AUTH ||
    !(issuerFlags & LSF_DEFAULT_RIPPLE) ||
    preparation.issuer.transferRate !== CANONICAL_TRANSFER_RATE
  ) reject("ISSUER_POLICY_REJECTED");
  if (
    payeeFlags & LSF_DEPOSIT_AUTH ||
    payeeFlags & LSF_REQUIRE_DEST_TAG ||
    payerFlags & LSF_DISABLE_MASTER
  ) reject("ACCOUNT_POLICY_REJECTED");
  const payerLine = validateTrustLine(
    preparation.payerLine,
    preparation.owner,
    policy.asset,
  );
  const payeeLine = validateTrustLine(
    preparation.payeeLine,
    policy.payTo,
    policy.asset,
  );
  const amount = decimalParts(challenge.amount).atoms;
  if (
    payerLine.balance < amount ||
    payeeLine.limit - payeeLine.balance < amount
  ) reject("ISSUED_BALANCE_OR_LIMIT_REJECTED");
  const fee = BigInt(canonicalDrops(preparation.feeDrops, "INVALID_FEE", true));
  const balance = BigInt(
    canonicalDrops(preparation.payer.balanceDrops, "INVALID_XRP_BALANCE"),
  );
  const reserveBase = BigInt(
    canonicalDrops(preparation.reserveBaseDrops, "INVALID_XRP_RESERVE"),
  );
  const reserveIncrement = BigInt(
    canonicalDrops(preparation.reserveIncrementDrops, "INVALID_XRP_RESERVE"),
  );
  const ownerCount = uint32(preparation.payer.ownerCount, "INVALID_OWNER_COUNT");
  if (
    fee > BigInt(policy.maxFeeDrops) ||
    balance - fee < reserveBase + reserveIncrement * BigInt(ownerCount) ||
    balance - fee < BigInt(policy.minimumXrpReserveDrops)
  ) reject("ISSUED_FEE_OR_RESERVE_REJECTED");
}

export async function buildIssuedX402SigningRequest(input: Readonly<{
  idempotencyKey: string;
  merchantId: string;
  sessionScope: string;
  challenge: X402IssuedChallenge;
  preparation: X402IssuedLedgerPreparation;
  policy: X402IssuedPolicy;
  now: Date;
}>): Promise<X402IssuedSigningRequest> {
  validatePolicy(input.policy);
  const { challenge, preparation, policy } = input;
  if (
    challenge.network !== "xrpl:1" ||
    assetKey(challenge.asset) !== assetKey(policy.asset) ||
    challenge.payTo !== policy.payTo ||
    !isValidClassicAddress(preparation.owner)
  ) reject("ISSUED_SIGNING_BINDING_MISMATCH");
  if (
    !/^[A-Za-z0-9._:-]{8,200}$/.test(input.merchantId) ||
    !/^[A-Za-z0-9._:-]{8,200}$/.test(input.sessionScope) ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 200
  ) reject("ISSUED_SIGNING_BINDING_MISMATCH");
  validateIssuedPreflight(preparation, challenge, policy, input.now);
  const fee = canonicalDrops(preparation.feeDrops, "INVALID_FEE", true);
  const sequence = positiveUInt32(preparation.payer.sequence, "INVALID_SEQUENCE");
  const ledger = positiveUInt32(
    preparation.validatedLedgerIndex,
    "INVALID_LEDGER_INDEX",
  );
  const lastLedgerSequence = ledger + Math.min(
    20,
    Math.ceil(challenge.maxTimeoutSeconds / 5) + 2,
  );
  if (lastLedgerSequence > UINT32_MAX) reject("INVALID_LEDGER_INDEX");
  const asset = {
    kind: "issued" as const,
    network: "xrpl:1" as const,
    namespace: "token" as const,
    currency: policy.asset.currency,
    issuer: policy.asset.issuer,
  };
  const envelope: X402IssuedApprovalEnvelopeV1 = {
    version: 1,
    domain: "pilot.x402.owner-approval",
    approval_id: preparation.approvalId,
    network: "xrpl:1",
    execution_network: "testnet",
    session_scope: input.sessionScope,
    idempotency_key: input.idempotencyKey,
    merchant: {
      id: input.merchantId,
      resource_method: "POST",
      resource_url: challenge.resource.url,
      pay_to: policy.payTo,
    },
    asset,
    amount: challenge.amount,
    owner: preparation.owner,
    quote_expires_at: preparation.quoteExpiresAt,
    merchant_invoice_id: challenge.invoiceId,
    transaction: {
      fee_drops: fee,
      sequence,
      last_ledger_sequence: lastLedgerSequence,
      source_tag: policy.sourceTag,
      validated_ledger_index: ledger,
    },
  };
  const approvalDigest = await digestIssuedApprovalEnvelope(envelope);
  if (preparation.approvalDigest !== approvalDigest) {
    reject("APPROVAL_DIGEST_MISMATCH");
  }
  const amount = {
    currency: policy.asset.currency,
    issuer: policy.asset.issuer,
    value: challenge.amount,
  };
  const transaction: Payment = {
    TransactionType: "Payment",
    Account: preparation.owner,
    Destination: policy.payTo,
    Amount: amount,
    SendMax: { ...amount },
    InvoiceID: approvalDigest,
    SourceTag: policy.sourceTag,
    Fee: fee,
    Sequence: sequence,
    LastLedgerSequence: lastLedgerSequence,
  };
  return {
    version: 1,
    approval_id: preparation.approvalId,
    approval_digest: preparation.approvalDigest,
    owner: preparation.owner,
    execution_network: "testnet",
    asset,
    amount: challenge.amount,
    pay_to: policy.payTo,
    quote_expires_at: preparation.quoteExpiresAt,
    validated_ledger_index: ledger,
    sequence,
    last_ledger_sequence: lastLedgerSequence,
    fee_drops: fee,
    source_tag: policy.sourceTag,
    invoice_id: transaction.InvoiceID!,
    tx_json: transaction,
  };
}

function exactIssuedAmount(
  value: unknown,
  expected: Readonly<{ currency: string; issuer: string }>,
  amount: string,
): boolean {
  return record(value) &&
    exactKeys(value, ["currency", "issuer", "value"]) &&
    value.currency === expected.currency &&
    value.issuer === expected.issuer &&
    value.value === amount;
}

function validateSignedPayment(
  signedBlob: string,
  expectedHash: string,
  request: X402IssuedSigningRequest,
): void {
  if (
    signedBlob.length === 0 ||
    signedBlob.length > 32 * 1024 ||
    signedBlob.length % 2 !== 0 ||
    !HEX.test(signedBlob.toUpperCase()) ||
    !HASH.test(expectedHash.toUpperCase()) ||
    hashes.hashSignedTx(signedBlob).toUpperCase() !== expectedHash.toUpperCase()
  ) reject("INVALID_SIGNED_PAYMENT");
  let decoded: Record<string, unknown>;
  try {
    decoded = decode(signedBlob) as Record<string, unknown>;
    if (!verifySignature(signedBlob)) reject("INVALID_SIGNED_PAYMENT");
  } catch (error) {
    if (error instanceof X402IssuedOfflineError) throw error;
    reject("INVALID_SIGNED_PAYMENT");
  }
  const expected = request.tx_json as unknown as Record<string, unknown>;
  if (
    !exactKeys(decoded, [
      ...Object.keys(expected), "SigningPubKey", "TxnSignature",
    ]) ||
    decoded.TransactionType !== "Payment" ||
    decoded.Account !== expected.Account ||
    decoded.Destination !== expected.Destination ||
    !exactIssuedAmount(decoded.Amount, request.asset, request.amount) ||
    !exactIssuedAmount(decoded.SendMax, request.asset, request.amount) ||
    decoded.InvoiceID !== expected.InvoiceID ||
    decoded.SourceTag !== expected.SourceTag ||
    decoded.DestinationTag !== expected.DestinationTag ||
    decoded.Fee !== expected.Fee ||
    decoded.Sequence !== expected.Sequence ||
    decoded.LastLedgerSequence !== expected.LastLedgerSequence ||
    typeof decoded.SigningPubKey !== "string" ||
    typeof decoded.TxnSignature !== "string"
  ) reject("SIGNED_PAYMENT_BINDING_MISMATCH");
  let signer: string;
  try {
    signer = deriveAddress(decoded.SigningPubKey);
  } catch {
    reject("SIGNER_NOT_AUTHORIZED");
  }
  if (signer !== request.owner) {
    reject("SIGNER_NOT_AUTHORIZED");
  }
}

function acceptedRequirement(challenge: X402IssuedChallenge): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "xrpl:1",
    asset: challenge.asset.currency,
    payTo: challenge.payTo,
    amount: challenge.amount,
    maxTimeoutSeconds: challenge.maxTimeoutSeconds,
    extra: {
      areFeesSponsored: false,
      assetTransferMethod: "sequence",
      issuer: challenge.asset.issuer,
      sourceTag: challenge.sourceTag,
      invoiceId: challenge.invoiceId,
      ...(challenge.destinationTag === undefined
        ? {}
        : { destinationTag: challenge.destinationTag }),
    },
  };
}

function paymentSignature(
  challenge: X402IssuedChallenge,
  signedBlob: string,
): string {
  const encoded = encodeHeader({
    x402Version: 2,
    resource: challenge.resource,
    accepted: acceptedRequirement(challenge),
    payload: { signedTxBlob: signedBlob },
  });
  if (encoded.length > PAYMENT_HEADER_LIMIT) reject("PAYMENT_SIGNATURE_TOO_LARGE");
  return encoded;
}

async function fixtureReceipt(
  response: Response,
  expected: { hash: string; payer: string },
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json"
  ) reject("MERCHANT_FIXTURE_RESPONSE_REJECTED");
  const header = response.headers.get("payment-response");
  if (header === null) reject("MERCHANT_FIXTURE_RECEIPT_MISSING");
  const receipt = decodeHeader(header);
  if (
    !record(receipt) ||
    !exactKeys(receipt, [
      "success", "transaction", "network", "payer", "evidenceSource",
    ]) ||
    receipt.success !== true ||
    receipt.network !== "xrpl:1" ||
    receipt.transaction !== expected.hash ||
    receipt.payer !== expected.payer ||
    receipt.evidenceSource !== "deterministic-offline-fixture"
  ) reject("MERCHANT_FIXTURE_RECEIPT_MISMATCH");
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^[0-9]+$/.test(declared) ||
      BigInt(declared) > BigInt(X402_MERCHANT_BODY_MAX_BYTES))
  ) reject("MERCHANT_FIXTURE_BODY_MISMATCH");
  if (response.body === null) reject("MERCHANT_FIXTURE_BODY_MISMATCH");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > X402_MERCHANT_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        reject("MERCHANT_FIXTURE_BODY_MISMATCH");
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = parseX402MerchantJsonBody(raw);
  } catch {
    reject("MERCHANT_FIXTURE_BODY_MISMATCH");
  }
  if (
    !record(body) ||
    !exactKeys(body, ["comparison", "paymentEvidence"]) ||
    !Array.isArray(body.comparison) ||
    body.comparison.length !== 2 ||
    body.comparison[0] !== "dex" ||
    body.comparison[1] !== "amm" ||
    body.paymentEvidence !== "deterministic-offline-fixture-not-live-validation"
  ) reject("MERCHANT_FIXTURE_BODY_MISMATCH");
  return body;
}

export function createOfflineIssuedX402Route(deps: Readonly<{
  enabled?: boolean;
  requestUrl: string;
  merchantId: string;
  sessionScope: string;
  policy: X402IssuedPolicy;
  budget: X402IssuedBudgetAuthority;
  state: X402IssuedStateAuthority;
  merchant: X402IssuedMerchantTransport;
  prepare(input: Readonly<{
    idempotencyKey: string;
    merchantId: string;
    sessionScope: string;
    challenge: X402IssuedChallenge;
  }>): Promise<X402IssuedLedgerPreparation>;
  signer: X402IssuedSigner;
  reconciler: Readonly<{
    reconcile(
      expectation: X402IssuedReconciliationExpectation,
    ): Promise<X402IssuedReconciliationResult>;
  }>;
  now?: () => Date;
  operationTimeoutMs?: number;
}>): {
  execute(input: Readonly<{ idempotencyKey: string }>): Promise<X402IssuedFixtureResult>;
} {
  validatePolicy(deps.policy);
  if (
    !/^[A-Za-z0-9._:-]{8,200}$/.test(deps.merchantId) ||
    !/^[A-Za-z0-9._:-]{8,200}$/.test(deps.sessionScope)
  ) reject("ISSUED_SIGNING_BINDING_MISMATCH");
  const now = deps.now ?? (() => new Date());
  const operationTimeoutMs = deps.operationTimeoutMs ?? 8_000;
  if (
    !Number.isInteger(operationTimeoutMs) ||
    operationTimeoutMs < 1 ||
    operationTimeoutMs > 60_000
  ) reject("INVALID_ISSUED_OPERATION_TIMEOUT");
  const inFlight = new Map<string, Promise<X402IssuedFixtureResult>>();
  const scope = paymentScope(
    deps.requestUrl,
    deps.merchantId,
    deps.sessionScope,
    deps.policy,
  );
  return Object.freeze({
    async execute(input) {
      if (deps.enabled !== true) reject("ISSUED_X402_OFFLINE_DISABLED");
      if (
        typeof input.idempotencyKey !== "string" ||
        input.idempotencyKey.length === 0 ||
        input.idempotencyKey.length > 200
      ) reject("INVALID_IDEMPOTENCY_KEY");
      const durable = await deps.state.get(input.idempotencyKey);
      if (durable !== null && durable.scope !== scope) {
        reject("IDEMPOTENCY_BINDING_MISMATCH");
      }
      if (durable?.status === "delivered" && durable.result !== undefined) {
        return durable.result;
      }
      if (durable !== null) reject("ISSUED_SETTLEMENT_RECONCILIATION_REQUIRED");
      const active = inFlight.get(input.idempotencyKey);
      if (active !== undefined) return await active;
      const operation = (async (): Promise<X402IssuedFixtureResult> => {
        const initial = await withDeadline(
          (signal) => deps.merchant.challenge(signal),
          "MERCHANT_CHALLENGE_TIMEOUT",
          operationTimeoutMs,
        );
        if (initial.status !== 402) reject("MERCHANT_CHALLENGE_REJECTED");
        const required = initial.headers.get("payment-required");
        if (required === null) reject("MERCHANT_CHALLENGE_REJECTED");
        const challenge = validateIssuedX402Challenge(
          required,
          deps.policy,
          deps.requestUrl,
        );
        const preparation = await withDeadline(
          () => deps.prepare({
            idempotencyKey: input.idempotencyKey,
            merchantId: deps.merchantId,
            sessionScope: deps.sessionScope,
            challenge,
          }),
          "ISSUED_PREFLIGHT_TIMEOUT",
          operationTimeoutMs,
        );
        return await deps.state.withPayerLock(preparation.owner, async () => {
        const afterLock = await deps.state.get(input.idempotencyKey);
        if (afterLock !== null && afterLock.scope !== scope) {
          reject("IDEMPOTENCY_BINDING_MISMATCH");
        }
        if (afterLock?.status === "delivered" && afterLock.result !== undefined) {
          return afterLock.result;
        }
        if (afterLock !== null) reject("ISSUED_SETTLEMENT_RECONCILIATION_REQUIRED");
        const signingRequest = await buildIssuedX402SigningRequest({
          idempotencyKey: input.idempotencyKey,
          merchantId: deps.merchantId,
          sessionScope: deps.sessionScope,
          challenge,
          preparation,
          policy: deps.policy,
          now: now(),
        });
        const stateReservation = await deps.state.reserve({
          idempotencyKey: input.idempotencyKey,
          scope,
          binding: JSON.stringify([
            input.idempotencyKey,
            deps.requestUrl,
            assetKey(deps.policy.asset),
            challenge.amount,
            challenge.payTo,
            challenge.invoiceId,
            preparation.approvalId,
            preparation.approvalDigest,
          ]),
          payer: preparation.owner,
          invoiceId: signingRequest.invoice_id,
          sequence: signingRequest.sequence,
          approvalId: preparation.approvalId,
          approvalDigest: preparation.approvalDigest,
        });
        if (stateReservation.replay) {
          reject("ISSUED_SETTLEMENT_RECONCILIATION_REQUIRED");
        }
        let reservation: X402IssuedBudgetReservation;
        try {
          reservation = await deps.budget.reserve({
            idempotencyKey: input.idempotencyKey,
            payer: preparation.owner,
            asset: deps.policy.asset,
            amount: challenge.amount,
            feeDrops: preparation.feeDrops,
            xrpBalanceDrops: preparation.payer.balanceDrops,
          minimumReserveDrops: (
            BigInt(preparation.reserveBaseDrops) +
            BigInt(preparation.reserveIncrementDrops) *
              BigInt(preparation.payer.ownerCount)
          ).toString(),
          });
        } catch (error) {
          await deps.state.releasePreSign(input.idempotencyKey);
          throw error;
        }
        if (reservation.replay) {
          await deps.state.releasePreSign(input.idempotencyKey);
          reject("ISSUED_SETTLEMENT_RECONCILIATION_REQUIRED");
        }
        await deps.state.markSigningStarted(input.idempotencyKey);
        let signed: { signedBlob: string; hash: string };
        try {
          signed = await withDeadline(
            (signal) => deps.signer.sign(signingRequest, signal),
            "ISSUED_SIGNER_TIMEOUT",
            operationTimeoutMs,
          );
          validateSignedPayment(
            signed.signedBlob,
            signed.hash,
            signingRequest,
          );
        } catch (error) {
          await deps.state.markUncertain(input.idempotencyKey);
          await deps.budget.markUncertain(input.idempotencyKey);
          throw error;
        }
        await deps.state.markSigned(
          input.idempotencyKey,
          signed.hash.toUpperCase(),
          signed.signedBlob.toUpperCase(),
        );
        if (now().getTime() >= new Date(preparation.quoteExpiresAt).getTime()) {
          await deps.state.markUncertain(input.idempotencyKey);
          await deps.budget.markUncertain(input.idempotencyKey);
          reject("SIGNED_APPROVAL_EXPIRED");
        }
        let response: Response;
        try {
          response = await withDeadline(
            (signal) => deps.merchant.pay(
              paymentSignature(challenge, signed.signedBlob),
              signal,
            ),
            "MERCHANT_SETTLEMENT_TIMEOUT",
            operationTimeoutMs,
          );
        } catch {
          await deps.state.markUncertain(input.idempotencyKey);
          await deps.budget.markUncertain(input.idempotencyKey);
          reject("MERCHANT_SETTLEMENT_UNCERTAIN");
        }
        let merchantBody: Readonly<Record<string, unknown>>;
        try {
          merchantBody = await withDeadline(
            (signal) => fixtureReceipt(
              response,
              {
                hash: signed.hash.toUpperCase(),
                payer: preparation.owner,
              },
              signal,
            ),
            "MERCHANT_FIXTURE_RECEIPT_TIMEOUT",
            operationTimeoutMs,
          );
        } catch (error) {
          await deps.state.markUncertain(input.idempotencyKey);
          await deps.budget.markUncertain(input.idempotencyKey);
          throw error;
        }
        let reconciliation: X402IssuedReconciliationResult;
        try {
          reconciliation = await withDeadline(
            () => deps.reconciler.reconcile({
              network: "xrpl:1",
              transactionHash: signed.hash.toUpperCase(),
              payer: preparation.owner,
              payTo: challenge.payTo,
              asset: challenge.asset,
              amount: challenge.amount,
              feeDrops: signingRequest.fee_drops,
              sequence: signingRequest.sequence,
              sourceTag: signingRequest.source_tag,
              merchantInvoiceId: challenge.invoiceId,
              approvalDigest: signingRequest.approval_digest,
              firstLedgerSequence: signingRequest.validated_ledger_index + 1,
              lastLedgerSequence: signingRequest.last_ledger_sequence,
            }),
            "ISSUED_RECONCILIATION_TIMEOUT",
            operationTimeoutMs,
          );
        } catch (error) {
          await deps.state.markUncertain(input.idempotencyKey);
          await deps.budget.markUncertain(input.idempotencyKey);
          throw error;
        }
        if (reconciliation.status !== "validated") {
          await deps.state.markUncertain(input.idempotencyKey);
          await deps.budget.markUncertain(input.idempotencyKey);
          reject("ISSUED_SETTLEMENT_RECONCILIATION_REQUIRED");
        }
        await deps.budget.commit(input.idempotencyKey);
        const result: X402IssuedFixtureResult = {
          status: "fixture_delivered",
          evidence: "deterministic-offline-fixture",
          idempotencyKey: input.idempotencyKey,
          asset: deps.policy.asset,
          amount: challenge.amount,
          payer: preparation.owner,
          payTo: challenge.payTo,
          invoiceId: challenge.invoiceId,
          approvalDigest: signingRequest.approval_digest,
          sessionScope: deps.sessionScope,
          merchantId: deps.merchantId,
          feeDrops: preparation.feeDrops,
          validatedLedgerIndex: reconciliation.evidence.ledgerIndex,
          transactionHash: signed.hash.toUpperCase(),
          merchantBody,
        };
        await deps.state.markDelivered(input.idempotencyKey, result);
        return result;
        });
      })();
      inFlight.set(input.idempotencyKey, operation);
      void operation.finally(() => {
        if (inFlight.get(input.idempotencyKey) === operation) {
          inFlight.delete(input.idempotencyKey);
        }
      }).catch(() => undefined);
      return await operation;
    },
  });
}

/** Unmounted local request seam. Callers must explicitly wire it to a route. */
export function createOfflineIssuedX402RequestHandler(
  route: ReturnType<typeof createOfflineIssuedX402Route>,
  requestTimeoutMs = 8_000,
): (request: Request) => Promise<Response> {
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 60_000
  ) reject("INVALID_ISSUED_OPERATION_TIMEOUT");
  return async (request) => {
    if (
      request.method !== "POST" ||
      request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
        "application/json"
    ) {
      return Response.json({ error: "offline_issued_route_rejected" }, { status: 404 });
    }
    let body: unknown;
    try {
      const declared = request.headers.get("content-length");
      if (
        declared !== null &&
        (!/^[0-9]+$/.test(declared) || BigInt(declared) > 4_096n)
      ) throw new Error("request too large");
      if (request.body === null) throw new Error("request body missing");
      const raw = await withDeadline(async (signal) => {
        const reader = request.body!.getReader();
        const cancel = () => { void reader.cancel().catch(() => undefined); };
        signal.addEventListener("abort", cancel, { once: true });
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > 4_096) {
              await reader.cancel().catch(() => undefined);
              throw new Error("request too large");
            }
            chunks.push(next.value);
          }
        } finally {
          signal.removeEventListener("abort", cancel);
        }
        const combined = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return combined;
      }, "REQUEST_BODY_TIMEOUT", requestTimeoutMs);
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw),
      ) as unknown;
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (
      !record(body) ||
      !exactKeys(body, ["idempotencyKey"]) ||
      typeof body.idempotencyKey !== "string"
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    try {
      return Response.json(
        await route.execute({ idempotencyKey: body.idempotencyKey }),
        { status: 200 },
      );
    } catch (error) {
      const code = error instanceof X402IssuedOfflineError
        ? error.code
        : "offline_issued_route_failed";
      return Response.json({ error: code }, { status: 409 });
    }
  };
}

type BudgetEntry = {
  binding: string;
  payer: string;
  day: string;
  amount: bigint;
  fee: bigint;
  state: "reserved" | "uncertain" | "committed";
};

/** Deterministic local authority; production persistence is intentionally absent. */
export class InMemoryIssuedX402Budget implements X402IssuedBudgetAuthority {
  readonly #entries = new Map<string, BudgetEntry>();
  readonly #policy: X402IssuedPolicy;
  readonly #clock: () => Date;
  #tail: Promise<void> = Promise.resolve();

  constructor(policy: X402IssuedPolicy, clock: () => Date = () => new Date()) {
    validatePolicy(policy);
    this.#policy = policy;
    this.#clock = clock;
  }

  async #locked<T>(work: () => T): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return work(); } finally { release(); }
  }

  async reserve(input: Readonly<{
    idempotencyKey: string;
    payer: string;
    asset: X402IssuedAsset;
    amount: string;
    feeDrops: string;
    xrpBalanceDrops: string;
    minimumReserveDrops: string;
  }>): Promise<X402IssuedBudgetReservation> {
    return this.#locked(() => {
      const amount = decimalParts(input.amount).atoms;
      const fee = BigInt(canonicalDrops(input.feeDrops, "INVALID_FEE", true));
      const balance = BigInt(canonicalDrops(input.xrpBalanceDrops, "INVALID_XRP_BALANCE"));
      const ledgerReserve = BigInt(
        canonicalDrops(input.minimumReserveDrops, "INVALID_XRP_RESERVE"),
      );
      validateAsset(input.asset);
      const binding = JSON.stringify([
        input.payer, assetKey(input.asset), input.amount, input.feeDrops,
        input.minimumReserveDrops,
      ]);
      const existing = this.#entries.get(input.idempotencyKey);
      if (existing !== undefined) {
        if (existing.binding !== binding) reject("IDEMPOTENCY_BINDING_MISMATCH");
        return { replay: true, state: existing.state };
      }
      if (
        !isValidClassicAddress(input.payer) ||
        assetKey(input.asset) !== assetKey(this.#policy.asset) ||
        amount > decimalParts(this.#policy.maxPerCall).atoms ||
        fee > BigInt(this.#policy.maxFeeDrops)
      ) reject("ISSUED_BUDGET_REJECTED");
      const day = this.#clock().toISOString().slice(0, 10);
      let daily = 0n;
      let lifetime = 0n;
      let activeFees = 0n;
      let dailyFees = 0n;
      let lifetimeFees = 0n;
      for (const entry of this.#entries.values()) {
        if (entry.payer !== input.payer) continue;
        lifetime += entry.amount;
        lifetimeFees += entry.fee;
        if (entry.day === day) {
          daily += entry.amount;
          dailyFees += entry.fee;
        }
        if (entry.state !== "committed") activeFees += entry.fee;
      }
      if (
        daily + amount > decimalParts(this.#policy.dailyCap).atoms ||
        lifetime + amount > decimalParts(this.#policy.lifetimeCap).atoms ||
        dailyFees + fee > BigInt(this.#policy.dailyFeeCapDrops) ||
        lifetimeFees + fee > BigInt(this.#policy.lifetimeFeeCapDrops)
      ) reject("ISSUED_BUDGET_REJECTED");
      if (
        balance - activeFees - fee <
          (ledgerReserve > BigInt(this.#policy.minimumXrpReserveDrops)
            ? ledgerReserve
            : BigInt(this.#policy.minimumXrpReserveDrops))
      ) reject("ISSUED_XRP_RESERVE_REJECTED");
      this.#entries.set(input.idempotencyKey, {
        binding,
        payer: input.payer,
        day,
        amount,
        fee,
        state: "reserved",
      });
      return { replay: false, state: "reserved" };
    });
  }

  async markUncertain(idempotencyKey: string): Promise<void> {
    await this.#locked(() => {
      const entry = this.#entries.get(idempotencyKey);
      if (entry === undefined || entry.state === "committed") {
        reject("ISSUED_BUDGET_STATE_MISMATCH");
      }
      entry.state = "uncertain";
    });
  }

  async releasePreSign(idempotencyKey: string): Promise<void> {
    await this.#locked(() => {
      const entry = this.#entries.get(idempotencyKey);
      if (entry === undefined || entry.state !== "reserved") {
        reject("ISSUED_BUDGET_STATE_MISMATCH");
      }
      this.#entries.delete(idempotencyKey);
    });
  }

  async commit(idempotencyKey: string): Promise<void> {
    await this.#locked(() => {
      const entry = this.#entries.get(idempotencyKey);
      if (entry === undefined) reject("ISSUED_BUDGET_STATE_MISMATCH");
      entry.state = "committed";
    });
  }
}

/** Fixture authority that models the required durable journal/sequence seam. */
export class InMemoryIssuedX402State implements X402IssuedStateAuthority {
  readonly #records = new Map<string, X402IssuedStateRecord>();
  readonly #invoiceOwners = new Map<string, string>();
  readonly #sequenceOwners = new Map<string, string>();
  readonly #approvalIdOwners = new Map<string, string>();
  readonly #approvalDigestOwners = new Map<string, string>();
  readonly #tails = new Map<string, Promise<void>>();

  async withPayerLock<T>(payer: string, callback: () => Promise<T>): Promise<T> {
    if (!isValidClassicAddress(payer)) reject("INVALID_PAYER_LOCK");
    const previous = this.#tails.get(payer) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(payer, tail);
    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      release();
      if (this.#tails.get(payer) === tail) this.#tails.delete(payer);
    }
  }

  async get(idempotencyKey: string): Promise<X402IssuedStateRecord | null> {
    return this.#records.get(idempotencyKey) ?? null;
  }

  async reserve(input: Readonly<{
    idempotencyKey: string;
    scope: string;
    binding: string;
    payer: string;
    invoiceId: string;
    sequence: number;
    approvalId: string;
    approvalDigest: string;
  }>): Promise<{ replay: boolean; record: X402IssuedStateRecord }> {
    const existing = this.#records.get(input.idempotencyKey);
    if (existing !== undefined) {
      if (
        existing.scope !== input.scope ||
        existing.binding !== input.binding
      ) reject("IDEMPOTENCY_BINDING_MISMATCH");
      return { replay: true, record: existing };
    }
    const sequenceKey = `${input.payer}:${input.sequence}`;
    if (
      this.#invoiceOwners.has(input.invoiceId) ||
      this.#sequenceOwners.has(sequenceKey) ||
      this.#approvalIdOwners.has(input.approvalId) ||
      this.#approvalDigestOwners.has(input.approvalDigest)
    ) reject("ISSUED_INVOICE_OR_SEQUENCE_CONFLICT");
    const recordValue: X402IssuedStateRecord = {
      scope: input.scope,
      binding: input.binding,
      payer: input.payer,
      invoiceId: input.invoiceId,
      sequence: input.sequence,
      approvalId: input.approvalId,
      approvalDigest: input.approvalDigest,
      status: "reserved",
    };
    this.#records.set(input.idempotencyKey, recordValue);
    this.#invoiceOwners.set(input.invoiceId, input.idempotencyKey);
    this.#sequenceOwners.set(sequenceKey, input.idempotencyKey);
    this.#approvalIdOwners.set(input.approvalId, input.idempotencyKey);
    this.#approvalDigestOwners.set(input.approvalDigest, input.idempotencyKey);
    return { replay: false, record: recordValue };
  }

  async releasePreSign(idempotencyKey: string): Promise<void> {
    const existing = this.#records.get(idempotencyKey);
    if (existing === undefined || existing.status !== "reserved") {
      reject("ISSUED_STATE_MISMATCH");
    }
    this.#records.delete(idempotencyKey);
    this.#invoiceOwners.delete(existing.invoiceId);
    this.#sequenceOwners.delete(`${existing.payer}:${existing.sequence}`);
    this.#approvalIdOwners.delete(existing.approvalId);
    this.#approvalDigestOwners.delete(existing.approvalDigest);
  }

  async markSigned(
    idempotencyKey: string,
    hash: string,
    signedBlob: string,
  ): Promise<void> {
    const existing = this.#records.get(idempotencyKey);
    if (
      existing === undefined ||
      existing.status !== "signing" ||
      !HASH.test(hash) ||
      !HEX.test(signedBlob) ||
      signedBlob.length % 2 !== 0
    ) reject("ISSUED_STATE_MISMATCH");
    this.#records.set(idempotencyKey, {
      ...existing,
      status: "signed",
      hash,
      signedBlob,
    });
  }

  async markSigningStarted(idempotencyKey: string): Promise<void> {
    const existing = this.#records.get(idempotencyKey);
    if (existing === undefined || existing.status !== "reserved") {
      reject("ISSUED_STATE_MISMATCH");
    }
    this.#records.set(idempotencyKey, { ...existing, status: "signing" });
  }

  async markUncertain(idempotencyKey: string): Promise<void> {
    const existing = this.#records.get(idempotencyKey);
    if (
      existing === undefined ||
      (existing.status !== "signing" &&
        existing.status !== "signed" &&
        existing.status !== "uncertain")
    ) reject("ISSUED_STATE_MISMATCH");
    this.#records.set(idempotencyKey, { ...existing, status: "uncertain" });
  }

  async markDelivered(
    idempotencyKey: string,
    result: X402IssuedFixtureResult,
  ): Promise<void> {
    const existing = this.#records.get(idempotencyKey);
    if (
      existing === undefined ||
      existing.status !== "signed" ||
      existing.hash !== result.transactionHash
    ) reject("ISSUED_STATE_MISMATCH");
    this.#records.set(idempotencyKey, {
      ...existing,
      status: "delivered",
      result,
    });
  }
}
