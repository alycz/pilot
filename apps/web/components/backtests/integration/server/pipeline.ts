import { z } from "zod";

import {
  enumerateUtcDays,
  fetchKrakenXrpUsdDailyBars,
  isTrustedKrakenDailyBarArtifact,
  trustedDailyBarSource,
  KRAKEN_XRP_USD_DAILY_SOURCE_ID,
  type KrakenDailyBarArtifact,
  type KrakenDailyBarFetchOptions,
  type PrivateDailyBarCache,
} from "../../data";
import {
  runDailyBarBacktest,
  type DailyBarBacktestReport,
  type DailyBarDataset as EngineDailyBarDataset,
  type PortfolioPoint,
  type WindowMetrics,
} from "../../engine";
import {
  createReproducibilityReport,
  sha256Fingerprint,
  type BacktestMetricSet,
  type SavedRunRecord,
} from "../../runs";

import { BacktestRunRequestSchema, type ParsedBacktestRunRequest } from "./input";
import { createRunPresentation } from "./presentation";
import type { BacktestRunResponse } from "./public-types";

export type BacktestPipelineDependencies = Readonly<{
  now?: Date;
  fetcher?: typeof fetch;
  cache?: PrivateDailyBarCache;
  fetchDailyBars?: (options: KrakenDailyBarFetchOptions) => Promise<KrakenDailyBarArtifact>;
}>;

export class BacktestPipelineError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "PROVIDER_UNAVAILABLE" | "SIMULATION_REJECTED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BacktestPipelineError";
  }
}

const utcInstant = (day: string) => `${day}T00:00:00.000Z`;

function mapTrustedDataset(artifact: KrakenDailyBarArtifact): EngineDailyBarDataset {
  if (!isTrustedKrakenDailyBarArtifact(artifact)) {
    throw new BacktestPipelineError("PROVIDER_UNAVAILABLE", "daily-bar provider evidence is not trusted");
  }
  const dataset = artifact.dataset;
  return {
    datasetId: dataset.datasetId,
    normalizedHash: dataset.provenance.normalizedSha256,
    baseSymbol: dataset.baseSymbol,
    quoteSymbol: dataset.quoteSymbol,
    intervalSeconds: dataset.intervalSeconds,
    bars: dataset.bars.map((bar) => ({
      id: `bar-${bar.day}`,
      startAt: utcInstant(bar.day),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volumeBase: bar.volumeBase,
      complete: true,
    })),
  };
}

function decimalMetric(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("metric must be finite");
  const normalized = value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  return normalized === "-0" ? "0" : normalized;
}

function windowPoints(report: DailyBarBacktestReport, phase?: PortfolioPoint["phase"]): readonly PortfolioPoint[] {
  return phase ? report.portfolio.filter((point) => point.phase === phase) : report.portfolio;
}

function exactMetricSet(metrics: WindowMetrics, points: readonly PortfolioPoint[]): BacktestMetricSet {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) throw new TypeError("metric window is unavailable");
  return {
    startingEquityQuote: first.strategyEquityQuote,
    endingEquityQuote: last.strategyEquityQuote,
    totalReturnBps: decimalMetric(metrics.strategyReturnBps),
    benchmarkReturnBps: decimalMetric(metrics.benchmarkReturnBps),
    excessReturnBps: decimalMetric(metrics.excessReturnBps),
    maxDrawdownBps: decimalMetric(metrics.maxDrawdownBps),
    totalCostsQuote: metrics.totalCostsQuote,
    turnoverQuote: metrics.turnoverQuote,
    tradeCount: metrics.filledTradeCount,
    rejectedFillCount: metrics.rejectedOrderCount,
  };
}

