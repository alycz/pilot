import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import {
  Near1ClickQuoteHashSchema,
  NearAccountIdSchema,
  NearArbitrumUsdcToWnearExecutableQuoteBindingSchema,
  NearArbitrumUsdcToWnearRouteSchema,
  NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
  NearNativeNearToArbitrumUsdcRouteSchema,
  NearPrincipalAuthorizationSchema,
  type NearArbitrumUsdcToWnearExecutableQuoteBinding,
  type NearNativeNearToArbitrumUsdcExecutableQuoteBinding,
  type NearPrincipalAuthorization,
} from "@pilot/contracts/near";
import { z } from "zod";

import { digestNearExecutableReviewQuote } from "./near-executable-review-proof";
import {
  readNearPrincipalAuthorization,
  type NearWalletProofEnvironment,
} from "./near-wallet-proof";
import { readCookie } from "./openrouter-session";

export const NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE =
  "__Host-pilot-near-executable-review-quote";

export const NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: 5 * 60,
};

const VERSION = "pilot-near-executable-review-quote-attestation-v1" as const;
const DOMAIN = "pilot.near.executable-review.quote-attestation.v1" as const;
const OPERATION = "near.intents.executable-quote.review" as const;
const MAX_TTL_MS = 5 * 60_000;
const AAD = Buffer.from(DOMAIN, "utf8");
const LowerHexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const EvmAddressSchema = z.string().regex(/^0x[0-9A-Fa-f]{40}$/);
const RouteSchema = z.union([
  NearArbitrumUsdcToWnearRouteSchema,
  NearNativeNearToArbitrumUsdcRouteSchema,
]);
const QuoteBindingSchema = z.union([
  NearArbitrumUsdcToWnearExecutableQuoteBindingSchema,
  NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
]);
type QuoteBinding =
  | NearArbitrumUsdcToWnearExecutableQuoteBinding
  | NearNativeNearToArbitrumUsdcExecutableQuoteBinding;

const AttestedQuoteSummaryBaseSchema = z.object({
  provider_signature_verified: z.literal(true),
  quote_digest: LowerHexDigestSchema,
  quote_hash: Near1ClickQuoteHashSchema,
  correlation_id: z.string().min(1).max(128),
  origin_asset_id: z.string().min(1).max(320),
  destination_asset_id: z.string().min(1).max(320),
  amount_in: z.string().regex(/^[1-9]\d*$/),
  min_amount_out: z.string().regex(/^[1-9]\d*$/),
  slippage_bps: z.number().int().min(0).max(1_000),
  deposit_memo_present: z.literal(false),
  provider_deadline_at: z.string().datetime({ offset: true }),
  provider_time_when_inactive_at: z.string().datetime({ offset: true }),
  approval_expires_at: z.string().datetime({ offset: true }),
});
const AttestedQuoteSummarySchema = z.discriminatedUnion("quote_version", [
  AttestedQuoteSummaryBaseSchema.extend({
    quote_version: z.literal("pilot-near-arbitrum-usdc-to-wnear-quote-binding-v1"),
    route: NearArbitrumUsdcToWnearRouteSchema,
    recipient: NearAccountIdSchema,
    refund_to: EvmAddressSchema,
    deposit_address: EvmAddressSchema,
  }).strict(),
  AttestedQuoteSummaryBaseSchema.extend({
    quote_version: z.literal("pilot-near-native-to-arbitrum-usdc-quote-binding-v1"),
    route: NearNativeNearToArbitrumUsdcRouteSchema,
    recipient: EvmAddressSchema,
    refund_to: NearAccountIdSchema,
    deposit_address: NearAccountIdSchema,
  }).strict(),
]);

const AttestationSchema = z.object({
  version: z.literal(VERSION),
  domain: z.literal(DOMAIN),
  operation: z.literal(OPERATION),
  authorization: NearPrincipalAuthorizationSchema,
  quote: AttestedQuoteSummarySchema,
  issued_at_ms: z.number().int().safe().nonnegative(),
  expires_at_ms: z.number().int().safe().positive(),
}).strict().superRefine((attestation, context) => {
  if (
    attestation.expires_at_ms <= attestation.issued_at_ms ||
    attestation.expires_at_ms - attestation.issued_at_ms > MAX_TTL_MS
  ) {
    context.addIssue({
      code: "custom",
      path: ["expires_at_ms"],
      message: "quote attestation expiry is outside the supported window",
    });
  }
});

export type NearExecutableReviewQuoteAttestation = z.infer<
  typeof AttestationSchema
>;

const LiveResultEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    source: z.literal("live"),
    provider_signature_verified: z.literal(true),
    route: RouteSchema,
    quote_hash: Near1ClickQuoteHashSchema,
    quote_binding: QuoteBindingSchema,
  }).passthrough(),
}).passthrough();

function secret(environment: NearWalletProofEnvironment): string {
  const value = environment.SESSION_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new Error("NEAR executable-review quote attestation is unavailable.");
  }
  return value;
}

