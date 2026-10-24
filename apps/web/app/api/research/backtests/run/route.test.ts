import { describe, expect, it, vi } from "vitest";

import { BacktestPipelineError } from "../../../../../components/backtests/integration/server";

import {
  BacktestQuotaError,
  type BacktestAccessScope,
  type BacktestExternalReadQuota,
} from "./access-control";
import { createBacktestRunPostHandler } from "./handler";

const SCOPE: BacktestAccessScope = {
  accountScopeId: "a".repeat(64),
  sessionScopeId: "s".repeat(64),
  network: "testnet",
  sessionExpiresAt: 60_000,
};

const VALID_INPUT = {
  startDay: "2025-01-01",
  endDay: "2025-01-10",
  outOfSampleStartDay: "2025-01-06",
  initialBase: "1000",
  initialQuote: "1000",
  targetBaseBps: 5_000,
  bandBps: 500,
  maxTradeQuote: "250",
  spreadBps: 10,
  venueFeeBps: 10,
  slippageBps: 25,
  networkCostQuote: "0.01",
  embargoBars: 1,
  hypothesis: "A frozen bounded allocation band is evaluated out of sample.",
};

function dependencies(overrides: Partial<{
  authenticate: () => BacktestAccessScope | null;
  quota: BacktestExternalReadQuota;
}> = {}) {
  return {
    authenticate: overrides.authenticate ?? (() => SCOPE),
    quota: overrides.quota ?? { reserve: vi.fn() },
    now: () => 1_000,
  };
}

describe("backtest run API", () => {
  it("returns private no-store JSON from the injected deterministic runner", async () => {
    const run = vi.fn(async () => ({ version: 1, viewModel: {}, savedRun: {}, chatEvidence: {} }) as never);
    const quota = { reserve: vi.fn() };
    const response = await createBacktestRunPostHandler(run, dependencies({ quota }))(new Request("http://local/api/research/backtests/run", {
      method: "POST",
      body: JSON.stringify(VALID_INPUT),
      headers: { "Content-Type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(quota.reserve).toHaveBeenCalledWith(SCOPE, 1_000);
    expect(run).toHaveBeenCalledWith(VALID_INPUT, SCOPE);
  });

  it("keeps signed-out research bundled-demo-only without reserving quota or running", async () => {
    const run = vi.fn(async () => ({} as never));
    const quota = { reserve: vi.fn() };
    const response = await createBacktestRunPostHandler(run, dependencies({
      authenticate: () => null,
      quota,
    }))(new Request("http://local/api/research/backtests/run", { method: "POST", body: JSON.stringify(VALID_INPUT) }));
    expect(response.status).toBe(401);
    expect(await response.text()).toMatch(/signed-out research remains bundled demo only/i);
    expect(quota.reserve).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("awaits an injected durable quota reservation before starting the runner", async () => {
    let release!: () => void;
    const quotaReady = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async () => ({ version: 1, viewModel: {}, savedRun: {}, chatEvidence: {} }) as never);
    const pending = createBacktestRunPostHandler(run, dependencies({
      quota: { reserve: () => quotaReady },
    }))(new Request("http://local/api/research/backtests/run", { method: "POST", body: JSON.stringify(VALID_INPUT) }));
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    release();
    expect((await pending).status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    [new BacktestQuotaError("QUOTA_EXHAUSTED", "exhausted"), 429],
    [new BacktestQuotaError("QUOTA_UNAVAILABLE", "unavailable"), 503],
    [new Error("unexpected quota failure"), 503],
  ] as const)("fails closed before external reads when quota rejects", async (error, status) => {
    const run = vi.fn(async () => ({} as never));
    const response = await createBacktestRunPostHandler(run, dependencies({
      quota: { reserve: () => { throw error; } },
    }))(new Request("http://local/api/research/backtests/run", { method: "POST", body: JSON.stringify(VALID_INPUT) }));
    expect(response.status).toBe(status);
    expect(await response.text()).toMatch(/no external historical data was requested/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("maps validation, simulation, and provider failures without fixture output", async () => {
    for (const [error, status] of [
      [new BacktestPipelineError("INVALID_REQUEST", "bad input"), 400],
      [new BacktestPipelineError("SIMULATION_REJECTED", "bad simulation"), 422],
      [new BacktestPipelineError("PROVIDER_UNAVAILABLE", "provider failed"), 503],
    ] as const) {
      const response = await createBacktestRunPostHandler(async () => { throw error; }, dependencies())(new Request("http://local/api/research/backtests/run", {
        method: "POST",
        body: JSON.stringify(VALID_INPUT),
      }));
      expect(response.status).toBe(status);
      if (status === 503) expect(await response.text()).toMatch(/No fixture result was substituted/i);
    }
  });

  it("rejects malformed and oversized bodies before the runner", async () => {
    const run = vi.fn(async () => ({} as never));
    const quota = { reserve: vi.fn() };
    const handler = createBacktestRunPostHandler(run, dependencies({ quota }));
    const malformed = await handler(new Request("http://local/api/research/backtests/run", { method: "POST", body: "{" }));
    expect(malformed.status).toBe(400);
    const schemaInvalid = await handler(new Request("http://local/api/research/backtests/run", { method: "POST", body: "{}" }));
    expect(schemaInvalid.status).toBe(400);
    const oversized = await handler(new Request("http://local/api/research/backtests/run", {
      method: "POST",
      body: JSON.stringify({ value: "x".repeat(17_000) }),
    }));
    expect(oversized.status).toBe(413);
    expect(quota.reserve).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
