import { isValidClassicAddress } from "xrpl";

export const X402_PAYMENT_REQUIRED_MAX_ENCODED_BYTES = 24 * 1024;
export const X402_PAYMENT_REQUIRED_MAX_DECODED_BYTES = 16 * 1024;
export const X402_INVOICE_ID_MAX_BYTES = 200;
export const X402_MAX_TIMEOUT_SECONDS = 600;

const UINT32_MAX = 0xffff_ffff;
const JAVASCRIPT_SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const SQLITE_INTEGER_MAX = 9_223_372_036_854_775_807n;
const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;
const CANONICAL_NONNEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/;
const MAX_CANONICAL_DROPS_DIGITS = 16;
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const ACCEPT_KEYS = new Set([
  "scheme",
  "network",
  "asset",
  "payTo",
  "amount",
  "maxTimeoutSeconds",
  "extra",
]);
const EXTRA_KEYS = new Set(["invoiceId", "sourceTag", "destinationTag"]);
const WRAPPER_KEYS = new Set([
  "x402Version",
  "error",
  "resource",
  "accepts",
  "extensions",
]);
const RESOURCE_KEYS = new Set([
  "url",
  "description",
  "mimeType",
  "serviceName",
  "tags",
  "iconUrl",
]);
const RESOURCE_URL_MAX_BYTES = 2_048;
const RESOURCE_TEXT_MAX_BYTES = X402_PAYMENT_REQUIRED_MAX_DECODED_BYTES;
const RESOURCE_TAGS_MAX_ITEMS = X402_PAYMENT_REQUIRED_MAX_DECODED_BYTES;
const RESOURCE_ICON_URL_MAX_BYTES = 2_048;

export type ValidateX402ChallengeOptions = {
  requestUrl: string;
  maxPriceDrops: string;
  policyPerCallDrops: string;
  network: "testnet";
  expectedSourceTag: number;
};

export type X402ResourceInfo = {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
};

export type ValidatedX402Challenge = {
  x402Version: 2;
  resource: X402ResourceInfo;
  scheme: "exact";
  network: "xrpl:1";
  asset: "XRP";
  payTo: string;
  amountDrops: string;
  maxTimeoutSeconds: number;
  invoiceId: string;
  sourceTag: number;
  destinationTag?: number;
};

export class X402ChallengeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "X402ChallengeError";
  }
}

function reject(code: string): never {
  throw new X402ChallengeError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodePaymentRequired(header: string): unknown {
  if (header.length > X402_PAYMENT_REQUIRED_MAX_ENCODED_BYTES) {
    reject("PAYMENT_REQUIRED_TOO_LARGE");
  }
  if (
    header.length === 0 ||
    header.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(header)
  ) {
    reject("INVALID_PAYMENT_REQUIRED_ENCODING");
  }

  // Reject oversized input before allocating its decoded representation.
  const padding = header.endsWith("==") ? 2 : header.endsWith("=") ? 1 : 0;
  const calculatedBytes = (header.length / 4) * 3 - padding;
  if (calculatedBytes > X402_PAYMENT_REQUIRED_MAX_DECODED_BYTES) {
    reject("PAYMENT_REQUIRED_TOO_LARGE");
  }

  let binary: string;
  try {
    binary = atob(header);
  } catch {
    reject("INVALID_PAYMENT_REQUIRED_ENCODING");
  }
  if (
    binary.length !== calculatedBytes ||
    binary.length > X402_PAYMENT_REQUIRED_MAX_DECODED_BYTES ||
    btoa(binary) !== header
  ) {
    reject("INVALID_PAYMENT_REQUIRED_ENCODING");
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
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

function parseBound(value: unknown, name: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > MAX_CANONICAL_DROPS_DIGITS ||
    !CANONICAL_NONNEGATIVE_INTEGER.test(value)
  ) {
    reject(`INVALID_${name}`);
  }
  const parsed = BigInt(value);
  if (parsed > JAVASCRIPT_SAFE_INTEGER_MAX || parsed > SQLITE_INTEGER_MAX) {
    reject(`INVALID_${name}`);
  }
  return parsed;
}

function requireUInt32(value: unknown, code: string): number {
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

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    reject(code);
  }
}

function optionalBoundedString(
  value: unknown,
  maxBytes: number,
  code: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    byteLength(value) > maxBytes
  ) {
    reject(code);
  }
  return value;
}

