import { GetResourceOauth2TokenCommand } from "@aws-sdk/client-bedrock-agentcore";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AGENTCORE_IDENTITY_LIVE_APPROVAL_MARKER,
  readAgentCoreIdentityAcceptancePreflight,
  serializeAgentCoreIdentityAcceptanceReport,
  type AgentCoreIdentityAcceptanceStatus,
} from "../src/identity-acceptance";
import { createAgentCoreIdentityM2mJwtResolver } from "../src/identity-sdk";
import type { AgentCoreTokenRevocationChecker } from "../src/jwt";
import { createInMemoryAgentCoreReplayStore, type AgentCoreReplayStore } from "../src/replay";
import {
  createAgentCoreProductionRuntimeInvoker,
  type AgentCoreProductionRuntimeConfig,
} from "../src/runtime-production";
import { startAgentCoreRuntimeHttpServer } from "../src/runtime-http";
import {
  createIdentityAcceptanceAwsMock,
  createIdentityAcceptanceGatewayMock,
  createIdentityAcceptanceJwksMock,
  IDENTITY_ACCEPTANCE_AUDIENCE,
  IDENTITY_ACCEPTANCE_CLIENT,
  IDENTITY_ACCEPTANCE_GATEWAY,
  IDENTITY_ACCEPTANCE_ISSUER,
  IDENTITY_ACCEPTANCE_JWKS,
  IDENTITY_ACCEPTANCE_NOW,
  IDENTITY_ACCEPTANCE_SCOPE,
  IDENTITY_ACCEPTANCE_SUBJECT,
  IDENTITY_ACCEPTANCE_TENANT,
  IDENTITY_ACCEPTANCE_TOOL,
  IDENTITY_ACCEPTANCE_WORKLOAD_TOKEN,
  identityAcceptanceConfig,
  identityAcceptanceInvocation,
  signIdentityAcceptanceJwt,
  unrelatedIdentityAcceptanceJwk,
} from "./support/identity-fixture";

const nativeFetch = globalThis.fetch.bind(globalThis);

type Scenario = Readonly<{
  id: string;
  status: AgentCoreIdentityAcceptanceStatus;
}>;

function compose(input: Readonly<{
  token?: string;
  config?: AgentCoreProductionRuntimeConfig;
  now?: () => number;
  awsMock?: ReturnType<typeof createIdentityAcceptanceAwsMock>;
  jwksMock?: ReturnType<typeof createIdentityAcceptanceJwksMock>;
  gatewayMock?: ReturnType<typeof createIdentityAcceptanceGatewayMock>;
  jwtRevocationChecker?: AgentCoreTokenRevocationChecker;
}> = {}) {
  const awsMock = input.awsMock ?? createIdentityAcceptanceAwsMock(input.token);
  const jwksMock = input.jwksMock ?? createIdentityAcceptanceJwksMock();
  const gatewayMock = input.gatewayMock ?? createIdentityAcceptanceGatewayMock();
  const config = input.config ?? identityAcceptanceConfig;
  const resolver = createAgentCoreIdentityM2mJwtResolver({
    region: "us-east-2",
    resourceCredentialProviderName: "pilot-gateway-jwt",
    scopes: config.jwtPolicy.requiredScopes,
    audiences: config.jwtPolicy.audiences,
    timeoutMs: 1_000,
  }, { client: awsMock.client as never });
  const replayBacking = createInMemoryAgentCoreReplayStore({
    nextLeaseId: () => "00000000-0000-4000-8000-000000000002",
  });
  const replayInputs: unknown[] = [];
  const replayStore: AgentCoreReplayStore = Object.freeze({
    claim(input: Parameters<AgentCoreReplayStore["claim"]>[0]) {
      replayInputs.push(input);
      return replayBacking.claim(input);
    },
    markDispatched(input: Parameters<AgentCoreReplayStore["markDispatched"]>[0]) {
      replayInputs.push(input);
      return replayBacking.markDispatched(input);
    },
    complete(input: Parameters<AgentCoreReplayStore["complete"]>[0]) {
      replayInputs.push(input);
      return replayBacking.complete(input);
    },
    releaseClaim(input: Parameters<AgentCoreReplayStore["releaseClaim"]>[0]) {
      replayInputs.push(input);
      return replayBacking.releaseClaim(input);
    },
  });
  return Object.freeze({
    awsMock,
    jwksMock,
    gatewayMock,
    replayStore,
    replayInputs,
    invoker: createAgentCoreProductionRuntimeInvoker({
      config,
      workloadJwtResolver: resolver,
      replayStore,
      jwksFetch: jwksMock.fetch,
      gatewayFetch: gatewayMock.fetch,
      now: input.now ?? (() => IDENTITY_ACCEPTANCE_NOW),
      ...(input.jwtRevocationChecker
        ? { jwtRevocationChecker: input.jwtRevocationChecker }
        : {}),
    }),
  });
}

