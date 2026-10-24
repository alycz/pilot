import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  Ap4mIntentError,
  buildAp4mCheckoutPayload,
  buildAp4mMerchantL2Presentation,
  buildMcIntent,
  canonicalAp4mJson,
  mintAp4mViPair,
  type Ap4mCompactJwtSigner,
  type MintAp4mViPairInput,
} from "../src/exec/ap4m-intent";

const NOW = new Date("2026-10-21T18:30:00.000Z");
const UUIDS = [
  "00000000-0000-4000-8000-000000000401",
  "00000000-0000-4000-8000-000000000402",
];

function base64url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decode(value: string): unknown {
  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - value.length % 4) % 4)}`;
  return JSON.parse(atob(padded));
}

function disclosure(salt: string, value: unknown): string {
  return base64url(JSON.stringify([salt, value]));
}

function splitSdJwt(value: string) {
  const [compact, ...tail] = value.split("~");
  if (!compact) throw new Error("missing compact jwt");
  const [header, payload, signature] = compact.split(".");
  if (!header || !payload || !signature) throw new Error("bad compact jwt");
  return {
    compact,
    header: decode(header) as Record<string, unknown>,
    payload: decode(payload) as Record<string, unknown>,
    disclosures: tail.filter(Boolean).map((entry) => decode(entry) as unknown[]),
    signingInput: `${header}.${payload}`,
    signature,
  };
}

async function digest(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

describe("MH4 Mastercard intent and VI L3 construction", () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let publicJwk: JsonWebKey;
  let signCompactJwt: Ap4mCompactJwtSigner;

  beforeAll(async () => {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    privateKey = keys.privateKey;
    publicKey = keys.publicKey;
    publicJwk = await crypto.subtle.exportKey("jwk", publicKey);
    signCompactJwt = async (header, payload) => {
      const protectedSegment = base64url(JSON.stringify(header));
      const payloadSegment = base64url(JSON.stringify(payload));
      const signingInput = `${protectedSegment}.${payloadSegment}`;
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${base64url(new Uint8Array(signature))}`;
    };
  });

  function intent() {
    const uuids = [...UUIDS];
    return buildMcIntent(
      {
        merchantId: "venue-yield-desk",
        merchantName: "Venue Yield Desk",
        srcDpaId: "src-dpa-venue-yield-desk",
        sku: "yield-report",
        itemName: "Venue yield report",
        priceUsd: "1.00",
      },
      { now: () => NOW, uuid: () => uuids.shift()! },
    );
  }

  function mintInput(): MintAp4mViPairInput {
    return {
      intent: intent(),
      paymentTerms: {
        scheme: "exact",
        network: "testnet",
        currency: "RLUSD",
        issuer: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        amount: "1",
        payTo: "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv",
      },
      merchant: {
        id: "venue-yield-desk",
        name: "Venue Yield Desk",
        website: "https://merchant.test/m/venue-yield-desk",
      },
      sku: "yield-report",
      itemName: "Venue yield report",
      amountMinorUnits: 100,
      paymentInstrument: {
        type: "xrpl.ap4m",
        id: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        description: "Testnet AP4M payer",
      },
      agentKid: "agent-key-1",
      agentPublicJwk: publicJwk,
      agentIssuer: "https://harbor.test/ap4m/agent",
      networkAudience: "https://harbor.test/ap4m/network",
      merchantAudience: "https://merchant.test/m/venue-yield-desk",
      l2: {
        baseJwt: `${base64url(JSON.stringify({ alg: "ES256" }))}.${base64url(JSON.stringify({ aud: "harbor" }))}.signature`,
        payment: disclosure("l2-payment", { vct: "mandate.payment.open" }),
        merchant: disclosure("l2-merchant", { id: "venue-yield-desk", name: "Venue Yield Desk" }),
        checkout: disclosure("l2-checkout", { vct: "mandate.checkout.open" }),
        item: disclosure("l2-item", { id: "yield-report", sku: "yield-report" }),
      },
    };
  }

  function mintDeps(overrides: Partial<Parameters<typeof mintAp4mViPair>[1]> = {}) {
    const nonces = ["l3a-nonce-0001", "l3b-nonce-0002"];
    const salts = ["merchant-salt", "payment-salt", "checkout-salt"];
    return {
      now: () => NOW,
      nonce: () => nonces.shift()!,
      disclosureSalt: () => salts.shift()!,
      signCompactJwt,
      ...overrides,
    };
  }

  it("builds the exact one-order deferred Mastercard intent with a five-minute expiry", () => {
    const value = intent();
    expect(value).toEqual({
      intentId: `demo-intent-${UUIDS[0]}`,
      intentSummary: "Purchase yield-report from Venue Yield Desk",
      intentStatus: "ACTIVE",
      orders: [{
        orderId: `demo-order-${UUIDS[1]}`,
        orderExecutionType: "DEFERRED",
        orderExpiry: Math.floor(NOW.getTime() / 1_000) + 300,
        orderTotalAmount: { amount: "1.00", currency: "USD" },
        items: [{
          itemId: "yield-report",
          itemName: "Venue yield report",
          itemUnitPrice: { amount: "1.00", currency: "USD" },
          itemQuantity: 1,
          itemDeliveryMethod: "DIGITAL",
        }],
        merchants: [{
          srcDpaId: "src-dpa-venue-yield-desk",
          merchantName: "Venue Yield Desk",
        }],
      }],
    });
  });

  it("canonicalizes the checkout payload independent of object insertion order", () => {
    expect(canonicalAp4mJson({ b: 1, a: { d: 2, c: 3 } }))
      .toBe('{"a":{"c":3,"d":2},"b":1}');
    const input = mintInput();
    expect(buildAp4mCheckoutPayload(input.intent, input.paymentTerms))
      .toBe(canonicalAp4mJson({ intent: input.intent, payment_terms: input.paymentTerms }));
  });

  it("builds the canonical merchant L2 presentation in fixed reference-verifiable order", () => {
    const l2 = mintInput().l2;
    const presentation = buildAp4mMerchantL2Presentation(l2);
    expect(presentation).toBe(
      `${l2.baseJwt}~${l2.payment}~${l2.merchant}~${l2.checkout}~${l2.item}~`,
    );
    expect(presentation.split("~")).toEqual([
      l2.baseJwt,
      l2.payment,
      l2.merchant,
      l2.checkout,
      l2.item,
      "",
    ]);
  });

  it("mints signed split L3 credentials with selective L2 bindings and one checkout hash", async () => {
    const input = mintInput();
    const pair = await mintAp4mViPair(input, mintDeps());
    const l3a = splitSdJwt(pair.l3a);
    const l3b = splitSdJwt(pair.l3b);

    expect(l3a.header).toEqual({ alg: "ES256", typ: "kb-sd-jwt", kid: "agent-key-1" });
    expect(l3b.header).toEqual(l3a.header);
    expect(l3a.header).not.toHaveProperty("jwk");
    expect(l3a.payload).not.toHaveProperty("cnf");
    expect(l3b.payload).not.toHaveProperty("cnf");
    expect(l3a.payload).toMatchObject({
      nonce: "l3a-nonce-0001",
      iat: Math.floor(NOW.getTime() / 1_000),
      exp: Math.floor(NOW.getTime() / 1_000) + 300,
      _sd_alg: "sha-256",
    });
    expect(l3b.payload.nonce).toBe("l3b-nonce-0002");
    expect(l3a.payload.sd_hash).toBe(await digest(
      `${input.l2.baseJwt}~${input.l2.payment}~${input.l2.merchant}~`,
    ));
    expect(l3b.payload.sd_hash).toBe(await digest(
      buildAp4mMerchantL2Presentation(input.l2),
    ));

    const finalPayment = l3a.disclosures.find((entry) => (entry.at(-1) as Record<string, unknown>).vct === "mandate.payment")?.at(-1) as Record<string, unknown>;
    const finalCheckout = l3b.disclosures[0]?.at(-1) as Record<string, unknown>;
    expect(finalPayment.transaction_id).toBe(pair.checkoutHash);
    expect(finalCheckout.checkout_hash).toBe(pair.checkoutHash);
    expect(finalCheckout.checkout_jwt).toBe(pair.checkoutPayload);
    expect(pair.checkoutHash).toBe(await digest(pair.checkoutPayload));
    expect(pair.l3aDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(pair.l3bDigest).toMatch(/^[a-f0-9]{64}$/);

    for (const token of [l3a, l3b]) {
      expect(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        Uint8Array.from(atob(token.signature.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(token.signature.length / 4) * 4, "=")), (character) => character.charCodeAt(0)),
        new TextEncoder().encode(token.signingInput),
      )).toBe(true);
    }
  });

  it("rejects mismatched L2 merchant and item disclosures before signing", async () => {
    const signer = vi.fn(signCompactJwt);
    const wrongMerchant = mintInput();
    wrongMerchant.l2.merchant = disclosure("l2-merchant", { id: "risk-oracle" });
    await expect(mintAp4mViPair(wrongMerchant, mintDeps({ signCompactJwt: signer })))
      .rejects.toMatchObject<Partial<Ap4mIntentError>>({ code: "INVALID_L2_PRESENTATION" });

    const wrongItem = mintInput();
    wrongItem.l2.item = disclosure("l2-item", { id: "risk-score" });
    await expect(mintAp4mViPair(wrongItem, mintDeps({ signCompactJwt: signer })))
      .rejects.toMatchObject<Partial<Ap4mIntentError>>({ code: "INVALID_L2_PRESENTATION" });
    expect(signer).not.toHaveBeenCalled();
  });

  it("rejects nonce reuse and signer mutation fail-closed", async () => {
    await expect(mintAp4mViPair(mintInput(), mintDeps({ nonce: () => "same-nonce" })))
      .rejects.toMatchObject<Partial<Ap4mIntentError>>({ code: "INVALID_INPUT" });

    const mutate: Ap4mCompactJwtSigner = async (header, payload) => signCompactJwt(
      header,
      { ...payload, aud: "https://attacker.test" },
    );
    await expect(mintAp4mViPair(mintInput(), mintDeps({ signCompactJwt: mutate })))
      .rejects.toMatchObject<Partial<Ap4mIntentError>>({ code: "INVALID_SIGNER_OUTPUT" });
  });

  it("changes the checkout binding when payment terms change", async () => {
    const first = await mintAp4mViPair(mintInput(), mintDeps());
    const changed = mintInput();
    changed.paymentTerms = { ...changed.paymentTerms, amount: "1.01" };
    const second = await mintAp4mViPair(changed, mintDeps());
    expect(second.checkoutHash).not.toBe(first.checkoutHash);
  });
});
