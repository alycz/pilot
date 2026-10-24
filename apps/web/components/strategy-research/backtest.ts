import {
  datasetCoverage,
  parseStrategyDataset,
  type HistoricalDatasetTrust,
  type MarketObservation,
  type StrategyDataset,
} from "./dataset";

export type BacktestConfig = {
  initialBase: number;
  initialQuote: number;
  targetBaseBps: number;
  bandBps: number;
  maxTradeQuote: number;
  venueFeeBps: number;
  assumedSlippageBps: number;
  networkFeeQuote: number;
};

export type BacktestTrade = {
  observationId: string;
  observedAt: string;
  ledgerIndex: number;
  side: "buy_base" | "sell_base";
  requestedGrossQuote: number;
  grossNotionalQuote: number;
  netCashFlowQuote: number;
  filledBase: number;
  modeledCostsQuote: number;
  partial: boolean;
  reason: string;
};

export type EquityPoint = {
  observationId: string;
  observedAt: string;
  ledgerIndex: number;
  strategyEquityBeforeTrade: number;
  strategyEquity: number;
  benchmarkEquity: number;
};

export type BacktestMetrics = {
  startAt: string;
  endAt: string;
  observations: number;
  strategyReturnBps: number;
  benchmarkReturnBps: number;
  excessReturnBps: number;
  maxDrawdownBps: number;
  tradeCount: number;
  partialFillCount: number;
  totalCostsQuote: number;
};

export type BacktestReport = {
  reportVersion: "pilot.strategy-backtest.v2";
  datasetId: string;
  sourceKind: StrategyDataset["source_kind"];
  sourceDisclosure: string;
  historicalCoverageAvailable: boolean;
  assumptions: BacktestConfig;
  coverage: ReturnType<typeof datasetCoverage>;
  split: StrategyDataset["split"];
  metrics: {
    full: BacktestMetrics;
    inSample: BacktestMetrics;
    outOfSample: BacktestMetrics;
  };
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
};

const DEFAULT_CONFIG: BacktestConfig = {
  initialBase: 100,
  initialQuote: 50,
  targetBaseBps: 5_000,
  bandBps: 500,
  maxTradeQuote: 25,
  venueFeeBps: 10,
  assumedSlippageBps: 25,
  networkFeeQuote: 0.01,
};

const round = (value: number, places = 8) => Number(value.toFixed(places));

function validateConfig(input: Partial<BacktestConfig>): BacktestConfig {
  const config = { ...DEFAULT_CONFIG, ...input };
  const finiteNonnegative = [
    config.initialBase,
    config.initialQuote,
    config.bandBps,
    config.venueFeeBps,
    config.assumedSlippageBps,
    config.networkFeeQuote,
  ].every((value) => Number.isFinite(value) && value >= 0);
  if (!finiteNonnegative || config.initialBase + config.initialQuote <= 0) {
    throw new TypeError("backtest balances and costs must be finite and nonnegative");
  }
  if (!Number.isFinite(config.maxTradeQuote) || config.maxTradeQuote <= 0) {
    throw new TypeError("maximum trade value must be positive");
  }
  if (!Number.isInteger(config.targetBaseBps) || config.targetBaseBps <= 0 || config.targetBaseBps >= 10_000) {
    throw new TypeError("target allocation must be between 0 and 10,000 bps");
  }
  if (!Number.isInteger(config.bandBps) || config.bandBps < 0 || config.bandBps >= 5_000) {
    throw new TypeError("allocation band must be a bounded whole number of bps");
  }
  if (config.venueFeeBps + config.assumedSlippageBps > 5_000) {
    throw new TypeError("combined proportional costs are outside the supported range");
  }
  return config;
}

function markPrice(observation: MarketObservation): number {
  if (observation.clob) return (observation.clob.bid + observation.clob.ask) / 2;
  if (observation.amm) return observation.amm.quote_reserve / observation.amm.base_reserve;
  throw new Error("validated observation has no market snapshot");
}

function metricsFor(
  points: EquityPoint[],
  trades: BacktestTrade[],
): BacktestMetrics {
  if (points.length < 2) throw new Error("a metric window requires at least two observations");
  const first = points[0]!;
  const last = points.at(-1)!;
  const startingEquity = first.strategyEquityBeforeTrade;
  let peak = startingEquity;
  let maxDrawdown = 0;
  for (const point of points) {
    peak = Math.max(peak, point.strategyEquityBeforeTrade, point.strategyEquity);
    if (peak > 0) {
      maxDrawdown = Math.max(
        maxDrawdown,
        (peak - point.strategyEquityBeforeTrade) / peak,
        (peak - point.strategyEquity) / peak,
      );
    }
  }
  const windowIds = new Set(points.map(({ observationId }) => observationId));
  const windowTrades = trades.filter(({ observationId }) => windowIds.has(observationId));
  const strategyReturnBps = ((last.strategyEquity / startingEquity) - 1) * 10_000;
  const benchmarkReturnBps = ((last.benchmarkEquity / first.benchmarkEquity) - 1) * 10_000;
  return {
    startAt: first.observedAt,
    endAt: last.observedAt,
    observations: points.length,
    strategyReturnBps: round(strategyReturnBps, 2),
    benchmarkReturnBps: round(benchmarkReturnBps, 2),
    excessReturnBps: round(strategyReturnBps - benchmarkReturnBps, 2),
    maxDrawdownBps: round(maxDrawdown * 10_000, 2),
    tradeCount: windowTrades.length,
    partialFillCount: windowTrades.filter(({ partial }) => partial).length,
    totalCostsQuote: round(windowTrades.reduce((sum, trade) => sum + trade.modeledCostsQuote, 0)),
  };
}

