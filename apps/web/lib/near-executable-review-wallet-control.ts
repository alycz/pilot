import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import {
  NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
  NearPrincipalAuthorizationSchema,
  type NearNativeNearToArbitrumUsdcExecutableQuoteBinding,
  type NearPrincipalAuthorization,
} from "@pilot/contracts/near";
import { z } from "zod";

import {
  digestNearExecutableReviewQuote,
  type VerifiedNearExecutableReviewWalletControl,
} from "./near-executable-review-proof";
import type { NearWalletProofEnvironment } from "./near-wallet-proof";
import { readCookie } from "./openrouter-session";

export const NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE =
  "__Host-pilot-near-executable-review-wallet-control";
export const NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_TTL_MS = 2 * 60_000;
export const NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_TTL_MS / 1_000,
};

const VERSION =
  "pilot-near-native-executable-review-wallet-control-attestation-v1" as const;
const DOMAIN =
  "pilot.near.native-executable-review.wallet-control-attestation.v1" as const;
const OPERATION = "near.intents.executable-quote.review" as const;
const AAD = Buffer.from(DOMAIN, "utf8");
const LowerHexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CanonicalNonceSchema = z.string().refine((value) => {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
});
const PublicKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/);

const WalletControlAttestationSchema = z.object({
  version: z.literal(VERSION),
  domain: z.literal(DOMAIN),
  operation: z.literal(OPERATION),
  authorization: NearPrincipalAuthorizationSchema,
  quote_binding: NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
  quote_digest: LowerHexDigestSchema,
  public_key: PublicKeySchema,
  provider: z.literal("nep413-full-access-key"),
  one_time_nonce: CanonicalNonceSchema,
  proof_verified_at: z.string().datetime({ offset: true }),
  proof_verified_at_ms: z.number().int().safe().nonnegative(),
  proof_expires_at: z.string().datetime({ offset: true }),
  proof_expires_at_ms: z.number().int().safe().positive(),
}).strict().superRefine((attestation, context) => {
  if (
    Date.parse(attestation.proof_verified_at) !== attestation.proof_verified_at_ms ||
    Date.parse(attestation.proof_expires_at) !== attestation.proof_expires_at_ms ||
    attestation.proof_expires_at_ms <= attestation.proof_verified_at_ms ||
    attestation.proof_expires_at_ms - attestation.proof_verified_at_ms >
      NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_TTL_MS
  ) {
    context.addIssue({
      code: "custom",
      path: ["proof_expires_at"],
      message: "wallet-control attestation expiry is outside the supported window",
    });
  }
});

export type NearExecutableReviewWalletControlAttestation = z.infer<
  typeof WalletControlAttestationSchema
>;

export type NearExecutableReviewWalletControlConsumption = Readonly<{
  version: "pilot-near-native-wallet-control-consumption-v1";
  principalId: string;
  accountId: string;
  network: "near:mainnet";
  authorizationId: string;
  quoteDigest: string;
  oneTimeNonce: string;
  expiresAt: number;
  now: number;
}>;

/** Durable implementations must atomically accept this sealed proof only once. */
export type NearExecutableReviewWalletControlConsumer = Readonly<{
  consume(
    input: NearExecutableReviewWalletControlConsumption,
  ): boolean | Promise<boolean>;
}>;

function environmentSecret(environment: NearWalletProofEnvironment): string {
  const value = environment.SESSION_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new Error("NEAR wallet-control attestation is unavailable.");
  }
  return value;
}

function key(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function seal(
  value: NearExecutableReviewWalletControlAttestation,
  valueSecret: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(valueSecret), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(deflateRawSync(Buffer.from(JSON.stringify(value), "utf8"))),
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
    if (
      iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0 ||
      ciphertext.length > 16_384
    ) {
      return undefined;
    }
    const decipher = createDecipheriv("aes-256-gcm", key(valueSecret), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = inflateRawSync(Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]), { maxOutputLength: 64 * 1_024 });
    return JSON.parse(plaintext.toString("utf8")) as unknown;
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

export function issueNearExecutableReviewWalletControlAttestation(input: Readonly<{
  verified: VerifiedNearExecutableReviewWalletControl;
  environment?: NearWalletProofEnvironment;
  now?: number;
  oneTimeNonce?: string;
}>): Readonly<{ cookie: string; expiresAt: number }> | null {
  if (
    input.verified.quote_binding.version !==
      "pilot-near-native-to-arbitrum-usdc-quote-binding-v1"
  ) return null;
  const environment = input.environment ?? process.env;
  const now = input.now ?? Date.now();
  const quote = input.verified.quote_binding;
  const expiresAt = Math.min(
    now + NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_TTL_MS,
    input.verified.challenge_expires_at,
    Date.parse(input.verified.authorization.expires_at),
    Date.parse(quote.approval_expires_at),
    Date.parse(quote.provider_time_when_inactive_at),
    Date.parse(quote.provider_deadline_at),
  );
  if (!Number.isSafeInteger(now) || now < 0 || expiresAt <= now) {
    throw new Error("NEAR wallet-control attestation is unavailable.");
  }
  const attestation = WalletControlAttestationSchema.parse({
    version: VERSION,
    domain: DOMAIN,
    operation: OPERATION,
    authorization: input.verified.authorization,
    quote_binding: quote,
    quote_digest: input.verified.quote_digest,
    public_key: input.verified.public_key,
    provider: input.verified.provider,
    one_time_nonce: input.oneTimeNonce ?? randomBytes(32).toString("base64url"),
    proof_verified_at: new Date(now).toISOString(),
    proof_verified_at_ms: now,
    proof_expires_at: new Date(expiresAt).toISOString(),
    proof_expires_at_ms: expiresAt,
  });
  return {
    cookie: seal(attestation, environmentSecret(environment)),
    expiresAt,
  };
}

export function readNearExecutableReviewWalletControlAttestation(
  request: Request,
  input: Readonly<{
    authorization: NearPrincipalAuthorization;
    quoteBinding: NearNativeNearToArbitrumUsdcExecutableQuoteBinding;
    environment?: NearWalletProofEnvironment;
    now?: number;
  }>,
): NearExecutableReviewWalletControlAttestation | null {
  const environment = input.environment ?? process.env;
  const now = input.now ?? Date.now();
  const parsed = WalletControlAttestationSchema.safeParse(open(
    readCookie(request, NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE),
    environmentSecret(environment),
  ));
  if (
    !parsed.success || !Number.isSafeInteger(now) || now < 0 ||
    parsed.data.proof_verified_at_ms > now ||
    parsed.data.proof_expires_at_ms <= now ||
    parsed.data.authorization.authorization_id !== input.authorization.authorization_id ||
    parsed.data.authorization.principal_id !== input.authorization.principal_id ||
    parsed.data.authorization.account_id !== input.authorization.account_id ||
    parsed.data.authorization.network !== input.authorization.network ||
    parsed.data.authorization.account_id !== input.quoteBinding.refund_to ||
    parsed.data.quote_digest !== digestNearExecutableReviewQuote(input.quoteBinding) ||
    canonicalJson(parsed.data.authorization) !== canonicalJson(input.authorization) ||
    canonicalJson(parsed.data.quote_binding) !== canonicalJson(input.quoteBinding)
  ) return null;
  return parsed.data;
}
