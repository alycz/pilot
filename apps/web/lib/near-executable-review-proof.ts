import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import {
  NearAccountIdSchema,
  NearArbitrumUsdcToWnearExecutableQuoteBindingSchema,
  NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
  NearPrincipalAuthorizationSchema,
  type NearArbitrumUsdcToWnearExecutableQuoteBinding,
  type NearNativeNearToArbitrumUsdcExecutableQuoteBinding,
  type NearPrincipalAuthorization,
} from "@pilot/contracts/near";
import { z } from "zod";

import {
  NearNep413VerifierError,
} from "./near-nep413-verifier";
import type {
  NearNep413FullAccessKeyVerifier,
  NearWalletProofEnvironment,
  NearWalletProofRuntime,
} from "./near-wallet-proof";

export const NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE =
  "__Host-pilot-near-executable-review-challenge";

export const NEAR_EXECUTABLE_REVIEW_CHALLENGE_TTL_MS = 2 * 60_000;

export const NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: NEAR_EXECUTABLE_REVIEW_CHALLENGE_TTL_MS / 1_000,
};

const CHALLENGE_VERSION =
  "pilot-near-executable-review-wallet-control-challenge-v1" as const;
const MESSAGE_VERSION =
  "pilot-near-executable-review-wallet-control-message-v1" as const;
const MESSAGE_DOMAIN = "pilot.near.executable-review.wallet-control.v1" as const;
const OPERATION = "near.intents.executable-quote.review" as const;
const PROVIDER = "nep413-full-access-key" as const;
const CHALLENGE_AAD = Buffer.from(
  "pilot.near.executable-review.wallet-control.challenge.v1",
  "utf8",
);

const CanonicalBase64UrlNonceSchema = z.string().refine((value) => {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}, "nonce must be canonical base64url for exactly 32 bytes");
const LowerHexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PublicKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const SignatureSchema = z.string().min(16).max(256).regex(/^[A-Za-z0-9+/=_-]+$/);
const NearExecutableReviewQuoteBindingSchema = z.union([
  NearArbitrumUsdcToWnearExecutableQuoteBindingSchema,
  NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
]);
export type NearExecutableReviewQuoteBinding =
  | NearArbitrumUsdcToWnearExecutableQuoteBinding
  | NearNativeNearToArbitrumUsdcExecutableQuoteBinding;

const NearExecutableReviewProofSchema = z.object({
  account_id: NearAccountIdSchema,
  public_key: PublicKeySchema,
  signature: SignatureSchema,
}).strict();

const NearExecutableReviewChallengeSchema = z.object({
  version: z.literal(CHALLENGE_VERSION),
  domain: z.literal(MESSAGE_DOMAIN),
  operation: z.literal(OPERATION),
  provider: z.literal(PROVIDER),
  authorization: NearPrincipalAuthorizationSchema,
  quote_binding: NearExecutableReviewQuoteBindingSchema,
  quote_digest: LowerHexDigestSchema,
  message: z.string().min(1).max(8_192),
  message_digest: LowerHexDigestSchema,
  nonce: CanonicalBase64UrlNonceSchema,
  recipient: NearAccountIdSchema,
  issued_at_ms: z.number().int().safe().nonnegative(),
  expires_at_ms: z.number().int().safe().positive(),
}).strict().superRefine((challenge, context) => {
  if (
    challenge.expires_at_ms <= challenge.issued_at_ms ||
    challenge.expires_at_ms - challenge.issued_at_ms >
      NEAR_EXECUTABLE_REVIEW_CHALLENGE_TTL_MS
  ) {
    context.addIssue({
      code: "custom",
      path: ["expires_at_ms"],
      message: "challenge expiry is outside the supported window",
    });
  }
});

type NearExecutableReviewChallenge = z.infer<
  typeof NearExecutableReviewChallengeSchema
>;

export type NearExecutableReviewProofErrorCode =
  | "RUNTIME_DISABLED"
  | "RUNTIME_INVALID"
  | "AUTHORIZATION_INVALID"
  | "PRINCIPAL_MISMATCH"
  | "ACCOUNT_MISMATCH"
  | "QUOTE_INVALID"
  | "QUOTE_EXPIRED"
  | "QUOTE_MUTATED"
  | "CHALLENGE_INVALID"
  | "CHALLENGE_EXPIRED"
  | "PROOF_INVALID"
  | "VERIFIER_UNAVAILABLE"
  | "REPLAY_PROTECTION_UNAVAILABLE"
  | "PROOF_REPLAYED";

