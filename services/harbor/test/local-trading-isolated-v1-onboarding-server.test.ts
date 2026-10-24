import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpRegistry, type OpDef } from "../src/catalog/registry";
import {
  LOCAL_TRADING_ISOLATED_ONBOARDING_V1_SIGNING_PROFILE,
  isLocalTradingIsolatedOnboardingV1Request,
} from "../src/local-trading-isolated-onboarding-v1";
import { createWorker, type Env } from "../src/server";

const bearer = `Bearer isolated-onboarding-principal:${"O".repeat(32)}`;

const isolatedOnboardingEnvironment: Env = {
  DB: {} as D1Database,
  HARBOR_API_KEYS: `isolated-onboarding-principal:${"O".repeat(32)}`,
  EXEC_NETWORK: "testnet",
  EXECUTOR: "quickjs",
  MAINNET_EXECUTION: "false",
  HARBOR_LOCAL_DEV: "true",
  HARBOR_LOCAL_READ_ONLY: "false",
  HARBOR_LOCAL_AUTH_REQUIRED: "true",
  HARBOR_LOCAL_CRON_DISABLED: "true",
  HARBOR_LOCAL_X402: "false",
  HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
  HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE:
    LOCAL_TRADING_ISOLATED_ONBOARDING_V1_SIGNING_PROFILE,
  HARBOR_SOURCE_TAG: "2610240",
};

function boundaryFixture(): OpDef {
  return {
    name: "account.status",
    family: "account",
    summary: "isolated onboarding server boundary fixture",
    args: z.object({ network: z.literal("testnet") }).strict(),
    returns: "request boundary context",
    caveats: [],
    example: 'await harbor.account.status({ network: "testnet" })',
    handler: (ctx) => ({
      principal: ctx.principal,
      localDevRequest: ctx.localDevRequest,
    }),
  };
}

function operationRequest(
  origin = "http://127.0.0.2:8791",
  headers: HeadersInit = {},
): Request {
  return new Request(`${origin}/api/ops/account.status`, {
    method: "POST",
    headers: {
      authorization: bearer,
      "content-type": "application/json",
      host: "127.0.0.2:8791",
      ...headers,
    },
    body: JSON.stringify({ network: "testnet" }),
  });
}

async function invoke(
  request: Request,
  env: Env = isolatedOnboardingEnvironment,
): Promise<Response> {
  return createWorker(new OpRegistry([boundaryFixture()])).fetch!(
    request,
    env,
    {} as ExecutionContext,
  );
}

async function expectLocalCapability(
  request: Request,
  expected: boolean,
  env: Env = isolatedOnboardingEnvironment,
): Promise<void> {
  const response = await invoke(request, env);
  expect(response.status).toBe(200);
  if (expected) {
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        principal: "isolated-onboarding-principal",
        localDevRequest: true,
      },
    });
  } else {
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  }
}

