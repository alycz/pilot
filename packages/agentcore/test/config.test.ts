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
      AWS_REGION: "us-east-1",
      AGENTCORE_RUNTIME_ARN: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/pilot_research-AbCdEf1234",
      AGENTCORE_RUNTIME_QUALIFIER: "pilot_v1",
      AGENTCORE_RUNTIME_AUTH_MODE: "iam",
      AGENTCORE_GATEWAY_URL: "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
      AGENTCORE_GATEWAY_TOOL_NAME: "PilotReadTarget___pilot.read_market_context",
      AGENTCORE_GATEWAY_AUTH_MODE: "custom_jwt",
    })).toMatchObject({
      mode: "aws",
      region: "us-east-1",
      qualifier: "pilot_v1",
      runtimeAuthMode: "iam",
      gatewayAuthMode: "custom_jwt",
      gatewayProtocolVersion: "2025-11-25",
    });
    expect(() => readAgentCoreConfig({ AGENTCORE_MODE: "aws" })).toThrow("AGENTCORE_RUNTIME_ARN");
  });

  it("never projects ambient credentials", () => {
    const serialized = JSON.stringify(readAgentCoreConfig({
      AWS_ACCESS_KEY_ID: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
    }));
    expect(serialized).not.toContain("must-not-leak");
  });
});
