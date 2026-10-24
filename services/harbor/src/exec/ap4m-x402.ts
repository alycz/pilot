import { isValidClassicAddress } from "xrpl";

import {
  validateX402ResourceInfo,
  X402_INVOICE_ID_MAX_BYTES,
  X402_MAX_TIMEOUT_SECONDS,
  X402_PAYMENT_REQUIRED_MAX_DECODED_BYTES,
  X402_PAYMENT_REQUIRED_MAX_ENCODED_BYTES,
  type X402ResourceInfo,
} from "../adapters/x402";

const UINT32_MAX = 0xffff_ffff;
const IOU_VALUE_MAX_BYTES = 32;
const IOU_MAX_SIGNIFICANT_DIGITS = 16;
const INTENT_MAX_DECODED_BYTES = 16 * 1024;
const INTENT_MAX_ENCODED_BYTES = 24 * 1024;
const VI_L3B_MAX_BYTES = 16 * 1024;
const SIGNED_BLOB_MAX_HEX_CHARS = 16 * 1024;
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const COMPACT_SD_JWT = /^[A-Za-z0-9._~-]+$/;
const HEX = /^[A-F0-9]+$/;
const encoder = new TextEncoder();

const WRAPPER_KEYS = new Set([
  "x402Version",
  "error",
  "resource",
  "accepts",
  "extensions",
]);
const REQUIREMENT_KEYS = new Set([
  "scheme",
  "network",
  "asset",
  "payTo",
  "amount",
  "maxTimeoutSeconds",
  "extra",
]);
const EXTRA_KEYS = new Set([
  "areFeesSponsored",
  "assetTransferMethod",
  "invoiceId",
  "issuer",
  "sourceTag",
  "destinationTag",
]);

export const AP4M_PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const AP4M_MASTERCARD_INTENT_HEADER = "x-mastercard-intent";
export const AP4M_VI_L1_HEADER = "x-vi-l1";
export const AP4M_VI_L2_HEADER = "x-vi-l2";
export const AP4M_VI_L3B_HEADER = "x-vi-l3b";

export type Ap4mStableAsset = Readonly<{
  currency: string;
  issuer: string;
}>;

export type ValidateAp4mX402ChallengeOptions = Readonly<{
  requestUrl: string;
  network: "testnet";
  merchantPayTo: string;
  expectedAsset: Ap4mStableAsset;
  maxAmount: string;
  expectedSourceTag?: number;
}>;

export type Ap4mX402Requirement = Readonly<{
  scheme: "exact";
  network: "xrpl:1";
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
  extra: Readonly<{
    areFeesSponsored: false;
    assetTransferMethod: "sequence";
    invoiceId: string;
    issuer: string;
    sourceTag?: number;
    destinationTag?: number;
  }>;
}>;

export type ValidatedAp4mX402Challenge = Readonly<{
  x402Version: 2;
  resource: X402ResourceInfo;
  scheme: "exact";
  network: "xrpl:1";
  currency: string;
  issuer: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
  invoiceId: string;
  sourceTag?: number;
  destinationTag?: number;
  accepted: Ap4mX402Requirement;
}>;

export class Ap4mX402Error extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "Ap4mX402Error";
  }
}

function reject(code: string): never {
  throw new Ap4mX402Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) reject(code);
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function uint32(value: unknown, code: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > UINT32_MAX
  ) {
    reject(code);
  }
  return value;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 4_096) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 4_096));
  }
  return btoa(binary);
}

function base64url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodePaymentRequired(input: string | readonly string[]): unknown {
  const header = typeof input === "string"
    ? input
    : input.length === 1
      ? input[0]
      : reject("DUPLICATE_PAYMENT_REQUIRED");
  if (header.includes(",")) reject("DUPLICATE_PAYMENT_REQUIRED");
  if (
    header.length === 0 ||
    header.length > X402_PAYMENT_REQUIRED_MAX_ENCODED_BYTES ||
    header.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(header)
  ) {
    reject("INVALID_PAYMENT_REQUIRED_ENCODING");
  }
  const padding = header.endsWith("==") ? 2 : header.endsWith("=") ? 1 : 0;
  const expectedBytes = (header.length / 4) * 3 - padding;
  if (expectedBytes > X402_PAYMENT_REQUIRED_MAX_DECODED_BYTES) {
    reject("PAYMENT_REQUIRED_TOO_LARGE");
  }
  let binary: string;
  try {
    binary = atob(header);
  } catch {
    reject("INVALID_PAYMENT_REQUIRED_ENCODING");
  }
  if (binary.length !== expectedBytes || btoa(binary) !== header) {
    reject("INVALID_PAYMENT_REQUIRED_ENCODING");
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    reject("INVALID_PAYMENT_REQUIRED_UTF8");
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    reject("INVALID_PAYMENT_REQUIRED_JSON");
  }
}

