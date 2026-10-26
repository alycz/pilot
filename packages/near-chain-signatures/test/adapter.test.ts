import { describe, expect, it, vi } from "vitest";

import {
  bindReviewedXrpPayment,
  createNearXrpChainSignaturesAdapter,
  formatXrpSignatureRequest,
  NEAR_CHAIN_SIGNATURES_TESTNET,
  type OfficialChainsigXrpPort,
  type PreparedXrpPayment,
  type XrpUnsignedTransaction,
} from "../src/index.js";

const OWNER = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const DESTINATION = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const PUBLIC_KEY = `02${"a".repeat(64)}`;
const PAYLOAD = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));

function unsignedTransaction(): XrpUnsignedTransaction {
  return {
    transaction: {
      TransactionType: "Payment",
      Account: OWNER,
      Destination: DESTINATION,
      Amount: "1000000",
      SigningPubKey: PUBLIC_KEY.toUpperCase(),
      Fee: "12",
      Sequence: 41,
      LastLedgerSequence: 9001,
    },
    signingPubKey: PUBLIC_KEY,
  };
}

function makePort(
  overrides: Partial<OfficialChainsigXrpPort> = {},
): OfficialChainsigXrpPort {
  return {
    deriveAddressAndPublicKey: vi.fn(async () => ({
      address: OWNER,
      publicKey: PUBLIC_KEY,
    })),
    prepareTransactionForSigning: vi.fn(async () => ({
      transaction: unsignedTransaction(),
      hashesToSign: [PAYLOAD],
    })),
    serializeTransaction: vi.fn((transaction) => JSON.stringify(transaction)),
    deserializeTransaction: vi.fn(
      (serialized) => JSON.parse(serialized) as XrpUnsignedTransaction,
    ),
    finalizeTransactionSigning: vi.fn(({ transaction }) =>
      JSON.stringify({
        ...transaction.transaction,
        TxnSignature: "30AABB",
      }),
    ),
    ...overrides,
  };
}

function makeAdapter(port = makePort()) {
  return {
    port,
    adapter: createNearXrpChainSignaturesAdapter({
      createOfficialXrp: () => port,
    }),
  };
}

async function prepare(port = makePort()): Promise<{
  port: OfficialChainsigXrpPort;
  prepared: PreparedXrpPayment;
}> {
  const adapter = createNearXrpChainSignaturesAdapter({
    createOfficialXrp: () => port,
  });
  return {
    port,
    prepared: await adapter.prepareXrpPayment({
      nearAccountId: "owner.testnet",
      derivationPath: "pilot:xrp:testnet:v1:owner-1",
      destinationXrpAddress: DESTINATION,
      amountDrops: "1000000",
      maxFeeDrops: "20",
    }),
  };
}

function approve(prepared: PreparedXrpPayment) {
  return bindReviewedXrpPayment(prepared, {
    nearAccountId: "owner.testnet",
    approvedReviewBinding: prepared.reviewBinding,
    approvedAt: "2026-10-26T12:00:00Z",
    approvalReference: "wallet-review-42",
  });
}

