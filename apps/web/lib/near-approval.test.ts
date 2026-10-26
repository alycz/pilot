import { describe, expect, it } from "vitest";

import {
  computeNearApprovalDigest,
  type NearApprovalBinding,
} from "@pilot/contracts";
import { reviewNearIntentsApproval } from "./near-approval";

function binding(
  input: Partial<NearApprovalBinding> = {},
): NearApprovalBinding {
  return {
    version: "pilot-near-1click-approval-v2",
    principal_id: "principal-near-review",
    account_id: "alice.near",
    network: "near:mainnet",
    idempotency_version: "pilot-near-idempotency-v1",
    idempotency_key: "attempt-near-review",
    policy_digest: "A".repeat(64),
    quote_id: "quote-near-review",
    quote_hash: "B".repeat(44),
    provider_signature_verified: true,
    origin_asset: "nep141:input.example",
    destination_asset: "nep141:output.example",
    amount_in: "100",
    min_amount_out: "90",
    recipient: "recipient.near",
    refund_to: "refund.near",
    deposit_address: "provider-deposit-address",
    deposit_memo: "provider-routing-memo",
    approval_expires_at: "2099-01-02T00:00:00.000Z",
    provider_deadline_at: "2099-01-03T00:00:00.000Z",
    ...input,
  };
}

describe("NEAR approval review model", () => {
  it("is review-only when runtime signing remains disabled", async () => {
    const exact = binding();
    const review = await reviewNearIntentsApproval({
      binding: exact,
      approvalDigest: await computeNearApprovalDigest(exact),
      now: Date.parse("2098-01-01T00:00:00.000Z"),
    });
    expect(review.readiness).toBe("signing-disabled");
    expect(review.canSign).toBe(false);
    expect(review.rows).toContainEqual({
      label: "Principal",
      value: "principal-near-review",
      exact: true,
    });
    expect(review.rows).toContainEqual({
      label: "Wallet account",
      value: "alice.near",
      exact: true,
    });
    expect(review.rows.find((row) => row.label.startsWith("Provider deposit memo")))
      .toEqual(expect.objectContaining({ value: "provider-routing-memo" }));
  });

  it("becomes ready only with an exact digest and explicit enablement", async () => {
    const exact = binding();
    const review = await reviewNearIntentsApproval({
      binding: exact,
      approvalDigest: await computeNearApprovalDigest(exact),
      signingEnabled: true,
      now: Date.parse("2098-01-01T00:00:00.000Z"),
    });
    expect(review).toEqual(expect.objectContaining({
      readiness: "ready",
      canSign: true,
    }));
  });

  it("fails closed when any reviewed field changes after digesting", async () => {
    const exact = binding();
    const digest = await computeNearApprovalDigest(exact);
    const review = await reviewNearIntentsApproval({
      binding: {
        ...exact,
        refund_to: "mallory.near",
      },
      approvalDigest: digest,
      signingEnabled: true,
    });
    expect(review.readiness).toBe("digest-mismatch");
    expect(review.canSign).toBe(false);
  });

  it("labels the provider deadline as refund timing rather than quote expiry", async () => {
    const exact = binding();
    const review = await reviewNearIntentsApproval({
      binding: exact,
      approvalDigest: await computeNearApprovalDigest(exact),
      signingEnabled: true,
      now: Date.parse("2099-01-03T00:00:00.000Z"),
    });
    expect(review.readiness).toBe("provider-refund-window-started");
    expect(review.rows.some((row) =>
      row.label === "Provider refund processing begins after"
    )).toBe(true);
  });
});

