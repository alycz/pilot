import { describe, expect, it } from "vitest";

import { runDailyBarBacktest } from "./engine";
import type { DailyBarBacktestConfig, DailyBarDataset } from "./types";

function day(dayOfMonth: number, price: string) {
  const startAt = `2026-01-${String(dayOfMonth).padStart(2, "0")}T00:00:00.000Z`;
  return {
    id: `bar-${dayOfMonth}`,
    startAt,
    open: price,
    high: price,
    low: price,
    close: price,
    volumeBase: "1000000",
    complete: true as const,
  };
}

function dataset(prices: readonly string[] = ["1", "1", "2", "2", "2", "4", "4", "4"]): DailyBarDataset {
  return {
    datasetId: "golden.xrp-usd.daily.v1",
    normalizedHash: "a".repeat(64),
    baseSymbol: "XRP",
    quoteSymbol: "USD",
    intervalSeconds: 86_400,
    bars: prices.map((price, index) => day(index + 1, price)),
  };
}

function config(overrides: Partial<DailyBarBacktestConfig> = {}): DailyBarBacktestConfig {
  return {
    initialBase: "0",
    initialQuote: "100",
    targetBaseBps: 5_000,
    bandBps: 0,
    maxTradeQuote: "100",
    spreadBps: 0,
    venueFeeBps: 0,
    slippageBps: 0,
    networkCostQuote: "0",
    outOfSampleStartAt: "2026-01-06T00:00:00.000Z",
    embargoBars: 1,
    ...overrides,
  };
}

