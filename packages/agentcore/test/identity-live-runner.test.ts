import { describe, expect, it, vi } from "vitest";

import {
  runAgentCoreIdentityLiveAcceptance,
  serializeAgentCoreIdentityLiveAcceptanceReport,
} from "../src/identity-live-runner";
import {
  AGENTCORE_PROTOCOL_VERSION,
  deriveAgentCoreScopeDigest,
} from "../src/contracts";
import {
  createIdentityAcceptanceJwksMock,
  IDENTITY_ACCEPTANCE_AUDIENCE,
  IDENTITY_ACCEPTANCE_CLIENT,
  IDENTITY_ACCEPTANCE_ISSUER,
  IDENTITY_ACCEPTANCE_JWKS,
  IDENTITY_ACCEPTANCE_SCOPE,
  IDENTITY_ACCEPTANCE_SUBJECT,
  IDENTITY_ACCEPTANCE_TENANT,
  signIdentityAcceptanceJwt,
} from "./support/identity-fixture";

const RUN_ID = "00000000-0000-4000-8000-000000000003";
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const RUNTIME_AUDIENCE = "pilot-agentcore-runtime";
const RUNTIME_CLIENT = "pilot-runtime-caller";
const RUNTIME_SCOPE = "pilot.invoke_research";
const RUNTIME_TENANT = "pilot-agentcore-event-workload";

const liveEnvironment = Object.freeze({
  AGENTCORE_IDENTITY_ACCEPTANCE_MODE: "live",
  AGENTCORE_IDENTITY_LIVE_APPROVAL: "I_APPROVE_ONE_BOUNDED_AGENTCORE_IDENTITY_READ_ONLY_RUN",
  AGENTCORE_IDENTITY_ACCEPTANCE_RUN_ID: RUN_ID,
  AGENTCORE_IDENTITY_ACCEPTANCE_APPROVED_AT: "2026-10-25T11:55:00.000Z",
  AGENTCORE_IDENTITY_ACCEPTANCE_OWNER: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  AGENTCORE_MODE: "aws",
  AGENTCORE_AWS_REGION: "us-east-2",
  AGENTCORE_RUNTIME_ARN:
    "arn:aws:bedrock-agentcore:us-east-2:123456789012:runtime/pilot_research-AbCdEf1234",
  AGENTCORE_RUNTIME_QUALIFIER: "pilot_v1",
  AGENTCORE_RUNTIME_AUTH_MODE: "oauth_jwt",
  AGENTCORE_RUNTIME_JWT_ISSUER: IDENTITY_ACCEPTANCE_ISSUER,
  AGENTCORE_RUNTIME_JWT_JWKS_URL: IDENTITY_ACCEPTANCE_JWKS,
  AGENTCORE_RUNTIME_JWT_AUDIENCES_JSON: JSON.stringify([RUNTIME_AUDIENCE]),
  AGENTCORE_RUNTIME_JWT_ALLOWED_SUBJECTS_JSON: JSON.stringify([IDENTITY_ACCEPTANCE_SUBJECT]),
  AGENTCORE_RUNTIME_JWT_ALLOWED_CLIENTS_JSON: JSON.stringify([RUNTIME_CLIENT]),
  AGENTCORE_RUNTIME_JWT_REQUIRED_SCOPES_JSON: JSON.stringify([RUNTIME_SCOPE]),
  AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM: "client_id",
  AGENTCORE_RUNTIME_JWT_TENANT_CLAIM: "tenant_id",
  AGENTCORE_RUNTIME_JWT_TENANT_ID: RUNTIME_TENANT,
  AGENTCORE_RUNTIME_JWT_ALGORITHMS_JSON: '["RS256"]',
  AGENTCORE_RUNTIME_JWT_CLOCK_TOLERANCE_SECONDS: "30",
  AGENTCORE_RUNTIME_JWT_MAX_TOKEN_AGE_SECONDS: "300",
  AGENTCORE_RUNTIME_JWT_MAX_TOKEN_LIFETIME_SECONDS: "600",
  AGENTCORE_RUNTIME_JWT_JWKS_CACHE_TTL_MS: "300000",
  AGENTCORE_RUNTIME_JWT_JWKS_REFRESH_COOLDOWN_MS: "10000",
  AGENTCORE_RUNTIME_JWT_REVOCATION_MODE: "expiry_only",
  AGENTCORE_RUNTIME_OAUTH_GRANT_TYPE: "client_credentials",
  AGENTCORE_RUNTIME_OAUTH_TOKEN_AUTH_METHOD: "client_secret_basic",
  AGENTCORE_RUNTIME_OAUTH_TOKEN_URL: "https://identity.example.test/oauth2/token",
  AGENTCORE_RUNTIME_OAUTH_CLIENT_ID: RUNTIME_CLIENT,
  AGENTCORE_RUNTIME_OAUTH_CLIENT_SECRET_REF: "pilot-runtime-client-secret",
  AGENTCORE_GATEWAY_URL:
    "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp",
  AGENTCORE_GATEWAY_TOOL_NAME: "PilotReadTarget___pilot.read_market_context",
  AGENTCORE_IDENTITY_CREDENTIAL_PROVIDER_NAME: "pilot-gateway-jwt",
  AGENTCORE_GATEWAY_JWT_ISSUER: IDENTITY_ACCEPTANCE_ISSUER,
  AGENTCORE_GATEWAY_JWT_JWKS_URL: IDENTITY_ACCEPTANCE_JWKS,
  AGENTCORE_GATEWAY_JWT_AUDIENCES_JSON: JSON.stringify([IDENTITY_ACCEPTANCE_AUDIENCE]),
  AGENTCORE_GATEWAY_JWT_ALLOWED_SUBJECTS_JSON: JSON.stringify([IDENTITY_ACCEPTANCE_SUBJECT]),
  AGENTCORE_GATEWAY_JWT_ALLOWED_CLIENTS_JSON: JSON.stringify([IDENTITY_ACCEPTANCE_CLIENT]),
  AGENTCORE_GATEWAY_JWT_REQUIRED_SCOPES_JSON: JSON.stringify([IDENTITY_ACCEPTANCE_SCOPE]),
  AGENTCORE_GATEWAY_JWT_CLIENT_CLAIM: "client_id",
  AGENTCORE_GATEWAY_JWT_TENANT_CLAIM: "tenant_id",
  AGENTCORE_GATEWAY_JWT_DEPLOYMENT_TENANT_ID: IDENTITY_ACCEPTANCE_TENANT,
  AGENTCORE_GATEWAY_JWT_ALGORITHMS_JSON: '["RS256"]',
  AGENTCORE_GATEWAY_JWT_CLOCK_TOLERANCE_SECONDS: "0",
  AGENTCORE_GATEWAY_JWT_MAX_TOKEN_AGE_SECONDS: "300",
  AGENTCORE_GATEWAY_JWT_MAX_TOKEN_LIFETIME_SECONDS: "300",
  AGENTCORE_GATEWAY_JWT_JWKS_CACHE_TTL_MS: "1000",
  AGENTCORE_GATEWAY_JWT_JWKS_REFRESH_COOLDOWN_MS: "1000",
  AGENTCORE_GATEWAY_JWT_REVOCATION_MODE: "expiry_only",
  AGENTCORE_REPLAY_TABLE: "pilot-agentcore-replay",
  AGENTCORE_REPLAY_DEPLOYMENT_ID: "pilot-runtime-identity-acceptance",
});

