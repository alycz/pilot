import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpRegistry, type OpDef } from "../src/catalog/registry";
import { LOCAL_TRADING_SIGNING_PROFILE } from "../src/local-trading";
import { createWorker, type Env } from "../src/server";

const reviewedEnvironment: Env = {
  DB: {} as D1Database,
  HARBOR_API_KEYS: `trading-principal:${"A".repeat(32)}`,
  EXEC_NETWORK: "testnet",
  EXECUTOR: "quickjs",
  MAINNET_EXECUTION: "false",
  HARBOR_LOCAL_DEV: "true",
  HARBOR_LOCAL_READ_ONLY: "false",
  HARBOR_LOCAL_AUTH_REQUIRED: "true",
  HARBOR_LOCAL_CRON_DISABLED: "true",
  HARBOR_LOCAL_X402: "false",
  HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
  HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_SIGNING_PROFILE: LOCAL_TRADING_SIGNING_PROFILE,
  HARBOR_SOURCE_TAG: "2610240",
};

function swapFixture(): OpDef {
  return {
    name: "tx.swap",
    family: "tx",
    summary: "trading auth fixture",
    args: z.object({ network: z.literal("testnet") }).strict(),
    returns: "principal",
    caveats: [],
    example: 'await harbor.tx.swap({ network: "testnet" })',
    handler: (ctx) => ({ principal: ctx.principal }),
  };
}

describe("local trading server boundary", () => {
  it("requires the named bearer on every loopback spelling and preserves its principal", async () => {
    const worker = createWorker(new OpRegistry([swapFixture()]));
    for (const origin of [
      "http://127.0.0.1:8791",
      "http://localhost:8791",
      "http://[::1]:8791",
      "http://127.0.0.1:9123",
    ]) {
      const response = await worker.fetch!(
        new Request(`${origin}/api/ops/tx.swap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ network: "testnet" }),
        }),
        reviewedEnvironment,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(401);
    }

    const authorized = await worker.fetch!(
      new Request("http://127.0.0.1:8791/api/ops/tx.swap", {
        method: "POST",
        headers: {
          authorization: `Bearer trading-principal:${"A".repeat(32)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ network: "testnet" }),
      }),
      reviewedEnvironment,
      {} as ExecutionContext,
    );
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({
      ok: true,
      data: { principal: "trading-principal" },
    });
  });

  it.each([
    { HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "false" },
    { HARBOR_LOCAL_TRADING_SIGNING_PROFILE: "unreviewed" },
  ])("disables cron and auth bypass for malformed marker %j", async (marker) => {
    const environment = { ...reviewedEnvironment, ...marker };
    const worker = createWorker(new OpRegistry());
    const response = await worker.fetch!(
      new Request("http://127.0.0.1:8791/mcp", {
        method: "POST",
        body: "{}",
      }),
      environment,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
    await expect(
      worker.scheduled!(
        {} as ScheduledController,
        environment,
        {} as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps health unauthenticated and the x402 probe disabled", async () => {
    const worker = createWorker(new OpRegistry());
    const health = await worker.fetch!(
      new Request("http://127.0.0.1:8791/health"),
      reviewedEnvironment,
      {} as ExecutionContext,
    );
    expect(health.status).toBe(200);

    const probe = await worker.fetch!(
      new Request("http://127.0.0.1:8791/local/x402/probe"),
      reviewedEnvironment,
      {} as ExecutionContext,
    );
    expect(probe.status).toBe(404);
  });

  it("never invokes the x402 probe for mixed or malformed trading markers", async () => {
    const probeLocalX402 = vi.fn(async () => ({
      reachable: true,
      status: 402,
      contentType: "application/json",
    }));
    const worker = createWorker(new OpRegistry(), undefined, probeLocalX402);
    const response = await worker.fetch!(
      new Request("http://127.0.0.1:8791/local/x402/probe"),
      {
        ...reviewedEnvironment,
        HARBOR_LOCAL_X402: "true",
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "false",
        HARBOR_LOCAL_TRADING_SIGNING_PROFILE: "unreviewed",
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    expect(probeLocalX402).not.toHaveBeenCalled();
  });
});
