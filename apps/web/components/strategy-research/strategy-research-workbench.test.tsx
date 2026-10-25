import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RESEARCH_DEMO_DRAFT,
  StrategyResearchWorkbench,
  evaluateResearchDemo,
  resetResearchDemoDraft,
} from "./strategy-research-workbench";

afterEach(() => vi.unstubAllGlobals());

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
    expect(markup).toContain("Run simulated research");
    expect(markup).toContain("Reset demo");
    expect(markup).toContain('aria-label="Simulated hypothesis comparison"');
    expect(markup).not.toMatch(/Approve transaction|Submit transaction|Start autonomous|Sign transaction/);
  });

  it("documents native XRPL AMM mechanics without concentrated-liquidity claims", () => {
    const markup = renderToStaticMarkup(createElement(StrategyResearchWorkbench));
    expect(markup).toContain("native constant-product AMM pricing");
    expect(markup).toContain("one pool per pair");
    expect(markup).toContain("not concentrated-range liquidity");
  });

  it("offers useful signed-out hypotheses and supported deterministic controls", () => {
    const markup = renderToStaticMarkup(createElement(StrategyResearchWorkbench));
    for (const text of [
      "Interactive simulated research",
      "Balanced rebalance",
      "Tighter intervention band",
      "Cost-stress case",
      "Target XRP allocation",
      "Allocation band",
      "Maximum modeled trade",
      "Assumed slippage",
      "Minimum research edge",
      "No AI model, wallet, provider, live price feed, or execution endpoint is contacted",
      "this local fixture state is discarded",
    ]) expect(markup).toContain(text);
    expect(markup).toContain('id="research-hypothesis"');
    expect(markup).toContain('id="research-target"');
    expect(markup).toContain('id="research-band"');
    expect(markup).toContain('id="research-max-trade"');
    expect(markup).toContain('id="research-slippage"');
    expect(markup).toContain('id="research-edge"');
  });

  it("repeats and resets to the same evidence without any network or model call", () => {
    const fetcher = vi.fn(() => Promise.reject(new Error("network must not be used")));
    vi.stubGlobal("fetch", fetcher);

    const first = evaluateResearchDemo(DEFAULT_RESEARCH_DEMO_DRAFT);
    const repeated = evaluateResearchDemo({ ...DEFAULT_RESEARCH_DEMO_DRAFT });
    const reset = evaluateResearchDemo(resetResearchDemoDraft());

    expect(repeated).toEqual(first);
    expect(reset).toEqual(first);
    expect(first.report.sourceKind).toBe("deterministic_fixture");
    expect(first.report.historicalCoverageAvailable).toBe(false);
    expect(first.fingerprint).toBe(repeated.fingerprint);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