function context() {
  return {
    signal: new AbortController().signal,
    workloadAccessToken: IDENTITY_ACCEPTANCE_WORKLOAD_TOKEN,
  };
}

async function rejectedToken(
  overrides: Readonly<Record<string, unknown>>,
  config: AgentCoreProductionRuntimeConfig = identityAcceptanceConfig,
): Promise<void> {
  const value = compose({ token: signIdentityAcceptanceJwt(overrides), config });
  await expect(value.invoker.invoke(identityAcceptanceInvocation, context()))
    .rejects.toMatchObject({ code: "authorization" });
  expect(value.gatewayMock.dispatches()).toBe(0);
}

async function scenario(id: string, work: () => Promise<void>): Promise<Scenario> {
  try {
    await work();
    return { id, status: "PASS" };
  } catch {
    return { id, status: "FAIL" };
  }
}

const liveEnvironment = Object.freeze({
  AGENTCORE_IDENTITY_ACCEPTANCE_MODE: "live",
  AGENTCORE_IDENTITY_LIVE_APPROVAL: AGENTCORE_IDENTITY_LIVE_APPROVAL_MARKER,
  AGENTCORE_IDENTITY_ACCEPTANCE_RUN_ID: "00000000-0000-4000-8000-000000000003",
  AGENTCORE_IDENTITY_ACCEPTANCE_APPROVED_AT: "2026-10-25T11:55:00.000Z",
  AGENTCORE_AWS_REGION: "us-east-2",
  AGENTCORE_RUNTIME_ARN:
    "arn:aws:bedrock-agentcore:us-east-2:123456789012:runtime/pilot_research-AbCdEf1234",
  AGENTCORE_RUNTIME_QUALIFIER: "pilot_v1",
  AGENTCORE_RUNTIME_AUTH_MODE: "oauth_jwt",
  AGENTCORE_RUNTIME_JWT_ISSUER: "https://runtime-identity.example.test/",
  AGENTCORE_RUNTIME_JWT_JWKS_URL: "https://runtime-identity.example.test/.well-known/jwks.json",
  AGENTCORE_RUNTIME_JWT_AUDIENCES_JSON: '["pilot-agentcore-runtime"]',
  AGENTCORE_RUNTIME_JWT_ALLOWED_SUBJECTS_JSON: '["pilot-server"]',
  AGENTCORE_RUNTIME_JWT_ALLOWED_CLIENTS_JSON: '["pilot-runtime-caller"]',
  AGENTCORE_RUNTIME_JWT_REQUIRED_SCOPES_JSON: '["pilot.invoke_research"]',
  AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM: "client_id",
  AGENTCORE_RUNTIME_JWT_TENANT_CLAIM: "tenant_id",
  AGENTCORE_RUNTIME_JWT_TENANT_ID: "pilot-agentcore-event-workload",
  AGENTCORE_RUNTIME_JWT_ALGORITHMS_JSON: '["RS256"]',
  AGENTCORE_RUNTIME_JWT_CLOCK_TOLERANCE_SECONDS: "30",
  AGENTCORE_RUNTIME_JWT_MAX_TOKEN_AGE_SECONDS: "300",
  AGENTCORE_RUNTIME_JWT_MAX_TOKEN_LIFETIME_SECONDS: "600",
  AGENTCORE_RUNTIME_JWT_JWKS_CACHE_TTL_MS: "300000",
  AGENTCORE_RUNTIME_JWT_JWKS_REFRESH_COOLDOWN_MS: "10000",
  AGENTCORE_RUNTIME_JWT_REVOCATION_MODE: "expiry_only",
  AGENTCORE_GATEWAY_URL: IDENTITY_ACCEPTANCE_GATEWAY,
  AGENTCORE_GATEWAY_TOOL_NAME: IDENTITY_ACCEPTANCE_TOOL,
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

describe("AgentCore identity offline acceptance", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("unexpected global network access during offline identity acceptance");
    }));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("composes the injected Identity, JWT/JWKS, Gateway, replay, and Runtime header boundaries", async () => {
    const scenarios: Scenario[] = [];

    scenarios.push(await scenario("valid-composed-chain", async () => {
      const value = compose();
      await expect(value.invoker.invoke(identityAcceptanceInvocation, context())).resolves.toMatchObject({
        transport: "aws-agentcore-runtime",
        dataProvenance: "external-unverified",
        requestId: identityAcceptanceInvocation.request.requestId,
      });
      expect(value.awsMock.commands).toHaveLength(1);
      expect(value.awsMock.commands[0]).toBeInstanceOf(GetResourceOauth2TokenCommand);
      expect((value.awsMock.commands[0] as GetResourceOauth2TokenCommand).input).toEqual({
        workloadIdentityToken: IDENTITY_ACCEPTANCE_WORKLOAD_TOKEN,
        resourceCredentialProviderName: "pilot-gateway-jwt",
        scopes: [IDENTITY_ACCEPTANCE_SCOPE],
        oauth2Flow: "M2M",
        audiences: [IDENTITY_ACCEPTANCE_AUDIENCE],
      });
      expect(value.gatewayMock.dispatches()).toBe(1);
    }));

    scenarios.push(await scenario("issuer-binding", async () => {
      await rejectedToken({ iss: "https://another.example.test/oauth2/default" });
    }));
    scenarios.push(await scenario("audience-binding", async () => {
      await rejectedToken({ aud: "another-gateway" });
      await rejectedToken({ aud: [IDENTITY_ACCEPTANCE_AUDIENCE, "unexpected-second-audience"] });
    }));
    scenarios.push(await scenario("subject-binding", async () => {
      await rejectedToken({ sub: "another-runtime" });
    }));
    scenarios.push(await scenario("client-binding", async () => {
      await rejectedToken({ client_id: "another-client" });
      const azpConfig: AgentCoreProductionRuntimeConfig = {
        ...identityAcceptanceConfig,
        jwtPolicy: { ...identityAcceptanceConfig.jwtPolicy, clientClaim: "azp" },
      };
      const value = compose({
        token: signIdentityAcceptanceJwt({ client_id: undefined, azp: IDENTITY_ACCEPTANCE_CLIENT }),
        config: azpConfig,
      });
      await expect(value.invoker.invoke(identityAcceptanceInvocation, context())).resolves.toBeDefined();
    }));
    scenarios.push(await scenario("tenant-binding", async () => {
      await rejectedToken({ tenant_id: "wallet-tenant" });
    }));
    scenarios.push(await scenario("scope-binding", async () => {
      await rejectedToken({ scope: "another:scope" });
      await rejectedToken({ scope: `${IDENTITY_ACCEPTANCE_SCOPE} unexpected:scope` });
    }));
    scenarios.push(await scenario("expiration-binding", async () => {
      await rejectedToken({ exp: Math.floor(IDENTITY_ACCEPTANCE_NOW / 1_000) - 1 });
      await rejectedToken({ exp: undefined });
      await rejectedToken({ exp: Math.floor(IDENTITY_ACCEPTANCE_NOW / 1_000) + 301 });
    }));
    scenarios.push(await scenario("not-before-binding", async () => {
      await rejectedToken({ nbf: Math.floor(IDENTITY_ACCEPTANCE_NOW / 1_000) + 1 });
      await rejectedToken({ iat: Math.floor(IDENTITY_ACCEPTANCE_NOW / 1_000) + 1 });
    }));

    scenarios.push(await scenario("resolver-revocation-blocks-replay", async () => {
      const token = signIdentityAcceptanceJwt();
      let calls = 0;
      const commands: unknown[] = [];
      const awsMock = {
        commands,
        client: {
          async send(command: unknown) {
            commands.push(command);
            calls += 1;
            if (calls > 1) throw new Error("fixture credential provider revoked");
            return { accessToken: token };
          },
        },
      } as ReturnType<typeof createIdentityAcceptanceAwsMock>;
      const value = compose({ awsMock });
      await expect(value.invoker.invoke(identityAcceptanceInvocation, context())).resolves.toBeDefined();
      await expect(value.invoker.invoke(identityAcceptanceInvocation, context()))
        .rejects.toMatchObject({ code: "authorization" });
      expect(value.gatewayMock.dispatches()).toBe(1);
    }));

    scenarios.push(await scenario("jwks-revocation-bound", async () => {
      let now = IDENTITY_ACCEPTANCE_NOW;
      const jwksMock = createIdentityAcceptanceJwksMock();
      const value = compose({ jwksMock, now: () => now });
      await expect(value.invoker.invoke(identityAcceptanceInvocation, context())).resolves.toBeDefined();
      jwksMock.replaceKeys([unrelatedIdentityAcceptanceJwk()]);
      now += 1_001;
      await expect(value.invoker.invoke(identityAcceptanceInvocation, context()))
        .rejects.toMatchObject({ code: "authorization" });
      expect(value.gatewayMock.dispatches()).toBe(1);
    }));

    scenarios.push(await scenario("immediate-per-token-revocation", async () => {
      const revocationChecker = vi.fn<AgentCoreTokenRevocationChecker>(async () => "active");
      const config: AgentCoreProductionRuntimeConfig = {
        ...identityAcceptanceConfig,
        jwtPolicy: {
          ...identityAcceptanceConfig.jwtPolicy,
          revocation: { mode: "checker", timeoutMs: 100 },
        },
      };
      const value = compose({ config, jwtRevocationChecker: revocationChecker });
      await expect(value.invoker.invoke(identityAcceptanceInvocation, context())).resolves.toBeDefined();
      revocationChecker.mockResolvedValueOnce("revoked");
      await expect(value.invoker.invoke(identityAcceptanceInvocation, context()))
        .rejects.toMatchObject({ code: "authorization" });
      expect(revocationChecker).toHaveBeenCalledTimes(2);
      expect(value.gatewayMock.dispatches()).toBe(1);
    }));

    scenarios.push(await scenario("replay-reauthenticates", async () => {
      const value = compose();
      await expect(value.invoker.invoke(identityAcceptanceInvocation, context())).resolves.toBeDefined();
      await expect(value.invoker.invoke(identityAcceptanceInvocation, context())).resolves.toBeDefined();
      expect(value.awsMock.commands).toHaveLength(2);
      expect(value.gatewayMock.dispatches()).toBe(1);
      const persistedInputs = JSON.stringify(value.replayInputs);
      expect(persistedInputs).not.toContain(IDENTITY_ACCEPTANCE_WORKLOAD_TOKEN);
      expect(persistedInputs).not.toContain(identityAcceptanceInvocation.request.prompt);
      expect(persistedInputs).not.toContain(identityAcceptanceInvocation.scope.owner);
      expect(persistedInputs).not.toContain(identityAcceptanceInvocation.scope.tenantId);
    }));

    scenarios.push(await scenario("runtime-header-boundary", async () => {
      const value = compose();
      const runtime = await startAgentCoreRuntimeHttpServer({
        handler: value.invoker,
        host: "127.0.0.1",
        port: 0,
        requestTimeoutMs: 1_000,
      });
      try {
        const missing = await nativeFetch(`${runtime.origin}/invocations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(identityAcceptanceInvocation),
        });
        expect(missing.status).toBe(401);
        expect(await missing.json()).toEqual({ error: "workload_identity_required" });
        const accepted = await nativeFetch(`${runtime.origin}/invocations`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            WorkloadAccessToken: IDENTITY_ACCEPTANCE_WORKLOAD_TOKEN,
          },
          body: JSON.stringify(identityAcceptanceInvocation),
        });
        expect(accepted.status).toBe(200);
        expect(value.gatewayMock.dispatches()).toBe(1);
      } finally {
        await runtime.close();
      }
    }));

    scenarios.push({ id: "live-account-acceptance", status: "NOT_RUN" });

    const report = serializeAgentCoreIdentityAcceptanceReport(scenarios);
    expect(report).not.toContain(IDENTITY_ACCEPTANCE_WORKLOAD_TOKEN);
    expect(report).not.toMatch(/Bearer\s/i);
    expect(JSON.parse(report)).toMatchObject({
      mode: "offline",
      provenance: "synthetic-local-fixture",
      awsCalls: 0,
      scenarios: expect.arrayContaining([
        { id: "immediate-per-token-revocation", status: "PASS" },
        { id: "live-account-acceptance", status: "NOT_RUN" },
      ]),
    });
    process.stdout.write(`AGENTCORE_IDENTITY_ACCEPTANCE ${report}`);
    expect(scenarios.filter(({ status }) => status === "FAIL")).toEqual([]);
  });

  it("is offline by default and rejects static token shortcuts", () => {
    expect(readAgentCoreIdentityAcceptancePreflight()).toEqual({
      mode: "offline",
      provenance: "synthetic-local-fixture",
      awsCalls: 0,
    });
    for (const name of [
      "AGENTCORE_WORKLOAD_ACCESS_TOKEN",
      "AGENTCORE_GATEWAY_BEARER_TOKEN",
      "AGENTCORE_RUNTIME_BEARER_TOKEN",
      "AGENTCORE_RUNTIME_INBOUND_JWT",
      "AGENTCORE_RUNTIME_ACCESS_TOKEN",
      "AGENTCORE_RUNTIME_JWT_TOKEN",
      "AGENTCORE_RUNTIME_OAUTH_TOKEN",
    ]) {
      expect(() => readAgentCoreIdentityAcceptancePreflight({
        env: { [name]: "forbidden-static-value" },
      })).toThrow(name);
    }
  });

  it("requires a live flag, exact marker, fresh UUID-bound approval, region, and complete identifiers", () => {
    expect(() => readAgentCoreIdentityAcceptancePreflight({
      args: ["--live"],
      env: {},
      now: () => IDENTITY_ACCEPTANCE_NOW,
    })).toThrow("MODE=live");
    expect(() => readAgentCoreIdentityAcceptancePreflight({
      args: ["--live"],
      env: { ...liveEnvironment, AGENTCORE_IDENTITY_LIVE_APPROVAL: "yes" },
      now: () => IDENTITY_ACCEPTANCE_NOW,
    })).toThrow("approval marker");
    expect(() => readAgentCoreIdentityAcceptancePreflight({
      args: ["--live"],
      env: { ...liveEnvironment, AGENTCORE_IDENTITY_ACCEPTANCE_RUN_ID: "not-a-uuid" },
      now: () => IDENTITY_ACCEPTANCE_NOW,
    })).toThrow("UUID v4");
    expect(() => readAgentCoreIdentityAcceptancePreflight({
      args: ["--live"],
      env: {
        ...liveEnvironment,
        AGENTCORE_IDENTITY_ACCEPTANCE_APPROVED_AT: "2026-10-25T11:49:59.999Z",
      },
      now: () => IDENTITY_ACCEPTANCE_NOW,
    })).toThrow("fresh canonical timestamp");
    expect(() => readAgentCoreIdentityAcceptancePreflight({
      args: ["--live"],
      env: { ...liveEnvironment, AGENTCORE_AWS_REGION: "us-east-1" },
      now: () => IDENTITY_ACCEPTANCE_NOW,
    })).toThrow("us-east-2");
    expect(() => readAgentCoreIdentityAcceptancePreflight({
      args: ["--live"],
      env: {
        ...liveEnvironment,
        AGENTCORE_RUNTIME_ARN:
          "arn:aws:bedrock-agentcore:us-east-2:123456789012:runtime/not-a-service-runtime-id",
      },
      now: () => IDENTITY_ACCEPTANCE_NOW,
    })).toThrow("AGENTCORE_RUNTIME_ARN");
    expect(() => readAgentCoreIdentityAcceptancePreflight({
      args: ["--live"],
      env: {
        ...liveEnvironment,
        AGENTCORE_RUNTIME_QUALIFIER: "invalid-qualifier",
      },
      now: () => IDENTITY_ACCEPTANCE_NOW,
    })).toThrow("AGENTCORE_RUNTIME_QUALIFIER");
    expect(() => readAgentCoreIdentityAcceptancePreflight({
      args: ["--live"],
      env: { ...liveEnvironment, AGENTCORE_GATEWAY_JWT_ALLOWED_SUBJECTS_JSON: undefined },
      now: () => IDENTITY_ACCEPTANCE_NOW,
    })).toThrow("AGENTCORE_GATEWAY_JWT_ALLOWED_SUBJECTS_JSON");

    expect(readAgentCoreIdentityAcceptancePreflight({
      args: ["--live"],
      env: liveEnvironment,
      now: () => IDENTITY_ACCEPTANCE_NOW,
    })).toMatchObject({
      mode: "live-preflight",
      region: "us-east-2",
      runtimeQualifier: "pilot_v1",
      runtimeAuthMode: "oauth_jwt",
      runtimeAudiences: ["pilot-agentcore-runtime"],
      runtimeAllowedSubjects: ["pilot-server"],
      runtimeAllowedClients: ["pilot-runtime-caller"],
      runtimeRequiredScopes: ["pilot.invoke_research"],
      audiences: [IDENTITY_ACCEPTANCE_AUDIENCE],
      allowedSubjects: [IDENTITY_ACCEPTANCE_SUBJECT],
      allowedClients: [IDENTITY_ACCEPTANCE_CLIENT],
      requiredScopes: [IDENTITY_ACCEPTANCE_SCOPE],
    });
  });
});