function buildSavedRun(
  input: ParsedBacktestRunRequest,
  artifact: KrakenDailyBarArtifact,
  engine: DailyBarBacktestReport,
  now: Date,
): SavedRunRecord {
  const dataset = artifact.dataset;
  const source = trustedDailyBarSource(KRAKEN_XRP_USD_DAILY_SOURCE_ID);
  const excess = engine.metrics.outOfSample.excessReturnBps;
  const report = createReproducibilityReport({
    engineVersion: engine.reportVersion,
    dataset: {
      datasetId: dataset.datasetId,
      rawHashSha256: dataset.provenance.rawBundleSha256,
      normalizedHashSha256: dataset.provenance.normalizedSha256,
      sourceRegistryId: dataset.sourceRegistryId,
      sourceLabel: "Kraken public XRP/USD daily OHLC",
      pairLabel: "XRP/USD",
      capabilityLabel: "Market-level spot OHLC only; no historical XRPL DEX execution or liquidity evidence.",
      costLabel: source.accessCost === "free-public-endpoint" ? "Free public endpoint; no account or API key." : source.accessCost,
      coverageLabel: `${dataset.coverage.observedBuckets}/${dataset.coverage.expectedBuckets} UTC daily buckets (${dataset.coverage.status}).`,
      redistributionLabel: "Raw data kept in a private local cache; redistribution rights require review.",
      coverage: {
        startDate: input.startDay,
        endDate: input.endDay,
        expectedBuckets: dataset.coverage.expectedBuckets,
        observedBuckets: dataset.coverage.observedBuckets,
        missingBuckets: dataset.coverage.missingDays.length,
        discardedIncompleteBuckets: 1,
      },
    },
    strategy: {
      strategyId: "allocation-band",
      strategyVersion: engine.strategyVersion,
      parameters: { strategyVersion: engine.strategyVersion, ...engine.assumptions },
    },
    split: {
      trainingEndDate: engine.split.inSampleEndAt.slice(0, 10),
      outOfSampleStartDate: input.outOfSampleStartDay,
      embargoBars: input.embargoBars,
      parametersFrozenBeforeOutOfSample: true,
    },
    costs: {
      quoteCurrency: "USD",
      spreadBps: input.spreadBps,
      venueFeeBps: input.venueFeeBps,
      slippageBps: input.slippageBps,
      networkCostPerFillQuote: input.networkCostQuote,
      liquidityModel: "not_modeled",
    },
    study: {
      hypothesis: { statement: input.hypothesis, declaredBeforeOutOfSample: true },
      experiment: {
        setupSummary: `Frozen long-only allocation-band v1; close signal, next-open fill, ${input.embargoBars}-bar embargo, explicit cash-equivalent costs, and no liquidity model.`,
        primaryMetric: "excess_return_bps",
        outOfSampleHiddenUntilParametersFrozen: true,
      },
      outcome: {
        status: "inconclusive",
        summary: `The deterministic OOS simulation observed ${decimalMetric(excess)} bps excess return. One frozen historical experiment is insufficient to accept or reject the hypothesis and is not evidence of future or executable performance.`,
        observedPrimaryMetric: decimalMetric(excess),
      },
    },
    result: {
      engineOutputHashSha256: sha256Fingerprint(engine),
      quoteCurrency: "USD",
      full: exactMetricSet(engine.metrics.full, windowPoints(engine)),
      outOfSample: exactMetricSet(engine.metrics.outOfSample, windowPoints(engine, "out_of_sample")),
    },
  });
  if (report.strategy.parameterFingerprintSha256 !== engine.parameterFingerprint) {
    throw new TypeError("report and engine parameter fingerprints diverged");
  }
  return {
    scope: "local_research_only",
    label: `XRP/USD ${input.startDay} to ${input.endDay}`,
    savedAt: now.toISOString(),
    report,
  };
}

export async function runTrustedDailyBarBacktest(
  inputValue: unknown,
  dependencies: BacktestPipelineDependencies = {},
): Promise<BacktestRunResponse> {
  const input = BacktestRunRequestSchema.parse(inputValue);
  const now = dependencies.now ?? new Date();
  try {
    enumerateUtcDays(input.startDay, input.endDay);
  } catch (cause) {
    throw new BacktestPipelineError("INVALID_REQUEST", cause instanceof Error ? cause.message : "requested date range is invalid", { cause });
  }
  if (input.endDay >= now.toISOString().slice(0, 10)) {
    throw new BacktestPipelineError("INVALID_REQUEST", "end date must precede the current incomplete UTC candle");
  }

  let artifact: KrakenDailyBarArtifact;
  try {
    artifact = await (dependencies.fetchDailyBars ?? fetchKrakenXrpUsdDailyBars)({
      startDay: input.startDay,
      endDay: input.endDay,
      now,
      fetcher: dependencies.fetcher,
      cache: dependencies.cache,
    });
    if (!isTrustedKrakenDailyBarArtifact(artifact)) throw new TypeError("provider did not return runtime trust evidence");
  } catch (cause) {
    throw new BacktestPipelineError("PROVIDER_UNAVAILABLE", "validated Kraken daily bars are unavailable; no fixture was substituted", { cause });
  }

  try {
    const engine = runDailyBarBacktest(mapTrustedDataset(artifact), {
      initialBase: input.initialBase,
      initialQuote: input.initialQuote,
      targetBaseBps: input.targetBaseBps,
      bandBps: input.bandBps,
      maxTradeQuote: input.maxTradeQuote,
      spreadBps: input.spreadBps,
      venueFeeBps: input.venueFeeBps,
      slippageBps: input.slippageBps,
      networkCostQuote: input.networkCostQuote,
      outOfSampleStartAt: utcInstant(input.outOfSampleStartDay),
      embargoBars: input.embargoBars,
    });
    const savedRun = buildSavedRun(input, artifact, engine, now);
    return createRunPresentation(input, artifact, engine, savedRun);
  } catch (cause) {
    throw new BacktestPipelineError("SIMULATION_REJECTED", "the validated dataset and frozen configuration could not produce a backtest", { cause });
  }
}

export function isBacktestRequestValidationError(error: unknown): error is z.ZodError {
  return error instanceof z.ZodError;
}
