import { webcrypto } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createCredentialIssueHandler,
  createCredentialRevokeHandler,
  createJwksHandler,
  createViL1Handler,
} from "../../../lib/demo-network/http";
import { issueViL1 } from "../../../lib/demo-network/vi";
import { sealWalletSession, WALLET_SESSION_COOKIE } from "../../../lib/wallet-session";

const SUBJECT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER_SUBJECT = "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr";
const SESSION_SECRET = "demo-network-route-test-secret-at-least-32-chars";
const TEST_ENV = {
  NODE_ENV: "test" as const,
  AP4M_DEMO_ENABLED: "true",
  EXEC_NETWORK: "testnet",
  PILOT_DEPLOYMENT_PROFILE: "hosted",
  PILOT_PUBLIC_ORIGIN: "https://pilot.example",
};

function post(
  path: string,
  body: unknown,
  options: { account?: string; network?: "testnet" | "devnet"; origin?: string | null } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.origin !== null) headers.set("Origin", options.origin ?? "https://pilot.example");
  if (options.account) {
    const session = sealWalletSession({
      version: 1,
      account: options.account,
      network: options.network ?? "testnet",
      expiresAt: Date.now() + 60_000,
    }, SESSION_SECRET, TEST_ENV);
    headers.set("Cookie", `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}`);
  }
  return new Request(`https://pilot.example${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function withSessionSecret<T>(run: () => Promise<T>): Promise<T> {
  const prior = process.env.SESSION_SECRET;
  try {
    process.env.SESSION_SECRET = SESSION_SECRET;
    return await run();
  } finally {
    if (prior === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prior;
  }
}

type ProtectedRouteName = "credential issue" | "credential revoke" | "VI L1";

function protectedRoute(name: ProtectedRouteName) {
  const sideEffect = vi.fn(async () => ({ ok: true })) as ReturnType<typeof vi.fn>;
  if (name === "credential issue") {
    return {
      body: { subject: SUBJECT },
      handler: createCredentialIssueHandler({
        env: TEST_ENV,
        issue: sideEffect,
        validateAddress: () => true,
      }),
      path: "/api/demo-network/credential/issue",
      sideEffect,
    };
  }
  if (name === "credential revoke") {
    return {
      body: { subject: SUBJECT },
      handler: createCredentialRevokeHandler({
        env: TEST_ENV,
        revoke: sideEffect,
        validateAddress: () => true,
      }),
      path: "/api/demo-network/credential/revoke",
      sideEffect,
    };
  }
  return {
    body: {
      budget_account: SUBJECT,
      device_public_jwk: {},
      of_verification: {
        verified: true,
        owner_name_hash: "a".repeat(64),
        customer_ref_hash: "b".repeat(64),
      },
    },
    handler: createViL1Handler({
      env: TEST_ENV,
      issue: sideEffect,
      validateAddress: () => true,
    }),
    path: "/api/demo-network/vi/l1",
    sideEffect,
  };
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
      env: TEST_ENV,
      issue,
      validateAddress: () => true,
    });
    const response = await withSessionSecret(() => handler(
      post("/api/demo-network/credential/issue", { subject: SUBJECT }, { account: SUBJECT }),
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(issue).toHaveBeenCalledWith(
      { demoUrl: "https://pilot.example/demo/ap4m", subject: SUBJECT },
      { env: TEST_ENV },
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
      ...TEST_ENV,
      DEMO_NETWORK_VI_L1_JWK: JSON.stringify(issuer),
    };
    const handler = createViL1Handler({
      env,
      issue: issueViL1,
      now: () => Date.UTC(2026, 9, 21),
      validateAddress: () => true,
    });
    const response = await withSessionSecret(() => handler(
      post("/api/demo-network/vi/l1", {
        budget_account: SUBJECT,
        device_public_jwk: devicePublicJwk,
        of_verification: {
          verified: true,
          owner_name_hash: "a".repeat(64),
          customer_ref_hash: "b".repeat(64),
        },
      }, { account: SUBJECT }),
    ));
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

  it.each([
    "credential issue",
    "credential revoke",
    "VI L1",
  ] as const)("rejects missing Origin before %s side effects", async (name) => {
    const route = protectedRoute(name);
    const response = await withSessionSecret(() => route.handler(
      post(route.path, route.body, { account: SUBJECT, origin: null }),
    ));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("DEMO_NETWORK_FORBIDDEN_ORIGIN");
    expect(route.sideEffect).not.toHaveBeenCalled();
  });

  it.each([
    "credential issue",
    "credential revoke",
    "VI L1",
  ] as const)("rejects cross-origin requests before %s side effects", async (name) => {
    const route = protectedRoute(name);
    const response = await withSessionSecret(() => route.handler(
      post(route.path, route.body, { account: SUBJECT, origin: "https://attacker.example" }),
    ));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("DEMO_NETWORK_FORBIDDEN_ORIGIN");
    expect(route.sideEffect).not.toHaveBeenCalled();
  });

  it.each([
    "credential issue",
    "credential revoke",
    "VI L1",
  ] as const)("rejects a wrong-account wallet before %s side effects", async (name) => {
    const route = protectedRoute(name);
    const response = await withSessionSecret(() => route.handler(
      post(route.path, route.body, { account: OTHER_SUBJECT }),
    ));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("DEMO_NETWORK_UNAUTHORIZED");
    expect(route.sideEffect).not.toHaveBeenCalled();
  });

  it.each([
    "credential issue",
    "credential revoke",
    "VI L1",
  ] as const)("rejects a wrong-network wallet before %s side effects", async (name) => {
    const route = protectedRoute(name);
    const response = await withSessionSecret(() => route.handler(
      post(route.path, route.body, { account: SUBJECT, network: "devnet" }),
    ));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("DEMO_NETWORK_UNAUTHORIZED");
    expect(route.sideEffect).not.toHaveBeenCalled();
  });
});
