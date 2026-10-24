import type { SavedBacktestChatEvidence } from "../../chat/evidence-reference";
import { trustedDailyBarSource, KRAKEN_XRP_USD_DAILY_SOURCE_ID, type KrakenDailyBarArtifact } from "../../data";
import type { BacktestOrder, DailyBarBacktestReport } from "../../engine";
import type { SavedRunRecord } from "../../runs";
import type { BacktestMetric, BacktestsViewModel, BacktestTradeRow, EquityDatum } from "../../ui/view-model";

import type { ParsedBacktestRunRequest } from "./input";
import type { BacktestRunResponse } from "./public-types";

function percent(value: number): string {
  const prefix = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${prefix}${Math.abs(value / 100).toFixed(2)}%`;
}

function numericDecimal(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} cannot be presented safely`);
  return parsed;
}

function metricCards(report: DailyBarBacktestReport): readonly BacktestMetric[] {
  const metrics = report.metrics.outOfSample;
  return [
    { label: "OOS strategy return", value: percent(metrics.strategyReturnBps), detail: "Continuous portfolio after embargo", tone: metrics.strategyReturnBps >= 0 ? "positive" : "warning" },
    { label: "OOS hold benchmark", value: percent(metrics.benchmarkReturnBps), detail: "Same starting holdings and mark series" },
    { label: "OOS excess return", value: percent(metrics.excessReturnBps), detail: "Strategy minus static hold", tone: metrics.excessReturnBps >= 0 ? "positive" : "warning" },
    { label: "OOS maximum drawdown", value: percent(-metrics.maxDrawdownBps), detail: "Post-cost marked equity", tone: "warning" },
    { label: "OOS modeled costs", value: `${metrics.totalCostsQuote} USD`, detail: "Cash-equivalent spread + venue + slippage + network" },
    { label: "OOS rejected fills", value: String(metrics.rejectedOrderCount), detail: "Missing bars, embargo, balance, or rounding" },
  ];
}

function equityRows(report: DailyBarBacktestReport): readonly EquityDatum[] {
  return report.portfolio.map((point) => ({
    date: point.observedAt.slice(0, 10),
    strategyEquity: numericDecimal(point.strategyEquityQuote, "strategy equity"),
    strategyEquityDisplay: `${point.strategyEquityQuote} USD`,
    benchmarkEquity: numericDecimal(point.benchmarkEquityQuote, "benchmark equity"),
    benchmarkEquityDisplay: `${point.benchmarkEquityQuote} USD`,
    drawdownBps: point.drawdownBps,
    drawdownDisplay: `−${(point.drawdownBps / 100).toFixed(2)}%`,
  }));
}

function cashAt(report: DailyBarBacktestReport, instant: string): string {
  const exact = report.portfolio.find((point) => point.observedAt === instant);
  return exact ? `${exact.quote} USD` : "Unchanged · no matching bar";
}

function orderCosts(order: BacktestOrder): string {
  return order.status === "filled" ? `${order.costs!.totalCostQuote} USD` : "0 USD";
}

function tradeRows(report: DailyBarBacktestReport): readonly BacktestTradeRow[] {
  return report.orders.map((order) => ({
    signalAt: `${order.signalAt.slice(0, 10)} close`,
    fillAt: order.status === "filled"
      ? `${order.fillAt!.slice(0, 10)} open`
      : `${order.scheduledFillAt.slice(0, 10)} · not filled`,
    side: order.status === "filled" ? (order.side === "buy_base" ? "Buy base" : "Sell base") : "Rejected",
    grossNotional: order.status === "filled" ? `${order.grossNotionalQuote} USD` : "—",
    costs: orderCosts(order),
    endingCash: cashAt(report, order.fillAt ?? order.signalAt),
    status: order.status === "filled" ? "Modeled next-open fill" : order.rejectionCode!.replaceAll("_", " ").toLowerCase(),
  }));
}

