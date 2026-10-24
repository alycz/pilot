import {
  generateKeyPairSync,
  sign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AgentCoreJwtError,
  createAgentCoreJwtVerifier,
  createVerifiedJwtGatewayAuth,
} from "../src/jwt";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const ISSUER = "https://identity.example.test/oauth2/default";
const JWKS = "https://identity.example.test/.well-known/jwks.json";
const AUDIENCE = "pilot-agentcore-gateway";
const SUBJECT = "pilot-runtime-workload";
const TENANT = "tenant-12345678";
const CLIENT = "pilot-runtime-client";
const SCOPE = "gateway:invoke";

function rsaKey(kid: string): { privateKey: KeyObject; publicJwk: JsonWebKey } {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      ...pair.publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
      key_ops: ["verify"],
    },
  };
}

function es256Token(): { compact: string; publicJwk: JsonWebKey } {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const now = Math.floor(NOW / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "key-ec", typ: "at+jwt" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER, sub: SUBJECT, aud: AUDIENCE, client_id: CLIENT, scope: SCOPE,
    tenant_id: TENANT, iat: now - 5, nbf: now - 5, exp: now + 120,
  })).toString("base64url");
  const signature = sign("SHA256", Buffer.from(`${header}.${payload}`, "ascii"), {
    key: pair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    compact: `${header}.${payload}.${signature}`,
    publicJwk: {
      ...pair.publicKey.export({ format: "jwk" }),
      kid: "key-ec", alg: "ES256", use: "sig", key_ops: ["verify"],
    },
  };
}

