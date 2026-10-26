import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import {
  NearAccountIdSchema,
  NearPrincipalAuthorizationSchema,
  type NearPrincipalAuthorization,
} from "@pilot/contracts/near";
import { z } from "zod";

import { NearNep413VerifierError } from "./near-nep413-verifier";
import { readCookie } from "./openrouter-session";

export const NEAR_PRINCIPAL_AUTHORIZATION_COOKIE =
  "__Host-pilot-near-principal-authorization";
export const NEAR_WALLET_CHALLENGE_COOKIE = "__Host-pilot-near-wallet-challenge";

export const NEAR_PRINCIPAL_AUTHORIZATION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: 60 * 60,
};

export const NEAR_WALLET_CHALLENGE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: 5 * 60,
};

export const NEAR_WALLET_CHALLENGE_TTL_MS =
  NEAR_WALLET_CHALLENGE_COOKIE_OPTIONS.maxAge * 1_000;

const ARTIFACT_VERSION = 1;
const AUTHORIZATION_AAD = Buffer.from(
  "pilot.near.principal-authorization.v1",
  "utf8",
);
const CHALLENGE_AAD = Buffer.from("pilot.near.wallet-control.challenge.v1", "utf8");
const CHALLENGE_DOMAIN = "pilot.near.wallet-control.v1" as const;
const PROVIDER = "nep413-full-access-key" as const;
const NonceSchema = z.string().refine((value) => {
  try {
    return Buffer.from(value, "base64url").length === 32;
  } catch {
    return false;
  }
}, "nonce must encode exactly 32 bytes");
const PublicKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const SignatureSchema = z.string().min(16).max(256).regex(/^[A-Za-z0-9+/=_-]+$/);

const NearWalletControlChallengeSchema = z.object({
  version: z.literal("pilot-near-wallet-control-challenge-v1"),
  domain: z.literal(CHALLENGE_DOMAIN),
  provider: z.literal(PROVIDER),
  authorization: NearPrincipalAuthorizationSchema,
  message: z.string().min(1).max(2_048),
  nonce: NonceSchema,
  recipient: NearAccountIdSchema,
  issued_at_ms: z.number().int().safe().nonnegative(),
  expires_at_ms: z.number().int().safe().positive(),
}).strict().superRefine((challenge, context) => {
  if (
    challenge.expires_at_ms <= challenge.issued_at_ms ||
    challenge.expires_at_ms - challenge.issued_at_ms > NEAR_WALLET_CHALLENGE_TTL_MS
  ) {
    context.addIssue({
      code: "custom",
      path: ["expires_at_ms"],
      message: "challenge expiry is outside the supported window",
    });
  }
  if (challenge.authorization.network !== "near:mainnet") {
    context.addIssue({
      code: "custom",
      path: ["authorization", "network"],
      message: "only the explicit NEAR mainnet identity is supported",
    });
  }
});

export type NearWalletControlChallenge = z.infer<
  typeof NearWalletControlChallengeSchema
>;

export type NearWalletControlProof = Readonly<{
  account_id: string;
  public_key: string;
  signature: string;
}>;

const NearWalletControlProofSchema = z.object({
  account_id: NearAccountIdSchema,
  public_key: PublicKeySchema,
  signature: SignatureSchema,
}).strict();

export type NearWalletProofRuntimeMode = "disabled" | "challenge-only" | "verify";

export type NearWalletProofEnvironment = Readonly<{
  [key: string]: string | undefined;
  PILOT_NEAR_WALLET_PROOF_MODE?: string;
  PILOT_NEAR_WALLET_PROOF_PROVIDER?: string;
  PILOT_NEAR_WALLET_PROOF_RECIPIENT?: string;
  SESSION_SECRET?: string;
}>;

export type NearWalletProofRuntime = Readonly<{
  mode: NearWalletProofRuntimeMode;
  provider: typeof PROVIDER;
  recipient: string;
}>;

export type NearWalletProofErrorCode =
  | "RUNTIME_DISABLED"
  | "RUNTIME_INVALID"
  | "AUTHORIZATION_INVALID"
  | "CHALLENGE_INVALID"
  | "CHALLENGE_EXPIRED"
  | "PRINCIPAL_MISMATCH"
  | "ACCOUNT_MISMATCH"
  | "PROOF_INVALID"
  | "VERIFIER_UNAVAILABLE"
  | "REPLAY_PROTECTION_UNAVAILABLE"
  | "PROOF_REPLAYED";

export class NearWalletProofError extends Error {
  constructor(
    readonly code: NearWalletProofErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NearWalletProofError";
  }
}