/** Convert a semantic stablecoin name (for example RLUSD/tUSD) to XRPL wire form. */
export function xrplCurrencyCodeForAp4m(value: string): string {
  if (/^[A-Fa-f0-9]{40}$/.test(value)) return value.toUpperCase();
  if (/^[A-Za-z0-9?!@#$%&*<>(){}[\]|]{3}$/.test(value) && value !== "XRP") {
    return value;
  }
  const bytes = encoder.encode(value);
  if (bytes.byteLength === 0 || bytes.byteLength > 20 || value === "XRP") {
    reject("INVALID_EXPECTED_CURRENCY");
  }
  return [...bytes, ...new Array<number>(20 - bytes.length).fill(0)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;

function decimal(value: unknown, code: string): Decimal {
  if (
    typeof value !== "string" ||
    byteLength(value) > IOU_VALUE_MAX_BYTES ||
    !/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value)
  ) {
    reject(code);
  }
  const [whole, fraction = ""] = value.split(".");
  const significant = `${whole}${fraction}`.replace(/^0+/, "");
  if (
    significant.length === 0 ||
    significant.length > IOU_MAX_SIGNIFICANT_DIGITS
  ) {
    reject(code);
  }
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function lessThanOrEqual(left: Decimal, right: Decimal): boolean {
  if (left.scale === right.scale) return left.coefficient <= right.coefficient;
  if (left.scale < right.scale) {
    return left.coefficient * 10n ** BigInt(right.scale - left.scale) <= right.coefficient;
  }
  return left.coefficient <= right.coefficient * 10n ** BigInt(left.scale - right.scale);
}

function invoiceId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    byteLength(value) > X402_INVOICE_ID_MAX_BYTES
  ) {
    reject("INVALID_INVOICE_ID");
  }
  return value;
}

function compatibleRequirement(
  value: Record<string, unknown>,
  expectedCurrency: string,
  expectedIssuer: string,
): boolean {
  if (
    value.scheme !== "exact" ||
    value.network !== "xrpl:1" ||
    value.asset !== expectedCurrency ||
    !isRecord(value.extra)
  ) {
    return false;
  }
  return value.extra.issuer === expectedIssuer;
}

/**
 * Validate the one XRPL Testnet issued-currency option Harbor is authorized to
 * sign. The exact XRPL x402 scheme identifies an IOU by asset + extra.issuer:
 * https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_xrpl.md
 */
export function validateAp4mX402Challenge(
  header: string | readonly string[],
  options: ValidateAp4mX402ChallengeOptions,
): ValidatedAp4mX402Challenge {
  if (options.network !== "testnet") reject("UNSUPPORTED_NETWORK");
  if (!isValidClassicAddress(options.merchantPayTo)) reject("INVALID_EXPECTED_PAY_TO");
  if (!isValidClassicAddress(options.expectedAsset.issuer)) reject("INVALID_EXPECTED_ISSUER");
  if (typeof options.requestUrl !== "string" || options.requestUrl.length === 0) {
    reject("INVALID_REQUEST_URL");
  }
  const expectedCurrency = xrplCurrencyCodeForAp4m(options.expectedAsset.currency);
  const maxAmount = decimal(options.maxAmount, "INVALID_MAX_AMOUNT");
  const expectedSourceTag = options.expectedSourceTag === undefined
    ? undefined
    : uint32(options.expectedSourceTag, "INVALID_EXPECTED_SOURCE_TAG");

  const decoded = decodePaymentRequired(header);
  if (!isRecord(decoded)) reject("INVALID_PAYMENT_REQUIRED_WRAPPER");
  if (decoded.x402Version !== 2) reject("UNSUPPORTED_X402_VERSION");
  rejectUnknownKeys(decoded, WRAPPER_KEYS, "UNSUPPORTED_PAYMENT_CONTROL");
  if (
    (decoded.error !== undefined && typeof decoded.error !== "string") ||
    (decoded.extensions !== undefined &&
      (!isRecord(decoded.extensions) || Object.keys(decoded.extensions).length !== 0))
  ) {
    reject("UNSUPPORTED_PAYMENT_CONTROL");
  }
  const resource = validateX402ResourceInfo(decoded.resource, options.requestUrl);
  if (!Array.isArray(decoded.accepts) || decoded.accepts.some((entry) => !isRecord(entry))) {
    reject("INVALID_ACCEPTS");
  }
  const compatible = decoded.accepts.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) &&
      compatibleRequirement(entry, expectedCurrency, options.expectedAsset.issuer),
  );
  if (compatible.length !== 1) {
    reject(
      compatible.length === 0
        ? "NO_COMPATIBLE_PAYMENT_REQUIREMENT"
        : "AMBIGUOUS_PAYMENT_REQUIREMENTS",
    );
  }

  const selected = compatible[0];
  rejectUnknownKeys(selected, REQUIREMENT_KEYS, "UNSUPPORTED_PAYMENT_CONTROL");
  if (selected.payTo !== options.merchantPayTo) reject("PAY_TO_MISMATCH");
  if (!isValidClassicAddress(selected.payTo as string)) reject("INVALID_PAY_TO");
  const amount = decimal(selected.amount, "INVALID_AMOUNT");
  if (!lessThanOrEqual(amount, maxAmount)) reject("MAX_PRICE_EXCEEDED");
  if (
    typeof selected.maxTimeoutSeconds !== "number" ||
    !Number.isInteger(selected.maxTimeoutSeconds) ||
    selected.maxTimeoutSeconds < 1 ||
    selected.maxTimeoutSeconds > X402_MAX_TIMEOUT_SECONDS
  ) {
    reject("INVALID_MAX_TIMEOUT_SECONDS");
  }
  if (!isRecord(selected.extra)) reject("INVALID_PAYMENT_EXTRA");
  rejectUnknownKeys(selected.extra, EXTRA_KEYS, "UNSUPPORTED_PAYMENT_CONTROL");
  if (selected.extra.areFeesSponsored !== false) reject("FEES_SPONSORED_UNSUPPORTED");
  if (
    selected.extra.assetTransferMethod !== undefined &&
    selected.extra.assetTransferMethod !== "sequence"
  ) {
    reject("ASSET_TRANSFER_METHOD_UNSUPPORTED");
  }
  if (selected.extra.issuer !== options.expectedAsset.issuer) reject("ISSUER_MISMATCH");
  const selectedInvoiceId = invoiceId(selected.extra.invoiceId);
  const sourceTag = selected.extra.sourceTag === undefined
    ? undefined
    : uint32(selected.extra.sourceTag, "INVALID_SOURCE_TAG");
  if (expectedSourceTag !== undefined && sourceTag !== expectedSourceTag) {
    reject("SOURCE_TAG_MISMATCH");
  }
  const destinationTag = selected.extra.destinationTag === undefined
    ? undefined
    : uint32(selected.extra.destinationTag, "INVALID_DESTINATION_TAG");

  const extra: Ap4mX402Requirement["extra"] = {
    areFeesSponsored: false,
    assetTransferMethod: "sequence",
    invoiceId: selectedInvoiceId,
    issuer: options.expectedAsset.issuer,
    ...(sourceTag === undefined ? {} : { sourceTag }),
    ...(destinationTag === undefined ? {} : { destinationTag }),
  };
  const accepted: Ap4mX402Requirement = {
    scheme: "exact",
    network: "xrpl:1",
    asset: expectedCurrency,
    payTo: selected.payTo as string,
    amount: selected.amount as string,
    maxTimeoutSeconds: selected.maxTimeoutSeconds,
    extra,
  };
  return {
    x402Version: 2,
    resource,
    scheme: "exact",
    network: "xrpl:1",
    currency: expectedCurrency,
    issuer: options.expectedAsset.issuer,
    payTo: accepted.payTo,
    amount: accepted.amount,
    maxTimeoutSeconds: accepted.maxTimeoutSeconds,
    invoiceId: selectedInvoiceId,
    ...(sourceTag === undefined ? {} : { sourceTag }),
    ...(destinationTag === undefined ? {} : { destinationTag }),
    accepted,
  };
}