function token(
  key: { privateKey: KeyObject },
  overrides: Readonly<Record<string, unknown>> = {},
  headerOverrides: Readonly<Record<string, unknown>> = {},
): string {
  const now = Math.floor(NOW / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-a", typ: "at+jwt", ...headerOverrides }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER,
    sub: SUBJECT,
    aud: AUDIENCE,
    iat: now - 5,
    nbf: now - 5,
    exp: now + 120,
    tenant_id: TENANT,
    client_id: CLIENT,
    scope: SCOPE,
    ...overrides,
  })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`, "ascii"), key.privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function response(keys: readonly JsonWebKey[]): Response {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { "content-type": "application/jwk-set+json" },
  });
}

function setup(fetcher: typeof fetch) {
  return createAgentCoreJwtVerifier({
    issuer: ISSUER,
    jwksUrl: JWKS,
    audiences: [AUDIENCE],
    allowedSubjects: [SUBJECT],
    allowedClients: [CLIENT],
    requiredScopes: [SCOPE],
    clientClaim: "client_id",
    tenantClaim: "tenant_id",
    algorithms: ["RS256"],
    clockToleranceSeconds: 0,
    maxTokenAgeSeconds: 300,
    maxTokenLifetimeSeconds: 600,
  }, { fetch: fetcher, now: () => NOW });
}

describe("AgentCore workload JWT verification", () => {
  it("validates signature, issuer, audience, subject, tenant, and time claims", async () => {
    const key = rsaKey("key-a");
    const fetcher = vi.fn(async () => response([key.publicJwk]));
    const verifier = setup(fetcher as typeof fetch);

    await expect(verifier.verifyAuthorization(`Bearer ${token(key)}`, { tenantId: TENANT }))
      .resolves.toMatchObject({
        issuer: ISSUER,
        subject: SUBJECT,
        audience: [AUDIENCE],
        tenantId: TENANT,
        keyId: "key-a",
        algorithm: "RS256",
      });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("supports explicitly allowed ES256 and rejects malformed ES256 signatures", async () => {
    const fixture = es256Token();
    const verifier = createAgentCoreJwtVerifier({
      issuer: ISSUER,
      jwksUrl: JWKS,
      audiences: [AUDIENCE],
      allowedSubjects: [SUBJECT],
      allowedClients: [CLIENT],
      requiredScopes: [SCOPE],
      clientClaim: "client_id",
      tenantClaim: "tenant_id",
      algorithms: ["ES256"],
      clockToleranceSeconds: 0,
    }, { fetch: async () => response([fixture.publicJwk]), now: () => NOW });
    await expect(verifier.verifyAuthorization(`Bearer ${fixture.compact}`, { tenantId: TENANT }))
      .resolves.toMatchObject({ algorithm: "ES256", keyId: "key-ec" });
    const parts = fixture.compact.split(".");
    parts[2] = Buffer.alloc(63).toString("base64url");
    await expect(verifier.verifyAuthorization(`Bearer ${parts.join(".")}`, { tenantId: TENANT }))
      .rejects.toMatchObject({ code: "authorization" });
  });

  it.each([
    ["issuer", { iss: "https://other.example.test/oauth2/default" }],
    ["audience", { aud: "another-client" }],
    ["subject", { sub: "another-workload" }],
    ["tenant", { tenant_id: "another-tenant" }],
    ["client", { client_id: "another-client" }],
    ["scope", { scope: "another:scope" }],
    ["expiry", { exp: Math.floor(NOW / 1_000) - 1 }],
    ["not-before", { nbf: Math.floor(NOW / 1_000) + 60 }],
    ["issued-at", { iat: Math.floor(NOW / 1_000) + 60 }],
    ["lifetime", { exp: Math.floor(NOW / 1_000) + 601 }],
    ["missing time claim", { iat: undefined }],
  ])("rejects a mismatched %s without exposing claims", async (_label, overrides) => {
    const key = rsaKey("key-a");
    const verifier = setup(async () => response([key.publicJwk]));
    const failure = verifier.verifyAuthorization(`Bearer ${token(key, overrides)}`, { tenantId: TENANT });
    await expect(failure).rejects.toMatchObject({
      code: "authorization",
      message: "AgentCore workload authorization is invalid",
    });
  });

  it("rejects algorithm/key URL confusion and malformed bearer values", async () => {
    const key = rsaKey("key-a");
    const verifier = setup(async () => response([key.publicJwk]));
    await expect(verifier.verifyAuthorization(
      `Bearer ${token(key, {}, { jku: "https://attacker.example/jwks.json" })}`,
      { tenantId: TENANT },
    )).rejects.toBeInstanceOf(AgentCoreJwtError);
    await expect(verifier.verifyAuthorization("Bearer not.a.token with-space", { tenantId: TENANT }))
      .rejects.toBeInstanceOf(AgentCoreJwtError);
    await expect(verifier.verifyAuthorization(
      `Bearer ${token(key, {}, { alg: "none" })}`,
      { tenantId: TENANT },
    )).rejects.toMatchObject({ code: "authorization" });
    await expect(verifier.verifyAuthorization(
      `Bearer ${token(key, {}, { alg: "HS256" })}`,
      { tenantId: TENANT },
    )).rejects.toMatchObject({ code: "authorization" });
    const tampered = token(key).split(".");
    tampered[2] = `${tampered[2]!.startsWith("A") ? "B" : "A"}${tampered[2]!.slice(1)}`;
    await expect(verifier.verifyAuthorization(`Bearer ${tampered.join(".")}`, { tenantId: TENANT }))
      .rejects.toMatchObject({ code: "authorization" });
  });

  it("refreshes once for a rotated key and then caches the JWKS", async () => {
    const oldKey = rsaKey("key-old");
    const newKey = rsaKey("key-new");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response([oldKey.publicJwk]))
      .mockResolvedValueOnce(response([newKey.publicJwk]));
    const verifier = setup(fetcher as typeof fetch);
    const rotated = token(newKey, {}, { kid: "key-new" });

    await expect(verifier.verifyAuthorization(`Bearer ${rotated}`, { tenantId: TENANT })).resolves.toBeDefined();
    await expect(verifier.verifyAuthorization(`Bearer ${rotated}`, { tenantId: TENANT })).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("negative-caches unknown key refreshes during the cooldown", async () => {
    const known = rsaKey("key-a");
    const unknown = rsaKey("key-unknown");
    const fetcher = vi.fn(async () => response([known.publicJwk]));
    const verifier = setup(fetcher as typeof fetch);
    const unknownToken = token(unknown, {}, { kid: "key-unknown" });
    await expect(verifier.verifyAuthorization(`Bearer ${unknownToken}`, { tenantId: TENANT }))
      .rejects.toMatchObject({ code: "authorization" });
    await expect(verifier.verifyAuthorization(`Bearer ${unknownToken}`, { tenantId: TENANT }))
      .rejects.toMatchObject({ code: "authorization" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects private, symmetric, weak, and multi-operation verification keys", async () => {
    const key = rsaKey("key-a");
    const privatePair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateJwk = {
      ...privatePair.privateKey.export({ format: "jwk" }), kid: "key-a", alg: "RS256", use: "sig", key_ops: ["verify"],
    } as JsonWebKey;
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const weakJwk = {
      ...weak.publicKey.export({ format: "jwk" }), kid: "key-a", alg: "RS256", use: "sig", key_ops: ["verify"],
    } as JsonWebKey;
    const badKeys: JsonWebKey[] = [
      privateJwk,
      { kty: "oct", k: "c2VjcmV0", kid: "key-a", alg: "RS256", use: "sig", key_ops: ["verify"] },
      weakJwk,
      { ...key.publicJwk, key_ops: ["verify", "encrypt"] },
    ];
    for (const badKey of badKeys) {
      const verifier = setup(async () => response([badKey]));
      await expect(verifier.verifyAuthorization(`Bearer ${token(key)}`, { tenantId: TENANT }))
        .rejects.toMatchObject({ code: "authorization" });
    }
  });

  it("fails closed when the caller aborts JWKS resolution", async () => {
    const key = rsaKey("key-a");
    const controller = new AbortController();
    controller.abort();
    const aborted = setup(async () => response([key.publicJwk]));
    await expect(aborted.verifyAuthorization(`Bearer ${token(key)}`, {
      tenantId: TENANT,
      signal: controller.signal,
    })).rejects.toBeInstanceOf(AgentCoreJwtError);
  });

  it("enforces the JWKS transport timeout", async () => {
    const key = rsaKey("key-a");
    const timeout = createAgentCoreJwtVerifier({
      issuer: ISSUER, jwksUrl: JWKS, audiences: [AUDIENCE], allowedSubjects: [SUBJECT],
      allowedClients: [CLIENT], requiredScopes: [SCOPE], clientClaim: "client_id",
      tenantClaim: "tenant_id", algorithms: ["RS256"], jwksTimeoutMs: 100,
    }, {
      fetch: ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const guard = setTimeout(() => reject(new Error("timeout signal was not forwarded")), 500);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(guard);
          reject(new Error("aborted"));
        }, { once: true });
      })) as typeof fetch,
      now: () => NOW,
    });
    await expect(timeout.verifyAuthorization(`Bearer ${token(key)}`, { tenantId: TENANT }))
      .rejects.toMatchObject({ code: "jwks_unavailable" });
  });

  it("applies the JWKS timeout through a response body that never finishes", async () => {
    const key = rsaKey("key-a");
    const timeout = createAgentCoreJwtVerifier({
      issuer: ISSUER, jwksUrl: JWKS, audiences: [AUDIENCE], allowedSubjects: [SUBJECT],
      allowedClients: [CLIENT], requiredScopes: [SCOPE], clientClaim: "client_id",
      tenantClaim: "tenant_id", algorithms: ["RS256"], jwksTimeoutMs: 100,
    }, {
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      }), { status: 200, headers: { "content-type": "application/jwk-set+json" } }),
      now: () => NOW,
    });
    await expect(timeout.verifyAuthorization(`Bearer ${token(key)}`, { tenantId: TENANT }))
      .rejects.toMatchObject({
        code: "jwks_unavailable",
        message: "AgentCore JWT verification keys are unavailable",
      });
  });

  it("rejects JWKS redirects and unsupported content types", async () => {
    const key = rsaKey("key-a");
    for (const bad of [
      new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }),
      new Response("{}", { status: 302, headers: { location: "https://other.example.test/jwks" } }),
    ]) {
      const verifier = setup(async () => bad.clone());
      await expect(verifier.verifyAuthorization(`Bearer ${token(key)}`, { tenantId: TENANT }))
        .rejects.toMatchObject({ code: "jwks_unavailable", message: "AgentCore JWT verification keys are unavailable" });
    }
  });

  it("fails closed on duplicate matching keys and oversized JWKS", async () => {
    const key = rsaKey("key-a");
    const duplicateVerifier = setup(async () => response([key.publicJwk, key.publicJwk]));
    await expect(duplicateVerifier.verifyAuthorization(`Bearer ${token(key)}`, { tenantId: TENANT }))
      .rejects.toBeInstanceOf(AgentCoreJwtError);

    const oversized = createAgentCoreJwtVerifier({
      issuer: ISSUER,
      jwksUrl: JWKS,
      audiences: [AUDIENCE],
      allowedSubjects: [SUBJECT],
      allowedClients: [CLIENT],
      requiredScopes: [SCOPE],
      clientClaim: "client_id",
      tenantClaim: "tenant_id",
      algorithms: ["RS256"],
      maxJwksBytes: 1_024,
    }, {
      fetch: async () => new Response(JSON.stringify({ keys: [key.publicJwk], padding: "x".repeat(2_000) }), {
        headers: { "content-type": "application/json" },
      }),
      now: () => NOW,
    });
    await expect(oversized.verifyAuthorization(`Bearer ${token(key)}`, { tenantId: TENANT }))
      .rejects.toMatchObject({ code: "jwks_unavailable" });
  });

  it("turns a resolved short-lived token into Gateway auth only after verification", async () => {
    const key = rsaKey("key-a");
    const verifier = setup(async () => response([key.publicJwk]));
    const authorization = `Bearer ${token(key)}`;
    const resolver = { resolveAuthorization: vi.fn(async () => authorization) };
    const auth = createVerifiedJwtGatewayAuth({ resolver, verifier, tenantId: TENANT });

    await expect(auth.authorization()).resolves.toBe(authorization);
    expect(resolver.resolveAuthorization).toHaveBeenCalledWith(
      {
        tenantId: TENANT,
        audiences: [AUDIENCE],
        requiredScopes: [SCOPE],
        workloadIdentityToken: undefined,
      },
      { signal: undefined },
    );
  });

  it("rejects insecure or cross-origin verifier configuration", () => {
    expect(() => createAgentCoreJwtVerifier({
      issuer: "http://identity.example.test/oauth2/default",
      jwksUrl: JWKS,
      audiences: [AUDIENCE],
      allowedSubjects: [SUBJECT],
      allowedClients: [CLIENT],
      requiredScopes: [SCOPE],
      clientClaim: "client_id",
      tenantClaim: "tenant_id",
      algorithms: ["RS256"],
    })).toThrow(AgentCoreJwtError);
    expect(() => createAgentCoreJwtVerifier({
      issuer: ISSUER,
      jwksUrl: "https://keys.example.test/jwks.json",
      audiences: [AUDIENCE],
      allowedSubjects: [SUBJECT],
      allowedClients: [CLIENT],
      requiredScopes: [SCOPE],
      clientClaim: "client_id",
      tenantClaim: "tenant_id",
      algorithms: ["RS256"],
    })).toThrow(AgentCoreJwtError);
  });

  it("preserves an exact valid trailing-slash OIDC issuer", () => {
    const verifier = createAgentCoreJwtVerifier({
      issuer: "https://identity.example.test/",
      jwksUrl: JWKS,
      audiences: [AUDIENCE],
      allowedSubjects: [SUBJECT],
      allowedClients: [CLIENT],
      requiredScopes: [SCOPE],
      clientClaim: "client_id",
      tenantClaim: "tenant_id",
      algorithms: ["RS256"],
    }, { fetch: async () => response([]), now: () => NOW });
    expect(verifier.policy.issuer).toBe("https://identity.example.test/");
  });
});
