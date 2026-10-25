import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";

import { InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { describe, expect, it, vi } from "vitest";

import { deriveAgentCoreScopeDigest } from "../src/contracts";
import {
  createAgentCoreProposalProvider,
  createAgentCoreProposalProviderFromEnv,
} from "../src/runtime";

const scope = {
  tenantId: "tenant-1",
  owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  network: "testnet" as const,
  invocationNonce: "nonce-123456789",
};
const gatewayToolName = "PilotReadTarget___pilot.read_market_context";
const runtimeArn = "arn:aws:bedrock-agentcore:us-east-2:123456789012:runtime/pilot_research-AbCdEf1234";
const nowSeconds = Math.floor(Date.now() / 1_000);
const runtimeKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const runtimePublicJwk: JsonWebKey = {
  ...runtimeKeyPair.publicKey.export({ format: "jwk" }),
  kid: "runtime-key-a",
  alg: "RS256",
  use: "sig",
  key_ops: ["verify"],
};
const runtimeJwtPolicy = {
  issuer: "https://identity.example.test/",
  jwksUrl: "https://identity.example.test/.well-known/jwks.json",
  audiences: ["pilot-agentcore-runtime"],
  allowedSubjects: ["pilot-server"],
  allowedClients: ["pilot-client"],
  requiredScopes: ["runtime:invoke"],
  clientClaim: "client_id" as const,
  tenantClaim: "tenant_id",
  algorithms: ["RS256" as const],
  clockToleranceSeconds: 0,
  revocation: { mode: "expiry_only" as const },
};
const oauthConfig = {
  mode: "aws" as const,
  region: "us-east-2" as const,
  runtimeAuthMode: "oauth_jwt" as const,
  runtimeArn,
  qualifier: "pilot_v1",
  runtimeJwtTenantId: "pilot-runtime",
  runtimeJwtPolicy,
  gatewayUrl: "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp",
  gatewayToolName,
  gatewayAuthMode: "custom_jwt" as const,
  gatewayProtocolVersion: "2025-11-25" as const,
  timeoutMs: 1_000,
  maxRequestBytes: 65_536,
  maxResponseBytes: 262_144,
};

function runtimeAuthorization(overrides: Readonly<Record<string, unknown>> = {}): string {
  const header = Buffer.from(JSON.stringify({
    alg: "RS256",
    kid: "runtime-key-a",
    typ: "at+jwt",
  })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: runtimeJwtPolicy.issuer,
    sub: "pilot-server",
    aud: "pilot-agentcore-runtime",
    client_id: "pilot-client",
    scope: "runtime:invoke",
    tenant_id: "pilot-runtime",
    iat: nowSeconds - 5,
    nbf: nowSeconds - 5,
    exp: nowSeconds + 120,
    ...overrides,
  })).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`, "ascii"),
    runtimeKeyPair.privateKey,
  ).toString("base64url");
  return `Bearer ${header}.${payload}.${signature}`;
}

const runtimeJwksFetch = vi.fn(async () => new Response(
  JSON.stringify({ keys: [runtimePublicJwk] }),
  { headers: { "content-type": "application/jwk-set+json" } },
)) as typeof fetch;

function runtimeResult(invocation: Readonly<{
  request: Readonly<{ requestId: string }>;
  scope: typeof scope;
  gatewayBindingDigest: string;
  requestDigest: string;
}>) {
  return {
    protocolVersion: "pilot-agentcore.research.v1",
    transport: "aws-agentcore-runtime",
    dataProvenance: "external-unverified",
    requestId: invocation.request.requestId,
    scopeDigest: deriveAgentCoreScopeDigest(invocation.scope),
    gatewayBindingDigest: invocation.gatewayBindingDigest,
    requestDigest: invocation.requestDigest,
    result: { kind: "read_only", summary: "Bounded OAuth response", evidence: [], caveats: [] },
  };
}

describe("AgentCore Runtime provider", () => {
  it("uses the official SDK command with one attempt and a fresh UUID session", async () => {
    const send = vi.fn(async (command: InvokeAgentRuntimeCommand) => {
      expect(command.input).toMatchObject({
        agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/pilot_research-AbCdEf1234",
        qualifier: "pilot_v1",
        contentType: "application/json",
        accept: "application/json",
      });
      expect(command.input.runtimeSessionId).toMatch(/^[0-9a-f-]{36}$/);
      const invocation = JSON.parse(new TextDecoder().decode(command.input.payload as Uint8Array));
      expect(invocation).toMatchObject({
        request: { requestId: "research-1", purpose: "read" },
        scope,
        allowedTools: [gatewayToolName],
      });
      const result = {
        protocolVersion: "pilot-agentcore.research.v1",
        transport: "aws-agentcore-runtime",
        dataProvenance: "external-unverified",
        requestId: invocation.request.requestId,
        scopeDigest: deriveAgentCoreScopeDigest(invocation.scope),
        gatewayBindingDigest: invocation.gatewayBindingDigest,
        requestDigest: invocation.requestDigest,
        result: { kind: "read_only", summary: "Bounded AWS response", evidence: [], caveats: [] },
      };
      return {
        contentType: "application/json",
        response: new TextEncoder().encode(JSON.stringify(result)),
      } as never;
    });
    const provider = createAgentCoreProposalProvider({
      config: {
        mode: "aws",
        region: "us-east-1",
        runtimeAuthMode: "iam",
        runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/pilot_research-AbCdEf1234",
        qualifier: "pilot_v1",
        gatewayUrl: "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
        gatewayToolName,
        gatewayAuthMode: "custom_jwt",
        gatewayProtocolVersion: "2025-11-25",
        timeoutMs: 1_000,
        maxRequestBytes: 65_536,
        maxResponseBytes: 262_144,
      },
      scope,
      runtimeClient: { send },
    });
    await expect(provider.propose({
      requestId: "research-1",
      purpose: "read",
      prompt: "Research XRP market context",
      context: {},
    })).resolves.toMatchObject({ kind: "read_only", summary: "Bounded AWS response" });
    expect(send).toHaveBeenCalledOnce();
    expect(provider.trust).toEqual({
      transport: "aws-agentcore-runtime",
      localStandin: false,
      runtimeAuthMode: "iam",
    });
  });

  it("uses a locally verified per-invocation JWT on the exact OAuth HTTPS endpoint", async () => {
    const authorization = runtimeAuthorization();
    const resolveAuthorization = vi.fn(async () => authorization);
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://bedrock-agentcore.us-east-2.amazonaws.com/runtimes/" +
        "arn%3Aaws%3Abedrock-agentcore%3Aus-east-2%3A123456789012%3Aruntime%2Fpilot_research-AbCdEf1234/" +
        "invocations?qualifier=pilot_v1",
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(authorization);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("accept")).toBe("application/json");
      const sessionId = headers.get("x-amzn-bedrock-agentcore-runtime-session-id");
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      const invocation = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
      return new Response(JSON.stringify(runtimeResult(invocation)), {
        headers: {
          "content-type": "application/json",
        },
      });
    });
    const provider = createAgentCoreProposalProvider({
      config: oauthConfig,
      scope,
      fetch: transport as typeof fetch,
      runtimeJwksFetch,
      runtimeJwtResolver: { resolveAuthorization },
    });

    await expect(provider.propose({
      requestId: "research-oauth",
      purpose: "read",
      prompt: "Research XRP market context",
      context: {},
    })).resolves.toMatchObject({ kind: "read_only", summary: "Bounded OAuth response" });
    expect(resolveAuthorization).toHaveBeenCalledOnce();
    expect(resolveAuthorization).toHaveBeenCalledWith({
      tenantId: "pilot-runtime",
      audiences: ["pilot-agentcore-runtime"],
      requiredScopes: ["runtime:invoke"],
    }, { signal: expect.any(AbortSignal) });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("fails closed without an injected resolver and rejects an invalid JWT before dispatch", async () => {
    expect(() => createAgentCoreProposalProvider({ config: oauthConfig, scope }))
      .toThrow("OAuth authorization resolver is not configured");
    expect(() => createAgentCoreProposalProviderFromEnv({
      env: {
        AGENTCORE_MODE: "aws",
        AGENTCORE_AWS_REGION: "us-east-2",
        AGENTCORE_RUNTIME_ARN: runtimeArn,
        AGENTCORE_RUNTIME_AUTH_MODE: "oauth_jwt",
        AGENTCORE_RUNTIME_JWT_ISSUER: runtimeJwtPolicy.issuer,
        AGENTCORE_RUNTIME_JWT_JWKS_URL: runtimeJwtPolicy.jwksUrl,
        AGENTCORE_RUNTIME_JWT_AUDIENCES_JSON: '["pilot-agentcore-runtime"]',
        AGENTCORE_RUNTIME_JWT_ALLOWED_SUBJECTS_JSON: '["pilot-server"]',
        AGENTCORE_RUNTIME_JWT_ALLOWED_CLIENTS_JSON: '["pilot-client"]',
        AGENTCORE_RUNTIME_JWT_REQUIRED_SCOPES_JSON: '["runtime:invoke"]',
        AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM: "client_id",
        AGENTCORE_RUNTIME_JWT_TENANT_CLAIM: "tenant_id",
        AGENTCORE_RUNTIME_JWT_TENANT_ID: "pilot-runtime",
        AGENTCORE_RUNTIME_JWT_ALGORITHMS_JSON: '["RS256"]',
        AGENTCORE_RUNTIME_JWT_CLOCK_TOLERANCE_SECONDS: "0",
        AGENTCORE_RUNTIME_JWT_MAX_TOKEN_AGE_SECONDS: "300",
        AGENTCORE_RUNTIME_JWT_MAX_TOKEN_LIFETIME_SECONDS: "300",
        AGENTCORE_RUNTIME_JWT_JWKS_CACHE_TTL_MS: "1000",
        AGENTCORE_RUNTIME_JWT_JWKS_REFRESH_COOLDOWN_MS: "1000",
        AGENTCORE_RUNTIME_JWT_REVOCATION_MODE: "expiry_only",
        AGENTCORE_GATEWAY_URL: oauthConfig.gatewayUrl,
        AGENTCORE_GATEWAY_TOOL_NAME: gatewayToolName,
      },
      scope,
    })).toThrow("OAuth authorization resolver is not configured");

    const transport = vi.fn();
    const invalid = createAgentCoreProposalProvider({
      config: oauthConfig,
      scope,
      fetch: transport as typeof fetch,
      runtimeJwksFetch,
      runtimeJwtResolver: {
        async resolveAuthorization() { return runtimeAuthorization({ sub: "attacker" }); },
      },
    });
    const error = await invalid.propose({
      requestId: "research-invalid-oauth",
      purpose: "read",
      prompt: "Research",
      context: {},
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "failed",
      message: "AgentCore Runtime authorization is unavailable",
    });
    expect(String(error)).not.toContain("Bearer");
    expect(transport).not.toHaveBeenCalled();
  });

  it("passes checker-mode Runtime tokens through the injected revocation boundary", async () => {
    const transport = vi.fn();
    const revocationChecker = vi.fn(async () => "revoked" as const);
    const provider = createAgentCoreProposalProvider({
      config: {
        ...oauthConfig,
        runtimeJwtPolicy: {
          ...runtimeJwtPolicy,
          revocation: { mode: "checker", timeoutMs: 100 },
        },
      },
      scope,
      fetch: transport as typeof fetch,
      runtimeJwksFetch,
      runtimeJwtRevocationChecker: revocationChecker,
      runtimeJwtResolver: {
        async resolveAuthorization() { return runtimeAuthorization({ jti: "runtime-token-1" }); },
      },
    });
    await expect(provider.propose({
      requestId: "research-revoked-oauth",
      purpose: "read",
      prompt: "Research",
      context: {},
    })).rejects.toMatchObject({
      code: "failed",
      message: "AgentCore Runtime authorization is unavailable",
    });
    expect(revocationChecker).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["mismatched session", 200, "application/json", "wrong-session-abcdefghijklmnop", false, "failed"],
    ["wrong content type", 200, "text/plain", "echo", false, "failed"],
    ["authorization rejection", 401, "application/json", "echo", false, "failed"],
    ["service failure", 503, "application/json", "echo", false, "uncertain"],
    ["redirect", 200, "application/json", "echo", true, "uncertain"],
  ])("fails closed for OAuth %s", async (_label, status, contentType, responseSession, redirected, code) => {
    const responseFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requestSession = new Headers(init?.headers)
        .get("x-amzn-bedrock-agentcore-runtime-session-id")!;
      const invocation = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
      const response = new Response(JSON.stringify(runtimeResult(invocation)), {
        status,
        headers: {
          "content-type": contentType,
          "x-amzn-bedrock-agentcore-runtime-session-id": responseSession === "echo"
            ? requestSession
            : responseSession,
        },
      });
      if (redirected) Object.defineProperty(response, "redirected", { value: true });
      return response;
    });
    const provider = createAgentCoreProposalProvider({
      config: oauthConfig,
      scope,
      fetch: responseFetch as typeof fetch,
      runtimeJwksFetch,
      runtimeJwtResolver: { async resolveAuthorization() { return runtimeAuthorization(); } },
    });
    await expect(provider.propose({
      requestId: `research-oauth-${status}-${code}`,
      purpose: "read",
      prompt: "Research",
      context: {},
    })).rejects.toMatchObject({ code });
  });

  it("is off by default and never dispatches", async () => {
    const send = vi.fn();
    const provider = createAgentCoreProposalProvider({
      config: { mode: "off", timeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 },
      scope,
      runtimeClient: { send } as never,
    });
    expect(provider.enabled).toBe(false);
    await expect(provider.propose({
      requestId: "research-1",
      purpose: "read",
      prompt: "Research",
      context: {},
    })).rejects.toMatchObject({ code: "disabled" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a response that is not bound to the server scope", async () => {
    const send = vi.fn(async (command: InvokeAgentRuntimeCommand) => {
      const invocation = JSON.parse(new TextDecoder().decode(command.input.payload as Uint8Array));
      return {
        contentType: "application/json",
        response: new TextEncoder().encode(JSON.stringify({
          protocolVersion: "pilot-agentcore.research.v1",
          transport: "aws-agentcore-runtime",
          dataProvenance: "external-unverified",
          requestId: invocation.request.requestId,
          scopeDigest: "0".repeat(64),
          gatewayBindingDigest: invocation.gatewayBindingDigest,
          requestDigest: invocation.requestDigest,
          result: { kind: "read_only", summary: "Cross-tenant response", evidence: [], caveats: [] },
        })),
      } as never;
    });
    const provider = createAgentCoreProposalProvider({
      config: {
        mode: "aws",
        region: "us-east-1",
        runtimeAuthMode: "iam",
        runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/pilot_research-AbCdEf1234",
        qualifier: "pilot_v1",
        gatewayUrl: "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
        gatewayToolName,
        gatewayAuthMode: "custom_jwt",
        gatewayProtocolVersion: "2025-11-25",
        timeoutMs: 1_000,
        maxRequestBytes: 65_536,
        maxResponseBytes: 262_144,
      },
      scope,
      runtimeClient: { send },
    });
    await expect(provider.propose({
      requestId: "research-cross-scope",
      purpose: "read",
      prompt: "Research XRP market context",
      context: {},
    })).rejects.toMatchObject({ code: "failed", message: "AgentCore Runtime returned an invalid scoped response" });
  });

  it("rejects credential-shaped prompt text before dispatch", async () => {
    const send = vi.fn();
    const provider = createAgentCoreProposalProvider({
      config: {
        mode: "aws",
        region: "us-east-1",
        runtimeAuthMode: "iam",
        runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/pilot_research-AbCdEf1234",
        qualifier: "pilot_v1",
        gatewayUrl: "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
        gatewayToolName,
        gatewayAuthMode: "custom_jwt",
        gatewayProtocolVersion: "2025-11-25",
        timeoutMs: 1_000,
        maxRequestBytes: 65_536,
        maxResponseBytes: 262_144,
      },
      scope,
      runtimeClient: { send } as never,
    });
    await expect(provider.propose({
      requestId: "research-secret",
      purpose: "read",
      prompt: "Use Bearer abcdefghijklmnopqrstuvwxyz",
      context: {},
    })).rejects.toThrow("Sensitive material is not accepted");
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds a noncompliant AWS SDK response stream and requests iterator cleanup", async () => {
    const returned = vi.fn(async () => ({ done: true, value: undefined }));
    const response = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: returned,
        };
      },
    };
    const provider = createAgentCoreProposalProvider({
      config: {
        mode: "aws",
        region: "us-east-1",
        runtimeAuthMode: "iam",
        runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/pilot_research-AbCdEf1234",
        qualifier: "pilot_v1",
        gatewayUrl: "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
        gatewayToolName,
        gatewayAuthMode: "custom_jwt",
        gatewayProtocolVersion: "2025-11-25",
        timeoutMs: 25,
        maxRequestBytes: 65_536,
        maxResponseBytes: 262_144,
      },
      scope,
      runtimeClient: {
        async send() { return { contentType: "application/json", response } as never; },
      },
    });
    await expect(provider.propose({
      requestId: "research-hung-sdk-body",
      purpose: "read",
      prompt: "Research",
      context: {},
    })).rejects.toMatchObject({ code: "uncertain" });
    expect(returned).toHaveBeenCalledOnce();
  });

  it("bounds a noncompliant stand-in response body and cancels its reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel,
    });
    const provider = createAgentCoreProposalProvider({
      config: {
        mode: "standin",
        endpoint: "http://127.0.0.1:32147",
        gatewayToolName,
        timeoutMs: 25,
        maxRequestBytes: 65_536,
        maxResponseBytes: 262_144,
      },
      scope,
      fetch: async () => new Response(body, {
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(provider.propose({
      requestId: "research-hung-fetch-body",
      purpose: "read",
      prompt: "Research",
      context: {},
    })).rejects.toMatchObject({ code: "uncertain" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
