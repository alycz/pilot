import {
  parseStrategyDataset,
  type HistoricalDatasetTrust,
  type StrategyDataset,
} from "./dataset";

export type ArbitrageResearchConfig = {
  now: string;
  tradeSizeBase: number;
  maxQuoteAgeSeconds: number;
  clobFeeBps: number;
  assumedSlippageBps: number;
  networkFeeQuotePerLeg: number;
  minimumNetEdgeBps: number;
};

export type ArbitrageResearchAlert = {
  kind: "research_alert";
  route: "buy_clob_sell_amm" | "buy_amm_sell_clob";
  ledgerIndex: number;
  observedAt: string;
  sizeBase: number;
  inputQuote: number;
  outputQuote: number;
  totalCostsQuote: number;
  netEdgeQuote: number;
  netEdgeBps: number;
  disclosure: string;
};

export type ArbitrageResearchResult = {
  status: "available" | "unavailable";
  datasetId: string;
  sourceKind: StrategyDataset["source_kind"];
  dataAvailability: "fixture-simulation" | "validated-historical";
  ledgerIndex?: number;
  observedAt?: string;
  alerts: ArbitrageResearchAlert[];
  reasons: string[];
};

const round = (value: number, places = 8) => Number(value.toFixed(places));

function validateConfig(config: ArbitrageResearchConfig): void {
  const now = Date.parse(config.now);
  if (!Number.isFinite(now)) throw new TypeError("arbitrage research clock must be an ISO timestamp");
  if (!Number.isFinite(config.tradeSizeBase) || config.tradeSizeBase <= 0) throw new TypeError("research size must be positive");
  if (!Number.isInteger(config.maxQuoteAgeSeconds) || config.maxQuoteAgeSeconds < 0 || config.maxQuoteAgeSeconds > 3_600) {
    throw new TypeError("quote age bound must be from 0 to 3,600 seconds");
  }
  for (const [label, value] of [
    ["CLOB fee", config.clobFeeBps],
    ["slippage", config.assumedSlippageBps],
    ["minimum edge", config.minimumNetEdgeBps],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 5_000) throw new TypeError(`${label} must be bounded whole-number bps`);
  }
  if (!Number.isFinite(config.networkFeeQuotePerLeg) || config.networkFeeQuotePerLeg < 0) {
    throw new TypeError("network fee assumption must be finite and nonnegative");
  }
}

function sellBaseIntoAmm(base: number, baseReserve: number, quoteReserve: number, feeBps: number): number {
  const afterFee = base * (1 - feeBps / 10_000);
  return quoteReserve * afterFee / (baseReserve + afterFee);
}

function quoteRequiredToBuyBase(base: number, baseReserve: number, quoteReserve: number, feeBps: number): number | undefined {
  if (base >= baseReserve) return undefined;
  const quoteAfterFee = quoteReserve * base / (baseReserve - base);
  const feeFactor = 1 - feeBps / 10_000;
  return feeFactor > 0 ? quoteAfterFee / feeFactor : undefined;
}

/**
 * Produces research alerts only. It consumes one schema-validated same-ledger
 * snapshot and has no wallet, builder, submission, or approval output.
 */