describe("NEAR/XRP Chain Signatures compatibility boundary", () => {
  it("constructs the official port only through the internally pinned config", () => {
    const port = makePort();
    const createOfficialXrp = vi.fn(() => port);
    createNearXrpChainSignaturesAdapter({ createOfficialXrp });
    expect(createOfficialXrp).toHaveBeenCalledExactlyOnceWith(
      NEAR_CHAIN_SIGNATURES_TESTNET,
    );
  });

  it("uses only the narrow official XRP preparation surface", async () => {
    const { port, prepared } = await prepare();
    expect(port.prepareTransactionForSigning).toHaveBeenCalledWith({
      from: OWNER,
      to: DESTINATION,
      amount: "1000000",
      publicKey: PUBLIC_KEY,
    });
    expect(port.deriveAddressAndPublicKey).toHaveBeenCalledWith(
      "owner.testnet",
      "pilot:xrp:testnet:v1:owner-1",
    );
    expect(prepared.review).toMatchObject({
      nearNetwork: "testnet",
      xrpNetwork: "testnet",
      contractId: "v1.signer-prod.testnet",
      from: OWNER,
      to: DESTINATION,
      amountDrops: "1000000",
      feeDrops: "12",
      maxFeeDrops: "20",
      sequence: 41,
      lastLedgerSequence: 9001,
      payloadHex: Array.from(PAYLOAD, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    });
    expect(prepared.reviewBinding).toContain(prepared.review.payloadHex);
    const bindingParts = JSON.parse(prepared.reviewBinding) as string[];
    expect(bindingParts.at(-1)).toBe(prepared.review.serializedUnsignedTransaction);
  });

  it.each([
    ["mainnet NEAR account", { nearAccountId: "owner.near" }],
    ["unseparated path", { derivationPath: "xrp-1" }],
    ["mainnet-labelled path", { derivationPath: "pilot:xrp:mainnet:v1:owner" }],
    ["zero amount", { amountDrops: "0" }],
    ["zero fee maximum", { maxFeeDrops: "0" }],
    ["decimal amount", { amountDrops: "1.5" }],
    ["invalid destination", { destinationXrpAddress: "not-an-address" }],
    ["self-payment", { destinationXrpAddress: OWNER }],
  ])("rejects %s before calling chainsig.js", async (_label, patch) => {
    const { port, adapter } = makeAdapter();
    await expect(
      adapter.prepareXrpPayment({
        nearAccountId: "owner.testnet",
        derivationPath: "pilot:xrp:testnet:v1:owner-1",
        destinationXrpAddress: DESTINATION,
        amountDrops: "1000000",
        maxFeeDrops: "20",
        ...patch,
      }),
    ).rejects.toThrow();
    expect(port.prepareTransactionForSigning).not.toHaveBeenCalled();
  });

  it("fails closed when chainsig.js changes an exact reviewed field", async () => {
    const port = makePort({
      serializeTransaction: vi.fn((transaction) =>
        JSON.stringify({
          ...transaction,
          transaction: { ...transaction.transaction, Amount: "2000000" },
        }),
      ),
    });
    await expect(prepare(port)).rejects.toThrow(
      "prepared XRP transaction changed reviewed field: Amount",
    );
  });

  it("uses only the XRP identity derived by chainsig.js", async () => {
    const port = makePort({
      deriveAddressAndPublicKey: vi.fn(async () => ({
        address: "not-an-xrp-address",
        publicKey: PUBLIC_KEY,
      })),
    });
    await expect(prepare(port)).rejects.toThrow("derived owner XRP address");
    expect(port.prepareTransactionForSigning).not.toHaveBeenCalled();
  });

  it("rejects fees above the reviewed maximum and unmodeled transaction fields", async () => {
    const excessiveFee = makePort({
      prepareTransactionForSigning: vi.fn(async () => ({
        transaction: {
          ...unsignedTransaction(),
          transaction: { ...unsignedTransaction().transaction, Fee: "21" },
        },
        hashesToSign: [PAYLOAD],
      })),
    });
    await expect(prepare(excessiveFee)).rejects.toThrow(
      "fee exceeds the reviewed maximum",
    );

    const extraField = makePort({
      prepareTransactionForSigning: vi.fn(async () => ({
        transaction: {
          ...unsignedTransaction(),
          transaction: {
            ...unsignedTransaction().transaction,
            DestinationTag: 123,
          },
        },
        hashesToSign: [PAYLOAD],
      })),
    });
    await expect(prepare(extraField)).rejects.toThrow(
      "added an unreviewed field: DestinationTag",
    );
  });

  it("requires exactly one 32-byte signing payload", async () => {
    for (const hashesToSign of [[], [new Uint8Array(31)], [PAYLOAD, PAYLOAD]]) {
      const port = makePort({
        prepareTransactionForSigning: vi.fn(async () => ({
          transaction: unsignedTransaction(),
          hashesToSign,
        })),
      });
      await expect(prepare(port)).rejects.toThrow(
        /exactly one (32-byte XRP signing payload|XRP signing payload)/,
      );
    }
  });

  it.each([
    ["Fee", { Fee: undefined }],
    ["Sequence", { Sequence: undefined }],
    ["LastLedgerSequence", { LastLedgerSequence: undefined }],
  ])("requires an autofilled %s", async (_field, transactionPatch) => {
    const port = makePort({
      prepareTransactionForSigning: vi.fn(async () => ({
        transaction: {
          ...unsignedTransaction(),
          transaction: {
            ...unsignedTransaction().transaction,
            ...transactionPatch,
          },
        },
        hashesToSign: [PAYLOAD],
      })),
    });
    await expect(prepare(port)).rejects.toThrow(/prepared XRP transaction must include/);
  });
});

describe("exact review binding and signature request", () => {
  it("formats only the reviewed NEAR testnet function call", async () => {
    const { prepared } = await prepare();
    const request = formatXrpSignatureRequest(approve(prepared));
    expect(request).toEqual({
      kind: "near-wallet-function-call/xrp-payment-v1",
      signerId: "owner.testnet",
      receiverId: "v1.signer-prod.testnet",
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "sign",
            args: {
              request: {
                payload_v2: { Ecdsa: prepared.review.payloadHex },
                path: "pilot:xrp:testnet:v1:owner-1",
                domain_id: 0,
              },
            },
            gas: "300000000000000",
            depositYoctoNear: "1",
          },
        },
      ],
      reviewBinding: prepared.reviewBinding,
    });
    expect(request.actions[0].params.gas).not.toBe(prepared.review.amountDrops);
  });

  it("rejects a mismatched binding, signer, time, or absent review reference", async () => {
    const { prepared } = await prepare();
    const base = {
      nearAccountId: "owner.testnet",
      approvedReviewBinding: prepared.reviewBinding,
      approvedAt: "2026-10-26T12:00:00Z",
      approvalReference: "review-1",
    };
    expect(() =>
      bindReviewedXrpPayment(prepared, {
        ...base,
        approvedReviewBinding: `${prepared.reviewBinding}-changed`,
      }),
    ).toThrow("does not match the exact reviewed XRP payment");
    expect(() =>
      bindReviewedXrpPayment(prepared, {
        ...base,
        nearAccountId: "other.testnet",
      }),
    ).toThrow("does not match the signer");
    expect(() =>
      bindReviewedXrpPayment(prepared, { ...base, approvedAt: "yesterday" }),
    ).toThrow("approvedAt");
    expect(() =>
      bindReviewedXrpPayment(prepared, { ...base, approvalReference: " " }),
    ).toThrow("approvalReference");
  });

  it("rejects forged prepared and review-bound objects", async () => {
    const { prepared } = await prepare();
    const forgedPrepared = { ...prepared };
    expect(() =>
      bindReviewedXrpPayment(forgedPrepared, {
        nearAccountId: "owner.testnet",
        approvedReviewBinding: prepared.reviewBinding,
        approvedAt: "2026-10-26T12:00:00Z",
        approvalReference: "forged",
      }),
    ).toThrow("must originate from this process's bounded adapter");

    const bound = approve(prepared);
    expect(() => formatXrpSignatureRequest({ ...bound })).toThrow(
      "must originate from this process's bounded adapter",
    );
  });
});

