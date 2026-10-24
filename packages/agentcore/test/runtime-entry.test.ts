import { describe, expect, it } from "vitest";

import {
  readAgentCoreRuntimeEnvironment,
  runAgentCoreRuntimeMain,
  startAgentCoreRuntimeFromEnvironment,
} from "../src/runtime-entry";
import { createInMemoryAgentCoreReplayStore } from "../src/replay";

const environment = Object.freeze({
  AGENTCORE_RUNTIME_SERVER_MODE: "aws",
  AWS_REGION: "us-east-1",
  AGENTCORE_GATEWAY_URL:
    "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
  AGENTCORE_GATEWAY_TOOL_NAME: "PilotReadTarget___pilot.read_market_context",
  AGENTCORE_IDENTITY_CREDENTIAL_PROVIDER_NAME: "pilot-gateway-jwt",
  AGENTCORE_GATEWAY_JWT_ISSUER: "https://identity.example.test/",
  AGENTCORE_GATEWAY_JWT_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
  AGENTCORE_GATEWAY_JWT_AUDIENCES_JSON: '["pilot-agentcore-gateway"]',
  AGENTCORE_GATEWAY_JWT_ALLOWED_SUBJECTS_JSON: '["pilot-runtime"]',
  AGENTCORE_GATEWAY_JWT_ALLOWED_CLIENTS_JSON: '["pilot-client"]',
  AGENTCORE_GATEWAY_JWT_REQUIRED_SCOPES_JSON: '["gateway:invoke"]',
  AGENTCORE_GATEWAY_JWT_CLIENT_CLAIM: "client_id",
  AGENTCORE_GATEWAY_JWT_TENANT_CLAIM: "tenant_id",
  AGENTCORE_GATEWAY_JWT_DEPLOYMENT_TENANT_ID: "pilot-runtime-deployment",
  AGENTCORE_GATEWAY_JWT_ALGORITHMS_JSON: '["RS256"]',
  AGENTCORE_REPLAY_TABLE: "pilot-agentcore-replay",
  AGENTCORE_REPLAY_DEPLOYMENT_ID: "pilot-runtime-v1",
});

describe("AgentCore Runtime executable configuration", () => {
  it("is default-off and requires a complete explicit AWS configuration", () => {
    expect(() => readAgentCoreRuntimeEnvironment({})).toThrow(
      "AGENTCORE_RUNTIME_SERVER_MODE must be aws",
    );
    expect(() => readAgentCoreRuntimeEnvironment({
      ...environment,
      AGENTCORE_GATEWAY_JWT_ALLOWED_CLIENTS_JSON: undefined,
    })).toThrow("AGENTCORE_GATEWAY_JWT_ALLOWED_CLIENTS_JSON");
  });

  it("parses exact allowlists and keeps the deployment tenant separate", () => {
    const parsed = readAgentCoreRuntimeEnvironment(environment);
    expect(parsed).toMatchObject({
      region: "us-east-1",
      resourceCredentialProviderName: "pilot-gateway-jwt",
      replayTableName: "pilot-agentcore-replay",
      config: {
        gatewayToolName: "PilotReadTarget___pilot.read_market_context",
        jwtDeploymentTenantId: "pilot-runtime-deployment",
        replayDeploymentId: "pilot-runtime-v1",
        replayLeaseMs: 30_000,
        replayRetentionMs: 86_400_000,
        maxConcurrentRequests: 1,
        jwtPolicy: {
          audiences: ["pilot-agentcore-gateway"],
          requiredScopes: ["gateway:invoke"],
          tenantClaim: "tenant_id",
        },
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("WORKLOAD_ACCESS_TOKEN");
  });

  it.each([
    ["wrong region", { AWS_REGION: "us-west-2" }],
    ["non-AWS Gateway", { AGENTCORE_GATEWAY_URL: "https://example.test/mcp" }],
    ["duplicate audience", { AGENTCORE_GATEWAY_JWT_AUDIENCES_JSON: '["same","same"]' }],
    ["unsupported algorithm", { AGENTCORE_GATEWAY_JWT_ALGORITHMS_JSON: '["HS256"]' }],
    ["unbounded concurrency", { AGENTCORE_RUNTIME_MAX_CONCURRENT_REQUESTS: "33" }],
    ["static token fallback", { AGENTCORE_WORKLOAD_ACCESS_TOKEN: "must-not-be-used" }],
    ["invalid replay table", { AGENTCORE_REPLAY_TABLE: "x" }],
    ["invalid replay deployment", { AGENTCORE_REPLAY_DEPLOYMENT_ID: "x" }],
    ["retention shorter than lease", {
      AGENTCORE_REPLAY_LEASE_MS: "120000",
      AGENTCORE_REPLAY_RETENTION_MS: "60000",
    }],
  ])("rejects %s", (_label, changed) => {
    expect(() => readAgentCoreRuntimeEnvironment({ ...environment, ...changed })).toThrow();
  });

  it("starts on an injected ephemeral loopback port without contacting AWS", async () => {
    const runtime = await startAgentCoreRuntimeFromEnvironment({
      env: environment,
      replayStore: createInMemoryAgentCoreReplayStore(),
      listen: { host: "127.0.0.1", port: 0 },
      workloadJwtResolver: {
        async resolveAuthorization() {
          throw new Error("not invoked by health checks");
        },
      },
    });
    try {
      const response = await fetch(`${runtime.origin}/ping`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "Healthy" });
    } finally {
      await runtime.close();
    }
  });

  it("refuses to bind the executable entrypoint without a durable replay adapter", async () => {
    await expect(runAgentCoreRuntimeMain()).rejects.toThrow(
      "A durable AgentCore replay adapter is required",
    );
  });
});
