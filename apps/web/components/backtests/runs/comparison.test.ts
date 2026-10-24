import { describe, expect, it } from "vitest";

import { compareSavedRuns } from "./comparison";
import { createReproducibilityReport } from "./report";
import { HASH_A, reportInput } from "./test-fixtures";

describe("saved-run comparison", () => {
  it("computes exact OOS deltas for compatible runs", () => {
    const baseline = createReproducibilityReport(reportInput());
    const candidateInput = reportInput();
    candidateInput.strategy.parameters.bandBps = 750;
    candidateInput.result.outOfSample = {
      ...candidateInput.result.outOfSample,
      totalReturnBps: "52.75",
      benchmarkReturnBps: "37.5",
      excessReturnBps: "15.25",
      maxDrawdownBps: "70.50",
      totalCostsQuote: "1.375",
      tradeCount: 3,
    };
    candidateInput.study.outcome.observedPrimaryMetric = "15.25";
    const candidate = createReproducibilityReport(candidateInput);
    const comparison = compareSavedRuns(baseline, candidate);

    expect(comparison).toMatchObject({
      compatible: true,
      outOfSampleDelta: {
        totalReturnBps: "2.75",
        benchmarkReturnBps: "0",
        excessReturnBps: "2.75",
        maxDrawdownBps: "-4.5",
        totalCostsQuote: "0.125",
        tradeCount: 1,
      },
    });
  });

  it("returns specific reasons for incompatible data, strategy, currency, and split", () => {
    const baseline = createReproducibilityReport(reportInput());
    const candidateInput = reportInput({
      dataset: {
        ...reportInput().dataset,
        rawHashSha256: "c".repeat(64),
        normalizedHashSha256: HASH_A,
      },
      strategy: {
        strategyId: "different-strategy",
        strategyVersion: "different-strategy.v1",
        parameters: {},
      },
      engineVersion: "fixed-point.v2",
      split: {
        ...reportInput().split,
        outOfSampleStartDate: "2025-01-09",
      },
      costs: { ...reportInput().costs, quoteCurrency: "EUR" },
      result: { ...reportInput().result, quoteCurrency: "EUR" },
    });
    const comparison = compareSavedRuns(
      baseline,
      createReproducibilityReport(candidateInput),
    );
    expect(comparison.compatible).toBe(false);
    if (comparison.compatible) throw new Error("expected incompatible runs");
    expect(comparison.reasons.map(({ code }) => code)).toEqual([
      "dataset_mismatch",
      "strategy_mismatch",
      "engine_mismatch",
      "currency_mismatch",
      "split_mismatch",
    ]);
  });
});
