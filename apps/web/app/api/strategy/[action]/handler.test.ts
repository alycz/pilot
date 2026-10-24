import { afterEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";

import { issueStrategyChallenge, type StrategyProofAction } from "../../../../lib/strategy-mandate-proof";
import { WALLET_SESSION_COOKIE, sealWalletSession } from "../../../../lib/wallet-session";
import { createStrategyRouteHandler } from "./handler";

const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const SECRET = "strategy-route-test-secret-with-at-least-thirty-two-characters";
const ENV = {
  EXEC_NETWORK: "testnet",
  PILOT_DEPLOYMENT_PROFILE: "hosted",
  PILOT_PUBLIC_ORIGIN: "https://pilot.example",
};

afterEach(() => vi.unstubAllEnvs());

function walletRequest(
  body: Record<string, unknown>,
  options: { account?: string; network?: "testnet" | "devnet"; origin?: string; fetchSite?: string } = {},
): Request {
  vi.stubEnv("SESSION_SECRET", SECRET);
  const cookie = sealWalletSession({
    version: 1,
    account: options.account ?? ACCOUNT,
    network: options.network ?? "testnet",
    expiresAt: Date.now() + 60_000,
  }, SECRET, ENV);
  return new Request("https://pilot.example/api/strategy/pause", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${WALLET_SESSION_COOKIE}=${cookie}`,
      origin: options.origin ?? "https://pilot.example",
      "sec-fetch-site": options.fetchSite ?? "same-origin",
    },
    body: JSON.stringify(body),
  });
}

function clearProof(wallet: Wallet, action: StrategyProofAction = "clear_global_kill") {
  const mandateExpiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const challenge = issueStrategyChallenge({
    version: 1, account: wallet.classicAddress, network: "testnet", expiresAt: Date.now() + 60_000,
  }, {
    action,
    strategyId: "strategy-test-001",
    mandateVersion: 3,
    mandateDigest: "A".repeat(64),
    mandateExpiresAt,
    requestId: "request-clear-global-001",
  }, { secret: SECRET });
  return {
    strategy_id: "strategy-test-001",
    mandate_version: 3,
    mandate_digest: "A".repeat(64),
    mandate_expires_at: mandateExpiresAt,
    challenge_token: challenge.token,
    tx_blob: wallet.sign(challenge.txJson as never).tx_blob,
    request_id: "request-clear-global-001",
  };
}

describe("strategy API allowlist", () => {
  it.each(["global-kill", "global-kill-set", "tick", "lease", "reconcile"])(
    "does not expose %s through the wallet-scoped API",
    async (action) => {
      const invoke = vi.fn();
      const handle = createStrategyRouteHandler({ invoke });
      const response = await handle(new Request("https://pilot.test/api/strategy/blocked", {
        method: "POST",
      }), action);

      expect(response.status).toBe(404);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("derives owner and Testnet scope from the wallet session and forwards one stable request id", async () => {
    const invoke = vi.fn(async () => ({
      ok: false,
      error: { service: "harbor", kind: "error", code: "PAUSED", message: "fixture" },
    }));
    const handle = createStrategyRouteHandler({ env: ENV, invoke: invoke as never });
    const response = await handle(walletRequest({
      strategy_id: "strategy-test-001", reason: "Owner pause", request_id: "request-pause-001",
    }), "pause");

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("strategy.pause", {
      strategy_id: "strategy-test-001",
      reason: "Owner pause",
      request_id: "request-pause-001",
      owner: ACCOUNT,
      network: "testnet",
    });
  });

  it("rejects browser-supplied owner scope before any Harbor call", async () => {
    const invoke = vi.fn();
    const handle = createStrategyRouteHandler({ env: ENV, invoke: invoke as never });
    const response = await handle(walletRequest({
      strategy_id: "strategy-test-001", reason: "Owner pause", request_id: "request-pause-001",
      owner: ACCOUNT,
    }), "pause");

    expect(response.status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("fails closed when an upstream read returns another strategy scope", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      data: {
        strategy_id: "strategy-other-tenant",
        mandate: { account: ACCOUNT, network: "testnet" },
      },
    }));
    const handle = createStrategyRouteHandler({ env: ENV, invoke: invoke as never });
    const response = await handle(walletRequest({ strategy_id: "strategy-test-001" }), "get");

    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("STRATEGY_STATUS_UNAVAILABLE");
  });

  it("reads and projects the global kill switch in the wallet-derived scope", async () => {
    const killSwitch = { enabled: true, reason: "Owner emergency stop", updated_at: "2026-10-23T00:00:00.000Z" };
    const invoke = vi.fn(async () => ({
      ok: true, data: killSwitch, asOf: "2026-10-23T00:00:00.000Z", asOfBasis: "server",
    }));
    const handle = createStrategyRouteHandler({ env: ENV, invoke: invoke as never });
    const response = await handle(walletRequest({}), "global-kill-get");

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith("strategy.globalKill.get", { owner: ACCOUNT, network: "testnet" });
    expect((await response.json()).data).toEqual({ owner: ACCOUNT, network: "testnet", kill_switch: killSwitch });
  });

  it("enables the global kill without a signature while preserving the explicit reason and request id", async () => {
    const killSwitch = { enabled: true, reason: "Owner emergency stop", updated_at: "2026-10-23T00:00:00.000Z" };
    const invoke = vi.fn(async () => ({ ok: true, data: killSwitch, asOf: "now", asOfBasis: "server" }));
    const handle = createStrategyRouteHandler({ env: ENV, invoke: invoke as never });
    const response = await handle(walletRequest({
      reason: "Owner emergency stop", request_id: "request-enable-global-001",
    }), "global-kill-enable");

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith("strategy.globalKill.set", {
      owner: ACCOUNT,
      network: "testnet",
      enabled: true,
      reason: "Owner emergency stop",
      request_id: "request-enable-global-001",
    });
  });

  it("clears the global kill only with an exact mandate-bound wallet proof", async () => {
    const wallet = Wallet.generate();
    const proof = clearProof(wallet);
    const killSwitch = { enabled: false, reason: "Cleared by owner wallet proof", updated_at: "2026-10-23T00:00:00.000Z" };
    const invoke = vi.fn(async () => ({ ok: true, data: killSwitch, asOf: "now", asOfBasis: "server" }));
    const handle = createStrategyRouteHandler({ env: ENV, invoke: invoke as never });
    const response = await handle(walletRequest(proof, { account: wallet.classicAddress }), "global-kill-clear");

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith("strategy.globalKill.set", expect.objectContaining({
      owner: wallet.classicAddress,
      network: "testnet",
      enabled: false,
      reason: "Cleared by owner wallet proof",
      strategy_id: proof.strategy_id,
      mandate_version: proof.mandate_version,
      mandate_digest: proof.mandate_digest,
      request_id: proof.request_id,
      authorization: expect.objectContaining({
        method: "wallet_action_proof_v1",
        owner: wallet.classicAddress,
        mandate_version: proof.mandate_version,
        mandate_digest: proof.mandate_digest,
      }),
    }));
  });

  it.each([
    ["action", (_proof: ReturnType<typeof clearProof>, wallet: Wallet) => clearProof(wallet, "activate")],
    ["version", (proof: ReturnType<typeof clearProof>, _wallet: Wallet) => ({ ...proof, mandate_version: proof.mandate_version + 1 })],
    ["digest", (proof: ReturnType<typeof clearProof>, _wallet: Wallet) => ({ ...proof, mandate_digest: "B".repeat(64) })],
    ["request", (proof: ReturnType<typeof clearProof>, _wallet: Wallet) => ({ ...proof, request_id: "request-clear-global-002" })],
  ])("rejects a global-kill clear with a mismatched %s binding", async (_name, mutate) => {
    const wallet = Wallet.generate();
    const proof = clearProof(wallet);
    const invoke = vi.fn();
    const handle = createStrategyRouteHandler({ env: ENV, invoke: invoke as never });
    const response = await handle(walletRequest(mutate(proof, wallet), { account: wallet.classicAddress }), "global-kill-clear");

    expect(response.status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects owner, session-network, CSRF, and extra-key mismatches before a global-kill mutation", async () => {
    const wallet = Wallet.generate();
    const proof = clearProof(wallet);
    const invoke = vi.fn();
    const handle = createStrategyRouteHandler({ env: ENV, invoke: invoke as never });
    const otherOwner = await handle(walletRequest(proof, { account: Wallet.generate().classicAddress }), "global-kill-clear");
    const wrongNetwork = await handle(walletRequest(proof, { account: wallet.classicAddress, network: "devnet" }), "global-kill-clear");
    const crossSite = await handle(walletRequest(proof, {
      account: wallet.classicAddress, origin: "https://attacker.example", fetchSite: "cross-site",
    }), "global-kill-clear");
    const extraKey = await handle(walletRequest({ ...proof, owner_hint: wallet.classicAddress }, {
      account: wallet.classicAddress,
    }), "global-kill-clear");

    expect([otherOwner.status, wrongNetwork.status, crossSite.status, extraKey.status]).toEqual([400, 401, 403, 400]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("preserves the request id for unknown or malformed global-kill mutation outcomes", async () => {
    const requestId = "request-enable-global-001";
    for (const result of [new Error("connection reset"), { ok: true, data: { enabled: "yes" } }]) {
      const invoke = vi.fn(async () => {
        if (result instanceof Error) throw result;
        return result;
      });
      const handle = createStrategyRouteHandler({ env: ENV, invoke: invoke as never });
      const response = await handle(walletRequest({ reason: "Owner emergency stop", request_id: requestId }), "global-kill-enable");
      expect(response.status).toBe(502);
      expect((await response.json()).error).toMatchObject({
        code: "STRATEGY_UPSTREAM_OUTCOME_UNKNOWN", request_id: requestId,
      });
    }
  });
});
