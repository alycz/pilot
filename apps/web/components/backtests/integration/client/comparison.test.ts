import { describe, expect, it } from "vitest";

import { compareRunEvidence } from "./comparison";
import { clientBundle } from "./test-fixture";

describe("saved backtest comparison", () => {
  it("computes deterministic decimal deltas for compatible evidence", () => {
    const baseline = clientBundle("bt_111111111111111111111111");
    const candidate = clientBundle("bt_222222222222222222222222");
    candidate.chatEvidence.metrics.strategyReturnBps = "125.25";
    candidate.chatEvidence.metrics.totalCostsQuote = "3.75";
    expect(compareRunEvidence(candidate, baseline)).toEqual({
      compatible: true,
      detail: "strategy +25.25 bps · benchmark +0 bps · drawdown +0 bps · cost +1.25 USD",
    });
  });

  it("blocks cross-dataset comparisons", () => {
    const baseline = clientBundle("bt_111111111111111111111111");
    const source = clientBundle("bt_222222222222222222222222");
    const changedHash = "c".repeat(64);
    const candidate = {
      ...source,
      chatEvidence: { ...source.chatEvidence, datasetNormalizedHash: changedHash },
      viewModel: {
        ...source.viewModel,
        reproducibility: { ...source.viewModel.reproducibility, normalizedHash: changedHash },
      },
    };
    expect(compareRunEvidence(candidate, baseline)).toMatchObject({ compatible: false });
  });

  it("blocks comparisons across engine versions or evaluation splits", () => {
    const baseline = clientBundle("bt_111111111111111111111111");
    const engineChanged = clientBundle("bt_222222222222222222222222");
    (engineChanged.savedRun.report as { engineVersion: string }).engineVersion = "pilot.daily-bar-backtest.v2";
    expect(compareRunEvidence(engineChanged, baseline)).toMatchObject({ compatible: false });

    const splitChanged = clientBundle("bt_333333333333333333333333");
    (splitChanged.savedRun.report as { split: { embargoBars: number } }).split.embargoBars = 2;
    expect(compareRunEvidence(splitChanged, baseline)).toMatchObject({ compatible: false });
  });
});
