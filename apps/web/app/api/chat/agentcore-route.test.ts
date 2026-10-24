import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { createChatHandler } from "./handler";

vi.mock("@/lib/model-access", () => ({
  getModelAccess: () => { throw new Error("Tests inject model access"); },
}));

const account = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

describe("chat AgentCore seam", () => {
  it("binds the optional provider to server scope and exposes only read research", async () => {
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
                context: { pair: "XRP/USD" },
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
        operation: "agentcore_research",
        messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Research XRP." }] }],
      }),
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Research complete.");
    expect(providerForRequest).toHaveBeenCalledWith({
      scope: expect.objectContaining({ owner: account, network: "testnet" }),
      signal: expect.any(AbortSignal),
    });
    expect(propose).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^agentcore-[0-9a-f-]{36}$/),
      purpose: "read",
      prompt: "Compare public XRP market context",
      context: { pair: "XRP/USD" },
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
});
