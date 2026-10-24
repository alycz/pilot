import { describe, expect, it } from "vitest";
import { ECDSA, Wallet, hashes, type Transaction } from "xrpl";

import {
  WORK_AGREEMENT_PROVENANCE,
  applyValidatedWorkAgreementSubmission,
  bindCancelApproval,
  bindCreateApproval,
  bindReleaseApproval,
  createWorkAgreementDraft,
  expireWorkAgreementApproval,
  markWorkAgreementSubmissionUnknown,
  ownerApprovalExecutionRequest,
  reconcileUnknownWorkAgreementSubmission,
  rejectWorkAgreementApproval,
  startWorkAgreementSubmission,
  type ActiveWorkAgreementState,
  type WorkAgreementApproval,
} from "./work-agreement-state";

const OWNER_WALLET = Wallet.generate(ECDSA.secp256k1);
const OWNER = OWNER_WALLET.classicAddress;
const COUNTERPARTY = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const EXPIRY = "2026-10-24T12:05:00.000Z";

function sign(tx: Record<string, unknown>): string {
  return OWNER_WALLET.sign(tx as Transaction).tx_blob;
}

function signedHash(tx: Record<string, unknown>): string {
  return hashes.hashSignedTx(sign(tx)).toUpperCase();
}

function draft() {
  return createWorkAgreementDraft({
    agreementId: "agreement-1",
    owner: OWNER,
    counterparty: COUNTERPARTY,
    network: "testnet",
    amountDrops: "2500000",
    finishAfter: 900_000_000,
    cancelAfter: 900_000_600,
  });
}

function createTx(overrides: Record<string, unknown> = {}) {
  return {
    TransactionType: "EscrowCreate",
    Account: OWNER,
    Destination: COUNTERPARTY,
    Amount: "2500000",
    FinishAfter: 900_000_000,
    CancelAfter: 900_000_600,
    Fee: "12",
    Sequence: 42,
    LastLedgerSequence: 1_050,
    SourceTag: 20261017,
    Memos: [{ Memo: { MemoType: "70696C6F74", MemoData: "61677265656D656E742D31" } }],
    ...overrides,
  };
}

function approval(
  action: WorkAgreementApproval["action"],
  txJson: Record<string, unknown>,
  suffix: string = action,
): WorkAgreementApproval {
  const lastLedgerSequence = Number(txJson.LastLedgerSequence);
  return {
    action,
    approvalId: `approval-${suffix}`,
    expiresAt: EXPIRY,
    execution: ownerApprovalExecutionRequest(`build-${suffix}`, `idempotency-${suffix}`),
    network: "testnet",
    validatedLedgerIndex: lastLedgerSequence - 20,
    validatedAccountSequence: Number(txJson.Sequence),
    maxFeeDrops: "500",
    ...(typeof txJson.SourceTag === "number" ? { sourceTag: txJson.SourceTag } : {}),
    ...(Array.isArray(txJson.Memos) ? { memos: txJson.Memos } : {}),
    txJson,
  };
}

function submitCreate() {
  const awaiting = bindCreateApproval(draft(), approval("create", createTx()), NOW);
  return startWorkAgreementSubmission(awaiting, {
    account: OWNER,
    network: "testnet",
    signedBlob: sign(createTx()),
    attemptId: "attempt-create",
    now: NOW,
  });
}

function active(): ActiveWorkAgreementState {
  const submitting = submitCreate();
  return applyValidatedWorkAgreementSubmission(submitting, {
    approvalId: "approval-create",
    hash: signedHash(createTx()),
    ledgerIndex: 1_048,
    validated: true,
    engineResult: "tesSUCCESS",
    txJson: createTx(),
  }) as ActiveWorkAgreementState;
}

