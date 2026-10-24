import { describe, expect, it, vi } from "vitest";

import { createKmsDelegateKey, type KmsKeyLifecycleClient, type KmsSignRequest, type KmsSigningClient } from "../src/exec/kms-signer";
import { signDelegatedTransaction } from "../src/exec/sign";
import type { KmsLinkRow } from "../src/exec/store";
import { MemoryKeyStore } from "../tools/aws-local/src/key-store";
import { handleKms } from "../tools/aws-local/src/kms";

const PRINCIPAL = "aws4-sign-integration";
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function localClient(store: MemoryKeyStore): KmsKeyLifecycleClient & KmsSigningClient {
  return {
    createKey: (input) => handleKms("TrentService.CreateKey", input, store),
    createAlias: (input) => handleKms("TrentService.CreateAlias", input, store),
    tagResource: (input) => handleKms("TrentService.TagResource", input, store),
    getPublicKey: (input) => handleKms("TrentService.GetPublicKey", input, store),
    scheduleKeyDeletion: (input) => handleKms("TrentService.ScheduleKeyDeletion", input, store),
    sign: (input: KmsSignRequest) => handleKms("TrentService.Sign", input, store),
  };
}

describe("AWS-4 delegated signing integration", () => {
  it("signs through a stand-in KMS link without a local seed or KEK fallback", async () => {
    const keyStore = new MemoryKeyStore();
    const kmsClient = localClient(keyStore);
    const created = await createKmsDelegateKey({
      principal: PRINCIPAL,
      owner: OWNER,
      network: "testnet",
      linkId: "integration-link",
      client: kmsClient,
    });
    const link: KmsLinkRow = {
      id: "integration-link",
      principal: PRINCIPAL,
      owner: OWNER,
      network: "testnet",
      delegate: created.address,
      keyBackend: "kms",
      delegateSeedEnc: null,
      iv: null,
      kmsKeyId: created.keyId,
      kmsAlias: created.keyAlias,
      permissions: ["OfferCancel"],
      status: "active",
      lastLedger: null,
      revokeTx: null,
      createdAt: "2026-10-21T20:00:00.000Z",
    };
    const getLink = vi.fn(async () => link);
    const request = vi.fn(async (_network: string, command: string) => {
      if (command === "account_info") {
        return { account_data: { Account: OWNER, Sequence: 7 } };
      }
      if (command === "fee") return { drops: { open_ledger_fee: "10" } };
      throw new Error(`Unexpected XRPL command: ${command}`);
    });

    const signed = await signDelegatedTransaction(
      {
        principal: PRINCIPAL,
        env: { KMS_MODE: "sign" },
        store: { getLink },
        xrplRpc: { request },
        signingServices: { kmsClient },
      },
      {
        network: "testnet",
        owner: OWNER,
        txJson: {
          TransactionType: "OfferCancel",
          Account: OWNER,
          OfferSequence: 1,
          Fee: "12",
          Sequence: 7,
          LastLedgerSequence: 200,
        },
      },
    );

    expect(signed.tx_blob).toMatch(/^[A-F0-9]+$/);
    expect(signed.hash).toMatch(/^[A-F0-9]{64}$/);
    expect(getLink).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(signed)).not.toMatch(/seed|secret|private|credential/i);
  });

  it("fails closed when sign mode is given a local link", async () => {
    const localLink = {
      id: "legacy-local-link",
      principal: PRINCIPAL,
      owner: OWNER,
      network: "testnet" as const,
      delegate: "rD4gs512CwAsi1Z6JP7xJnt8DDutSiaQJm",
      keyBackend: "local" as const,
      delegateSeedEnc: new Uint8Array([1]).buffer,
      iv: new Uint8Array(12).buffer,
      kmsKeyId: null,
      kmsAlias: null,
      permissions: ["OfferCancel"],
      status: "active" as const,
      lastLedger: null,
      revokeTx: null,
      createdAt: "2026-10-21T20:00:00.000Z",
    };
    await expect(signDelegatedTransaction(
      {
        principal: PRINCIPAL,
        env: { KMS_MODE: "sign" },
        store: { getLink: vi.fn(async () => localLink) },
        xrplRpc: {
          request: vi.fn(async (_network: string, command: string) =>
            command === "account_info"
              ? { account_data: { Account: OWNER, Sequence: 7 } }
              : { drops: { open_ledger_fee: "10" } }),
        },
      },
      {
        network: "testnet",
        owner: OWNER,
        txJson: {
          TransactionType: "OfferCancel",
          Account: OWNER,
          OfferSequence: 1,
          Fee: "12",
          Sequence: 7,
          LastLedgerSequence: 200,
        },
      },
    )).rejects.toMatchObject({ code: "INVALID_LINK" });
  });
});
