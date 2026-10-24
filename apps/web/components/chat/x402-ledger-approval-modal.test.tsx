import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { OwnerReviewedX402ApprovalModal } from "./x402-ledger-approval-modal";
import type { BoundOwnerReviewedX402Approval } from "./x402-ledger-approval";

const RECEIVER = "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr";
vi.stubGlobal("React", React);

function bound(): BoundOwnerReviewedX402Approval {
  return {
    approvalDigest: "A".repeat(64),
    provenanceNotice: "Speculos simulation with its public default test seed; no physical Ledger is claimed.",
    review: {
      action: "payment",
      network: "testnet",
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      signingMode: "clear",
      digest: "b".repeat(64),
      provenance: {
        runtime: "speculos",
        signatureEvidence: "signing-key-control-only",
        physicalDeviceInferred: false,
        emulator: true,
      },
      approvalExpiresAtMs: Date.now() + 60_000,
      quoteExpiresAtMs: Date.now() + 60_000,
    },
    request: {
      approvalId: "owner-review-approval-001",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      txJson: {
        TransactionType: "Payment",
        Account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        Destination: RECEIVER,
        Amount: "5000",
        Fee: "12",
      },
      summary: {
        action: "Pay the reviewed local comparison merchant",
        amounts: ["0.005 XRP"],
        destination: RECEIVER,
        feeDrops: "12",
        network: "testnet",
      },
    },
  };
}

describe("owner-reviewed x402 approval modal", () => {
  it("shows the exact payment terms and simulated-device provenance", () => {
    const html = renderToStaticMarkup(
      <OwnerReviewedX402ApprovalModal
        open
        bound={bound()}
        wallet={{ signOnly: vi.fn() }}
        accountIndex={0}
        deviceReady
        deviceState={{ interaction: "none", busy: false }}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toContain("Pay the reviewed local comparison merchant");
    expect(html).toContain("0.005 XRP");
    expect(html).toContain(RECEIVER);
    expect(html).toContain("testnet");
    expect(html).toContain("Speculos simulation");
    expect(html).toContain("no physical Ledger");
    expect(html).not.toContain("RLUSD");
  });

  it("renders nothing while closed", () => {
    const html = renderToStaticMarkup(
      <OwnerReviewedX402ApprovalModal
        open={false}
        bound={bound()}
        wallet={{ signOnly: vi.fn() }}
        accountIndex={0}
        deviceReady={false}
        deviceState={{ interaction: "none", busy: false }}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toBe("");
  });
});
