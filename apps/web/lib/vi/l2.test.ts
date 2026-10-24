import { webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadOrCreateDeviceKey, type DeviceKeyStore, type StoredDeviceKey } from "./device-key";
import { arrayBuffer, sha256Base64Url, utf8 } from "./encoding";
import {
  bindL2DigestToBatch,
  bindL2DigestToSetup,
  buildAutonomousL2,
} from "./l2";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const MEMO_TYPE = Buffer.from("ap4m/l2", "utf8").toString("hex").toUpperCase();

class MemoryStore implements DeviceKeyStore {
  value?: StoredDeviceKey;
  async get(): Promise<StoredDeviceKey | undefined> {
    return this.value;
  }
  async put(value: StoredDeviceKey): Promise<void> {
    this.value = value;
  }
}

function decode(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

function disclosure(value: string): [string, Record<string, unknown>] {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as [string, Record<string, unknown>];
}

describe("pinned VI v0.1 AP4M autonomous L2", () => {
  it("binds the L1, mandate nonce, audience, agent key, and exact constraints", async () => {
    const cryptoImpl = webcrypto as Crypto;
    const device = await loadOrCreateDeviceKey(new MemoryStore(), cryptoImpl);
    const agentPair = (await cryptoImpl.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const agentPublicJwk = await cryptoImpl.subtle.exportKey("jwk", agentPair.publicKey);
    const l1 = "fixture-l1-sd-jwt~";
    const built = await buildAutonomousL2(
      {
        agentPublicJwk,
        audience: "https://harbor.test",
        constraints: {
          currency: "USD",
          per_payment_max: "5.00",
          daily_max: "10.00",
          total_max: "25.00",
          payees: ["merchant-a"],
          skus: ["sku-a"],
        },
        deviceKeyId: device.kid,
        devicePrivateKey: device.privateKey,
        expiresAt: "2026-10-22T08:00:00.000Z",
        l1,
        mandateId: "00000000-0000-4000-8000-000000000002",
        notBefore: "2026-10-21T08:00:00.000Z",
        owner: OWNER,
      },
      { crypto: cryptoImpl, now: new Date("2026-10-21T12:00:00.000Z") },
    );

    const [jwt, ...encodedDisclosures] = built.l2.split("~").filter(Boolean);
    const [headerSegment, payloadSegment, signatureSegment] = jwt!.split(".");
    const header = decode(headerSegment!);
    const payload = decode(payloadSegment!);
    expect(header).toEqual({
      alg: "ES256",
      typ: "kb-sd-jwt+kb",
      kid: device.kid,
    });
    expect(payload).toMatchObject({
      nonce: "00000000-0000-4000-8000-000000000002",
      aud: "https://harbor.test",
      iat: 1_792_584_000,
      exp: 1_792_656_000,
      iss: OWNER,
      sd_hash: await sha256Base64Url(l1, cryptoImpl),
      _sd_alg: "sha-256",
    });
    const verificationKey = await cryptoImpl.subtle.importKey(
      "jwk",
      device.publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await cryptoImpl.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verificationKey,
        Buffer.from(signatureSegment!, "base64url"),
        arrayBuffer(utf8(`${headerSegment}.${payloadSegment}`)),
      ),
    ).toBe(true);

    const decoded = encodedDisclosures.map(disclosure);
    const allowedDigests = new Set(payload._sd as string[]);
    const disclosuresByDigest = new Map<string, Record<string, unknown>>();
    for (const encoded of encodedDisclosures) {
      const digest = await sha256Base64Url(encoded, cryptoImpl);
      expect(allowedDigests.has(digest)).toBe(true);
      disclosuresByDigest.set(digest, disclosure(encoded)[1]);
    }
    const delegates = (payload.delegate_payload as Array<{ "...": string }>).map(
      (reference) => disclosuresByDigest.get(reference["..."]),
    );
    expect(delegates.map((value) => value?.vct)).toEqual([
      "mandate.checkout.open",
      "mandate.payment.open",
    ]);
    const checkout = decoded.find(([, value]) => value.vct === "mandate.checkout.open")?.[1];
    const payment = decoded.find(([, value]) => value.vct === "mandate.payment.open")?.[1];
    expect(checkout).toMatchObject({
      cnf: { jwk: { kty: "EC", crv: "P-256", x: agentPublicJwk.x, y: agentPublicJwk.y } },
    });
    expect(payment).toMatchObject({
      payment_instrument: { type: "xrpl.ap4m", id: OWNER },
      cnf: { jwk: { kty: "EC", crv: "P-256", x: agentPublicJwk.x, y: agentPublicJwk.y } },
    });
    const paymentConstraints = payment?.constraints as Array<Record<string, unknown>>;
    expect(paymentConstraints).toContainEqual({
      type: "payment.amount",
      currency: "USD",
      min: 0,
      max: 500,
    });
    expect(paymentConstraints).toContainEqual({
      type: "payment.budget",
      currency: "USD",
      max: 2500,
      pilot_daily_max: 1000,
    });
    const checkoutEncoded = encodedDisclosures.find(
      (encoded) => disclosure(encoded)[1].vct === "mandate.checkout.open",
    );
    expect(paymentConstraints).toContainEqual({
      type: "payment.reference",
      conditional_transaction_id: await sha256Base64Url(
        checkoutEncoded!,
        cryptoImpl,
      ),
    });
    expect(JSON.stringify(decoded)).not.toContain('"d"');
    expect(built.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects silent monetary rounding and signing outside the mandate window", async () => {
    const cryptoImpl = webcrypto as Crypto;
    const device = await loadOrCreateDeviceKey(new MemoryStore(), cryptoImpl);
    const publicJwk = device.publicJwk;
    const base = {
      agentPublicJwk: publicJwk,
      audience: "https://harbor.test",
      constraints: {
        currency: "USD" as const,
        per_payment_max: "1.001",
        daily_max: "2.00",
        total_max: "3.00",
        payees: ["merchant-a"],
      },
      deviceKeyId: device.kid,
      devicePrivateKey: device.privateKey,
      expiresAt: "2026-10-22T08:00:00.000Z",
      l1: "fixture~",
      mandateId: "m-1",
      notBefore: "2026-10-21T08:00:00.000Z",
      owner: OWNER,
    };
    await expect(
      buildAutonomousL2(base, {
        crypto: cryptoImpl,
        now: new Date("2026-10-21T12:00:00.000Z"),
      }),
    ).rejects.toThrow("per_payment_max must be exact USD");
    await expect(
      buildAutonomousL2(
        { ...base, constraints: { ...base.constraints, per_payment_max: "1.00" } },
        { crypto: cryptoImpl, now: new Date("2026-10-23T12:00:00.000Z") },
      ),
    ).rejects.toThrow("Mandate is not active");

    await expect(
      buildAutonomousL2(
        {
          ...base,
          constraints: {
            ...base.constraints,
            currency: "EUR" as "USD",
            per_payment_max: "1.00",
          },
        },
        { crypto: cryptoImpl, now: new Date("2026-10-21T12:00:00.000Z") },
      ),
    ).rejects.toThrow("currency must be USD");

    await expect(
      buildAutonomousL2(
        {
          ...base,
          constraints: {
            ...base.constraints,
            per_payment_max: "1.00",
            skus: [],
          },
        },
        { crypto: cryptoImpl, now: new Date("2026-10-21T12:00:00.000Z") },
      ),
    ).resolves.toMatchObject({ digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("replaces only the designated AP4M memo with the exact uppercase digest", async () => {
    const transaction = {
      TransactionType: "Batch",
      Memos: [
        { Memo: { MemoType: "6F74686572", MemoData: "KEEP" } },
        { Memo: { MemoType: MEMO_TYPE, MemoData: "PLACEHOLDER" } },
      ],
    };
    const result = await bindL2DigestToBatch(
      transaction,
      "signed-l2~",
      webcrypto as Crypto,
    );
    expect(result.Memos[0]).toEqual(transaction.Memos[0]);
    expect(result.Memos[1]?.Memo.MemoData).toMatch(/^[A-F0-9]{64}$/);
    expect(result.Memos[1]?.Memo.MemoData).toBe(
      Buffer.from(await webcrypto.subtle.digest("SHA-256", utf8("signed-l2~")))
        .toString("hex")
        .toUpperCase(),
    );
    expect(transaction.Memos[1]?.Memo.MemoData).toBe("PLACEHOLDER");
  });

  it("rejects ambiguous or missing AP4M memo slots", async () => {
    await expect(
      bindL2DigestToBatch({ Memos: [] }, "l2", webcrypto as Crypto),
    ).rejects.toThrow("exactly one AP4M L2 memo");
    await expect(
      bindL2DigestToBatch(
        {
          Memos: [
            { Memo: { MemoType: MEMO_TYPE } },
            { Memo: { MemoType: MEMO_TYPE } },
          ],
        },
        "l2",
        webcrypto as Crypto,
      ),
    ).rejects.toThrow("exactly one AP4M L2 memo");
  });

  it("binds the same L2 digest to Batch and every sequential alternative", async () => {
    const setup = {
      unsignedBatch: {
        TransactionType: "Batch",
        Memos: [{ Memo: { MemoType: MEMO_TYPE, MemoData: "0".repeat(64) } }],
      },
      unsignedSequential: [
        {
          TransactionType: "CredentialAccept",
          Memos: [{ Memo: { MemoType: MEMO_TYPE, MemoData: "0".repeat(64) } }],
        },
        {
          TransactionType: "PaymentChannelCreate",
          Memos: [{ Memo: { MemoType: MEMO_TYPE, MemoData: "0".repeat(64) } }],
        },
      ],
    };
    const result = await bindL2DigestToSetup(
      setup,
      "signed-l2~",
      webcrypto as Crypto,
    );
    const expected = Buffer.from(
      await webcrypto.subtle.digest("SHA-256", utf8("signed-l2~")),
    )
      .toString("hex")
      .toUpperCase();
    expect(result.unsignedBatch.Memos[0]?.Memo.MemoData).toBe(expected);
    expect(
      result.unsignedSequential?.map(
        (transaction) => transaction.Memos[0]?.Memo.MemoData,
      ),
    ).toEqual([expected, expected]);
    expect(setup.unsignedSequential[0]?.Memos[0]?.Memo.MemoData).toBe(
      "0".repeat(64),
    );
  });
});
