import { describe, expect, it } from "vitest";

import type { CapabilityGrant, CapabilityOwnerReview } from "./ledger-capability-client";
import {
  bindCapabilityOwnerReview,
  exactCapabilityProofTransaction,
  expectedCapabilityRevocationDigest,
} from "./ledger-capability-review";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const REF = `cap_v1_${"A".repeat(43)}`;
const NOW = new Date("2026-10-24T12:00:30.000Z");

function grant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    capabilityRef: REF,
    principal: "pilot-browser",
    account: OWNER,
    network: "testnet",
    service: "mock.catalog",
    operation: "read",
    amount: { unit: "request", value: "1" },
    destination: "local-fixture-catalog",
    notBefore: "2026-10-24T12:00:00.000Z",
    expiresAt: "2026-10-24T12:10:00.000Z",
    maxUses: 3,
    uses: 0,
    rateLimit: { windowSeconds: 60, maxCalls: 3 },
    generation: 1,
    state: "prepared",
    approvalDigest: "a".repeat(64),
    ...overrides,
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
    approved_at: "2026-10-24T12:00:00.000Z",
    expires_at: "2026-10-24T12:01:00.000Z",
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

describe("exact capability owner review binding", () => {
  it("binds the entire activation AccountSet proof before Ledger signing", async () => {
    await expect(bindCapabilityOwnerReview(review(), grant(), NOW)).resolves.toMatchObject({
      signingMode: "clear",
      review: { action: "activate", generation: 1 },
    });
  });

  it.each([
    ["memo type", (value: CapabilityOwnerReview) => ({ ...value, tx_json: { ...value.tx_json, Memos: [{ Memo: { MemoType: "AA", MemoData: value.tx_json.Memos[0]!.Memo.MemoData } }] } })],
    ["memo data", (value: CapabilityOwnerReview) => ({ ...value, tx_json: { ...value.tx_json, Memos: [{ Memo: { MemoType: value.tx_json.Memos[0]!.Memo.MemoType, MemoData: "AA" } }] } })],
    ["action", (value: CapabilityOwnerReview) => ({ ...value, action: "revoke" as const })],
    ["generation", (value: CapabilityOwnerReview) => ({ ...value, generation: 2 })],
    ["digest", (value: CapabilityOwnerReview) => ({ ...value, approval_digest: "b".repeat(64) })],
    ["future approval", (value: CapabilityOwnerReview) => ({ ...value, approved_at: "2026-10-24T12:00:31.000Z" })],
    ["long expiry", (value: CapabilityOwnerReview) => ({ ...value, expires_at: "2026-10-24T12:02:00.000Z" })],
    ["extra transaction field", (value: CapabilityOwnerReview) => ({ ...value, tx_json: { ...value.tx_json, Flags: 1 } as never })],
  ])("rejects %s tampering", async (_label, mutate) => {
    await expect(bindCapabilityOwnerReview(mutate(review()) as CapabilityOwnerReview, grant(), NOW))
      .rejects.toThrow();
  });

  it("binds revocation to the current grant generation and deterministic digest", async () => {
    const active = grant({ state: "active" });
    const digest = await expectedCapabilityRevocationDigest(active);
    const candidate = review({
      action: "revoke",
      generation: 2,
      approval_digest: digest,
    });
    const exact = {
      ...candidate,
      tx_json: exactCapabilityProofTransaction(candidate, OWNER) as CapabilityOwnerReview["tx_json"],
    };
    await expect(bindCapabilityOwnerReview(exact, active, NOW)).resolves.toMatchObject({
      review: { action: "revoke", generation: 2, approval_digest: digest },
    });
    await expect(bindCapabilityOwnerReview({ ...exact, generation: 3 }, active, NOW))
      .rejects.toThrow(/generation/i);
  });
});
