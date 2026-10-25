import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CapabilityProofAttempt,
  LedgerCapabilityApprovalModal,
  isCapabilityReviewExpired,
} from "./ledger-capability-approval-modal";
import type { CapabilityGrant, CapabilityOwnerReview } from "./ledger-capability-client";
import {
  bindCapabilityOwnerReview,
  exactCapabilityProofTransaction,
} from "./ledger-capability-review";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const REF = `cap_v1_${"A".repeat(43)}`;
const modalSource = readFileSync(
  new URL("./ledger-capability-approval-modal.tsx", import.meta.url),
  "utf8",
);

function grant(): CapabilityGrant {
  return {
    capabilityRef: REF,
    principal: "pilot-browser",
    account: OWNER,
    network: "testnet",
    service: "mock.catalog",
    operation: "read",
    amount: { unit: "request", value: "1" },
    destination: "local-fixture-catalog",
    notBefore: "2099-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:10:00.000Z",
    maxUses: 3,
    uses: 0,
    rateLimit: { windowSeconds: 60, maxCalls: 3 },
    generation: 1,
    state: "prepared",
    approvalDigest: "a".repeat(64),
  };
}

function review(overrides: Partial<CapabilityOwnerReview> = {}): CapabilityOwnerReview {
  const candidate: CapabilityOwnerReview = {
    action: "activate",
    capability_ref: REF,
    network: "testnet",
    generation: 1,
    approval_digest: "a".repeat(64),
    nonce: "N".repeat(32),
    approved_at: "2099-01-01T00:00:00.000Z",
    expires_at: "2099-01-01T00:01:00.000Z",
    tx_json: {
      TransactionType: "AccountSet",
      Account: OWNER,
      Sequence: 0,
      Fee: "0",
      LastLedgerSequence: 0,
      Memos: [{ Memo: { MemoType: "AA", MemoData: "BB" } }],
    },
    verification_boundary: {
      signature_proves: "owner-key-control-only",
      runtime_provenance: "not-authenticated-by-signed-blob",
      physical_device_inferred: false,
    },
    ...overrides,
  };
  return {
    ...candidate,
    tx_json: overrides.tx_json ?? exactCapabilityProofTransaction(candidate, OWNER) as CapabilityOwnerReview["tx_json"],
  };
}

describe("Ledger capability approval", () => {
  it("renders exact scope, no-broadcast semantics, rejection, and honest provenance", async () => {
    const bound = await bindCapabilityOwnerReview(
      review(),
      grant(),
      new Date("2099-01-01T00:00:30.000Z"),
    );
    const html = renderToStaticMarkup(
      <LedgerCapabilityApprovalModal
        accountIndex={0}
        bound={bound}
        deviceReady
        deviceState={{ interaction: "none", busy: false }}
        onClose={() => undefined}
        onSubmit={async () => undefined}
        open
        wallet={{ signOnly: async () => "AA" }}
      />,
    );
    expect(html).toContain("mock.catalog / read");
    expect(html).toContain("1 request");
    expect(html).toContain("never broadcast");
    expect(html).toContain("does not prove a physical Ledger");
    expect(html).toContain("no fallback");
    expect(html).toContain("Reject capability review");
    expect(html).toContain("font-serif");
    expect(html).toContain("min-h-11");
    expect(html).toContain("focus-visible:ring-2");
    expect(modalSource).not.toMatch(
      /(?:slate|amber|emerald|red)-|bg-white|bg-slate-950|#(?:f3f1ea|171814|235a52)/,
    );
  });

  it("reuses one in-memory signature after an uncertain activation response", async () => {
    const attempt = new CapabilityProofAttempt();
    const signOnly = vi.fn(async () => "AABB");
    const submit = vi.fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(undefined);
    await expect(attempt.run({ review: review(), wallet: { signOnly }, submit }))
      .rejects.toThrow("response lost");
    expect(attempt.hasSignedBlob).toBe(true);
    await expect(attempt.run({ review: review(), wallet: { signOnly }, submit }))
      .resolves.toBeUndefined();
    expect(signOnly).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]?.[0]).toEqual(submit.mock.calls[1]?.[0]);
  });

  it("rejects expiry and unsupported blind-sign shapes without opening the wallet", async () => {
    const expired = review({ expires_at: "2000-01-01T00:00:00.000Z" });
    expect(isCapabilityReviewExpired(expired)).toBe(true);
    const signOnly = vi.fn(async () => "AA");
    await expect(new CapabilityProofAttempt().run({
      review: expired,
      wallet: { signOnly },
      submit: async () => undefined,
    })).rejects.toThrow(/expired/i);
    expect(signOnly).not.toHaveBeenCalled();

    const unsupported = review({
      tx_json: { ...review().tx_json, TransactionType: "Payment" } as never,
    });
    await expect(bindCapabilityOwnerReview(
      unsupported,
      grant(),
      new Date("2099-01-01T00:00:30.000Z"),
    )).rejects.toThrow();
  });
});
