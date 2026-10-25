import {
  decode,
  deriveAddress,
  encode,
  encodeForSigning,
  hashes,
  isValidClassicAddress,
  verifyKeypairSignature,
  type Transaction,
} from "xrpl";
import { z } from "zod";

import { ledgerSigningMode } from "./clear-sign.js";
import {
  X402_OWNER_APPROVAL_DOMAIN,
  verifyIssuedX402ApprovalCommitment,
  type IssuedX402OwnerApprovalEnvelope,
} from "./x402-approval-envelope.js";

export const XRPL_TESTNET_CAIP2 = "xrpl:1" as const;
export const PILOT_ISSUED_PAYMENT_XRP_APP_VERSION = "2.8.2" as const;
export const PILOT_ISSUED_PAYMENT_MAX_FEE_DROPS = "100" as const;
export const PILOT_ISSUED_PAYMENT_MAX_LEDGER_WINDOW = 20 as const;
export const PILOT_ISSUED_PAYMENT_MAX_QUOTE_TTL_MS = 5 * 60_000;

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/);
const HashSchema = z.string().regex(/^[A-F0-9]{64}$/);
const ClassicAddressSchema = z.string().refine(isValidClassicAddress, "invalid classic XRPL address");
const CurrencySchema = z.string().regex(/^[A-F0-9]{40}$/);
const CanonicalDecimalSchema = z.string().refine(
  (value) => /^(?:[1-9]\d*(?:\.\d*[1-9])?|0\.\d*[1-9])$/.test(value) &&
    value.replace(".", "").replace(/^0+/, "").length <= 15,
  "issued amount must be a positive canonical plain decimal with at most 15 significant digits",
);
const CanonicalDropsSchema = z.string().regex(/^(?:0|[1-9]\d*)$/);
const UnsignedTransactionSchema = z.record(z.string(), z.unknown());

export const IssuedAssetX402SigningRequestSchema = z.object({
  version: z.literal(1),
  approval_id: IdentifierSchema,
  approval_digest: HashSchema,
  session_scope: z.string().min(8).max(200),
  idempotency_key: z.string().min(1).max(200),
  owner: ClassicAddressSchema,
  execution_network: z.literal("testnet"),
  asset: z.object({
    kind: z.literal("issued"),
    network: z.literal(XRPL_TESTNET_CAIP2),
    namespace: z.literal("token"),
    currency: CurrencySchema,
    issuer: ClassicAddressSchema,
  }).strict(),
  amount: CanonicalDecimalSchema,
  pay_to: ClassicAddressSchema,
  merchant: z.object({
    id: z.string().min(8).max(200),
    resource_method: z.literal("POST"),
    resource_url: z.string().min(1).max(2_048),
  }).strict(),
  merchant_invoice_id: z.string().min(1).max(200),
  quote_expires_at: z.string().datetime(),
  validated_ledger_index: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  last_ledger_sequence: z.number().int().positive(),
  fee_drops: CanonicalDropsSchema,
  source_tag: z.number().int().nonnegative().max(0xffff_ffff),
  invoice_id: HashSchema,
  tx_json: UnsignedTransactionSchema,
}).strict();

export type IssuedAssetX402SigningRequest = z.infer<typeof IssuedAssetX402SigningRequestSchema>;

export const LedgerIssuedPaymentAppConfigSchema = z.object({
  app_name: z.literal("XRP"),
  app_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  source: z.enum(["device-app-config", "speculos-app-config"]),
}).strict();

export type LedgerIssuedPaymentAppConfig = z.infer<typeof LedgerIssuedPaymentAppConfigSchema>;

export type BoundIssuedAssetX402SigningRequest = Readonly<{
  request: IssuedAssetX402SigningRequest;
  transaction: Readonly<Record<string, unknown>>;
  signingMode: "clear";
  appSupport: Readonly<{
    appName: "XRP";
    appVersion: typeof PILOT_ISSUED_PAYMENT_XRP_APP_VERSION;
    source: LedgerIssuedPaymentAppConfig["source"];
    evidence: "pinned-version-profile-only";
    physicalDeviceInferred: false;
  }>;
}>;

export type VerifiedIssuedAssetX402SignedBlob = Readonly<{
  transaction: Readonly<Record<string, unknown>>;
  hash: string;
  signingMode: "clear";
}>;

