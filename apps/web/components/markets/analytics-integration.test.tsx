import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AnalyticsSnapshot } from "./analytics-panels";
import { AnalyticsWorkspace, type AnalyticsWorkspaceProps } from "./analytics-workspace";

const OBSERVED_AT = "2026-10-23T12:05:00.000Z";
const COVERAGE_START = "2026-10-23T12:00:00.000Z";

function snapshot(overrides: Partial<AnalyticsSnapshot> = {}): AnalyticsSnapshot {
  return {
    id: "testnet:xrp-rlusd",
    label: "XRP / RLUSD",
    base: { symbol: "XRP", currency: "XRP" },
    quote: {
      symbol: "RLUSD",
      currency: "RLUSD",
      issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
    },
    status: "ready",
    provenance: {
      network: "testnet",
      source: "Harbor / XRPL JSON-RPC",
      observedAt: OBSERVED_AT,
      ledgerIndex: 12_345,
      freshnessMs: 1_000,
      mode: "live",
    },
    price: 0.518,
    priceUnit: "RLUSD per XRP",
    bestBid: 0.517,
    bestAsk: 0.519,
    spreadBps: 38.6,
    bidDepth: 2_500,
    askDepth: 2_100,
    depthUnit: "XRP",
    history: {
      points: [
        { at: COVERAGE_START, price: 0.516, ledgerIndex: 12_340 },
        { at: OBSERVED_AT, price: 0.518, ledgerIndex: 12_345 },
      ],
      startedAt: COVERAGE_START,
      endedAt: OBSERVED_AT,
      coverage: "sampled-live",
    },
    depth: [
      { side: "bid", price: 0.517, size: 1_000, cumulative: 1_000, offers: 2 },
      { side: "ask", price: 0.519, size: 900, cumulative: 900, offers: 1 },
    ],
    liquidity: [
      {
        id: "quote-100",
        inputAmount: 100,
        estimatedOutput: 51.6,
        averagePrice: 0.516,
        priceImpactBps: 38.6,
        route: "XRPL DEX funded offers",
        available: true,
      },
    ],
    comparisons: [
      {
        id: "order-book",
        label: "XRP / RLUSD order book",
        venue: "XRPL DEX",
        price: 0.518,
        spreadBps: 38.6,
        depth: 4_600,
        depthUnit: "XRP",
        observedAt: OBSERVED_AT,
        status: "available",
      },
      {
        id: "amm",
        label: "XRP / RLUSD AMM",
        venue: "XRPL AMM",
        price: null,
        spreadBps: null,
        depth: null,
        depthUnit: "XRP",
        observedAt: OBSERVED_AT,
        status: "unavailable",
        note: "No matching AMM returned by this read.",
      },
    ],
    amm: {
      account: "rExamplePool",
      baseReserve: 200_000,
      quoteReserve: 103_600,
      feeBps: 30,
      lpSupply: null,
      reserveUnit: "XRP",
    },
    ...overrides,
  };
}

function render(props: Partial<AnalyticsWorkspaceProps> = {}): string {
  return renderToStaticMarkup(createElement(AnalyticsWorkspace, {
    state: "ready",
    snapshots: [snapshot()],
    selectedId: "testnet:xrp-rlusd",
    ...props,
  }));
}

