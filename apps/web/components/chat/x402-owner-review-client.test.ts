import { describe, expect, it, vi } from "vitest";

import {
  requestOwnerReviewedX402,
  type OwnerReviewPublicState,
} from "./x402-owner-review-client";
import {
  X402_APPROVED_RECEIVER,
  X402_MAX_PRICE_DROPS,
} from "./x402-operation-state";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

function state(overrides: Partial<OwnerReviewPublicState> = {}): OwnerReviewPublicState {
  return {
    status: "awaiting_approval",
    approval_id: "owner-review-approval-0001",
    approval_digest: "A".repeat(64),
    idempotency_key: "owner-review-operation-0001",
    owner: OWNER,
    network: "testnet",
    resource_url: "http://127.0.0.1:8000/api/x402/compare",
    pay_to: X402_APPROVED_RECEIVER,
    asset: "XRP",
    amount_drops: X402_MAX_PRICE_DROPS,
    quote_expires_at: "2026-10-24T12:05:00.000Z",
    validated_ledger_index: 1_000,
    validated_account_sequence: 7,
    expected_source_tag: 2_610_240,
    tx_json: {
      TransactionType: "Payment",
      Account: OWNER,
      Destination: X402_APPROVED_RECEIVER,
      Amount: X402_MAX_PRICE_DROPS,
      Fee: "12",
      Sequence: 7,
      LastLedgerSequence: 1_015,
      SourceTag: 2_610_240,
      InvoiceID: "B".repeat(64),
    },
    ...overrides,
  };
}

describe("owner-reviewed x402 browser client", () => {
  it("uses only the fixed same-origin prepare route and exact request body", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      ok: true,
      data: state(),
      asOf: "2026-10-24T12:00:00.000Z",
      asOfBasis: "local-mock-owner-review",
    }));
    await expect(requestOwnerReviewedX402({
      action: "prepare",
      args: {
        owner: OWNER,
        network: "testnet",
        max_price_drops: X402_MAX_PRICE_DROPS,
        idempotency_key: "owner-review-operation-0001",
      },
    }, fetchImpl as typeof fetch)).resolves.toMatchObject({ status: "awaiting_approval" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/harbor/x402.ownerReviewPrepare",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          owner: OWNER,
          network: "testnet",
          max_price_drops: X402_MAX_PRICE_DROPS,
          idempotency_key: "owner-review-operation-0001",
        }),
      }),
    );
  });

  it.each([
    ["merchant", { pay_to: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" }],
    ["asset", { asset: "RLUSD" }],
    ["amount", { amount_drops: "5001" }],
    ["receipt", { status: "delivered", receipt: undefined }],
  ])("rejects an untrusted %s response", async (_label, change) => {
    const fetchImpl = vi.fn(async () => Response.json({
      ok: true,
      data: state(change as never),
      asOf: "2026-10-24T12:00:00.000Z",
      asOfBasis: "local-mock-owner-review",
    }));
    await expect(requestOwnerReviewedX402({
      action: "recover",
      args: {
        owner: OWNER,
        network: "testnet",
        idempotency_key: "owner-review-operation-0001",
        approval_id: "owner-review-approval-0001",
      },
    }, fetchImpl as typeof fetch)).rejects.toThrow(/invalid|rejected/i);
  });

  it("accepts a delivered receipt only with explicit local mock settlement provenance", async () => {
    const txHash = "C".repeat(64);
    const delivered = state({
      status: "delivered",
      tx_hash: txHash,
      receipt: {
        status: "delivered",
        simulation: true,
        approval_id: "owner-review-approval-0001",
        idempotency_key: "owner-review-operation-0001",
        owner: OWNER,
        network: "testnet",
        resource_url: "http://127.0.0.1:8000/api/x402/compare",
        pay_to: X402_APPROVED_RECEIVER,
        asset: "XRP",
        amount_drops: X402_MAX_PRICE_DROPS,
        tx_hash: txHash,
        validated_ledger_index: 1_014,
        body: { comparison: ["dex", "amm"] },
        provenance: "local-mock-simulated-settlement",
      },
    });
    const fetchImpl = vi.fn(async () => Response.json({
      ok: true,
      data: delivered,
      asOf: "2026-10-24T12:00:00.000Z",
      asOfBasis: "local-mock-owner-review",
    }));
    await expect(requestOwnerReviewedX402({
      action: "recover",
      args: {
        owner: OWNER,
        network: "testnet",
        idempotency_key: "owner-review-operation-0001",
        approval_id: "owner-review-approval-0001",
      },
    }, fetchImpl as typeof fetch)).resolves.toMatchObject({
      status: "delivered",
      receipt: { simulation: true, provenance: "local-mock-simulated-settlement" },
    });
  });

  it("returns only the bounded upstream error message", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      ok: false,
      error: {
        service: "x402.ownerReviewReject",
        kind: "error",
        message: "Owner review is disabled",
        code: "OWNER_REVIEW_DISABLED",
      },
    }, { status: 503 }));
    await expect(requestOwnerReviewedX402({
      action: "reject",
      args: {
        owner: OWNER,
        network: "testnet",
        idempotency_key: "owner-review-operation-0001",
        approval_id: "owner-review-approval-0001",
      },
    }, fetchImpl as typeof fetch)).rejects.toThrow("Owner review is disabled");
  });

  it("preserves only the bounded error code needed for safe missing-approval recovery", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      ok: false,
      error: {
        service: "x402.ownerReviewRecover",
        kind: "error",
        message: "APPROVAL_NOT_FOUND",
        code: "APPROVAL_NOT_FOUND",
      },
    }, { status: 200 }));
    await expect(requestOwnerReviewedX402({
      action: "recover",
      args: {
        owner: OWNER,
        network: "testnet",
        idempotency_key: "owner-review-operation-0001",
        approval_id: "owner-review-approval-0001",
      },
    }, fetchImpl as typeof fetch)).rejects.toMatchObject({
      name: "OwnerReviewRequestError",
      code: "APPROVAL_NOT_FOUND",
      message: "APPROVAL_NOT_FOUND",
    });
  });
});
