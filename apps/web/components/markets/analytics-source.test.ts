import { describe, expect, it, vi } from "vitest";

import {
  ANALYTICS_MAX_HISTORY_SAMPLES,
  ANALYTICS_MAX_LEVELS,
  ANALYTICS_MAX_QUOTE_SIZES,
  fetchMarketAnalytics,
  normalizeAnalyticsEnvelope,
  scopeAnalyticsRequest,
  type AnalyticsRequest,
} from "./analytics-source";

const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const request: AnalyticsRequest = {
  network: "testnet",
  pair: { base: { currency: "XRP" }, quote: { currency: "USD", issuer } },
};
const now = Date.parse("2026-10-23T12:00:10.000Z");

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    asOf: "2026-10-23T12:00:05.000Z",
    asOfBasis: "validated-ledger",
    data: {
      network: "testnet",
      pair: {
        base: { kind: "native", currency: "XRP", issuer: null },
        quote: { kind: "issued", currency: "USD", issuer },
      },
      source: { operation: "analytics.marketSnapshot", providers: ["xrpl:book_offers", "xrpl:amm_info"], request_count: 3, bounded: true },
      observed_at: "2026-10-23T12:00:05.000Z",
      ledger_index: 123,
      ledger_indexes: { bids: 123, asks: 123, amm: 123 },
      freshness: { status: "live-observation", basis: "validated-ledger", age_seconds: null, note: "Observed by Harbor." },
      units: { base_size: "XRP display units", quote_size: "USD display units", price: "USD per XRP", spread_bps: "basis points" },
      book: {
        bids: [{ price: "0.99", base_size: "100", quote_size: "99", offer_count: 2, cumulative_base_size: "100" }],
        asks: [{ price: "1.01", base_size: "100", quote_size: "101", offer_count: 2, cumulative_base_size: "100" }],
        limited: false,
        max_levels: 50,
        availability: { bids: "available", asks: "available" },
        invalid_offer_count: 0,
      },
      metrics: { best_bid: "0.99", best_ask: "1.01", mid: "1", spread: "0.02", spread_bps: "200" },
      executable_liquidity: [{
        base_amount: "1",
        sell_base: { direction: "sell-base", requested_base: "1", filled_base: "1", quote_amount: "0.99", average_price: "0.99", price_impact_bps: "-100", benchmark: "book-mid", available: true, limited_by_depth: false, levels_consumed: 1 },
        buy_base: { direction: "buy-base", requested_base: "1", filled_base: "1", quote_amount: "1.01", average_price: "1.01", price_impact_bps: "100", benchmark: "book-mid", available: true, limited_by_depth: false, levels_consumed: 1 },
      }],
      amm: { account: null, base_reserve: "1000", quote_reserve: "1000", implied_price: "1", trading_fee_bps: "30", units: { base_reserve: "XRP", quote_reserve: "USD", implied_price: "USD/XRP", trading_fee_bps: "basis points" } },
      availability: { amm: "available" },
      history: {
        points: [{ observed_at: "2026-10-23T12:00:05.000Z", ledger_index: 123, price: "1" }],
        started_at: "2026-10-23T12:00:05.000Z",
        ended_at: "2026-10-23T12:00:05.000Z",
        max_samples: 120,
        interval_hint_ms: 4_000,
        complete: true,
      },
      recent_trades: { support: "supported", rows: [], limited: false },
      partial: false,
      partial_reasons: [],
      ...overrides,
    },
  };
}

describe("analytics request scope", () => {
  it("caps upstream work and de-duplicates quote sizes", () => {
    const scoped = scopeAnalyticsRequest({
      ...request,
      depthLimit: 99_999,
      sampleBaseAmounts: Array.from({ length: 30 }, (_, index) => String((index % 15) + 1)),
    });
    expect(scoped.depth_limit).toBe(ANALYTICS_MAX_LEVELS);
    expect(scoped.sample_base_amounts).toHaveLength(ANALYTICS_MAX_QUOTE_SIZES);
  });

  it("requires exact issuer identity and distinct assets", () => {
    expect(() => scopeAnalyticsRequest({ network: "testnet", pair: { base: { currency: "USD" }, quote: { currency: "XRP" } } })).toThrow("issuer");
    expect(() => scopeAnalyticsRequest({ network: "testnet", pair: { base: { currency: "XRP" }, quote: { currency: "XRP" } } })).toThrow("different");
  });
});

