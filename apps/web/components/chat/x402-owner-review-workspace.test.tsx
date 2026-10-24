import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  clearMissingOwnerReviewRecovery,
  ownerReviewApprovalFromState,
  restoreOwnerReviewRecovery,
  X402OwnerReviewWorkspace,
} from "./x402-owner-review-workspace";
import { OwnerReviewRequestError } from "./x402-owner-review-client";
import { X402_APPROVED_RECEIVER } from "./x402-operation-state";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

describe("owner-reviewed x402 workspace", () => {
  it("mounts an honest default-off native-XRP review surface", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(<X402OwnerReviewWorkspace />);
    expect(html).toContain("Ledger owner-reviewed x402");
    expect(html).toContain("Review the actual payment");
    expect(html).toContain("0.005 XRP");
    expect(html).toContain(X402_APPROVED_RECEIVER);
    expect(html).toContain("Default off");
    expect(html).toContain("Speculos is simulation");
  });

  it("converts only an awaiting exact approval", () => {
    expect(ownerReviewApprovalFromState({
      status: "awaiting_approval",
      approval_id: "owner-review-approval-0001",
      approval_digest: "A".repeat(64),
      idempotency_key: "owner-review-operation-0001",
      owner: OWNER,
      network: "testnet",
      resource_url: "http://127.0.0.1:8000/api/x402/compare",
      pay_to: X402_APPROVED_RECEIVER,
      asset: "XRP",
      amount_drops: "5000",
      quote_expires_at: "2026-10-24T12:05:00.000Z",
      validated_ledger_index: 1_000,
      validated_account_sequence: 7,
      expected_source_tag: 2_610_240,
      tx_json: { TransactionType: "Payment" },
    })).toMatchObject({
      approvalId: "owner-review-approval-0001",
      resource: "compare",
      amountDrops: "5000",
      payTo: X402_APPROVED_RECEIVER,
    });
    expect(() => ownerReviewApprovalFromState({ status: "expired" } as never)).toThrow(/not awaiting/i);
  });

  it("restores only a schema-valid recovery record for the authenticated owner", () => {
    const saved = {
      status: "settlement_unknown",
      approval_id: "owner-review-approval-0001",
      approval_digest: "A".repeat(64),
      idempotency_key: "owner-review-operation-0001",
      owner: OWNER,
      network: "testnet",
      resource_url: "http://127.0.0.1:8000/api/x402/compare",
      pay_to: X402_APPROVED_RECEIVER,
      asset: "XRP",
      amount_drops: "5000",
      quote_expires_at: "2026-10-24T12:05:00.000Z",
      validated_ledger_index: 1_000,
      validated_account_sequence: 7,
      expected_source_tag: 2_610_240,
      tx_hash: "B".repeat(64),
    };
    expect(restoreOwnerReviewRecovery(JSON.stringify(saved), OWNER))
      .toMatchObject({ status: "settlement_unknown", tx_hash: "B".repeat(64) });
    expect(restoreOwnerReviewRecovery(JSON.stringify(saved), "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"))
      .toBeUndefined();
    expect(restoreOwnerReviewRecovery('{"status":"settlement_unknown"}', OWNER))
      .toBeUndefined();
  });

  it("clears a missing approval only before any submit-capable state", () => {
    const storage = { removeItem: vi.fn() };
    const missing = new OwnerReviewRequestError("APPROVAL_NOT_FOUND", "APPROVAL_NOT_FOUND");
    expect(clearMissingOwnerReviewRecovery(storage, missing, { status: "awaiting_approval" }))
      .toBe(true);
    expect(storage.removeItem).toHaveBeenCalledWith("pilot:ledger-x402-owner-review:v1");

    storage.removeItem.mockClear();
    for (const status of ["signed", "relaying", "settlement_unknown", "settled", "delivering"] as const) {
      expect(clearMissingOwnerReviewRecovery(storage, missing, { status })).toBe(false);
    }
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(clearMissingOwnerReviewRecovery(
      storage,
      new OwnerReviewRequestError("APPROVAL_BINDING_MISMATCH", "mismatch"),
      { status: "awaiting_approval" },
    )).toBe(false);
  });
});
