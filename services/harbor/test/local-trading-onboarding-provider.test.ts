import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpRegistry, type OpDef } from "../src/catalog/registry";
import {
  LOCAL_TRADING_ONBOARDING_NETWORK_DISABLED,
  LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST,
  LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED,
  createHarborProvider,
} from "../src/executor/providers";
import { LOCAL_TRADING_SIGNING_PROFILE } from "../src/local-trading";
import { LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE } from "../src/local-trading-onboarding";

function operation(name: string, handler: OpDef["handler"]): OpDef {
  return {
    name,
    family: name.split(".")[0]!,
    summary: "local trading onboarding boundary fixture",
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
  HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE:
    LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
  HARBOR_SOURCE_TAG: "2610240",
};

describe("local trading onboarding operation boundary", () => {
  it("exports exactly the reviewed onboarding operation set", () => {
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
    expect(LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST.has("tx.swap")).toBe(false);
    expect(LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST.has("tx.approvalReconcile")).toBe(false);
  });

  it("admits only the exact allowlist in the complete named local profile", async () => {
    const allowed = vi.fn(() => ({ admitted: true }));
    const denied = vi.fn(() => ({ admitted: false }));
    const registry = new OpRegistry([
      ...[...LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST].map((name) =>
        operation(name, allowed)),
      operation("tx.swap", denied),
      operation("account.unsafeFuture", denied),
      operation("x402.pay", denied),
    ]);
    const provider = createHarborProvider(registry, {
      principal: "onboarding-principal",
      localDevRequest: true,
      env: reviewedEnvironment,
    });

    for (const name of LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST) {
      const args = name === "tx.execute"
        ? { build_id: "fixture" }
        : { network: "testnet" };
      await expect(provider.invoke(name, args)).resolves.toMatchObject({ ok: true });
    }
    for (const name of ["tx.swap", "account.unsafeFuture", "x402.pay", "unknown.op"]) {
      await expect(provider.invoke(name, { network: "testnet" })).resolves.toMatchObject({
        ok: false,
        error: { code: LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED },
      });
    }
    expect(allowed).toHaveBeenCalledTimes(LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST.size);
    expect(denied).not.toHaveBeenCalled();
  });

  it.each([
    { HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "false" },
    { HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE: "unreviewed" },
    { HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true" },
  ])("fails closed for a partial or malformed onboarding profile: %j", async (marker) => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([operation("account.link", handler)]),
      {
        principal: "onboarding-principal",
        localDevRequest: true,
        env: marker,
      },
    );
    await expect(provider.invoke("account.link", { network: "testnet" })).resolves.toMatchObject({
      ok: false,
      error: { code: LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies every operation when onboarding and trading markers are mixed", async () => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([
        operation("tx.execute", handler),
        operation("account.link", handler),
      ]),
      {
        principal: "onboarding-principal",
        localDevRequest: true,
        env: {
          ...reviewedEnvironment,
          HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
          HARBOR_LOCAL_TRADING_SIGNING_PROFILE: LOCAL_TRADING_SIGNING_PROFILE,
        },
      },
    );
    await expect(provider.invoke("tx.execute", { build_id: "fixture" })).resolves.toMatchObject({
      ok: false,
    });
    await expect(provider.invoke("account.link", { network: "testnet" })).resolves.toMatchObject({
      ok: false,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("takes the deny-all intersection when onboarding and x402 markers are mixed", async () => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([
        operation("account.link", handler),
        operation("x402.pay", handler),
      ]),
      {
        principal: "onboarding-principal",
        localDevRequest: true,
        env: {
          ...reviewedEnvironment,
          HARBOR_LOCAL_X402: "true",
          HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
          HARBOR_LOCAL_X402_SIGNING_PROFILE: "reviewed-testnet-local-v1",
        },
      },
    );
    await expect(provider.invoke("account.link", { network: "testnet" })).resolves.toMatchObject({
      ok: false,
    });
    await expect(provider.invoke("x402.pay", {})).resolves.toMatchObject({ ok: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects explicit non-testnet requests before handlers", async () => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([operation("account.link", handler)]),
      {
        principal: "onboarding-principal",
        localDevRequest: true,
        env: reviewedEnvironment,
      },
    );
    await expect(provider.invoke("account.link", { network: "devnet" })).resolves.toMatchObject({
      ok: false,
      error: { code: LOCAL_TRADING_ONBOARDING_NETWORK_DISABLED },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    { principal: "local-dev", localDevRequest: true },
    { principal: "onboarding-principal", localDevRequest: false },
  ])("requires a named exact-local capability context: %j", async (context) => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([operation("account.link", handler)]),
      { ...context, env: reviewedEnvironment },
    );
    await expect(provider.invoke("account.link", { network: "testnet" })).resolves.toMatchObject({
      ok: false,
      error: { code: LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