describe("daily-bar allocation-band backtest", () => {
  it("matches a hand-calculated long-only portfolio and static benchmark", () => {
    const report = runDailyBarBacktest(dataset(), config());
    expect(report).toMatchObject({
      reportVersion: "pilot.daily-bar-backtest.v1",
      strategyVersion: "allocation-band.v1",
      liquidityModel: "not-modeled",
      fillPriceModel: "next-open-unadjusted",
      proportionalCostModel: "cash-equivalent-quote-deduction",
      missingBuckets: 0,
      split: {
        inSampleEndAt: "2026-01-04T00:00:00.000Z",
        embargoStartAt: "2026-01-05T00:00:00.000Z",
        outOfSampleStartAt: "2026-01-06T00:00:00.000Z",
        embargoBars: 1,
      },
    });
    const filled = report.orders.filter((order) => order.status === "filled");
    expect(filled[0]).toMatchObject({
      signalAt: "2026-01-01T00:00:00.000Z",
      fillAt: "2026-01-02T00:00:00.000Z",
      side: "buy_base",
      requestedGrossQuote: "50",
      grossNotionalQuote: "50",
      filledBase: "50",
      netCashFlowQuote: "-50",
    });
    expect(filled[1]).toMatchObject({
      signalAt: "2026-01-03T00:00:00.000Z",
      fillAt: "2026-01-04T00:00:00.000Z",
      side: "sell_base",
      grossNotionalQuote: "25",
      filledBase: "12.5",
      netCashFlowQuote: "25",
    });
    expect(report.portfolio[3]).toMatchObject({ base: "37.5", quote: "75", strategyEquityQuote: "150" });
    expect(report.portfolio.at(-1)).toMatchObject({ base: "28.125", quote: "112.5", strategyEquityQuote: "225" });
    expect(report.metrics.full).toMatchObject({
      strategyReturnBps: 12_500,
      benchmarkReturnBps: 0,
      excessReturnBps: 12_500,
      turnoverQuote: "112.5",
    });
    expect(report.metrics.outOfSample).toMatchObject({ strategyReturnBps: 0, benchmarkReturnBps: 0 });
    expect(report.executionDisclosure).toMatch(/unadjusted next-bucket open/i);
    expect(report.executionDisclosure).toMatch(/cash-equivalent quote deductions, not worse-price or market-impact/i);
    expect(report.executionDisclosure).toMatch(/not historical XRPL DEX fills/i);
  });

  it("never fills on the signal bar and rejects a training signal at the embargo", () => {
    const prices = ["1", "1", "1", "4", "4", "4", "4", "4"];
    const report = runDailyBarBacktest(dataset(prices), config());
    for (const order of report.orders.filter((candidate) => candidate.status === "filled")) {
      expect(Date.parse(order.fillAt!)).toBeGreaterThan(Date.parse(order.signalAt));
      expect(order.fillAt).toBe(order.scheduledFillAt);
    }
    expect(report.orders).toContainEqual(expect.objectContaining({
      signalAt: "2026-01-04T00:00:00.000Z",
      scheduledFillAt: "2026-01-05T00:00:00.000Z",
      signalPhase: "in_sample",
      status: "rejected",
      rejectionCode: "EMBARGO",
    }));
    expect(report.orders).not.toContainEqual(expect.objectContaining({
      signalAt: "2026-01-04T00:00:00.000Z",
      status: "filled",
    }));
    expect(report.portfolio[4]).toMatchObject({
      phase: "embargo",
      base: report.portfolio[3]!.base,
      quote: report.portfolio[3]!.quote,
    });
    expect(report.orders.some(({ signalAt }) => signalAt === "2026-01-05T00:00:00.000Z")).toBe(false);
  });

  it("marks gaps and rejects rather than bridging a signal across a missing bar", () => {
    const withGap: DailyBarDataset = {
      ...dataset(),
      bars: [day(1, "1"), day(3, "1"), day(4, "1"), day(5, "1"), day(6, "1"), day(7, "1"), day(8, "1")],
    };
    const report = runDailyBarBacktest(withGap, config({ outOfSampleStartAt: "2026-01-07T00:00:00.000Z" }));
    expect(report.missingBuckets).toBe(1);
    expect(report.orders[0]).toMatchObject({
      signalAt: "2026-01-01T00:00:00.000Z",
      scheduledFillAt: "2026-01-02T00:00:00.000Z",
      status: "rejected",
      rejectionCode: "MISSING_NEXT_BAR",
    });
  });

  it("reports each cost separately and keeps balances nonnegative", () => {
    const report = runDailyBarBacktest(dataset(["1", "1", "1", "1", "1", "1", "1", "1"]), config({
      spreadBps: 100,
      venueFeeBps: 200,
      slippageBps: 300,
      networkCostQuote: "1",
    }));
    const fill = report.orders.find((order) => order.status === "filled")!;
    expect(fill.costs).toEqual({
      spreadCostQuote: "0.5",
      venueFeeCostQuote: "1",
      slippageCostQuote: "1.5",
      networkCostQuote: "1",
      totalCostQuote: "4",
    });
    expect(fill.unadjustedReferenceOpen).toBe("1");
    expect(fill.netCashFlowQuote).toBe("-54");
    expect(report.portfolio.every((point) => !point.base.startsWith("-") && !point.quote.startsWith("-"))).toBe(true);
  });

  it("rejects fills whose explicit costs exceed proceeds", () => {
    const report = runDailyBarBacktest(dataset(["1", "1", "1", "1", "1", "1", "1", "1"]), config({
      initialBase: "100",
      initialQuote: "0",
      targetBaseBps: 100,
      maxTradeQuote: "1",
      networkCostQuote: "2",
    }));
    expect(report.orders[0]).toMatchObject({ status: "rejected", rejectionCode: "COST_EXCEEDS_PROCEEDS" });
    expect(report.portfolio[1]).toMatchObject({ base: "100", quote: "0" });
  });

  it("fails closed on rounding and oversized decimal inputs", () => {
    const million = dataset(Array(8).fill("1000000"));
    const tiny = runDailyBarBacktest(million, config({ initialQuote: "0.000000000001", maxTradeQuote: "0.000000000001" }));
    expect(tiny.orders[0]).toMatchObject({ status: "rejected", rejectionCode: "ROUNDING_TO_ZERO" });

    const original = dataset();
    const oversized: DailyBarDataset = {
      ...original,
      bars: original.bars.map((bar, index) => index === 0
        ? { ...bar, open: "1000000000000000001", high: "1000000000000000001" }
        : bar),
    };
    expect(() => runDailyBarBacktest(oversized, config())).toThrow(/range/);
    expect(() => runDailyBarBacktest(dataset(), config({ networkCostQuote: "0.0000000000001" }))).toThrow(/12 decimal/);
  });

  it("fingerprints normalized frozen parameters deterministically", () => {
    const first = runDailyBarBacktest(dataset(), config());
    const second = runDailyBarBacktest(structuredClone(dataset()), { ...config(), initialQuote: "100.0" });
    const changed = runDailyBarBacktest(dataset(), config({ slippageBps: 1 }));
    expect(first.parameterFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.parameterFingerprint).toBe(first.parameterFingerprint);
    expect(changed.parameterFingerprint).not.toBe(first.parameterFingerprint);
  });

  it("does not let next-bar high, low, or close change the prior signal or next-open fill", () => {
    const baseline = dataset();
    const mutated: DailyBarDataset = {
      ...baseline,
      bars: baseline.bars.map((bar, index) => index === 1
        ? { ...bar, open: "1", high: "9", low: "0.5", close: "8" }
        : bar),
    };
    const baselineReport = runDailyBarBacktest(baseline, config());
    const mutatedReport = runDailyBarBacktest(mutated, config());
    const baselineFirstFill = baselineReport.orders[0]!;
    const mutatedFirstFill = mutatedReport.orders[0]!;

    expect(baselineFirstFill).toMatchObject({
      signalAt: "2026-01-01T00:00:00.000Z",
      fillAt: "2026-01-02T00:00:00.000Z",
      unadjustedReferenceOpen: "1",
    });
    expect(mutatedFirstFill).toEqual(baselineFirstFill);
  });

  it("does not turn market-level volume into invented fill liquidity or wallet authority", () => {
    const zeroVolume = dataset();
    const highVolume = dataset();
    const withoutVolume: DailyBarDataset = {
      ...zeroVolume,
      bars: zeroVolume.bars.map((bar) => ({ ...bar, volumeBase: "0" })),
    };
    const withVolume: DailyBarDataset = {
      ...highVolume,
      bars: highVolume.bars.map((bar) => ({ ...bar, volumeBase: "999999999" })),
    };
    const first = runDailyBarBacktest(withoutVolume, config());
    const second = runDailyBarBacktest(withVolume, config());

    expect(first.orders).toEqual(second.orders);
    expect(first.liquidityModel).toBe("not-modeled");
    expect(first.executionDisclosure).toMatch(/liquidity is not modeled/i);
    expect(JSON.stringify(first)).not.toMatch(/wallet|account|approval|capability|transaction|submit/i);
  });
});
