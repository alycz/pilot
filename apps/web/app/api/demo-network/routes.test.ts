import { webcrypto } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createCredentialIssueHandler,
  createCredentialRevokeHandler,
  createJwksHandler,
  createViL1Handler,
} from "../../../lib/demo-network/http";
import { issueViL1 } from "../../../lib/demo-network/vi";

const SUBJECT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function issuerPrivateJwk(): Promise<JsonWebKey> {
  const pair = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return webcrypto.subtle.exportKey("jwk", pair.privateKey);
}

describe("demo-network API routes", () => {
  it("hides every route unless the AP4M demo is explicitly enabled", async () => {
    const issue = vi.fn();
    const handler = createCredentialIssueHandler({
      env: { NODE_ENV: "test" },
      issue,
    });
    const response = await handler(
      post("/api/demo-network/credential/issue", { subject: SUBJECT }),
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("DEMO_NETWORK_DISABLED");
    expect(issue).not.toHaveBeenCalled();
  });

  it("hides every route outside an explicit Testnet execution context", async () => {
    const issue = vi.fn();
    const handler = createCredentialIssueHandler({
      env: {
        NODE_ENV: "test",
        AP4M_DEMO_ENABLED: "true",
        EXEC_NETWORK: "mainnet",
      },
      issue,
    });
    const response = await handler(
      post("/api/demo-network/credential/issue", { subject: SUBJECT }),
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe(
      "DEMO_NETWORK_REQUIRES_TESTNET",
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it("issues credentials with public response fields only", async () => {
    const issue = vi.fn(async () => ({
      action: "issued" as const,
      credential_type_hex: "4150344D2D4167656E74",
      issuer: "rIssuer",
      network: "testnet" as const,
      subject: SUBJECT,
      tx_hash: "HASH",
    }));
    const handler = createCredentialIssueHandler({
      env: {
        NODE_ENV: "test",
        AP4M_DEMO_ENABLED: "true",
        EXEC_NETWORK: "testnet",
      },
      issue,
      validateAddress: () => true,
    });
    const response = await handler(
      post("/api/demo-network/credential/issue", { subject: SUBJECT }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(issue).toHaveBeenCalledWith(
      { demoUrl: "http://localhost/demo/ap4m", subject: SUBJECT },
      {
        env: {
          NODE_ENV: "test",
          AP4M_DEMO_ENABLED: "true",
          EXEC_NETWORK: "testnet",
        },
      },
    );
    expect(JSON.stringify(body)).not.toMatch(/seed|private|secret/i);
  });

  it("rejects an attempted network override before revoke", async () => {
    const revoke = vi.fn();
    const handler = createCredentialRevokeHandler({
      env: {
        NODE_ENV: "test",
        AP4M_DEMO_ENABLED: "true",
        EXEC_NETWORK: "testnet",
      },
      revoke,
      validateAddress: () => true,
    });
    const response = await handler(
      post("/api/demo-network/credential/revoke", {
        network: "mainnet",
        subject: SUBJECT,
      }),
    );

    expect(response.status).toBe(400);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("issues L1 with hashes only and publishes a public JWKS", async () => {
    const issuer = await issuerPrivateJwk();
    const devicePair = (await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const devicePublicJwk = await webcrypto.subtle.exportKey(
      "jwk",
      devicePair.publicKey,
    );
    const env = {
      NODE_ENV: "test" as const,
      AP4M_DEMO_ENABLED: "true",
      EXEC_NETWORK: "testnet",
      DEMO_NETWORK_VI_L1_JWK: JSON.stringify(issuer),
    };
    const handler = createViL1Handler({
      env,
      issue: issueViL1,
      now: () => Date.UTC(2026, 9, 21),
      validateAddress: () => true,
    });
    const response = await handler(
      post("/api/demo-network/vi/l1", {
        budget_account: SUBJECT,
        device_public_jwk: devicePublicJwk,
        of_verification: {
          verified: true,
          owner_name_hash: "a".repeat(64),
          customer_ref_hash: "b".repeat(64),
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.issuer).toBe("Demo Network (Mastercard's role in production)");
    expect(JSON.stringify(body)).not.toContain(String(issuer.d));

    const jwks = await createJwksHandler(env)();
    const jwksBody = await jwks.json();
    expect(jwks.status).toBe(200);
    expect(jwksBody.keys).toHaveLength(1);
    expect(jwksBody.keys[0]).not.toHaveProperty("d");
    expect(jwksBody.keys[0].kid).toBe(body.public_jwk.kid);
  });
});
