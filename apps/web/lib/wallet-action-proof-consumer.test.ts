import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  HarborWalletActionProofConsumer,
  createWalletActionProofConsumer,
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
