import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WalletSessionStatus } from "../../lib/harbor-browser";
import {
  WorkAgreementAttemptGate,
  assertWorkAgreementOperationContext,
  bindWorkAgreementApproval,
  canRecoverWorkAgreement,
  shouldRenderWorkAgreementDemo,
  workAgreementMatchesSession,
} from "./work-agreement-workspace";
import type {
  WorkAgreementPublicState,
  WorkAgreementRecovery,
} from "./work-agreement-runtime-client";
import { WorkAgreementView } from "./work-agreement-view";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const COUNTERPARTY = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const EXPIRES = "2026-10-24T12:05:00.000Z";

function prepared(overrides: Partial<WorkAgreementPublicState> = {}): WorkAgreementPublicState {
  const txJson = {
    TransactionType: "EscrowCreate",
    Account: OWNER,
    Destination: COUNTERPARTY,
    Amount: "2500000",
    FinishAfter: 900_000_000,
    CancelAfter: 900_000_600,
    Fee: "12",
    Sequence: 42,
    LastLedgerSequence: 1_050,
    SourceTag: 20_261_017,
    Memos: [{ Memo: { MemoType: "70696C6F74", MemoData: "61677265656D656E74" } }],
  };
  return {
    profile: "local-testnet-mock-v1",
    status: "awaiting_approval",
    revision: 3,
    outcome: "prepared",
    simulation: true,
    settlement_provenance: "local-mock-simulated-settlement",
    live_validation_claimed: false,
    physical_device_inferred: false,
    speculos_conformance_claimed: false,
    owner_key_custody: false,
    network_requests_made: 0,
    agreement_id: "agreement-runtime-0001",
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
      tx_json: txJson,
    },
    created_at: "2026-10-24T11:59:00.000Z",
    updated_at: "2026-10-24T12:00:00.000Z",
    ...overrides,
  };
}

const SESSION: WalletSessionStatus = {
  authenticated: true,
  account: OWNER,
  network: "testnet",
};

