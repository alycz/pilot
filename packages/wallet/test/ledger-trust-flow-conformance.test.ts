import { decode, encode } from "xrpl";
import { describe, expect, it } from "vitest";

import { ledgerSigningMode } from "../src/ledger/clear-sign.js";
import {
  ledgerRuntimeProvenance,
  validateExactLedgerAction,
  type ExactLedgerActionExpectation,
} from "../src/ledger/exact-action.js";

const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const DESTINATION = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const NOW = 1_800_000_000_000;
const CONDITION =
  "A0258020E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855810100";
const FULFILLMENT = "A0028000";

const COMMON_EXPECTATION = {
  network: "testnet" as const,
  account: ACCOUNT,
  sequence: 42,
  validatedLedgerIndex: 9_000,
  maxLedgerWindow: 50,
  maxFeeDrops: "500",
  approvalExpiresAtMs: NOW + 60_000,
};

const COMMON_TRANSACTION = {
  Account: ACCOUNT,
  Sequence: 42,
  LastLedgerSequence: 9_050,
  SigningPubKey: "",
};

type OfflineConformanceFixture = Readonly<{
  name: string;
  expectation: ExactLedgerActionExpectation;
  transaction: Readonly<Record<string, unknown>>;
}>;

/**
 * Offline transaction-shape fixtures only. They contain no seed, private key,
 * signed blob, APDU, network receipt, or historical device evidence. Passing
 * them does not mean Speculos or a physical Ledger executed these actions.
 */
const FIXTURES: readonly OfflineConformanceFixture[] = [
  {
    name: "native-XRP Payment",
    expectation: {
      ...COMMON_EXPECTATION,
      kind: "payment",
      destination: DESTINATION,
      amountDrops: "2500000",
      destinationTag: 7,
    },
    transaction: {
      ...COMMON_TRANSACTION,
      TransactionType: "Payment",
      Destination: DESTINATION,
      DestinationTag: 7,
      Amount: "2500000",
      Fee: "12",
    },
  },
  {
    name: "bounded EscrowCreate",
    expectation: {
      ...COMMON_EXPECTATION,
      kind: "escrow-create",
      destination: DESTINATION,
      amountDrops: "1000000",
      finishAfter: 900_000_000,
      cancelAfter: 900_000_600,
      condition: CONDITION,
      destinationTag: 7,
    },
    transaction: {
      ...COMMON_TRANSACTION,
      TransactionType: "EscrowCreate",
      Destination: DESTINATION,
      DestinationTag: 7,
      Amount: "1000000",
      FinishAfter: 900_000_000,
      CancelAfter: 900_000_600,
      Condition: CONDITION,
      Fee: "12",
    },
  },
  {
    name: "conditioned EscrowFinish",
    expectation: {
      ...COMMON_EXPECTATION,
      kind: "escrow-finish",
      escrowId: { owner: DESTINATION, offerSequence: 7 },
      condition: CONDITION,
      fulfillment: FULFILLMENT,
    },
    transaction: {
      ...COMMON_TRANSACTION,
      TransactionType: "EscrowFinish",
      Owner: DESTINATION,
      OfferSequence: 7,
      Condition: CONDITION,
      Fulfillment: FULFILLMENT,
      Fee: "399",
    },
  },
  {
    name: "exact EscrowCancel",
    expectation: {
      ...COMMON_EXPECTATION,
      kind: "escrow-cancel",
      escrowId: { owner: DESTINATION, offerSequence: 7 },
    },
    transaction: {
      ...COMMON_TRANSACTION,
      TransactionType: "EscrowCancel",
      Owner: DESTINATION,
      OfferSequence: 7,
      Fee: "12",
    },
  },
] as const;

describe("offline Ledger trust-flow shapes (actual Speculos execution unrun)", () => {
  it.each(FIXTURES)("validates and binary-round-trips $name", async ({
    expectation,
    transaction,
  }) => {
    expect(ledgerSigningMode({ ...transaction })).toBe("clear");

    const original = await validateExactLedgerAction({
      transaction,
      expectation,
      provenance: ledgerRuntimeProvenance("speculos"),
      now: NOW,
    });
    const roundTripped = decode(encode(transaction as never)) as Record<string, unknown>;
    const decoded = await validateExactLedgerAction({
      transaction: roundTripped,
      expectation,
      provenance: ledgerRuntimeProvenance("speculos"),
      now: NOW,
    });

    expect(decoded.digest).toBe(original.digest);
    expect(decoded.provenance).toEqual({
      runtime: "speculos",
      signatureEvidence: "signing-key-control-only",
      physicalDeviceInferred: false,
      emulator: true,
    });
    expect(transaction).not.toHaveProperty("TxnSignature");
  });

  it("keeps each exact action bound to a distinct canonical digest", async () => {
    const digests = await Promise.all(FIXTURES.map(async ({ expectation, transaction }) =>
      (await validateExactLedgerAction({
        transaction,
        expectation,
        provenance: ledgerRuntimeProvenance("speculos"),
        now: NOW,
      })).digest
    ));
    expect(new Set(digests).size).toBe(FIXTURES.length);
  });

  it("does not convert an offline shape check into device or network evidence", () => {
    const provenance = ledgerRuntimeProvenance("speculos");
    expect(provenance.signatureEvidence).toBe("signing-key-control-only");
    expect(provenance.physicalDeviceInferred).toBe(false);
    expect(provenance.emulator).toBe(true);
  });
});
