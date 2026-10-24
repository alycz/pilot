export type DataAvailability = "validated-historical" | "deterministic-fixture" | "unavailable";

export type BacktestSetupField = Readonly<{
  id: string;
  label: string;
  value: string;
  help: string;
}>;

export type BacktestMetric = Readonly<{
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "positive" | "warning";
}>;

export type EquityDatum = Readonly<{
  date: string;
  /** Approximate numeric projection used only to draw the chart. */
  strategyEquity: number;
  /** Authoritative fixed-point value rendered in the result table. */
  strategyEquityDisplay: string;
  benchmarkEquity: number;
  benchmarkEquityDisplay: string;
  drawdownBps: number;
  drawdownDisplay: string;
}>;

export type BacktestTradeRow = Readonly<{
  signalAt: string;
  fillAt: string;
  side: "Buy base" | "Sell base" | "Rejected";
  grossNotional: string;
  costs: string;
  endingCash: string;
  status: string;
}>;

export type SavedRunComparison = Readonly<{
  label: string;
  runId: string;
  datasetFingerprint: string;
  strategyReturn: string;
  benchmarkReturn: string;
  maxDrawdown: string;
  totalCosts: string;
  compatible: boolean;
}>;

export type BacktestsViewModel = Readonly<{
  availability: DataAvailability;
  availabilityLabel: string;
  availabilityTitle: string;
  availabilityDetail: string;
  provider: Readonly<{
    name: string;
    pair: string;
    capability: string;
    cost: string;
    requestedWindow: string;
    actualCoverage: string;
    incompleteCandlePolicy: string;
  }>;
  setup: readonly BacktestSetupField[];
  splitDisclosure: string;
  metrics: readonly BacktestMetric[];
  equity: readonly EquityDatum[];
  trades: readonly BacktestTradeRow[];
  reproducibility: Readonly<{
    runId: string;
    strategyVersion: string;
    parameterFingerprint: string;
    rawHash: string;
    normalizedHash: string;
    coverage: string;
    missingData: string;
  }>;
  experiment: Readonly<{
    hypothesis: string;
    experiment: string;
    outcome: string;
  }>;
  savedRuns: readonly SavedRunComparison[];
}>;
