export const DAILY_BAR_BACKTEST_REPORT_VERSION = "pilot.daily-bar-backtest.v1" as const;
export const ALLOCATION_BAND_STRATEGY_VERSION = "allocation-band.v1" as const;

export type DailyBar = Readonly<{
  id: string;
  startAt: string;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Informational only. The v1 engine never infers executable liquidity from it. */
  volumeBase?: string;
  complete: true;
}>;
export type DailyBarDataset = Readonly<{
  datasetId: string;
  normalizedHash: string;
  baseSymbol: string;
  quoteSymbol: string;
  intervalSeconds: 86_400;
  bars: readonly DailyBar[];
}>;

export type DailyBarBacktestConfig = Readonly<{
  initialBase: string;
  initialQuote: string;
  targetBaseBps: number;
  bandBps: number;
  maxTradeQuote: string;
  spreadBps: number;
  venueFeeBps: number;
  slippageBps: number;
  networkCostQuote: string;
  outOfSampleStartAt: string;
  embargoBars: number;
}>;

export type EvaluationPhase = "in_sample" | "embargo" | "out_of_sample";
export type TradeSide = "buy_base" | "sell_base";
export type RejectionCode =
  | "EMBARGO"
  | "MISSING_NEXT_BAR"
  | "NO_NEXT_BAR"
  | "INSUFFICIENT_CASH"
  | "INSUFFICIENT_BASE"
  | "COST_EXCEEDS_PROCEEDS"
  | "ROUNDING_TO_ZERO";

export type BacktestOrder = Readonly<{
  signalAt: string;
  scheduledFillAt: string;
  signalPhase: EvaluationPhase;
  side: TradeSide;
  requestedGrossQuote: string;
  status: "filled" | "rejected";
  fillAt?: string;
  fillPhase?: EvaluationPhase;
  rejectionCode?: RejectionCode;
  /** Unadjusted next-bar open used to calculate base quantity. */
  unadjustedReferenceOpen?: string;
  grossNotionalQuote?: string;
  filledBase?: string;
  netCashFlowQuote?: string;
  partial?: boolean;
  costs?: Readonly<{
    /** Cash-equivalent quote deduction; this is not a fill-price adjustment. */
    spreadCostQuote: string;
    venueFeeCostQuote: string;
    /** Cash-equivalent quote deduction; this is not price impact. */
    slippageCostQuote: string;
    networkCostQuote: string;
    totalCostQuote: string;
  }>;
}>;

export type PortfolioPoint = Readonly<{
  barId: string;
  observedAt: string;
  phase: EvaluationPhase;
  close: string;
  base: string;
  quote: string;
  strategyEquityQuote: string;
  benchmarkEquityQuote: string;
  drawdownBps: number;
}>;

export type WindowMetrics = Readonly<{
  startAt: string;
  endAt: string;
  observations: number;
  strategyReturnBps: number;
  benchmarkReturnBps: number;
  excessReturnBps: number;
  maxDrawdownBps: number;
  filledTradeCount: number;
  rejectedOrderCount: number;
  turnoverQuote: string;
  totalCostsQuote: string;
}>;

export type DailyBarBacktestReport = Readonly<{
  reportVersion: typeof DAILY_BAR_BACKTEST_REPORT_VERSION;
  strategyVersion: typeof ALLOCATION_BAND_STRATEGY_VERSION;
  datasetId: string;
  datasetHash: string;
  parameterFingerprint: string;
  assumptions: DailyBarBacktestConfig;
  executionDisclosure: string;
  fillPriceModel: "next-open-unadjusted";
  proportionalCostModel: "cash-equivalent-quote-deduction";
  liquidityModel: "not-modeled";
  missingBuckets: number;
  split: Readonly<{
    outOfSampleStartAt: string;
    embargoBars: number;
    inSampleEndAt: string;
    embargoStartAt: string;
  }>;
  metrics: Readonly<{
    full: WindowMetrics;
    inSample: WindowMetrics;
    outOfSample: WindowMetrics;
  }>;
  orders: readonly BacktestOrder[];
  portfolio: readonly PortfolioPoint[];
}>;
