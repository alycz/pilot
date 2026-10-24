import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ComparisonScannerBars,
  ExecutableSlippageChart,
  OrderBookDepthChart,
  SampledPriceChart,
  type AnalyticsCoverage,
} from "./analytics-charts";

const coverage: AnalyticsCoverage = {
  source: "Harbor · dex.analytics",
  observedAt: "2026-10-23T12:05:00.000Z",
  coverageStart: "2026-10-23T12:00:00.000Z",
  coverageEnd: "2026-10-23T12:05:00.000Z",
  status: "ready",
};

describe("SampledPriceChart", () => {
  it("renders observed segments without joining an explicit collection gap", () => {
    const markup = renderToStaticMarkup(createElement(SampledPriceChart, {
      baseLabel: "XRP",
      quoteLabel: "RLUSD",
      coverage,
      observations: [
        { at: "2026-10-23T12:00:00.000Z", value: 0.5, ledgerIndex: 1 },
        { at: "2026-10-23T12:01:00.000Z", value: 0.51, ledgerIndex: 2 },
        { at: "2026-10-23T12:04:00.000Z", value: 0.49, ledgerIndex: 5, gapBefore: true },
        { at: "2026-10-23T12:05:00.000Z", value: 0.505, ledgerIndex: 6 },
      ],
    }));
    expect(markup.match(/data-series="price-observations"/g)).toHaveLength(2);
    expect(markup).toContain("1 explicit sampling gap");
    expect(markup).toContain("not an inferred candle series");
    expect(markup).toContain("Harbor · dex.analytics");
  });

  it("does not draw a price line from one observation", () => {
    const markup = renderToStaticMarkup(createElement(SampledPriceChart, {
      baseLabel: "XRP", quoteLabel: "RLUSD", coverage,
      observations: [{ at: "2026-10-23T12:00:00.000Z", value: 0.5 }],
    }));
    expect(markup).toContain("Insufficient observations");
    expect(markup).toContain("does not fabricate history");
    expect(markup).not.toContain('data-series="price-observations"');
  });
});

describe("OrderBookDepthChart", () => {
  it("labels one-sided depth as partial and never invents the missing side", () => {
    const markup = renderToStaticMarkup(createElement(OrderBookDepthChart, {
      baseLabel: "XRP", quoteLabel: "RLUSD", coverage,
      bids: [{ price: 0.5, cumulative: 100 }, { price: 0.49, cumulative: 250 }],
      asks: [],
    }));
    expect(markup).toContain("Partial coverage");
    expect(markup).toContain('data-series="bid-depth"');
    expect(markup).not.toContain('data-series="ask-depth"');
    expect(markup).toContain("spread and mid should not be inferred");
  });

  it("shows a no-liquidity state instead of a flat curve", () => {
    const markup = renderToStaticMarkup(createElement(OrderBookDepthChart, {
      baseLabel: "XRP", quoteLabel: "RLUSD", coverage, bids: [], asks: [],
    }));
    expect(markup).toContain("No funded liquidity");
    expect(markup).not.toContain('data-series="bid-depth"');
    expect(markup).not.toContain('data-series="ask-depth"');
  });
});

describe("ExecutableSlippageChart", () => {
  it("requires two bounded observations and filters non-finite points", () => {
    const markup = renderToStaticMarkup(createElement(ExecutableSlippageChart, {
      inputUnit: "XRP", coverage,
      points: [{ input: 100, slippageBps: 12 }, { input: 200, slippageBps: Number.POSITIVE_INFINITY }],
    }));
    expect(markup).toContain("Insufficient quote sizes");
    expect(markup).not.toContain('data-series="slippage-observations"');
  });

  it("renders only an observed slippage series", () => {
    const markup = renderToStaticMarkup(createElement(ExecutableSlippageChart, {
      inputUnit: "XRP", coverage,
      points: [{ input: 10, slippageBps: 2 }, { input: 100, slippageBps: 18 }],
    }));
    expect(markup).toContain('data-series="slippage-observations"');
    expect(markup).toContain("2 executable quote observations");
  });
});

describe("ComparisonScannerBars", () => {
  it("keeps unavailable markets visible but excludes them from ranking bars", () => {
    const markup = renderToStaticMarkup(createElement(ComparisonScannerBars, {
      metricLabel: "Observed spread", unit: "bps", coverage,
      items: [
        { id: "xrp-rlusd", label: "XRP / RLUSD", value: 18, status: "observed" },
        { id: "xrp-usd", label: "XRP / USD", value: null, status: "unavailable", detail: "No funded asks" },
      ],
    }));
    expect(markup.match(/data-series="scanner-bar"/g)).toHaveLength(1);
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("1 of 2 rows have comparable observed values");
  });
});
