import { describe, expect, it } from "vitest";
import { ECDSA, Wallet, decode, encode, hashes, type Payment, type Transaction } from "xrpl";

import {
  ExactActionPolicyError,
  LedgerApprovalTransitionError,
  createLedgerApprovalState,
  ledgerRuntimeProvenance,
  transitionLedgerApproval,
  validateExactLedgerAction,
  verifyExactLedgerSignedBlob,
  type ExactLedgerActionExpectation,
} from "../src/ledger/exact-action.js";

const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const DESTINATION = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const DELEGATE = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const NOW = 1_800_000_000_000;
const COMMON = {
  network: "testnet" as const,
  account: ACCOUNT,
  sequence: 42,
  validatedLedgerIndex: 1_000,
  maxLedgerWindow: 50,
  maxFeeDrops: "100",
  approvalExpiresAtMs: NOW + 60_000,
  quoteExpiresAtMs: NOW + 30_000,
};

const BASE_TX = {
  Account: ACCOUNT,
  Fee: "12",
  Sequence: 42,
  LastLedgerSequence: 1_050,
};

function code(expected: string) {
  return expect.objectContaining({
    name: "ExactActionPolicyError",
    code: expected,
  });
}

async function rejectCode(
  transaction: Record<string, unknown>,
  expectation: ExactLedgerActionExpectation,
  expected: string,
) {
  await expect(validateExactLedgerAction({
    transaction,
    expectation,
    provenance: ledgerRuntimeProvenance("ledger-webhid"),
    now: NOW,
  })).rejects.toEqual(code(expected));
}

