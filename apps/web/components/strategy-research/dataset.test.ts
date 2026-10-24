import { describe, expect, it } from "vitest";

import {
  datasetCoverage,
  parseStrategyDataset,
  strategyDatasetContentDigest,
} from "./dataset";
import { DETERMINISTIC_STRATEGY_FIXTURE } from "./fixtures";

const clone = () => structuredClone(DETERMINISTIC_STRATEGY_FIXTURE);

describe("strategy research dataset contract", () => {
  it("validates explicit provenance, coverage, missing intervals, and train/OOS boundaries", () => {
    const dataset = parseStrategyDataset(clone());
    expect(dataset.source_kind).toBe("deterministic_fixture");
    expect(dataset.provenance.content_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(strategyDatasetContentDigest(dataset)).toBe(dataset.provenance.content_digest);
    expect(datasetCoverage(dataset)).toEqual({ observed: 8, expected: 9, missing: 1, coveragePercent: 88.89 });
    expect(Date.parse(dataset.split.train_end_at)).toBeLessThan(Date.parse(dataset.split.out_of_sample_start_at));
  });

  it("rejects non-monotonic observations and mismatched route ledgers", () => {
    const timeTravel = clone();
    timeTravel.observations[2]!.observed_at = timeTravel.observations[1]!.observed_at;
    expect(() => parseStrategyDataset(timeTravel)).toThrow(/increase strictly/);

    const mixedLedger = clone();
    mixedLedger.observations[3]!.amm!.ledger_index += 1;
    expect(() => parseStrategyDataset(mixedLedger)).toThrow(/AMM quote must use the observation ledger/);
  });

  it("rejects understated gaps and overlapping evaluation windows", () => {
    const hiddenGap = clone();
    hiddenGap.coverage.missing_intervals = [];
    expect(() => parseStrategyDataset(hiddenGap)).toThrow(/declared missing intervals/);

    const overlap = clone();
    overlap.split.out_of_sample_start_at = overlap.split.train_end_at;
    expect(() => parseStrategyDataset(overlap)).toThrow(/must not overlap/);
  });

  it("rejects content changes that are not covered by the canonical digest", () => {
    const changedLabel = clone();
    changedLabel.label = "Caller-relabelled dataset";
    expect(() => parseStrategyDataset(changedLabel)).toThrow(/content digest/);
  });

  it("requires an external source-and-digest trust decision for historical data", () => {
    const historical = clone();
    historical.source_kind = "validated_historical";
    historical.provenance.source_label = "approved-feed";
    historical.provenance.content_digest = strategyDatasetContentDigest(historical);

    expect(() => parseStrategyDataset(historical)).toThrow(/externally trusted source and digest/);
    expect(parseStrategyDataset(historical, {
      trustedSources: [{
        sourceLabel: historical.provenance.source_label,
        contentDigest: historical.provenance.content_digest,
      }],
    }).source_kind).toBe("validated_historical");
  });

  it("rejects off-grid timestamps outside the declared alignment tolerance", () => {
    const offGrid = clone();
    offGrid.coverage.alignment_tolerance_seconds = 5;
    offGrid.observations[1]!.observed_at = "2026-01-01T01:00:06.000Z";
    expect(() => parseStrategyDataset(offGrid)).toThrow(/interval alignment tolerance/);

    const withinTolerance = clone();
    withinTolerance.coverage.alignment_tolerance_seconds = 5;
    withinTolerance.observations[1]!.observed_at = "2026-01-01T01:00:05.000Z";
    withinTolerance.provenance.content_digest = strategyDatasetContentDigest(withinTolerance);
    expect(parseStrategyDataset(withinTolerance).coverage.alignment_tolerance_seconds).toBe(5);
  });
});
