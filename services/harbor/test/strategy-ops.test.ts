import { describe, expect, it } from "vitest";

import type {
  Strategy,
  StrategyAuditEvent,
  StrategyAuthorizeArgs,
  StrategyCreateArgs,
  StrategyKillSwitch,
} from "../src/contracts";
import {
  handleStrategyAudit,
  handleStrategyAuthorize,
  handleStrategyCreate,
  handleStrategyGet,
  handleStrategyGlobalKillSet,
  handleStrategyKill,
  handleStrategyList,
  handleStrategyPause,
  handleStrategyResume,
  ops,
  type StrategyOpsStore,
} from "../src/ops/strategy";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const OTHER_OWNER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const CURRENCY = "524C555344000000000000000000000000000000";
const DIGEST = "AB".repeat(32);
const NOW = new Date("2026-10-22T00:00:00.000Z");
const EXPIRES = "2026-10-23T00:00:00.000Z";

const createArgs: StrategyCreateArgs = {
  kind: "xrp_issued_rebalancer_v1",
  network: "testnet",
  account: OWNER,
  issued_asset: { currency: CURRENCY, issuer: ISSUER },
  allocation: {
    target_xrp_bps: 5_000,
    lower_xrp_bps: 4_500,
    upper_xrp_bps: 5_500,
  },
  limits: {
    max_order_value: "25",
    max_daily_value: "100",
    min_order_value: "1",
    max_fee_drops: "20",
    max_slippage_bps: 100,
    max_price_impact_bps: 100,
    min_xrp_reserve_drops: "12000000",
    fee_buffer_drops: "1000",
    max_xrp_exposure_drops: "1000000000",
    max_issued_exposure: "1000",
    min_liquidity_value: "50",
    cooldown_seconds: 300,
    max_quote_age_seconds: 20,
    max_ledger_gap: 1,
  },
  interval_seconds: 300,
  execution_mode: "offer_create_fok",
  not_before: NOW.toISOString(),
  expires_at: EXPIRES,
};

function authorization(id = "authorization:1") {
  return {
    authorization_id: id,
    method: "wallet_action_proof_v1" as const,
    owner: OWNER,
    mandate_digest: DIGEST,
    mandate_version: 1,
    approved_at: NOW.toISOString(),
    expires_at: "2026-10-22T00:05:00.000Z",
  };
}

