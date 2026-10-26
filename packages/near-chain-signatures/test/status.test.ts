import { describe, expect, it } from "vitest";

import { classifyNearSignatureStatus } from "../src/index.js";

const BINDING = "exact-review-binding";

describe("Chain Signatures status boundaries", () => {
  it.each([
    [
      { kind: "not-requested" } as const,
      ["approval-required", "not-submitted", "not-requested"],
    ],
    [
      { kind: "wallet-pending", reviewBinding: BINDING } as const,
      ["wallet-pending", "not-submitted", "pending"],
    ],
    [
      {
        kind: "near-transaction-submitted",
        reviewBinding: BINDING,
        nearTransactionHash: "near-hash",
      } as const,
      ["near-pending", "pending", "pending"],
    ],
    [
      {
        kind: "signature-returned",
        reviewBinding: BINDING,
        nearTransactionHash: "near-hash",
        signatureCount: 1,
      } as const,
      ["signature-ready", "final-success", "ready"],
    ],
    [
      {
        kind: "near-final-failure",
        reviewBinding: BINDING,
        nearTransactionHash: "near-hash",
        errorCode: "FunctionCallError",
      } as const,
      ["failed", "final-failure", "failed"],
    ],
    [
      { kind: "outcome-unknown", reason: "timeout" } as const,
      ["unknown", "unknown", "unknown"],
    ],
  ])("classifies $kind without claiming external effects", (observation, expected) => {
    const result = classifyNearSignatureStatus(observation, BINDING);
    expect([
      result.stage,
      result.nearTransactionStatus,
      result.signatureStatus,
    ]).toEqual(expected);
    expect(result.xrpSubmissionStatus).toBe("not-submitted");
    expect(result.externalStateStatus).toBe("not-validated");
  });

  it("does not treat NEAR success without a returned signature as ready", () => {
    expect(
      classifyNearSignatureStatus(
        {
          kind: "near-final-success-no-signature",
          reviewBinding: BINDING,
          nearTransactionHash: "near-hash",
        },
        BINDING,
      ),
    ).toMatchObject({
      stage: "unknown",
      nearTransactionStatus: "final-success",
      signatureStatus: "unknown",
      xrpSubmissionStatus: "not-submitted",
      externalStateStatus: "not-validated",
    });
  });

  it("fails closed on binding mismatch or an unexpected signature count", () => {
    expect(
      classifyNearSignatureStatus(
        {
          kind: "signature-returned",
          reviewBinding: "other",
          nearTransactionHash: "near-hash",
          signatureCount: 1,
        },
        BINDING,
      ).stage,
    ).toBe("unknown");
    expect(
      classifyNearSignatureStatus(
        {
          kind: "signature-returned",
          reviewBinding: BINDING,
          nearTransactionHash: "near-hash",
          signatureCount: 2,
        },
        BINDING,
      ).signatureStatus,
    ).toBe("unknown");
  });

  it("requires correlation and rejects empty transaction hashes", () => {
    expect(() =>
      classifyNearSignatureStatus({ kind: "not-requested" }, ""),
    ).toThrow("expectedReviewBinding is required");
    expect(
      classifyNearSignatureStatus(
        {
          kind: "signature-returned",
          reviewBinding: BINDING,
          nearTransactionHash: " ",
          signatureCount: 1,
        },
        BINDING,
      ).stage,
    ).toBe("unknown");
  });
});