export type IssuedPaymentPolicyErrorCode =
  | "INVALID_REQUEST"
  | "NETWORK_MISMATCH"
  | "UNSUPPORTED_APP_PROFILE"
  | "STALE_QUOTE"
  | "QUOTE_WINDOW_TOO_BROAD"
  | "FEE_EXCEEDS_CAP"
  | "LEDGER_WINDOW_INVALID"
  | "UNEXPECTED_FIELD"
  | "SEMANTIC_MISMATCH"
  | "UNSUPPORTED_DISPLAY"
  | "INVALID_SIGNATURE_SHAPE";

export class IssuedPaymentPolicyError extends Error {
  constructor(
    readonly code: IssuedPaymentPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IssuedPaymentPolicyError";
  }
}

const RESERVED_XRP_HEX = "0000000000000000000000005852500000000000";
const ZERO_CURRENCY = "0000000000000000000000000000000000000000";
const REQUIRED_UNSIGNED_FIELDS = new Set([
  "TransactionType",
  "Account",
  "Destination",
  "Amount",
  "SendMax",
  "Fee",
  "Sequence",
  "LastLedgerSequence",
  "SourceTag",
  "InvoiceID",
]);
const SIGNED_FIELDS = new Set([...REQUIRED_UNSIGNED_FIELDS, "SigningPubKey", "TxnSignature"]);

function fail(code: IssuedPaymentPolicyErrorCode, message: string): never {
  throw new IssuedPaymentPolicyError(code, message);
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

function canonicalDrops(value: string, label: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    fail("SEMANTIC_MISMATCH", `${label} must be canonical XRP drops.`);
  }
  return BigInt(value);
}

function expectedIssuedAmount(request: IssuedAssetX402SigningRequest) {
  return Object.freeze({
    currency: request.asset.currency,
    issuer: request.asset.issuer,
    value: request.amount,
  });
}

function assertExactFields(transaction: Record<string, unknown>, phase: "before-sign" | "after-sign"): void {
  const allowed = phase === "before-sign" ? REQUIRED_UNSIGNED_FIELDS : SIGNED_FIELDS;
  if (Object.keys(transaction).length !== allowed.size) {
    fail("UNEXPECTED_FIELD", "The issued-asset Payment has missing or additional fields.");
  }
  const unexpected = Object.keys(transaction).find((field) => !allowed.has(field));
  if (unexpected !== undefined) {
    fail("UNEXPECTED_FIELD", `Unsupported issued-asset Payment field: ${unexpected}.`);
  }
  for (const required of allowed) {
    if (!(required in transaction)) {
      fail("UNEXPECTED_FIELD", `Required issued-asset Payment field is missing: ${required}.`);
    }
  }
}

function assertNetwork(request: IssuedAssetX402SigningRequest): void {
  // The Chain Agnostic XRPL namespace assigns 0=livenet, 1=testnet, 2=devnet.
  // Keep Pilot's execution network and the CAIP-2 asset identity in agreement.
  if (request.execution_network !== "testnet" || request.asset.network !== XRPL_TESTNET_CAIP2) {
    fail("NETWORK_MISMATCH", "Issued-asset signing is restricted to XRPL Testnet (xrpl:1).");
  }
}

function assertAppSupport(appConfig: unknown): LedgerIssuedPaymentAppConfig {
  // Ledger documents Payment and issued-asset review in the XRP app, but does
  // not publish a versioned compatibility table. Pilot therefore enables only
  // its explicitly pinned display profile and rejects every other version.
  const parsed = LedgerIssuedPaymentAppConfigSchema.safeParse(appConfig);
  if (!parsed.success || parsed.data.app_version !== PILOT_ISSUED_PAYMENT_XRP_APP_VERSION) {
    fail(
      "UNSUPPORTED_APP_PROFILE",
      `Issued-asset Payment review requires the pinned XRP app ${PILOT_ISSUED_PAYMENT_XRP_APP_VERSION} display profile.`,
    );
  }
  return parsed.data;
}