describe("bounded AgentCore live acceptance runner", () => {
  it("is inert by default and never resolves a secret or performs transport I/O", async () => {
    const secretProvider = { resolveSecret: vi.fn() };
    const transport = vi.fn();
    await expect(runAgentCoreIdentityLiveAcceptance({
      env: { AGENTCORE_IDENTITY_ACCEPTANCE_MODE: "offline" },
      secretProvider,
      oauthFetch: transport,
      runtimeFetch: transport,
      jwksFetch: transport,
    })).resolves.toMatchObject({
      mode: "offline",
      runtimeInvocations: 0,
      scenario: { status: "NOT_RUN" },
    });
    expect(secretProvider.resolveSecret).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("runs exactly one fixed public-market Runtime request after fresh approval", async () => {
    const seconds = Math.floor(Date.now() / 1_000);
    const accessToken = signIdentityAcceptanceJwt({
      iss: IDENTITY_ACCEPTANCE_ISSUER,
      aud: RUNTIME_AUDIENCE,
      sub: IDENTITY_ACCEPTANCE_SUBJECT,
      client_id: RUNTIME_CLIENT,
      scope: RUNTIME_SCOPE,
      tenant_id: RUNTIME_TENANT,
      iat: seconds - 1,
      nbf: seconds - 1,
      exp: seconds + 120,
    });
    const secretProvider = { resolveSecret: vi.fn(async () => "fixture-client-secret") };
    const oauthFetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      scope: RUNTIME_SCOPE,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const runtimeFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : String(init?.body);
      const invocation = JSON.parse(body) as {
        request: { requestId: string };
        scope: Parameters<typeof deriveAgentCoreScopeDigest>[0];
        gatewayBindingDigest: string;
        requestDigest: string;
      };
      expect(invocation.request.requestId).toBe(`acceptance-${RUN_ID}`);
      expect(body).toContain("XRP/RLUSD");
      expect(body).not.toContain("fixture-client-secret");
      return new Response(JSON.stringify({
        protocolVersion: AGENTCORE_PROTOCOL_VERSION,
        transport: "aws-agentcore-runtime",
        dataProvenance: "external-unverified",
        requestId: invocation.request.requestId,
        scopeDigest: deriveAgentCoreScopeDigest(invocation.scope),
        gatewayBindingDigest: invocation.gatewayBindingDigest,
        requestDigest: invocation.requestDigest,
        result: { kind: "read_only", summary: "Bounded public fixture", evidence: [], caveats: [] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const jwks = createIdentityAcceptanceJwksMock();
    const report = await runAgentCoreIdentityLiveAcceptance({
      args: ["--live"],
      env: liveEnvironment,
      now: () => NOW,
      secretProvider,
      oauthFetch,
      runtimeFetch,
      jwksFetch: jwks.fetch,
    });
    expect(report).toMatchObject({
      mode: "live",
      runtimeInvocations: 1,
      scenario: { id: "bounded-public-market-read", status: "PASS" },
    });
    expect(oauthFetch).toHaveBeenCalledTimes(1);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    const serialized = serializeAgentCoreIdentityLiveAcceptanceReport(report);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain("fixture-client-secret");
    expect(serialized).not.toContain("Bounded public fixture");
  });

  it("fails before transport without the exact approval or a server-only secret provider", async () => {
    const transport = vi.fn();
    await expect(runAgentCoreIdentityLiveAcceptance({
      args: ["--live"],
      env: { ...liveEnvironment, AGENTCORE_IDENTITY_LIVE_APPROVAL: "yes" },
      now: () => NOW,
      secretProvider: { resolveSecret: vi.fn() },
      oauthFetch: transport,
      runtimeFetch: transport,
    })).rejects.toThrow("approval marker");
    await expect(runAgentCoreIdentityLiveAcceptance({
      args: ["--live"],
      env: liveEnvironment,
      now: () => NOW,
      oauthFetch: transport,
      runtimeFetch: transport,
    })).rejects.toThrow("server-only secret provider");
    expect(transport).not.toHaveBeenCalled();
  });
});