describe("analytics response normalization", () => {
  it("carries source, units, observation ledger, and coverage", () => {
    const state = normalizeAnalyticsEnvelope(envelope(), request, { nowMs: now });
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("expected ready state");
    expect(state.data.meta).toMatchObject({
      network: "testnet",
      mode: "live",
      ledgerIndex: 123,
      freshness: { state: "fresh", ageMs: 5_000 },
      coverage: { sampleCount: 1, maxSamples: 120, complete: true },
    });
    expect(state.data.meta.units.price).toBe("USD per XRP");
    expect(state.data.book.bids[0]).toEqual({ price: "0.99", baseSize: "100", quoteSize: "99", offerCount: 2, cumulativeBaseSize: "100" });
  });

  it("marks stale, partial, and fixture observations honestly", () => {
    const stale = normalizeAnalyticsEnvelope(envelope({
      observed_at: "2026-10-23T11:00:00.000Z",
      book: { bids: [], asks: [{ price: "1.01", base_size: "10", quote_size: "10.1", offer_count: 1, cumulative_base_size: "10" }], limited: true, max_levels: 1, availability: { bids: "empty", asks: "available" }, invalid_offer_count: 0 },
      amm: null,
      availability: { amm: "unavailable" },
      history: {
        points: [],
        started_at: "2026-10-23T11:00:00.000Z",
        ended_at: null,
        max_samples: 10,
        interval_hint_ms: null,
        complete: false,
        reason: "Collection started recently",
      },
      recent_trades: { support: "unsupported", rows: [], reason: "Not exposed by this read source" },
      partial: true,
      partial_reasons: ["AMM pool was unavailable"],
    }), request, { nowMs: now });
    expect(stale.status).toBe("partial");
    if (stale.status !== "partial") throw new Error("expected partial state");
    expect(stale.data.meta.freshness.state).toBe("stale");
    expect(stale.issues).toEqual(expect.arrayContaining([
      "Observation exceeded the freshness window",
      "The observed order book is one-sided.",
      "Collection started recently",
    ]));

    const partialObservation = normalizeAnalyticsEnvelope(envelope({
      freshness: { status: "partial-observation", basis: "validated-ledger", age_seconds: null, note: "One source failed." },
    }), request, { nowMs: now });
    expect(partialObservation.status).toBe("partial");
    if (partialObservation.status !== "partial") throw new Error("expected partial observation state");
    expect(partialObservation.data.meta.freshness).toMatchObject({
      state: "unknown",
      reason: "One or more bounded upstream reads were unavailable or incomplete.",
    });

    const demo = normalizeAnalyticsEnvelope(envelope(), request, { mode: "demo-fixture", nowMs: now });
    expect(demo.status).toBe("partial");
    if (demo.status !== "partial") throw new Error("expected partial fixture state");
    expect(demo.data.meta).toMatchObject({ mode: "demo-fixture", freshness: { state: "unknown" } });
  });

  it("does not preserve data on errors or pair/network mismatches", () => {
    expect(normalizeAnalyticsEnvelope({ ok: false, error: { kind: "error", message: "upstream timeout" } }, request, { nowMs: now }))
      .toMatchObject({ status: "error", message: "upstream timeout" });
    const mismatch = normalizeAnalyticsEnvelope(envelope({ network: "mainnet" }), request, { nowMs: now });
    expect(mismatch).toMatchObject({ status: "error", retryable: false });
    expect("data" in mismatch).toBe(false);
  });

  it("represents a bounded soft-empty response as an empty observation, not an upstream failure", () => {
    const state = normalizeAnalyticsEnvelope({
      ok: false,
      error: { kind: "soft-empty", code: "NO_LIQUIDITY", message: "No funded offers were observed for this pair." },
    }, request, { nowMs: now });

    expect(state).toMatchObject({
      status: "empty",
      reason: "no-liquidity",
      message: "No funded offers were observed for this pair.",
      meta: {
        network: "testnet",
        observedAt: null,
        freshness: { state: "unknown", reason: "No market observation was returned." },
      },
    });
    expect("data" in state).toBe(false);
  });

  it("reports no liquidity instead of rendering a zero market", () => {
    const state = normalizeAnalyticsEnvelope(envelope({
      book: { bids: [], asks: [], limited: false, max_levels: 50, availability: { bids: "empty", asks: "empty" }, invalid_offer_count: 0 },
      amm: null,
      availability: { amm: "unavailable" },
      history: null,
      recent_trades: null,
    }), request, { nowMs: now });
    expect(state).toMatchObject({ status: "empty", reason: "no-liquidity" });
  });

  it("treats a response clock far ahead of the client as unknown freshness", () => {
    const state = normalizeAnalyticsEnvelope(envelope({ observed_at: "2026-10-23T12:10:00.000Z" }), request, { nowMs: now });
    expect(state.status).toBe("partial");
    if (state.status !== "partial") throw new Error("expected partial state");
    expect(state.data.meta.freshness).toMatchObject({ state: "unknown", reason: "Observation clock is ahead of this client" });
  });
});

describe("browser Harbor boundary", () => {
  it("uses the read-only Pilot proxy with the bounded request", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.credentials).toBe("same-origin");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ network: "testnet", depth_limit: 100, sample_base_amounts: ["1", "10", "100"] });
      return new Response(JSON.stringify(envelope()), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await fetchMarketAnalytics({ ...request, depthLimit: 999 }, { fetcher: fetcher as typeof fetch, nowMs: now });
    expect(fetcher).toHaveBeenCalledWith("/api/harbor/analytics.marketSnapshot", expect.objectContaining({ method: "POST" }));
    expect(result.status).toBe("ready");
  });
});
