import { describe, expect, it } from "vitest";

import {
  appendHistoryPoint,
  compareMarkets,
  deriveSpread,
  executableBookQuote,
  formatExactDecimal,
  parseExactDecimal,
} from "./analytics-model";
import type { AnalyticsDepthLevel, AnalyticsPricePoint, PairAnalyticsSnapshot } from "./analytics-types";

const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

function level(price: string, baseSize = "10"): AnalyticsDepthLevel {
  return { price, baseSize, quoteSize: null, offerCount: 1, cumulativeBaseSize: baseSize };
}

function snapshot(overrides: Partial<PairAnalyticsSnapshot> = {}): PairAnalyticsSnapshot {
  return {
    pair: { base: { kind: "native", currency: "XRP", issuer: null }, quote: { kind: "issued", currency: "USD", issuer } },
    meta: {
      network: "testnet",
      mode: "live",
      source: { operation: "analytics.marketSnapshot", providers: ["rippled"], requestCount: 3, bounded: true },
      observedAt: "2026-10-23T12:00:00.000Z",
      ledgerIndex: 12,
      ledgerIndexes: { bids: 12, asks: 12, amm: 12 },
      ledgerCloseTime: "2026-10-23T12:00:00.000Z",
      receivedAt: "2026-10-23T12:00:01.000Z",
      freshness: { state: "fresh", ageMs: 1_000, maxAgeMs: 30_000 },
      units: { price: "USD/XRP", baseSize: "XRP", quoteSize: `USD.${issuer}` },
    },
    book: { bids: [level("0.999999999999999999")], asks: [level("1.000000000000000001")], limited: false, maxLevels: 50, availability: { bids: "available", asks: "available" }, invalidOfferCount: 0 },
    metrics: { bestBid: "0.999999999999999999", bestAsk: "1.000000000000000001", mid: "1", spread: "0.000000000000000002", spreadBps: "0.00000000000002" },
    executableLiquidity: [],
    amm: { account: null, baseReserve: "1000000000000000000", quoteReserve: "1000000000000000000", tradingFeeBps: "30", impliedPrice: "1", units: {} },
    availability: { amm: "available" },
    history: [],
    recentTrades: { support: "unsupported", rows: [], reason: "not reconstructed" },
    ...overrides,
  };
}

describe("exact decimal math", () => {
  it("preserves values beyond JavaScript number precision", () => {
    expect(formatExactDecimal(parseExactDecimal("123456789012345678.000000000000000001")))
      .toBe("123456789012345678.000000000000000001");
    expect(formatExactDecimal(parseExactDecimal("1.2300e3"))).toBe("1230");
    expect(() => parseExactDecimal("NaN")).toThrow("Invalid decimal");
  });

  it("derives a tiny spread without collapsing it to zero", () => {
    const spread = deriveSpread({
      bids: [level("0.999999999999999999")],
      asks: [level("1.000000000000000001")],
    });
    expect(spread.midpoint).toBe("1");
    expect(spread.spread).toBe("0.000000000000000002");
    expect(spread.spreadBps).toBe("0.00000000000002");
    expect(spread.condition).toBe("two-sided");
  });
});

describe("order-book boundaries", () => {
  it("distinguishes empty, one-sided and crossed books", () => {
    expect(deriveSpread({ bids: [], asks: [] }).condition).toBe("empty");
    expect(deriveSpread({ bids: [level("1")], asks: [] })).toMatchObject({ condition: "one-sided", midpoint: "1", spread: null });
    expect(deriveSpread({ bids: [level("1.1")], asks: [level("1")] })).toMatchObject({ condition: "crossed", spread: "-0.1" });
  });

  it("returns a truthful partial fill instead of extrapolating missing depth", () => {
    const quote = executableBookQuote({
      side: "sell",
      requestedBase: "3",
      referencePrice: "1",
      levels: [level("1", "1"), level("0.9", "1")],
    });
    expect(quote).toMatchObject({
      filledBase: "2",
      quoteAmount: "1.9",
      averagePrice: "0.95",
      slippageBps: "500",
      complete: false,
      unavailableReason: "insufficient-depth",
    });
  });

  it("reports no liquidity and bounds the number of consumed levels", () => {
    expect(executableBookQuote({ side: "buy", requestedBase: "1", levels: [] })).toMatchObject({
      filledBase: "0",
      complete: false,
      unavailableReason: "no-liquidity",
    });
    const many = Array.from({ length: 250 }, () => level("1", "1"));
    expect(executableBookQuote({ side: "buy", requestedBase: "250", levels: many, maxLevels: 500 })).toMatchObject({
      filledBase: "200",
      levelsUsed: 200,
      complete: false,
    });
  });
});

describe("comparison scanner", () => {
  it("retains but excludes stale and outlier observations", () => {
    const stale = snapshot({
      meta: { ...snapshot().meta, freshness: { state: "stale", ageMs: 60_000, maxAgeMs: 30_000 } },
    });
    const outlier = snapshot({
      amm: { account: null, baseReserve: "1", quoteReserve: "10", tradingFeeBps: null, impliedPrice: "10", units: {} },
    });
    const [staleRow, outlierRow] = compareMarkets([stale, outlier], { maxAbsDivergenceBps: "5000" });
    expect(staleRow).toMatchObject({ excluded: true, exclusionReason: "Stale observation" });
    expect(outlierRow).toMatchObject({ excluded: true, exclusionReason: "Divergence exceeds outlier threshold" });
    expect(outlierRow!.divergenceBps).toBe("90000");
  });

  it("excludes zero AMM reserves instead of manufacturing a price", () => {
    const invalid = snapshot({ amm: { account: null, baseReserve: "0", quoteReserve: "10", tradingFeeBps: null, impliedPrice: "0", units: {} } });
    expect(compareMarkets([invalid])[0]).toMatchObject({ excluded: true, ammPrice: null, exclusionReason: "No usable AMM reserves" });
  });
});

describe("sampled history", () => {
  it("de-duplicates, sorts, and enforces the hard 250-sample ring bound", () => {
    let history: AnalyticsPricePoint[] = Array.from({ length: 250 }, (_, index) => ({
      observedAt: new Date(Date.UTC(2026, 9, 23, 0, 0, index)).toISOString(),
      ledgerIndex: index + 1,
      price: String(index + 1),
    }));
    history = appendHistoryPoint(history, {
      observedAt: new Date(Date.UTC(2026, 9, 23, 0, 5, 0)).toISOString(),
      ledgerIndex: 251,
      price: "251",
    }, 999);
    expect(history).toHaveLength(250);
    expect(history[0]!.ledgerIndex).toBe(2);
    expect(history.at(-1)!.ledgerIndex).toBe(251);
    expect(appendHistoryPoint(history, history.at(-1)!, 250)).toHaveLength(250);
  });
});