describe("exact Ledger action policy", () => {
  it("binds an exact native-XRP Payment to account, network and review terms", async () => {
    const expectation: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "payment",
      destination: DESTINATION,
      amountDrops: "2500000",
      destinationTag: 7,
      invoiceId: "A".repeat(64),
    };
    const transaction = {
      ...BASE_TX,
      TransactionType: "Payment",
      Destination: DESTINATION,
      Amount: "2500000",
      DestinationTag: 7,
      InvoiceID: "A".repeat(64),
    };
    const review = await validateExactLedgerAction({
      transaction,
      expectation,
      provenance: ledgerRuntimeProvenance("ledger-webhid"),
      now: NOW,
    });
    expect(review).toMatchObject({
      action: "payment",
      network: "testnet",
      account: ACCOUNT,
      signingMode: "clear",
      provenance: {
        runtime: "ledger-webhid",
        signatureEvidence: "signing-key-control-only",
        physicalDeviceInferred: false,
        emulator: false,
      },
    });
    expect(review.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces the same canonical digest before and after exact signing", async () => {
    const wallet = Wallet.generate(ECDSA.secp256k1);
    const expectation: ExactLedgerActionExpectation = {
      ...COMMON,
      account: wallet.classicAddress,
      quoteExpiresAtMs: undefined,
      kind: "payment",
      destination: DESTINATION,
      amountDrops: "1",
    };
    const unsigned = {
      TransactionType: "Payment",
      Account: wallet.classicAddress,
      Destination: DESTINATION,
      Amount: "1",
      Fee: BASE_TX.Fee,
      Sequence: BASE_TX.Sequence,
      LastLedgerSequence: BASE_TX.LastLedgerSequence,
    };
    const before = await validateExactLedgerAction({
      transaction: unsigned,
      expectation,
      provenance: ledgerRuntimeProvenance("speculos"),
      now: NOW,
    });
    const after = await validateExactLedgerAction({
      transaction: decode(wallet.sign(unsigned as Payment).tx_blob) as Record<string, unknown>,
      expectation,
      provenance: ledgerRuntimeProvenance("speculos"),
      phase: "after-sign",
      now: NOW,
    });
    expect(after.digest).toBe(before.digest);
    expect(after.provenance).toEqual({
      runtime: "speculos",
      signatureEvidence: "signing-key-control-only",
      physicalDeviceInferred: false,
      emulator: true,
    });
  });

  it("derives the signed hash only after cryptographic account verification", () => {
    const wallet = Wallet.generate(ECDSA.secp256k1);
    const impostor = Wallet.generate(ECDSA.secp256k1);
    const expectation: ExactLedgerActionExpectation = {
      ...COMMON,
      account: wallet.classicAddress,
      quoteExpiresAtMs: undefined,
      kind: "payment",
      destination: DESTINATION,
      amountDrops: "1",
    };
    const unsigned = {
      TransactionType: "Payment",
      Account: wallet.classicAddress,
      Destination: DESTINATION,
      Amount: "1",
      Fee: BASE_TX.Fee,
      Sequence: BASE_TX.Sequence,
      LastLedgerSequence: BASE_TX.LastLedgerSequence,
    };
    const signedBlob = wallet.sign(unsigned as Payment).tx_blob;
    expect(verifyExactLedgerSignedBlob({ signedBlob, expectation, now: NOW })).toMatchObject({
      hash: hashes.hashSignedTx(signedBlob).toUpperCase(),
      signingMode: "clear",
    });

    const impostorSigned = decode(impostor.sign({
      ...unsigned,
      Account: impostor.classicAddress,
    } as Payment).tx_blob) as Record<string, unknown>;
    const forged = {
      ...(decode(signedBlob) as Record<string, unknown>),
      TxnSignature: impostorSigned.TxnSignature,
    };
    expect(() => verifyExactLedgerSignedBlob({
      signedBlob: encode(forged as Transaction),
      expectation,
      now: NOW,
    })).toThrow(code("INVALID_SIGNATURE_SHAPE"));
  });

  it.each([
    ["account", { Account: DESTINATION }, "SEMANTIC_MISMATCH"],
    ["sequence", { Sequence: 43 }, "SEMANTIC_MISMATCH"],
    ["expired ledger", { LastLedgerSequence: 1_000 }, "SEMANTIC_MISMATCH"],
    ["broad ledger window", { LastLedgerSequence: 1_051 }, "SEMANTIC_MISMATCH"],
    ["fee cap", { Fee: "101" }, "SEMANTIC_MISMATCH"],
    ["noncanonical fee", { Fee: "012" }, "SEMANTIC_MISMATCH"],
    ["destination", { Destination: DELEGATE }, "SEMANTIC_MISMATCH"],
    ["amount", { Amount: "2500001" }, "SEMANTIC_MISMATCH"],
    ["issued asset", { Amount: { currency: "USD", issuer: DELEGATE, value: "1" } }, "SEMANTIC_MISMATCH"],
    ["arbitrary path", { Paths: [] }, "UNEXPECTED_FIELD"],
    ["send max", { SendMax: "999" }, "UNEXPECTED_FIELD"],
    ["flag", { Flags: 0x0002_0000 }, "UNEXPECTED_FIELD"],
    ["memo", { Memos: [] }, "UNEXPECTED_FIELD"],
  ] as const)("rejects Payment %s drift", async (_label, change, expected) => {
    const expectation: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "payment",
      destination: DESTINATION,
      amountDrops: "2500000",
    };
    await rejectCode({
      ...BASE_TX,
      TransactionType: "Payment",
      Destination: DESTINATION,
      Amount: "2500000",
      ...change,
    }, expectation, expected);
  });

  it("requires exact reviewed SourceTag and memos when metadata is present", async () => {
    const expectation: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "payment",
      destination: DESTINATION,
      amountDrops: "2",
      sourceTag: 9,
      memos: [{ Memo: { MemoType: "AA", MemoData: "BB" } }],
    };
    const transaction = {
      ...BASE_TX,
      TransactionType: "Payment",
      Destination: DESTINATION,
      Amount: "2",
      SourceTag: 9,
      Memos: [{ Memo: { MemoData: "BB", MemoType: "AA" } }],
    };
    await expect(validateExactLedgerAction({
      transaction,
      expectation,
      provenance: ledgerRuntimeProvenance("ledger-webhid"),
      now: NOW,
    })).resolves.toMatchObject({ action: "payment" });
    await rejectCode({ ...transaction, SourceTag: 10 }, expectation, "SEMANTIC_MISMATCH");
  });

  it("rejects a changed or unreviewed Payment InvoiceID", async () => {
    const transaction = {
      ...BASE_TX,
      TransactionType: "Payment",
      Destination: DESTINATION,
      Amount: "2",
      InvoiceID: "A".repeat(64),
    };
    await rejectCode(transaction, {
      ...COMMON,
      kind: "payment",
      destination: DESTINATION,
      amountDrops: "2",
    }, "UNEXPECTED_FIELD");
    await rejectCode(transaction, {
      ...COMMON,
      kind: "payment",
      destination: DESTINATION,
      amountDrops: "2",
      invoiceId: "B".repeat(64),
    }, "SEMANTIC_MISMATCH");
  });

  it("allows only explicitly reviewed blind DelegateSet grant and revoke", async () => {
    const grant: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "delegate-grant",
      delegate: DELEGATE,
      permissions: [8, 9, 21],
      blindSigning: "explicitly-reviewed-delegateset",
    };
    const grantTx = {
      ...BASE_TX,
      TransactionType: "DelegateSet",
      Authorize: DELEGATE,
      Permissions: [8, 9, 21].map((PermissionValue) => ({
        Permission: { PermissionValue },
      })),
    };
    await expect(validateExactLedgerAction({
      transaction: grantTx,
      expectation: grant,
      provenance: ledgerRuntimeProvenance("speculos"),
      now: NOW,
    })).resolves.toMatchObject({ signingMode: "blind" });

    const revoke: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "delegate-revoke",
      delegate: DELEGATE,
      blindSigning: "explicitly-reviewed-delegateset",
    };
    await expect(validateExactLedgerAction({
      transaction: {
        ...BASE_TX,
        TransactionType: "DelegateSet",
        Authorize: DELEGATE,
        Permissions: [],
      },
      expectation: revoke,
      provenance: ledgerRuntimeProvenance("ledger-webhid"),
      now: NOW,
    })).resolves.toMatchObject({ signingMode: "blind" });

    await rejectCode({ ...grantTx, Permissions: [...grantTx.Permissions].reverse() }, grant, "SEMANTIC_MISMATCH");
    await rejectCode({ ...grantTx, Authorize: DESTINATION }, grant, "SEMANTIC_MISMATCH");
    await rejectCode({ ...grantTx, Permissions: [...grantTx.Permissions, grantTx.Permissions[0]] }, grant, "SEMANTIC_MISMATCH");
  });

  it("validates exact create, finish and cancel escrow identifiers and bounds", async () => {
    const create: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "escrow-create",
      destination: DESTINATION,
      amountDrops: "1000000",
      finishAfter: 900_000_000,
      cancelAfter: 900_000_600,
      condition: "AABB",
      destinationTag: 7,
    };
    await expect(validateExactLedgerAction({
      transaction: {
        ...BASE_TX,
        TransactionType: "EscrowCreate",
        Destination: DESTINATION,
        Amount: "1000000",
        FinishAfter: 900_000_000,
        CancelAfter: 900_000_600,
        Condition: "AABB",
        DestinationTag: 7,
      },
      expectation: create,
      provenance: ledgerRuntimeProvenance("ledger-webhid"),
      now: NOW,
    })).resolves.toMatchObject({ action: "escrow-create", signingMode: "clear" });

    const escrowId = { owner: DESTINATION, offerSequence: 7 } as const;
    const finish: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "escrow-finish",
      escrowId,
      condition: "AABB",
      fulfillment: "CCDD",
    };
    await expect(validateExactLedgerAction({
      transaction: {
        ...BASE_TX,
        TransactionType: "EscrowFinish",
        Owner: DESTINATION,
        OfferSequence: 7,
        Condition: "AABB",
        Fulfillment: "CCDD",
      },
      expectation: finish,
      provenance: ledgerRuntimeProvenance("ledger-webhid"),
      now: NOW,
    })).resolves.toMatchObject({ action: "escrow-finish" });

    const cancel: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "escrow-cancel",
      escrowId,
    };
    await expect(validateExactLedgerAction({
      transaction: {
        ...BASE_TX,
        TransactionType: "EscrowCancel",
        Owner: DESTINATION,
        OfferSequence: 7,
      },
      expectation: cancel,
      provenance: ledgerRuntimeProvenance("ledger-webhid"),
      now: NOW,
    })).resolves.toMatchObject({ action: "escrow-cancel" });

    await rejectCode({
      ...BASE_TX,
      TransactionType: "EscrowCancel",
      Owner: DESTINATION,
      OfferSequence: 8,
    }, cancel, "SEMANTIC_MISMATCH");
  });

  it("rejects invalid escrow timing and condition pairs", async () => {
    const invalidCreate: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "escrow-create",
      destination: DESTINATION,
      amountDrops: "1",
      finishAfter: 10,
      cancelAfter: 10,
    };
    await rejectCode({
      ...BASE_TX,
      TransactionType: "EscrowCreate",
      Destination: DESTINATION,
      Amount: "1",
      FinishAfter: 10,
      CancelAfter: 10,
    }, invalidCreate, "INVALID_EXPECTATION");

    const invalidFinish: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "escrow-finish",
      escrowId: { owner: DESTINATION, offerSequence: 7 },
      condition: "AABB",
    };
    await rejectCode({
      ...BASE_TX,
      TransactionType: "EscrowFinish",
      Owner: DESTINATION,
      OfferSequence: 7,
      Condition: "AABB",
    }, invalidFinish, "INVALID_EXPECTATION");
  });

  it("rejects expired approvals, stale quotes and malformed post-sign blobs", async () => {
    const transaction = {
      ...BASE_TX,
      TransactionType: "Payment",
      Destination: DESTINATION,
      Amount: "1",
    };
    const base: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "payment",
      destination: DESTINATION,
      amountDrops: "1",
    };
    await rejectCode(transaction, { ...base, approvalExpiresAtMs: NOW }, "EXPIRED_APPROVAL");
    await rejectCode(transaction, { ...base, quoteExpiresAtMs: NOW }, "STALE_QUOTE");
    await expect(validateExactLedgerAction({
      transaction,
      expectation: base,
      provenance: ledgerRuntimeProvenance("ledger-webhid"),
      phase: "after-sign",
      now: NOW,
    })).rejects.toEqual(code("INVALID_SIGNATURE_SHAPE"));
  });

  it("rejects a transaction type outside the exact reviewed action", async () => {
    const expectation: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "payment",
      destination: DESTINATION,
      amountDrops: "1",
    };
    await rejectCode({
      ...BASE_TX,
      TransactionType: "FutureTransaction",
      Destination: DESTINATION,
      Amount: "1",
    }, expectation, "UNSUPPORTED_TRANSACTION");
  });

  it("does not allow provenance to assert a physical device", async () => {
    const expectation: ExactLedgerActionExpectation = {
      ...COMMON,
      kind: "payment",
      destination: DESTINATION,
      amountDrops: "1",
    };
    await expect(validateExactLedgerAction({
      transaction: {
        ...BASE_TX,
        TransactionType: "Payment",
        Destination: DESTINATION,
        Amount: "1",
      },
      expectation,
      provenance: {
        runtime: "ledger-webhid",
        signatureEvidence: "signing-key-control-only",
        physicalDeviceInferred: true,
        emulator: false,
      } as never,
      now: NOW,
    })).rejects.toEqual(code("INVALID_EXPECTATION"));
  });
});