describe("work-agreement state", () => {
  it("labels all state as fixture simulation without claiming Speculos conformance", () => {
    expect(draft()).toMatchObject({
      status: "draft",
      provenance: WORK_AGREEMENT_PROVENANCE,
      simulation: true,
      speculosConformanceClaimed: false,
    });
  });

  it("accepts only bounded native-XRP escrow terms", () => {
    expect(() => createWorkAgreementDraft({
      agreementId: "bad",
      owner: OWNER,
      counterparty: OWNER,
      network: "testnet",
      amountDrops: "1",
      finishAfter: 1,
    })).toThrow(/different accounts/i);
    expect(() => createWorkAgreementDraft({
      agreementId: "bad",
      owner: OWNER,
      counterparty: COUNTERPARTY,
      network: "testnet",
      amountDrops: "1.5",
      finishAfter: 1,
    })).toThrow(/native XRP drops/i);
    expect(() => createWorkAgreementDraft({
      agreementId: "bad",
      owner: OWNER,
      counterparty: COUNTERPARTY,
      network: "testnet",
      amountDrops: "1",
      condition: "AA",
    })).toThrow(/requires CancelAfter/i);
    expect(() => createWorkAgreementDraft({
      agreementId: "bad",
      owner: OWNER,
      counterparty: COUNTERPARTY,
      network: "testnet",
      amountDrops: "1",
      finishAfter: 20,
      cancelAfter: 20,
    })).toThrow(/later than FinishAfter/i);
  });

  it("binds an exact create approval and forces owner approval", () => {
    const state = bindCreateApproval(draft(), approval("create", createTx()), NOW);
    expect(state.status).toBe("awaiting_create");
    expect(state.approval.execution).toEqual({
      build_id: "build-create",
      idempotency_key: "idempotency-create",
      require_owner_approval: true,
    });
    expect(state.history.approvalIds).toEqual(["approval-create"]);
  });

  it.each([
    ["account", { Account: COUNTERPARTY }],
    ["counterparty", { Destination: OWNER }],
    ["amount", { Amount: "2500001" }],
    ["finish", { FinishAfter: 900_000_001 }],
    ["cancel", { CancelAfter: 900_000_601 }],
    ["extra field", { DestinationTag: 7 }],
    ["delegate", { Delegate: COUNTERPARTY }],
  ])("rejects create %s tampering", (_label, changed) => {
    expect(() => bindCreateApproval(draft(), approval("create", createTx(changed)), NOW)).toThrow();
  });

  it("rejects stale, wrong-network, and non-forced approvals", () => {
    const stale = { ...approval("create", createTx()), expiresAt: new Date(NOW).toISOString() };
    expect(() => bindCreateApproval(draft(), stale, NOW)).toThrow(/stale or expired/i);
    expect(() => bindCreateApproval(draft(), {
      ...approval("create", createTx()),
      network: "devnet",
    }, NOW)).toThrow(/network changed/i);
    expect(() => bindCreateApproval(draft(), {
      ...approval("create", createTx()),
      execution: {
        build_id: "build-create",
        idempotency_key: "idempotency-create",
        require_owner_approval: false,
      } as never,
    }, NOW)).toThrow(/forced-owner/i);
  });

  it.each([
    ["fee cap", { tx: { Fee: "501" } }],
    ["account sequence", { approval: { validatedAccountSequence: 43 } }],
    ["stale ledger", { approval: { validatedLedgerIndex: 1_050 } }],
    ["broad ledger", { approval: { validatedLedgerIndex: 999 } }],
    ["source tag", { approval: { sourceTag: 1 } }],
    ["memos", { approval: { memos: [] } }],
  ])("rejects unsafe approval freshness or metadata: %s", (_label, change) => {
    const update = change as {
      tx?: Record<string, unknown>;
      approval?: Partial<WorkAgreementApproval>;
    };
    const tx = createTx(update.tx ?? {});
    const candidate = { ...approval("create", tx), ...(update.approval ?? {}) };
    expect(() => bindCreateApproval(draft(), candidate, NOW)).toThrow();
  });

  it("rejects account, network, transaction, attempt replay, and double-click changes before signing", () => {
    const awaiting = bindCreateApproval(draft(), approval("create", createTx()), NOW);
    const base = { account: OWNER, network: "testnet" as const, signedBlob: sign(createTx()), attemptId: "attempt-create", now: NOW };
    expect(() => startWorkAgreementSubmission(awaiting, { ...base, account: COUNTERPARTY })).toThrow(/account changed/i);
    expect(() => startWorkAgreementSubmission(awaiting, { ...base, network: "devnet" })).toThrow(/network changed/i);
    expect(() => startWorkAgreementSubmission(awaiting, { ...base, signedBlob: sign(createTx({ Amount: "3" })) })).toThrow(/amount changed/i);
    const submitting = startWorkAgreementSubmission(awaiting, base);
    expect(submitting.status).toBe("submitting");
    expect(() => startWorkAgreementSubmission(submitting as never, base)).toThrow();
  });

  it("derives OfferSequence only from validated create evidence", () => {
    const state = active();
    expect(state.status).toBe("active");
    expect(state.offerSequence).toBe(42);
    expect(state.createEvidence.validated).toBe(true);
  });

  it("rejects mismatched or tampered validated evidence", () => {
    const submitting = submitCreate();
    expect(() => applyValidatedWorkAgreementSubmission(submitting, {
      approvalId: "another-approval",
      hash: signedHash(createTx()),
      ledgerIndex: 1_048,
      validated: true,
      engineResult: "tesSUCCESS",
      txJson: createTx(),
    })).toThrow(/another approval/i);
    expect(() => applyValidatedWorkAgreementSubmission(submitting, {
      approvalId: "approval-create",
      hash: signedHash(createTx()),
      ledgerIndex: 1_048,
      validated: true,
      engineResult: "tesSUCCESS",
      txJson: createTx({ Sequence: 43 }),
    })).toThrow(/differs/i);
    expect(() => applyValidatedWorkAgreementSubmission(submitting, {
      approvalId: "approval-create",
      hash: "C".repeat(64),
      ledgerIndex: 1_048,
      validated: true,
      engineResult: "tesSUCCESS",
      txJson: createTx(),
    })).toThrow(/locally signed transaction hash/i);
    expect(() => applyValidatedWorkAgreementSubmission(submitting, {
      approvalId: "approval-create",
      hash: signedHash(createTx()),
      ledgerIndex: 1_048,
      validated: false,
      engineResult: "tecFAILED",
      txJson: createTx(),
    } as never)).toThrow(/tesSUCCESS/i);
    expect(() => applyValidatedWorkAgreementSubmission(submitting, {
      approvalId: "approval-create",
      hash: signedHash(createTx()),
      ledgerIndex: 1_000,
      validated: true,
      engineResult: "tesSUCCESS",
      txJson: createTx(),
    })).toThrow(/inclusion window/i);
    expect(() => applyValidatedWorkAgreementSubmission(submitting, {
      approvalId: "approval-create",
      hash: signedHash(createTx()),
      ledgerIndex: 1_051,
      validated: true,
      engineResult: "tesSUCCESS",
      txJson: createTx(),
    })).toThrow(/inclusion window/i);
  });

  it("binds exact conditioned release and cancel shapes to validated sequence", () => {
    const conditionedDraft = createWorkAgreementDraft({
      agreementId: "conditioned",
      owner: OWNER,
      counterparty: COUNTERPARTY,
      network: "testnet",
      amountDrops: "1000000",
      condition: "AA",
      cancelAfter: 900_001_000,
    });
    const { FinishAfter: _unusedFinishAfter, ...conditionedCreate } = createTx({
      Amount: "1000000",
      Condition: "AA",
      CancelAfter: 900_001_000,
    });
    const createAwaiting = bindCreateApproval(
      conditionedDraft,
      approval("create", conditionedCreate, "conditioned-create"),
      NOW,
    );
    const createSubmitting = startWorkAgreementSubmission(createAwaiting, {
      account: OWNER,
      network: "testnet",
      signedBlob: sign(conditionedCreate),
      attemptId: "conditioned-create-attempt",
      now: NOW,
    });
    const conditionedActive = applyValidatedWorkAgreementSubmission(createSubmitting, {
      approvalId: "approval-conditioned-create",
      hash: signedHash(conditionedCreate),
      ledgerIndex: 1_048,
      validated: true,
      engineResult: "tesSUCCESS",
      txJson: conditionedCreate,
    }) as ActiveWorkAgreementState;
    const releaseTx = {
      TransactionType: "EscrowFinish", Account: OWNER, Owner: OWNER,
      OfferSequence: 42, Condition: "AA", Fulfillment: "BB",
      Fee: "399", Sequence: 43, LastLedgerSequence: 1_060,
    };
    const release = bindReleaseApproval(
      conditionedActive,
      approval("release", releaseTx),
      NOW,
    );
    expect(release.status).toBe("awaiting_release");
    expect(() => bindReleaseApproval(conditionedActive, approval("release", {
      ...releaseTx,
      OfferSequence: 41,
    }, "bad-release"), NOW)).toThrow(/validated create sequence/i);

    const cancelTx = {
      TransactionType: "EscrowCancel", Account: OWNER, Owner: OWNER,
      OfferSequence: 42, Fee: "12", Sequence: 43, LastLedgerSequence: 1_060,
    };
    expect(bindCancelApproval(conditionedActive, approval("cancel", cancelTx), NOW).status)
      .toBe("awaiting_cancel");
    expect(() => bindCancelApproval(conditionedActive, approval("cancel", {
      ...cancelTx,
      Condition: "AA",
    }, "bad-cancel"), NOW)).toThrow(/unsupported field/i);
  });

  it("keeps release and cancel mutually exclusive after validation", () => {
    const current = active();
    const releaseTx = {
      TransactionType: "EscrowFinish", Account: OWNER, Owner: OWNER,
      OfferSequence: 42, Fee: "12", Sequence: 43, LastLedgerSequence: 1_060,
    };
    const awaiting = bindReleaseApproval(current, approval("release", releaseTx), NOW);
    const submitting = startWorkAgreementSubmission(awaiting, {
      account: OWNER,
      network: "testnet",
      signedBlob: sign(releaseTx),
      attemptId: "attempt-release",
      now: NOW,
    });
    const released = applyValidatedWorkAgreementSubmission(submitting, {
      approvalId: "approval-release",
      hash: signedHash(releaseTx),
      ledgerIndex: 1_059,
      validated: true,
      engineResult: "tesSUCCESS",
      txJson: releaseTx,
    });
    expect(released.status).toBe("released");
    expect(() => bindCancelApproval(released as never, approval("cancel", {}), NOW)).toThrow();
  });

  it("returns user rejection or expired unsigned approval to its safe base without permitting replay", () => {
    const awaitingCreate = bindCreateApproval(draft(), approval("create", createTx()), NOW);
    const rejected = rejectWorkAgreementApproval(awaitingCreate);
    expect(rejected.status).toBe("draft");
    expect(() => bindCreateApproval(rejected as ReturnType<typeof draft>, approval("create", createTx()), NOW)).toThrow(/replay/i);

    const current = active();
    const cancelTx = {
      TransactionType: "EscrowCancel", Account: OWNER, Owner: OWNER,
      OfferSequence: 42, Fee: "12", Sequence: 43, LastLedgerSequence: 1_060,
    };
    const awaitingCancel = bindCancelApproval(current, {
      ...approval("cancel", cancelTx),
      expiresAt: new Date(NOW + 1_000).toISOString(),
    }, NOW);
    expect(() => expireWorkAgreementApproval(awaitingCancel, NOW)).toThrow(/not expired/i);
    expect(expireWorkAgreementApproval(awaitingCancel, NOW + 1_000).status).toBe("active");
  });

  it("freezes ambiguous submission until validated or complete non-inclusion reconciliation", () => {
    const unknown = markWorkAgreementSubmissionUnknown(submitCreate(), "response_lost");
    expect(unknown.status).toBe("unknown");
    expect(() => bindCreateApproval(unknown as never, approval("create", createTx(), "replacement"), NOW)).toThrow();
    expect(() => reconcileUnknownWorkAgreementSubmission(unknown, {
      approvalId: "approval-create",
      outcome: "not_included",
      searchedAll: true,
      validatedLedgerIndex: 1_050,
      checkedThroughLedger: 1_050,
    })).toThrow(/Complete post-expiry/i);
    expect(reconcileUnknownWorkAgreementSubmission(unknown, {
      approvalId: "approval-create",
      outcome: "not_included",
      searchedAll: true,
      validatedLedgerIndex: 1_051,
      checkedThroughLedger: 1_050,
    }).status).toBe("draft");
  });

  it("recovers ambiguous validated submission without creating a replacement", () => {
    const unknown = markWorkAgreementSubmissionUnknown(submitCreate(), "timeout");
    const recovered = reconcileUnknownWorkAgreementSubmission(unknown, {
      approvalId: "approval-create",
      hash: signedHash(createTx()),
      ledgerIndex: 1_048,
      validated: true,
      engineResult: "tesSUCCESS",
      txJson: createTx(),
    });
    expect(recovered).toMatchObject({ status: "active", offerSequence: 42 });
    expect(recovered.history.attemptIds).toEqual(["attempt-create"]);
  });
});
