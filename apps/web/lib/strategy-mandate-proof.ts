import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { decode, deriveAddress, encodeForSigning, verifyKeypairSignature } from "xrpl";

import type { WalletSession } from "./wallet-session";

export const STRATEGY_PROOF_HEADER = "x-pilot-strategy-proof";
export const STRATEGY_CHALLENGE_TTL_MS = 60_000;

export type StrategyProofAction = "activate" | "resume" | "clear_global_kill";

type Challenge = {
  version: 1;
  action: StrategyProofAction;
  account: string;
  network: "testnet";
  strategyId: string;
  mandateVersion: number;
  mandateDigest: string;
  mandateExpiresAt: string;
  requestId: string;
  approvedAt: string;
  nonce: string;
  expiresAt: number;
};

const AAD = Buffer.from("pilot.strategy.mandate.v1", "utf8");
const MEMO_TYPE = Buffer.from("pilot-strategy-mandate-v1", "utf8").toString("hex").toUpperCase();
const DIGEST = /^[A-F0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

function key(secret: string): Buffer {
  if (secret.length < 32) throw new Error("Strategy authorization is not configured.");
  return createHash("sha256").update(secret, "utf8").digest();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => `${JSON.stringify(name)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function seal(value: Challenge, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function open(token: string, secret: string): Challenge | null {
  try {
    const [version, rawIv, rawTag, rawBody, extra] = token.split(".");
    if (version !== "v1" || extra !== undefined) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(rawIv, "base64url"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(rawTag, "base64url"));
    const value = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(rawBody, "base64url")), decipher.final(),
    ]).toString("utf8")) as Challenge;
    if (value.version !== 1 || value.network !== "testnet" || !ID.test(value.strategyId) ||
      !Number.isSafeInteger(value.mandateVersion) || value.mandateVersion < 1 ||
      !DIGEST.test(value.mandateDigest) || !Number.isFinite(Date.parse(value.mandateExpiresAt)) ||
      !ID.test(value.requestId) ||
      !Number.isFinite(Date.parse(value.approvedAt)) ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(value.nonce) ||
      !Number.isSafeInteger(value.expiresAt) || Date.parse(value.approvedAt) >= value.expiresAt ||
      Date.parse(value.mandateExpiresAt) <= Date.parse(value.approvedAt) ||
      !["activate", "resume", "clear_global_kill"].includes(value.action)) return null;
    return value;
  } catch {
    return null;
  }
}

function memoData(challenge: Challenge): string {
  return Buffer.from(canonical({
    action: challenge.action,
    approvedAt: challenge.approvedAt,
    mandateDigest: challenge.mandateDigest,
    mandateExpiresAt: challenge.mandateExpiresAt,
    mandateVersion: challenge.mandateVersion,
    network: challenge.network,
    nonce: challenge.nonce,
    requestId: challenge.requestId,
    strategyId: challenge.strategyId,
  })).toString("hex").toUpperCase();
}

export function strategyChallengeTransaction(challenge: Challenge): Record<string, unknown> {
  return {
    TransactionType: "AccountSet", Account: challenge.account, Sequence: 0, Fee: "0",
    LastLedgerSequence: 0,
    Memos: [{ Memo: { MemoType: MEMO_TYPE, MemoData: memoData(challenge) } }],
  };
}

export function issueStrategyChallenge(
  session: WalletSession,
  input: {
    action: StrategyProofAction; strategyId: string; mandateVersion: number;
    mandateDigest: string; mandateExpiresAt: string; requestId: string;
  },
  options: { now?: number; secret?: string; nonce?: string } = {},
): { token: string; expiresAt: number; txJson: Record<string, unknown> } {
  const now = options.now ?? Date.now();
  const digest = input.mandateDigest.toUpperCase();
  const mandateExpiresAt = new Date(input.mandateExpiresAt).toISOString();
  if (session.network !== "testnet" || session.expiresAt <= now || !ID.test(input.strategyId) ||
    !ID.test(input.requestId) ||
    !Number.isSafeInteger(input.mandateVersion) || input.mandateVersion < 1 || !DIGEST.test(digest)) {
    throw new Error("The strategy challenge is invalid.");
  }
  if (Date.parse(mandateExpiresAt) <= now) throw new Error("The strategy mandate is expired.");
  const challenge: Challenge = {
    version: 1, action: input.action, account: session.account, network: "testnet",
    strategyId: input.strategyId, mandateVersion: input.mandateVersion,
    mandateDigest: digest, mandateExpiresAt, requestId: input.requestId,
    approvedAt: new Date(now).toISOString(),
    nonce: options.nonce ?? randomBytes(32).toString("base64url"),
    expiresAt: Math.min(session.expiresAt, now + STRATEGY_CHALLENGE_TTL_MS),
  };
  const secret = options.secret ?? process.env.SESSION_SECRET?.trim();
  if (!secret) throw new Error("Strategy authorization is not configured.");
  return { token: seal(challenge, secret), expiresAt: challenge.expiresAt, txJson: strategyChallengeTransaction(challenge) };
}

/**
 * Verifies one signed logical mutation. Byte-identical replay is intentionally
 * accepted only for the signed request_id so Harbor can return its durable
 * receipt after an ambiguous HTTP result; changing any binding invalidates it.
 */
export async function verifyAndConsumeStrategyProof(
  input: {
    token: string; txBlob: string; action: StrategyProofAction; strategyId: string;
    mandateVersion: number; mandateDigest: string; mandateExpiresAt: string; requestId: string;
  },
  options: { now?: number; secret?: string } = {},
): Promise<{ authorizationId: string; approvedAt: string; expiresAt: string; owner: string }> {
  const now = options.now ?? Date.now();
  const secret = options.secret ?? process.env.SESSION_SECRET?.trim();
  if (!secret) throw new Error("Strategy authorization is not configured.");
  const challenge = open(input.token, secret);
  if (!challenge || challenge.expiresAt <= now || challenge.action !== input.action ||
    challenge.strategyId !== input.strategyId || challenge.mandateVersion !== input.mandateVersion ||
    challenge.mandateDigest !== input.mandateDigest.toUpperCase() ||
    challenge.mandateExpiresAt !== new Date(input.mandateExpiresAt).toISOString() ||
    challenge.requestId !== input.requestId || Date.parse(challenge.mandateExpiresAt) <= now ||
    !/^[A-Fa-f0-9]+$/.test(input.txBlob) || input.txBlob.length > 16_384) {
    throw new Error("The strategy proof is invalid or expired.");
  }
  let decoded: Record<string, unknown>;
  try { decoded = decode(input.txBlob) as Record<string, unknown>; } catch { throw new Error("The strategy proof is invalid."); }
  const signature = decoded.TxnSignature;
  const publicKey = decoded.SigningPubKey;
  const unsigned = { ...decoded }; delete unsigned.TxnSignature; delete unsigned.SigningPubKey;
  if (typeof signature !== "string" || typeof publicKey !== "string" || !publicKey ||
    canonical(unsigned) !== canonical(strategyChallengeTransaction(challenge)) ||
    deriveAddress(publicKey) !== challenge.account ||
    !verifyKeypairSignature(encodeForSigning(decoded as never), signature, publicKey)) {
    throw new Error("The strategy proof signature is invalid.");
  }
  return {
    authorizationId: createHash("sha256").update(challenge.nonce).digest("hex").toUpperCase(),
    approvedAt: challenge.approvedAt, expiresAt: challenge.mandateExpiresAt,
    owner: challenge.account,
  };
}
