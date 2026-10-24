import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

export const HERMES_CONSENT_COOKIE = "__Host-pilot-hermes-consent";
export const HERMES_CONSENT_DATA_POLICY = "bounded-redacted-proposals" as const;

export const HERMES_CONSENT_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
};

export type HermesConsentNetwork = "testnet" | "devnet" | "lending-devnet";

export type HermesConsentScope = {
  tenantId: string;
  owner: string;
  network: HermesConsentNetwork;
};

export type HermesConsentDisclosure = {
  provider: string;
  model: string;
  dataPolicy: typeof HERMES_CONSENT_DATA_POLICY;
  retentionDays: number;
  termsVersion: string;
};

export type HermesConsentRecord = {
  version: 1;
  epoch: number;
  scopeDigest: string;
  disclosureDigest: string;
  issuedAt: number;
  expiresAt: number;
};

declare const VALIDATED_HERMES_CONSENT: unique symbol;
export type ValidatedHermesConsentRecord = HermesConsentRecord & Readonly<{
  readonly [VALIDATED_HERMES_CONSENT]: true;
}>;

type ConsentBinding = Readonly<{
  disclosure: string;
  scope: string;
}>;

const validatedConsentRecords = new WeakMap<object, ConsentBinding>();

/** Rebind a branded record to the exact separately supplied server authority. */
export function isValidatedHermesConsentRecordFor(
  value: unknown,
  scope: HermesConsentScope,
  disclosure: HermesConsentDisclosure,
): value is ValidatedHermesConsentRecord {
  assertScope(scope);
  assertDisclosure(disclosure);
  if (typeof value !== "object" || value === null) return false;
  const binding = validatedConsentRecords.get(value);
  return binding?.scope === canonicalScope(scope) &&
    binding.disclosure === canonicalDisclosure(disclosure);
}

export type IssueHermesConsentOptions = {
  secret: string;
  epoch?: number;
  now?: number;
  maxAgeSeconds?: number;
};

export type ReadHermesConsentOptions = {
  secret: string;
  expectedEpoch?: number;
  now?: number;
};

export type IssuedHermesConsent = {
  value: string;
  setCookie: string;
  expiresAt: number;
};

const CONSENT_VERSION = 1 as const;
const TOKEN_PREFIX = "v1";
const SIGNING_DOMAIN = "pilot.hermes.consent.v1";
const MAX_CONSENT_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_COOKIE_HEADER_LENGTH = 4096;
const MAX_PAYLOAD_SEGMENT_LENGTH = 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const XRP_BASE58_ALPHABET =
  "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
const NETWORKS = new Set<HermesConsentNetwork>([
  "testnet",
  "devnet",
  "lending-devnet",
]);
const PAYLOAD_KEYS = [
  "disclosureDigest",
  "epoch",
  "expiresAt",
  "issuedAt",
  "scopeDigest",
  "version",
] as const;
const SCOPE_KEYS = ["network", "owner", "tenantId"] as const;
const DISCLOSURE_KEYS = [
  "dataPolicy",
  "model",
  "provider",
  "retentionDays",
  "termsVersion",
] as const;

export function issueHermesConsentCookie(
  scope: HermesConsentScope,
  disclosure: HermesConsentDisclosure,
  options: IssueHermesConsentOptions,
): IssuedHermesConsent {
  assertConsentSecret(options.secret);
  assertScope(scope);
  assertDisclosure(disclosure);

  const nowSeconds = toEpochSeconds(options.now ?? Date.now());
  const epoch = options.epoch ?? 0;
  assertEpoch(epoch);
  const maxAgeSeconds =
    options.maxAgeSeconds ?? disclosure.retentionDays * 24 * 60 * 60;
  assertMaxAge(maxAgeSeconds);

  const record: HermesConsentRecord = {
    version: CONSENT_VERSION,
    epoch,
    scopeDigest: digestScope(scope, options.secret),
    disclosureDigest: digestDisclosure(disclosure, options.secret),
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + maxAgeSeconds,
  };
  const payload = Buffer.from(JSON.stringify(record), "utf8").toString(
    "base64url",
  );
  const signature = sign(payload, options.secret);
  const value = `${TOKEN_PREFIX}.${payload}.${signature}`;

  return {
    value,
    setCookie: serializeCookie(value, maxAgeSeconds),
    expiresAt: record.expiresAt,
  };
}

