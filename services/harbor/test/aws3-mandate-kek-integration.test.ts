import { describe, expect, it } from "vitest";

import {
  createWrappedMandateKeysWithCryptoKey,
  MandateKeyError,
  unwrapMandateViChain,
  unwrapMandateViChainWithCryptoKey,
  wrapMandateViChain,
  wrapMandateViChainWithCryptoKey,
} from "../src/exec/mandate-keys";

const identity = {
  principal: "aws3-mandate-test",
  owner: "rBudgetOwner",
  network: "testnet" as const,
  mandateId: "mandate-aws3",
};

const rawKek = new Uint8Array(32).fill(27);
const encodedKek = Buffer.from(rawKek).toString("base64");

async function kmsKek(extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    rawKek,
    "AES-GCM",
    extractable,
    ["encrypt", "decrypt"],
  );
}

function additionalData(purpose: "agent" | "claims" | "vi-chain") {
  return new TextEncoder().encode(
    JSON.stringify([
      identity.principal,
      identity.owner,
      identity.network,
      identity.mandateId,
      purpose,
    ]),
  );
}

describe("AWS-3 mandate CryptoKey integration", () => {
  it("wraps the MH2 agent and claim keys with a non-extractable KMS KEK", async () => {
    const key = await kmsKek();
    let index = 0;
    const result = await createWrappedMandateKeysWithCryptoKey(
      identity,
      ["merchant-a", "merchant-b"],
      key,
      {
        generateClaimWallet: () => ({
          publicKey: `EDPUBLIC${index}`,
          seed: `s-test-claim-${index++}`,
        }),
      },
    );

    expect(key).toMatchObject({
      type: "secret",
      extractable: false,
      algorithm: { name: "AES-GCM", length: 256 },
    });
    expect(result.agentPublicJwk).not.toHaveProperty("d");
    expect(result.claimPublicKeys).toEqual([
      { merchant_id: "merchant-a", public_key: "EDPUBLIC0" },
      { merchant_id: "merchant-b", public_key: "EDPUBLIC1" },
    ]);
    expect(JSON.stringify(result)).not.toContain("s-test-claim");

    const claimPlaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(result.claimKeysIv),
        additionalData: additionalData("claims"),
      },
      key,
      result.claimKeysCiphertext,
    );
    expect(JSON.parse(new TextDecoder().decode(claimPlaintext))).toEqual([
      { merchant_id: "merchant-a", seed: "s-test-claim-0" },
      { merchant_id: "merchant-b", seed: "s-test-claim-1" },
    ]);

    const agentPlaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(result.agentKeyIv),
        additionalData: additionalData("agent"),
      },
      key,
      result.agentKeyCiphertext,
    );
    expect(JSON.parse(new TextDecoder().decode(agentPlaintext))).toMatchObject({
      kty: "EC",
      crv: "P-256",
      d: expect.any(String),
    });
  });

  it("keeps string and CryptoKey VI wrapping interoperable with identical AAD", async () => {
    const key = await kmsKek();
    const presentation = { l1: "public-l1", l2: "public-l2" };

    const legacyWrapped = await wrapMandateViChain(
      identity,
      presentation,
      encodedKek,
    );
    await expect(
      unwrapMandateViChainWithCryptoKey(identity, legacyWrapped, key),
    ).resolves.toEqual(presentation);

    const kmsWrapped = await wrapMandateViChainWithCryptoKey(
      identity,
      presentation,
      key,
    );
    await expect(
      unwrapMandateViChain(identity, kmsWrapped, encodedKek),
    ).resolves.toEqual(presentation);
  });

  it("rejects the wrong mandate identity, wrong KEK, and extractable KEKs", async () => {
    const key = await kmsKek();
    const wrapped = await wrapMandateViChainWithCryptoKey(
      identity,
      { l1: "public-l1", l2: "public-l2" },
      key,
    );
    const wrongKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );

    await expect(
      unwrapMandateViChainWithCryptoKey(
        { ...identity, mandateId: "other-mandate" },
        wrapped,
        key,
      ),
    ).rejects.toMatchObject<Partial<MandateKeyError>>({ code: "WRAP_FAILED" });
    await expect(
      unwrapMandateViChainWithCryptoKey(identity, wrapped, wrongKey),
    ).rejects.toMatchObject<Partial<MandateKeyError>>({ code: "WRAP_FAILED" });

    const extractable = await kmsKek(true);
    await expect(
      createWrappedMandateKeysWithCryptoKey(
        identity,
        ["merchant-a"],
        extractable,
      ),
    ).rejects.toMatchObject<Partial<MandateKeyError>>({ code: "INVALID_KEK" });
  });
});