/** Validate and preserve the complete x402 v2 ResourceInfo allowlist. */
export function validateX402ResourceInfo(
  value: unknown,
  requestUrl: string,
): X402ResourceInfo {
  if (!isRecord(value)) reject("INVALID_RESOURCE");
  rejectUnknownKeys(value, RESOURCE_KEYS, "UNSUPPORTED_RESOURCE_CONTROL");
  if (
    typeof value.url !== "string" ||
    value.url !== requestUrl ||
    byteLength(value.url) > RESOURCE_URL_MAX_BYTES
  ) {
    reject("RESOURCE_URL_MISMATCH");
  }

  const resource: X402ResourceInfo = { url: value.url };
  const description = optionalBoundedString(
    value.description,
    RESOURCE_TEXT_MAX_BYTES,
    "INVALID_RESOURCE_DESCRIPTION",
  );
  if (description !== undefined) resource.description = description;
  const mimeType = optionalBoundedString(
    value.mimeType,
    RESOURCE_TEXT_MAX_BYTES,
    "INVALID_RESOURCE_MIME_TYPE",
  );
  if (mimeType !== undefined) resource.mimeType = mimeType;
  const serviceName = optionalBoundedString(
    value.serviceName,
    RESOURCE_TEXT_MAX_BYTES,
    "INVALID_RESOURCE_SERVICE_NAME",
  );
  if (serviceName !== undefined) resource.serviceName = serviceName;

  if (value.tags !== undefined) {
    if (
      !Array.isArray(value.tags) ||
      value.tags.length > RESOURCE_TAGS_MAX_ITEMS ||
      value.tags.some(
        (tag) =>
          typeof tag !== "string" ||
          byteLength(tag) > RESOURCE_TEXT_MAX_BYTES,
      )
    ) {
      reject("INVALID_RESOURCE_TAGS");
    }
    resource.tags = [...value.tags] as string[];
  }

  const iconUrl = optionalBoundedString(
    value.iconUrl,
    RESOURCE_ICON_URL_MAX_BYTES,
    "INVALID_RESOURCE_ICON_URL",
  );
  if (iconUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(iconUrl);
    } catch {
      reject("INVALID_RESOURCE_ICON_URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      reject("INVALID_RESOURCE_ICON_URL");
    }
    resource.iconUrl = iconUrl;
  }
  return resource;
}

/**
 * Decode and validate an x402 v2 PAYMENT-REQUIRED header for Harbor's narrow
 * XRPL Testnet/XRP/exact payment path. This function performs no I/O.
 */
