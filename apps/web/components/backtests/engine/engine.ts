import { createHash } from "node:crypto";

import {
  bpsCeil,
  bpsFloor,
  divideFloor,
  formatFixed,
  minFixed,
  multiplyFloor,
  parseFixed,
  ratioBps,
  type Fixed,
} from "./fixed-point";
import {
  ALLOCATION_BAND_STRATEGY_VERSION,
  DAILY_BAR_BACKTEST_REPORT_VERSION,
  type BacktestOrder,
  type DailyBar,
  type DailyBarBacktestConfig,
  type DailyBarBacktestReport,
  type DailyBarDataset,
  type EvaluationPhase,
  type PortfolioPoint,
  type RejectionCode,
  type TradeSide,
  type WindowMetrics,
} from "./types";

const DAY_MS = 86_400_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;

type ParsedBar = Readonly<{
  source: DailyBar;
  time: number;
  open: Fixed;
  high: Fixed;
  low: Fixed;
  close: Fixed;
}>;

type ParsedConfig = Readonly<{
  source: DailyBarBacktestConfig;
  initialBase: Fixed;
  initialQuote: Fixed;
  maxTradeQuote: Fixed;
  networkCostQuote: Fixed;
  outOfSampleIndex: number;
  embargoStartIndex: number;
}>;

type PendingSignal = Readonly<{
  signalAt: string;
  scheduledFillAt: string;
  signalPhase: EvaluationPhase;
  side: TradeSide;
  requestedGross: Fixed;
}>;

type CostBreakdown = Readonly<{
  spread: Fixed;
  venue: Fixed;
  slippage: Fixed;
  network: Fixed;
  total: Fixed;
}>;

function canonicalJson(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function canonicalInstant(input: string, label: string): number {
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input) {
    throw new TypeError(`${label} must be a canonical ISO-8601 UTC instant`);
  }
  return milliseconds;
}

