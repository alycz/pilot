import { describe, expect, it, vi } from "vitest";

import { OpRegistry } from "../src/catalog/registry";
import { LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE } from "../src/local-trading-onboarding";
import { createWorker, type Env } from "../src/server";

const onboardingEnvironment: Env = {
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
  HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE:
    LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
  HARBOR_SOURCE_TAG: "2610240",
};

describe("local trading onboarding server boundary", () => {
  it.each([
    onboardingEnvironment,
    {
      ...onboardingEnvironment,
      HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "false",
    },
    {
      ...onboardingEnvironment,
      HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
    },
  ])("requires bearer and disables cron under exact, malformed, or mixed markers", async (env) => {
    const worker = createWorker(new OpRegistry());
    const response = await worker.fetch!(
      new Request("http://127.0.0.1:8791/mcp", {
        method: "POST",
        body: "{}",
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
    await expect(
      worker.scheduled!(
        {} as ScheduledController,
        env,
        {} as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
  });

  it("returns 404 without invoking the x402 probe under mixed onboarding markers", async () => {
    const probeLocalX402 = vi.fn(async () => ({
      reachable: true,
      status: 402,
      contentType: "application/json",
    }));
    const worker = createWorker(new OpRegistry(), undefined, probeLocalX402);
    const response = await worker.fetch!(
      new Request("http://127.0.0.1:8791/local/x402/probe"),
      {
        ...onboardingEnvironment,
        HARBOR_LOCAL_X402: "true",
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "malformed",
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    expect(probeLocalX402).not.toHaveBeenCalled();
  });

  it("keeps only health unauthenticated", async () => {
    const worker = createWorker(new OpRegistry());
    const response = await worker.fetch!(
      new Request("http://127.0.0.1:8791/health"),
      onboardingEnvironment,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "harbor",
      health: "process",
      handoff_readiness: "not_evaluated",
    });
  });
});
