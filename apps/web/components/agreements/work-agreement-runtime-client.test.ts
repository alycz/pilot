import { describe, expect, it, vi } from "vitest";

import {
  WORK_AGREEMENT_RECOVERY_KEY,
  clearWorkAgreementRecovery,
  loadWorkAgreementRecovery,
  requestWorkAgreement,
  saveWorkAgreementRecovery,
  type WorkAgreementPublicState,
  type WorkAgreementRecovery,
} from "./work-agreement-runtime-client";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const COUNTERPARTY = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const CREATED = "2026-10-24T12:00:00.000Z";
const EXPIRES = "2026-10-24T12:05:00.000Z";

function state(overrides: Partial<WorkAgreementPublicState> = {}): WorkAgreementPublicState {
  return {
    profile: "local-testnet-mock-v1",
    status: "awaiting_approval",
    revision: 0,
    outcome: "prepared",
    simulation: true,
    settlement_provenance: "local-mock-simulated-settlement",
    live_validation_claimed: false,
    physical_device_inferred: false,
    speculos_conformance_claimed: false,
    owner_key_custody: false,
    network_requests_made: 0,
    agreement_id: "agreement-client-0001",
    owner: OWNER,
    network: "testnet",
    terms: {
      counterparty: COUNTERPARTY,
      amount_drops: "2500000",
      finish_after: 900_000_000,
      cancel_after: 900_000_600,
    },
    action: "create",
    approval: {
      action: "create",
      approval_id: "agreement-approval-0001",
      expires_at: EXPIRES,
      idempotency_key: "agreement-idempotency-0001",
      require_owner_approval: true,
      validated_ledger_index: 1_000,
      validated_account_sequence: 42,
      max_fee_drops: "100",
      tx_json: { TransactionType: "EscrowCreate", Account: OWNER },
    },
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, value); },
  };
}

describe("work-agreement runtime client", () => {
  it("uses the fixed same-origin prepare route and exact body", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      ok: true,
      data: state(),
      asOf: CREATED,
      asOfBasis: "local-mock-work-agreement",
    }));
    const args = {
      owner: OWNER,
      network: "testnet" as const,
      agreement_id: "agreement-client-0001",
      action: "create" as const,
      idempotency_key: "agreement-idempotency-0001",
      approval_expires_at: EXPIRES,
      terms: {
        counterparty: COUNTERPARTY,
        amount_drops: "2500000",
        finish_after: 900_000_000,
        cancel_after: 900_000_600,
      },
    };
    await expect(requestWorkAgreement({ action: "prepare", args }, fetchImpl as typeof fetch))
      .resolves.toMatchObject({ status: "awaiting_approval", simulation: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/harbor/workAgreement.prepare",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify(args),
      }),
    );
  });

  it.each([
    ["provenance", { settlement_provenance: "xrpl-live" }],
    ["device claim", { physical_device_inferred: true }],
    ["missing approval", { approval: undefined }],
    ["active evidence", { status: "active", approval: undefined, offer_sequence: 42 }],
  ])("rejects an untrusted %s response", async (_label, change) => {
    const fetchImpl = vi.fn(async () => Response.json({
      ok: true,
      data: state(change as never),
      asOf: CREATED,
      asOfBasis: "local-mock-work-agreement",
    }));
    await expect(requestWorkAgreement({
      action: "status",
      args: { owner: OWNER, network: "testnet", agreement_id: "agreement-client-0001" },
    }, fetchImpl as typeof fetch)).rejects.toThrow(/rejected|invalid/i);
  });

  it("surfaces only the bounded operation error", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      ok: false,
      error: {
        service: "workAgreement.recover",
        kind: "error",
        code: "AUTH_BINDING_MISMATCH",
        message: "AUTH_BINDING_MISMATCH",
      },
    }, { status: 200 }));
    await expect(requestWorkAgreement({
      action: "recover",
      args: {
        owner: OWNER,
        network: "testnet",
        agreement_id: "agreement-client-0001",
        approval_id: "agreement-approval-0001",
        idempotency_key: "agreement-idempotency-0001",
      },
    }, fetchImpl as typeof fetch)).rejects.toMatchObject({
      name: "WorkAgreementRequestError",
      code: "AUTH_BINDING_MISMATCH",
    });
  });

  it("persists only account-bound recovery references and clears safely", () => {
    const storage = memoryStorage();
    const recovery: WorkAgreementRecovery = {
      version: 1,
      owner: OWNER,
      network: "testnet",
      agreement_id: "agreement-client-0001",
      approval_id: "agreement-approval-0001",
      idempotency_key: "agreement-idempotency-0001",
      attempt_id: "agreement-attempt-0001",
      action: "create",
      expires_at: EXPIRES,
      retain_until: "2026-10-25T12:00:00.000Z",
    };
    saveWorkAgreementRecovery(storage, recovery);
    expect(storage.getItem(WORK_AGREEMENT_RECOVERY_KEY)).not.toContain("signed_blob");
    expect(loadWorkAgreementRecovery(storage, OWNER, "testnet", Date.parse(CREATED))).toEqual(recovery);
    expect(loadWorkAgreementRecovery(storage, COUNTERPARTY, "testnet", Date.parse(CREATED))).toBeNull();
    expect(loadWorkAgreementRecovery(storage, OWNER, "testnet", Date.parse(EXPIRES))).toEqual(recovery);
    expect(loadWorkAgreementRecovery(storage, OWNER, "testnet", Date.parse(recovery.retain_until))).toBeNull();
    clearWorkAgreementRecovery(storage);
    expect(storage.getItem(WORK_AGREEMENT_RECOVERY_KEY)).toBeNull();
  });
});
