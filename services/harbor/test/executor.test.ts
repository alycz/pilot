import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  OpRegistry,
  type OpContext,
  type OpDef,
} from "../src/catalog/registry";
import { XrplRpcError } from "../src/adapters/xrpl-rpc";
import { MAX_OUTPUT_BYTES } from "../src/guard";
import { execute } from "../src/executor/run";
import {
  ProviderCallLimitError,
  createHarborProvider,
} from "../src/executor/providers";

function feeOp(
  handler: OpDef["handler"] = (ctx) => ({
    drops: "12",
    principal: ctx.principal,
  }),
): OpDef {
  return {
    name: "ledger.fee",
    family: "ledger",
    summary: "Read the current XRPL transaction fee.",
    tags: ["fee"],
    args: z.object({ network: z.string().optional() }).strict(),
    returns: "the fee in drops",
    caveats: [],
    example: "await harbor.ledger.fee()",
    handler,
  };
}

const ctx: OpContext = { principal: "unit-test-principal" };

describe("registry-backed Harbor provider", () => {
  it("builds dotted namespaces and preserves ctx.principal", async () => {
    const provider = createHarborProvider(new OpRegistry([feeOp()]), ctx);
    const fee = provider.harbor.ledger.fee;
    expect(typeof fee).toBe("function");
    await expect((fee as (args?: unknown) => Promise<unknown>)()).resolves.toMatchObject({
      ok: true,
      data: { drops: "12", principal: "unit-test-principal" },
      asOfBasis: "server-time",
    });
  });

  it("returns guarded envelopes and stops at the configured call limit", async () => {
    const provider = createHarborProvider(
      new OpRegistry([feeOp()]),
      ctx,
      1,
    );
    await expect(provider.invoke("ledger.fee", { unexpected: true })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENTS" },
    });
    await expect(provider.invoke("ledger.fee")).rejects.toBeInstanceOf(
      ProviderCallLimitError,
    );
  });

  it("does not disclose arbitrary handler errors", async () => {
    const provider = createHarborProvider(
      new OpRegistry([
        feeOp(() => {
          throw new Error("delegate credential material");
        }),
      ]),
      ctx,
    );
    await expect(provider.invoke("ledger.fee")).resolves.toEqual({
      ok: false,
      error: {
        service: "ledger.fee",
        kind: "error",
        message: "Operation failed",
        code: "OPERATION_FAILED",
      },
    });
  });

  it("preserves only allowlisted XRPL transport metadata", async () => {
    const provider = createHarborProvider(
      new OpRegistry([
        feeOp(() => {
          throw new XrplRpcError(
            "sentinel secret URL/body/request",
            "XRPL_TRANSPORT_ERROR",
            "error",
            true,
          );
        }),
      ]),
      ctx,
    );
    const result = await provider.invoke("ledger.fee");
    expect(result).toEqual({
      ok: false,
      error: {
        service: "xrpl",
        kind: "error",
        message: "XRPL request failed",
        code: "XRPL_TRANSPORT_ERROR",
      },
    });
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });

  it("preserves allowlisted XRPL soft-empty metadata", async () => {
    const provider = createHarborProvider(
      new OpRegistry([
        feeOp(() => {
          throw new XrplRpcError(
            "upstream response must remain private",
            "entryNotFound",
            "soft-empty",
          );
        }),
      ]),
      ctx,
    );
    await expect(provider.invoke("ledger.fee")).resolves.toEqual({
      ok: false,
      error: {
        service: "xrpl",
        kind: "soft-empty",
        message: "XRPL request failed",
        code: "entryNotFound",
      },
    });
  });

  it("redacts unrecognized XRPL codes and soft-empty claims", async () => {
    const provider = createHarborProvider(
      new OpRegistry([
        feeOp(() => {
          throw new XrplRpcError(
            "secret-message-sentinel",
            "secret-code-sentinel",
            "soft-empty",
          );
        }),
      ]),
      ctx,
    );
    const result = await provider.invoke("ledger.fee");
    expect(result).toEqual({
      ok: false,
      error: {
        service: "xrpl",
        kind: "error",
        message: "XRPL request failed",
        code: "XRPL_ERROR",
      },
    });
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });

  it("downgrades forged soft-empty kinds on non-empty allowlisted codes", async () => {
    const provider = createHarborProvider(
      new OpRegistry([
        feeOp(() => {
          throw new XrplRpcError(
            "upstream detail remains private",
            "tooBusy",
            "soft-empty",
            true,
          );
        }),
      ]),
      ctx,
    );
    await expect(provider.invoke("ledger.fee")).resolves.toEqual({
      ok: false,
      error: {
        service: "xrpl",
        kind: "error",
        message: "XRPL request failed",
        code: "tooBusy",
      },
    });
  });
});

