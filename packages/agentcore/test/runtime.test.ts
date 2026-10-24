import { InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { describe, expect, it, vi } from "vitest";

import { deriveAgentCoreScopeDigest } from "../src/contracts";
import { createAgentCoreProposalProvider } from "../src/runtime";

const scope = {
  tenantId: "tenant-1",
  owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  network: "testnet" as const,
  invocationNonce: "nonce-123456789",
};
const gatewayToolName = "PilotReadTarget___pilot.read_market_context";

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
    expect(provider.trust).toEqual({ transport: "aws-agentcore-runtime", localStandin: false });
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
});