export function encodeAp4mT54PaymentSignature(input: Readonly<{
  challenge: ValidatedAp4mX402Challenge;
  signedTxBlob: string;
}>): string {
  if (
    typeof input.signedTxBlob !== "string" ||
    input.signedTxBlob.length === 0 ||
    input.signedTxBlob.length > SIGNED_BLOB_MAX_HEX_CHARS ||
    input.signedTxBlob.length % 2 !== 0 ||
    !HEX.test(input.signedTxBlob)
  ) {
    reject("INVALID_SIGNED_TX_BLOB");
  }
  const encoded = base64(
    encoder.encode(
      JSON.stringify({
        x402Version: 2,
        resource: input.challenge.resource,
        accepted: input.challenge.accepted,
        payload: { signedTxBlob: input.signedTxBlob },
      }),
    ),
  );
  if (encoded.length > X402_PAYMENT_REQUIRED_MAX_ENCODED_BYTES) {
    reject("PAYMENT_SIGNATURE_TOO_LARGE");
  }
  return encoded;
}

function boundedJson(value: unknown): Uint8Array {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 1_000 || current.depth > 16) reject("INVALID_MASTERCARD_INTENT");
    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "string") {
      if (byteLength(current.value) > 4_096) reject("INVALID_MASTERCARD_INTENT");
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) reject("INVALID_MASTERCARD_INTENT");
      continue;
    }
    if (typeof current.value !== "object" || current.value === null) {
      reject("INVALID_MASTERCARD_INTENT");
    }
    if (seen.has(current.value)) reject("INVALID_MASTERCARD_INTENT");
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      reject("INVALID_MASTERCARD_INTENT");
    }
    for (const [key, child] of Object.entries(current.value)) {
      if (byteLength(key) > 128) reject("INVALID_MASTERCARD_INTENT");
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    reject("INVALID_MASTERCARD_INTENT");
  }
  const bytes = encoder.encode(json);
  if (bytes.length === 0 || bytes.length > INTENT_MAX_DECODED_BYTES) {
    reject("MASTERCARD_INTENT_TOO_LARGE");
  }
  return bytes;
}

