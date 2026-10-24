import { describe, expect, it } from "vitest";

import {
  ammSummary,
  assetSymbol,
  bookSummary,
  deviationBps,
  depthAmountValue,
  depthSide,
  ledgerAmountValue,
  marketPair,
  parseDecimal,
  routeSummary,
} from "./markets-data";
import { FIXTURE_TRADE_SIZES, fixtureAmm, fixtureCompare, fixtureDepth } from "./markets-fixtures";

const pair = marketPair("testnet", { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" });

describe("parsing", () => {
  it("parses decimals strictly", () => {
    expect(parseDecimal("1.25")).toBe(1.25);
    expect(parseDecimal("1e3")).toBe(1000);
    expect(parseDecimal("abc")).toBeNull();
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal(undefined)).toBeNull();
  });

  it("reads XRP drops and issued amounts", () => {
    expect(ledgerAmountValue("2500000")).toBe(2.5);
    expect(ledgerAmountValue({ currency: "USD", issuer: "r", value: "12.5" })).toBe(12.5);
    expect(ledgerAmountValue("1.5")).toBeNull();
  });

  it("treats long integer XRP depth amounts as drops", () => {
    expect(depthAmountValue("150000000", { currency: "XRP" })).toBe(150);
    expect(depthAmountValue("150.5", { currency: "XRP" })).toBe(150.5);
    expect(depthAmountValue("150000000", pair.quote)).toBe(150_000_000);
  });

  it("decodes hex currency codes", () => {
    expect(assetSymbol({ currency: "524C555344000000000000000000000000000000" })).toBe("RLUSD");
    expect(assetSymbol({ currency: "USD" })).toBe("USD");
  });
});

describe("order book derivation", () => {
  const asks = depthSide(fixtureDepth(pair, "ask"), "ask");
  const bids = depthSide(fixtureDepth(pair, "bid"), "bid");

  it("orders both sides from the best price outwards with running totals", () => {
    expect(asks[0]!.price).toBeLessThan(asks[1]!.price);
    expect(bids[0]!.price).toBeGreaterThan(bids[1]!.price);
    expect(asks.at(-1)!.cumulative).toBeCloseTo(asks.reduce((sum, level) => sum + level.size, 0));
  });

  it("computes mid and spread in quote per base", () => {
    const summary = bookSummary(bids, asks);
    expect(summary.bestBid).toBeLessThan(summary.bestAsk!);
    expect(summary.mid).toBeCloseTo(0.518, 4);
    expect(summary.spreadBps).toBeGreaterThan(20);
    expect(summary.spreadBps).toBeLessThan(25);
  });

  it("handles an empty side", () => {
    const summary = bookSummary([], asks);
    expect(summary.bestBid).toBeNull();
    expect(summary.mid).toBe(asks[0]!.price);
    expect(summary.spreadBps).toBeNull();
  });
});

describe("AMM derivation", () => {
  it("derives implied price, fee and TVL from reserves", () => {
    const summary = ammSummary(fixtureAmm(pair), pair.base, pair.quote)!;
    expect(summary.baseReserve).toBe(412_500);
    expect(summary.price).toBeCloseTo(0.51845, 5);
    expect(summary.feePercent).toBeCloseTo(0.3);
    expect(summary.tvlQuote).toBeCloseTo(summary.quoteReserve * 2);
  });

  it("accepts reversed asset order and rejects mismatched pools", () => {
    const result = fixtureAmm(pair);
    const reversed = { ...result, amm: { ...result.amm, amount: result.amm.amount2, amount2: result.amm.amount } };
    expect(ammSummary(reversed, pair.base, pair.quote)?.baseReserve).toBe(412_500);
    expect(ammSummary(result, pair.base, { currency: "EUR", issuer: "rX" })).toBeNull();
  });
});

describe("route ranking", () => {
  it("ranks available routes by output and measures shortfall", () => {
    const summary = routeSummary(fixtureCompare(pair, "1000"));
    expect(summary.best?.route).toBe("path");
    expect(summary.best?.deltaBps).toBe(0);
    expect(summary.routes.every((route, index, all) => index === 0 || all[index - 1]!.output >= route.output)).toBe(true);
    expect(summary.savings).toBeGreaterThan(0);
  });

  it("separates unavailable routes", () => {
    const summary = routeSummary({
      ...fixtureCompare(pair, "100"),
      routes: [
        { venue_id: "a", route: "amm", input_amount: "100", output_amount: "51", price: "0.51", available: true },
        { venue_id: "b", route: "order-book", input_amount: "100", output_amount: "0", price: "0", available: false, detail: "No depth" },
      ],
    });
    expect(summary.routes).toHaveLength(1);
    expect(summary.unavailable).toHaveLength(1);
    expect(summary.savings).toBe(0);
  });

  it("keeps fixture prices consistent across sizes", () => {
    const mid = bookSummary(depthSide(fixtureDepth(pair, "bid"), "bid"), depthSide(fixtureDepth(pair, "ask"), "ask")).mid;
    for (const size of FIXTURE_TRADE_SIZES) {
      const best = routeSummary(fixtureCompare(pair, size)).best!;
      expect(Math.abs(deviationBps(best.effectivePrice, mid)!)).toBeLessThan(150);
    }
  });
});
