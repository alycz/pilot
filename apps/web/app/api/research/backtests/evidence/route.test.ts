import { describe, expect, it } from "vitest";

import { createReproducibilityReport } from "../../../../../components/backtests/runs";
import { reportInput } from "../../../../../components/backtests/runs/test-fixtures";

import { POST } from "./route";

function savedEvidenceRequest() {
  const report = createReproducibilityReport(reportInput());
  return {
    reference: {
      version: "v1",
      runId: report.runId,
      resultFingerprint: report.result.resultFingerprintSha256,
      datasetNormalizedHash: report.dataset.normalizedHashSha256,
      strategyVersion: report.strategy.strategyVersion,
    },
    savedRun: {
      scope: "local_research_only",
      label: "Verified local run",
      savedAt: "2026-10-24T12:00:00.000Z",
      report,
    },
  };
}

describe("saved backtest evidence verification API", () => {
  it("revalidates the full report before returning research-only context", async () => {
    const response = await POST(new Request("http://local/api/research/backtests/evidence", {
      method: "POST",
      body: JSON.stringify(savedEvidenceRequest()),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toMatchObject({
      kind: "saved_backtest_research_evidence",
      authority: "research_only",
      dataset: {
        sourceKind: "saved_historical_report",
        sourceDisclosure: expect.stringMatching(/client-supplied.*not refetched.*research evidence.*not executable liquidity/i),
      },
      disclosure: expect.stringMatching(/not .*permission.*approval.*transaction/i),
    });
  });

  it("fails closed on report tampering or mismatched references", async () => {
    const tampered = structuredClone(savedEvidenceRequest());
    tampered.savedRun.report.result.outOfSample.endingEquityQuote = "999999";
    const tamperedResponse = await POST(new Request("http://local/api/research/backtests/evidence", {
      method: "POST",
      body: JSON.stringify(tampered),
    }));
    expect(tamperedResponse.status).toBe(400);

    const mismatched = savedEvidenceRequest();
    mismatched.reference.resultFingerprint = "f".repeat(64);
    const mismatchResponse = await POST(new Request("http://local/api/research/backtests/evidence", {
      method: "POST",
      body: JSON.stringify(mismatched),
    }));
    expect(mismatchResponse.status).toBe(400);
  });
});