export function researchArbitrage(
  datasetInput: unknown,
  config: ArbitrageResearchConfig,
  historicalTrust?: HistoricalDatasetTrust,
): ArbitrageResearchResult {
  const dataset = parseStrategyDataset(datasetInput, historicalTrust);
  validateConfig(config);
  const observation = dataset.observations.at(-1)!;
  const baseResult = {
    datasetId: dataset.dataset_id,
    sourceKind: dataset.source_kind,
    dataAvailability: dataset.source_kind === "validated_historical" ? "validated-historical" as const : "fixture-simulation" as const,
    ledgerIndex: observation.ledger_index,
    observedAt: observation.observed_at,
  };
  const reasons: string[] = [];
  const ageSeconds = (Date.parse(config.now) - Date.parse(observation.observed_at)) / 1_000;
  if (ageSeconds < 0) reasons.push("Latest quote is newer than the research clock.");
  if (ageSeconds > config.maxQuoteAgeSeconds) reasons.push(`Latest quote is stale (${Math.round(ageSeconds)}s > ${config.maxQuoteAgeSeconds}s).`);
  if (!observation.clob) reasons.push("A same-ledger executable CLOB snapshot is unavailable.");
  if (!observation.amm) reasons.push("A same-ledger XRPL AMM snapshot is unavailable.");
  if (reasons.length > 0 || !observation.clob || !observation.amm) {
    return { status: "unavailable", ...baseResult, alerts: [], reasons };
  }

  const { clob, amm } = observation;
  const size = config.tradeSizeBase;
  const proportionalClobCost = (config.clobFeeBps + config.assumedSlippageBps) / 10_000;
  const assumedAmmSlippage = config.assumedSlippageBps / 10_000;
  const networkCosts = config.networkFeeQuotePerLeg * 2;
  const candidates: Array<Omit<ArbitrageResearchAlert, "kind" | "disclosure">> = [];

  if (clob.ask_liquidity_base >= size) {
    const inputBeforeCosts = size * clob.ask;
    const inputQuote = inputBeforeCosts * (1 + proportionalClobCost) + networkCosts;
    const rawOutput = sellBaseIntoAmm(size, amm.base_reserve, amm.quote_reserve, amm.trading_fee_bps);
    const outputQuote = rawOutput * (1 - assumedAmmSlippage);
    const totalCostsQuote = inputQuote - inputBeforeCosts + (rawOutput - outputQuote);
    const netEdgeQuote = outputQuote - inputQuote;
    candidates.push({
      route: "buy_clob_sell_amm",
      ledgerIndex: observation.ledger_index,
      observedAt: observation.observed_at,
      sizeBase: size,
      inputQuote: round(inputQuote),
      outputQuote: round(outputQuote),
      totalCostsQuote: round(totalCostsQuote),
      netEdgeQuote: round(netEdgeQuote),
      netEdgeBps: round((netEdgeQuote / inputQuote) * 10_000, 2),
    });
  } else {
    reasons.push("CLOB ask depth is below the configured research size.");
  }

  const ammInput = quoteRequiredToBuyBase(size, amm.base_reserve, amm.quote_reserve, amm.trading_fee_bps);
  if (clob.bid_liquidity_base >= size && ammInput !== undefined) {
    const inputQuote = ammInput * (1 + assumedAmmSlippage) + networkCosts;
    const outputBeforeCosts = size * clob.bid;
    const outputQuote = outputBeforeCosts * (1 - proportionalClobCost);
    const totalCostsQuote = inputQuote - ammInput + (outputBeforeCosts - outputQuote);
    const netEdgeQuote = outputQuote - inputQuote;
    candidates.push({
      route: "buy_amm_sell_clob",
      ledgerIndex: observation.ledger_index,
      observedAt: observation.observed_at,
      sizeBase: size,
      inputQuote: round(inputQuote),
      outputQuote: round(outputQuote),
      totalCostsQuote: round(totalCostsQuote),
      netEdgeQuote: round(netEdgeQuote),
      netEdgeBps: round((netEdgeQuote / inputQuote) * 10_000, 2),
    });
  } else if (clob.bid_liquidity_base < size) {
    reasons.push("CLOB bid depth is below the configured research size.");
  } else {
    reasons.push("AMM reserves cannot support the configured research size.");
  }

  const alerts = candidates
    .filter(({ netEdgeBps }) => netEdgeBps >= config.minimumNetEdgeBps && netEdgeBps > 0)
    .sort((left, right) => right.netEdgeBps - left.netEdgeBps)
    .map((candidate): ArbitrageResearchAlert => ({
      kind: "research_alert",
      ...candidate,
      disclosure: dataset.source_kind === "deterministic_fixture"
        ? "Deterministic fixture simulation signal only. It is not a live executable quote, execution instruction, or profit guarantee."
        : "Validated historical research signal only. It is not a live execution instruction or a profit guarantee; quotes can change before any separately approved action.",
    }));
  if (candidates.length > 0 && alerts.length === 0) reasons.push("No route has a positive net edge above the configured threshold after modeled costs.");
  return { status: "available", ...baseResult, alerts, reasons };
}
