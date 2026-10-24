import { describe, expect, it, vi } from "vitest";

import type { OpContext } from "../src/catalog/registry";
import { invokeOp } from "../src/guard";
import { ops } from "../src/ops/perps";

const XRP_MARKET = {
  coin: "XRP",
  szDecimals: 1,
  maxLeverage: 20,
  onlyIsolated: false,
  isDelisted: false,
  dayNtlVlm: "3000000.25",
  funding: "0.0000125",
  impactPxs: ["0.5099", "0.5101"] as [string, string],
  markPx: "0.5100",
  midPx: "0.5100",
  openInterest: "9000000",
  oraclePx: "0.5098",
  premium: "0.0003",
  prevDayPx: "0.5000",
};

function operation() {
  const op = ops.find(({ name }) => name === "perps.markets");
  if (!op) throw new Error("Missing perps.markets");
  return op;
}

describe("perps.markets", () => {
  it("exports one read-only market-data operation with the fixed caveat", () => {
    const op = operation();
    expect(ops.map(({ name }) => name)).toEqual(["perps.markets"]);
    expect(op.caveats).toEqual(["off-ledger"]);
    expect(op.tags).toEqual(expect.arrayContaining(["read-only", "market-data"]));
    expect(op.summary).toMatch(/trading and order management are unavailable/i);
    expect(op.args.safeParse({}).success).toBe(true);
    expect(op.args.safeParse({ coin: "BTC" }).success).toBe(false);
    expect(ops.some(({ name }) => /order|trade|execute/i.test(name))).toBe(false);
  });

  it("returns only the XRP market and states that execution is unavailable", async () => {
    const hyperliquidMarkets = vi.fn(async () => [
      { ...XRP_MARKET, coin: "BTC" },
      XRP_MARKET,
    ]);
    const result = await operation().handler(
      {
        principal: "perps-unit-test",
        hyperliquidMarkets,
      } as OpContext,
      {},
    );

    expect(result).toEqual({
      venue: "hyperliquid",
      venueId: "hyperliquid-xrp-perps",
      readOnly: true,
      executionAvailable: false,
      markets: [XRP_MARKET],
    });
    expect(hyperliquidMarkets).toHaveBeenCalledOnce();
  });

  it("places the off-ledger caveat in the operation envelope", async () => {
    const envelope = await invokeOp(
      operation(),
      {
        principal: "perps-unit-test",
        hyperliquidMarkets: vi.fn(async () => [XRP_MARKET]),
      } as OpContext,
      {},
      {
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "hyperliquid-info-api",
      },
    );

    expect(envelope).toMatchObject({
      ok: true,
      asOf: "2026-10-18T00:00:00.000Z",
      asOfBasis: "hyperliquid-info-api",
      caveat: ["off-ledger"],
      data: {
        readOnly: true,
        executionAvailable: false,
      },
    });
  });

  it("fails rather than substituting another perpetual when XRP is absent", async () => {
    await expect(
      operation().handler(
        {
          principal: "perps-unit-test",
          hyperliquidMarkets: vi.fn(async () => [
            { ...XRP_MARKET, coin: "BTC" },
          ]),
        } as OpContext,
        {},
      ),
    ).rejects.toThrow("XRP perpetual market is unavailable");
  });

  it("validates injected readers and rejects malformed or extra claim fields", async () => {
    const invalidResults = [
      [{ ...XRP_MARKET, openInterest: 9_000_000 }],
      [{ ...XRP_MARKET, orderEndpoint: "https://example.invalid/order" }],
    ];

    for (const result of invalidResults) {
      await expect(
        operation().handler(
          {
            principal: "perps-unit-test",
            hyperliquidMarkets: vi.fn(async () => result),
          } as OpContext,
          {},
        ),
      ).rejects.toMatchObject({
        name: "HyperliquidError",
        code: "INVALID_RESPONSE",
      });
    }
  });
});