describe("durable work-agreement workspace", () => {
  it("renders the PR13-styled durable route with an explicitly separate recorded demo", () => {
    const markup = renderToStaticMarkup(
      <WorkAgreementView
        busy={false}
        draft={{ amountDrops: "1000000", cancelAfter: "900000600", counterparty: "", finishAfter: "900000000" }}
        owner={OWNER}
        onChange={() => undefined}
        onClear={() => undefined}
        onCreate={() => undefined}
        onPrepareCancel={() => undefined}
        onPrepareRelease={() => undefined}
        onRecover={() => undefined}
        onRefresh={() => undefined}
        onReject={() => undefined}
        onReview={() => undefined}
      />,
    );
    expect(markup).toContain("Owner-reviewed escrow workspace");
    expect(markup).toContain("Local mock settlement only");
    expect(markup).toContain("/agreements?demo=recorded");
    expect(markup).toContain("font-serif");
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).not.toContain("amber-");
    expect(markup).not.toContain("#");
  });

  it("binds the authenticated owner and invalidates account or network changes", () => {
    const record = prepared();
    expect(workAgreementMatchesSession(record, SESSION)).toBe(true);
    expect(workAgreementMatchesSession(record, { ...SESSION, account: COUNTERPARTY })).toBe(false);
    expect(workAgreementMatchesSession(record, { ...SESSION, network: "devnet" })).toBe(false);
    expect(workAgreementMatchesSession(record, { authenticated: false })).toBe(false);
  });

  it("shows the local demo until an authenticated session is confirmed", () => {
    expect(shouldRenderWorkAgreementDemo(undefined)).toBe(false);
    expect(shouldRenderWorkAgreementDemo(null)).toBe(true);
    expect(shouldRenderWorkAgreementDemo({ authenticated: false })).toBe(true);
    expect(shouldRenderWorkAgreementDemo(SESSION)).toBe(false);
    expect(shouldRenderWorkAgreementDemo({ ...SESSION, network: "devnet" })).toBe(false);
  });

  it("rejects repeated clicks while the first async operation is active", async () => {
    const gate = new WorkAgreementAttemptGate();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const first = gate.run(async () => {
      await waiting;
      return "complete";
    });
    await expect(gate.run(async () => "duplicate")).resolves.toBeUndefined();
    release();
    await expect(first).resolves.toBe("complete");
    await expect(gate.run(async () => "next")).resolves.toBe("next");
  });

  it("rejects a delayed response after the wallet account generation changes", async () => {
    let generation = 7;
    let currentSession: WalletSessionStatus = SESSION;
    const context = { generation, owner: OWNER } as const;
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    let mutated = false;
    const operation = (async () => {
      await delayed;
      assertWorkAgreementOperationContext(context, generation, currentSession);
      mutated = true;
    })();
    generation += 1;
    currentSession = { authenticated: true, account: COUNTERPARTY, network: "testnet" };
    release();
    await expect(operation).rejects.toMatchObject({ name: "StaleWorkAgreementOperationError" });
    expect(mutated).toBe(false);
  });

  it("validates the exact clear-sign escrow action before opening owner review", async () => {
    const bound = await bindWorkAgreementApproval(prepared(), "ledger-webhid", NOW);
    expect(bound.review).toMatchObject({
      action: "escrow-create",
      account: OWNER,
      network: "testnet",
      signingMode: "clear",
      provenance: {
        runtime: "ledger-webhid",
        signatureEvidence: "signing-key-control-only",
        physicalDeviceInferred: false,
      },
    });
    expect(bound.request).toMatchObject({
      approvalId: "agreement-approval-0001",
      expiresAt: EXPIRES,
      summary: {
        action: "Create the reviewed escrow",
        destination: COUNTERPARTY,
        feeDrops: "12",
        network: "testnet",
      },
    });
  });

  it("fails closed when the exact approval expired", async () => {
    await expect(bindWorkAgreementApproval(prepared(), "speculos", Date.parse(EXPIRES)))
      .rejects.toThrow(/expired/i);
  });

  it("recovers only the exact unknown submission tuple and never a prepare lock", () => {
    const unknown = prepared({
      status: "unknown",
      outcome: "unknown",
      attempt_id: "agreement-attempt-0001",
      tx_hash: "A".repeat(64),
    });
    const recovery: WorkAgreementRecovery = {
      version: 1,
      owner: OWNER,
      network: "testnet",
      agreement_id: unknown.agreement_id,
      phase: "submission_unknown",
      approval_id: unknown.approval!.approval_id,
      idempotency_key: unknown.approval!.idempotency_key,
      attempt_id: unknown.attempt_id!,
      action: "create",
      expires_at: EXPIRES,
      retain_until: "2026-10-25T12:05:00.000Z",
    };
    expect(canRecoverWorkAgreement(unknown, recovery, SESSION)).toBe(true);
    expect(canRecoverWorkAgreement(prepared(), recovery, SESSION)).toBe(true);
    expect(canRecoverWorkAgreement(prepared({
      status: "submitting",
      outcome: "submitted",
      approval: undefined,
      action: undefined,
    }), recovery, SESSION)).toBe(true);
    expect(canRecoverWorkAgreement(unknown, { ...recovery, attempt_id: "agreement-attempt-other" }, SESSION)).toBe(false);
    expect(canRecoverWorkAgreement(unknown, {
      version: 1,
      owner: OWNER,
      network: "testnet",
      agreement_id: unknown.agreement_id,
      idempotency_key: unknown.approval!.idempotency_key,
      phase: "prepare_unknown",
      retain_until: "2026-10-25T12:05:00.000Z",
    }, SESSION)).toBe(false);
    expect(JSON.stringify(recovery)).not.toContain("signed_blob");
  });
});
