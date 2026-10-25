import { describe, expect, it } from "vitest";

import { researchArbitrage, type ArbitrageResearchConfig } from "./arbitrage";
import { strategyDatasetContentDigest, type StrategyDataset } from "./dataset";
import { DETERMINISTIC_STRATEGY_FIXTURE } from "./fixtures";

function reseal(dataset: StrategyDataset): StrategyDataset {
  dataset.provenance.content_digest = strategyDatasetContentDigest(dataset);
  return dataset;
}

const baseConfig: ArbitrageResearchConfig = {
  now: "2026-01-01T08:00:10.000Z",
  tradeSizeBase: 100,
  maxQuoteAgeSeconds: 30,
  clobFeeBps: 10,
  assumedSlippageBps: 25,
  networkFeeQuotePerLeg: 0.01,
  minimumNetEdgeBps: 20,
};

describe("arbitrage research alerts", () => {
  it("emits only a net-of-cost research alert from fresh same-ledger executable quotes", () => {
    const dataset = structuredClone(DETERMINISTIC_STRATEGY_FIXTURE);
    const latest = dataset.observations.at(-1)!;
    latest.amm!.quote_reserve = latest.amm!.base_reserve * 0.72;
    const result = researchArbitrage(reseal(dataset), baseConfig);
    expect(result.status).toBe("available");
    expect(result.dataAvailability).toBe("fixture-simulation");
    expect(result.alerts[0]).toMatchObject({ kind: "research_alert", route: "buy_clob_sell_amm", ledgerIndex: latest.ledger_index });
    expect(result.alerts[0]!.netEdgeQuote).toBeGreaterThan(0);
    expect(result.alerts[0]!.totalCostsQuote).toBeGreaterThan(0);
    expect(result.alerts[0]!.disclosure).toMatch(/deterministic fixture simulation signal only/i);
    expect(JSON.stringify(result)).not.toMatch(/tx_json|build_id|approval_id|submit/);
  });

  it("fails availability closed for stale quotes", () => {
    const result = researchArbitrage(DETERMINISTIC_STRATEGY_FIXTURE, {
      ...baseConfig,
      now: "2026-01-01T08:02:00.000Z",
    });
    expect(result.status).toBe("unavailable");
    expect(result.alerts).toEqual([]);
    expect(result.reasons.join(" ")).toMatch(/stale/);
  });

  it("rejects mixed-ledger inputs before comparison", () => {
    const dataset = structuredClone(DETERMINISTIC_STRATEGY_FIXTURE);
    dataset.observations.at(-1)!.clob!.ledger_index += 1;
    expect(() => researchArbitrage(dataset, baseConfig)).toThrow(/CLOB quote must use the observation ledger/);
  });

  it("reports insufficient executable depth instead of inventing an alert", () => {
    const dataset = structuredClone(DETERMINISTIC_STRATEGY_FIXTURE);
    const latest = dataset.observations.at(-1)!;
    latest.clob!.ask_liquidity_base = 1;
    latest.clob!.bid_liquidity_base = 1;
    const result = researchArbitrage(reseal(dataset), baseConfig);
    expect(result.status).toBe("available");
    expect(result.alerts).toEqual([]);
    expect(result.reasons.join(" ")).toMatch(/depth is below/);
  });
});
