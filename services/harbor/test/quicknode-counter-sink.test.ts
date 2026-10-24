import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { XrplRpc } from "../src/adapters/xrpl-rpc";
import { OpRegistry, type OpContext, type OpDef } from "../src/catalog/registry";
import { createHarborProvider } from "../src/executor/providers";

class CounterD1 {
  readonly counts = new Map<
    string,
    { calls_quicknode: number; calls_fallback: number }
  >();

  constructor(readonly fail = false) {}

  prepare(_sql: string) {
    return {
      bind: (
        runTag: string,
        callsQuickNode: number,
        callsFallback: number,
        _updatedAt: string,
      ) => ({
        run: async () => {
          if (this.fail) throw new Error("D1 unavailable");
          const current = this.counts.get(runTag) ?? {
            calls_quicknode: 0,
            calls_fallback: 0,
          };
          this.counts.set(runTag, {
            calls_quicknode: current.calls_quicknode + callsQuickNode,
            calls_fallback: current.calls_fallback + callsFallback,
          });
          return { success: true };
        },
      }),
    };
  }
}

function rpc(): XrplRpc {
  return {
    request: vi.fn(async () => ({ drops: { base_fee: "10" } })),
  };
}

function feeOperation(): OpDef {
  return {
    name: "ledger.fee",
    family: "ledger",
    summary: "Test fee operation.",
    args: z.object({}).strict(),
    returns: "fee",
    caveats: [],
    example: "await harbor.ledger.fee({})",
    handler: async (ctx: OpContext) =>
      (ctx.xrplRpc as XrplRpc).request("testnet", "fee"),
  };
}

describe("QuickNode persistent RPC counter sink", () => {
  it("persists successful routes independently per QN_RUN_TAG", async () => {
    const db = new CounterD1();
    const registry = new OpRegistry([feeOperation()]);
    const mockProvider = createHarborProvider(registry, {
      principal: "counter-test",
      db: db as unknown as D1Database,
      fallbackXrplRpc: rpc(),
      env: { QN_MODE: "mock", QN_RUN_TAG: "run_A" },
    });
    const fallbackProvider = createHarborProvider(registry, {
      principal: "counter-test",
      db: db as unknown as D1Database,
      fallbackXrplRpc: rpc(),
      env: { QN_MODE: "off", QN_RUN_TAG: "run_B" },
    });

    await expect(mockProvider.invoke("ledger.fee")).resolves.toMatchObject({
      ok: true,
    });
    await expect(fallbackProvider.invoke("ledger.fee")).resolves.toMatchObject({
      ok: true,
    });

    expect(db.counts).toEqual(
      new Map([
        ["run_A", { calls_quicknode: 1, calls_fallback: 0 }],
        ["run_B", { calls_quicknode: 0, calls_fallback: 1 }],
      ]),
    );
  });

  it("does not fail execution when the counter write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const provider = createHarborProvider(
      new OpRegistry([feeOperation()]),
      {
        principal: "counter-test",
        db: new CounterD1(true) as unknown as D1Database,
        fallbackXrplRpc: rpc(),
        env: { QN_MODE: "mock", QN_RUN_TAG: "run1" },
      },
    );

    await expect(provider.invoke("ledger.fee")).resolves.toMatchObject({
      ok: true,
      data: { drops: { base_fee: "10" } },
    });
    expect(warn).toHaveBeenCalledWith("qn_rpc_counter_failed", {
      evt: "qn_rpc_counter_failed",
      code: "QN_RPC_COUNTER_WRITE_FAILED",
    });
    warn.mockRestore();
  });
});
