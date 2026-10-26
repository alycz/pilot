import { describe, expect, it, vi } from "vitest";

import type { HarborClient, NearIntentsExecutableQuoteReviewResult } from "@pilot/harbor-client";
import {
  loadLiveNearOwnerFundedReview,
  loadLiveNearOwnerFundedStatus,
  type LiveNearOwnerFundedReview,
} from "./near-owner-funded-preview";

const args = {
  route: "arbitrum-usdc-to-near-wnear-v1" as const,
  amount_atomic: "1000000",
  slippage_bps: 100,
  recipient: "owner.near",
  refund_to: "0x1111111111111111111111111111111111111111",
  refund_deadline: "2027-01-01T00:00:00.000Z",
};

describe("owner-funded NEAR preview boundary", () => {
  it("never promotes an executable-review fixture", async () => {
    const client = { op: vi.fn(async () => ({
      ok: true,
      data: {
        source: "fixture",
        provider_signature_verified: false,
      } as NearIntentsExecutableQuoteReviewResult,
      asOf: "2026-10-26T00:00:00.000Z",
      asOfBasis: "fixture",
    })) } as unknown as Pick<HarborClient, "op">;

    await expect(loadLiveNearOwnerFundedReview(client, args, 0)).rejects.toThrow(/fixture data/);
  });

  it("rejects an expired live review before presenting a funding target", async () => {
    const client = { op: vi.fn(async () => ({
      ok: true,
      data: {
        source: "live",
        provider_signature_verified: true,
        quote_binding: { approval_expires_at: "2026-10-26T00:00:00.000Z" },
      },
      asOf: "2026-10-26T00:00:00.000Z",
      asOfBasis: "provider",
    })) } as unknown as Pick<HarborClient, "op">;

    await expect(loadLiveNearOwnerFundedReview(client, args, Date.parse("2026-10-26T00:00:00.000Z")))
      .rejects.toThrow(/expired/);
  });

  it("binds status lookup to the verified live review and rejects fixture status", async () => {
    const review = {
      source: "live",
      provider_signature_verified: true,
      owner_review: {
        status_lookup: {
          operation: "near.intents.status",
          deposit_address: "0x2222222222222222222222222222222222222222",
          deposit_memo: null,
          expected_correlation_id: "live-correlation",
          expected_quote_hash: "3".repeat(44),
        },
      },
    } as LiveNearOwnerFundedReview;
    const op = vi.fn(async () => ({
      ok: true,
      data: { source: "fixture", signature_verified: false },
      asOf: "2026-10-26T00:00:00.000Z",
      asOfBasis: "fixture",
    }));
    const client = { op } as unknown as Pick<HarborClient, "op">;

    await expect(loadLiveNearOwnerFundedStatus(client, review)).rejects.toThrow(/fixture data/);
    expect(op).toHaveBeenCalledWith("near.intents.status", {
      deposit_address: "0x2222222222222222222222222222222222222222",
      expected_correlation_id: "live-correlation",
      expected_quote_hash: "3".repeat(44),
    });
  });
});