export class NearExecutableReviewProofError extends Error {
  constructor(
    readonly code: NearExecutableReviewProofErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NearExecutableReviewProofError";
  }
}

export type NearExecutableReviewNonceConsumption = Readonly<{
  version: "pilot-near-executable-review-nonce-v1";
  principalId: string;
  accountId: string;
  network: "near:mainnet";
  authorizationId: string;
  operation: typeof OPERATION;
  quoteDigest: string;
  recipient: string;
  nonce: string;
  expiresAt: number;
  now: number;
}>;

/**
 * Durable implementations must atomically insert the exact scoped nonce once.
 * False means the nonce was already consumed or its binding was rejected.
 */
export type NearExecutableReviewNonceConsumer = Readonly<{
  consume(
    input: NearExecutableReviewNonceConsumption,
  ): boolean | Promise<boolean>;
}>;

export type IssuedNearExecutableReviewChallenge = Readonly<{
  cookie: string;
  expiresAt: number;
  quoteDigest: string;
  signMessage: Readonly<{
    message: string;
    message_digest: string;
    nonce: string;
    recipient: string;
  }>;
}>;

export type VerifiedNearExecutableReviewWalletControl = Readonly<{
  authorization: NearPrincipalAuthorization;
  quote_binding: NearExecutableReviewQuoteBinding;
  quote_digest: string;
  account_id: string;
  public_key: string;
  provider: typeof PROVIDER;
  challenge_expires_at: number;
}>;

function secret(environment: NearWalletProofEnvironment): string {
  const value = environment.SESSION_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new NearExecutableReviewProofError(
      "RUNTIME_INVALID",
      "NEAR executable-review wallet proof is not configured.",
    );
  }
  return value;
}