function strategy(lifecycle: Strategy["lifecycle"] = "draft"): Strategy {
  const approved = lifecycle !== "draft";
  return {
    strategy_id: "strategy:1",
    lifecycle,
    mandate: {
      mandate_id: "mandate:1",
      strategy_id: "strategy:1",
      version: 1,
      digest: DIGEST,
      status: approved ? "approved" : "draft",
      kind: "xrp_issued_rebalancer_v1",
      network: "testnet",
      account: OWNER,
      issued_asset: { currency: CURRENCY, issuer: ISSUER },
      allocation: createArgs.allocation,
      limits: createArgs.limits,
      schedule: {
        interval_seconds: 300,
        next_evaluation_at: NOW.toISOString(),
      },
      execution_mode: "offer_create_fok",
      not_before: NOW.toISOString(),
      expires_at: EXPIRES,
      ...(approved ? { authorization: authorization() } : {}),
    },
    generation: 1,
    ...(lifecycle === "active"
      ? { next_evaluation_at: NOW.toISOString() }
      : {}),
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

class MemoryStrategyStore implements StrategyOpsStore {
  value: Strategy = strategy();
  killSwitch: StrategyKillSwitch = {
    enabled: true,
    reason: "Not activated",
    updated_at: NOW.toISOString(),
  };
  calls: string[] = [];
  receipts = new Map<string, { operation: string; digest: string; result: unknown }>();

  async runControlOnce<T>(
    requestId: string,
    operation: string,
    digest: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const current = this.receipts.get(requestId);
    if (current) {
      if (current.operation !== operation || current.digest !== digest) {
        throw new Error("control request id conflict");
      }
      return current.result as T;
    }
    const result = await action();
    this.receipts.set(requestId, { operation, digest, result });
    return result;
  }

  async createDraft(args: StrategyCreateArgs): Promise<Strategy> {
    this.calls.push(`create:${args.account}`);
    return {
      ...this.value,
      mandate: {
        ...this.value.mandate,
        account: args.account,
        network: args.network,
      },
    };
  }

  async getStrategy(strategyId: string): Promise<Strategy | null> {
    this.calls.push(`get:${strategyId}`);
    return strategyId === this.value.strategy_id ? this.value : null;
  }

  async listStrategies(owner?: string): Promise<Strategy[]> {
    this.calls.push(`list:${owner ?? "*"}`);
    return owner === undefined || owner === OWNER ? [this.value] : [];
  }

  async authorizeAndActivate(args: StrategyAuthorizeArgs): Promise<Strategy> {
    this.calls.push(`authorize:${args.strategy_id}`);
    this.value = strategy("active");
    return this.value;
  }

  async pause(strategyId: string, _now: Date, reason?: string): Promise<Strategy> {
    this.calls.push(`pause:${strategyId}:${reason}`);
    this.value = strategy("paused");
    return this.value;
  }

  async resume(strategyId: string): Promise<Strategy> {
    this.calls.push(`resume:${strategyId}`);
    this.value = strategy("active");
    return this.value;
  }

  async stop(strategyId: string): Promise<Strategy> {
    this.calls.push(`stop:${strategyId}`);
    this.value = strategy("stopped");
    return this.value;
  }

  async kill(strategyId: string, _now: Date, reason: string): Promise<Strategy> {
    this.calls.push(`kill:${strategyId}:${reason}`);
    this.value = strategy("stopped");
    return this.value;
  }

  async getGlobalKill(
    owner: string,
    network: "testnet",
  ): Promise<StrategyKillSwitch> {
    this.calls.push(`global:get:${owner}:${network}`);
    return this.killSwitch;
  }

  async setGlobalKill(
    owner: string,
    network: "testnet",
    enabled: boolean,
    reason: string,
  ): Promise<StrategyKillSwitch> {
    this.calls.push(`global:set:${owner}:${network}:${enabled}`);
    this.killSwitch = {
      enabled,
      reason,
      updated_at: NOW.toISOString(),
    };
    return this.killSwitch;
  }

  async listAudit(
    strategyId: string,
    limit?: number,
  ): Promise<StrategyAuditEvent[]> {
    this.calls.push(`audit:${strategyId ?? "*"}:${limit ?? "default"}`);
    return [
      {
        event_id: "event:1",
        strategy_id: "strategy:1",
        actor: "owner",
        kind: "created",
        detail: { lifecycle: "draft" },
        at: NOW.toISOString(),
      },
    ];
  }
}

function context(store: MemoryStrategyStore) {
  return {
    principal: "pilot:test",
    strategyServices: { store, now: () => NOW },
  };
}

describe("strategy operations", () => {
  it("registers only owner-facing operations and no browser-callable tick", () => {
    expect(ops.map(({ name }) => name)).toEqual([
      "strategy.create",
      "strategy.list",
      "strategy.get",
      "strategy.audit",
      "strategy.authorize",
      "strategy.pause",
      "strategy.resume",
      "strategy.stop",
      "strategy.kill",
      "strategy.globalKill.get",
      "strategy.globalKill.set",
    ]);
    expect(ops.some(({ name }) => /tick|lease|reconcil|reserve/i.test(name))).toBe(
      false,
    );
  });

  it("creates a non-authorizing exact Testnet draft", async () => {
    const store = new MemoryStrategyStore();
    const result = await handleStrategyCreate(context(store), {
      ...createArgs,
      request_id: "request:create:1",
    });
    expect(result.lifecycle).toBe("draft");
    expect(result.mandate.issued_asset).toEqual({
      currency: CURRENCY,
      issuer: ISSUER,
    });
    expect(store.calls).toEqual([`create:${OWNER}`]);

    await expect(
      handleStrategyCreate(context(store), {
        ...createArgs,
        network: "mainnet",
        request_id: "request:create:2",
      } as never),
    ).rejects.toThrow();
    expect(store.calls).toHaveLength(1);
  });

  it("binds every read to the exact owner and Testnet scope", async () => {
    const store = new MemoryStrategyStore();
    await expect(
      handleStrategyList(context(store), {
        owner: OTHER_OWNER,
        network: "testnet",
      }),
    ).resolves.toEqual([]);
    await expect(
      handleStrategyGet(context(store), {
        strategy_id: "strategy:1",
        owner: OTHER_OWNER,
        network: "testnet",
      }),
    ).rejects.toThrow("strategy not found");
    await expect(
      handleStrategyAudit(context(store), {
        strategy_id: "strategy:1",
        owner: OTHER_OWNER,
        network: "testnet",
      }),
    ).rejects.toThrow("strategy not found");
    await expect(
      handleStrategyAudit(context(store), {
        owner: OWNER,
        network: "testnet",
      } as never),
    ).rejects.toThrow();
    expect(store.calls).not.toContain("audit:*:default");
  });

  it("activates only the current immutable mandate with fresh owner authorization", async () => {
    const store = new MemoryStrategyStore();
    await expect(
      handleStrategyAuthorize(context(store), {
        strategy_id: "strategy:1",
        owner: OWNER,
        network: "testnet",
        mandate_version: 2,
        mandate_digest: DIGEST,
        authorization: { ...authorization(), mandate_version: 2 },
        request_id: "request:authorize:bad",
      }),
    ).rejects.toThrow("does not bind");
    expect(store.calls).not.toContain("authorize:strategy:1");

    const result = await handleStrategyAuthorize(context(store), {
      strategy_id: "strategy:1",
      owner: OWNER,
      network: "testnet",
      mandate_version: 1,
      mandate_digest: DIGEST,
      authorization: authorization(),
      request_id: "request:authorize:1",
    });
    expect(result.lifecycle).toBe("active");
    expect(store.calls).toContain("authorize:strategy:1");
  });

  it("rejects expired authorization before resume", async () => {
    const store = new MemoryStrategyStore();
    store.value = strategy("paused");
    await expect(
      handleStrategyResume(context(store), {
        strategy_id: "strategy:1",
        owner: OWNER,
        network: "testnet",
        mandate_version: 1,
        mandate_digest: DIGEST,
        authorization: {
          ...authorization("authorization:resume"),
          approved_at: "2026-10-21T23:55:00.000Z",
          expires_at: "2026-10-21T23:59:59.000Z",
        },
        request_id: "request:resume:expired",
      }),
    ).rejects.toThrow("expired");
    expect(store.calls).not.toContain("resume:strategy:1");
  });

  it("keeps pause and kill risk-reducing and preserves explicit reasons", async () => {
    const store = new MemoryStrategyStore();
    store.value = strategy("active");
    const paused = await handleStrategyPause(context(store), {
      strategy_id: "strategy:1",
      owner: OWNER,
      network: "testnet",
      reason: "Review limits",
      request_id: "request:pause:1",
    });
    expect(paused.lifecycle).toBe("paused");
    expect(store.calls).toContain("pause:strategy:1:Review limits");

    const killed = await handleStrategyKill(context(store), {
      strategy_id: "strategy:1",
      owner: OWNER,
      network: "testnet",
      reason: "Emergency stop",
      request_id: "request:kill:1",
    });
    expect(killed.lifecycle).toBe("stopped");
    expect(store.calls).toContain("kill:strategy:1:Emergency stop");
  });

  it("requires fresh exact authorization to clear, but not enable, global kill", async () => {
    const store = new MemoryStrategyStore();
    await handleStrategyGlobalKillSet(context(store), {
      owner: OWNER,
      network: "testnet",
      enabled: true,
      reason: "Emergency stop",
      request_id: "request:global:on",
    });
    expect(store.killSwitch.enabled).toBe(true);

    await expect(
      handleStrategyGlobalKillSet(context(store), {
        owner: OWNER,
        network: "testnet",
        enabled: false,
        reason: "Resume",
        request_id: "request:global:bad",
      }),
    ).rejects.toThrow();
    expect(
      store.calls.filter((call) => call.endsWith(":false")),
    ).toHaveLength(0);

    await handleStrategyGlobalKillSet(context(store), {
      owner: OWNER,
      network: "testnet",
      enabled: false,
      reason: "Owner approved restart",
      strategy_id: "strategy:1",
      mandate_version: 1,
      mandate_digest: DIGEST,
      authorization: authorization("authorization:global-clear"),
      request_id: "request:global:off",
    });
    expect(store.killSwitch.enabled).toBe(false);
  });

  it("replays one durable control receipt and rejects request-id conflicts", async () => {
    const store = new MemoryStrategyStore();
    store.value = strategy("active");
    const request = {
      strategy_id: "strategy:1",
      owner: OWNER,
      network: "testnet" as const,
      reason: "Review limits",
      request_id: "request:pause:stable",
    };
    await handleStrategyPause(context(store), request);
    await handleStrategyPause(context(store), request);
    expect(
      store.calls.filter((call) => call === "pause:strategy:1:Review limits"),
    ).toHaveLength(1);

    await expect(
      handleStrategyPause(context(store), {
        ...request,
        reason: "Different mutation",
      }),
    ).rejects.toThrow("conflict");
  });

  it("namespaces the same caller request id across wallet owners", async () => {
    const store = new MemoryStrategyStore();
    const request_id = "request:create:shared";
    await handleStrategyCreate(context(store), { ...createArgs, request_id });
    await handleStrategyCreate(context(store), {
      ...createArgs,
      account: OTHER_OWNER,
      request_id,
    });
    expect(store.calls).toContain(`create:${OWNER}`);
    expect(store.calls).toContain(`create:${OTHER_OWNER}`);
    expect(store.receipts).toHaveLength(2);
  });
});
