import { describe, expect, it } from "vitest";

import { BacktestRunBundleSchema } from "./contracts";
import { INITIAL_DRAFT, requestFromDraft } from "./backtests-client";
import { clientBundle } from "./test-fixture";

describe("backtest client contracts", () => {
  it("accepts the frozen 638-day request and rejects oversized windows", () => {
    expect(requestFromDraft(INITIAL_DRAFT)).toMatchObject({
      startDay: "2025-01-01",
      endDay: "2026-09-30",
      targetBaseBps: 5_000,
    });
    expect(() => requestFromDraft({ ...INITIAL_DRAFT, startDay: "2024-01-01" })).toThrow(/720 daily buckets/);
  });

  it("requires explicit response version and matching run evidence", () => {
    expect(BacktestRunBundleSchema.parse(clientBundle()).version).toBe(1);
    expect(() => BacktestRunBundleSchema.parse({ ...clientBundle(), version: 2 })).toThrow();
    const mismatched = structuredClone(clientBundle());
    mismatched.chatEvidence.runId = "bt_bbbbbbbbbbbbbbbbbbbbbbbb";
    expect(() => BacktestRunBundleSchema.parse(mismatched)).toThrow(/run identifiers do not match/);
  });

  it("binds every chat summary field to the saved deterministic report", () => {
    const changedMetric = structuredClone(clientBundle());
    changedMetric.chatEvidence.metrics.endingEquityQuote = "999999";
    expect(() => BacktestRunBundleSchema.parse(changedMetric)).toThrow(/ending equity does not match/);

    const changedFingerprint = structuredClone(clientBundle());
    changedFingerprint.savedRun.report = {
      ...(changedFingerprint.savedRun.report as Record<string, unknown>),
      result: {
        ...((changedFingerprint.savedRun.report as Record<string, unknown>).result as Record<string, unknown>),
        resultFingerprintSha256: "c".repeat(64),
      },
    };
    expect(() => BacktestRunBundleSchema.parse(changedFingerprint)).toThrow(/result fingerprint does not match/);
  });
});