export function encodeMastercardIntentHeader(intent: unknown): string {
  const encoded = base64url(boundedJson(intent));
  if (
    encoded.length === 0 ||
    encoded.length > INTENT_MAX_ENCODED_BYTES ||
    !BASE64URL.test(encoded)
  ) {
    reject("MASTERCARD_INTENT_TOO_LARGE");
  }
  return encoded;
}

function canonicalPaymentSignature(value: string): void {
  if (
    value.length === 0 ||
    value.length > X402_PAYMENT_REQUIRED_MAX_ENCODED_BYTES ||
    value.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(value) ||
    value.includes(",")
  ) {
    reject("INVALID_PAYMENT_SIGNATURE");
  }
}

function originalHeaders(input: HeadersInit | undefined): Headers {
  if (input === undefined) return new Headers();
  if (Array.isArray(input)) {
    const seen = new Set<string>();
    for (const [name] of input) {
      const normalized = name.toLowerCase();
      if (seen.has(normalized)) reject("DUPLICATE_REQUEST_HEADER");
      seen.add(normalized);
    }
  }
  return new Headers(input);
}

/** Build only retry headers; the caller retains the original URL, method and body. */
export function buildAp4mRetryHeaders(
  original: HeadersInit | undefined,
  input: Readonly<{
    paymentSignature: string;
    mastercardIntent: unknown;
    viL1: string;
    viL2: string;
    viL3b: string;
  }>,
): Headers {
  canonicalPaymentSignature(input.paymentSignature);
  for (const [value, code] of [
    [input.viL1, "INVALID_VI_L1"],
    [input.viL2, "INVALID_VI_L2"],
    [input.viL3b, "INVALID_VI_L3B"],
  ] as const) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      byteLength(value) > VI_L3B_MAX_BYTES ||
      !COMPACT_SD_JWT.test(value) ||
      /[\r\n]/.test(value)
    ) {
      reject(code);
    }
  }
  const headers = originalHeaders(original);
  for (const name of [
    AP4M_PAYMENT_SIGNATURE_HEADER,
    AP4M_MASTERCARD_INTENT_HEADER,
    AP4M_VI_L1_HEADER,
    AP4M_VI_L2_HEADER,
    AP4M_VI_L3B_HEADER,
  ]) {
    if (headers.has(name)) reject("RESERVED_HEADER_PRESENT");
  }
  headers.set(AP4M_PAYMENT_SIGNATURE_HEADER, input.paymentSignature);
  headers.set(
    AP4M_MASTERCARD_INTENT_HEADER,
    encodeMastercardIntentHeader(input.mastercardIntent),
  );
  headers.set(AP4M_VI_L1_HEADER, input.viL1);
  headers.set(AP4M_VI_L2_HEADER, input.viL2);
  headers.set(AP4M_VI_L3B_HEADER, input.viL3b);
  return headers;
}
