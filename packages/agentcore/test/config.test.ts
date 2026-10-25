import { describe, expect, it } from "vitest";

import { readAgentCoreConfig } from "../src/config";

describe("readAgentCoreConfig", () => {
  it("is disabled by default", () => {
    expect(readAgentCoreConfig({})).toEqual({
      mode: "off",
      timeoutMs: 30_000,
      maxRequestBytes: 65_536,
      maxResponseBytes: 262_144,
    });
  });

  it("accepts only an explicit loopback stand-in", () => {
    expect(readAgentCoreConfig({
      AGENTCORE_MODE: "standin",
      AGENTCORE_STANDIN_URL: "http://127.0.0.1:32147",
    })).toMatchObject({
      mode: "standin",
      endpoint: "http://127.0.0.1:32147",
      gatewayToolName: "PilotStandin___pilot_read_market_context",
    });
    expect(() => readAgentCoreConfig({
      AGENTCORE_MODE: "standin",
      AGENTCORE_STANDIN_URL: "https://example.com",
    })).toThrow("loopback");
  });

  it("requires an exact Runtime ARN and Gateway endpoint in aws mode", () => {
    expect(readAgentCoreConfig({
      AGENTCORE_MODE: "aws",
      AWS_REGION: "us-west-2",
      AGENTCORE_AWS_REGION: "us-east-2",
      AGENTCORE_RUNTIME_ARN: "arn:aws:bedrock-agentcore:us-east-2:123456789012:runtime/pilot_research-AbCdEf1234",
      AGENTCORE_RUNTIME_QUALIFIER: "pilot_v1",
      AGENTCORE_RUNTIME_AUTH_MODE: "iam",
      AGENTCORE_GATEWAY_URL: "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp",
      AGENTCORE_GATEWAY_TOOL_NAME: "PilotReadTarget___pilot.read_market_context",
      AGENTCORE_GATEWAY_AUTH_MODE: "custom_jwt",
    })).toMatchObject({
      mode: "aws",
      region: "us-east-2",
      qualifier: "pilot_v1",
      runtimeAuthMode: "iam",
      gatewayAuthMode: "custom_jwt",
      gatewayProtocolVersion: "2025-11-25",
    });
    expect(() => readAgentCoreConfig({ AGENTCORE_MODE: "aws" })).toThrow("AGENTCORE_RUNTIME_ARN");
    expect(() => readAgentCoreConfig({
      AGENTCORE_MODE: "aws",
      AGENTCORE_AWS_REGION: "us-east-2",
      AGENTCORE_RUNTIME_ARN: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/pilot_research-AbCdEf1234",
      AGENTCORE_GATEWAY_URL: "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp",
    })).toThrow("us-east-2 Runtime ARN");
  });

  it("accepts an explicit us-east-2 OAuth JWT policy without accepting a token", () => {
    const parsed = readAgentCoreConfig({
      AGENTCORE_MODE: "aws",
      AGENTCORE_AWS_REGION: "us-east-2",
      AGENTCORE_RUNTIME_ARN: "arn:aws:bedrock-agentcore:us-east-2:123456789012:runtime/pilot_research-AbCdEf1234",
      AGENTCORE_RUNTIME_QUALIFIER: "pilot_v1",
      AGENTCORE_RUNTIME_AUTH_MODE: "oauth_jwt",
      AGENTCORE_RUNTIME_JWT_ISSUER: "https://identity.example.test/",
      AGENTCORE_RUNTIME_JWT_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
      AGENTCORE_RUNTIME_JWT_AUDIENCES_JSON: '["pilot-agentcore-runtime"]',
      AGENTCORE_RUNTIME_JWT_ALLOWED_SUBJECTS_JSON: '["pilot-server"]',
      AGENTCORE_RUNTIME_JWT_ALLOWED_CLIENTS_JSON: '["pilot-client"]',
      AGENTCORE_RUNTIME_JWT_REQUIRED_SCOPES_JSON: '["runtime:invoke"]',
      AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM: "client_id",
      AGENTCORE_RUNTIME_JWT_TENANT_CLAIM: "tenant_id",
      AGENTCORE_RUNTIME_JWT_TENANT_ID: "pilot-runtime",
      AGENTCORE_RUNTIME_JWT_ALGORITHMS_JSON: '["RS256"]',
      AGENTCORE_RUNTIME_JWT_CLOCK_TOLERANCE_SECONDS: "30",
      AGENTCORE_RUNTIME_JWT_MAX_TOKEN_AGE_SECONDS: "300",
      AGENTCORE_RUNTIME_JWT_MAX_TOKEN_LIFETIME_SECONDS: "600",
      AGENTCORE_RUNTIME_JWT_JWKS_CACHE_TTL_MS: "300000",
      AGENTCORE_RUNTIME_JWT_JWKS_REFRESH_COOLDOWN_MS: "10000",
      AGENTCORE_RUNTIME_JWT_REVOCATION_MODE: "expiry_only",
      AGENTCORE_GATEWAY_URL: "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp",
      AGENTCORE_GATEWAY_TOOL_NAME: "PilotReadTarget___pilot.read_market_context",
      AGENTCORE_GATEWAY_AUTH_MODE: "custom_jwt",
    });
    expect(parsed).toMatchObject({
      mode: "aws",
      region: "us-east-2",
      runtimeAuthMode: "oauth_jwt",
      runtimeJwtTenantId: "pilot-runtime",
      runtimeJwtPolicy: {
        issuer: "https://identity.example.test/",
        audiences: ["pilot-agentcore-runtime"],
        allowedSubjects: ["pilot-server"],
        allowedClients: ["pilot-client"],
        requiredScopes: ["runtime:invoke"],
        clockToleranceSeconds: 30,
        maxTokenAgeSeconds: 300,
        maxTokenLifetimeSeconds: 600,
        cacheTtlMs: 300_000,
        jwksRefreshCooldownMs: 10_000,
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("Bearer");
  });

  it("rejects incomplete OAuth JWT policy, implicit IAM, and static token shortcuts", () => {
    const base = {
      AGENTCORE_MODE: "aws",
      AGENTCORE_AWS_REGION: "us-east-2",
      AGENTCORE_RUNTIME_ARN: "arn:aws:bedrock-agentcore:us-east-2:123456789012:runtime/pilot_research-AbCdEf1234",
      AGENTCORE_RUNTIME_AUTH_MODE: "oauth_jwt",
      AGENTCORE_GATEWAY_URL: "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp",
      AGENTCORE_GATEWAY_TOOL_NAME: "PilotReadTarget___pilot.read_market_context",
    };
    expect(() => readAgentCoreConfig(base)).toThrow("AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM");
    expect(() => readAgentCoreConfig({
      AGENTCORE_MODE: "aws",
      AGENTCORE_AWS_REGION: "us-east-2",
      AGENTCORE_RUNTIME_ARN: base.AGENTCORE_RUNTIME_ARN,
    })).toThrow("explicitly be iam or oauth_jwt");
    for (const name of [
      "AGENTCORE_RUNTIME_ACCESS_TOKEN",
      "AGENTCORE_RUNTIME_BEARER_TOKEN",
      "AGENTCORE_RUNTIME_INBOUND_JWT",
      "AGENTCORE_RUNTIME_JWT_TOKEN",
      "AGENTCORE_RUNTIME_OAUTH_TOKEN",
      "AGENTCORE_WORKLOAD_ACCESS_TOKEN",
    ]) {
      expect(() => readAgentCoreConfig({ [name]: "must-not-be-used" })).toThrow("Static AgentCore Runtime token");
    }
  });

  it("requires singleton Runtime identity claims and an explicit revocation mode", () => {
    const base = {
      AGENTCORE_MODE: "aws",
      AGENTCORE_AWS_REGION: "us-east-1",
      AGENTCORE_RUNTIME_ARN: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/pilot_research-AbCdEf1234",
      AGENTCORE_RUNTIME_AUTH_MODE: "oauth_jwt",
      AGENTCORE_RUNTIME_JWT_ISSUER: "https://identity.example.test/",
      AGENTCORE_RUNTIME_JWT_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
      AGENTCORE_RUNTIME_JWT_AUDIENCES_JSON: '["pilot-agentcore-runtime"]',
      AGENTCORE_RUNTIME_JWT_ALLOWED_SUBJECTS_JSON: '["pilot-server"]',
      AGENTCORE_RUNTIME_JWT_ALLOWED_CLIENTS_JSON: '["pilot-client"]',
      AGENTCORE_RUNTIME_JWT_REQUIRED_SCOPES_JSON: '["runtime:invoke"]',
      AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM: "client_id",
      AGENTCORE_RUNTIME_JWT_TENANT_CLAIM: "tenant_id",
      AGENTCORE_RUNTIME_JWT_TENANT_ID: "pilot-runtime",
      AGENTCORE_RUNTIME_JWT_ALGORITHMS_JSON: '["RS256"]',
      AGENTCORE_RUNTIME_JWT_CLOCK_TOLERANCE_SECONDS: "30",
      AGENTCORE_RUNTIME_JWT_MAX_TOKEN_AGE_SECONDS: "300",
      AGENTCORE_RUNTIME_JWT_MAX_TOKEN_LIFETIME_SECONDS: "600",
      AGENTCORE_RUNTIME_JWT_JWKS_CACHE_TTL_MS: "300000",
      AGENTCORE_RUNTIME_JWT_JWKS_REFRESH_COOLDOWN_MS: "10000",
      AGENTCORE_RUNTIME_JWT_REVOCATION_MODE: "expiry_only",
      AGENTCORE_GATEWAY_URL: "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
      AGENTCORE_GATEWAY_TOOL_NAME: "PilotReadTarget___pilot.read_market_context",
    };
    expect(readAgentCoreConfig(base)).toMatchObject({
      region: "us-east-1",
      runtimeAuthMode: "oauth_jwt",
      runtimeJwtPolicy: { revocation: { mode: "expiry_only" } },
    });
    expect(() => readAgentCoreConfig({
      ...base,
      AGENTCORE_RUNTIME_JWT_ALLOWED_SUBJECTS_JSON: '["pilot-server","backup-server"]',
    })).toThrow("AGENTCORE_RUNTIME_JWT_ALLOWED_SUBJECTS_JSON");
    expect(() => readAgentCoreConfig({
      ...base,
      AGENTCORE_RUNTIME_JWT_AUDIENCES_JSON: '["runtime-a","runtime-b"]',
    })).toThrow("AGENTCORE_RUNTIME_JWT_AUDIENCES_JSON");
    expect(() => readAgentCoreConfig({
      ...base,
      AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM: "azp",
    })).toThrow("must be client_id");
    expect(() => readAgentCoreConfig({
      ...base,
      AGENTCORE_RUNTIME_JWT_REVOCATION_MODE: "checker",
    })).toThrow("AGENTCORE_RUNTIME_JWT_REVOCATION_TIMEOUT_MS");
  });

  it("never projects ambient credentials", () => {
    const serialized = JSON.stringify(readAgentCoreConfig({
      AWS_ACCESS_KEY_ID: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
    }));
    expect(serialized).not.toContain("must-not-leak");
  });
});