function toViewModel(
  input: ParsedBacktestRunRequest,
  artifact: KrakenDailyBarArtifact,
  engine: DailyBarBacktestReport,
  savedRun: SavedRunRecord,
): BacktestsViewModel {
  const dataset = artifact.dataset;
  const source = trustedDailyBarSource(KRAKEN_XRP_USD_DAILY_SOURCE_ID);
  const report = savedRun.report;
  const complete = dataset.coverage.status === "complete";
  return {
    availability: "validated-historical",
    availabilityLabel: complete ? "Validated historical market data" : "Validated source · partial coverage",
    availabilityTitle: complete ? "Kraken XRP/USD daily bars passed every gate" : "Run completed with explicitly missing daily buckets",
    availabilityDetail: `${dataset.coverage.observedBuckets}/${dataset.coverage.expectedBuckets} requested UTC buckets were observed. These are market-level spot bars, not historical XRPL DEX quotes, liquidity, or fills.`,
    provider: {
      name: source.providerDisplayName,
      pair: `${dataset.baseSymbol} / ${dataset.quoteSymbol}`,
      capability: "Public market-level daily OHLC · read-only · no executable liquidity",
      cost: "Free public endpoint · no account or API key",
      requestedWindow: `${input.startDay} → ${input.endDay}`,
      actualCoverage: `${dataset.coverage.observedBuckets}/${dataset.coverage.expectedBuckets} buckets · ${dataset.coverage.status}`,
      incompleteCandlePolicy: "Provider's final current candle discarded",
    },
    setup: [
      { id: "dataset", label: "Dataset", value: "Kraken XRP/USD daily OHLC", help: "Source identity, raw response, normalization, chronology, and coverage were validated server-side." },
      { id: "date-window", label: "Date window", value: `${input.startDay} → ${input.endDay}`, help: "UTC daily buckets; gaps remain missing and are never interpolated." },
      { id: "strategy", label: "Strategy", value: "Long-only allocation band v1", help: "No leverage, shorts, optimizer, generated code, or executable-liquidity claim." },
      { id: "starting-portfolio", label: "Starting portfolio", value: `${input.initialBase} XRP + ${input.initialQuote} USD`, help: "Research inputs only; no wallet address or balance was read." },
      { id: "target-band", label: "Target / band", value: `${(input.targetBaseBps / 100).toFixed(2)}% base / ±${(input.bandBps / 100).toFixed(2)}%`, help: "Parameters were fingerprinted and frozen before out-of-sample evaluation." },
      { id: "costs", label: "Costs", value: `${input.spreadBps} bps spread + ${input.venueFeeBps} bps fee + ${input.slippageBps} bps slippage + ${input.networkCostQuote} USD/fill`, help: "Cash-equivalent deductions, not adjusted fill prices or observed historical venue costs." },
    ],
    splitDisclosure: `Signals use day t close and can fill only at the unadjusted day t+1 open. ${input.embargoBars} full bar${input.embargoBars === 1 ? "" : "s"} separate in-sample setup from OOS; OOS metrics use the continuous simulated portfolio and a new boundary baseline.`,
    metrics: metricCards(engine),
    equity: equityRows(engine),
    trades: tradeRows(engine),
    reproducibility: {
      runId: report.runId,
      strategyVersion: report.strategy.strategyVersion,
      parameterFingerprint: report.strategy.parameterFingerprintSha256,
      rawHash: report.dataset.rawHashSha256,
      normalizedHash: report.dataset.normalizedHashSha256,
      coverage: report.dataset.coverageLabel,
      missingData: dataset.coverage.missingDays.length === 0 ? "No missing UTC daily buckets" : `${dataset.coverage.missingDays.length} missing: ${dataset.coverage.missingDays.join(", ")}`,
    },
    experiment: {
      hypothesis: report.study.hypothesis.statement,
      experiment: report.study.experiment.setupSummary,
      outcome: report.study.outcome.summary,
    },
    savedRuns: [{
      label: savedRun.label,
      runId: report.runId,
      datasetFingerprint: report.dataset.normalizedHashSha256,
      strategyReturn: percent(engine.metrics.outOfSample.strategyReturnBps),
      benchmarkReturn: percent(engine.metrics.outOfSample.benchmarkReturnBps),
      maxDrawdown: percent(-engine.metrics.outOfSample.maxDrawdownBps),
      totalCosts: `${engine.metrics.outOfSample.totalCostsQuote} USD`,
      compatible: true,
    }],
  };
}

export function createRunPresentation(
  input: ParsedBacktestRunRequest,
  artifact: KrakenDailyBarArtifact,
  engine: DailyBarBacktestReport,
  savedRun: SavedRunRecord,
): BacktestRunResponse {
  const report = savedRun.report;
  const chatEvidence: SavedBacktestChatEvidence = {
    runId: report.runId,
    resultFingerprint: report.result.resultFingerprintSha256,
    datasetNormalizedHash: report.dataset.normalizedHashSha256,
    strategyVersion: report.strategy.strategyVersion,
    datasetLabel: "Kraken XRP/USD daily OHLC",
    sourceKind: "validated_historical",
    sourceDisclosure: "Public market-level daily bars; not historical XRPL DEX prices, liquidity, or fills.",
    period: { startDate: input.startDay, endDate: input.endDay },
    quoteSymbol: "USD",
    metrics: {
      strategyReturnBps: report.result.outOfSample.totalReturnBps,
      benchmarkReturnBps: report.result.outOfSample.benchmarkReturnBps,
      maxDrawdownBps: report.result.outOfSample.maxDrawdownBps,
      endingEquityQuote: report.result.outOfSample.endingEquityQuote,
      totalCostsQuote: report.result.outOfSample.totalCostsQuote,
      tradeCount: report.result.outOfSample.tradeCount,
    },
  };
  return { version: 1, viewModel: toViewModel(input, artifact, engine, savedRun), savedRun, chatEvidence };
}
