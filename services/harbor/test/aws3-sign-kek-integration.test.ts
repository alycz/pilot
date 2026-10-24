import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadKmsKekMock } = vi.hoisted(() => ({
  loadKmsKekMock: vi.fn(),
}));

vi.mock("../src/aws/kms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/aws/kms")>();
  return { ...actual, loadKmsKek: loadKmsKekMock };
});

import { createWrappedDelegateKeyWithCryptoKey } from "../src/exec/keys";
import { signDelegatedTransaction } from "../src/exec/sign";

const PRINCIPAL = "aws3-sign-test";
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

describe("AWS-3 delegated signing KEK integration", () => {
  let key: CryptoKey;

  beforeEach(async () => {
    loadKmsKekMock.mockReset();
    key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    loadKmsKekMock.mockResolvedValue(key);
  });

  async function signingFixture(mode: "off" | "kek" | "sign") {
    const identity = {
      principal: PRINCIPAL,
      owner: OWNER,
      network: "testnet" as const,
    };
    const wrapped = await createWrappedDelegateKeyWithCryptoKey(identity, key);
    const link = {
      id: "aws3-link",
      owner: OWNER,
      network: "testnet" as const,
      delegate: wrapped.address,
      delegateSeedEnc: wrapped.ciphertext,
      iv: wrapped.iv,
      permissions: ["OfferCancel"],
      status: "active" as const,
    };
    const request = vi.fn(async (_network: string, command: string) => {
      if (command === "account_info") {
        return { account_data: { Account: OWNER, Sequence: 7 } };
      }
      if (command === "fee") return { drops: { open_ledger_fee: "10" } };
      throw new Error(`Unexpected XRPL command: ${command}`);
    });
    return {
      input: {
        network: "testnet" as const,
        owner: OWNER,
        txJson: {
          TransactionType: "OfferCancel" as const,
          Account: OWNER,
          OfferSequence: 1,
          Fee: "12",
          Sequence: 7,
          LastLedgerSequence: 200,
        },
      },
      context: {
        principal: PRINCIPAL,
        env: {
          KMS_MODE: mode,
          HARBOR_KEK_CIPHERTEXT: Buffer.from(
            "noncredential ciphertext fixture",
          ).toString("base64"),
        },
        store: { getLink: vi.fn(async () => link) },
        xrplRpc: { request },
      },
    };
  }

  it("unwraps and signs through the KMS CryptoKey path without HARBOR_KEK", async () => {
    const fixture = await signingFixture("kek");

    const signed = await signDelegatedTransaction(
      fixture.context,
      fixture.input,
    );

    expect(signed.tx_blob).toMatch(/^[A-F0-9]+$/);
    expect(signed.hash).toMatch(/^[A-F0-9]{64}$/);
    expect(loadKmsKekMock).toHaveBeenCalledOnce();
    expect(loadKmsKekMock.mock.calls[0]?.[0]).not.toHaveProperty("HARBOR_KEK");
    expect(fixture.context.store.getLink).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to the KMS KEK in off mode", async () => {
    const fixture = await signingFixture("off");
    await expect(
      signDelegatedTransaction(fixture.context, fixture.input),
    ).rejects.toMatchObject({ code: "MISSING_KEK" });
    expect(loadKmsKekMock).not.toHaveBeenCalled();
  });

  it("rejects a local link rather than falling back in sign mode", async () => {
    const fixture = await signingFixture("sign");
    await expect(
      signDelegatedTransaction(fixture.context, fixture.input),
    ).rejects.toMatchObject({ code: "INVALID_LINK" });
    expect(loadKmsKekMock).not.toHaveBeenCalled();
  });
});