export function readHermesConsentCookie(
  cookieHeader: string | null | undefined,
  scope: HermesConsentScope,
  disclosure: HermesConsentDisclosure,
  options: ReadHermesConsentOptions,
): ValidatedHermesConsentRecord | null {
  assertConsentSecret(options.secret);
  assertScope(scope);
  assertDisclosure(disclosure);

  const value = readSingleCookie(cookieHeader, HERMES_CONSENT_COOKIE);
  if (!value) return null;

  const segments = value.split(".");
  if (
    segments.length !== 3 ||
    segments[0] !== TOKEN_PREFIX ||
    !segments[1] ||
    segments[1].length > MAX_PAYLOAD_SEGMENT_LENGTH ||
    !isCanonicalBase64url(segments[1]) ||
    !segments[2] ||
    !isCanonicalBase64url(segments[2])
  ) {
    return null;
  }

  const expectedSignature = Buffer.from(
    sign(segments[1], options.secret),
    "base64url",
  );
  const presentedSignature = Buffer.from(segments[2], "base64url");
  if (
    expectedSignature.length !== presentedSignature.length ||
    !timingSafeEqual(expectedSignature, presentedSignature)
  ) {
    return null;
  }

  const record = parseRecord(segments[1]);
  if (!record) return null;

  const nowSeconds = toEpochSeconds(options.now ?? Date.now());
  if (options.expectedEpoch !== undefined) {
    assertEpoch(options.expectedEpoch);
    if (record.epoch !== options.expectedEpoch) return null;
  }
  if (
    record.issuedAt > nowSeconds ||
    record.expiresAt <= nowSeconds ||
    record.expiresAt - record.issuedAt > MAX_CONSENT_AGE_SECONDS
  ) {
    return null;
  }
  if (record.scopeDigest !== digestScope(scope, options.secret)) return null;
  if (
    record.disclosureDigest !== digestDisclosure(disclosure, options.secret)
  ) {
    return null;
  }

  const validated = Object.freeze(record) as ValidatedHermesConsentRecord;
  validatedConsentRecords.set(validated, {
    scope: canonicalScope(scope),
    disclosure: canonicalDisclosure(disclosure),
  });
  return validated;
}

