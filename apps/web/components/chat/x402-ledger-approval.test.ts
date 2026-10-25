import { describe, expect, it } from "vitest";

import {
  X402_APPROVED_RECEIVER,
  X402_MAX_PRICE_DROPS,
  X402_RESOURCE,
} from "./x402-operation-state";
import {
  bindOwnerReviewedX402Approval,
  type OwnerReviewedX402Approval,
} from "./x402-ledger-approval";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const NOW = Date.parse("2026-10-24T12:00:00.000Z");

function approval(overrides: Partial<OwnerReviewedX402Approval> = {}): OwnerReviewedX402Approval {
  return {
    approvalId: "owner-review-approval-001",
    approvalDigest: "A".repeat(64),
    owner: OWNER,
    network: "testnet",
    resource: X402_RESOURCE,
    asset: "XRP",
    amountDrops: X402_MAX_PRICE_DROPS,
    payTo: X402_APPROVED_RECEIVER,
    quoteExpiresAt: "2026-10-24T12:01:00.000Z",
    txJson: {
      TransactionType: "Payment",
      Account: OWNER,
      Destination: X402_APPROVED_RECEIVER,
      Amount: X402_MAX_PRICE_DROPS,
      InvoiceID: "B".repeat(64),
      SourceTag: 2_610_240,
      Fee: "12",
      Sequence: 7,
      LastLedgerSequence: 1_015,
    },
    ...overrides,
  };
}

const context = {
  connectedAccount: OWNER,
  validatedLedgerIndex: 1_000,
  validatedAccountSequence: 7,
  expectedSourceTag: 2_610_240,
  runtime: "speculos" as const,
  now: NOW,
};

describe("owner-reviewed x402 Ledger approval binding", () => {
  it("renders the actual clear-sign Payment terms and honest Speculos provenance", async () => {
    const bound = await bindOwnerReviewedX402Approval({ approval: approval(), ...context });
    expect(bound.request).toMatchObject({
      approvalId: "owner-review-approval-001",
      summary: {
        action: "Pay the reviewed local comparison merchant",
        amounts: ["0.005 XRP"],
        destination: X402_APPROVED_RECEIVER,
        feeDrops: "12",
        network: "testnet",
      },
    });
    expect(bound.review).toMatchObject({ signingMode: "clear", action: "payment" });
    expect(bound.provenanceNotice).toMatch(/Speculos simulation/);
    expect(bound.provenanceNotice).toMatch(/no physical Ledger/i);
  });

  it.each([
    ["owner", { owner: X402_APPROVED_RECEIVER }],
    ["asset", { asset: "RLUSD" }],
    ["amount", { amountDrops: "5001" }],
    ["receiver", { payTo: OWNER }],
    ["network", { network: "devnet" }],
  ])("rejects changed trusted offer %s", async (_label, changed) => {
    await expect(bindOwnerReviewedX402Approval({
      approval: approval(changed as never),
      ...context,
    })).rejects.toThrow(/trusted native-XRP scope/i);
  });

  it.each([
    ["account", { Account: X402_APPROVED_RECEIVER }],
    ["destination", { Destination: OWNER }],
    ["amount", { Amount: "5001" }],
    ["invoice shape", { InvoiceID: "C".repeat(62) }],
    ["source tag", { SourceTag: 2_610_241 }],
    ["fee", { Fee: "101" }],
    ["sequence", { Sequence: 8 }],
    ["ledger window", { LastLedgerSequence: 1_021 }],
    ["arbitrary path", { Paths: [] }],
  ])("rejects Payment %s drift", async (_label, change) => {
    const candidate = approval({
      txJson: { ...approval().txJson, ...change },
    });
    await expect(bindOwnerReviewedX402Approval({ approval: candidate, ...context })).rejects.toThrow();
  });

  it("rejects expiry, account changes, and any blind-sign fallback", async () => {
    await expect(bindOwnerReviewedX402Approval({
      approval: approval({ quoteExpiresAt: new Date(NOW).toISOString() }),
      ...context,
    })).rejects.toThrow(/stale/i);
    await expect(bindOwnerReviewedX402Approval({
      approval: approval(),
      ...context,
      connectedAccount: X402_APPROVED_RECEIVER,
    })).rejects.toThrow(/trusted native-XRP scope/i);
    await expect(bindOwnerReviewedX402Approval({
      approval: approval({ txJson: { ...approval().txJson, Flags: 1 } }),
      ...context,
    })).rejects.toThrow();
  });
});