describe("QuickJS executor", () => {
  it("runs an async script against the test-only ledger.fee op", async () => {
    const output = await execute("return await harbor.ledger.fee();", {
      ctx,
      registry: new OpRegistry([feeOp()]),
      runtime: "quickjs",
    });
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      data: { drops: "12", principal: "unit-test-principal" },
      asOfBasis: "server-time",
    });
  });

  it("supports concurrent host promises without deadlocking the bridge", async () => {
    let call = 0;
    const output = await execute(
      "return await Promise.all([harbor.ledger.fee(), harbor.ledger.fee()]);",
      {
        ctx,
        registry: new OpRegistry([
          feeOp(async () => {
            call += 1;
            await Promise.resolve();
            return { drops: String(call) };
          }),
        ]),
        runtime: "quickjs",
      },
    );
    expect(JSON.parse(output)).toHaveLength(2);
  });

  it("rejects fetch, sensitive code, and a 31st operation call", async () => {
    const registry = new OpRegistry([feeOp()]);
    await expect(
      execute('return await fetch("https://example.invalid");', {
        ctx,
        registry,
        runtime: "quickjs",
      }),
    ).rejects.toThrow(/outbound network access is disabled/i);

    await expect(
      execute('return "mnemonic";', { ctx, registry, runtime: "quickjs" }),
    ).rejects.toThrow(/sensitive material/i);

    await expect(
      execute(
        "for (let i = 0; i < 31; i++) await harbor.ledger.fee(); return true;",
        { ctx, registry, runtime: "quickjs" },
      ),
    ).rejects.toThrow(/call limit exceeded/i);
  });

  it("caps serialized output at 24 KiB", async () => {
    const output = await execute('return "x".repeat(30000);', {
      ctx,
      registry: new OpRegistry([feeOp()]),
      runtime: "quickjs",
    });
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES,
    );
    expect(output).toContain("output truncated");
  });

  it("does not return timeout until an admitted host operation settles", async () => {
    let settled = false;
    const registry = new OpRegistry([
      feeOp(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              settled = true;
              resolve({ drops: "12" });
            }, 25),
          ),
      ),
    ]);
    await expect(
      execute("return await harbor.ledger.fee();", {
        ctx,
        registry,
        runtime: "quickjs",
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(settled).toBe(true);
  });
});

describe("Dynamic Worker executor", () => {
  it("falls back before execution when Loader.load is unavailable", async () => {
    const loader = {
      load(): WorkerStub {
        throw new Error("binding unavailable");
      },
    };
    const output = await execute("return 42;", {
      ctx,
      registry: new OpRegistry([feeOp()]),
      loader,
      rpc: { invoke: vi.fn() },
    });
    expect(output).toBe("42");
  });

  it("uses Loader.load with one RPC capability and no outbound network", async () => {
    let loadOptions: WorkerLoaderWorkerCode | undefined;
    const fetch = vi.fn(async () =>
      Response.json({ ok: true, value: { runtime: "dynamic" } }),
    );
    const loader = {
      load(options: WorkerLoaderWorkerCode) {
        loadOptions = options;
        return {
          getEntrypoint: () => ({ fetch }),
        } as unknown as WorkerStub;
      },
    };
    const rpc = { invoke: vi.fn(async () => ({ ok: true })) };

    const output = await execute("return 42;", {
      ctx,
      registry: new OpRegistry([feeOp()]),
      loader,
      rpc,
    });

    expect(JSON.parse(output)).toEqual({ runtime: "dynamic" });
    expect(loadOptions).toMatchObject({
      compatibilityDate: expect.any(String),
      mainModule: "agent.js",
      globalOutbound: null,
      env: { HARBOR: rpc },
      limits: { cpuMs: 10_000, subRequests: 30 },
    });
    expect(Object.keys(loadOptions?.modules ?? {})).toEqual([
      "agent.js",
      "user.js",
    ]);
    expect(loadOptions?.modules["agent.js"]).toContain(
      "Outbound network access is disabled",
    );
    expect(loadOptions?.modules["agent.js"]).toContain(
      "Promise.allSettled([...inFlight])",
    );
    expect(loadOptions?.modules["agent.js"]).not.toContain("return 42");
    expect(loadOptions?.modules["user.js"]).toContain("return 42");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
