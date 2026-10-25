import type { ReproducibilityReportInput } from "./report";

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);

export function reportInput(
  overrides: Partial<ReproducibilityReportInput> = {},
): ReproducibilityReportInput {
  const base: ReproducibilityReportInput = {
    engineVersion: "fixed-point.v1",
    dataset: {
      datasetId: "kraken.xrp-usd.daily.2025",
      rawHashSha256: HASH_A,
      normalizedHashSha256: HASH_B,
      sourceRegistryId: "kraken-public-ohlc",
      sourceLabel: "Kraken public XRP/USD daily OHLC",
      pairLabel: "XRP/USD",
      capabilityLabel: "Public daily market bars; not executable XRPL DEX liquidity",
      costLabel: "No API key or paid data plan required",
      coverageLabel: "10 expected UTC daily buckets; 10 observed; 0 missing",
      redistributionLabel: "Local research cache only; redistribution not asserted",
      coverage: {
        startDate: "2025-01-01",
        endDate: "2025-01-10",
        expectedBuckets: 10,
        observedBuckets: 10,
        missingBuckets: 0,
        discardedIncompleteBuckets: 1,
      },
    },
    strategy: {
      strategyId: "allocation-band",
      strategyVersion: "allocation-band.v1",
      parameters: {
        targetBaseBps: 5_000,
        bandBps: 500,
        maxTradeQuote: "25.00",
      },
    },
    split: {
      trainingEndDate: "2025-01-06",
      outOfSampleStartDate: "2025-01-08",
      embargoBars: 1,
      parametersFrozenBeforeOutOfSample: true,
    },
    costs: {
      quoteCurrency: "USD",
      spreadBps: 10,
      venueFeeBps: 10,
      slippageBps: 25,
      networkCostPerFillQuote: "0.01",
      liquidityModel: "not_modeled",
    },
    study: {
      hypothesis: {
        statement: "A bounded allocation rule improves OOS excess return without increasing drawdown.",
        declaredBeforeOutOfSample: true,
      },
      experiment: {
        setupSummary: "Freeze one allocation-band parameter set, embargo one bar, then reveal OOS metrics.",
        primaryMetric: "excess_return_bps",
        outOfSampleHiddenUntilParametersFrozen: true,
      },
      outcome: {
        status: "inconclusive",
        summary: "The deterministic result does not establish future performance.",
        observedPrimaryMetric: "12.5",
      },
    },
    result: {
      engineOutputHashSha256: "c".repeat(64),
      quoteCurrency: "USD",
      full: {
        startingEquityQuote: "1000",
        endingEquityQuote: "1020.25",
        totalReturnBps: "202.5",
        benchmarkReturnBps: "180",
        excessReturnBps: "22.5",
        maxDrawdownBps: "150.25",
        totalCostsQuote: "2.50",
        turnoverQuote: "100.00",
        tradeCount: 4,
        rejectedFillCount: 0,
      },
      outOfSample: {
        startingEquityQuote: "1010",
        endingEquityQuote: "1015.05",
        totalReturnBps: "50",
        benchmarkReturnBps: "37.5",
        excessReturnBps: "12.5",
        maxDrawdownBps: "75",
        totalCostsQuote: "1.25",
        turnoverQuote: "50",
        tradeCount: 2,
        rejectedFillCount: 0,
      },
    },
  };
  return { ...base, ...overrides };
}