function validateBps(value: number, label: string, maximum = 5_000): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} must be a whole number from 0 to ${maximum} bps`);
  }
}

function parseDataset(dataset: DailyBarDataset): { bars: ParsedBar[]; missingBuckets: number } {
  if (!ID_PATTERN.test(dataset.datasetId)) throw new TypeError("dataset id is invalid");
  if (!HASH_PATTERN.test(dataset.normalizedHash)) throw new TypeError("dataset hash must be a lowercase SHA-256 digest");
  if (!dataset.baseSymbol.trim() || !dataset.quoteSymbol.trim() || dataset.baseSymbol === dataset.quoteSymbol) {
    throw new TypeError("dataset base and quote symbols must be distinct");
  }
  if (dataset.intervalSeconds !== 86_400) throw new TypeError("daily-bar engine requires an 86,400-second interval");
  if (dataset.bars.length < 6 || dataset.bars.length > 10_000) {
    throw new TypeError("daily-bar dataset must contain between 6 and 10,000 complete bars");
  }

  const ids = new Set<string>();
  const times = new Set<number>();
  let missingBuckets = 0;
  const bars = dataset.bars.map((bar, index): ParsedBar => {
    if (!ID_PATTERN.test(bar.id) || ids.has(bar.id)) throw new TypeError(`bar ${index} has an invalid or duplicate id`);
    ids.add(bar.id);
    if (bar.complete !== true) throw new TypeError(`bar ${bar.id} is incomplete`);
    const time = canonicalInstant(bar.startAt, `bar ${bar.id} start`);
    if (time % DAY_MS !== 0) throw new TypeError(`bar ${bar.id} is not aligned to a UTC daily bucket`);
    if (times.has(time)) throw new TypeError(`bar ${bar.id} duplicates a daily bucket`);
    times.add(time);

    const open = parseFixed(bar.open, `${bar.id} open`);
    const high = parseFixed(bar.high, `${bar.id} high`);
    const low = parseFixed(bar.low, `${bar.id} low`);
    const close = parseFixed(bar.close, `${bar.id} close`);
    if (open <= 0n || high <= 0n || low <= 0n || close <= 0n) throw new TypeError(`bar ${bar.id} prices must be positive`);
    if (high < open || high < close || high < low || low > open || low > close) {
      throw new TypeError(`bar ${bar.id} violates OHLC bounds`);
    }
    if (bar.volumeBase !== undefined) parseFixed(bar.volumeBase, `${bar.id} volume`);

    if (index > 0) {
      const previous = dataset.bars[index - 1]!;
      const previousTime = Date.parse(previous.startAt);
      const elapsed = time - previousTime;
      if (elapsed <= 0 || elapsed % DAY_MS !== 0) {
        throw new TypeError("daily bars must increase in exact whole-day buckets");
      }
      missingBuckets += elapsed / DAY_MS - 1;
    }
    return { source: bar, time, open, high, low, close };
  });
  return { bars, missingBuckets };
}

function parseConfig(config: DailyBarBacktestConfig, bars: readonly ParsedBar[]): ParsedConfig {
  const initialBase = parseFixed(config.initialBase, "initial base");
  const initialQuote = parseFixed(config.initialQuote, "initial quote");
  if (initialBase === 0n && initialQuote === 0n) throw new TypeError("starting portfolio must contain value");
  const maxTradeQuote = parseFixed(config.maxTradeQuote, "maximum trade quote");
  if (maxTradeQuote <= 0n) throw new TypeError("maximum trade quote must be positive");
  const networkCostQuote = parseFixed(config.networkCostQuote, "network cost quote");

  validateBps(config.targetBaseBps, "target allocation", 10_000);
  if (config.targetBaseBps <= 0 || config.targetBaseBps >= 10_000) {
    throw new TypeError("target allocation must be strictly between 0 and 10,000 bps");
  }
  validateBps(config.bandBps, "allocation band", 4_999);
  if (config.targetBaseBps - config.bandBps < 0 || config.targetBaseBps + config.bandBps > 10_000) {
    throw new TypeError("allocation band must remain inside portfolio bounds");
  }
  validateBps(config.spreadBps, "spread");
  validateBps(config.venueFeeBps, "venue fee");
  validateBps(config.slippageBps, "slippage");
  if (config.spreadBps + config.venueFeeBps + config.slippageBps >= 10_000) {
    throw new TypeError("combined proportional costs must remain below 10,000 bps");
  }
  if (!Number.isInteger(config.embargoBars) || config.embargoBars < 1 || config.embargoBars > 30) {
    throw new TypeError("OOS embargo must contain between 1 and 30 daily bars");
  }

  canonicalInstant(config.outOfSampleStartAt, "out-of-sample start");
  const outOfSampleIndex = bars.findIndex(({ source }) => source.startAt === config.outOfSampleStartAt);
  if (outOfSampleIndex < 0) throw new TypeError("out-of-sample start must identify a complete daily bar");
  const embargoStartIndex = outOfSampleIndex - config.embargoBars;
  if (embargoStartIndex < 2) throw new TypeError("in-sample window requires at least two bars before the embargo");
  if (bars.length - outOfSampleIndex < 2) throw new TypeError("out-of-sample window requires at least two bars");

  return {
    source: {
      ...config,
      initialBase: formatFixed(initialBase),
      initialQuote: formatFixed(initialQuote),
      maxTradeQuote: formatFixed(maxTradeQuote),
      networkCostQuote: formatFixed(networkCostQuote),
    },
    initialBase,
    initialQuote,
    maxTradeQuote,
    networkCostQuote,
    outOfSampleIndex,
    embargoStartIndex,
  };
}

function phaseFor(index: number, config: ParsedConfig): EvaluationPhase {
  if (index < config.embargoStartIndex) return "in_sample";
  if (index < config.outOfSampleIndex) return "embargo";
  return "out_of_sample";
}

function parameterFingerprint(config: ParsedConfig): string {
  return createHash("sha256").update(canonicalJson({
    strategyVersion: ALLOCATION_BAND_STRATEGY_VERSION,
    ...config.source,
  }), "utf8").digest("hex");
}

function costsFor(gross: Fixed, config: ParsedConfig): CostBreakdown {
  const spread = bpsCeil(gross, config.source.spreadBps);
  const venue = bpsCeil(gross, config.source.venueFeeBps);
  const slippage = bpsCeil(gross, config.source.slippageBps);
  const network = config.networkCostQuote;
  return { spread, venue, slippage, network, total: spread + venue + slippage + network };
}

function rejected(signal: PendingSignal, rejectionCode: RejectionCode): BacktestOrder {
  return {
    signalAt: signal.signalAt,
    scheduledFillAt: signal.scheduledFillAt,
    signalPhase: signal.signalPhase,
    side: signal.side,
    requestedGrossQuote: formatFixed(signal.requestedGross),
    status: "rejected",
    rejectionCode,
  };
}

function fillSignal(
  signal: PendingSignal,
  bar: ParsedBar,
  fillPhase: EvaluationPhase,
  config: ParsedConfig,
  balances: { base: Fixed; quote: Fixed },
): BacktestOrder {
  let candidate = minFixed(signal.requestedGross, config.maxTradeQuote);
  if (signal.side === "buy_base") {
    if (balances.quote <= config.networkCostQuote) return rejected(signal, "INSUFFICIENT_CASH");
    const proportionalBps = config.source.spreadBps + config.source.venueFeeBps + config.source.slippageBps;
    const affordable = ((balances.quote - config.networkCostQuote) * 10_000n) / BigInt(10_000 + proportionalBps);
    candidate = minFixed(candidate, affordable);
    if (candidate <= 0n) return rejected(signal, "INSUFFICIENT_CASH");
  } else {
    const availableGross = multiplyFloor(balances.base, bar.open);
    if (availableGross <= 0n) return rejected(signal, "INSUFFICIENT_BASE");
    candidate = minFixed(candidate, availableGross);
  }

  let filledBase = 0n;
  let gross = 0n;
  let costs: CostBreakdown = costsFor(0n, config);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    filledBase = divideFloor(candidate, bar.open);
    gross = multiplyFloor(filledBase, bar.open);
    if (filledBase <= 0n || gross <= 0n) return rejected(signal, "ROUNDING_TO_ZERO");
    costs = costsFor(gross, config);
    if (signal.side !== "buy_base" || gross + costs.total <= balances.quote) break;
    const deficit = gross + costs.total - balances.quote;
    if (candidate <= deficit) return rejected(signal, "INSUFFICIENT_CASH");
    candidate -= deficit;
  }

  if (signal.side === "buy_base") {
    if (gross + costs.total > balances.quote) return rejected(signal, "INSUFFICIENT_CASH");
    balances.base += filledBase;
    balances.quote -= gross + costs.total;
  } else {
    if (filledBase > balances.base) return rejected(signal, "INSUFFICIENT_BASE");
    if (costs.total >= gross) return rejected(signal, "COST_EXCEEDS_PROCEEDS");
    balances.base -= filledBase;
    balances.quote += gross - costs.total;
  }

  return {
    signalAt: signal.signalAt,
    scheduledFillAt: signal.scheduledFillAt,
    signalPhase: signal.signalPhase,
    side: signal.side,
    requestedGrossQuote: formatFixed(signal.requestedGross),
    status: "filled",
    fillAt: bar.source.startAt,
    fillPhase,
    unadjustedReferenceOpen: formatFixed(bar.open),
    grossNotionalQuote: formatFixed(gross),
    filledBase: formatFixed(filledBase),
    netCashFlowQuote: formatFixed(signal.side === "buy_base" ? -(gross + costs.total) : gross - costs.total),
    partial: gross < signal.requestedGross,
    costs: {
      spreadCostQuote: formatFixed(costs.spread),
      venueFeeCostQuote: formatFixed(costs.venue),
      slippageCostQuote: formatFixed(costs.slippage),
      networkCostQuote: formatFixed(costs.network),
      totalCostQuote: formatFixed(costs.total),
    },
  };
}

function metricsFor(points: readonly PortfolioPoint[], orders: readonly BacktestOrder[]): WindowMetrics {
  if (points.length < 2) throw new TypeError("metric window requires at least two observations");
  const pointTimes = new Set(points.map(({ observedAt }) => observedAt));
  const filled = orders.filter((order) => order.status === "filled" && order.fillAt && pointTimes.has(order.fillAt));
  const rejectedOrders = orders.filter((order) => order.status === "rejected" && pointTimes.has(order.signalAt));
  const firstStrategy = parseFixed(points[0]!.strategyEquityQuote);
  const lastStrategy = parseFixed(points.at(-1)!.strategyEquityQuote);
  const firstBenchmark = parseFixed(points[0]!.benchmarkEquityQuote);
  const lastBenchmark = parseFixed(points.at(-1)!.benchmarkEquityQuote);
  let peak = firstStrategy;
  let maximumDrawdown = 0;
  for (const point of points) {
    const equity = parseFixed(point.strategyEquityQuote);
    if (equity > peak) peak = equity;
    if (peak > 0n) maximumDrawdown = Math.max(maximumDrawdown, ratioBps(peak - equity, peak));
  }
  const strategyReturnBps = ratioBps(lastStrategy - firstStrategy, firstStrategy);
  const benchmarkReturnBps = ratioBps(lastBenchmark - firstBenchmark, firstBenchmark);
  const turnover = filled.reduce((sum, order) => sum + parseFixed(order.grossNotionalQuote!), 0n);
  const totalCosts = filled.reduce((sum, order) => sum + parseFixed(order.costs!.totalCostQuote), 0n);
  return {
    startAt: points[0]!.observedAt,
    endAt: points.at(-1)!.observedAt,
    observations: points.length,
    strategyReturnBps,
    benchmarkReturnBps,
    excessReturnBps: Number((strategyReturnBps - benchmarkReturnBps).toFixed(2)),
    maxDrawdownBps: Number(maximumDrawdown.toFixed(2)),
    filledTradeCount: filled.length,
    rejectedOrderCount: rejectedOrders.length,
    turnoverQuote: formatFixed(turnover),
    totalCostsQuote: formatFixed(totalCosts),
  };
}

/**
 * Pure deterministic daily-bar research simulation. It never reads a wallet,
 * clock, network, permission, model, or transaction builder. Daily-bar volume
 * is intentionally ignored because market-level volume is not executable
 * venue liquidity.
 */
export function runDailyBarBacktest(
  dataset: DailyBarDataset,
  configInput: DailyBarBacktestConfig,
): DailyBarBacktestReport {
  const { bars, missingBuckets } = parseDataset(dataset);
  const config = parseConfig(configInput, bars);
  const balances = { base: config.initialBase, quote: config.initialQuote };
  const benchmark = { base: config.initialBase, quote: config.initialQuote };
  const orders: BacktestOrder[] = [];
  const portfolio: PortfolioPoint[] = [];
  let pending: PendingSignal | undefined;
  let peakEquity = 0n;

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const phase = phaseFor(index, config);

    if (pending) {
      if (bar.source.startAt !== pending.scheduledFillAt) {
        orders.push(rejected(pending, "MISSING_NEXT_BAR"));
      } else if (phase === "embargo") {
        orders.push(rejected(pending, "EMBARGO"));
      } else {
        orders.push(fillSignal(pending, bar, phase, config, balances));
      }
      pending = undefined;
    }

    const baseValue = multiplyFloor(balances.base, bar.close);
    const strategyEquity = baseValue + balances.quote;
    const benchmarkEquity = multiplyFloor(benchmark.base, bar.close) + benchmark.quote;
    if (strategyEquity > peakEquity) peakEquity = strategyEquity;
    const pointDrawdown = peakEquity > 0n ? ratioBps(peakEquity - strategyEquity, peakEquity) : 0;
    portfolio.push({
      barId: bar.source.id,
      observedAt: bar.source.startAt,
      phase,
      close: formatFixed(bar.close),
      base: formatFixed(balances.base),
      quote: formatFixed(balances.quote),
      strategyEquityQuote: formatFixed(strategyEquity),
      benchmarkEquityQuote: formatFixed(benchmarkEquity),
      drawdownBps: pointDrawdown,
    });

    if (phase === "embargo" || strategyEquity <= 0n) continue;
    const allocationBps = Number((baseValue * 10_000n) / strategyEquity);
    const lower = config.source.targetBaseBps - config.source.bandBps;
    const upper = config.source.targetBaseBps + config.source.bandBps;
    if (allocationBps >= lower && allocationBps <= upper) continue;

    const targetBaseValue = bpsFloor(strategyEquity, config.source.targetBaseBps);
    const side: TradeSide = baseValue < targetBaseValue ? "buy_base" : "sell_base";
    const requestedGross = baseValue < targetBaseValue ? targetBaseValue - baseValue : baseValue - targetBaseValue;
    const scheduledFillAt = new Date(bar.time + DAY_MS).toISOString();
    const signal: PendingSignal = {
      signalAt: bar.source.startAt,
      scheduledFillAt,
      signalPhase: phase,
      side,
      requestedGross,
    };
    if (requestedGross <= 0n) {
      orders.push(rejected(signal, "ROUNDING_TO_ZERO"));
    } else if (index === bars.length - 1) {
      orders.push(rejected(signal, "NO_NEXT_BAR"));
    } else {
      pending = signal;
    }
  }

  const inSample = portfolio.filter(({ phase }) => phase === "in_sample");
  const outOfSample = portfolio.filter(({ phase }) => phase === "out_of_sample");
  return {
    reportVersion: DAILY_BAR_BACKTEST_REPORT_VERSION,
    strategyVersion: ALLOCATION_BAND_STRATEGY_VERSION,
    datasetId: dataset.datasetId,
    datasetHash: dataset.normalizedHash,
    parameterFingerprint: parameterFingerprint(config),
    assumptions: config.source,
    executionDisclosure: "Base quantity is calculated at the unadjusted next-bucket open. Spread and slippage assumptions are separate cash-equivalent quote deductions, not worse-price or market-impact modeling. Liquidity is not modeled; results are simulations, not historical XRPL DEX fills or execution evidence.",
    fillPriceModel: "next-open-unadjusted",
    proportionalCostModel: "cash-equivalent-quote-deduction",
    liquidityModel: "not-modeled",
    missingBuckets,
    split: {
      outOfSampleStartAt: config.source.outOfSampleStartAt,
      embargoBars: config.source.embargoBars,
      inSampleEndAt: bars[config.embargoStartIndex - 1]!.source.startAt,
      embargoStartAt: bars[config.embargoStartIndex]!.source.startAt,
    },
    metrics: {
      full: metricsFor(portfolio, orders),
      inSample: metricsFor(inSample, orders),
      outOfSample: metricsFor(outOfSample, orders),
    },
    orders,
    portfolio,
  };
}
