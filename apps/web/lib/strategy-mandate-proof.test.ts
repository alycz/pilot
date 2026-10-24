import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";

import {
  STRATEGY_CHALLENGE_TTL_MS,
  issueStrategyChallenge,
  type StrategyProofAction,
  verifyAndConsumeStrategyProof,
} from "./strategy-mandate-proof";
import type { WalletSession } from "./wallet-session";

const NOW = Date.parse("2026-10-22T00:00:00.000Z");
const SECRET = "strategy-proof-test-secret-with-at-least-thirty-two-characters";
const DIGEST = "A".repeat(64);
const MANDATE_EXPIRES_AT = "2026-10-29T00:00:00.000Z";

function session(wallet: Wallet): WalletSession {
  return {
    version: 1,
    account: wallet.classicAddress,
    network: "testnet",
    expiresAt: NOW + 10 * 60_000,
  };
}

function signedProof(wallet: Wallet, action: StrategyProofAction = "activate") {
  const challenge = issueStrategyChallenge(session(wallet), {
    action,
    strategyId: "strategy-test-001",
    mandateVersion: 1,
    mandateDigest: DIGEST,
    mandateExpiresAt: MANDATE_EXPIRES_AT,
    requestId: "request-activate-001",
  }, { now: NOW, secret: SECRET, nonce: "A".repeat(43) });
  return { challenge, txBlob: wallet.sign(challenge.txJson as never).tx_blob };
}

function exactInput(
  challenge: ReturnType<typeof signedProof>["challenge"],
  txBlob: string,
  action: StrategyProofAction = "activate",
) {
  return {
    token: challenge.token,
    txBlob,
    action,
    strategyId: "strategy-test-001",
    mandateVersion: 1,
    mandateDigest: DIGEST,
    mandateExpiresAt: MANDATE_EXPIRES_AT,
    requestId: "request-activate-001",
  };
}

