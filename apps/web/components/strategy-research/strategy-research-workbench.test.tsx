import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StrategyResearchWorkbench } from "./strategy-research-workbench";

describe("strategy research workbench", () => {
  it("shows explicit fixture, assumptions, benchmark, drawdown, coverage, and OOS boundaries", () => {
    const markup = renderToStaticMarkup(createElement(StrategyResearchWorkbench));
    for (const text of [
      "Strategy research · simulation only",
      "Fixture data · historical coverage unavailable",
      "Reproducible software evidence, not market performance",
      "Hold benchmark",
      "Maximum drawdown",
      "Training window",
      "Out-of-sample window",
      "Modeled slippage",
      "Maximum gross notional",
      "Missing intervals",
      "Interval / tolerance",
      "Validated historical coverage is not supplied",
    ]) expect(markup).toContain(text);
    expect(markup).toContain("rounded-xl");
    expect(markup).toContain("font-display");
  });

  it("is keyboard-readable, responsive, reduced-motion safe, and has no execution affordance", () => {
    const markup = renderToStaticMarkup(createElement(StrategyResearchWorkbench));
    expect(markup).toContain('aria-label="Modeled research fills table"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("motion-reduce:transition-none");
    expect(markup).toContain("cannot build, sign, approve, or submit");
    expect(markup).toContain("No automatic arbitrage execution is implemented or implied");
    expect(markup).toContain("Requested gross");
    expect(markup).toContain("Gross notional");
    expect(markup).toContain("Net cash flow");
    expect(markup).toContain("boundary observation remain inside return and drawdown");
    expect(markup).not.toMatch(/<button|Connect wallet|Approve transaction|Submit transaction/);
  });

  it("documents native XRPL AMM mechanics without concentrated-liquidity claims", () => {
    const markup = renderToStaticMarkup(createElement(StrategyResearchWorkbench));
    expect(markup).toContain("native constant-product AMM pricing");
    expect(markup).toContain("one pool per pair");
    expect(markup).toContain("not concentrated-range liquidity");
  });
});
