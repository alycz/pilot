import { describe, expect, it, vi } from "vitest";

import {
  AgentCoreLambdaTargetError,
  createAgentCoreLambdaTargetHandler,
} from "../src/lambda-target";

const event = {
  requestId: "request-123",
  scopeDigest: "a".repeat(64),
  context: {},
};

const custom = {
  bedrockAgentCoreMessageVersion: "1.0",
  bedrockAgentCoreAwsRequestId: "aws-request-123",
  bedrockAgentCoreMcpMessageId: "mcp-message-123",
  bedrockAgentCoreGatewayId: "PilotResearchGateway-AbCdEf1234",
  bedrockAgentCoreTargetId: "PilotReadTarget-ZyXwVu9876",
  bedrockAgentCoreToolName: "PilotReadTarget___pilot.read_market_context",
};

function context(overrides: Readonly<Record<string, unknown>> = {}) {
  return { clientContext: { custom: { ...custom, ...overrides } } };
}

function handler(
  read: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>,
  limits: Readonly<{ timeoutMs?: number; maxEventBytes?: number; maxResponseBytes?: number }> = {},
) {
  return createAgentCoreLambdaTargetHandler({
    gatewayId: custom.bedrockAgentCoreGatewayId,
    targetId: custom.bedrockAgentCoreTargetId,
    targetName: "PilotReadTarget",
    source: { read },
    ...limits,
  });
}

describe("AgentCore Gateway Lambda target", () => {
  it("passes only bounded public selectors to one injected read source", async () => {
    const read = vi.fn(async (_input: unknown, _options: { signal: AbortSignal }) => ({
      summary: "Bounded public fixture",
      evidence: [{
        source: "local-fixture",
        claim: "No external service was called.",
        freshness: "2026-10-24T12:00:00.000Z",
      }],
      caveats: ["Local unit fixture only."],
    }));

    await expect(handler(read)(event, context())).resolves.toEqual({
      summary: "Bounded public fixture",
      evidence: [{
        source: "local-fixture",
        claim: "No external service was called.",
        freshness: "2026-10-24T12:00:00.000Z",
      }],
      caveats: ["Local unit fixture only."],
    });
    expect(read).toHaveBeenCalledOnce();
    const [sourceInput, sourceOptions] = read.mock.calls[0]!;
    expect(sourceInput).toEqual({
      requestId: "request-123",
      scopeDigest: "a".repeat(64),
    });
    expect(sourceInput).not.toHaveProperty("owner");
    expect(sourceInput).not.toHaveProperty("tenantId");
    expect(sourceInput).not.toHaveProperty("network");
    expect(sourceInput).not.toHaveProperty("personalization");
    expect(sourceInput).not.toHaveProperty("token");
    expect(sourceInput).not.toHaveProperty("key");
    expect(sourceInput).not.toHaveProperty("prompt");
    expect(sourceOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["unknown tool", { bedrockAgentCoreToolName: "PilotReadTarget___unknown" }],
    ["wrong gateway", { bedrockAgentCoreGatewayId: "OtherGateway-AbCdEf1234" }],
    ["wrong target", { bedrockAgentCoreTargetId: "OtherTarget-ZyXwVu9876" }],
    ["wrong message version", { bedrockAgentCoreMessageVersion: "2.0" }],
    ["unknown context", { unexpected: "field" }],
  ])("rejects %s before the source", async (_name, overrides) => {
    const read = vi.fn();
    await expect(handler(read)(event, context(overrides)))
      .rejects.toMatchObject({ code: "invalid_context" });
    expect(read).not.toHaveBeenCalled();
  });

  it("strictly rejects malformed, extra, sensitive, and oversized events", async () => {
    const read = vi.fn();
    const invoke = handler(read, { maxEventBytes: 1_024 });
    await expect(invoke({ ...event, extra: true }, context()))
      .rejects.toMatchObject({ code: "invalid_event" });
    await expect(invoke({ ...event, prompt: "must-not-enter" }, context()))
      .rejects.toMatchObject({ code: "invalid_event" });
    await expect(invoke({ ...event, padding: "x".repeat(2_000) }, context()))
      .rejects.toMatchObject({ code: "invalid_event" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy wallet scope", {
      ...event,
      scope: {
        tenantId: "tenant-1",
        owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        network: "testnet",
        invocationNonce: "nonce-1",
      },
    }],
    ["owner", { ...event, owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59" }],
    ["tenant", { ...event, tenantId: "tenant-1" }],
    ["network", { ...event, network: "testnet" }],
    ["personalization", { ...event, personalization: { strategy: "private" } }],
    ["prompt", { ...event, prompt: "private chat history" }],
    ["token", { ...event, token: "opaque-but-forbidden" }],
    ["key", { ...event, key: "opaque-but-forbidden" }],
  ])("rejects the external %s field before the source", async (_name, candidate) => {
    const read = vi.fn();
    await expect(handler(read)(candidate, context()))
      .rejects.toMatchObject({ code: "invalid_event" });
    expect(read).not.toHaveBeenCalled();
  });

  it("bounds source latency even when the adapter ignores cancellation", async () => {
    const invoke = handler(async () => new Promise<never>(() => undefined), { timeoutMs: 100 });
    await expect(invoke(event, context())).rejects.toMatchObject({ code: "source_timeout" });
  });

  it("redacts source failures and rejects private or oversized output", async () => {
    const failed = handler(async () => { throw new Error("Bearer must-not-leak"); });
    const error = await failed(event, context()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AgentCoreLambdaTargetError);
    expect(String(error)).toBe("AgentCoreLambdaTargetError: AgentCore Lambda target source failed");
    expect(String(error)).not.toContain("must-not-leak");

    await expect(handler(async () => ({
      summary: "client_secret=must-not-leak",
      evidence: [],
      caveats: [],
    }))(event, context())).rejects.toMatchObject({ code: "invalid_response" });

    await expect(handler(async () => ({
      summary: "x".repeat(2_000),
      evidence: [],
      caveats: [],
    }), { maxResponseBytes: 1_024 })(event, context()))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("fails configuration closed before creating a handler", () => {
    expect(() => createAgentCoreLambdaTargetHandler({
      gatewayId: "bad id",
      targetId: custom.bedrockAgentCoreTargetId,
      targetName: "PilotReadTarget",
      source: { async read() { return {}; } },
    })).toThrow(AgentCoreLambdaTargetError);
  });
});
