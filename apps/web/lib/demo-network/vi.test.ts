import { webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  issueViL1,
  publicIssuerJwk,
  verifyViL1,
  type ViL1Input,
} from "./vi";
import fixture from "./fixtures/vi-l1-es256.json";

const BUDGET = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OWNER_HASH = "a".repeat(64);
const CUSTOMER_HASH = "b".repeat(64);

async function keyPair(): Promise<{
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}> {
  const pair = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return {
    privateJwk: await webcrypto.subtle.exportKey("jwk", pair.privateKey),
    publicJwk: await webcrypto.subtle.exportKey("jwk", pair.publicKey),
  };
}

function input(devicePublicJwk: JsonWebKey): ViL1Input {
  return {
    budget_account: BUDGET,
    device_public_jwk: devicePublicJwk,
    of_verification: {
      customer_ref_hash: CUSTOMER_HASH,
      owner_name_hash: OWNER_HASH,
      verified: true,
    },
  };
}

describe("demo-network Verifiable Intent L1", () => {
  it("verifies the portable public-only ES256 fixture", async () => {
    const claims = await verifyViL1(
      fixture.l1,
      fixture.issuer_public_jwk as JsonWebKey,
    );

    expect(claims).toMatchObject({
      budget_account: fixture.expected.budget_account,
      cnf: { jwk: fixture.device_public_jwk },
      exp: fixture.expected.exp,
      iat: fixture.expected.iat,
      iss: fixture.expected.issuer,
      of_customer_ref: fixture.expected.customer_ref_hash,
      of_owner_name_hash: fixture.expected.owner_name_hash,
    });
    expect(JSON.stringify(fixture)).not.toContain('"d"');
  });

  it("issues standard ES256 SD-JWT compact data that verifies independently", async () => {
    const issuer = await keyPair();
    const device = await keyPair();
    const result = await issueViL1(
      input(device.publicJwk),
      issuer.privateJwk,
      Date.UTC(2026, 9, 21),
    );
    const claims = await verifyViL1(result.l1, result.public_jwk);

    expect(result.l1.endsWith("~")).toBe(true);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(claims).toMatchObject({
      budget_account: BUDGET,
      cnf: {
        jwk: {
          crv: "P-256",
          kty: "EC",
          x: device.publicJwk.x,
          y: device.publicJwk.y,
        },
      },
      iss: "Demo Network (Mastercard's role in production)",
      pilot_issuer_name: "Demo Network (Mastercard's role in production)",
      of_customer_ref: CUSTOMER_HASH,
      of_owner_name_hash: OWNER_HASH,
      of_verified: true,
      sub: BUDGET,
      vct: "https://credentials.mastercard.com/card",
    });
    expect(claims.exp - claims.iat).toBe(365 * 24 * 60 * 60);
    expect(JSON.stringify(claims)).not.toContain("Ada Lovelace");
    expect(result.public_jwk).not.toHaveProperty("d");
    expect(result.public_jwk.kid).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects tampered compact credentials", async () => {
    const issuer = await keyPair();
    const device = await keyPair();
    const result = await issueViL1(
      input(device.publicJwk),
      issuer.privateJwk,
    );
    const parts = result.l1.slice(0, -1).split(".");
    parts[1] = Buffer.from(JSON.stringify({ sub: "tampered" }))
      .toString("base64url");
    await expect(
      verifyViL1(`${parts.join(".")}~`, result.public_jwk),
    ).rejects.toThrow("Invalid L1 signature");
  });

  it("rejects a device private key and unhashed Open Finance identifiers", async () => {
    const issuer = await keyPair();
    const device = await keyPair();
    await expect(
      issueViL1(
        input(device.privateJwk),
        issuer.privateJwk,
      ),
    ).rejects.toMatchObject({ code: "INVALID_DEVICE_KEY" });
    await expect(
      issueViL1(
        {
          ...input(device.publicJwk),
          of_verification: {
            customer_ref_hash: "customer-raw",
            owner_name_hash: "Ada Lovelace",
            verified: true,
          },
        },
        issuer.privateJwk,
      ),
    ).rejects.toMatchObject({ code: "OPEN_FINANCE_VERIFICATION_REQUIRED" });
  });

  it("rejects a structurally shaped device key whose point is invalid", async () => {
    const issuer = await keyPair();
    await expect(
      issueViL1(
        input({ crv: "P-256", kty: "EC", x: "AQ", y: "AQ" }),
        issuer.privateJwk,
      ),
    ).rejects.toMatchObject({ code: "INVALID_DEVICE_KEY" });
  });

  it("derives the same stable public JWKS key without private material", async () => {
    const issuer = await keyPair();
    expect(publicIssuerJwk(issuer.privateJwk)).toEqual(
      publicIssuerJwk(issuer.privateJwk),
    );
    expect(publicIssuerJwk(issuer.privateJwk)).not.toHaveProperty("d");
  });
});