function assertTimeAndLedgerBounds(request: IssuedAssetX402SigningRequest, now: number): void {
  const expiresAt = Date.parse(request.quote_expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    fail("STALE_QUOTE", "The issued-asset quote is stale.");
  }
  if (expiresAt - now > PILOT_ISSUED_PAYMENT_MAX_QUOTE_TTL_MS) {
    fail("QUOTE_WINDOW_TOO_BROAD", "The issued-asset quote lifetime is too broad.");
  }
  if (
    request.last_ledger_sequence <= request.validated_ledger_index ||
    request.last_ledger_sequence > request.validated_ledger_index + PILOT_ISSUED_PAYMENT_MAX_LEDGER_WINDOW
  ) {
    fail("LEDGER_WINDOW_INVALID", "The issued-asset Payment ledger window is stale or too broad.");
  }
  if (canonicalDrops(request.fee_drops, "Payment fee") > BigInt(PILOT_ISSUED_PAYMENT_MAX_FEE_DROPS)) {
    fail("FEE_EXCEEDS_CAP", "The issued-asset Payment fee exceeds the reviewed cap.");
  }
}

function assertCurrency(request: IssuedAssetX402SigningRequest): void {
  if (request.asset.currency === ZERO_CURRENCY || request.asset.currency === RESERVED_XRP_HEX) {
    fail("INVALID_REQUEST", "The issued-asset currency code is reserved or empty.");
  }
}

function validateTransaction(
  transaction: Record<string, unknown>,
  request: IssuedAssetX402SigningRequest,
  phase: "before-sign" | "after-sign",
  now: number,
): void {
  assertExactFields(transaction, phase);
  assertTimeAndLedgerBounds(request, now);
  const amount = expectedIssuedAmount(request);
  if (
    transaction.TransactionType !== "Payment" ||
    transaction.Account !== request.owner ||
    transaction.Destination !== request.pay_to ||
    !exact(transaction.Amount, amount) ||
    !exact(transaction.SendMax, amount) ||
    transaction.Fee !== request.fee_drops ||
    transaction.Sequence !== request.sequence ||
    transaction.LastLedgerSequence !== request.last_ledger_sequence ||
    transaction.SourceTag !== request.source_tag ||
    transaction.InvoiceID !== request.invoice_id
  ) {
    fail(
      "SEMANTIC_MISMATCH",
      "The issued-asset Payment changed its account, asset, amount, SendMax, destination, fee, ledger window, or invoice binding.",
    );
  }
  if (phase === "before-sign") {
    if (transaction.SigningPubKey !== undefined || transaction.TxnSignature !== undefined) {
      fail("INVALID_SIGNATURE_SHAPE", "The issued-asset Payment must be unsigned before review.");
    }
  } else if (
    typeof transaction.SigningPubKey !== "string" ||
    !/^(?:02|03)[A-Fa-f0-9]{64}$/.test(transaction.SigningPubKey) ||
    typeof transaction.TxnSignature !== "string" ||
    !/^(?:[A-Fa-f0-9]{2})+$/.test(transaction.TxnSignature)
  ) {
    fail("INVALID_SIGNATURE_SHAPE", "The signed issued-asset Payment has an invalid signature shape.");
  } else {
    try {
      if (
        deriveAddress(transaction.SigningPubKey) !== request.owner ||
        !verifyKeypairSignature(
          encodeForSigning(transaction as Transaction),
          transaction.TxnSignature,
          transaction.SigningPubKey,
        )
      ) {
        fail("INVALID_SIGNATURE_SHAPE", "The signed issued-asset Payment does not match the reviewed owner.");
      }
    } catch (error) {
      if (error instanceof IssuedPaymentPolicyError) throw error;
      fail("INVALID_SIGNATURE_SHAPE", "The signed issued-asset Payment signature is invalid.");
    }
  }
  if (ledgerSigningMode(transaction) !== "clear") {
    fail("UNSUPPORTED_DISPLAY", "The XRP app cannot safely display this issued-asset Payment; blind signing is not allowed.");
  }
}

function assertCodecRoundTrip(transaction: Record<string, unknown>): void {
  try {
    const roundTrip = decode(encode(transaction as Transaction)) as Record<string, unknown>;
    if (!exact(roundTrip, transaction)) {
      fail("SEMANTIC_MISMATCH", "XRPL canonical encoding changed the reviewed issued-asset Payment.");
    }
  } catch (error) {
    if (error instanceof IssuedPaymentPolicyError) throw error;
    fail("INVALID_REQUEST", "The issued-asset Payment is not canonically encodable by XRPL.");
  }
}

