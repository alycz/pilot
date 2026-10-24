import type { BacktestsViewModel } from "./view-model";

/**
 * Empty pre-run state. It deliberately contains no decorative performance
 * result and cannot be mistaken for validated historical evidence.
 */
export const BACKTESTS_FIXTURE_VIEW_MODEL: BacktestsViewModel = {
  availability: "unavailable",
  availabilityLabel: "Not run · historical coverage not loaded",
  availabilityTitle: "Configure and run a validated experiment",
  availabilityDetail:
    "No performance result is shown until the public dataset passes source, digest, chronology, and coverage validation.",
  provider: {
    name: "Kraken public API · not loaded",
    pair: "XRP / USD",
    capability: "Public daily OHLC · read-only",
    cost: "No account or API key planned",
    requestedWindow: "2025-01-01 → 2026-09-30",
    actualCoverage: "Not yet verified",
    incompleteCandlePolicy: "Discard current incomplete candle",
  },
  setup: [
    { id: "dataset", label: "Dataset", value: "Kraken XRP/USD daily OHLC · not loaded", help: "History must pass source, digest, chronology, and coverage validation." },
    { id: "date-window", label: "Date window", value: "2025-01-01 → 2026-09-30", help: "Requested window; actual provider coverage is reported separately." },
    { id: "strategy", label: "Strategy", value: "Long-only allocation band v1", help: "No leverage, shorts, optimizer, or generated strategy code." },
    { id: "starting-portfolio", label: "Starting portfolio", value: "1,000 XRP + 1,000.00 USD", help: "Research inputs only; no wallet address or balance is read." },
    { id: "target-band", label: "Target / band", value: "50% base / ±5%", help: "Parameters are frozen before the out-of-sample window is revealed." },
    { id: "costs", label: "Costs", value: "10 bps fee + 25 bps slippage + 0.01 USD/fill", help: "Explicit assumptions, not observed venue costs or executable quotes." },
  ],
  splitDisclosure:
    "Signals use day t close and can fill no earlier than day t+1 open. A one-bar embargo separates the frozen in-sample setup from out-of-sample evaluation.",
  metrics: [],
  equity: [],
  trades: [],
  reproducibility: {
    runId: "Not available before a run",
    strategyVersion: "allocation-band.v1",
    parameterFingerprint: "Not available before a run",
    rawHash: "Unavailable until provider fetch",
    normalizedHash: "Not available before a run",
    coverage: "Not loaded",
    missingData: "Not evaluated",
  },
  experiment: {
    hypothesis: "A bounded allocation band may reduce unnecessary turnover relative to daily rebalancing.",
    experiment: "Freeze one allocation-band configuration, apply explicit costs, then evaluate after a chronological embargo.",
    outcome: "Not run. No market conclusion is available until validated historical data is supplied.",
  },
  savedRuns: [],
};