export function validateX402Challenge(
  header: string,
  options: ValidateX402ChallengeOptions,
): ValidatedX402Challenge {
  if (typeof header !== "string") {
    reject("INVALID_PAYMENT_REQUIRED_ENCODING");
  }
  if (typeof options.requestUrl !== "string" || options.requestUrl.length === 0) {
    reject("INVALID_REQUEST_URL");
  }
  if (options.network !== "testnet") {
    reject("UNSUPPORTED_NETWORK");
  }
  const expectedSourceTag = requireUInt32(
    options.expectedSourceTag,
    "INVALID_EXPECTED_SOURCE_TAG",
  );
  const maxPriceDrops = parseBound(options.maxPriceDrops, "MAX_PRICE_DROPS");
  const policyPerCallDrops = parseBound(
    options.policyPerCallDrops,
    "POLICY_PER_CALL_DROPS",
  );

  const decoded = decodePaymentRequired(header);
  if (!isRecord(decoded)) {
    reject("INVALID_PAYMENT_REQUIRED_WRAPPER");
  }
  if (decoded.x402Version !== 2) {
    reject("UNSUPPORTED_X402_VERSION");
  }
  rejectUnknownKeys(decoded, WRAPPER_KEYS, "UNSUPPORTED_PAYMENT_CONTROL");
  if (
    (decoded.error !== undefined && typeof decoded.error !== "string") ||
    (decoded.extensions !== undefined &&
      (!isRecord(decoded.extensions) || Object.keys(decoded.extensions).length > 0))
  ) {
    reject("UNSUPPORTED_PAYMENT_CONTROL");
  }
  const resource = validateX402ResourceInfo(decoded.resource, options.requestUrl);
  if (!Array.isArray(decoded.accepts)) {
    reject("INVALID_ACCEPTS");
  }
  if (decoded.accepts.some((entry) => !isRecord(entry))) {
    reject("INVALID_ACCEPTS");
  }

  const compatible = decoded.accepts.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) &&
      entry.scheme === "exact" &&
      entry.network === "xrpl:1" &&
      entry.asset === "XRP",
  );
  if (compatible.length !== 1) {
    reject(
      compatible.length === 0
        ? "NO_COMPATIBLE_PAYMENT_REQUIREMENT"
        : "AMBIGUOUS_PAYMENT_REQUIREMENTS",
    );
  }

  const selected = compatible[0];
  rejectUnknownKeys(selected, ACCEPT_KEYS, "UNSUPPORTED_PAYMENT_CONTROL");

  if (
    typeof selected.payTo !== "string" ||
    !isValidClassicAddress(selected.payTo)
  ) {
    reject("INVALID_PAY_TO");
  }
  if (
    typeof selected.amount !== "string" ||
    selected.amount.length > MAX_CANONICAL_DROPS_DIGITS ||
    !CANONICAL_POSITIVE_INTEGER.test(selected.amount)
  ) {
    reject("INVALID_AMOUNT");
  }
  const amount = BigInt(selected.amount);
  if (amount > JAVASCRIPT_SAFE_INTEGER_MAX || amount > SQLITE_INTEGER_MAX) {
    reject("AMOUNT_OUT_OF_RANGE");
  }
  if (amount > maxPriceDrops) {
    reject("MAX_PRICE_EXCEEDED");
  }
  if (amount > policyPerCallDrops) {
    reject("POLICY_PER_CALL_EXCEEDED");
  }

  if (
    typeof selected.maxTimeoutSeconds !== "number" ||
    !Number.isInteger(selected.maxTimeoutSeconds) ||
    selected.maxTimeoutSeconds < 1 ||
    selected.maxTimeoutSeconds > X402_MAX_TIMEOUT_SECONDS
  ) {
    reject("INVALID_MAX_TIMEOUT_SECONDS");
  }
  if (!isRecord(selected.extra)) {
    reject("INVALID_PAYMENT_EXTRA");
  }
  rejectUnknownKeys(selected.extra, EXTRA_KEYS, "UNSUPPORTED_PAYMENT_CONTROL");

  const invoiceId = selected.extra.invoiceId;
  if (
    typeof invoiceId !== "string" ||
    invoiceId.trim().length === 0 ||
    byteLength(invoiceId) > X402_INVOICE_ID_MAX_BYTES
  ) {
    reject("INVALID_INVOICE_ID");
  }
  const sourceTag = requireUInt32(
    selected.extra.sourceTag,
    "INVALID_SOURCE_TAG",
  );
  if (sourceTag !== expectedSourceTag) {
    reject("SOURCE_TAG_MISMATCH");
  }

  const base = {
    x402Version: 2 as const,
    resource,
    scheme: "exact" as const,
    network: "xrpl:1" as const,
    asset: "XRP" as const,
    payTo: selected.payTo,
    amountDrops: selected.amount,
    maxTimeoutSeconds: selected.maxTimeoutSeconds,
    invoiceId,
    sourceTag,
  };
  if (selected.extra.destinationTag === undefined) {
    return base;
  }
  return {
    ...base,
    destinationTag: requireUInt32(
      selected.extra.destinationTag,
      "INVALID_DESTINATION_TAG",
    ),
  };
}
