import {
  generateKeyPairSync,
  sign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

import {
  AGENTCORE_MCP_PROTOCOL_VERSION,
  AGENTCORE_PROTOCOL_VERSION,
  deriveAgentCoreGatewayBindingDigest,
  deriveAgentCoreRequestDigest,
  deriveAgentCoreScopeDigest,
} from "../../src/contracts";

export const IDENTITY_ACCEPTANCE_NOW = Date.parse("2026-10-25T12:00:00.000Z");
export const IDENTITY_ACCEPTANCE_ISSUER = "https://identity.example.test/oauth2/default";
export const IDENTITY_ACCEPTANCE_JWKS = "https://identity.example.test/.well-known/jwks.json";
export const IDENTITY_ACCEPTANCE_AUDIENCE = "pilot-agentcore-gateway";
export const IDENTITY_ACCEPTANCE_SUBJECT = "pilot-runtime-workload";
export const IDENTITY_ACCEPTANCE_CLIENT = "pilot-runtime-client";
export const IDENTITY_ACCEPTANCE_TENANT = "pilot-runtime-deployment";
export const IDENTITY_ACCEPTANCE_SCOPE = "pilot.read_market_context";
export const IDENTITY_ACCEPTANCE_GATEWAY =
  "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp";
export const IDENTITY_ACCEPTANCE_TOOL = "PilotReadTarget___pilot.read_market_context";
export const IDENTITY_ACCEPTANCE_WORKLOAD_TOKEN = "opaque-platform-workload-token";

const pair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const publicJwk: JsonWebKey = Object.freeze({
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "identity-acceptance-key",
  alg: "RS256",
  use: "sig",
  key_ops: ["verify"],
});

export const identityAcceptanceScope = Object.freeze({
  tenantId: "wallet-tenant",
  owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  network: "testnet" as const,
  invocationNonce: "identity-acceptance-nonce",
});

export const identityAcceptanceRequest = Object.freeze({
  requestId: "identity-acceptance-1",
  purpose: "read" as const,
  prompt: "Read public XRP/RLUSD market context",
  context: { pair: "XRP/RLUSD" },
});

const gatewayBindingDigest = deriveAgentCoreGatewayBindingDigest({
  gatewayUrl: IDENTITY_ACCEPTANCE_GATEWAY,
  gatewayToolName: IDENTITY_ACCEPTANCE_TOOL,
  gatewayProtocolVersion: AGENTCORE_MCP_PROTOCOL_VERSION,
  gatewayAuthMode: "custom_jwt",
});
const scopeDigest = deriveAgentCoreScopeDigest(identityAcceptanceScope);
const requestDigest = deriveAgentCoreRequestDigest({
  request: identityAcceptanceRequest,
  scopeDigest,
  gatewayBindingDigest,
});

export const identityAcceptanceInvocation = Object.freeze({
  protocolVersion: AGENTCORE_PROTOCOL_VERSION,
  request: identityAcceptanceRequest,
  scope: identityAcceptanceScope,
  allowedTools: [IDENTITY_ACCEPTANCE_TOOL] as const,
  gatewayBindingDigest,
  requestDigest,
});

export const identityAcceptanceConfig = Object.freeze({
  gatewayUrl: IDENTITY_ACCEPTANCE_GATEWAY,
  gatewayToolName: IDENTITY_ACCEPTANCE_TOOL,
  jwtDeploymentTenantId: IDENTITY_ACCEPTANCE_TENANT,
  replayDeploymentId: "pilot-runtime-identity-acceptance",
  replayLeaseMs: 30_000,
  replayRetentionMs: 86_400_000,
  jwtPolicy: {
    issuer: IDENTITY_ACCEPTANCE_ISSUER,
    jwksUrl: IDENTITY_ACCEPTANCE_JWKS,
    audiences: [IDENTITY_ACCEPTANCE_AUDIENCE],
    allowedSubjects: [IDENTITY_ACCEPTANCE_SUBJECT],
    allowedClients: [IDENTITY_ACCEPTANCE_CLIENT],
    requiredScopes: [IDENTITY_ACCEPTANCE_SCOPE],
    clientClaim: "client_id" as const,
    tenantClaim: "tenant_id",
    algorithms: ["RS256" as const],
    clockToleranceSeconds: 0,
    maxTokenAgeSeconds: 300,
    maxTokenLifetimeSeconds: 300,
    cacheTtlMs: 1_000,
  },
  requestTimeoutMs: 1_000,
});

export function signIdentityAcceptanceJwt(
  overrides: Readonly<Record<string, unknown>> = {},
  key: KeyObject = pair.privateKey,
): string {
  const now = Math.floor(IDENTITY_ACCEPTANCE_NOW / 1_000);
  const header = Buffer.from(JSON.stringify({
    alg: "RS256",
    kid: "identity-acceptance-key",
    typ: "at+jwt",
  })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: IDENTITY_ACCEPTANCE_ISSUER,
    sub: IDENTITY_ACCEPTANCE_SUBJECT,
    aud: IDENTITY_ACCEPTANCE_AUDIENCE,
    client_id: IDENTITY_ACCEPTANCE_CLIENT,
    scope: IDENTITY_ACCEPTANCE_SCOPE,
    tenant_id: IDENTITY_ACCEPTANCE_TENANT,
    jti: "00000000-0000-4000-8000-000000000001",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 120,
    ...overrides,
  })).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`, "ascii"),
    key,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export function createIdentityAcceptanceAwsMock(accessToken = signIdentityAcceptanceJwt()) {
  const commands: unknown[] = [];
  return Object.freeze({
    commands,
    client: Object.freeze({
      async send(command: unknown): Promise<Readonly<{ accessToken: string }>> {
        commands.push(command);
        return { accessToken };
      },
    }),
  });
}

export function createIdentityAcceptanceJwksMock() {
  let keys: readonly JsonWebKey[] = [publicJwk];
  let calls = 0;
  return Object.freeze({
    fetch: (async (input: string | URL | Request) => {
      if (String(input) !== IDENTITY_ACCEPTANCE_JWKS) {
        throw new Error("unexpected JWKS fixture URL");
      }
      calls += 1;
      return new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { "content-type": "application/jwk-set+json" },
      });
    }) as typeof fetch,
    calls: () => calls,
    replaceKeys(next: readonly JsonWebKey[]) {
      keys = Object.freeze([...next]);
    },
  });
}

export function unrelatedIdentityAcceptanceJwk(): JsonWebKey {
  const unrelated = generateKeyPairSync("rsa", { modulusLength: 2_048 });
  return Object.freeze({
    ...unrelated.publicKey.export({ format: "jwk" }),
    kid: "replacement-identity-key",
    alg: "RS256",
    use: "sig",
    key_ops: ["verify"],
  });
}

export function createIdentityAcceptanceGatewayMock() {
  let dispatches = 0;
  let calls = 0;
  return Object.freeze({
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const headers = new Headers(init?.headers);
      if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
        headers.get("authorization") ?? "",
      )) {
        throw new Error("Gateway fixture received unverified authorization");
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const message = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (message.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: AGENTCORE_MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "identity-acceptance-fixture", version: "1.0.0" },
          },
        }), {
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "identity-acceptance-session",
          },
        });
      }
      if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
        return new Response(null, { status: 202 });
      }
      if (message.method !== "tools/call") throw new Error("unexpected Gateway fixture method");
      dispatches += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "synthetic local identity acceptance fixture" }],
          structuredContent: {
            summary: "Synthetic local identity acceptance fixture",
            evidence: [],
            caveats: ["No AWS service was contacted."],
          },
          isError: false,
        },
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    calls: () => calls,
    dispatches: () => dispatches,
  });
}
