import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpRegistry, type OpDef } from "../src/catalog/registry";
import {
  LOCAL_TRADING_ONBOARDING_NETWORK_DISABLED,
  LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST,
  LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED,
  createHarborProvider,
} from "../src/executor/providers";
import {
  LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
  LOCAL_TRADING_ISOLATED_ONBOARDING_V1_SIGNING_PROFILE,
} from "../src/local-trading-isolated-onboarding-v1";
import { LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE } from "../src/local-trading-isolated-v1";
import {
  LOCAL_TRADING_SIGNING_PROFILE,
  assertLocalTradingTestnet,
  localTradingSafetyMarkersPresent,
} from "../src/local-trading";
import { LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE } from "../src/local-trading-onboarding";

function operation(name: string, handler: OpDef["handler"]): OpDef {
  return {
    name,
    family: name.split(".")[0]!,
    summary: "isolated local trading onboarding boundary fixture",
    args: z.record(z.string(), z.unknown()),
    returns: "fixture",
    caveats: [],
    example: `await harbor.${name}({})`,
    handler,
  };
}

const reviewedEnvironment = {
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
} as const;

function context(env: Record<string, unknown> = reviewedEnvironment) {
  return {
    principal: "isolated-onboarding-principal",
    localDevRequest: true,
    env,
  };
}

describe("isolated local trading onboarding operation boundary", () => {
  it("exports the frozen profile and reuses exactly the onboarding allowlist", () => {
    expect(LOCAL_TRADING_ISOLATED_ONBOARDING_V1_SIGNING_PROFILE).toBe(
      "local-wallet-isolated-onboarding-v1",
    );
    expect(LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN).toBe(
      "local-trading-isolated-onboarding-v1",
    );
    expect([...LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST]).toEqual([
      "onboarding.readiness",
      "account.link",
      "account.status",
      "account.revoke",
      "ledger.account.info",
      "ledger.account.lines",
      "ledger.account.tx",
      "policy.get",
      "policy.set",
      "tx.trustSet",
      "tx.approvalPreflight",
      "tx.execute",
      "tx.submit",
      "tx.status",
    ]);
    expect(LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST.has("tx.swap")).toBe(
      false,
    );
  });

  it("participates in aggregate local-trading safety and testnet enforcement", () => {
    expect(localTradingSafetyMarkersPresent(reviewedEnvironment)).toBe(true);
    expect(() =>
      assertLocalTradingTestnet(context(), "devnet"),
    ).toThrow("Local trading profile permits only testnet state");
    expect(() =>
      assertLocalTradingTestnet(context(), "testnet"),
    ).not.toThrow();
  });

  it("admits exactly the reviewed onboarding operations", async () => {
    const allowed = vi.fn(() => ({ admitted: true }));
    const denied = vi.fn(() => ({ admitted: false }));
    const registry = new OpRegistry([
      ...[...LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST].map((name) =>
        operation(name, allowed),
      ),
      operation("tx.swap", denied),
      operation("account.future", denied),
      operation("x402.pay", denied),
    ]);
    const provider = createHarborProvider(registry, context());

    for (const name of LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST) {
      await expect(
        provider.invoke(name, { network: "testnet" }),
      ).resolves.toMatchObject({ ok: true });
    }
    expect(allowed).toHaveBeenCalledTimes(
      LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST.size,
    );

    for (const name of [
      "tx.swap",
      "account.future",
      "x402.pay",
      "unknown.operation",
    ]) {
      await expect(provider.invoke(name)).resolves.toMatchObject({
        ok: false,
        error: {
          service: name,
          code: LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED,
        },
      });
    }
    expect(denied).not.toHaveBeenCalled();
  });

  it.each([
    { HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: "true" },
    {
      HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE:
        LOCAL_TRADING_ISOLATED_ONBOARDING_V1_SIGNING_PROFILE,
    },
    {
      ...reviewedEnvironment,
      HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: "false",
    },
    {
      ...reviewedEnvironment,
      HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE: "malformed",
    },
  ])("fails closed for a partial or malformed marker pair: %j", async (env) => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([operation("account.link", handler)]),
      context(env),
    );

    await expect(
      provider.invoke("account.link", { network: "testnet" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    {
      HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE:
        LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE,
    },
    {
      HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_TRADING_SIGNING_PROFILE: LOCAL_TRADING_SIGNING_PROFILE,
    },
    {
      HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE:
        LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
    },
    { HARBOR_LOCAL_X402_SIGNING_PROFILE: "reviewed-testnet-local-v1" },
    { HARBOR_LOCAL_X402_MERCHANT_PAY_TO: "rMixedProfile" },
  ])("rejects mixed local profiles: %j", async (conflictingMarkers) => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([operation("account.link", handler)]),
      context({ ...reviewedEnvironment, ...conflictingMarkers }),
    );

    await expect(
      provider.invoke("account.link", { network: "testnet" }),
    ).resolves.toMatchObject({ ok: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("takes the deny-all intersection with an enabled x402 profile", async () => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([
        operation("account.link", handler),
        operation("x402.pay", handler),
      ]),
      context({
        ...reviewedEnvironment,
        HARBOR_LOCAL_X402: "true",
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_X402_SIGNING_PROFILE: "reviewed-testnet-local-v1",
      }),
    );

    await expect(
      provider.invoke("account.link", { network: "testnet" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(provider.invoke("x402.pay")).resolves.toMatchObject({
      ok: false,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires a named exact-local capability context", async () => {
    const handler = vi.fn(() => ({ admitted: true }));
    const registry = new OpRegistry([operation("account.link", handler)]);

    for (const candidate of [
      { ...context(), principal: "local-dev" },
      { ...context(), localDevRequest: false },
    ]) {
      const provider = createHarborProvider(registry, candidate);
      await expect(
        provider.invoke("account.link", { network: "testnet" }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED },
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects every explicit non-testnet route before its handler", async () => {
    const handler = vi.fn(() => ({ admitted: true }));
    const registry = new OpRegistry([
      operation("account.link", handler),
      operation("tx.submit", handler),
      operation("tx.status", handler),
    ]);
    const provider = createHarborProvider(registry, context());

    for (const [name, args] of [
      ["account.link", { network: "devnet" }],
      ["account.link", { network: "mainnet" }],
      ["tx.submit", { network: "devnet" }],
      ["tx.status", { network: "lending-devnet" }],
    ] as const) {
      await expect(provider.invoke(name, args)).resolves.toMatchObject({
        ok: false,
        error: {
          service: name,
          code: LOCAL_TRADING_ONBOARDING_NETWORK_DISABLED,
        },
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