export function revokeHermesConsentCookie(): string {
  return `${HERMES_CONSENT_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function assertConsentSecret(secret: string): void {
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    /[\0\r\n]/.test(secret)
  ) {
    throw new Error(
      "HERMES consent secret must be a separate value of at least 32 characters.",
    );
  }
}

function assertScope(scope: HermesConsentScope): void {
  if (!isPlainRecord(scope) || !hasExactKeys(scope, SCOPE_KEYS)) {
    throw new Error("Hermes consent scope has an invalid shape.");
  }
  if (!isSafeIdentifier(scope.tenantId, 64)) {
    throw new Error("A valid Hermes tenant ID is required.");
  }
  if (!isValidXrplClassicAddress(scope.owner)) {
    throw new Error("A valid XRPL classic owner address is required.");
  }
  if (!NETWORKS.has(scope.network)) {
    throw new Error("Hermes consent is restricted to approved non-mainnet networks.");
  }
}

function isValidXrplClassicAddress(value: string): boolean {
  if (typeof value !== "string" || value.length < 25 || value.length > 35) {
    return false;
  }

  let numericValue = 0n;
  for (const character of value) {
    const digit = XRP_BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return false;
    numericValue = numericValue * 58n + BigInt(digit);
  }

  let encoded = numericValue.toString(16);
  if (encoded.length % 2 !== 0) encoded = `0${encoded}`;
  let decoded = numericValue === 0n ? Buffer.alloc(0) : Buffer.from(encoded, "hex");
  const leadingZeroes = value.match(/^r+/)?.[0].length ?? 0;
  if (leadingZeroes > 0) {
    decoded = Buffer.concat([Buffer.alloc(leadingZeroes), decoded]);
  }
  if (decoded.length !== 25 || decoded[0] !== 0) return false;

  const body = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const expectedChecksum = createHash("sha256")
    .update(createHash("sha256").update(body).digest())
    .digest()
    .subarray(0, 4);
  return timingSafeEqual(checksum, expectedChecksum);
}

function assertDisclosure(disclosure: HermesConsentDisclosure): void {
  if (!isPlainRecord(disclosure) || !hasExactKeys(disclosure, DISCLOSURE_KEYS)) {
    throw new Error("Hermes consent disclosure has an invalid shape.");
  }
  if (!isSafeIdentifier(disclosure.provider, 64)) {
    throw new Error("A valid Hermes provider identifier is required.");
  }
  if (
    typeof disclosure.model !== "string" ||
    disclosure.model.length > 128 ||
    !SAFE_MODEL.test(disclosure.model)
  ) {
    throw new Error("A valid Hermes model identifier is required.");
  }
  if (disclosure.dataPolicy !== HERMES_CONSENT_DATA_POLICY) {
    throw new Error("The bounded redacted proposal data policy is required.");
  }
  if (
    !Number.isInteger(disclosure.retentionDays) ||
    disclosure.retentionDays < 1 ||
    disclosure.retentionDays > 30
  ) {
    throw new Error("Hermes retention must be an integer from 1 to 30 days.");
  }
  if (!isSafeIdentifier(disclosure.termsVersion, 64)) {
    throw new Error("A valid Hermes terms version is required.");
  }
}

function isSafeIdentifier(value: string, maxLength: number): boolean {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    SAFE_ID.test(value)
  );
}

function assertMaxAge(maxAgeSeconds: number): void {
  if (
    !Number.isInteger(maxAgeSeconds) ||
    maxAgeSeconds < 1 ||
    maxAgeSeconds > MAX_CONSENT_AGE_SECONDS
  ) {
    throw new Error("Hermes consent lifetime must be between 1 second and 30 days.");
  }
}

function assertEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("Hermes consent epoch must be a non-negative safe integer.");
  }
}

function toEpochSeconds(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Hermes consent time must be a non-negative epoch millisecond value.");
  }
  return Math.floor(now / 1000);
}

function digestScope(scope: HermesConsentScope, secret: string): string {
  return bindingDigest(
    "scope",
    canonicalScope(scope),
    secret,
  );
}

function digestDisclosure(
  disclosure: HermesConsentDisclosure,
  secret: string,
): string {
  return bindingDigest(
    "disclosure",
    canonicalDisclosure(disclosure),
    secret,
  );
}

export function hermesConsentScopeDigest(
  scope: HermesConsentScope,
  secret: string,
): string {
  assertConsentSecret(secret);
  assertScope(scope);
  return digestScope(scope, secret);
}

function canonicalScope(scope: HermesConsentScope): string {
  return JSON.stringify({
    tenantId: scope.tenantId,
    owner: scope.owner,
    network: scope.network,
  });
}

function canonicalDisclosure(disclosure: HermesConsentDisclosure): string {
  return JSON.stringify({
    provider: disclosure.provider,
    model: disclosure.model,
    dataPolicy: disclosure.dataPolicy,
    retentionDays: disclosure.retentionDays,
    termsVersion: disclosure.termsVersion,
  });
}

function bindingDigest(domain: string, value: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${SIGNING_DOMAIN}.${domain}.${value}`, "utf8")
    .digest("hex");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${SIGNING_DOMAIN}.${payload}`, "utf8")
    .digest("base64url");
}

function parseRecord(payload: string): HermesConsentRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;

  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    !PAYLOAD_KEYS.every((key, index) => keys[index] === key)
  ) {
    return null;
  }
  if (
    parsed.version !== CONSENT_VERSION ||
    !Number.isSafeInteger(parsed.epoch) ||
    (parsed.epoch as number) < 0 ||
    typeof parsed.scopeDigest !== "string" ||
    !SHA256_HEX.test(parsed.scopeDigest) ||
    typeof parsed.disclosureDigest !== "string" ||
    !SHA256_HEX.test(parsed.disclosureDigest) ||
    !Number.isSafeInteger(parsed.issuedAt) ||
    !Number.isSafeInteger(parsed.expiresAt) ||
    (parsed.issuedAt as number) < 0 ||
    (parsed.expiresAt as number) <= (parsed.issuedAt as number)
  ) {
    return null;
  }

  return parsed as HermesConsentRecord;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    expected.every((key, index) => keys[index] === key)
  );
}

function isCanonicalBase64url(value: string): boolean {
  if (!BASE64URL.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

function readSingleCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (!cookieHeader || cookieHeader.length > MAX_COOKIE_HEADER_LENGTH) return null;

  const matches: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      matches.push(decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      return null;
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function serializeCookie(value: string, maxAgeSeconds: number): string {
  return `${HERMES_CONSENT_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}