function encryptionKey(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sealChallenge(
  challenge: NearExecutableReviewChallenge,
  sessionSecret: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    encryptionKey(sessionSecret),
    iv,
  );
  cipher.setAAD(CHALLENGE_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(challenge), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function openChallenge(value: string | undefined, sessionSecret: string): unknown {
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
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(sessionSecret),
      iv,
    );
    decipher.setAAD(CHALLENGE_AAD);
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
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function digestNearExecutableReviewQuote(
  value: unknown,
): string {
  const parsed = NearExecutableReviewQuoteBindingSchema.safeParse(value);
  if (!parsed.success) {
    throw new NearExecutableReviewProofError(
      "QUOTE_INVALID",
      "The executable quote binding is invalid.",
    );
  }
  return sha256(canonicalJson(parsed.data));
}

function exactAuthorization(
  value: unknown,
  now: number,
): NearPrincipalAuthorization {
  const parsed = NearPrincipalAuthorizationSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.network !== "near:mainnet" ||
    !parsed.data.operations.includes(OPERATION) ||
    Date.parse(parsed.data.issued_at) > now ||
    Date.parse(parsed.data.expires_at) <= now
  ) {
    throw new NearExecutableReviewProofError(
      "AUTHORIZATION_INVALID",
      "The NEAR executable-review principal authorization is inactive.",
    );
  }
  return parsed.data;
}

function exactQuote(
  value: unknown,
  authorization: NearPrincipalAuthorization,
  now: number,
): NearExecutableReviewQuoteBinding {
  const parsed = NearExecutableReviewQuoteBindingSchema.safeParse(value);
  if (!parsed.success) {
    throw new NearExecutableReviewProofError(
      "QUOTE_INVALID",
      "The executable quote binding is invalid.",
    );
  }
  const nearOwnerAccount = parsed.data.version ===
      "pilot-near-native-to-arbitrum-usdc-quote-binding-v1"
    ? parsed.data.refund_to
    : parsed.data.recipient;
  if (nearOwnerAccount !== authorization.account_id) {
    throw new NearExecutableReviewProofError(
      "ACCOUNT_MISMATCH",
      "The executable quote belongs to another NEAR account.",
    );
  }
  if (
    Date.parse(parsed.data.approval_expires_at) <= now ||
    Date.parse(parsed.data.provider_time_when_inactive_at) <= now ||
    Date.parse(parsed.data.provider_deadline_at) <= now
  ) {
    throw new NearExecutableReviewProofError(
      "QUOTE_EXPIRED",
      "The executable quote is no longer active for wallet review.",
    );
  }
  return parsed.data;
}

function messageForChallenge(input: Readonly<{
  authorization: NearPrincipalAuthorization;
  quote: NearExecutableReviewQuoteBinding;
  quoteDigest: string;
  nonce: string;
  recipient: string;
  issuedAt: number;
  expiresAt: number;
}>): string {
  const request = input.quote.request_echo;
  return canonicalJson({
    version: MESSAGE_VERSION,
    domain: MESSAGE_DOMAIN,
    operation: OPERATION,
    authorization: {
      authorization_id: input.authorization.authorization_id,
      principal_id: input.authorization.principal_id,
      account_id: input.authorization.account_id,
      network: input.authorization.network,
    },
    quote: {
      quote_digest: input.quoteDigest,
      quote_hash: input.quote.quote_hash,
      correlation_id: input.quote.correlation_id,
      provider_signature_verified: input.quote.provider_signature_verified,
      route: input.quote.route,
      economics: {
        swap_type: request.swapType,
        amount_in: input.quote.amount_in,
        min_amount_out: input.quote.min_amount_out,
        slippage_bps: request.slippageTolerance,
        origin_asset_id: request.originAsset,
        destination_asset_id: request.destinationAsset,
      },
      routing: {
        deposit_type: request.depositType,
        deposit_mode: request.depositMode,
        deposit_address: input.quote.deposit_address,
        deposit_memo_present: input.quote.deposit_memo_present,
        recipient: input.quote.recipient,
        recipient_type: request.recipientType,
        refund_to: input.quote.refund_to,
        refund_type: request.refundType,
      },
      timing: {
        provider_deadline_at: input.quote.provider_deadline_at,
        provider_time_when_inactive_at:
          input.quote.provider_time_when_inactive_at,
        approval_expires_at: input.quote.approval_expires_at,
      },
    },
    challenge: {
      issued_at_ms: input.issuedAt,
      expires_at_ms: input.expiresAt,
      nonce: input.nonce,
      recipient: input.recipient,
    },
  });
}

function assertVerifyRuntime(runtime: NearWalletProofRuntime): void {
  if (runtime.mode === "disabled") {
    throw new NearExecutableReviewProofError(
      "RUNTIME_DISABLED",
      "NEAR executable-review wallet proof is disabled.",
    );
  }
  if (runtime.mode !== "verify" || runtime.provider !== PROVIDER) {
    throw new NearExecutableReviewProofError(
      "RUNTIME_INVALID",
      "NEAR executable-review wallet proof verification is unavailable.",
    );
  }
}

export function issueNearExecutableReviewChallenge(input: Readonly<{
  authorization: NearPrincipalAuthorization;
  quoteBinding: unknown;
  runtime: NearWalletProofRuntime;
  environment?: NearWalletProofEnvironment;
  now?: number;
  nonce?: string;
}>): IssuedNearExecutableReviewChallenge {
  const environment = input.environment ?? process.env;
  assertVerifyRuntime(input.runtime);
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new NearExecutableReviewProofError(
      "CHALLENGE_INVALID",
      "The executable-review challenge clock is invalid.",
    );
  }
  const authorization = exactAuthorization(input.authorization, now);
  const quote = exactQuote(input.quoteBinding, authorization, now);
  const nonce = input.nonce ?? randomBytes(32).toString("base64url");
  if (!CanonicalBase64UrlNonceSchema.safeParse(nonce).success) {
    throw new NearExecutableReviewProofError(
      "CHALLENGE_INVALID",
      "The executable-review challenge nonce is invalid.",
    );
  }
  const expiresAt = Math.min(
    now + NEAR_EXECUTABLE_REVIEW_CHALLENGE_TTL_MS,
    Date.parse(authorization.expires_at),
    Date.parse(quote.approval_expires_at),
    Date.parse(quote.provider_time_when_inactive_at),
    Date.parse(quote.provider_deadline_at),
  );
  if (expiresAt <= now) {
    throw new NearExecutableReviewProofError(
      "QUOTE_EXPIRED",
      "The executable quote expired before challenge issuance.",
    );
  }
  const quoteDigest = digestNearExecutableReviewQuote(quote);
  const message = messageForChallenge({
    authorization,
    quote,
    quoteDigest,
    nonce,
    recipient: input.runtime.recipient,
    issuedAt: now,
    expiresAt,
  });
  const challenge = NearExecutableReviewChallengeSchema.parse({
    version: CHALLENGE_VERSION,
    domain: MESSAGE_DOMAIN,
    operation: OPERATION,
    provider: input.runtime.provider,
    authorization,
    quote_binding: quote,
    quote_digest: quoteDigest,
    message,
    message_digest: sha256(message),
    nonce,
    recipient: input.runtime.recipient,
    issued_at_ms: now,
    expires_at_ms: expiresAt,
  });
  return Object.freeze({
    cookie: sealChallenge(challenge, secret(environment)),
    expiresAt,
    quoteDigest,
    signMessage: Object.freeze({
      message,
      message_digest: challenge.message_digest,
      nonce,
      recipient: challenge.recipient,
    }),
  });
}