describe("local trading isolated v1 onboarding server boundary", () => {
  it("requires the named bearer at the exact isolated Harbor origin", async () => {
    const unauthorized = await invoke(
      new Request("http://127.0.0.2:8791/api/ops/account.status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network: "testnet" }),
      }),
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

    await expectLocalCapability(operationRequest(), true);
  });

  it("accepts only absent or exact same-origin browser metadata", async () => {
    await expectLocalCapability(
      operationRequest(undefined, {
        origin: "http://127.0.0.2:8791",
        "sec-fetch-site": "same-origin",
      }),
      true,
    );

    for (const headers of [
      { origin: "http://127.0.0.2:3003" },
      { origin: "http://127.0.0.1:8791" },
      { origin: "http://127.0.0.2:8791/" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "none" },
    ]) {
      await expectLocalCapability(operationRequest(undefined, headers), false);
    }
  });

  it.each([
    "http://127.0.0.1:8791",
    "http://localhost:8791",
    "http://[::1]:8791",
    "http://127.0.0.2:8792",
    "http://127.0.0.3:8791",
    "http://127.1.2.3:8791",
    "https://127.0.0.2:8791",
  ])("does not establish locality for %s", async (origin) => {
    await expectLocalCapability(operationRequest(origin), false);
  });

  it("rejects credentials, fragments, alternate IPv4, and forwarding metadata", async () => {
    const credentials = operationRequest();
    Object.defineProperty(credentials, "url", {
      configurable: true,
      value: "http://user:password@127.0.0.2:8791/api/ops/account.status",
    });
    await expectLocalCapability(credentials, false);

    await expectLocalCapability(
      new Request("http://127.0.0.2:8791/api/ops/account.status#fragment", {
        method: "POST",
        headers: {
          authorization: bearer,
          "content-type": "application/json",
          host: "127.0.0.2:8791",
        },
        body: JSON.stringify({ network: "testnet" }),
      }),
      false,
    );

    for (const name of [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-port",
      "x-forwarded-proto",
    ]) {
      await expectLocalCapability(
        operationRequest(undefined, { [name]: "127.0.0.2" }),
        false,
      );
    }
  });

  it.each([
    ["0177.0.0.2:8791", "http://0177.0.0.2:8791"],
    ["2130706434:8791", "http://2130706434:8791"],
    ["0x7f000002:8791", "http://0x7f000002:8791"],
    ["127.2:8791", "http://127.2:8791"],
  ])(
    "rejects alternate Host spelling %s after WHATWG URL canonicalization",
    async (host, origin) => {
      const request = operationRequest(origin, { host });
      expect(request.url).toBe(
        "http://127.0.0.2:8791/api/ops/account.status",
      );
      expect(
        isLocalTradingIsolatedOnboardingV1Request(
          request,
          isolatedOnboardingEnvironment,
        ),
      ).toBe(false);
      await expectLocalCapability(request, false);
    },
  );

  it("rejects missing, multiple, whitespace, case-altered, and wrong-port Host values", async () => {
    const missing = operationRequest();
    missing.headers.delete("host");

    const multiple = operationRequest();
    multiple.headers.append("host", "127.0.0.2:8791");

    for (const request of [
      missing,
      multiple,
      operationRequest(undefined, { host: "127.0.0.2 :8791" }),
      operationRequest(undefined, { host: "127.0.0.2: 8791" }),
      operationRequest(undefined, { host: "0X7F000002:8791" }),
      operationRequest(undefined, { host: "127.0.0.2:8792" }),
    ]) {
      expect(
        isLocalTradingIsolatedOnboardingV1Request(
          request,
          isolatedOnboardingEnvironment,
        ),
      ).toBe(false);
      await expectLocalCapability(request, false);
    }
  });

  it.each([
    {
      HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: undefined,
    },
    { HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: "false" },
    {
      HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE: undefined,
    },
    {
      HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE:
        "unreviewed",
    },
    { HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true" },
    { HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true" },
    { HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true" },
    { HARBOR_LOCAL_X402_SIGNING_PROFILE: "reviewed-testnet-local-v1" },
    { HARBOR_LOCAL_X402_MERCHANT_PAY_TO: "rMixedProfile" },
  ])("fails closed for partial, malformed, or mixed markers %j", async (change) => {
    const env = { ...isolatedOnboardingEnvironment, ...change };
    await expectLocalCapability(operationRequest(), false, env);

    const noBearer = new Request("http://127.0.0.1:8791/mcp", {
      method: "POST",
      body: "{}",
    });
    expect(
      await createWorker(new OpRegistry()).fetch!(
        noBearer,
        env,
        {} as ExecutionContext,
      ),
    ).toMatchObject({ status: 401 });
  });

  it("disables cron and x402 for exact and malformed isolated onboarding markers", async () => {
    const probeLocalX402 = vi.fn(async () => ({
      reachable: true,
      status: 402,
      contentType: "application/json",
    }));
    const worker = createWorker(new OpRegistry(), undefined, probeLocalX402);

    for (const env of [
      isolatedOnboardingEnvironment,
      {
        ...isolatedOnboardingEnvironment,
        HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED:
          "malformed",
        HARBOR_LOCAL_X402: "true",
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
      },
    ]) {
      const probe = await worker.fetch!(
        new Request("http://127.0.0.1:8791/local/x402/probe"),
        env,
        {} as ExecutionContext,
      );
      expect(probe.status).toBe(404);
      await expect(
        worker.scheduled!(
          {} as ScheduledController,
          env,
          {} as ExecutionContext,
        ),
      ).resolves.toBeUndefined();
    }
    expect(probeLocalX402).not.toHaveBeenCalled();
  });

  it("keeps health public without adding CORS authority", async () => {
    const health = await createWorker(new OpRegistry()).fetch!(
      new Request("http://127.0.0.2:8791/health", {
        headers: { origin: "http://127.0.0.2:3003" },
      }),
      isolatedOnboardingEnvironment,
      {} as ExecutionContext,
    );
    expect(health.status).toBe(200);
    expect(health.headers.get("access-control-allow-origin")).toBeNull();
  });
});