describe("AnalyticsWorkspace states", () => {
  it("keeps source, network, issuer, ledger, freshness, coverage, and units attached to ready observations", () => {
    const markup = render({
      onQueryChange: vi.fn(),
      onSelect: vi.fn(),
      onSelectComparison: vi.fn(),
      onRefresh: vi.fn(),
      selectedComparisonId: "order-book",
    });

    expect(markup).toContain('aria-label="XRPL market analytics workspace"');
    expect(markup).toContain('aria-label="Market data provenance"');
    expect(markup).toContain('aria-label="Observed market metrics"');
    expect(markup).toContain("Harbor / XRPL JSON-RPC");
    expect(markup).toContain("testnet");
    expect(markup).toContain("12,345");
    expect(markup).toContain("rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV");
    expect(markup).toContain("RLUSD per XRP");
    expect(markup).toContain("sampled live");
    expect(markup).toContain("Captured since this live session began");
    expect(markup).toContain("Read-only analytics.");
    expect(markup).toContain("does not grant signing or execution authority");
  });

  it("renders loading, empty, and error states without leaking a previous observation", () => {
    const loading = render({ state: "loading" });
    expect(loading).toContain('aria-label="Loading market analytics"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain("0.518");
    expect(loading.match(/animate-pulse/g)).toHaveLength(10);
    expect(loading.match(/motion-reduce:animate-none/g)).toHaveLength(10);

    const empty = render({ state: "empty", snapshots: [] });
    expect(empty).toContain("No market observations");
    expect(empty).toContain("does not fill empty panels with generated market data");
    expect(empty).not.toContain("Harbor / XRPL JSON-RPC");

    const error = render({ state: "error", error: "Upstream read timed out.", onRefresh: vi.fn() });
    expect(error).toContain('role="alert"');
    expect(error).toContain("Market reads unavailable");
    expect(error).toContain("Upstream read timed out.");
    expect(error).toContain("Retry reads");
    expect(error).not.toContain("0.518");
  });

  it("labels partial and stale data instead of presenting it as a fresh live read", () => {
    const partial = snapshot({
      status: "partial",
      unavailableReason: "One order-book side and the matching AMM were unavailable.",
      provenance: {
        network: "testnet",
        source: "Harbor / XRPL JSON-RPC",
        observedAt: OBSERVED_AT,
        ledgerIndex: 12_345,
        freshnessMs: 180_000,
        stale: true,
        mode: "live",
      },
      bestAsk: null,
      askDepth: null,
      amm: null,
      history: {
        points: [{ at: OBSERVED_AT, price: 0.518, ledgerIndex: 12_345 }],
        startedAt: OBSERVED_AT,
        endedAt: OBSERVED_AT,
        coverage: "sampled-live",
        incomplete: true,
      },
    });
    const markup = render({ snapshots: [partial] });

    expect(markup).toContain("partial data");
    expect(markup).toContain("Some upstream observations are unavailable");
    expect(markup).toContain("3 min old");
    expect(markup).toContain("sampled live · incomplete");
    expect(markup).toContain("Not enough observations to draw a series");
    expect(markup).toContain("No matching AMM observed");
    expect(markup).not.toContain("Illustrative demo fixture.");
  });

  it("marks demo fixtures explicitly and does not describe them as current ledger observations", () => {
    const demo = snapshot({
      provenance: {
        network: "testnet",
        source: "Bundled analytics fixture",
        observedAt: OBSERVED_AT,
        ledgerIndex: 12_345,
        freshnessMs: undefined,
        mode: "demo",
      },
      history: {
        points: [{ at: OBSERVED_AT, price: 0.518, ledgerIndex: 12_345 }],
        startedAt: OBSERVED_AT,
        endedAt: OBSERVED_AT,
        coverage: "illustrative-fixture",
        incomplete: true,
      },
    });
    const markup = render({ snapshots: [demo] });

    expect(markup).toContain("Illustrative demo fixture.");
    expect(markup).toContain("not represented as current ledger observations");
    expect(markup).toContain("Bundled analytics fixture");
    expect(markup).toContain("illustrative fixture · incomplete");
    expect(markup).not.toContain("sampled live");
  });
});

describe("AnalyticsWorkspace interaction semantics", () => {
  it("exposes the terminal regions and keyboard-reachable market and comparison controls", () => {
    const markup = render({
      onQueryChange: vi.fn(),
      onSelect: vi.fn(),
      onSelectComparison: vi.fn(),
      onActivePanelChange: vi.fn(),
      onRefresh: vi.fn(),
      selectedComparisonId: "order-book",
    });

    const searchInput = markup.match(/<input type="search"[^>]*>/)?.[0];
    expect(searchInput).toBeDefined();
    expect(searchInput).not.toMatch(/\sdisabled(?:=|\s|\/?\>)/);
    expect(markup).toContain('aria-label="Select market pair"');
    expect(markup).toContain('role="option"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('aria-label="Market book and trade preview"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Markets terminal panels"');
    expect(markup).toContain('id="markets-terminal-panel-overview"');
    expect(markup).toContain('id="markets-terminal-panel-book"');
    expect(markup).toContain('id="markets-terminal-panel-liquidity"');
    expect(markup).toContain('id="markets-terminal-panel-compare"');
    expect(markup).toContain('aria-label="Observed market comparison scanner"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain("overflow-x-auto");
    expect(markup).not.toContain("Trade now");
    expect(markup).not.toContain("Sign transaction");
    expect(markup).not.toContain("Message Pilot");
    expect(markup).not.toContain("/api/chat");
  });

  it("uses a roving, controlled mobile tab surface without discarding the selected market or search", () => {
    const mainnet = snapshot({
      id: "mainnet:xrp-rlusd",
      provenance: {
        network: "mainnet",
        source: "Harbor / XRPL JSON-RPC",
        observedAt: OBSERVED_AT,
        ledgerIndex: 99_001,
        freshnessMs: 2_000,
        mode: "live",
      },
      price: 0.521,
    });
    const markup = render({
      snapshots: [snapshot(), mainnet],
      selectedId: mainnet.id,
      query: "RLUSD",
      activePanel: "book",
      onQueryChange: vi.fn(),
      onSelect: vi.fn(),
      onActivePanelChange: vi.fn(),
    });

    expect(markup).toMatch(/<input[^>]+type="search"[^>]+value="RLUSD"/);
    expect(markup).toContain("99,001");
    expect(markup).toContain("0.521");
    expect(markup.match(/role="option"/g)).toHaveLength(2);
    expect(markup.match(/role="tab"/g)).toHaveLength(4);
    expect(markup).toMatch(/id="markets-terminal-tab-book"[^>]+aria-selected="true"[^>]+aria-controls="markets-terminal-panel-book"[^>]+tabindex="0"/);
    expect(markup).toMatch(/id="markets-terminal-tab-overview"[^>]+aria-selected="false"[^>]+tabindex="-1"/);
    expect(markup).toContain('id="markets-terminal-panel-book" role="tabpanel" aria-label="Book" class="block"');
  });

  it("keeps the right-rail trade handoff bounded and delegates to the existing approval conversation", () => {
    const mixedLiquidity = snapshot({
      liquidity: [
        ...snapshot().liquidity,
        {
          id: "quote-1000",
          inputAmount: 1_000,
          estimatedOutput: null,
          averagePrice: null,
          priceImpactBps: null,
          route: "XRPL DEX funded offers",
          available: false,
          reason: "Only 400 XRP was observed within bounded depth.",
        },
      ],
    });
    const markup = render({ activePanel: "liquidity", snapshots: [mixedLiquidity] });

    expect(markup).toContain("Trade preview");
    expect(markup).toContain('aria-label="Read-only executable estimates"');
    expect(markup).toContain("Estimates are observations, not reserved quotes");
    expect(markup).toContain('href="/chat"');
    expect(markup).toContain("Review in workspace chat");
    expect(markup).toContain("1,000 XRP");
    expect(markup).toContain("Only 400 XRP was observed within bounded depth.");
    expect(markup).not.toContain("Sign transaction");
    expect(markup).not.toContain("Submit transaction");
    expect(markup).not.toContain("Connect wallet");
  });

  it("never exposes the approval handoff for mainnet observations or demo fixtures", () => {
    const mainnet = snapshot({
      id: "mainnet:xrp-rlusd",
      provenance: {
        network: "mainnet",
        source: "Harbor / XRPL JSON-RPC",
        observedAt: OBSERVED_AT,
        ledgerIndex: 99_001,
        freshnessMs: 2_000,
        mode: "live",
      },
    });
    const demo = snapshot({
      provenance: {
        network: "testnet",
        source: "Bundled analytics fixture",
        observedAt: OBSERVED_AT,
        ledgerIndex: 12_345,
        mode: "demo",
      },
    });

    const mainnetMarkup = render({ snapshots: [mainnet], selectedId: mainnet.id });
    expect(mainnetMarkup).toContain("Mainnet observation · signing disabled");
    expect(mainnetMarkup).not.toContain('href="/chat"');

    const demoMarkup = render({ snapshots: [demo] });
    expect(demoMarkup).toContain("Illustrative fixture · no approval path");
    expect(demoMarkup).not.toContain('href="/chat"');
  });

  it("keeps no-liquidity and filtered results honest", () => {
    const noLiquidity = snapshot({
      status: "empty",
      unavailableReason: "No funded liquidity was observed for this pair.",
      price: null,
      bestBid: null,
      bestAsk: null,
      spreadBps: null,
      bidDepth: null,
      askDepth: null,
      history: { points: [], coverage: "sampled-live", incomplete: true },
      depth: [],
      liquidity: [],
      comparisons: [],
      amm: null,
    });
    const honestEmpty = render({ snapshots: [noLiquidity] });
    expect(honestEmpty).toContain("No funded liquidity was observed for this pair.");
    expect(honestEmpty).toContain("Not enough observations to draw a series");
    expect(honestEmpty).toContain("No funded order-book levels");
    expect(honestEmpty).toContain("No quote sizes requested");
    expect(honestEmpty).toContain("No executable estimate · approval entry unavailable");
    expect(honestEmpty).not.toContain('href="/chat"');
    expect(honestEmpty).toContain("No comparable observations");
    expect(honestEmpty).not.toContain("0 bps");

    const filtered = render({ query: "does-not-exist", onQueryChange: vi.fn() });
    expect(filtered).toContain("No matching markets");
    expect(filtered).toContain("does-not-exist");
  });
});