export function issuedAssetX402AssetId(request: IssuedAssetX402SigningRequest): string {
  return `${request.asset.network}/${request.asset.namespace}:${request.asset.currency}.${request.asset.issuer}`;
}

export function issuedAssetX402ApprovalEnvelope(
  request: IssuedAssetX402SigningRequest,
): IssuedX402OwnerApprovalEnvelope {
  return {
    version: 1,
    domain: X402_OWNER_APPROVAL_DOMAIN,
    approval_id: request.approval_id,
    network: request.asset.network,
    execution_network: request.execution_network,
    session_scope: request.session_scope,
    idempotency_key: request.idempotency_key,
    merchant: {
      id: request.merchant.id,
      resource_method: request.merchant.resource_method,
      resource_url: request.merchant.resource_url,
      pay_to: request.pay_to,
    },
    asset: request.asset,
    amount: request.amount,
    owner: request.owner,
    quote_expires_at: request.quote_expires_at,
    merchant_invoice_id: request.merchant_invoice_id,
    transaction: {
      fee_drops: request.fee_drops,
      sequence: request.sequence,
      validated_ledger_index: request.validated_ledger_index,
      last_ledger_sequence: request.last_ledger_sequence,
      source_tag: request.source_tag,
    },
  };
}

export async function bindIssuedAssetX402SigningRequest(input: Readonly<{
  request: unknown;
  connectedAccount: string;
  appConfig: unknown;
  now?: number;
}>): Promise<BoundIssuedAssetX402SigningRequest> {
  const parsed = IssuedAssetX402SigningRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    fail("INVALID_REQUEST", "The issued-asset owner-signing request is invalid.");
  }
  const request = parsed.data;
  if (!isValidClassicAddress(input.connectedAccount) || input.connectedAccount !== request.owner) {
    fail("SEMANTIC_MISMATCH", "The connected account changed before issued-asset review.");
  }
  assertNetwork(request);
  assertCurrency(request);
  const app = assertAppSupport(input.appConfig);
  const transaction = { ...request.tx_json };
  validateTransaction(transaction, request, "before-sign", input.now ?? Date.now());
  assertCodecRoundTrip(transaction);
  try {
    await verifyIssuedX402ApprovalCommitment({
      envelope: issuedAssetX402ApprovalEnvelope(request),
      approvalDigest: request.approval_digest,
      invoiceId: transaction.InvoiceID,
    });
  } catch {
    fail(
      "SEMANTIC_MISMATCH",
      "The issued-asset Payment does not contain the exact owner-approval commitment.",
    );
  }
  return Object.freeze({
    request,
    transaction: Object.freeze(transaction),
    signingMode: "clear" as const,
    appSupport: Object.freeze({
      appName: "XRP" as const,
      appVersion: PILOT_ISSUED_PAYMENT_XRP_APP_VERSION,
      source: app.source,
      evidence: "pinned-version-profile-only" as const,
      physicalDeviceInferred: false as const,
    }),
  });
}

export function verifyIssuedAssetX402SignedBlob(input: Readonly<{
  signedBlob: string;
  bound: BoundIssuedAssetX402SigningRequest;
  now?: number;
}>): VerifiedIssuedAssetX402SignedBlob {
  if (!/^(?:[A-Fa-f0-9]{2})+$/.test(input.signedBlob)) {
    fail("INVALID_SIGNATURE_SHAPE", "The signed issued-asset Payment blob is invalid.");
  }
  let transaction: Record<string, unknown>;
  try {
    transaction = decode(input.signedBlob) as Record<string, unknown>;
  } catch {
    fail("INVALID_SIGNATURE_SHAPE", "The signed issued-asset Payment blob cannot be decoded.");
  }
  validateTransaction(transaction, input.bound.request, "after-sign", input.now ?? Date.now());
  let hash: string;
  try {
    hash = hashes.hashSignedTx(input.signedBlob).toUpperCase();
  } catch {
    fail("INVALID_SIGNATURE_SHAPE", "The signed issued-asset Payment hash is invalid.");
  }
  return Object.freeze({
    transaction: Object.freeze(transaction),
    hash,
    signingMode: "clear" as const,
  });
}
