import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { OpContext, OpDef } from "../src/catalog/registry";
import { OpRegistry } from "../src/catalog/registry";
import type { XrplRpc } from "../src/adapters/xrpl-rpc";
import { XrplRpcError } from "../src/adapters/xrpl-rpc";
import { createHarborProvider } from "../src/executor/providers";
import { createQuickNodeRoutedRpc } from "../src/quicknode/rpc";
import coverage from "../src/quicknode/coverage.testnet.json";
import {
  classifyCoverageResponse,
  resolveCoverageEndpoint,
  XRPL_COVERAGE_METHODS,
} from "../scripts/quicknode/coverage";

function rpc(
  implementation: XrplRpc["request"] = async () => ({ status: "success" }),
): XrplRpc & { request: ReturnType<typeof vi.fn> } {
  return { request: vi.fn(implementation) };
}

const LIVE_ENV = {
  QN_MODE: "live",
  QN_XRPL_TESTNET_HTTP: "https://endpoint.example.invalid/token",
} as const;

describe("QuickNode XRPL routing", () => {
  it("defaults off to fallback and labels mock calls without using a live endpoint", async () => {
    const fallback = rpc();
    const off = createQuickNodeRoutedRpc({ fallbackRpc: fallback });
    await off.rpc.request("testnet", "fee");
    expect(off.trust()).toEqual({
      route: "fallback",
      methods_quicknode: 0,
      methods_fallback: 1,
    });

    const mock = createQuickNodeRoutedRpc({
      env: { QN_MODE: "mock" },
      fallbackRpc: fallback,
    });
    await mock.rpc.request("testnet", "fee");
    expect(mock.trust()).toEqual({
      route: "quicknode-mock",
      methods_quicknode: 1,
      methods_fallback: 0,
    });
  });

  it("uses QuickNode for supported testnet methods and bypasses it for coverage gaps", async () => {
    const quickNode = rpc();
    const fallback = rpc();
    const routed = createQuickNodeRoutedRpc({
      env: LIVE_ENV,
      quickNodeRpc: quickNode,
      fallbackRpc: fallback,
    });

    await routed.rpc.request("testnet", "fee");
    await routed.rpc.request("testnet", "simulate", { tx_json: {} });

    expect(quickNode.request).toHaveBeenCalledOnce();
    expect(fallback.request).toHaveBeenCalledOnce();
    expect(routed.trust()).toEqual({
      route: "fallback",
      methods_quicknode: 1,
      methods_fallback: 1,
    });
  });

  it("fails closed to fallback for an unprobed command", async () => {
    const quickNode = rpc();
    const fallback = rpc(async () => ({ status: "success" }));
    const routed = createQuickNodeRoutedRpc({
      env: LIVE_ENV,
      quickNodeRpc: quickNode,
      fallbackRpc: fallback,
    });

    await expect(
      routed.rpc.request("testnet", "future_unprobed_method"),
    ).resolves.toEqual({ status: "success" });
    expect(quickNode.request).not.toHaveBeenCalled();
    expect(fallback.request).toHaveBeenCalledOnce();
    expect(routed.trust()).toEqual({
      route: "fallback",
      methods_quicknode: 0,
      methods_fallback: 1,
    });
  });

  it.each([
    new XrplRpcError(
      "private transport detail",
      "XRPL_TRANSPORT_ERROR",
      "error",
      true,
    ),
    new XrplRpcError("unsupported", "unknownCmd"),
    new XrplRpcError("rate limited", "HTTP_429", "error", true),
    new XrplRpcError("upstream unavailable", "HTTP_503", "error", true),
  ])("fails over a read on %s", async (primaryError) => {
    const quickNode = rpc(async () => {
      throw primaryError;
    });
    const fallback = rpc(async () => ({ ledger_index: 42 }));
    const routed = createQuickNodeRoutedRpc({
      env: LIVE_ENV,
      quickNodeRpc: quickNode,
      fallbackRpc: fallback,
    });

    await expect(routed.rpc.request("testnet", "fee")).resolves.toEqual({
      ledger_index: 42,
    });
    expect(routed.trust()).toEqual({
      route: "fallback",
      methods_quicknode: 0,
      methods_fallback: 1,
    });
  });

  it.each([
    new XrplRpcError("not found", "actNotFound", "soft-empty"),
    new XrplRpcError("claim failed", "tecFAILED_PROCESSING"),
    new XrplRpcError("malformed", "temMALFORMED"),
  ])("does not fail over a business error %s", async (primaryError) => {
    const quickNode = rpc(async () => {
      throw primaryError;
    });
    const fallback = rpc();
    const routed = createQuickNodeRoutedRpc({
      env: LIVE_ENV,
      quickNodeRpc: quickNode,
      fallbackRpc: fallback,
    });

    await expect(routed.rpc.request("testnet", "account_info")).rejects.toBe(
      primaryError,
    );
    expect(fallback.request).not.toHaveBeenCalled();
    expect(routed.trust()).toMatchObject({
      route: "quicknode",
      methods_quicknode: 1,
      methods_fallback: 0,
    });
  });

  it("never fails over submit on HTTP 429", async () => {
    const error = new XrplRpcError("rate limited", "HTTP_429", "error", true);
    const quickNode = rpc(async () => {
      throw error;
    });
    const fallback = rpc();
    const routed = createQuickNodeRoutedRpc({
      env: LIVE_ENV,
      quickNodeRpc: quickNode,
      fallbackRpc: fallback,
    });

    await expect(
      routed.rpc.request("testnet", "submit", { tx_blob: "DEADBEEF" }),
    ).rejects.toBe(error);
    expect(fallback.request).not.toHaveBeenCalled();
  });

  it("reuses the exact signed-blob params object on an allowed submit failover", async () => {
    const quickNode = rpc(async () => {
      throw new XrplRpcError("unavailable", "HTTP_500", "error", true);
    });
    const fallback = rpc();
    const params = { tx_blob: "DEADBEEF", fail_hard: true } as const;
    const routed = createQuickNodeRoutedRpc({
      env: LIVE_ENV,
      quickNodeRpc: quickNode,
      fallbackRpc: fallback,
    });

    await routed.rpc.request("testnet", "submit", params, { intent: "execute" });
    expect(quickNode.request.mock.calls[0]?.[2]).toBe(params);
    expect(fallback.request.mock.calls[0]?.[2]).toBe(params);
  });

  it("routes non-testnet calls to fallback and rejects invalid live configuration", async () => {
    const quickNode = rpc();
    const fallback = rpc();
    const routed = createQuickNodeRoutedRpc({
      env: LIVE_ENV,
      quickNodeRpc: quickNode,
      fallbackRpc: fallback,
    });
    await routed.rpc.request("devnet", "fee");
    expect(quickNode.request).not.toHaveBeenCalled();
    expect(fallback.request).toHaveBeenCalledOnce();

    expect(() =>
      createQuickNodeRoutedRpc({ env: { QN_MODE: "live" } }),
    ).toThrowError("QuickNode endpoint is required in live mode");
    expect(() =>
      createQuickNodeRoutedRpc({
        env: {
          QN_MODE: "live",
          QN_XRPL_TESTNET_HTTP: "http://token.invalid/rpc",
        },
      }),
    ).toThrowError("QuickNode endpoint is invalid");
  });

  it("normalizes only bounded execution-critical reads to current", async () => {
    const fallback = rpc();
    const execution = createQuickNodeRoutedRpc({
      operationName: "tx.swap",
      fallbackRpc: fallback,
    });
    await execution.rpc.request("testnet", "account_lines", {
      account: "rExample",
      ledger_index: "validated",
    });
    expect(fallback.request.mock.calls[0]?.[2]).toEqual({
      account: "rExample",
      ledger_index: "current",
    });

    fallback.request.mockClear();
    const simulation = createQuickNodeRoutedRpc({
      operationName: "tx.simulate",
      fallbackRpc: fallback,
    });
    await simulation.rpc.request("testnet", "account_info", {
      account: "rExample",
      ledger_index: "validated",
    });
    expect(fallback.request.mock.calls[0]?.[2]).toEqual({
      account: "rExample",
      ledger_index: "current",
    });

    fallback.request.mockClear();
    const display = createQuickNodeRoutedRpc({
      operationName: "ledger.account.lines",
      fallbackRpc: fallback,
    });
    await display.rpc.request("testnet", "account_lines", {
      account: "rExample",
      ledger_index: "validated",
    });
    expect(fallback.request.mock.calls[0]?.[2]).toEqual({
      account: "rExample",
      ledger_index: "validated",
    });
  });

  it("emits only secret-safe structured call metadata", async () => {
    const events: unknown[] = [];
    const quickNode = rpc(async () => {
      throw new XrplRpcError("secret URL / token", "unknownCmd");
    });
    const fallback = rpc();
    const routed = createQuickNodeRoutedRpc({
      env: LIVE_ENV,
      quickNodeRpc: quickNode,
      fallbackRpc: fallback,
      logger: (event) => events.push(event),
      now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(105)
        .mockReturnValueOnce(200).mockReturnValueOnce(207),
    });
    await routed.rpc.request("testnet", "fee", { token: "must-not-log" });

    expect(events).toEqual([
      {
        evt: "xrpl_call",
        method: "fee",
        route: "quicknode",
        ms: 5,
        ok: false,
        errCode: "unknownCmd",
      },
      {
        evt: "xrpl_call",
        method: "fee",
        route: "fallback",
        ms: 7,
        ok: true,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("must-not-log");
  });
});

function feeOperation(): OpDef {
  return {
    name: "ledger.fee",
    family: "ledger",
    summary: "Read fee through the injected operation RPC.",
    args: z.object({}).strict(),
    returns: "fee",
    caveats: [],
    example: "await harbor.ledger.fee()",
    handler: async (ctx: OpContext) => {
      const operationRpc = ctx.xrplRpc as XrplRpc;
      return operationRpc.request("testnet", "fee");
    },
  };
}

describe("QuickNode provider trust envelope", () => {
  it("adds per-operation RPC route counts before AWS screening", async () => {
    const fallback = rpc(async () => ({ drops: { base_fee: "10" } }));
    const provider = createHarborProvider(new OpRegistry([feeOperation()]), {
      principal: "quicknode-test",
      fallbackXrplRpc: fallback,
      env: { QN_MODE: "off" },
    });

    await expect(provider.invoke("ledger.fee")).resolves.toMatchObject({
      ok: true,
      data: { drops: { base_fee: "10" } },
      trust: {
        rpc: {
          route: "fallback",
          methods_quicknode: 0,
          methods_fallback: 1,
        },
      },
    });
  });
});

describe("QuickNode coverage probe", () => {
  it("keeps the committed build-time map complete for every probe method", () => {
    expect(Object.keys(coverage.methods).sort()).toEqual(
      [...XRPL_COVERAGE_METHODS].sort(),
    );
  });

  it("distinguishes capability gaps from supported business errors", () => {
    expect(
      classifyCoverageResponse({ result: { status: "success", ledger_index: 1 } }),
    ).toBe("supported");
    expect(
      classifyCoverageResponse({
        result: { status: "error", error: "unknownCmd" },
      }),
    ).toBe("unsupported");
    expect(
      classifyCoverageResponse({
        result: { status: "error", error: "actNotFound" },
      }),
    ).toBe("supported_business_error");
    expect(
      classifyCoverageResponse({ error: { code: "notImpl" } }),
    ).toBe("unsupported");
    expect(() =>
      classifyCoverageResponse({
        result: { status: "error", error: "tooBusy" },
      }),
    ).toThrowError("unrecognized XRPL error");
    expect(() =>
      classifyCoverageResponse({ error: { code: -32_000 } }),
    ).toThrowError("unrecognized XRPL error");
  });

  it("keeps token-bearing endpoints out of command-line arguments", () => {
    expect(
      resolveCoverageEndpoint("http://127.0.0.1:8793/rpc", undefined),
    ).toBe("http://127.0.0.1:8793/rpc");
    expect(
      resolveCoverageEndpoint(
        undefined,
        "https://endpoint.example.invalid/private-token",
      ),
    ).toBe("https://endpoint.example.invalid/private-token");

    const secretCli = "https://endpoint.example.invalid/secret-sentinel";
    try {
      resolveCoverageEndpoint(secretCli, undefined);
      throw new Error("expected command-line endpoint rejection");
    } catch (error) {
      expect(String(error)).not.toContain("secret-sentinel");
      expect(String(error)).toContain("HTTPS or loopback HTTP");
    }
  });
});
