import { describe, expect, it } from "vitest";

import { runBacktest } from "./backtest";
import { strategyDatasetContentDigest } from "./dataset";
import { DETERMINISTIC_STRATEGY_FIXTURE } from "./fixtures";

function goldenDataset() {
  const input = {
    schema_version: "pilot.strategy-dataset.v2" as const,
    dataset_id: "fixture.golden-accounting.v1",
    label: "Golden accounting fixture",
    source_kind: "deterministic_fixture" as const,
    network: "testnet" as const,
    base: { symbol: "XRP", currency: "XRP" },
    quote: { symbol: "USD", currency: "USD", issuer: "rGoldenIssuer" },
    provenance: {
      source_label: "Hand-calculated golden fixture",
      collected_at: "2026-01-02T00:00:00.000Z",
      content_digest: "0".repeat(64),
      methodology: "Four exact observations for boundary and gross/net accounting regression tests.",
    },
    coverage: {
      start_at: "2026-01-01T00:00:00.000Z",
      end_at: "2026-01-01T03:00:00.000Z",
      expected_interval_seconds: 3_600,
      alignment_tolerance_seconds: 0,
      missing_intervals: [],
    },
    split: {
      train_end_at: "2026-01-01T01:00:00.000Z",
      out_of_sample_start_at: "2026-01-01T02:00:00.000Z",
    },
    observations: [1, 1, 2, 2].map((price, index) => ({
      observation_id: `golden-${index + 1}`,
      observed_at: `2026-01-01T0${index}:00:00.000Z`,
      ledger_index: 100 + index,
      clob: {
        ledger_index: 100 + index,
        bid: price,
        ask: price,
        bid_liquidity_base: 1_000,
        ask_liquidity_base: 1_000,
      },
    })),
  };
  input.provenance.content_digest = strategyDatasetContentDigest(input);
  return input;
}

describe("deterministic strategy backtest", () => {
  it("is reproducible and reports benchmark, costs, drawdown, coverage, and OOS boundaries", () => {
    const first = runBacktest(DETERMINISTIC_STRATEGY_FIXTURE);
    const second = runBacktest(structuredClone(DETERMINISTIC_STRATEGY_FIXTURE));
    expect(first).toEqual(second);
    expect(first.sourceKind).toBe("deterministic_fixture");
    expect(first.historicalCoverageAvailable).toBe(false);
    expect(first.sourceDisclosure).toMatch(/not live or historical/i);
    expect(first.coverage).toMatchObject({ observed: 8, expected: 9, missing: 1 });
    expect(first.metrics.full.observations).toBe(8);
    expect(first.metrics.inSample.observations).toBe(4);
    expect(first.metrics.outOfSample.observations).toBe(4);
    expect(first.metrics.full.maxDrawdownBps).toBeGreaterThan(0);
    expect(first.metrics.full.totalCostsQuote).toBeGreaterThan(0);
    expect(Number.isFinite(first.metrics.full.benchmarkReturnBps)).toBe(true);
  });

  it("caps fills by the configured size and observed liquidity", () => {
    const report = runBacktest(DETERMINISTIC_STRATEGY_FIXTURE, { maxTradeQuote: 4 });
    expect(report.trades.length).toBeGreaterThan(0);
    expect(report.trades.every(({ grossNotionalQuote }) => grossNotionalQuote <= 4)).toBe(true);
    expect(report.trades.some(({ partial }) => partial)).toBe(true);
    expect(report.metrics.full.partialFillCount).toBeGreaterThan(0);
  });

  it("makes costs reduce strategy equity and never emits an execution artifact", () => {
    const zeroCost = runBacktest(DETERMINISTIC_STRATEGY_FIXTURE, {
      venueFeeBps: 0,
      assumedSlippageBps: 0,
      networkFeeQuote: 0,
    });
    const costly = runBacktest(DETERMINISTIC_STRATEGY_FIXTURE, {
      venueFeeBps: 100,
      assumedSlippageBps: 100,
      networkFeeQuote: 0.25,
    });
    expect(costly.equityCurve.at(-1)!.strategyEquity).toBeLessThan(zeroCost.equityCurve.at(-1)!.strategyEquity);
    expect(JSON.stringify(costly)).not.toMatch(/tx_json|build_id|approval_id|submit/);
  });

  it("accepts historical data only with an external source-and-digest trust decision", () => {
    const historical = structuredClone(DETERMINISTIC_STRATEGY_FIXTURE);
    historical.source_kind = "validated_historical";
    historical.provenance.source_label = "approved-history";
    historical.provenance.content_digest = strategyDatasetContentDigest(historical);
    expect(() => runBacktest(historical)).toThrow(/externally trusted source and digest/);
    const report = runBacktest(historical, {}, {
      trustedSources: [{
        sourceLabel: historical.provenance.source_label,
        contentDigest: historical.provenance.content_digest,
      }],
    });
    expect(report.historicalCoverageAvailable).toBe(true);
    expect(report.sourceDisclosure).toMatch(/simulations, not forecasts/i);
  });

  it("uses pre-trade window baselines and symmetric gross, cost, and net cash-flow accounting", () => {
    const report = runBacktest(goldenDataset(), {
      initialBase: 0,
      initialQuote: 100,
      targetBaseBps: 5_000,
      bandBps: 100,
      maxTradeQuote: 100,
      venueFeeBps: 100,
      assumedSlippageBps: 0,
      networkFeeQuote: 1,
    });
    const buy = report.trades[0]!;
    const sell = report.trades[1]!;

    expect(buy).toMatchObject({
      side: "buy_base",
      requestedGrossQuote: 50,
      grossNotionalQuote: 50,
      modeledCostsQuote: 1.5,
      netCashFlowQuote: -51.5,
      filledBase: 50,
    });
    expect(sell).toMatchObject({
      side: "sell_base",
      requestedGrossQuote: 25.75,
      grossNotionalQuote: 25.75,
      modeledCostsQuote: 1.2575,
      netCashFlowQuote: 24.4925,
      filledBase: 12.875,
    });
    expect(report.equityCurve[2]).toMatchObject({
      strategyEquityBeforeTrade: 148.5,
      strategyEquity: 147.2425,
    });
    expect(report.metrics.outOfSample).toMatchObject({
      strategyReturnBps: -84.68,
      benchmarkReturnBps: 0,
      maxDrawdownBps: 84.68,
      totalCostsQuote: 1.2575,
    });
  });
});
