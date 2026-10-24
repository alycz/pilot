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

const RLUSD = {
  currency: "524C555344000000000000000000000000000000",
  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
} as const;

function declarativeDraft() {
  return {
    kind: "declarative_strategy_v1",
    semantics_version: "harbor.declarative-strategy/1",
    issued_asset: RLUSD,
    plan: {
      plan_version: "1",
      trigger: { kind: "interval", interval_seconds: 3600 },
      rules: [{
        rule_id: "hourly-dca",
        all: [{ kind: "always" }],
        action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "5" },
      }],
      fallback: { kind: "hold" },
    },
    limits: {
      max_order_value: "5", max_daily_value: "10", max_cumulative_value: "50",
      min_order_value: "1", max_fee_drops: "20", max_daily_fee_drops: "100",
      max_cumulative_fee_drops: "500", max_daily_trades: 2, max_total_trades: 10,
      cumulative_scope: "owner_network_asset_lifetime",
      max_slippage_bps: 100, max_price_impact_bps: 100,
      min_xrp_reserve_drops: "12000000", fee_buffer_drops: "1000000",
      max_xrp_exposure_drops: "100000000", max_issued_exposure: "100",
      min_liquidity_value: "25", cooldown_seconds: 300,
      max_quote_age_seconds: 30, max_ledger_gap: 2,
    },
    execution_mode: "offer_create_fok",
    not_before: "2026-10-23T00:00:00.000Z",
    expires_at: "2026-10-30T00:00:00.000Z",
  };
}

function capabilities() {
  return {
    network: "testnet",
    assets: [{ currency: "XRP" }, RLUSD],
    trigger_kinds: ["interval"],
    condition_kinds: ["always", "price_threshold", "xrp_allocation_outside"],
    action_kinds: ["fixed_swap", "target_allocation"],
    execution_mode: "offer_create_fok",
    max_rules: 8,
    max_conditions_per_rule: 8,
    max_actions_per_evaluation: 1,
  };
}

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

  it("server-binds declarative validation scope without creating authority", async () => {
    const normalized = { ...declarativeDraft(), account: ACCOUNT, network: "testnet" };
    const invoke = vi.fn(async () => ({
      ok: true,
      data: {
        valid: true,
        semantics_version: "harbor.declarative-strategy/1",
        capabilities: capabilities(),
        errors: [],
        plan_digest: "A".repeat(64),
        normalized_proposal: normalized,
      },
      asOf: "2026-10-23T00:00:00.000Z",
      asOfBasis: "offline fixture",
    }));
    const handle = createStrategyRouteHandler({ env: ENV, invoke: invoke as never });
    const response = await handle(walletRequest(declarativeDraft()), "validate");

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith("strategy.validate", normalized);
    expect(invoke).not.toHaveBeenCalledWith("strategy.create", expect.anything());
  });

  it("server-binds paper observation scope and rejects nested account injection", async () => {
    const observation = {
      xrp_balance_drops: "50000000", issued_balance: "50", bid: "0.5", ask: "0.51",
      executable_liquidity_value: "500", fee_drops: "12", reserve_base_drops: "10000000",
      reserve_increment_drops: "2000000", owner_count: 1, daily_value_used: "0",
      cumulative_value_used: "0", daily_fee_drops_used: "0", cumulative_fee_drops_used: "0",
      daily_trades_used: 0, total_trades_used: 0, ledger_index: 100, quote_ledger_index: 100,
      observed_at: "2026-10-23T00:00:00.000Z", global_kill: false,
      unresolved_execution: false, grant_active: true, policy_active: true,
    };
    const preview = {
      boundary: "paper_only", ledger_acceptance: "not_tested",
      semantics_version: "harbor.declarative-strategy/1", plan_digest: "A".repeat(64),
      outcome: "order", action: "buy_xrp", matched_rule_id: "hourly-dca",
      proposed_value: "5", price_basis: "ask", price_value: "0.51", hold_codes: [],
      explanation: "Fixture-only first-match preview.", evaluated_at: "2026-10-23T00:00:00.000Z",
      observed_at: "2026-10-23T00:00:00.000Z", quote_ledger_index: 100,
    };
    const invoke = vi.fn(async () => ({ ok: true, data: preview, asOf: preview.observed_at, asOfBasis: "fixture" }));
    const handle = createStrategyRouteHandler({ env: ENV, invoke: invoke as never });
    const body = { proposal: declarativeDraft(), observation, at: "2026-10-23T00:00:00.000Z" };
    const response = await handle(walletRequest(body), "simulate");
    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith("strategy.simulate", {
      proposal: { ...declarativeDraft(), account: ACCOUNT, network: "testnet" },
      observation: { ...observation, account: ACCOUNT, network: "testnet", issued_asset: RLUSD },
      at: body.at,
    });

    const injected = await handle(walletRequest({
      ...body, observation: { ...observation, account: Wallet.generate().classicAddress },
    }), "simulate");
    expect(injected.status).toBe(400);
    expect(invoke).toHaveBeenCalledTimes(1);
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