function secret(environment: NearWalletProofEnvironment): string {
  const value = environment.SESSION_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new NearWalletProofError(
      "RUNTIME_INVALID",
      "NEAR wallet proof state is not configured.",
    );
  }
  return value;
}

function encryptionKey(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function seal(value: object, aad: Buffer, sessionSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(sessionSecret), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    `v${ARTIFACT_VERSION}`,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function open(value: string | undefined, aad: Buffer, sessionSecret: string): unknown {
  if (!value) return undefined;
  try {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] = value.split(".");
    if (version !== `v${ARTIFACT_VERSION}` || extra !== undefined) return undefined;
    const iv = Buffer.from(encodedIv, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(sessionSecret), iv);
    decipher.setAAD(aad);
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
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function resolveNearWalletProofRuntime(
  environment: NearWalletProofEnvironment = process.env,
): NearWalletProofRuntime {
  const mode = environment.PILOT_NEAR_WALLET_PROOF_MODE ?? "disabled";
  if (mode === "disabled") {
    throw new NearWalletProofError(
      "RUNTIME_DISABLED",
      "NEAR wallet proof is disabled.",
    );
  }
  if (mode !== "challenge-only" && mode !== "verify") {
    throw new NearWalletProofError(
      "RUNTIME_INVALID",
      "NEAR wallet proof mode is invalid.",
    );
  }
  if (environment.PILOT_NEAR_WALLET_PROOF_PROVIDER !== PROVIDER) {
    throw new NearWalletProofError(
      "RUNTIME_INVALID",
      "NEAR wallet proof provider is invalid.",
    );
  }
  const recipient = NearAccountIdSchema.safeParse(
    environment.PILOT_NEAR_WALLET_PROOF_RECIPIENT,
  );
  if (!recipient.success) {
    throw new NearWalletProofError(
      "RUNTIME_INVALID",
      "NEAR wallet proof recipient is invalid.",
    );
  }
  secret(environment);
  return Object.freeze({ mode, provider: PROVIDER, recipient: recipient.data });
}

export function sealNearPrincipalAuthorization(
  value: NearPrincipalAuthorization,
  environment: NearWalletProofEnvironment = process.env,
): string {
  return seal(
    NearPrincipalAuthorizationSchema.parse(value),
    AUTHORIZATION_AAD,
    secret(environment),
  );
}

export function openNearPrincipalAuthorization(
  value: string | undefined,
  options: Readonly<{
    environment?: NearWalletProofEnvironment;
    now?: number;
  }> = {},
): NearPrincipalAuthorization | null {
  const environment = options.environment ?? process.env;
  const parsed = NearPrincipalAuthorizationSchema.safeParse(
    open(value, AUTHORIZATION_AAD, secret(environment)),
  );
  const now = options.now ?? Date.now();
  if (
    !parsed.success ||
    !Number.isSafeInteger(now) ||
    Date.parse(parsed.data.issued_at) > now ||
    Date.parse(parsed.data.expires_at) <= now ||
    !parsed.data.operations.includes("near.intents.approval.review")
  ) return null;
  return parsed.data;
}

export function readNearPrincipalAuthorization(
  request: Request,
  options: Readonly<{
    environment?: NearWalletProofEnvironment;
    now?: number;
  }> = {},
): NearPrincipalAuthorization | null {
  return openNearPrincipalAuthorization(
    readCookie(request, NEAR_PRINCIPAL_AUTHORIZATION_COOKIE),
    options,
  );
}

function challengeMessage(input: Readonly<{
  authorization: NearPrincipalAuthorization;
  nonce: string;
  recipient: string;
  issuedAt: number;
  expiresAt: number;
}>): string {
  return canonicalJson({
    account_id: input.authorization.account_id,
    authorization_id: input.authorization.authorization_id,
    domain: CHALLENGE_DOMAIN,
    expires_at_ms: input.expiresAt,
    issued_at_ms: input.issuedAt,
    network: input.authorization.network,
    nonce: input.nonce,
    principal_id: input.authorization.principal_id,
    recipient: input.recipient,
  });
}

export type IssuedNearWalletProofChallenge = Readonly<{
  cookie: string;
  expiresAt: number;
  signMessage: Readonly<{
    message: string;
    nonce: string;
    recipient: string;
  }>;
}>;

export function issueNearWalletProofChallenge(input: Readonly<{
  authorization: NearPrincipalAuthorization;
  runtime: NearWalletProofRuntime;
  environment?: NearWalletProofEnvironment;
  now?: number;
  nonce?: string;
}>): IssuedNearWalletProofChallenge {
  const environment = input.environment ?? process.env;
  if (input.runtime.mode === "disabled") {
    throw new NearWalletProofError("RUNTIME_DISABLED", "NEAR wallet proof is disabled.");
  }
  const authorization = NearPrincipalAuthorizationSchema.parse(input.authorization);
  const now = input.now ?? Date.now();
  const authorizationExpiresAt = Date.parse(authorization.expires_at);
  if (
    !Number.isSafeInteger(now) || now < 0 ||
    Date.parse(authorization.issued_at) > now ||
    authorizationExpiresAt <= now ||
    !authorization.operations.includes("near.intents.approval.review")
  ) {
    throw new NearWalletProofError(
      "AUTHORIZATION_INVALID",
      "The NEAR principal authorization is invalid or expired.",
    );
  }
  const nonce = input.nonce ?? randomBytes(32).toString("base64url");
  if (!NonceSchema.safeParse(nonce).success) {
    throw new NearWalletProofError("CHALLENGE_INVALID", "The challenge nonce is invalid.");
  }
  const expiresAt = Math.min(now + NEAR_WALLET_CHALLENGE_TTL_MS, authorizationExpiresAt);
  const message = challengeMessage({
    authorization,
    nonce,
    recipient: input.runtime.recipient,
    issuedAt: now,
    expiresAt,
  });
  const challenge = NearWalletControlChallengeSchema.parse({
    version: "pilot-near-wallet-control-challenge-v1",
    domain: CHALLENGE_DOMAIN,
    provider: input.runtime.provider,
    authorization,
    message,
    nonce,
    recipient: input.runtime.recipient,
    issued_at_ms: now,
    expires_at_ms: expiresAt,
  });
  return Object.freeze({
    cookie: seal(challenge, CHALLENGE_AAD, secret(environment)),
    expiresAt,
    signMessage: Object.freeze({ message, nonce, recipient: challenge.recipient }),
  });
}

export type NearNep413FullAccessKeyVerifier = Readonly<{
  verify(input: Readonly<{
    accountId: string;
    publicKey: string;
    signature: string;
    message: string;
    nonce: Uint8Array;
    recipient: string;
  }>): Promise<Readonly<{
    accountId: string;
    publicKey: string;
    signatureValid: true;
    fullAccessKeyVerified: true;
  }>>;
}>;

export type NearWalletProofReplayConsumer = Readonly<{
  consume(input: Readonly<{
    principalId: string;
    accountId: string;
    network: "near:mainnet";
    authorizationId: string;
    recipient: string;
    nonce: string;
    expiresAt: number;
    now: number;
  }>): boolean | Promise<boolean>;
}>;

export type VerifiedNearWalletControl = Readonly<{
  authorization: NearPrincipalAuthorization;
  account_id: string;
  public_key: string;
  provider: typeof PROVIDER;
  challenge_expires_at: number;
}>;

export async function verifyNearWalletControlProof(input: Readonly<{
  challengeCookie: string | undefined;
  currentAuthorization: NearPrincipalAuthorization;
  proof: unknown;
  runtime: NearWalletProofRuntime;
  environment?: NearWalletProofEnvironment;
  verifier?: NearNep413FullAccessKeyVerifier;
  replayConsumer?: NearWalletProofReplayConsumer;
  now?: number;
  clock?: () => number;
}>): Promise<VerifiedNearWalletControl> {
  const environment = input.environment ?? process.env;
  const challenge = NearWalletControlChallengeSchema.safeParse(
    open(input.challengeCookie, CHALLENGE_AAD, secret(environment)),
  );
  if (!challenge.success) {
    throw new NearWalletProofError(
      "CHALLENGE_INVALID",
      "The NEAR wallet-control challenge is invalid.",
    );
  }
  const clock = input.clock ?? Date.now;
  const now = input.now ?? clock();
  if (!Number.isSafeInteger(now) || now < 0 || challenge.data.expires_at_ms <= now) {
    throw new NearWalletProofError(
      "CHALLENGE_EXPIRED",
      "The NEAR wallet-control challenge expired.",
    );
  }
  if (
    challenge.data.provider !== input.runtime.provider ||
    challenge.data.recipient !== input.runtime.recipient
  ) {
    throw new NearWalletProofError(
      "CHALLENGE_INVALID",
      "The NEAR wallet-control challenge does not match this runtime.",
    );
  }
  const currentAuthorization = NearPrincipalAuthorizationSchema.safeParse(
    input.currentAuthorization,
  );
  if (!currentAuthorization.success) {
    throw new NearWalletProofError(
      "AUTHORIZATION_INVALID",
      "The current NEAR principal authorization is invalid.",
    );
  }
  if (
    Date.parse(currentAuthorization.data.issued_at) > now ||
    Date.parse(currentAuthorization.data.expires_at) <= now ||
    !currentAuthorization.data.operations.includes("near.intents.approval.review")
  ) {
    throw new NearWalletProofError(
      "AUTHORIZATION_INVALID",
      "The current NEAR principal authorization is inactive.",
    );
  }
  if (
    currentAuthorization.data.authorization_id !==
      challenge.data.authorization.authorization_id ||
    currentAuthorization.data.principal_id !== challenge.data.authorization.principal_id
  ) {
    throw new NearWalletProofError(
      "PRINCIPAL_MISMATCH",
      "The challenge belongs to another Pilot principal.",
    );
  }
  if (
    currentAuthorization.data.account_id !== challenge.data.authorization.account_id ||
    currentAuthorization.data.network !== challenge.data.authorization.network
  ) {
    throw new NearWalletProofError(
      "ACCOUNT_MISMATCH",
      "The challenge belongs to another NEAR wallet account.",
    );
  }
  if (
    canonicalJson(currentAuthorization.data) !==
      canonicalJson(challenge.data.authorization)
  ) {
    throw new NearWalletProofError(
      "AUTHORIZATION_INVALID",
      "The server-issued NEAR principal authorization changed after challenge issuance.",
    );
  }
  const proof = NearWalletControlProofSchema.safeParse(input.proof);
  if (!proof.success) {
    throw new NearWalletProofError("PROOF_INVALID", "The NEAR wallet proof is invalid.");
  }
  if (proof.data.account_id !== challenge.data.authorization.account_id) {
    throw new NearWalletProofError(
      "ACCOUNT_MISMATCH",
      "The signed proof belongs to another NEAR wallet account.",
    );
  }
  if (input.runtime.mode !== "verify" || !input.verifier) {
    throw new NearWalletProofError(
      "VERIFIER_UNAVAILABLE",
      "NEP-413 full-access-key verification is unavailable.",
    );
  }
  if (!input.replayConsumer) {
    throw new NearWalletProofError(
      "REPLAY_PROTECTION_UNAVAILABLE",
      "NEAR wallet proof replay protection is unavailable.",
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
    if (error instanceof NearWalletProofError) throw error;
    if (
      error instanceof NearNep413VerifierError &&
      (error.code === "INPUT_INVALID" ||
        error.code === "SIGNATURE_INVALID" ||
        error.code === "FULL_ACCESS_KEY_REQUIRED")
    ) {
      throw new NearWalletProofError(
        "PROOF_INVALID",
        "The NEAR wallet proof did not verify for the exact full-access key.",
      );
    }
    throw new NearWalletProofError(
      "VERIFIER_UNAVAILABLE",
      "NEP-413 full-access-key verification is unavailable.",
    );
  }
  if (
    verified.signatureValid !== true ||
    verified.fullAccessKeyVerified !== true ||
    verified.accountId !== proof.data.account_id ||
    verified.publicKey !== proof.data.public_key
  ) {
    throw new NearWalletProofError(
      "PROOF_INVALID",
      "The NEAR wallet proof did not verify for the exact full-access key.",
    );
  }
  let consumed: boolean;
  try {
    consumed = await input.replayConsumer.consume({
      principalId: currentAuthorization.data.principal_id,
      accountId: currentAuthorization.data.account_id,
      network: currentAuthorization.data.network,
      authorizationId: currentAuthorization.data.authorization_id,
      recipient: challenge.data.recipient,
      nonce: challenge.data.nonce,
      expiresAt: challenge.data.expires_at_ms,
      now,
    });
  } catch {
    throw new NearWalletProofError(
      "REPLAY_PROTECTION_UNAVAILABLE",
      "NEAR wallet proof replay protection is unavailable.",
    );
  }
  if (!consumed) {
    throw new NearWalletProofError("PROOF_REPLAYED", "The NEAR wallet proof was already used.");
  }
  if (clock() >= challenge.data.expires_at_ms) {
    throw new NearWalletProofError(
      "CHALLENGE_EXPIRED",
      "The NEAR wallet-control challenge expired during verification.",
    );
  }
  return Object.freeze({
    authorization: currentAuthorization.data,
    account_id: verified.accountId,
    public_key: verified.publicKey,
    provider: challenge.data.provider,
    challenge_expires_at: challenge.data.expires_at_ms,
  });
}