describe("Ledger exact-action approval state", () => {
  const timing = {
    approvalExpiresAtMs: NOW + 60_000,
    quoteExpiresAtMs: NOW + 30_000,
    signTimeoutMs: 10_000,
  };

  it("runs the valid review through validated transition", () => {
    let state = createLedgerApprovalState(timing, NOW);
    state = transitionLedgerApproval(state, { type: "begin-sign" }, NOW + 1);
    expect(state).toMatchObject({ status: "signing", signDeadlineMs: NOW + 10_001 });
    state = transitionLedgerApproval(state, { type: "sign-succeeded" }, NOW + 2);
    state = transitionLedgerApproval(state, { type: "begin-submit" }, NOW + 3);
    state = transitionLedgerApproval(state, { type: "submit-validated" }, NOW + 4);
    expect(state.status).toBe("validated");
  });

  it("models rejection, timeout, expiry, stale quote and ambiguous settlement distinctly", () => {
    const review = createLedgerApprovalState(timing, NOW);
    expect(transitionLedgerApproval(review, { type: "user-rejected" }, NOW + 1).status)
      .toBe("rejected");

    const signing = transitionLedgerApproval(review, { type: "begin-sign" }, NOW);
    expect(transitionLedgerApproval(signing, { type: "tick" }, NOW + 10_000).status)
      .toBe("timed-out");
    expect(createLedgerApprovalState({ ...timing, approvalExpiresAtMs: NOW }, NOW).status)
      .toBe("expired");
    expect(createLedgerApprovalState({ ...timing, quoteExpiresAtMs: NOW }, NOW).status)
      .toBe("stale-quote");

    const signed = transitionLedgerApproval(signing, { type: "sign-succeeded" }, NOW + 1);
    const submitting = transitionLedgerApproval(signed, { type: "begin-submit" }, NOW + 2);
    expect(transitionLedgerApproval(submitting, { type: "tick" }, NOW + 60_000).status)
      .toBe("submitting");
    const unknown = transitionLedgerApproval(submitting, { type: "submit-unknown" }, NOW + 60_001);
    expect(unknown.status).toBe("settlement-unknown");
    expect(() => transitionLedgerApproval(unknown, { type: "begin-submit" }, NOW + 60_002))
      .toThrow(/terminal/);
  });

  it("rejects double clicks, replay and invalid transition order", () => {
    const review = createLedgerApprovalState(timing, NOW);
    const signing = transitionLedgerApproval(review, { type: "begin-sign" }, NOW + 1);
    expect(() => transitionLedgerApproval(signing, { type: "begin-sign" }, NOW + 2))
      .toThrow(LedgerApprovalTransitionError);
    const rejected = transitionLedgerApproval(signing, { type: "user-rejected" }, NOW + 2);
    expect(() => transitionLedgerApproval(rejected, { type: "begin-sign" }, NOW + 3))
      .toThrow(/terminal/);
    expect(() => transitionLedgerApproval(review, { type: "submit-validated" }, NOW + 1))
      .toThrow(/Invalid approval transition/);
  });

  it("caps the signing timeout and validates timing inputs", () => {
    expect(() => createLedgerApprovalState({
      approvalExpiresAtMs: NOW + 1,
      signTimeoutMs: 300_001,
    }, NOW)).toThrow(LedgerApprovalTransitionError);
  });
});
