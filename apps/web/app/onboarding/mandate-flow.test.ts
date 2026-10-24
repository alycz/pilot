import { webcrypto } from "node:crypto";

import { createHarborRestClient } from "@pilot/harbor-client";
import { describe, expect, it, vi } from "vitest";

import { sha256Hex, type DeviceKeyStore, type StoredDeviceKey } from "../../lib/vi";

import {
  approveAndRegisterMandate,
  mandateChannelPreviews,
  prepareMandateDraft,
  walletBatchCapability,
  type MandateDraft,
} from "./mandate-flow";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const HASH = "A".repeat(64);
const MEMO_TYPE = Buffer.from("ap4m/l2").toString("hex").toUpperCase();

class MemoryStore implements DeviceKeyStore {
  value?: StoredDeviceKey;
  async get() { return this.value; }
  async put(value: StoredDeviceKey) { this.value = value; }
}

function setupTx(type: string) {
  return {
    TransactionType: type,
    Memos: [{ Memo: { MemoType: MEMO_TYPE, MemoData: "0".repeat(64) } }],
  };
}

function draft(): MandateDraft {
  return {
    claimPublicKeys: [
      { merchant_id: "venue-yield-desk", public_key: "ED" + "1".repeat(64) },
    ],
    constraints: {
      currency: "USD",
      per_payment_max: "5.00",
      daily_max: "10.00",
      total_max: "25.00",
      payees: ["venue-yield-desk"],
    },
    expiresAt: "2026-10-22T08:00:00.000Z",
    l1: "l1~",
    l1Digest: "1".repeat(64),
    l2: "l2~",
    l2Digest: "2".repeat(64),
    mandateId: "mandate-1",
    notBefore: "2026-10-21T08:00:00.000Z",
    owner: OWNER,
    unsignedBatch: setupTx("Batch"),
    unsignedSequential: [setupTx("CredentialAccept")],
  };
}

