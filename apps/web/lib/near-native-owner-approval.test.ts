import { describe, expect, it } from "vitest";

import {
  createNearNativeOwnerApprovalFixture,
  reviewNearNativeOwnerApproval,
} from "./near-native-owner-approval";

describe("native NEAR owner approval review", () => {
  it("builds an exact quote-bound fixture while keeping every action non-live", async () => {
    const review = await createNearNativeOwnerApprovalFixture();

    expect(review.readiness).toBe("fixture-only");
    expect(review.canRequestWalletControl).toBe(false);
    expect(review.canConfirmEconomicApproval).toBe(false);
    expect(review.envelope?.approval_digest).toMatch(/^[A-F0-9]{64}$/);
    expect(review.approvalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "NEP-413 challenge nonce" }),
      expect.objectContaining({ label: "Network", value: "near:mainnet" }),
      expect.objectContaining({ label: "Source account", value: "owner-demo.near" }),
      expect.objectContaining({ label: "Economic approval expires" }),
      expect.objectContaining({ label: "Approval digest", value: review.envelope?.approval_digest }),
    ]));
    expect(review.fundingRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Transfer asset", value: "Native NEAR · not a wNEAR token transfer" }),
      expect.objectContaining({ label: "Memo", value: "None · do not add one" }),
    ]));
  });

  it("rejects a quote changed after the economic digest was created", async () => {
    const fixture = await createNearNativeOwnerApprovalFixture();
    const quote = structuredClone(fixture.quote!);
    quote.min_amount_out = "4900001";

    const review = await reviewNearNativeOwnerApproval({
      provenance: "live",
      quote,
      envelope: fixture.envelope,
      challenge: fixture.challenge,
      now: Date.parse("2099-01-01T00:02:00.000Z"),
    });

    expect(review.readiness).toBe("invalid");
    expect(review.canRequestWalletControl).toBe(false);
    expect(review.canConfirmEconomicApproval).toBe(false);
  });

  it("rejects a cross-account wallet-control challenge", async () => {
    const fixture = await createNearNativeOwnerApprovalFixture();
    const challenge = { ...fixture.challenge!, account_id: "mallory.near" };

    const review = await reviewNearNativeOwnerApproval({
      provenance: "live",
      quote: fixture.quote,
      envelope: fixture.envelope,
      challenge,
      now: Date.parse("2099-01-01T00:02:00.000Z"),
    });

    expect(review.readiness).toBe("invalid");
    expect(review.notice).toContain("does not bind the exact verified quote");
  });

  it("expires the challenge and economic approval fail closed", async () => {
    const fixture = await createNearNativeOwnerApprovalFixture();
    const review = await reviewNearNativeOwnerApproval({
      provenance: "live",
      quote: fixture.quote,
      envelope: fixture.envelope,
      challenge: fixture.challenge,
      now: Date.parse("2099-01-01T00:07:00.000Z"),
    });

    expect(review.readiness).toBe("expired");
    expect(review.canRequestWalletControl).toBe(false);
    expect(review.canConfirmEconomicApproval).toBe(false);
  });
});

