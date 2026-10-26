import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  HarborNearWalletProofReplayConsumer,
  HarborWalletActionProofConsumer,
  createHostedNearWalletProofReplayConsumer,
  createWalletActionProofConsumer,
  deriveHostedNearWalletProofScopeId,
  deriveHostedWalletProofScopeId,
} from "./wallet-action-proof-consumer";
import type { WalletSession } from "./wallet-session";

const SECRET = "hosted-wallet-proof-scope-secret-at-least-thirty-two-characters";
const SESSION: WalletSession = {
  version: 1,
  account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  network: "testnet",
  expiresAt: 1_800_000_000_000,
};
const NEAR_BINDING = {
  principalId: "principal-alice",
  accountId: "alice.near",
  network: "near:mainnet" as const,
  authorizationId: "authorization-1",
  recipient: "pilot.near",
};
const NEAR_NONCE = Buffer.alloc(32, 7).toString("base64url");

describe("hosted wallet proof consumer", () => {
  it("derives opaque, domain-separated scopes bound to the session and namespace", () => {
    const chat = deriveHostedWalletProofScopeId(SESSION, "chat", SECRET);
    expect(chat).toMatch(/^[a-f0-9]{64}$/);
    expect(chat).not.toContain(SESSION.account);
    expect(deriveHostedWalletProofScopeId(SESSION, "wallet-auth", SECRET)).not.toBe(chat);
    expect(deriveHostedWalletProofScopeId({ ...SESSION, network: "devnet" }, "chat", SECRET))
      .not.toBe(chat);
    expect(deriveHostedWalletProofScopeId({ ...SESSION, expiresAt: SESSION.expiresAt + 1 },
      "chat", SECRET)).not.toBe(chat);
  });

  it("domain-separates a NEAR scope across every authority binding", () => {
    const exact = deriveHostedNearWalletProofScopeId(NEAR_BINDING, SECRET);
    expect(exact).toMatch(/^[a-f0-9]{64}$/);
    expect(exact).not.toContain(NEAR_BINDING.principalId);
    for (const changed of [
      { ...NEAR_BINDING, principalId: "principal-bob" },
      { ...NEAR_BINDING, accountId: "bob.near" },
      { ...NEAR_BINDING, authorizationId: "authorization-2" },
      { ...NEAR_BINDING, recipient: "other.near" },
    ]) {
      expect(deriveHostedNearWalletProofScopeId(changed, SECRET)).not.toBe(exact);
    }
  });

  it("adapts the exact NEAR replay signature and sends only opaque digests", async () => {
    const consumeWalletProof = vi.fn().mockResolvedValue({ consumed: true });
    const consumer = new HarborNearWalletProofReplayConsumer(
      { consumeWalletProof }, NEAR_BINDING, SECRET,
    );
    await expect(consumer.consume({
      principalId: NEAR_BINDING.principalId,
      accountId: NEAR_BINDING.accountId,
      network: NEAR_BINDING.network,
      authorizationId: NEAR_BINDING.authorizationId,
      recipient: NEAR_BINDING.recipient,
      nonce: NEAR_NONCE,
      expiresAt: SESSION.expiresAt,
      now: 1_799_999_000_000,
    })).resolves.toBe(true);
    expect(consumeWalletProof).toHaveBeenCalledWith({
      version: 1,
      namespace: "near-wallet-auth",
      scopeId: deriveHostedNearWalletProofScopeId(NEAR_BINDING, SECRET),
      nonceDigest: createHash("sha256").update(NEAR_NONCE).digest("hex"),
      expiresAtMs: SESSION.expiresAt,
    });
    const serialized = JSON.stringify(consumeWalletProof.mock.calls);
    expect(serialized).not.toContain(NEAR_NONCE);
    expect(serialized).not.toContain(NEAR_BINDING.principalId);
    expect(serialized).not.toContain(NEAR_BINDING.accountId);
    expect(serialized).not.toContain(NEAR_BINDING.authorizationId);
  });

  it("rejects cross-principal, cross-account, malformed nonce, and local fallback", async () => {
    const consumeWalletProof = vi.fn().mockResolvedValue({ consumed: true });
    const consumer = new HarborNearWalletProofReplayConsumer(
      { consumeWalletProof }, NEAR_BINDING, SECRET,
    );
    const baseline = {
      principalId: NEAR_BINDING.principalId,
      accountId: NEAR_BINDING.accountId,
      network: NEAR_BINDING.network,
      authorizationId: NEAR_BINDING.authorizationId,
      recipient: NEAR_BINDING.recipient,
      nonce: NEAR_NONCE,
      expiresAt: SESSION.expiresAt,
      now: 1_799_999_000_000,
    };
    await expect(consumer.consume({ ...baseline, principalId: "principal-bob" }))
      .resolves.toBe(false);
    await expect(consumer.consume({ ...baseline, accountId: "bob.near" }))
      .resolves.toBe(false);
    await expect(consumer.consume({ ...baseline, authorizationId: "authorization-2" }))
      .resolves.toBe(false);
    await expect(consumer.consume({ ...baseline, recipient: "other.near" }))
      .resolves.toBe(false);
    await expect(consumer.consume({ ...baseline, nonce: "not-a-near-nonce" }))
      .resolves.toBe(false);
    expect(consumeWalletProof).not.toHaveBeenCalled();
    expect(() => createHostedNearWalletProofReplayConsumer(NEAR_BINDING, {
      PILOT_DEPLOYMENT_PROFILE: "local-wallet",
      SESSION_SECRET: SECRET,
    })).toThrow("NEAR wallet proof replay protection is unavailable.");
  });

  it("sends only a nonce digest, namespace, opaque scope, and expiry", async () => {
    const consumeWalletProof = vi.fn().mockResolvedValue({ consumed: true });
    const consumer = new HarborWalletActionProofConsumer(
      { consumeWalletProof }, "chat", "c".repeat(64),
    );
    const nonce = "sensitive-wallet-proof-nonce";
    await expect(consumer.consume(nonce, SESSION.expiresAt, 1_799_999_000_000)).resolves.toBe(true);
    expect(consumeWalletProof).toHaveBeenCalledWith({
      version: 1,
      namespace: "chat",
      scopeId: "c".repeat(64),
      nonceDigest: createHash("sha256").update(nonce).digest("hex"),
      expiresAtMs: SESSION.expiresAt,
    });
    expect(JSON.stringify(consumeWalletProof.mock.calls)).not.toContain(nonce);
    expect(JSON.stringify(consumeWalletProof.mock.calls)).not.toContain(SESSION.account);
  });

  it("fails closed without retrying an uncertain remote consume", async () => {
    const consumeWalletProof = vi.fn().mockRejectedValue(new Error("unavailable"));
    const consumer = new HarborWalletActionProofConsumer(
      { consumeWalletProof }, "wallet-auth", "c".repeat(64),
    );
    await expect(consumer.consume("nonce", SESSION.expiresAt, 1_799_999_000_000))
      .rejects.toThrow("unavailable");
    expect(consumeWalletProof).toHaveBeenCalledTimes(1);
  });

  it("selects the remote consumer only for a fully configured hosted profile", () => {
    const remote = createWalletActionProofConsumer(SESSION, "chat", {
      HARBOR_URL: "https://harbor.example",
      PILOT_DEPLOYMENT_PROFILE: "hosted",
      PILOT_HOSTED_STATE_API_KEY: `pilot-state:${"T".repeat(32)}`,
      SESSION_SECRET: SECRET,
    }, { fetch: vi.fn<typeof fetch>() });
    expect(remote).toBeInstanceOf(HarborWalletActionProofConsumer);

    for (const environment of [
      { HARBOR_URL: "https://harbor.example", PILOT_DEPLOYMENT_PROFILE: "hosted",
        SESSION_SECRET: SECRET },
      { HARBOR_URL: "https://harbor.example", PILOT_DEPLOYMENT_PROFILE: "hosted",
        HARBOR_API_KEY: `broad:${"T".repeat(32)}`, SESSION_SECRET: SECRET },
      { HARBOR_URL: "https://harbor.example", PILOT_DEPLOYMENT_PROFILE: "hosted",
        PILOT_HOSTED_STATE_API_KEY: `pilot-state:${"T".repeat(32)}`, SESSION_SECRET: "short" },
    ]) {
      expect(() => createWalletActionProofConsumer(SESSION, "chat", environment))
        .toThrow();
    }
  });

  it("retains the local file consumer for the two local profiles", () => {
    for (const profile of ["local-wallet", "local-wallet-isolated-v1"] as const) {
      const consumer = createWalletActionProofConsumer(SESSION, "chat", {
        PILOT_DEPLOYMENT_PROFILE: profile,
        P_LIVE_RLUSD_ACQUISITION_STATE_DIR: "/private/local-state",
      });
      expect(consumer).not.toBeInstanceOf(HarborWalletActionProofConsumer);
    }
  });
});
