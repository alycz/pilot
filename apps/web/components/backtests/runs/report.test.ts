import { describe, expect, it } from "vitest";

import {
  createReproducibilityReport,
  sha256Fingerprint,
  verifyReproducibilityReport,
} from "./report";
import { reportInput } from "./test-fixtures";

describe("reproducibility reports", () => {
  it("creates deterministic immutable run and evidence fingerprints", () => {
    const first = createReproducibilityReport(reportInput());
    const reordered = reportInput({
      strategy: {
        strategyId: "allocation-band",
        strategyVersion: "allocation-band.v1",
        parameters: { maxTradeQuote: "25.00", bandBps: 500, targetBaseBps: 5_000 },
      },
    });
    const second = createReproducibilityReport(reordered);

    expect(first).toEqual(second);
    expect(first.runId).toMatch(/^bt_[a-f0-9]{24}$/);
    expect(first.strategy.parameterFingerprintSha256).toBe(
      sha256Fingerprint(first.strategy.parameters),
    );
    expect(first.result.resultFingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.dataset.coverage)).toBe(true);
  });

  it("rejects result and metadata tampering", () => {
    const report = createReproducibilityReport(reportInput());
    const changedResult = structuredClone(report);
    changedResult.result.outOfSample.endingEquityQuote = "999999";
    expect(() => verifyReproducibilityReport(changedResult)).toThrow(/result fingerprint/);

    const changedSource = structuredClone(report);
    changedSource.dataset.sourceLabel = "Unreviewed replacement";
    expect(() => verifyReproducibilityReport(changedSource)).toThrow(/run identifier/);

    const changedEngineOutput = structuredClone(report);
    changedEngineOutput.result.engineOutputHashSha256 = "d".repeat(64);
    expect(() => verifyReproducibilityReport(changedEngineOutput)).toThrow(/result fingerprint/);
  });

  it("binds equal aggregate metrics to distinct complete engine outputs", () => {
    const first = createReproducibilityReport(reportInput());
    const secondInput = reportInput();
    secondInput.result.engineOutputHashSha256 = "d".repeat(64);
    const second = createReproducibilityReport(secondInput);
    expect(second.result.full).toEqual(first.result.full);
    expect(second.result.outOfSample).toEqual(first.result.outOfSample);
    expect(second.result.resultFingerprintSha256).not.toBe(first.result.resultFingerprintSha256);
    expect(second.runId).not.toBe(first.runId);
  });

  it("rejects wallet/account identifiers in generic parameter fields and free text", () => {
    const privateField = reportInput({
      strategy: {
        strategyId: "allocation-band",
        strategyVersion: "allocation-band.v1",
        parameters: { walletAddress: "not-allowed" },
      },
    });
    expect(() => createReproducibilityReport(privateField)).toThrow(/not permitted/);

    const addressText = reportInput();
    addressText.study.hypothesis.statement =
      "Test the balance of rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh.";
    expect(() => createReproducibilityReport(addressText)).toThrow(/wallet address/);
  });
});
