import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  OwnerReviewAttemptGate,
  assertOwnerReviewOperationContext,
  clearMissingOwnerReviewRecovery,
  ownerReviewApprovalFromState,
  ownerReviewRecoveryKey,
  persistOwnerReviewPrepareFailure,
  restoreOwnerReviewRecovery,
  restoreOwnerReviewPrepareRecovery,
  X402OwnerReviewWorkspace,
} from "./x402-owner-review-workspace";
import { OwnerReviewRequestError } from "./x402-owner-review-client";
import { X402_APPROVED_RECEIVER } from "./x402-operation-state";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const viewSource = readFileSync(new URL("./x402-owner-review-view.tsx", import.meta.url), "utf8");

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
    expect(html).toContain("font-serif");
    expect(html).toContain("min-h-11");
    expect(html).toContain("focus-visible:ring-2");
    expect(viewSource).not.toMatch(
      /(?:slate|amber|emerald|red)-|bg-white|bg-slate-950|#(?:f3f1ea|171814|235a52)/,
    );
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
    expect(restoreOwnerReviewRecovery(JSON.stringify(saved), OWNER, "devnet"))
      .toBeUndefined();
    expect(restoreOwnerReviewRecovery('{"status":"settlement_unknown"}', OWNER))
      .toBeUndefined();
  });

  it("clears a missing approval only before any submit-capable state", () => {
    const storage = { removeItem: vi.fn() };
    const missing = new OwnerReviewRequestError("APPROVAL_NOT_FOUND", "APPROVAL_NOT_FOUND");
    expect(clearMissingOwnerReviewRecovery(storage, missing, {
      status: "awaiting_approval",
      owner: OWNER,
      network: "testnet",
    }))
      .toBe(true);
    expect(storage.removeItem).toHaveBeenCalledWith(ownerReviewRecoveryKey(OWNER, "testnet"));

    storage.removeItem.mockClear();
    for (const status of ["signed", "relaying", "settlement_unknown", "settled", "delivering"] as const) {
      expect(clearMissingOwnerReviewRecovery(storage, missing, {
        status,
        owner: OWNER,
        network: "testnet",
      })).toBe(false);
    }
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(clearMissingOwnerReviewRecovery(
      storage,
      new OwnerReviewRequestError("APPROVAL_BINDING_MISMATCH", "mismatch"),
      { status: "awaiting_approval", owner: OWNER, network: "testnet" },
    )).toBe(false);
  });

  it("isolates recovery keys by account and network", () => {
    expect(ownerReviewRecoveryKey(OWNER, "testnet")).not.toBe(ownerReviewRecoveryKey(OTHER, "testnet"));
    expect(ownerReviewRecoveryKey(OWNER, "testnet")).not.toBe(ownerReviewRecoveryKey(OWNER, "devnet"));

    const removed: string[] = [];
    const missing = new OwnerReviewRequestError("APPROVAL_NOT_FOUND", "APPROVAL_NOT_FOUND");
    clearMissingOwnerReviewRecovery({ removeItem: (key) => { removed.push(key); } }, missing, {
      status: "awaiting_approval",
      owner: OWNER,
      network: "testnet",
    });
    expect(removed).toEqual([ownerReviewRecoveryKey(OWNER, "testnet")]);
    expect(removed).not.toContain(ownerReviewRecoveryKey(OTHER, "testnet"));
  });

  it("rejects delayed responses after an account or network generation change", async () => {
    const context = { generation: 8, owner: OWNER } as const;
    const matching = { authenticated: true, account: OWNER, network: "testnet" } as const;
    assertOwnerReviewOperationContext(context, 8, matching);

    await Promise.resolve();
    expect(() => assertOwnerReviewOperationContext(context, 9, matching)).toThrow(/session changed/i);
    expect(() => assertOwnerReviewOperationContext(context, 8, {
      authenticated: true,
      account: OTHER,
      network: "testnet",
    })).toThrow(/session changed/i);
    expect(() => assertOwnerReviewOperationContext(context, 8, {
      authenticated: true,
      account: OWNER,
      network: "devnet",
    })).toThrow(/session changed/i);
  });

  it("does not let an old operation release a newer session's gate", () => {
    const gate = new OwnerReviewAttemptGate();
    const oldToken = gate.acquire();
    expect(oldToken).toBeTypeOf("number");
    gate.invalidate();
    const newToken = gate.acquire();
    expect(gate.release(oldToken!)).toBe(false);
    expect(gate.acquire()).toBeUndefined();
    expect(gate.release(newToken!)).toBe(true);
  });

  it("recovers only the exact account-scoped pending preparation tuple", () => {
    const pending = JSON.stringify({
      version: 1,
      owner: OWNER,
      network: "testnet",
      phase: "prepare_unknown",
      idempotency_key: "owner-review-12345678-1234-1234-1234-123456789abc",
    });
    expect(restoreOwnerReviewPrepareRecovery(pending, OWNER)).toEqual({
      version: 1,
      owner: OWNER,
      network: "testnet",
      phase: "prepare_unknown",
      idempotency_key: "owner-review-12345678-1234-1234-1234-123456789abc",
    });
    expect(restoreOwnerReviewPrepareRecovery(pending, OTHER)).toBeUndefined();
    expect(restoreOwnerReviewPrepareRecovery(pending, OWNER, "devnet")).toBeUndefined();
    expect(restoreOwnerReviewPrepareRecovery(pending.replace("prepare_unknown", "new_prepare"), OWNER))
      .toBeUndefined();
  });

  it("retains a valid prepared response when exact retry binding fails", () => {
    const pendingValue = JSON.stringify({
      version: 1,
      owner: OWNER,
      network: "testnet",
      phase: "prepare_unknown",
      idempotency_key: "owner-review-12345678-1234-1234-1234-123456789abc",
    });
    const pending = restoreOwnerReviewPrepareRecovery(pendingValue, OWNER)!;
    const prepared = {
      status: "awaiting_approval",
      approval_id: "owner-review-approval-0001",
      approval_digest: "A".repeat(64),
      idempotency_key: pending.idempotency_key,
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
    } as const;
    let stored = pendingValue;

    expect(persistOwnerReviewPrepareFailure({
      setItem: (key, value) => {
        expect(key).toBe(ownerReviewRecoveryKey(OWNER, "testnet"));
        stored = value;
      },
    }, pending, prepared)).toBeUndefined();

    expect(restoreOwnerReviewRecovery(stored, OWNER, "testnet"))
      .toMatchObject({ approval_id: prepared.approval_id, status: "awaiting_approval" });
    expect(restoreOwnerReviewPrepareRecovery(stored, OWNER, "testnet")).toBeUndefined();
  });
});