/**
 * Pure reproducible research simulation. It reads no clock, wallet, network, or
 * execution client, and it never emits a transaction or approval request.
 */
export function runBacktest(
  datasetInput: unknown,
  configInput: Partial<BacktestConfig> = {},
  historicalTrust?: HistoricalDatasetTrust,
): BacktestReport {
  const dataset = parseStrategyDataset(datasetInput, historicalTrust);
  const config = validateConfig(configInput);
  let base = config.initialBase;
  let quote = config.initialQuote;
  const benchmarkBase = base;
  const benchmarkQuote = quote;
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  for (const observation of dataset.observations) {
    const mid = markPrice(observation);
    const beforeEquity = base * mid + quote;
    const baseAllocationBps = beforeEquity > 0 ? (base * mid / beforeEquity) * 10_000 : 0;
    const lower = config.targetBaseBps - config.bandBps;
    const upper = config.targetBaseBps + config.bandBps;
    const clob = observation.clob;

    if (clob && (baseAllocationBps < lower || baseAllocationBps > upper)) {
      const targetBaseValue = beforeEquity * (config.targetBaseBps / 10_000);
      const currentBaseValue = base * mid;
      const side = currentBaseValue < targetBaseValue ? "buy_base" : "sell_base";
      const requestedQuote = Math.abs(targetBaseValue - currentBaseValue);
      const price = side === "buy_base" ? clob.ask : clob.bid;
      const liquidityQuote = (side === "buy_base" ? clob.ask_liquidity_base : clob.bid_liquidity_base) * price;
      const proportionalCost = (config.venueFeeBps + config.assumedSlippageBps) / 10_000;
      const balanceCapacity = side === "buy_base"
        ? Math.max(0, (quote - config.networkFeeQuote) / (1 + proportionalCost))
        : base * price;
      const grossNotionalQuote = Math.min(requestedQuote, config.maxTradeQuote, liquidityQuote, balanceCapacity);

      if (grossNotionalQuote > 0) {
        const filledBase = grossNotionalQuote / price;
        const modeledCostsQuote = grossNotionalQuote * proportionalCost + config.networkFeeQuote;
        let netCashFlowQuote: number;
        if (side === "buy_base") {
          netCashFlowQuote = -(grossNotionalQuote + modeledCostsQuote);
          base = round(base + filledBase);
          quote = round(quote + netCashFlowQuote);
        } else {
          netCashFlowQuote = grossNotionalQuote - modeledCostsQuote;
          base = round(base - filledBase);
          quote = round(quote + netCashFlowQuote);
        }
        trades.push({
          observationId: observation.observation_id,
          observedAt: observation.observed_at,
          ledgerIndex: observation.ledger_index,
          side,
          requestedGrossQuote: round(requestedQuote),
          grossNotionalQuote: round(grossNotionalQuote),
          netCashFlowQuote: round(netCashFlowQuote),
          filledBase: round(filledBase),
          modeledCostsQuote: round(modeledCostsQuote),
          partial: grossNotionalQuote + 1e-8 < requestedQuote,
          reason: grossNotionalQuote + 1e-8 < requestedQuote
            ? "Partial research fill: capped by the configured order size, available balance, or observed CLOB liquidity."
            : "Research fill stayed within the configured order, balance, and observed-liquidity assumptions.",
        });
      }
    }

    equityCurve.push({
      observationId: observation.observation_id,
      observedAt: observation.observed_at,
      ledgerIndex: observation.ledger_index,
      strategyEquityBeforeTrade: round(beforeEquity),
      strategyEquity: round(base * mid + quote),
      benchmarkEquity: round(benchmarkBase * mid + benchmarkQuote),
    });
  }

  const trainEnd = Date.parse(dataset.split.train_end_at);
  const outOfSampleStart = Date.parse(dataset.split.out_of_sample_start_at);
  const inSample = equityCurve.filter(({ observedAt }) => Date.parse(observedAt) <= trainEnd);
  const outOfSample = equityCurve.filter(({ observedAt }) => Date.parse(observedAt) >= outOfSampleStart);

  return {
    reportVersion: "pilot.strategy-backtest.v2",
    datasetId: dataset.dataset_id,
    sourceKind: dataset.source_kind,
    sourceDisclosure: dataset.source_kind === "validated_historical"
      ? "Validated historical dataset supplied with explicit provenance and bounded coverage. Results remain simulations, not forecasts."
      : "Deterministic fixture only. Results are reproducible software evidence, not live or historical market analytics.",
    historicalCoverageAvailable: dataset.source_kind === "validated_historical",
    assumptions: config,
    coverage: datasetCoverage(dataset, historicalTrust),
    split: dataset.split,
    metrics: {
      full: metricsFor(equityCurve, trades),
      inSample: metricsFor(inSample, trades),
      outOfSample: metricsFor(outOfSample, trades),
    },
    trades,
    equityCurve,
  };
}
