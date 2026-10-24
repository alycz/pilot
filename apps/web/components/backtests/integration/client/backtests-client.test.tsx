import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BacktestsClient } from "./backtests-client";

describe("BacktestsClient", () => {
  it("renders labeled controls without fetching during SSR", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const markup = renderToStaticMarkup(createElement(BacktestsClient));
    expect(fetcher).not.toHaveBeenCalled();
    for (const label of ["Dataset", "Start day", "Out-of-sample start", "Starting XRP", "Venue fee", "Hypothesis"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("Run deterministic backtest");
    expect(markup).toContain("External public historical data · not verified for executable liquidity");
    expect(markup).toContain("rounded-xl");
    expect(markup).toContain("rounded-md");
    expect(markup).toContain("never silently substitutes fixture data");
    expect(markup).not.toContain("Explain saved evidence in chat");
    vi.unstubAllGlobals();
  });
});