describe("signature application boundary", () => {
  it("delegates DER formatting to chainsig.js and never submits XRP", async () => {
    const port = makePort();
    const { prepared } = await prepare(port);
    const adapter = createNearXrpChainSignaturesAdapter({
      createOfficialXrp: () => port,
    });
    const result = adapter.applyXrpMpcSignature(approve(prepared), [
      { r: "1".repeat(64), s: "2".repeat(64), v: 0 },
    ]);
    expect(port.finalizeTransactionSigning).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      xrpSubmissionStatus: "not-submitted",
      externalStateStatus: "not-validated",
    });
    expect(result.signedTransaction).toContain('"TxnSignature":"30AABB"');
    expect("broadcastTx" in adapter).toBe(false);
  });

  it("rejects zero, multiple, or malformed signatures", async () => {
    const { port, prepared } = await prepare();
    const adapter = createNearXrpChainSignaturesAdapter({
      createOfficialXrp: () => port,
    });
    const bound = approve(prepared);
    expect(() => adapter.applyXrpMpcSignature(bound, [])).toThrow("exactly one");
    expect(() =>
      adapter.applyXrpMpcSignature(bound, [
        { r: "1".repeat(64), s: "2".repeat(64), v: 0 },
        { r: "3".repeat(64), s: "4".repeat(64), v: 1 },
      ]),
    ).toThrow("exactly one");
    expect(() =>
      adapter.applyXrpMpcSignature(bound, [
        { r: "short", s: "2".repeat(64), v: 0 },
      ]),
    ).toThrow("signature r");
  });

  it("rejects finalization that changes or adds transaction fields", async () => {
    for (const signed of [
      { ...unsignedTransaction().transaction, Amount: "2000000", TxnSignature: "30AA" },
      { ...unsignedTransaction().transaction, Memo: "unreviewed", TxnSignature: "30AA" },
    ]) {
      const port = makePort({
        finalizeTransactionSigning: vi.fn(() => JSON.stringify(signed)),
      });
      const { prepared } = await prepare(port);
      const adapter = createNearXrpChainSignaturesAdapter({
        createOfficialXrp: () => port,
      });
      expect(() =>
        adapter.applyXrpMpcSignature(approve(prepared), [
          { r: "1".repeat(64), s: "2".repeat(64), v: 0 },
        ]),
      ).toThrow(/changed reviewed field|added an unreviewed field/);
    }
  });
});