function key(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function seal(value: NearExecutableReviewQuoteAttestation, valueSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(valueSecret), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function open(value: string | undefined, valueSecret: string): unknown {
  if (!value) return undefined;
  try {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] =
      value.split(".");
    if (version !== "v1" || extra !== undefined) return undefined;
    const iv = Buffer.from(encodedIv, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      return undefined;
    }
    const decipher = createDecipheriv("aes-256-gcm", key(valueSecret), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => `${JSON.stringify(name)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function summary(
  quote: QuoteBinding,
) {
  return AttestedQuoteSummarySchema.parse({
    provider_signature_verified: quote.provider_signature_verified,
    quote_version: quote.version,
    quote_digest: digestNearExecutableReviewQuote(quote),
    quote_hash: quote.quote_hash,
    correlation_id: quote.correlation_id,
    route: quote.route,
    origin_asset_id: quote.request_echo.originAsset,
    destination_asset_id: quote.request_echo.destinationAsset,
    amount_in: quote.amount_in,
    min_amount_out: quote.min_amount_out,
    slippage_bps: quote.request_echo.slippageTolerance,
    recipient: quote.recipient,
    refund_to: quote.refund_to,
    deposit_address: quote.deposit_address,
    deposit_memo_present: quote.deposit_memo_present,
    provider_deadline_at: quote.provider_deadline_at,
    provider_time_when_inactive_at: quote.provider_time_when_inactive_at,
    approval_expires_at: quote.approval_expires_at,
  });
}

function exactRequestBinding(
  args: Record<string, unknown>,
  quote: QuoteBinding,
): boolean {
  const expectedRoute = quote.version ===
      "pilot-near-native-to-arbitrum-usdc-quote-binding-v1"
    ? "near-native-to-arbitrum-usdc-v1"
    : "arbitrum-usdc-to-near-wnear-v1";
  return args.route === expectedRoute &&
    args.amount_atomic === quote.amount_in &&
    args.slippage_bps === quote.request_echo.slippageTolerance &&
    args.recipient === quote.recipient &&
    typeof args.refund_to === "string" &&
    args.refund_to.toLowerCase() === quote.refund_to.toLowerCase() &&
    args.refund_deadline === quote.request_echo.deadline &&
    (args.quote_waiting_time_ms ?? 0) === quote.request_echo.quoteWaitingTimeMs;
}

function cookieHeader(value: string, maxAgeSeconds: number): string {
  return `${NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE}=${
    encodeURIComponent(value)
  }; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

/** Mint only from the authenticated server-to-Harbor response boundary. */
export function nearExecutableReviewAttestationResponseHeaders(
  request: Request,
  op: string,
  args: Record<string, unknown>,
  body: ArrayBuffer,
  status: number,
  options: Readonly<{
    environment?: NearWalletProofEnvironment;
    now?: number;
  }> = {},
): Record<string, string> {
  if (
    op !== OPERATION || status < 200 || status >= 300 || body.byteLength === 0
  ) return {};
  const environment = options.environment ?? process.env;
  const now = options.now ?? Date.now();
  try {
    const authorization = readNearPrincipalAuthorization(request, {
      environment,
      now,
    });
    const requestNearAccount = args.route === "near-native-to-arbitrum-usdc-v1"
      ? args.refund_to
      : args.recipient;
    if (
      !authorization || authorization.network !== "near:mainnet" ||
      !authorization.operations.includes(OPERATION) ||
      authorization.account_id !== requestNearAccount
    ) return {};
    const envelope = LiveResultEnvelopeSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    );
    if (!envelope.success) return {};
    const data = envelope.data.data;
    const quote = data.quote_binding;
    const quoteNearAccount = quote.version ===
        "pilot-near-native-to-arbitrum-usdc-quote-binding-v1"
      ? quote.refund_to
      : quote.recipient;
    if (
      data.quote_hash !== quote.quote_hash ||
      canonicalJson(data.route) !== canonicalJson(quote.route) ||
      quoteNearAccount !== authorization.account_id ||
      !exactRequestBinding(args, quote)
    ) return {};
    const expiresAt = Math.min(
      now + MAX_TTL_MS,
      Date.parse(authorization.expires_at),
      Date.parse(quote.approval_expires_at),
      Date.parse(quote.provider_time_when_inactive_at),
      Date.parse(quote.provider_deadline_at),
    );
    if (expiresAt <= now) return {};
    const attestation = AttestationSchema.parse({
      version: VERSION,
      domain: DOMAIN,
      operation: OPERATION,
      authorization,
      quote: summary(quote),
      issued_at_ms: now,
      expires_at_ms: expiresAt,
    });
    return {
      "set-cookie": cookieHeader(
        seal(attestation, secret(environment)),
        Math.max(1, Math.ceil((expiresAt - now) / 1_000)),
      ),
    };
  } catch {
    return {};
  }
}

export function readNearExecutableReviewQuoteAttestation(
  request: Request,
  input: Readonly<{
    authorization: NearPrincipalAuthorization;
    quoteBinding: unknown;
    environment?: NearWalletProofEnvironment;
    now?: number;
  }>,
): NearExecutableReviewQuoteAttestation | null {
  const environment = input.environment ?? process.env;
  const now = input.now ?? Date.now();
  const parsed = AttestationSchema.safeParse(open(
    readCookie(request, NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE),
    secret(environment),
  ));
  const quote = QuoteBindingSchema.safeParse(
    input.quoteBinding,
  );
  if (
    !parsed.success || !quote.success ||
    !Number.isSafeInteger(now) || now < 0 ||
    parsed.data.expires_at_ms <= now ||
    parsed.data.authorization.authorization_id !== input.authorization.authorization_id ||
    parsed.data.authorization.principal_id !== input.authorization.principal_id ||
    parsed.data.authorization.account_id !== input.authorization.account_id ||
    parsed.data.authorization.network !== input.authorization.network ||
    canonicalJson(parsed.data.authorization) !== canonicalJson(input.authorization) ||
    parsed.data.quote.quote_digest !== digestNearExecutableReviewQuote(quote.data) ||
    canonicalJson(parsed.data.quote) !== canonicalJson(summary(quote.data))
  ) return null;
  return parsed.data;
}
