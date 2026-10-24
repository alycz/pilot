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
import { LOCAL_TRADING_SIGNING_PROFILE } from "../src/local-trading";
import { ExecutionLifetimeError } from "../src/executor/errors";
import { SubmitValidationError } from "../src/exec/submit";

function operation(name: string, handler: OpDef["handler"]): OpDef {
  return {
    name,
    family: name.split(".")[0]!,
    summary: "local trading boundary fixture",
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
  HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_SIGNING_PROFILE: LOCAL_TRADING_SIGNING_PROFILE,
  HARBOR_SOURCE_TAG: "2610240",
};

const malformedEnvironments = [
  { ...reviewedEnvironment, HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "false" },
  { HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "false" },
  { HARBOR_LOCAL_TRADING_SIGNING_PROFILE: "unrecognized" },
];

describe("local trading operation boundary", () => {
  it("exports exactly the reviewed local trading operations", () => {
    expect([...LOCAL_TRADING_OPERATION_ALLOWLIST]).toEqual([
      "tx.swap",
      "tx.approvalPreflight",
      "tx.approvalReconcile",
      "tx.execute",
      "tx.submit",
      "tx.status",
    ]);
  });

  it("admits exactly the reviewed operations only in the complete reviewed profile", async () => {
      const allowedHandler = vi.fn(() => ({ admitted: true }));
      const deniedHandler = vi.fn(() => ({ admitted: false }));
      const provider = createHarborProvider(
        new OpRegistry([
          operation("tx.swap", allowedHandler),
          operation("tx.approvalPreflight", allowedHandler),
          operation("tx.approvalReconcile", allowedHandler),
          operation("tx.execute", allowedHandler),
          operation("tx.submit", allowedHandler),
          operation("tx.status", allowedHandler),
          operation("dex.depth", deniedHandler),
          operation("policy.get", deniedHandler),
          operation("x402.pay", deniedHandler),
          operation("future.trade", deniedHandler),
        ]),
        {
          principal: "trading-principal",
          localDevRequest: true,
          env: reviewedEnvironment,
        },
      );

      await expect(provider.invoke("tx.swap", { network: "testnet" })).resolves.toMatchObject({ ok: true });
      await expect(provider.invoke("tx.approvalPreflight", {})).resolves.toMatchObject({ ok: true });
      await expect(provider.invoke("tx.approvalReconcile", {})).resolves.toMatchObject({ ok: true });
      await expect(provider.invoke("tx.execute", { build_id: "build" })).resolves.toMatchObject({ ok: true });
      await expect(provider.invoke("tx.submit", {})).resolves.toMatchObject({ ok: true });
      await expect(provider.invoke("tx.status", {})).resolves.toMatchObject({ ok: true });
      expect(allowedHandler).toHaveBeenCalledTimes(6);

      for (const name of [
        "dex.depth",
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
      expect(deniedHandler).not.toHaveBeenCalled();
  });

  it("exposes only the fixed v2 lifetime code from an authorized handler", async () => {
    const provider = createHarborProvider(
      new OpRegistry([
        operation("tx.approvalPreflight", () => {
          throw new ExecutionLifetimeError(
            "The immutable execution snapshot is stale",
            "EXECUTION_SNAPSHOT_STALE",
          );
        }),
      ]),
      {
        principal: "trading-principal",
        localDevRequest: true,
        env: reviewedEnvironment,
      },
    );

    await expect(provider.invoke("tx.approvalPreflight", {})).resolves.toMatchObject({
      ok: false,
      error: {
        service: "tx.approvalPreflight",
        code: "EXECUTION_SNAPSHOT_STALE",
      },
    });
  });

  it("exposes the fixed already-preflighted ambiguity code", async () => {
    const provider = createHarborProvider(
      new OpRegistry([
        operation("tx.approvalPreflight", () => {
          throw new ExecutionLifetimeError(
            "The approval was already preflighted",
            "APPROVAL_ALREADY_PREFLIGHTED",
          );
        }),
      ]),
      {
        principal: "trading-principal",
        localDevRequest: true,
        env: reviewedEnvironment,
      },
    );

    await expect(provider.invoke("tx.approvalPreflight", {})).resolves.toMatchObject({
      ok: false,
      error: {
        service: "tx.approvalPreflight",
        code: "APPROVAL_ALREADY_PREFLIGHTED",
      },
    });
  });

  it("exposes only the fixed approval recovery codes", async () => {
    const provider = createHarborProvider(
      new OpRegistry([
        operation("tx.approvalReconcile", () => {
          throw new ExecutionLifetimeError(
            "The proof is incomplete",
            "APPROVAL_RECOVERY_INCOMPLETE",
          );
        }),
      ]),
      {
        principal: "trading-principal",
        localDevRequest: true,
        env: reviewedEnvironment,
      },
    );
    await expect(provider.invoke("tx.approvalReconcile", {})).resolves.toMatchObject({
      ok: false,
      error: { service: "tx.approvalReconcile", code: "APPROVAL_RECOVERY_INCOMPLETE" },
    });
  });

  it("exposes the fixed approval transaction mismatch without broadening submit errors", async () => {
    const provider = createHarborProvider(
      new OpRegistry([
        operation("tx.submit", () => {
          throw new SubmitValidationError(
            "Signed transaction does not match the approved transaction",
            "APPROVAL_TRANSACTION_MISMATCH",
          );
        }),
      ]),
      {
        principal: "trading-principal",
        localDevRequest: true,
        env: reviewedEnvironment,
      },
    );
    await expect(provider.invoke("tx.submit", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "APPROVAL_TRANSACTION_MISMATCH" },
    });
  });

  it.each(malformedEnvironments)(
    "denies even allowlisted operations for a partial or malformed profile: %j",
    async (env) => {
      const handler = vi.fn(() => ({ admitted: true }));
      const provider = createHarborProvider(
        new OpRegistry([operation("tx.swap", handler)]),
        {
          principal: "trading-principal",
          localDevRequest: true,
          env,
        },
      );

      await expect(
        provider.invoke("tx.swap", { network: "testnet" }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: LOCAL_TRADING_OPERATION_DISABLED },
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each([
    { principal: "local-dev", localDevRequest: true },
    { principal: "trading-principal", localDevRequest: false },
  ])("requires named local capability context: %j", async (context) => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([operation("tx.swap", handler)]),
      { ...context, env: reviewedEnvironment },
    );

    await expect(
      provider.invoke("tx.swap", { network: "testnet" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: LOCAL_TRADING_OPERATION_DISABLED },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects every explicit non-testnet trading route before its handler", async () => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([
        operation("tx.swap", handler),
        operation("tx.submit", handler),
        operation("tx.status", handler),
      ]),
      {
        principal: "trading-principal",
        localDevRequest: true,
        env: reviewedEnvironment,
      },
    );

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

  it("takes the safe intersection if x402 and trading markers coexist", async () => {
    const handler = vi.fn(() => ({ admitted: true }));
    const provider = createHarborProvider(
      new OpRegistry([
        operation("tx.swap", handler),
        operation("x402.pay", handler),
      ]),
      {
        principal: "trading-principal",
        env: {
          HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
          HARBOR_LOCAL_TRADING_SIGNING_PROFILE: LOCAL_TRADING_SIGNING_PROFILE,
          HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
        },
      },
    );

    await expect(provider.invoke("tx.swap", { network: "testnet" })).resolves.toMatchObject({
      ok: false,
      error: { code: LOCAL_X402_OPERATION_DISABLED },
    });
    await expect(provider.invoke("x402.pay")).resolves.toMatchObject({
      ok: false,
      error: { code: LOCAL_TRADING_OPERATION_DISABLED },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
