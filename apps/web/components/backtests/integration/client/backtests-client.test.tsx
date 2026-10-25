import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BacktestsClient } from "./backtests-client";

describe("BacktestsClient", () => {
  it("renders an immediate signed-out sample without fetching during SSR", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const markup = renderToStaticMarkup(createElement(BacktestsClient));
    expect(fetcher).not.toHaveBeenCalled();
    for (const label of ["Dataset", "Start day", "Out-of-sample start", "Starting XRP", "Venue fee", "Hypothesis"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("Run simulated sample");
    expect(markup).toContain(">Sample<");
    expect(markup).toContain("Synthetic sample data · not historical, live, or executable");
    expect(markup).toContain("Sample strategy return");
    expect(markup).toContain("Sample hold benchmark");
    expect(markup).toContain("Synthetic next-sample fill");
    expect(markup).toContain("Reset sample");
    expect(markup).toContain("Connect wallet (optional)");
    expect(markup).toContain("rounded-xl");
    expect(markup).toContain("rounded-md");
    expect(markup).not.toContain("Demo · simulated sample results");
    expect(markup).not.toContain("Explain saved evidence in chat");
    vi.unstubAllGlobals();
  });
});
