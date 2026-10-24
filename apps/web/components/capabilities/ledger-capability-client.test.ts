import { describe, expect, it, vi } from "vitest";

import {
  CapabilityRequestError,
  CapabilityTransportError,
  activateCapability,
  invokeCapability,
  prepareCapability,
  prepareCapabilityRevocation,
  readCapability,
  revokeCapability,
  type CapabilityGrant,
  type CapabilityOwnerReview,
} from "./ledger-capability-client";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const REF = `cap_v1_${"A".repeat(43)}`;
const DIGEST = "a".repeat(64);
const NOW = "2026-10-24T12:00:00.000Z";

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
    notBefore: NOW,
    expiresAt: "2026-10-24T12:10:00.000Z",
    maxUses: 3,
    uses: 0,
    rateLimit: { windowSeconds: 60, maxCalls: 3 },
    generation: 1,
    state: "prepared",
    approvalDigest: DIGEST,
    ...overrides,
  };
}

function review(action: "activate" | "revoke", generation = action === "activate" ? 1 : 2): CapabilityOwnerReview {
  return {
    action,
    capability_ref: REF,
    network: "testnet",
    generation,
    approval_digest: action === "activate" ? DIGEST : "b".repeat(64),
    nonce: "N".repeat(32),
    approved_at: NOW,
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
  };
}

function ok(data: unknown): Response {
  return Response.json({ ok: true, data, asOf: NOW, asOfBasis: "local mock fixture" });
}

