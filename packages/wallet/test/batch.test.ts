import { describe, expect, it, vi } from "vitest";

import {
  MandateBatchError,
  createMandateSigningPlan,
  signMandateSetup,
  type MandateSigningPlan,
} from "../src/batch.js";

const BATCH = {
  TransactionType: "Batch",
  Account: "rOwner",
  RawTransactions: [{ RawTransaction: { TransactionType: "CredentialAccept" } }],
};

const SEQUENTIAL = [
  { TransactionType: "CredentialAccept", Account: "rOwner" },
  {
    TransactionType: "PaymentChannelCreate",
    Account: "rOwner",
    Destination: "rMerchantA",
  },
  {
    TransactionType: "PaymentChannelCreate",
    Account: "rOwner",
    Destination: "rMerchantB",
  },
];

function expectCode(code: string) {
  return expect.objectContaining({ name: "MandateBatchError", code });
}

describe("AP4M mandate setup signing", () => {
  it("selects exactly one Batch prompt when the provider supports Batch", async () => {
    const plan = createMandateSigningPlan("supported", {
      unsignedBatch: BATCH,
      unsignedSequential: SEQUENTIAL,
    });
    const wallet = {
      signOnly: vi.fn().mockResolvedValue("SIGNED_BATCH"),
    };

    await expect(signMandateSetup(plan, wallet)).resolves.toEqual({
      mode: "batch",
      signedBlobs: ["SIGNED_BATCH"],
    });
    expect(plan.promptCount).toBe(1);
    expect(wallet.signOnly).toHaveBeenCalledTimes(1);
    expect(wallet.signOnly).toHaveBeenCalledWith(BATCH);
  });

  it("selects sequential signing before prompting an unsupported provider", async () => {
    const plan = createMandateSigningPlan("unsupported", {
      unsignedBatch: BATCH,
      unsignedSequential: SEQUENTIAL,
    });
    const wallet = {
      signOnly: vi
        .fn()
        .mockResolvedValueOnce("SIGNED_CREDENTIAL")
        .mockResolvedValueOnce("SIGNED_CHANNEL_A")
        .mockResolvedValueOnce("SIGNED_CHANNEL_B"),
    };

    await expect(signMandateSetup(plan, wallet)).resolves.toEqual({
      mode: "sequential",
      signedBlobs: [
        "SIGNED_CREDENTIAL",
        "SIGNED_CHANNEL_A",
        "SIGNED_CHANNEL_B",
      ],
    });
    expect(plan.promptCount).toBe(3);
    expect(wallet.signOnly.mock.calls.map(([transaction]) => transaction)).toEqual(
      SEQUENTIAL,
    );
  });

  it("fails closed while provider Batch capability is unknown", () => {
    expect(() =>
      createMandateSigningPlan("unknown", {
        unsignedBatch: BATCH,
        unsignedSequential: SEQUENTIAL,
      }),
    ).toThrowError(expectCode("BATCH_CAPABILITY_UNKNOWN"));
  });

  it("requires the transaction set for the selected mode", () => {
    expect(() => createMandateSigningPlan("supported", {})).toThrowError(
      expectCode("BATCH_TRANSACTION_MISSING"),
    );
    expect(() => createMandateSigningPlan("unsupported", {})).toThrowError(
      expectCode("SEQUENTIAL_TRANSACTIONS_MISSING"),
    );
  });

  it("rejects a Batch disguised as a sequential transaction", () => {
    expect(() =>
      createMandateSigningPlan("unsupported", {
        unsignedSequential: [BATCH],
      }),
    ).toThrowError(expectCode("INVALID_TRANSACTION_SET"));
  });

  it("stops on the first cancelled prompt without retrying or switching mode", async () => {
    const cancellation = new Error("wallet cancelled");
    const plan = createMandateSigningPlan("unsupported", {
      unsignedSequential: SEQUENTIAL,
    });
    const wallet = {
      signOnly: vi
        .fn()
        .mockResolvedValueOnce("SIGNED_CREDENTIAL")
        .mockRejectedValueOnce(cancellation)
        .mockResolvedValueOnce("MUST_NOT_BE_REACHED"),
    };

    await expect(signMandateSetup(plan, wallet)).rejects.toBe(cancellation);
    expect(wallet.signOnly).toHaveBeenCalledTimes(2);
    expect(wallet.signOnly).not.toHaveBeenCalledWith(BATCH);
  });

  it("treats an uncertain provider result as terminal", async () => {
    const uncertain = Object.assign(new Error("provider state unknown"), {
      code: "SIGN_FAILED",
    });
    const plan = createMandateSigningPlan("supported", {
      unsignedBatch: BATCH,
      unsignedSequential: SEQUENTIAL,
    });
    const wallet = { signOnly: vi.fn().mockRejectedValue(uncertain) };

    await expect(signMandateSetup(plan, wallet)).rejects.toBe(uncertain);
    expect(wallet.signOnly).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed externally constructed plans before opening a prompt", async () => {
    const plan = {
      mode: "batch",
      promptCount: 2,
      transactions: [BATCH, BATCH],
    } as unknown as MandateSigningPlan;
    const wallet = { signOnly: vi.fn() };

    await expect(signMandateSetup(plan, wallet)).rejects.toEqual(
      expectCode("INVALID_TRANSACTION_SET"),
    );
    expect(wallet.signOnly).not.toHaveBeenCalled();
  });

  it("rejects an empty signed blob and never advances", async () => {
    const plan = createMandateSigningPlan("unsupported", {
      unsignedSequential: SEQUENTIAL,
    });
    const wallet = {
      signOnly: vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("NEXT"),
    };

    await expect(signMandateSetup(plan, wallet)).rejects.toBeInstanceOf(
      MandateBatchError,
    );
    expect(wallet.signOnly).toHaveBeenCalledTimes(1);
  });
});
