import type { BacktestsViewModel, SavedRunComparison } from "../../ui/view-model";
import { sha256CanonicalJson } from "../../../../lib/sha256-sync";

import type { BacktestRunRequest } from "./contracts";

const SAMPLE_PRICES = [0.48, 0.52, 0.57, 0.5, 0.44, 0.55, 0.62, 0.58, 0.66, 0.71, 0.64, 0.76] as const;
const SAMPLE_DATASET_HASH = sha256CanonicalJson(SAMPLE_PRICES);

export type DemoBacktestRun = Readonly<{
  runId: string;
  label: string;
  request: BacktestRunRequest;
  model: BacktestsViewModel;
}>;

type MutableTrade = {
  signalAt: string;
  fillAt: string;
  side: "Buy base" | "Sell base";
  grossNotional: string;
  costs: string;
  endingCash: string;
  status: string;
};

function percentFromBps(value: number): string {
  const prefix = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${prefix}${Math.abs(value / 100).toFixed(2)}%`;
}

function sampleDates(startDay: string, endDay: string): readonly string[] {
  const start = Date.parse(`${startDay}T00:00:00.000Z`);
  const end = Date.parse(`${endDay}T00:00:00.000Z`);
  const interval = Math.max(86_400_000, Math.floor((end - start) / (SAMPLE_PRICES.length - 1)));
  return SAMPLE_PRICES.map((_, index) => new Date(Math.min(end, start + interval * index)).toISOString().slice(0, 10));
}

function comparison(run: DemoBacktestRun, currentId: string): SavedRunComparison {
  const metric = (label: string) => run.model.metrics.find((entry) => entry.label === label)?.value ?? "—";
  return {
    label: run.label,
    runId: run.runId,
    datasetFingerprint: SAMPLE_DATASET_HASH,
    strategyReturn: metric("Sample strategy return"),
    benchmarkReturn: metric("Sample hold benchmark"),
    maxDrawdown: metric("Sample maximum drawdown"),
    totalCosts: metric("Sample modeled costs"),
    compatible: run.runId !== currentId,
  };
}

export function withDemoComparisons(current: DemoBacktestRun, runs: readonly DemoBacktestRun[]): BacktestsViewModel {
  return {
    ...current.model,
    savedRuns: runs.map((run) => comparison(run, current.runId)),
  };
}

export function createSignedOutDemoRun(request: BacktestRunRequest, ordinal = 1): DemoBacktestRun {
  const dates = sampleDates(request.startDay, request.endDay);
  let base = Number(request.initialBase);
  let quote = Number(request.initialQuote);
  const startingBase = base;
  const startingQuote = quote;
  const target = request.targetBaseBps / 10_000;
  const band = request.bandBps / 10_000;
  const maxTrade = Number(request.maxTradeQuote);
  const proportionalCosts = (request.spreadBps + request.venueFeeBps + request.slippageBps) / 10_000;
  const fixedCost = Number(request.networkCostQuote);
  const startingEquity = startingBase * SAMPLE_PRICES[0] + startingQuote;
  let peak = startingEquity;
  let totalCosts = 0;
  let maximumDrawdownBps = 0;
  const trades: MutableTrade[] = [];
  const equity = SAMPLE_PRICES.map((price, index) => {
    const date = dates[index]!;
    const markedBefore = base * price + quote;
    const allocation = markedBefore > 0 ? (base * price) / markedBefore : 0;
    if (index > 0 && (allocation < target - band || allocation > target + band)) {
      const desiredBaseValue = markedBefore * target;
      const gross = Math.min(maxTrade, Math.abs(desiredBaseValue - base * price));
      const cost = gross * proportionalCosts + fixedCost;
      if (gross > 0.005 && allocation < target && quote >= gross + cost) {
        base += gross / price;
        quote -= gross + cost;
        totalCosts += cost;
        trades.push({ signalAt: `${dates[index - 1]} close`, fillAt: `${date} open`, side: "Buy base", grossNotional: `${gross.toFixed(2)} USD`, costs: `${cost.toFixed(2)} USD`, endingCash: `${quote.toFixed(2)} USD`, status: "Synthetic next-sample fill" });
      } else if (gross > 0.005 && allocation > target && base >= gross / price && gross > cost) {
        base -= gross / price;
        quote += gross - cost;
        totalCosts += cost;
        trades.push({ signalAt: `${dates[index - 1]} close`, fillAt: `${date} open`, side: "Sell base", grossNotional: `${gross.toFixed(2)} USD`, costs: `${cost.toFixed(2)} USD`, endingCash: `${quote.toFixed(2)} USD`, status: "Synthetic next-sample fill" });
      }
    }
    const strategyEquity = base * price + quote;
    const benchmarkEquity = startingBase * price + startingQuote;
    peak = Math.max(peak, strategyEquity);
    const drawdownBps = peak > 0 ? ((peak - strategyEquity) / peak) * 10_000 : 0;
    maximumDrawdownBps = Math.max(maximumDrawdownBps, drawdownBps);
    return {
      date,
      strategyEquity,
      strategyEquityDisplay: `${strategyEquity.toFixed(2)} USD`,
      benchmarkEquity,
      benchmarkEquityDisplay: `${benchmarkEquity.toFixed(2)} USD`,
      drawdownBps,
      drawdownDisplay: `−${(drawdownBps / 100).toFixed(2)}%`,
    };
  });
  const ending = equity.at(-1)!;
  const strategyReturnBps = ((ending.strategyEquity / startingEquity) - 1) * 10_000;
  const benchmarkReturnBps = ((ending.benchmarkEquity / startingEquity) - 1) * 10_000;
  const fingerprint = sha256CanonicalJson({ request, fixture: "pilot.synthetic.xrp-usd.v1" });
  const runId = `demo_${fingerprint.slice(0, 12)}_${ordinal}`;
  const label = `Sample ${ordinal} · ${Math.round(request.targetBaseBps / 100)}% target / ±${(request.bandBps / 100).toFixed(1)}% band`;
  const model: BacktestsViewModel = {
    availability: "deterministic-fixture",
    availabilityLabel: "Simulated demo · deterministic sample data",
    availabilityTitle: "Interactive sample result — never live market evidence",
    availabilityDetail: "Twelve repository-owned synthetic XRP/USD observations drive this browser-only demonstration. No provider, wallet, model, signing, approval, or execution service is contacted.",
    provider: {
      name: "Repository-owned synthetic fixture",
      pair: "Sample XRP / USD",
      capability: "Twelve invented daily observations for UI demonstration only",
      cost: "Local browser calculation · no account, key, or network call",
      requestedWindow: `${request.startDay} → ${request.endDay}`,
      actualCoverage: `${SAMPLE_PRICES.length}/${SAMPLE_PRICES.length} synthetic sample observations`,
      incompleteCandlePolicy: "Not applicable · every sample point is fixed",
    },
    setup: [
      { id: "dataset", label: "Dataset", value: "Synthetic XRP/USD sample path v1", help: "Invented repository fixture; not historical prices, live quotes, or executable liquidity." },
      { id: "date-window", label: "Display window", value: `${request.startDay} → ${request.endDay}`, help: "Synthetic observations are mapped across the selected window for demonstration." },
      { id: "strategy", label: "Strategy", value: "Long-only allocation band sample", help: "Deterministic browser calculation with no optimizer, model, wallet, or order builder." },
      { id: "starting-portfolio", label: "Starting portfolio", value: `${request.initialBase} sample XRP + ${request.initialQuote} sample USD`, help: "Editable simulation inputs only; no wallet balance is read." },
      { id: "target-band", label: "Target / band", value: `${(request.targetBaseBps / 100).toFixed(2)}% base / ±${(request.bandBps / 100).toFixed(2)}%`, help: "Changing either value creates a new deterministic sample run." },
      { id: "costs", label: "Modeled sample costs", value: `${request.spreadBps} bps spread + ${request.venueFeeBps} bps fee + ${request.slippageBps} bps slippage + ${request.networkCostQuote} USD/fill`, help: "User-controlled assumptions; not observed costs or fill evidence." },
    ],
    splitDisclosure: `The sample rule observes one synthetic point and applies any bounded rebalance at the next synthetic point. The ${request.embargoBars}-day embargo is displayed for parity with the historical workflow; sample results remain illustrative only.`,
    metrics: [
      { label: "Sample strategy return", value: percentFromBps(strategyReturnBps), detail: "Synthetic path after modeled sample costs", tone: strategyReturnBps >= 0 ? "positive" : "warning" },
      { label: "Sample hold benchmark", value: percentFromBps(benchmarkReturnBps), detail: "Same synthetic path with static starting holdings" },
      { label: "Sample excess vs benchmark", value: percentFromBps(strategyReturnBps - benchmarkReturnBps), detail: "Illustrative difference, not expected performance", tone: strategyReturnBps >= benchmarkReturnBps ? "positive" : "warning" },
      { label: "Sample maximum drawdown", value: percentFromBps(-maximumDrawdownBps), detail: "Largest synthetic peak-to-trough decline", tone: "warning" },
      { label: "Sample modeled costs", value: `${totalCosts.toFixed(2)} USD`, detail: "Spread + venue + slippage + fixed cost assumptions" },
      { label: "Sample fills", value: String(trades.length), detail: "Browser-only simulated rebalances; no orders created" },
    ],
    equity,
    trades,
    reproducibility: {
      runId,
      strategyVersion: "allocation-band.sample.v1",
      parameterFingerprint: fingerprint,
      rawHash: SAMPLE_DATASET_HASH,
      normalizedHash: SAMPLE_DATASET_HASH,
      coverage: `${SAMPLE_PRICES.length}/${SAMPLE_PRICES.length} fixed sample observations`,
      missingData: "No missing fixture points · no provider queried",
    },
    experiment: {
      hypothesis: request.hypothesis,
      experiment: "Apply one frozen allocation-band configuration to the fixed synthetic sample path with explicit modeled costs.",
      outcome: `The sample strategy returned ${percentFromBps(strategyReturnBps)} versus ${percentFromBps(benchmarkReturnBps)} for static hold. This demonstrates the workflow only and says nothing about historical, live, or future performance.`,
    },
    savedRuns: [],
  };
  return { runId, label, request, model };
}
