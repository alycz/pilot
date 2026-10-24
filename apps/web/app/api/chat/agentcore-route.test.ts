import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { createChatHandler } from "./handler";

vi.mock("@/lib/model-access", () => ({
  getModelAccess: () => { throw new Error("Tests inject model access"); },
}));

const account = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

describe("chat AgentCore seam", () => {
  it("binds the optional provider to server scope and exposes only read research", async () => {
    const privateMarker = "PRIVATE_PERSONALIZATION_MUST_NOT_LEAVE_PILOT";
    const propose = vi.fn(async () => ({
      kind: "read_only" as const,
      summary: "Scoped AgentCore research",
      evidence: [],
      caveats: [],
    }));
    const providerForRequest = vi.fn(async () => ({
      enabled: true,
      trust: { transport: "agentcore-standin" as const, localStandin: true },
      propose,
    }));
    const model = new MockLanguageModelV2({
      doStream: [
        {
          stream: simulateReadableStream({ chunks: [
            {
              type: "tool-call",
              toolCallId: "agentcore-1",
              toolName: "agentcore_research",
              input: JSON.stringify({
                query: "Compare public XRP market context",
              }),
            } as const,
            { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as const,
          ] }),
        },
        {
          stream: simulateReadableStream({ chunks: [
            { type: "text-start", id: "answer-1" } as const,
            { type: "text-delta", id: "answer-1", delta: "Research complete." } as const,
            { type: "text-end", id: "answer-1" } as const,
            { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as const,
          ] }),
        },
      ],
    });
    const chat = createChatHandler({
      environment: {
        HARBOR_URL: "https://harbor.example",
        NEXT_PUBLIC_DEV_SIGNER: "0",
        PILOT_DEPLOYMENT_PROFILE: "hosted",
        PILOT_PUBLIC_ORIGIN: "https://pilot.example",
        PILOT_STRUCTURED_PREFERENCES: "1",
        PILOT_PERSONALIZATION_TENANT_ID: "private-tenant",
      },
      model,
      systemPrompt: `Ordinary private prompt: ${privateMarker}`,
      getModelAccess: async () => ({ apiKey: "test-key", model: "mock/model", mode: "user" }),
      harborRest: { op: vi.fn() },
      harborMcp: { tools: {}, close: vi.fn() },
      context: { main_account: account, budget_account: account, network: "testnet" },
      agentCoreProviderForRequest: providerForRequest,
    });
    const response = await chat(new Request("https://pilot.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://pilot.example" },
      body: JSON.stringify({
        operation: "agentcore_research",
        messages: [
          {
            id: "assistant-private-history",
            role: "assistant",
            parts: [{ type: "text", text: `Prior wallet context ${account} ${privateMarker}` }],
          },
          { id: "user-1", role: "user", parts: [{ type: "text", text: "Research XRP." }] },
        ],
      }),
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Research complete.");
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain(privateMarker);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain("private-tenant");
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain(account);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("Research XRP.");
    expect(providerForRequest).toHaveBeenCalledWith({
      scope: expect.objectContaining({
        tenantId: expect.stringMatching(/^wallet-[a-f0-9]{32}$/),
        owner: account,
        network: "testnet",
      }),
      signal: expect.any(AbortSignal),
    });
    expect(propose).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^agentcore-[0-9a-f-]{36}$/),
      purpose: "read",
      prompt: "Compare public XRP market context",
      context: {
        pair: "XRP/RLUSD",
        venue: "xrpl-testnet-dex",
        timeframe: "spot",
      },
    }, { signal: expect.any(AbortSignal) });
  });

  it("does not construct AgentCore for an ordinary chat run", async () => {
    const providerForRequest = vi.fn();
    const model = new MockLanguageModelV2({
      doStream: {
        stream: simulateReadableStream({ chunks: [
          { type: "text-start", id: "answer-normal" } as const,
          { type: "text-delta", id: "answer-normal", delta: "Ordinary chat." } as const,
          { type: "text-end", id: "answer-normal" } as const,
          { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as const,
        ] }),
      },
    });
    const chat = createChatHandler({
      environment: {
        HARBOR_URL: "https://harbor.example",
        NEXT_PUBLIC_DEV_SIGNER: "0",
        PILOT_DEPLOYMENT_PROFILE: "hosted",
        PILOT_PUBLIC_ORIGIN: "https://pilot.example",
      },
      model,
      getModelAccess: async () => ({ apiKey: "test-key", model: "mock/model", mode: "user" }),
      harborRest: { op: vi.fn() },
      harborMcp: { tools: {}, close: vi.fn() },
      context: { main_account: account, budget_account: account, network: "testnet" },
      agentCoreProviderForRequest: providerForRequest,
    });
    const response = await chat(new Request("https://pilot.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://pilot.example" },
      body: JSON.stringify({
        messages: [{ id: "user-ordinary", role: "user", parts: [{ type: "text", text: "Hello." }] }],
      }),
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Ordinary chat.");
    expect(providerForRequest).not.toHaveBeenCalled();
  });

  it("rejects a wallet address in the current public-research query", async () => {
    const doStream = vi.fn();
    const providerForRequest = vi.fn();
    const chat = createChatHandler({
      environment: {
        HARBOR_URL: "https://harbor.example",
        NEXT_PUBLIC_DEV_SIGNER: "0",
        PILOT_DEPLOYMENT_PROFILE: "hosted",
        PILOT_PUBLIC_ORIGIN: "https://pilot.example",
      },
      model: new MockLanguageModelV2({ doStream }),
      getModelAccess: async () => ({ apiKey: "test-key", model: "mock/model", mode: "user" }),
      harborRest: { op: vi.fn() },
      harborMcp: { tools: {}, close: vi.fn() },
      context: { main_account: account, budget_account: account, network: "testnet" },
      agentCoreProviderForRequest: providerForRequest,
    });
    const response = await chat(new Request("https://pilot.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://pilot.example" },
      body: JSON.stringify({
        operation: "agentcore_research",
        messages: [{
          id: "user-private-query",
          role: "user",
          parts: [{ type: "text", text: `Research activity for ${account}.` }],
        }],
      }),
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("cannot include wallet addresses");
    expect(providerForRequest).not.toHaveBeenCalled();
    expect(doStream).not.toHaveBeenCalled();
  });

  it("fails closed before model streaming when dedicated AgentCore mode is disabled", async () => {
    const doStream = vi.fn();
    const model = new MockLanguageModelV2({ doStream });
    const chat = createChatHandler({
      environment: {
        HARBOR_URL: "https://harbor.example",
        NEXT_PUBLIC_DEV_SIGNER: "0",
        PILOT_DEPLOYMENT_PROFILE: "hosted",
        PILOT_PUBLIC_ORIGIN: "https://pilot.example",
      },
      model,
      getModelAccess: async () => ({ apiKey: "test-key", model: "mock/model", mode: "user" }),
      harborRest: { op: vi.fn() },
      harborMcp: { tools: {}, close: vi.fn() },
      context: { main_account: account, budget_account: account, network: "testnet" },
      agentCoreProviderForRequest: async () => ({
        enabled: false,
        trust: { transport: "disabled", localStandin: false },
        async propose() { throw new Error("disabled"); },
      }),
    });
    const response = await chat(new Request("https://pilot.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://pilot.example" },
      body: JSON.stringify({
        operation: "agentcore_research",
        messages: [{ id: "user-disabled", role: "user", parts: [{ type: "text", text: "Research." }] }],
      }),
    }));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("AgentCore research is not configured");
    expect(doStream).not.toHaveBeenCalled();
  });

  it("rejects AgentCore research for a mainnet wallet before provider or model use", async () => {
    const doStream = vi.fn();
    const providerForRequest = vi.fn();
    const chat = createChatHandler({
      environment: {
        HARBOR_URL: "https://harbor.example",
        NEXT_PUBLIC_DEV_SIGNER: "0",
        PILOT_DEPLOYMENT_PROFILE: "hosted",
        PILOT_PUBLIC_ORIGIN: "https://pilot.example",
      },
      model: new MockLanguageModelV2({ doStream }),
      getModelAccess: async () => ({ apiKey: "test-key", model: "mock/model", mode: "user" }),
      harborRest: { op: vi.fn() },
      harborMcp: { tools: {}, close: vi.fn() },
      context: { main_account: account, budget_account: account, network: "mainnet" },
      agentCoreProviderForRequest: providerForRequest,
    });
    const response = await chat(new Request("https://pilot.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://pilot.example" },
      body: JSON.stringify({
        operation: "agentcore_research",
        messages: [{ id: "user-mainnet", role: "user", parts: [{ type: "text", text: "Research." }] }],
      }),
    }));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("unavailable for mainnet");
    expect(providerForRequest).not.toHaveBeenCalled();
    expect(doStream).not.toHaveBeenCalled();
  });

  it("keeps AgentCore research behind the shared same-origin authority gate", async () => {
    const doStream = vi.fn();
    const loadContext = vi.fn();
    const providerForRequest = vi.fn();
    const chat = createChatHandler({
      environment: {
        HARBOR_URL: "https://harbor.example",
        NEXT_PUBLIC_DEV_SIGNER: "0",
        PILOT_DEPLOYMENT_PROFILE: "hosted",
        PILOT_PUBLIC_ORIGIN: "https://pilot.example",
      },
      model: new MockLanguageModelV2({ doStream }),
      getModelAccess: async () => ({ apiKey: "test-key", model: "mock/model", mode: "user" }),
      harborRest: { op: vi.fn() },
      harborMcp: { tools: {}, close: vi.fn() },
      loadContext,
      agentCoreProviderForRequest: providerForRequest,
    });
    const response = await chat(new Request("https://pilot.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({
        operation: "agentcore_research",
        messages: [{ id: "user-cross-origin", role: "user", parts: [{ type: "text", text: "Research." }] }],
      }),
    }));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("unavailable for this request authority");
    expect(loadContext).not.toHaveBeenCalled();
    expect(providerForRequest).not.toHaveBeenCalled();
    expect(doStream).not.toHaveBeenCalled();
  });
});
