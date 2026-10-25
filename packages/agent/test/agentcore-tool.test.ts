import { describe, expect, it, vi } from "vitest";

import { createAgentTools } from "../src/tools";

const base = {
  account: {
    main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
    budget_account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  },
  network: "testnet" as const,
  harborRest: { async op() { return { ok: true, data: {} } as never; } },
  harborMcp: { tools: {}, async close() {} },
};

describe("AgentCore research tool", () => {
  it("is absent while disabled", () => {
    const tools = createAgentTools({
      ...base,
      agentCore: { enabled: false, async propose() { throw new Error("disabled"); } },
    }) as Record<string, unknown>;
    expect(tools.agentcore_research).toBeUndefined();
  });

  it("forwards only a bounded read proposal", async () => {
    const propose = vi.fn(async () => ({
      kind: "read_only" as const,
      summary: "Scoped result",
      evidence: [],
      caveats: [],
    }));
    const tools = createAgentTools({ ...base, agentCore: { enabled: true, propose } }) as Record<string, any>;
    const response = await tools.agentcore_research.execute({
      query: "Compare market context",
    });
    expect(response).toMatchObject({ kind: "read_only", summary: "Scoped result" });
    expect(propose).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^agentcore-[0-9a-f-]{36}$/),
      purpose: "read",
      prompt: "Compare market context",
      context: {
        pair: "XRP/RLUSD",
        venue: "xrpl-testnet-dex",
        timeframe: "spot",
      },
    }, { signal: undefined });

    expect(() => tools.agentcore_research.inputSchema.parse({
      query: "Try another pair",
      context: { pair: "XRP/USD" },
    })).toThrow();

    expect(tools.propose_intent).toBeUndefined();
    expect(tools.x402_compare).toBeUndefined();
    expect(tools.memory_read).toBeUndefined();
  });
});
