import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BacktestsWorkbench } from "./backtests-workbench";
import { BACKTESTS_FIXTURE_VIEW_MODEL } from "./fixture-view-model";

describe("backtests workbench", () => {
  it("shows the complete research workflow without decorative performance before a run", () => {
    const markup = renderToStaticMarkup(createElement(BacktestsWorkbench, { model: BACKTESTS_FIXTURE_VIEW_MODEL }));

    for (const text of [
      "Backtest an investing rule before acting",
      "Not run · historical coverage not loaded",
      "Dataset, portfolio, strategy, and costs",
      "Long-only allocation band v1",
      "Equity, benchmark, and drawdown",
      "Signals, next-bar fills, and rejections",
      "Saved-run comparison",
      "Reproducibility report",
      "Hypothesis → experiment → outcome",
      "Market-level bars do not prove historical XRPL DEX fills or liquidity",
    ]) expect(markup).toContain(text);
    expect(markup).toContain("No performance result is shown");
    expect(markup).toContain("Actual coverage");
    expect(markup).toContain("Not yet verified");
    expect(markup).toContain("rounded-xl");
    expect(markup).not.toContain("font-display");
    expect(markup).not.toContain("+4.20%");
  });

  it("exposes labeled setup fields and keyboard-readable exact result tables", () => {
    const markup = renderToStaticMarkup(createElement(BacktestsWorkbench, { model: BACKTESTS_FIXTURE_VIEW_MODEL }));

    for (const fieldId of ["dataset", "date-window", "strategy", "starting-portfolio", "target-band", "costs"]) {
      expect(markup).toContain(`for="${fieldId}"`);
      expect(markup).toContain(`id="${fieldId}"`);
      expect(markup).toContain(`aria-describedby="${fieldId}-help"`);
    }
    expect(markup.match(/tabindex="0"/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="Equity and drawdown data table"');
    expect(markup).toContain('aria-label="Backtest trade event log"');
    expect(markup).toContain('aria-label="Saved backtest run comparison"');
  });

  it("renders authoritative decimal strings instead of rounded chart projections", () => {
    const model = {
      ...BACKTESTS_FIXTURE_VIEW_MODEL,
      equity: [{
        date: "2026-09-30",
        strategyEquity: 1010.25,
        strategyEquityDisplay: "1010.250000000001 USD",
        benchmarkEquity: 1005,
        benchmarkEquityDisplay: "1005 USD",
        drawdownBps: 20,
        drawdownDisplay: "−0.20%",
      }, {
        date: "2026-10-01",
        strategyEquity: 1011,
        strategyEquityDisplay: "1011 USD",
        benchmarkEquity: 1006,
        benchmarkEquityDisplay: "1006 USD",
        drawdownBps: 0,
        drawdownDisplay: "0.00%",
      }],
    };
    const markup = renderToStaticMarkup(createElement(BacktestsWorkbench, { model }));
    expect(markup).toContain("1010.250000000001 USD");
    expect(markup).toContain("1005 USD");
    expect(markup).toContain("−0.20%");
    expect(markup).toContain("Exact values are available in the keyboard-readable table");
  });

  it("is responsive and reduced-motion safe with no transaction authority", () => {
    const markup = renderToStaticMarkup(createElement(BacktestsWorkbench, { model: BACKTESTS_FIXTURE_VIEW_MODEL }));

    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("sm:grid-cols-2");
    expect(markup).toContain("motion-reduce:transition-none");
    expect(markup).toContain("No wallet address or balance is required");
    expect(markup).toContain("No leverage, shorts, transaction building, signing, approval, or submission");
    expect(markup).not.toMatch(/Connect wallet|Approve transaction|Submit transaction|Guaranteed profit/);
  });
});