describe("Ledger capability browser client", () => {
  it("runs prepare, activation, status, invocation replay, revocation, and post-revoke denial", async () => {
    const activateReview = review("activate");
    const revokeReview = review("revoke");
    const responses = [
      ok({ grant: grant(), owner_review: activateReview }),
      ok(grant({ state: "active" })),
      ok(grant({ state: "active" })),
      ok({
        capabilityRef: REF,
        requestId: "capability-invoke-request-1",
        generation: 1,
        status: "completed",
        replayed: false,
        data: { resource: "ledger-docs", entries: ["payments", "escrow"], simulated: true },
      }),
      ok({
        capabilityRef: REF,
        requestId: "capability-invoke-request-1",
        generation: 1,
        status: "completed",
        replayed: true,
        data: { resource: "ledger-docs", entries: ["payments", "escrow"], simulated: true },
      }),
      ok({ request_id: "capability-revoke-request-1", owner_review: revokeReview }),
      ok(grant({ state: "revoked", generation: 2, uses: 1 })),
      Response.json({
        ok: false,
        error: { service: "capability.invoke", kind: "error", code: "OPERATION_FAILED", message: "Capability is not active" },
      }, { status: 500 }),
      ok(grant({ state: "revoked", generation: 2, uses: 1 })),
    ];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift()!);
    const prepared = await prepareCapability(OWNER, new Date(NOW), fetchImpl as typeof fetch);
    const proof = {
      nonce: activateReview.nonce,
      approved_at: activateReview.approved_at,
      expires_at: activateReview.expires_at,
      tx_blob: "AA",
    };
    await expect(activateCapability(OWNER, activateReview, proof, fetchImpl as typeof fetch))
      .resolves.toMatchObject({ state: "active" });
    await expect(readCapability(OWNER, REF, fetchImpl as typeof fetch))
      .resolves.toMatchObject({ state: "active" });
    await expect(invokeCapability(OWNER, REF, 1, "capability-invoke-request-1", fetchImpl as typeof fetch))
      .resolves.toMatchObject({ replayed: false, status: "completed" });
    await expect(invokeCapability(OWNER, REF, 1, "capability-invoke-request-1", fetchImpl as typeof fetch))
      .resolves.toMatchObject({ replayed: true, status: "completed" });
    const revocation = await prepareCapabilityRevocation(
      OWNER,
      REF,
      "capability-revoke-request-1",
      fetchImpl as typeof fetch,
    );
    await expect(revokeCapability(OWNER, revocation.owner_review, {
      ...proof,
      nonce: revocation.owner_review.nonce,
      approved_at: revocation.owner_review.approved_at,
      expires_at: revocation.owner_review.expires_at,
    }, fetchImpl as typeof fetch)).resolves.toMatchObject({ state: "revoked", generation: 2 });
    await expect(invokeCapability(
      OWNER,
      REF,
      2,
      "capability-post-revoke-1",
      fetchImpl as typeof fetch,
    )).rejects.toBeInstanceOf(CapabilityRequestError);
    await expect(readCapability(OWNER, REF, fetchImpl as typeof fetch))
      .resolves.toMatchObject({ state: "revoked" });

    expect(prepared.grant.state).toBe("prepared");
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      "/api/harbor/capability.prepare",
      "/api/harbor/capability.activate",
      "/api/harbor/capability.status",
      "/api/harbor/capability.invoke",
      "/api/harbor/capability.invoke",
      "/api/harbor/capability.prepareRevoke",
      "/api/harbor/capability.revoke",
      "/api/harbor/capability.invoke",
      "/api/harbor/capability.status",
    ]);
    expect(fetchImpl.mock.calls.every(([, init]) =>
      init?.credentials === "same-origin" && init?.cache === "no-store")).toBe(true);
  });

  it("rejects a prepared review whose account changed", async () => {
    const changed = review("activate");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok({
      grant: grant(),
      owner_review: { ...changed, tx_json: { ...changed.tx_json, Account: OTHER } },
    }));
    await expect(prepareCapability(OWNER, new Date(NOW), fetchImpl as typeof fetch))
      .rejects.toThrow("transition was rejected");
  });

  it("rejects a consistently switched prepared account and changed preparation bounds", async () => {
    const switched = review("activate");
    const switchedFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok({
      grant: grant({ account: OTHER }),
      owner_review: {
        ...switched,
        tx_json: { ...switched.tx_json, Account: OTHER },
      },
    }));
    await expect(prepareCapability(OWNER, new Date(NOW), switchedFetch as typeof fetch))
      .rejects.toThrow(/account, network, reference/i);

    const expandedQuota = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok({
      grant: grant({ maxUses: 4 }),
      owner_review: review("activate"),
    }));
    await expect(prepareCapability(OWNER, new Date(NOW), expandedQuota as typeof fetch))
      .rejects.toThrow(/time or quota/i);
  });

  it("retains the bounded error code needed for safe exact-request recovery", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      ok: false,
      error: { service: "capability.invoke", kind: "error", code: "OPERATION_FAILED", message: "Capability dispatch is unknown" },
    }, { status: 500 }));
    await expect(invokeCapability(
      OWNER,
      REF,
      1,
      "capability-invoke-request-1",
      fetchImpl as typeof fetch,
    )).rejects.toMatchObject({ code: "OPERATION_FAILED", message: "Capability dispatch is unknown" });
  });

  it("treats transport failure as ambiguous and rejects a changed invocation response tuple", async () => {
    const offline = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      throw new Error("connection reset");
    });
    await expect(invokeCapability(
      OWNER,
      REF,
      1,
      "capability-invoke-request-1",
      offline as typeof fetch,
    )).rejects.toBeInstanceOf(CapabilityTransportError);

    const changed = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok({
      capabilityRef: REF,
      requestId: "capability-invoke-request-2",
      generation: 1,
      status: "completed",
      replayed: false,
      data: { resource: "ledger-docs", entries: ["payments"], simulated: true },
    }));
    await expect(invokeCapability(
      OWNER,
      REF,
      1,
      "capability-invoke-request-1",
      changed as typeof fetch,
    )).rejects.toThrow(/exact recovery tuple/i);

    const changedResource = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok({
      capabilityRef: REF,
      requestId: "capability-invoke-request-1",
      generation: 1,
      status: "completed",
      replayed: false,
      data: { resource: "market-fixture", entries: ["payments"], simulated: true },
    }));
    await expect(invokeCapability(
      OWNER,
      REF,
      1,
      "capability-invoke-request-1",
      changedResource as typeof fetch,
    )).rejects.toThrow(/exact recovery tuple/i);
  });
});
