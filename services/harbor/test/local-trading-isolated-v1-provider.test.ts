import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpRegistry, type OpDef } from "../src/catalog/registry";
import {
  LOCAL_TRADING_NETWORK_DISABLED,
  LOCAL_TRADING_OPERATION_ALLOWLIST,
  LOCAL_TRADING_OPERATION_DISABLED,
  LOCAL_X402_OPERATION_DISABLED,
  createHarborProvider,
} from "../src/executor/providers";
import {
  LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE,
} from "../src/local-trading-isolated-v1";
import { LOCAL_TRADING_SIGNING_PROFILE } from "../src/local-trading";
import { LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE } from "../src/local-trading-onboarding";

function operation(name: string, handler: OpDef["handler"]): OpDef {
  return {
    name,
    family: name.split(".")[0]!,
    summary: "isolated local trading boundary fixture",
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
  HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE:
    LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE,
  HARBOR_SOURCE_TAG: "2610240",
} as const;

function context(env: Record<string, unknown> = reviewedEnvironment) {
  return {
    principal: "isolated-trading-principal",
    localDevRequest: true,
    env,
  };
}

describe("isolated local trading operation boundary", () => {
  it("reuses exactly the reviewed local trading allowlist", () => {
    expect([...LOCAL_TRADING_OPERATION_ALLOWLIST]).toEqual([
      "tx.swap",
      "tx.approvalPreflight",
      "tx.approvalReconcile",
      "tx.execute",
      "tx.submit",
      "tx.status",
    ]);
  });

  it("admits exactly the six reviewed operations in the exact isolated profile", async () => {
    const allowed = vi.fn(() => ({ admitted: true }));
    const denied = vi.fn(() => ({ admitted: false }));
    const registry = new OpRegistry([
      ...[...LOCAL_TRADING_OPERATION_ALLOWLIST].map((name) =>
        operation(name, allowed),
      ),
      operation("policy.get", denied),
      operation("x402.pay", denied),
      operation("future.trade", denied),
    ]);
    const provider = createHarborProvider(registry, context());

    for (const name of LOCAL_TRADING_OPERATION_ALLOWLIST) {
      const args = name === "tx.swap" ? { network: "testnet" } : {};
      await expect(provider.invoke(name, args)).resolves.toMatchObject({
        ok: true,
      });
    }
    expect(allowed).toHaveBeenCalledTimes(LOCAL_TRADING_OPERATION_ALLOWLIST.size);

    for (const name of [
      "policy.get",
      "x402.pay",
      "future.trade",
      "unknown.operation",
    ]) {
      await expect(provider.invoke(name)).resolves.toMatchObject({
        ok: false,
        error: { service: name, code: LOCAL_TRADING_OPERATION_DISABLED },
      });
    }
    expect(denied).not.toHaveBeenCalled();
  });

  it.each([
    { HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true" },
    {
      HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE:
        LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE,
    },
    {
      ...reviewedEnvironment,
      HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "false",
    },
    {
      ...reviewedEnvironment,
      HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE: "malformed",
    },
  ])("fails closed for a partial or malformed marker pair: %j", async (env) => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([operation("tx.swap", handler)]),
      context(env),
    );

    await expect(
      provider.invoke("tx.swap", { network: "testnet" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: LOCAL_TRADING_OPERATION_DISABLED },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    {
      HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_TRADING_SIGNING_PROFILE: LOCAL_TRADING_SIGNING_PROFILE,
    },
    {
      HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE:
        LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
    },
  ])("rejects mixed old/new local profiles: %j", async (legacyMarkers) => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([operation("tx.swap", handler)]),
      context({ ...reviewedEnvironment, ...legacyMarkers }),
    );

    await expect(
      provider.invoke("tx.swap", { network: "testnet" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: LOCAL_TRADING_OPERATION_DISABLED },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("takes the deny-all intersection with x402", async () => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([
        operation("tx.swap", handler),
        operation("x402.pay", handler),
      ]),
      context({
        ...reviewedEnvironment,
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_X402_SIGNING_PROFILE: "mixed",
      }),
    );

    await expect(
      provider.invoke("tx.swap", { network: "testnet" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: LOCAL_X402_OPERATION_DISABLED },
    });
    await expect(provider.invoke("x402.pay")).resolves.toMatchObject({
      ok: false,
      error: { code: LOCAL_TRADING_OPERATION_DISABLED },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires a named local capability context", async () => {
    const handler = vi.fn(() => ({ admitted: true }));
    const registry = new OpRegistry([operation("tx.swap", handler)]);

    for (const candidate of [
      { ...context(), principal: "local-dev" },
      { ...context(), localDevRequest: false },
    ]) {
      const provider = createHarborProvider(registry, candidate);
      await expect(
        provider.invoke("tx.swap", { network: "testnet" }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: LOCAL_TRADING_OPERATION_DISABLED },
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects every explicit non-testnet route before its handler", async () => {
    const handler = vi.fn(() => ({ admitted: true }));
    const registry = new OpRegistry([
      operation("tx.swap", handler),
      operation("tx.submit", handler),
      operation("tx.status", handler),
    ]);
    const provider = createHarborProvider(registry, context());

    for (const [name, args] of [
      ["tx.swap", { network: "devnet" }],
      ["tx.swap", { network: "mainnet" }],
      ["tx.submit", { network: "devnet" }],
      ["tx.status", { network: "lending-devnet" }],
    ] as const) {
      await expect(provider.invoke(name, args)).resolves.toMatchObject({
        ok: false,
        error: { service: name, code: LOCAL_TRADING_NETWORK_DISABLED },
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