function assertSameAuthorization(
  current: NearPrincipalAuthorization,
  challenged: NearPrincipalAuthorization,
): void {
  if (
    current.authorization_id !== challenged.authorization_id ||
    current.principal_id !== challenged.principal_id
  ) {
    throw new NearExecutableReviewProofError(
      "PRINCIPAL_MISMATCH",
      "The executable-review challenge belongs to another Pilot principal.",
    );
  }
  if (
    current.account_id !== challenged.account_id ||
    current.network !== challenged.network
  ) {
    throw new NearExecutableReviewProofError(
      "ACCOUNT_MISMATCH",
      "The executable-review challenge belongs to another NEAR account.",
    );
  }
  if (canonicalJson(current) !== canonicalJson(challenged)) {
    throw new NearExecutableReviewProofError(
      "AUTHORIZATION_INVALID",
      "The NEAR principal authorization changed after challenge issuance.",
    );
  }
}

export async function verifyNearExecutableReviewProof(input: Readonly<{
  challengeCookie: string | undefined;
  currentAuthorization: NearPrincipalAuthorization;
  currentQuoteBinding: unknown;
  proof: unknown;
  runtime: NearWalletProofRuntime;
  environment?: NearWalletProofEnvironment;
  verifier?: NearNep413FullAccessKeyVerifier;
  nonceConsumer?: NearExecutableReviewNonceConsumer;
  now?: number;
  clock?: () => number;
}>): Promise<VerifiedNearExecutableReviewWalletControl> {
  const environment = input.environment ?? process.env;
  assertVerifyRuntime(input.runtime);
  const challenge = NearExecutableReviewChallengeSchema.safeParse(
    openChallenge(input.challengeCookie, secret(environment)),
  );
  if (!challenge.success) {
    throw new NearExecutableReviewProofError(
      "CHALLENGE_INVALID",
      "The executable-review wallet challenge is invalid.",
    );
  }
  const clock = input.clock ?? Date.now;
  const now = input.now ?? clock();
  if (
    !Number.isSafeInteger(now) || now < 0 ||
    challenge.data.expires_at_ms <= now
  ) {
    throw new NearExecutableReviewProofError(
      "CHALLENGE_EXPIRED",
      "The executable-review wallet challenge expired.",
    );
  }
  if (
    challenge.data.provider !== input.runtime.provider ||
    challenge.data.recipient !== input.runtime.recipient
  ) {
    throw new NearExecutableReviewProofError(
      "CHALLENGE_INVALID",
      "The executable-review challenge does not match this runtime.",
    );
  }
  const authorization = exactAuthorization(input.currentAuthorization, now);
  assertSameAuthorization(authorization, challenge.data.authorization);
  const quote = exactQuote(input.currentQuoteBinding, authorization, now);
  const quoteDigest = digestNearExecutableReviewQuote(quote);
  if (
    quoteDigest !== challenge.data.quote_digest ||
    canonicalJson(quote) !== canonicalJson(challenge.data.quote_binding)
  ) {
    throw new NearExecutableReviewProofError(
      "QUOTE_MUTATED",
      "The executable quote changed after wallet review began.",
    );
  }
  const expectedMessage = messageForChallenge({
    authorization,
    quote,
    quoteDigest,
    nonce: challenge.data.nonce,
    recipient: challenge.data.recipient,
    issuedAt: challenge.data.issued_at_ms,
    expiresAt: challenge.data.expires_at_ms,
  });
  if (
    challenge.data.message !== expectedMessage ||
    challenge.data.message_digest !== sha256(expectedMessage)
  ) {
    throw new NearExecutableReviewProofError(
      "CHALLENGE_INVALID",
      "The executable-review challenge message is invalid.",
    );
  }
  const proof = NearExecutableReviewProofSchema.safeParse(input.proof);
  if (!proof.success) {
    throw new NearExecutableReviewProofError(
      "PROOF_INVALID",
      "The executable-review wallet proof is invalid.",
    );
  }
  if (proof.data.account_id !== authorization.account_id) {
    throw new NearExecutableReviewProofError(
      "ACCOUNT_MISMATCH",
      "The executable-review proof belongs to another NEAR account.",
    );
  }
  if (!input.verifier) {
    throw new NearExecutableReviewProofError(
      "VERIFIER_UNAVAILABLE",
      "NEP-413 executable-review verification is unavailable.",
    );
  }
  if (!input.nonceConsumer) {
    throw new NearExecutableReviewProofError(
      "REPLAY_PROTECTION_UNAVAILABLE",
      "Executable-review replay protection is unavailable.",
    );
  }
  let verified;
  try {
    verified = await input.verifier.verify({
      accountId: proof.data.account_id,
      publicKey: proof.data.public_key,
      signature: proof.data.signature,
      message: challenge.data.message,
      nonce: new Uint8Array(Buffer.from(challenge.data.nonce, "base64url")),
      recipient: challenge.data.recipient,
    });
  } catch (error) {
    if (
      error instanceof NearNep413VerifierError &&
      (error.code === "INPUT_INVALID" ||
        error.code === "SIGNATURE_INVALID" ||
        error.code === "FULL_ACCESS_KEY_REQUIRED")
    ) {
      throw new NearExecutableReviewProofError(
        "PROOF_INVALID",
        "The executable-review proof did not verify for an authorized full-access key.",
      );
    }
    throw new NearExecutableReviewProofError(
      "VERIFIER_UNAVAILABLE",
      "NEP-413 executable-review verification is unavailable.",
    );
  }
  if (
    verified.signatureValid !== true ||
    verified.fullAccessKeyVerified !== true ||
    verified.accountId !== proof.data.account_id ||
    verified.publicKey !== proof.data.public_key
  ) {
    throw new NearExecutableReviewProofError(
      "PROOF_INVALID",
      "The executable-review proof did not verify for an authorized full-access key.",
    );
  }
  let consumed: boolean;
  try {
    consumed = await input.nonceConsumer.consume({
      version: "pilot-near-executable-review-nonce-v1",
      principalId: authorization.principal_id,
      accountId: authorization.account_id,
      network: authorization.network,
      authorizationId: authorization.authorization_id,
      operation: OPERATION,
      quoteDigest,
      recipient: challenge.data.recipient,
      nonce: challenge.data.nonce,
      expiresAt: challenge.data.expires_at_ms,
      now,
    });
  } catch {
    throw new NearExecutableReviewProofError(
      "REPLAY_PROTECTION_UNAVAILABLE",
      "Executable-review replay protection is unavailable.",
    );
  }
  if (!consumed) {
    throw new NearExecutableReviewProofError(
      "PROOF_REPLAYED",
      "The executable-review wallet proof was already used.",
    );
  }
  if (clock() >= challenge.data.expires_at_ms) {
    throw new NearExecutableReviewProofError(
      "CHALLENGE_EXPIRED",
      "The executable-review challenge expired during verification.",
    );
  }
  return Object.freeze({
    authorization,
    quote_binding: quote,
    quote_digest: quoteDigest,
    account_id: verified.accountId,
    public_key: verified.publicKey,
    provider: challenge.data.provider,
    challenge_expires_at: challenge.data.expires_at_ms,
  });
}
