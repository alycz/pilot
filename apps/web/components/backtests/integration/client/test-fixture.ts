import type { BacktestRunBundle } from "./contracts";

export function clientBundle(runId = "bt_aaaaaaaaaaaaaaaaaaaaaaaa"): BacktestRunBundle {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  return {
    version: 1,
    viewModel: {
      availability: "validated-historical",
      availabilityLabel: "Validated historical · complete",
      availabilityTitle: "Deterministic result",
      availabilityDetail: "Market-level data only.",
      provider: {
        name: "Kraken",
        pair: "XRP / USD",
        capability: "Public daily OHLC; not executable liquidity",
        cost: "Free public endpoint",
        requestedWindow: "2025-01-01 → 2026-09-30",
        actualCoverage: "638 / 638",
        incompleteCandlePolicy: "Discarded",
      },
      setup: [],
      splitDisclosure: "Close t signals fill at open t+1 after an embargo.",
      metrics: [],
      equity: [{
        date: "2026-09-30",
        strategyEquity: 1010.25,
        strategyEquityDisplay: "1010.250000000001 USD",
        benchmarkEquity: 1005,
        benchmarkEquityDisplay: "1005 USD",
        drawdownBps: 20,
        drawdownDisplay: "−0.20%",
      }],
      trades: [],
      reproducibility: {
        runId,
        strategyVersion: "allocation-band.v1",
        parameterFingerprint: hashA,
        rawHash: hashB,
        normalizedHash: hashA,
        coverage: "638 / 638",
        missingData: "0 missing",
      },
      experiment: { hypothesis: "Bounded rebalance", experiment: "Frozen OOS", outcome: "Inconclusive" },
      savedRuns: [],
    },
    savedRun: {
      scope: "local_research_only",
      label: `Run ${runId.slice(-4)}`,
      savedAt: "2026-10-24T12:00:00.000Z",
      report: {
        schemaVersion: "pilot.backtest-report.v1",
        runId,
        engineVersion: "pilot.daily-bar-backtest.v1",
        dataset: { normalizedHashSha256: hashA },
        strategy: {
          strategyVersion: "allocation-band.v1",
          parameterFingerprintSha256: hashA,
        },
        split: {
          trainingEndDate: "2025-12-30",
          outOfSampleStartDate: "2026-01-01",
          embargoBars: 1,
        },
        result: {
          quoteCurrency: "USD",
          resultFingerprintSha256: hashB,
          outOfSample: {
            totalReturnBps: "100",
            benchmarkReturnBps: "50",
            maxDrawdownBps: "20",
            endingEquityQuote: "1010.250000000001",
            totalCostsQuote: "2.5",
            tradeCount: 2,
          },
        },
        capabilityLabel: "public daily OHLC",
      },
    },
    chatEvidence: {
      runId,
      resultFingerprint: hashB,
      datasetNormalizedHash: hashA,
      strategyVersion: "allocation-band.v1",
      datasetLabel: "Kraken XRP/USD daily bars",
      sourceKind: "validated_historical",
      sourceDisclosure: "Market-level bars; not XRPL DEX liquidity.",
      period: { startDate: "2025-01-01", endDate: "2026-09-30" },
      quoteSymbol: "USD",
      metrics: {
        strategyReturnBps: "100",
        benchmarkReturnBps: "50",
        maxDrawdownBps: "20",
        endingEquityQuote: "1010.250000000001",
        totalCostsQuote: "2.5",
        tradeCount: 2,
      },
    },
  };
}
