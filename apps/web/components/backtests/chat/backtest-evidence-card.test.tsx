import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BacktestEvidenceCard,
  backtestExplanationDraft,
  type BacktestEvidenceCardState,
} from "./backtest-evidence-card";
import { RESEARCH_ONLY_DISCLOSURE, type BacktestChatEvidenceContext } from "./evidence-reference";

const evidence: BacktestChatEvidenceContext = {
  kind: "saved_backtest_research_evidence",
  authority: "research_only",
  reference: {
    version: "v1",
    runId: "bt_01K8E7X9P5R4M2N6",
    resultFingerprint: "a".repeat(64),
    datasetNormalizedHash: "b".repeat(64),
    strategyVersion: "allocation-band.v1",
  },
  dataset: {
    label: "Kraken XRP/USD daily bars",
    sourceKind: "validated_historical",
    sourceDisclosure: "Public market-level spot bars; not historical XRPL DEX liquidity.",
    startDate: "2025-01-01",
    endDate: "2026-09-30",
  },
  result: {
    quoteSymbol: "USD",
    strategyReturnBps: "125.25",
    benchmarkReturnBps: "98.10",
    maxDrawdownBps: "840.50",
    endingEquityQuote: "10125.25",
    totalCostsQuote: "42.125",
    tradeCount: 9,
  },
  disclosure: RESEARCH_ONLY_DISCLOSURE,
};

describe("BacktestEvidenceCard", () => {
  it("shows exact saved evidence with an explicit research-only boundary", () => {
    const markup = renderToStaticMarkup(<BacktestEvidenceCard state={{ kind: "ready", evidence }} />);

    for (const text of [
      "Saved backtest · research only",
      "Kraken XRP/USD daily bars",
      "+125.25 bps",
      "+98.10 bps",
      "-840.50 bps",
      "10125.25 USD",
      "42.125 USD",
      "Public market-level spot bars",
      RESEARCH_ONLY_DISCLOSURE,
      "Copy explanation draft",
    ]) expect(markup).toContain(text);
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("rounded-xl");
    expect(markup).toContain("rounded-md");
    expect(markup).toContain("motion-reduce:transition-none");
    expect(markup).not.toMatch(/Build transaction|Approve trade|Submit trade|Connect wallet/i);
  });

  it.each([
    [{ kind: "unavailable", reason: "This run is not saved in this browser session." }, "unavailable"],
    [{ kind: "error", reason: "The evidence reference does not match the saved run." }, "invalid"],
  ] as const)("fails closed for a %s state", (state, label) => {
    const markup = renderToStaticMarkup(<BacktestEvidenceCard state={state as BacktestEvidenceCardState} />);
    expect(markup).toContain(`Backtest evidence · ${label}`);
    expect(markup).toContain(state.reason);
    expect(markup).toContain("Nothing was prepared, approved, or submitted");
    expect(markup).not.toContain("Strategy return");
  });

  it("builds a bounded explanation request without execution authority", () => {
    const draft = backtestExplanationDraft(evidence);
    expect(draft).toContain("Explain this saved deterministic backtest as research evidence only");
    expect(draft).toContain("Discuss assumptions, cost sensitivity, dataset limits");
    expect(draft).toContain("Do not treat this run as a live quote");
    expect(draft.length).toBeLessThan(1_200);
    expect(draft).not.toMatch(/build|sign|submit|execute this|guaranteed profit/i);
  });
});