describe("strategy mandate proof", () => {
  it("keeps the one-use challenge short while binding authorization to mandate expiry", async () => {
    const wallet = Wallet.generate();
    const { challenge, txBlob } = signedProof(wallet);
    expect(challenge.expiresAt).toBe(NOW + STRATEGY_CHALLENGE_TTL_MS);

    const authorization = await verifyAndConsumeStrategyProof({
      token: challenge.token,
      txBlob,
      action: "activate",
      strategyId: "strategy-test-001",
      mandateVersion: 1,
      mandateDigest: DIGEST,
      mandateExpiresAt: MANDATE_EXPIRES_AT,
      requestId: "request-activate-001",
    }, { now: NOW + 1, secret: SECRET });

    expect(authorization.owner).toBe(wallet.classicAddress);
    expect(authorization.expiresAt).toBe(MANDATE_EXPIRES_AT);
  });

  it("binds a global-kill clear proof to that exact risk-increasing action", async () => {
    const wallet = Wallet.generate();
    const { challenge, txBlob } = signedProof(wallet, "clear_global_kill");

    await expect(verifyAndConsumeStrategyProof(
      exactInput(challenge, txBlob, "clear_global_kill"),
      { now: NOW + 1, secret: SECRET },
    )).resolves.toMatchObject({ owner: wallet.classicAddress });
    await expect(verifyAndConsumeStrategyProof(
      exactInput(challenge, txBlob, "activate"),
      { now: NOW + 1, secret: SECRET },
    )).rejects.toThrow("invalid or expired");
  });

  it("allows concurrent exact-request replay but rejects a different request id or expiry", async () => {
    const wallet = Wallet.generate();
    const { challenge, txBlob } = signedProof(wallet);
    const input = exactInput(challenge, txBlob);
    const sameRequest = await Promise.all([
      verifyAndConsumeStrategyProof(input, { now: NOW + 1, secret: SECRET }),
      verifyAndConsumeStrategyProof(input, { now: NOW + 30_000, secret: SECRET }),
    ]);
    expect(sameRequest[0]).toEqual(sameRequest[1]);
    await expect(verifyAndConsumeStrategyProof({
      ...input, requestId: "request-activate-002",
    }, { now: NOW + 2, secret: SECRET })).rejects.toThrow("invalid or expired");
    await expect(verifyAndConsumeStrategyProof({
      ...input, mandateExpiresAt: "2026-10-28T00:00:00.000Z",
    }, { now: NOW + 3, secret: SECRET })).rejects.toThrow("invalid or expired");
  });

  it.each([
    ["action", { action: "resume" as const }],
    ["global-kill action", { action: "clear_global_kill" as const }],
    ["strategy id", { strategyId: "strategy-test-002" }],
    ["mandate version", { mandateVersion: 2 }],
    ["mandate digest", { mandateDigest: "B".repeat(64) }],
  ])("rejects a valid signature replayed with a changed %s binding", async (_name, changed) => {
    const wallet = Wallet.generate();
    const { challenge, txBlob } = signedProof(wallet);

    await expect(verifyAndConsumeStrategyProof({
      ...exactInput(challenge, txBlob),
      ...changed,
    }, { now: NOW + 1, secret: SECRET })).rejects.toThrow("invalid or expired");
  });

  it("rejects a challenge transaction signed by a different account or supplied as a malformed blob", async () => {
    const owner = Wallet.generate();
    const impostor = Wallet.generate();
    const { challenge } = signedProof(owner);
    const impostorBlob = impostor.sign(challenge.txJson as never).tx_blob;

    await expect(verifyAndConsumeStrategyProof(
      exactInput(challenge, impostorBlob),
      { now: NOW + 1, secret: SECRET },
    )).rejects.toThrow("signature is invalid");

    await expect(verifyAndConsumeStrategyProof(
      exactInput(challenge, `${impostorBlob.slice(0, -2)}ZZ`),
      { now: NOW + 1, secret: SECRET },
    )).rejects.toThrow("invalid or expired");
  });

  it.each([
    ["fee", (tx: Record<string, unknown>) => ({ ...tx, Fee: "1" })],
    ["flags", (tx: Record<string, unknown>) => ({ ...tx, Flags: 0 })],
    ["memo format", (tx: Record<string, unknown>) => {
      const memos = structuredClone(tx.Memos) as Array<{ Memo: Record<string, unknown> }>;
      memos[0].Memo.MemoFormat = Buffer.from("text/plain", "utf8").toString("hex").toUpperCase();
      return { ...tx, Memos: memos };
    }],
    ["extra memo", (tx: Record<string, unknown>) => ({
      ...tx,
      Memos: [
        ...(structuredClone(tx.Memos) as Array<Record<string, unknown>>),
        { Memo: { MemoData: "00" } },
      ],
    })],
  ] as const)("rejects a re-signed transaction with a harmless-looking %s change", async (_name, mutate) => {
    const wallet = Wallet.generate();
    const { challenge } = signedProof(wallet);
    const changedBlob = wallet.sign(mutate(challenge.txJson) as never).tx_blob;

    await expect(verifyAndConsumeStrategyProof(
      exactInput(challenge, changedBlob),
      { now: NOW + 1, secret: SECRET },
    )).rejects.toThrow("signature is invalid");
  });

  it("rejects at the exact short-lived challenge expiry boundary without weakening exact replay", async () => {
    const wallet = Wallet.generate();
    const { challenge, txBlob } = signedProof(wallet);
    const input = exactInput(challenge, txBlob);

    await expect(verifyAndConsumeStrategyProof(
      input,
      { now: challenge.expiresAt - 1, secret: SECRET },
    )).resolves.toMatchObject({ owner: wallet.classicAddress });
    await expect(verifyAndConsumeStrategyProof(
      input,
      { now: challenge.expiresAt, secret: SECRET },
    )).rejects.toThrow("invalid or expired");
  });
});
