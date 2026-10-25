import { afterEach, describe, expect, it, vi } from "vitest";

import { INITIAL_DRAFT, requestFromDraft } from "./backtests-client";
import { createSignedOutDemoRun, withDemoComparisons } from "./signed-out-demo";

describe("signed-out backtest demo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates deterministic, clearly synthetic results without external dependencies", () => {
    const fetcher = vi.fn(() => {
      throw new Error("sample calculation attempted a network call");
    });
    vi.stubGlobal("fetch", fetcher);
    const request = requestFromDraft(INITIAL_DRAFT);
    const first = createSignedOutDemoRun(request, 1);
    const reload = createSignedOutDemoRun(request, 1);

    expect(reload).toEqual(first);
    expect(first.model.availability).toBe("deterministic-fixture");
    expect(first.model.availabilityTitle).toContain("never live market evidence");
    expect(first.model.provider.name).toBe("Repository-owned synthetic fixture");
    expect(first.model.equity).toHaveLength(12);
    expect(first.model.metrics).toHaveLength(6);
    expect(first.model.trades.length).toBeGreaterThan(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(first)).not.toMatch(/wallet.?address|signed.?blob|approval.?id|transaction.?hash/i);
  });

  it("changes sample output only from supported deterministic inputs", () => {
    const baseline = createSignedOutDemoRun(requestFromDraft(INITIAL_DRAFT), 1);
    const tighter = createSignedOutDemoRun(requestFromDraft({
      ...INITIAL_DRAFT,
      targetBaseBps: "6500",
      bandBps: "150",
      maxTradeQuote: "100",
    }), 2);

    expect(tighter.model.reproducibility.parameterFingerprint).not.toBe(baseline.model.reproducibility.parameterFingerprint);
    expect(tighter.model.setup.find(({ id }) => id === "target-band")?.value).toContain("65.00%");
    expect(tighter.model.metrics).not.toEqual(baseline.model.metrics);
  });

  it("supports repeat, compare, and reset without persisting authority", () => {
    const request = requestFromDraft(INITIAL_DRAFT);
    const initial = createSignedOutDemoRun(request, 1);
    const repeat = createSignedOutDemoRun(request, 2);
    const compared = withDemoComparisons(repeat, [repeat, initial]);
    const reset = createSignedOutDemoRun(request, 1);

    expect(repeat.model.metrics).toEqual(initial.model.metrics);
    expect(compared.savedRuns).toHaveLength(2);
    expect(compared.savedRuns.find(({ runId }) => runId === initial.runId)?.compatible).toBe(true);
    expect(reset).toEqual(initial);
    expect(compared.reproducibility.runId).toMatch(/^demo_/);
    expect(compared).not.toHaveProperty("chatEvidence");
  });
});
