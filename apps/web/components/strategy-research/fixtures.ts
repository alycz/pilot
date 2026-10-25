import {
  parseStrategyDataset,
  strategyDatasetContentDigest,
  type StrategyDataset,
} from "./dataset";

export const FIXTURE_DISCLOSURE =
  "Deterministic fixture · synthetic observations for reproducible research only. Not live prices, historical ledger coverage, or evidence of future performance.";

const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

function observation(
  sequence: number,
  hour: number,
  price: number,
  options: { bidLiquidity?: number; askLiquidity?: number; ammBase?: number; ammQuote?: number } = {},
) {
  const ledger = 90_000_000 + sequence;
  const bid = Number((price * 0.9975).toFixed(6));
  const ask = Number((price * 1.0025).toFixed(6));
  return {
    observation_id: `fixture-${sequence}`,
    observed_at: `2026-01-01T${String(hour).padStart(2, "0")}:00:00.000Z`,
    ledger_index: ledger,
    clob: {
      ledger_index: ledger,
      bid,
      ask,
      bid_liquidity_base: options.bidLiquidity ?? 500,
      ask_liquidity_base: options.askLiquidity ?? 500,
    },
    amm: {
      ledger_index: ledger,
      base_reserve: options.ammBase ?? 10_000,
      quote_reserve: options.ammQuote ?? Number((10_000 * price).toFixed(6)),
      trading_fee_bps: 30,
    },
  };
}

const fixtureInput = {
  schema_version: "pilot.strategy-dataset.v2",
  dataset_id: "fixture.xrp-test-rlusd.v1",
  label: "Synthetic XRP / test-RLUSD research fixture",
  source_kind: "deterministic_fixture",
  network: "testnet",
  base: { symbol: "XRP", currency: "XRP" },
  quote: {
    symbol: "test-RLUSD",
    currency: "524C555344000000000000000000000000000000",
    issuer,
  },
  provenance: {
    source_label: "Repository-owned deterministic fixture",
    collected_at: "2026-01-02T00:00:00.000Z",
    content_digest: "0".repeat(64),
    methodology: "Hand-authored bounded observations used only to test deterministic simulation, availability gates, and disclosure behavior.",
  },
  coverage: {
    start_at: "2026-01-01T00:00:00.000Z",
    end_at: "2026-01-01T08:00:00.000Z",
    expected_interval_seconds: 3_600,
    alignment_tolerance_seconds: 0,
    missing_intervals: [{ after_observation_id: "fixture-6", missing_count: 1 }],
  },
  split: {
    train_end_at: "2026-01-01T03:00:00.000Z",
    out_of_sample_start_at: "2026-01-01T04:00:00.000Z",
  },
  observations: [
    observation(1, 0, 0.5),
    observation(2, 1, 0.62),
    observation(3, 2, 0.74, { bidLiquidity: 45, askLiquidity: 45 }),
    observation(4, 3, 0.58),
    observation(5, 4, 0.43),
    observation(6, 5, 0.36, { bidLiquidity: 18, askLiquidity: 18 }),
    observation(7, 7, 0.49),
    observation(8, 8, 0.55),
  ],
};

fixtureInput.provenance.content_digest = strategyDatasetContentDigest(fixtureInput);

export const DETERMINISTIC_STRATEGY_FIXTURE: StrategyDataset = parseStrategyDataset(fixtureInput);
