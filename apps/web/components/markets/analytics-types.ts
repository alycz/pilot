/**
 * Normalized market analytics shared by the Markets UI and its Harbor proxy.
 *
 * Numeric ledger values intentionally remain decimal strings. Rendering code
 * may format them for display, but should not silently round the source data.
 */

export type AnalyticsNetwork = "mainnet" | "testnet" | "devnet";
export type AnalyticsMode = "live" | "sampled-live" | "demo-fixture";
export type DecimalString = string;

export type AnalyticsAssetInput = {
  currency: string;
  issuer?: string;
};

export type AnalyticsAsset =
  | { kind: "native"; currency: "XRP"; issuer: null }
  | { kind: "issued"; currency: string; issuer: string };

export type AnalyticsPairInput = {
  base: AnalyticsAssetInput;
  quote: AnalyticsAssetInput;
};

export type AnalyticsPair = {
  base: AnalyticsAsset;
  quote: AnalyticsAsset;
};

export type AnalyticsFreshness = {
  state: "fresh" | "stale" | "unknown";
  ageMs: number | null;
  maxAgeMs: number;
  reason?: string;
};

export type AnalyticsCoverage = {
  startedAt: string;
  endedAt: string | null;
  sampleCount: number;
  maxSamples: number;
  intervalHintMs: number | null;
  complete: boolean;
  reason?: string;
};

export type AnalyticsSource = {
  operation: string;
  providers: string[];
  requestCount: number;
  bounded: boolean;
};

export type AnalyticsObservationMeta = {
  network: AnalyticsNetwork;
  mode: AnalyticsMode;
  source: AnalyticsSource;
  observedAt: string | null;
  ledgerIndex: number | null;
  ledgerIndexes: { bids: number | null; asks: number | null; amm: number | null } | null;
  ledgerCloseTime: string | null;
  receivedAt: string;
  freshness: AnalyticsFreshness;
  /** Human-readable units keyed by response field, e.g. price -> RLUSD/XRP. */
  units: Record<string, string>;
  coverage?: AnalyticsCoverage;
};

export type AnalyticsDepthLevel = {
  /** Quote units per one base unit. */
  price: DecimalString;
  /** Available base units at this level. */
  baseSize: DecimalString;
  /** Quote amount at this level when supplied by Harbor. */
  quoteSize: DecimalString | null;
  offerCount: number;
  cumulativeBaseSize: DecimalString;
};

export type AnalyticsOrderBook = {
  bids: AnalyticsDepthLevel[];
  asks: AnalyticsDepthLevel[];
  limited: boolean;
  maxLevels: number;
  availability: { bids: "available" | "empty" | "error"; asks: "available" | "empty" | "error" };
  invalidOfferCount: number;
};

export type AnalyticsAmm = {
  account: string | null;
  baseReserve: DecimalString;
  quoteReserve: DecimalString;
  /** XRPL AMM fee in basis points, after conversion from ledger fee units. */
  tradingFeeBps: DecimalString | null;
  impliedPrice: DecimalString;
  units: Record<string, string>;
};

export type AnalyticsMarketMetrics = {
  bestBid: DecimalString | null;
  bestAsk: DecimalString | null;
  mid: DecimalString | null;
  spread: DecimalString | null;
  spreadBps: DecimalString | null;
};

export type AnalyticsExecutableEstimate = {
  direction: "sell-base" | "buy-base";
  requestedBase: DecimalString;
  filledBase: DecimalString;
  quoteAmount: DecimalString;
  averagePrice: DecimalString | null;
  priceImpactBps: DecimalString | null;
  benchmark: "book-mid" | null;
  available: boolean;
  limitedByDepth: boolean;
  levelsConsumed: number;
};

export type AnalyticsExecutableLiquidity = {
  baseAmount: DecimalString;
  sellBase: AnalyticsExecutableEstimate;
  buyBase: AnalyticsExecutableEstimate;
};

export type AnalyticsPricePoint = {
  observedAt: string;
  ledgerIndex: number | null;
  price: DecimalString;
  /** Starts a new sampled segment; no continuous interval is inferred. */
  gapBefore?: boolean;
};

export type AnalyticsTrade = {
  hash: string;
  ledgerIndex: number;
  observedAt: string;
  side: "buy" | "sell" | "unknown";
  price: DecimalString;
  baseAmount: DecimalString;
  quoteAmount: DecimalString;
};

export type AnalyticsRecentTrades =
  | { support: "supported"; rows: AnalyticsTrade[]; limited: boolean }
  | { support: "unsupported"; rows: []; reason: string };

export type PairAnalyticsSnapshot = {
  pair: AnalyticsPair;
  meta: AnalyticsObservationMeta;
  book: AnalyticsOrderBook;
  metrics: AnalyticsMarketMetrics;
  executableLiquidity: AnalyticsExecutableLiquidity[];
  amm: AnalyticsAmm | null;
  availability: { amm: "available" | "unavailable" | "error" };
  history: AnalyticsPricePoint[];
  recentTrades: AnalyticsRecentTrades;
};

export type AnalyticsEmptyReason = "no-liquidity" | "unsupported" | "no-observations";

/**
 * Failed reads never carry prior data. This prevents a stale/error response
 * from being presented as a new live observation.
 */
export type AnalyticsPanelState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "partial"; data: T; issues: string[] }
  | {
      status: "empty";
      reason: AnalyticsEmptyReason;
      message: string;
      meta: AnalyticsObservationMeta;
    }
  | { status: "error"; message: string; retryable: boolean; receivedAt: string };

export type AnalyticsSpread = {
  bestBid: DecimalString | null;
  bestAsk: DecimalString | null;
  midpoint: DecimalString | null;
  spread: DecimalString | null;
  spreadBps: DecimalString | null;
  condition: "two-sided" | "one-sided" | "empty" | "crossed";
};

export type ExecutableBookQuote = {
  side: "buy" | "sell";
  requestedBase: DecimalString;
  filledBase: DecimalString;
  quoteAmount: DecimalString;
  averagePrice: DecimalString | null;
  referencePrice: DecimalString | null;
  slippageBps: DecimalString | null;
  complete: boolean;
  levelsUsed: number;
  unavailableReason?: "no-liquidity" | "insufficient-depth" | "invalid-reference";
};

export type MarketComparison = {
  id: string;
  pair: AnalyticsPair;
  meta: AnalyticsObservationMeta;
  midpoint: DecimalString | null;
  ammPrice: DecimalString | null;
  divergenceBps: DecimalString | null;
  excluded: boolean;
  exclusionReason?: string;
};

export function analyticsAssetKey(network: AnalyticsNetwork, asset: AnalyticsAsset): string {
  return `${network}:${asset.currency}:${asset.issuer ?? "native"}`;
}

export function analyticsPairKey(network: AnalyticsNetwork, pair: AnalyticsPair): string {
  return `${analyticsAssetKey(network, pair.base)}>${analyticsAssetKey(network, pair.quote)}`;
}