describe("MP3 mandate onboarding flow", () => {
  it("mock Check: explicit approval completes prepared onboarding to ACTIVE", async () => {
    const cryptoImpl = webcrypto as Crypto;
    const harbor = createHarborRestClient({ mock: true });
    const preparationOrder: string[] = [];
    const prepared = await prepareMandateDraft(
      {
        audience: "https://harbor.mock",
        constraints: {
          currency: "USD",
          per_payment_max: "5.00",
          daily_max: "10.00",
          total_max: "25.00",
          payees: ["venue-yield-desk"],
        },
        expiresAt: "2026-10-22T08:00:00.000Z",
        ofVerification: {
          customer_ref_hash: "b".repeat(64),
          owner_name_hash: "a".repeat(64),
          verified: true,
        },
        owner: OWNER,
      },
      {
        crypto: cryptoImpl,
        deviceKeyStore: new MemoryStore(),
        now: new Date("2026-10-21T12:00:00.000Z"),
        issueL1: vi.fn(async () => {
          preparationOrder.push("l1");
          return {
            digest: await sha256Hex("fixture-l1~", cryptoImpl),
            l1: "fixture-l1~",
          };
        }),
        prepare: vi.fn(async (input) => {
          preparationOrder.push("mandate.prepare");
          const response = await harbor.op("mandate.prepare", input);
          if (!response.ok) throw new Error(response.error.message);
          return response.data;
        }),
      },
    );
    expect(
      mandateChannelPreviews(prepared, [
        {
          credentialIssuer: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
          credentialTypeHex: "4150344D2D4167656E74",
          id: "venue-yield-desk",
          name: "Venue Yield Desk",
          xrplAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        },
      ]),
    ).toHaveLength(1);
    const wallet = { signOnly: vi.fn(async () => "1200002280000000") };
    const submit = vi.fn(async (txBlob: string) => {
      const response = await harbor.op("tx.submit", { tx_blob: txBlob, network: "testnet" });
      if (!response.ok) throw new Error(response.error.message);
      return "status" in response.data
        ? { status: "failed" as const }
        : { hash: response.data.hash, status: "validated" as const };
    });
    const register = vi.fn(async (input) => {
      const response = await harbor.op("mandate.register", input);
      if (!response.ok) throw new Error(response.error.message);
      return response.data;
    });

    // Calling this function models the user's explicit click on the approval card.
    const result = await approveAndRegisterMandate(prepared, "supported", {
      register,
      submit,
      wallet,
    });

    expect(wallet.signOnly).toHaveBeenCalledTimes(1);
    expect(preparationOrder).toEqual(["mandate.prepare", "l1"]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
    expect(result.mandate.status).toBe("ACTIVE");
  });

  it("prepares a bound autonomous L2 without exporting the device private key", async () => {
    const cryptoImpl = webcrypto as Crypto;
    const issueL1 = vi.fn(async (input: { device_public_jwk: JsonWebKey }) => ({
      l1: "fixture-l1~",
      digest: await sha256Hex("fixture-l1~", cryptoImpl),
      public: input.device_public_jwk,
    }));
    const prepared = await prepareMandateDraft(
      {
        audience: "https://harbor.test",
        constraints: {
          currency: "USD",
          per_payment_max: "5.00",
          daily_max: "10.00",
          total_max: "25.00",
          payees: ["venue-yield-desk"],
          skus: ["yield-report"],
        },
        expiresAt: "2026-10-22T08:00:00.000Z",
        ofVerification: {
          customer_ref_hash: "b".repeat(64),
          owner_name_hash: "a".repeat(64),
          verified: true,
        },
        owner: OWNER,
      },
      {
        crypto: cryptoImpl,
        deviceKeyStore: new MemoryStore(),
        now: new Date("2026-10-21T12:00:00.000Z"),
        issueL1,
        prepare: vi.fn(async () => ({
          mandate_id: "mandate-1",
          agent_public_jwk: {
            kty: "EC",
            crv: "P-256",
            x: "agent-public-x",
            y: "agent-public-y",
          },
          claim_public_keys: [],
          unsigned_batch: setupTx("Batch"),
          unsigned_sequential: [setupTx("CredentialAccept")],
        })),
      },
    );
    expect(prepared.l2).toContain("~");
    expect(prepared.l2Digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(issueL1.mock.calls)).not.toMatch(/"d"|privateKey/);
    expect(
      ((prepared.unsignedBatch.Memos as Array<{ Memo: { MemoData: string } }>)[0]!
        .Memo.MemoData),
    ).toBe(prepared.l2Digest.toUpperCase());
  });

  it("rejects an issuer-supplied L1 digest that does not match the compact intent", async () => {
    await expect(
      prepareMandateDraft(
        {
          audience: "https://harbor.test",
          constraints: {
            currency: "USD",
            daily_max: "10.00",
            payees: ["venue-yield-desk"],
            per_payment_max: "5.00",
            total_max: "25.00",
          },
          expiresAt: "2026-10-22T08:00:00.000Z",
          ofVerification: {
            customer_ref_hash: "b".repeat(64),
            owner_name_hash: "a".repeat(64),
            verified: true,
          },
          owner: OWNER,
        },
        {
          crypto: webcrypto as Crypto,
          deviceKeyStore: new MemoryStore(),
          issueL1: vi.fn(async () => ({
            digest: "0".repeat(64),
            l1: "fixture-l1~",
          })),
          now: new Date("2026-10-21T12:00:00.000Z"),
          prepare: vi.fn(async () => ({
            agent_public_jwk: {
              crv: "P-256",
              kty: "EC",
              x: "agent-public-x",
              y: "agent-public-y",
            },
            claim_public_keys: [],
            mandate_id: "mandate-1",
            unsigned_batch: setupTx("Batch"),
          })),
        },
      ),
    ).rejects.toThrow("digest does not match");
  });

  it("uses exactly one signOnly prompt, submits once, then registers ACTIVE", async () => {
    const wallet = { signOnly: vi.fn(async () => "SIGNED_BATCH") };
    const submit = vi.fn(async () => ({ status: "validated" as const, hash: HASH }));
    const register = vi.fn(async (input: { setup_tx_hash: string | string[] }) => ({
      id: "mandate-1",
      owner: OWNER,
      network: "testnet" as const,
      status: "ACTIVE" as const,
      execution_type: "DEFERRED" as const,
      not_before: "2026-10-21T08:00:00.000Z",
      expires_at: "2026-10-22T08:00:00.000Z",
      constraints: draft().constraints,
      agent_public_jwk: {},
      l1_digest: "1".repeat(64),
      l2_digest: "2".repeat(64),
      setup_batch_hash: Array.isArray(input.setup_tx_hash)
        ? input.setup_tx_hash.join(",")
        : input.setup_tx_hash,
      channels: [],
      spent_usd: "0",
    }));
    const result = await approveAndRegisterMandate(draft(), "supported", {
      wallet,
      submit,
      register,
    });
    expect(wallet.signOnly).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ setup_tx_hash: HASH }),
    );
    expect(result.mandate.status).toBe("ACTIVE");
  });

  it("submits a selected sequential plan in order and registers its ordered hashes", async () => {
    const value = draft();
    value.unsignedSequential = [
      setupTx("CredentialAccept"),
      setupTx("PaymentChannelCreate"),
    ];
    const hashes = ["B".repeat(64), "C".repeat(64)];
    const wallet = {
      signOnly: vi
        .fn()
        .mockResolvedValueOnce("SIGNED_CREDENTIAL")
        .mockResolvedValueOnce("SIGNED_CHANNEL"),
    };
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ status: "validated" as const, hash: hashes[0] })
      .mockResolvedValueOnce({ status: "validated" as const, hash: hashes[1] });
    const register = vi.fn(async (input: { setup_tx_hash: string | string[] }) => ({
      agent_public_jwk: {},
      channels: [],
      constraints: value.constraints,
      execution_type: "DEFERRED" as const,
      expires_at: value.expiresAt,
      id: value.mandateId,
      l1_digest: value.l1Digest,
      l2_digest: value.l2Digest,
      network: "testnet" as const,
      not_before: value.notBefore,
      owner: OWNER,
      setup_batch_hash: Array.isArray(input.setup_tx_hash)
        ? input.setup_tx_hash.join(",")
        : input.setup_tx_hash,
      spent_usd: "0",
      status: "ACTIVE" as const,
    }));

    const result = await approveAndRegisterMandate(value, "unsupported", {
      register,
      submit,
      wallet,
    });

    expect(wallet.signOnly).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls.map(([blob]) => blob)).toEqual([
      "SIGNED_CREDENTIAL",
      "SIGNED_CHANNEL",
    ]);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ setup_tx_hash: hashes }),
    );
    expect(result.setupTxHashes).toEqual(hashes);
  });

  it("stops sequential submission at the first nonvalidated result without fallback", async () => {
    const value = draft();
    value.unsignedSequential = [
      setupTx("CredentialAccept"),
      setupTx("PaymentChannelCreate"),
    ];
    const wallet = {
      signOnly: vi
        .fn()
        .mockResolvedValueOnce("SIGNED_CREDENTIAL")
        .mockResolvedValueOnce("SIGNED_CHANNEL"),
    };
    const submit = vi.fn(async () => ({
      status: "pending" as const,
      hash: "B".repeat(64),
    }));
    const register = vi.fn();

    await expect(
      approveAndRegisterMandate(value, "unsupported", {
        register,
        submit,
        wallet,
      }),
    ).rejects.toThrow("will not retry automatically");

    expect(wallet.signOnly).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
  });

  it("does not retry or register an uncertain submission", async () => {
    const wallet = { signOnly: vi.fn(async () => "SIGNED_BATCH") };
    const submit = vi.fn(async () => ({ status: "pending" as const, hash: HASH }));
    const register = vi.fn();
    await expect(
      approveAndRegisterMandate(draft(), "supported", { wallet, submit, register }),
    ).rejects.toThrow("will not retry automatically");
    expect(wallet.signOnly).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
  });

  it("only declares proven dev-signer Batch support", () => {
    expect(walletBatchCapability("dev")).toBe("supported");
    expect(walletBatchCapability("gemwallet")).toBe("unsupported");
  });

  it("derives public channel locks from the prepared Batch", () => {
    const value = draft();
    const cancelAfter =
      Math.floor(Date.parse(value.expiresAt) / 1_000) - 946_684_800 + 86_400;
    value.unsignedBatch = {
      TransactionType: "Batch",
      Account: OWNER,
      Flags: 0x0001_0000,
      RawTransactions: [
        {
          RawTransaction: {
            TransactionType: "CredentialAccept",
            Account: OWNER,
            CredentialType: "4150344D2D4167656E74",
            Fee: "0",
            Flags: 0x4000_0000,
            Issuer: "rCredentialIssuer",
            SigningPubKey: "",
          },
        },
        {
          RawTransaction: {
            TransactionType: "PaymentChannelCreate",
            Account: OWNER,
            Amount: "25000000",
            CancelAfter: cancelAfter,
            Destination: "rMerchant",
            Fee: "0",
            Flags: 0x4000_0000,
            PublicKey: "ED" + "1".repeat(64),
            SettleDelay: 3_600,
            SigningPubKey: "",
          },
        },
      ],
      Memos: [],
    };
    value.unsignedSequential = undefined;
    const merchants = [
      {
        credentialIssuer: "rCredentialIssuer",
        credentialTypeHex: "4150344D2D4167656E74",
        id: "venue-yield-desk",
        name: "Venue Yield Desk",
        xrplAddress: "rMerchant",
      },
    ];
    expect(
      mandateChannelPreviews(value, merchants),
    ).toEqual([
      {
        amountDrops: "25000000",
        lockedUntil: "2026-10-23T08:00:00.000Z",
        merchantId: "venue-yield-desk",
        merchantName: "Venue Yield Desk",
      },
    ]);

    value.unsignedSequential = [
      {
        Account: OWNER,
        CredentialType: "4150344D2D4167656E74",
        Issuer: "rCredentialIssuer",
        TransactionType: "CredentialAccept",
      },
      {
        Account: OWNER,
        Amount: "25000000",
        CancelAfter: cancelAfter,
        Destination: "rMerchant",
        PublicKey: "ED" + "1".repeat(64),
        SettleDelay: 3_600,
        TransactionType: "PaymentChannelCreate",
      },
    ];
    expect(mandateChannelPreviews(value, merchants)).toHaveLength(1);
    value.unsignedSequential[1]!.Amount = "99999999";
    expect(() => mandateChannelPreviews(value, merchants)).toThrow(
      "Prepared sequential channel does not match merchant venue-yield-desk",
    );
    value.unsignedSequential = undefined;

    const channel = (
      value.unsignedBatch.RawTransactions as Array<{
        RawTransaction: Record<string, unknown>;
      }>
    )[1]!.RawTransaction;
    channel.Amount = "99999999";
    expect(() => mandateChannelPreviews(value, merchants)).toThrow(
      "does not match merchant",
    );
    channel.Amount = "25000000";
    channel.Destination = "rWrongMerchant";
    expect(() => mandateChannelPreviews(value, merchants)).toThrow(
      "does not match merchant",
    );
    channel.Destination = "rMerchant";
    channel.CancelAfter = cancelAfter - 1;
    expect(() => mandateChannelPreviews(value, merchants)).toThrow(
      "does not match merchant",
    );
    (
      value.unsignedBatch.RawTransactions as Array<{
        RawTransaction: Record<string, unknown>;
      }>
    ).pop();
    expect(() => mandateChannelPreviews(value, merchants)).toThrow(
      "wrong credential or channel count",
    );
  });
});
