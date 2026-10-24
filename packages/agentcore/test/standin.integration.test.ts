import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentCoreProposalProvider } from "../src/runtime";
import { startAgentCoreStandin } from "../src/standin";

const close: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(close.splice(0).map((entry) => entry())));

describe("AgentCore local stand-in", () => {
  it("runs Runtime to MCP Gateway to one injected read-only tool", async () => {
    const invoke = vi.fn(async (input) => ({
      summary: `Synthetic market fixture for ${input.scope.network}`,
      evidence: [{ source: "local-fixture", claim: "No live market data was queried." }],
      caveats: [],
    }));
    const standin = await startAgentCoreStandin({ tools: { invoke } });
    close.push(standin.close);
    const provider = createAgentCoreProposalProvider({
      config: {
        mode: "standin",
        endpoint: standin.origin,
        gatewayToolName: "PilotStandin___pilot_read_market_context",
        timeoutMs: 2_000,
        maxRequestBytes: 65_536,
        maxResponseBytes: 262_144,
      },
      scope: {
        tenantId: "tenant-1",
        owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        network: "testnet",
        invocationNonce: "nonce-123456789",
      },
    });
    const response = await provider.propose({
      requestId: "standin-1",
      purpose: "read",
      prompt: "Read public market context",
      context: { pair: "XRP/USD" },
    });
    expect(response).toMatchObject({
      kind: "read_only",
      evidence: [{ source: "local-fixture" }],
      caveats: [expect.stringContaining("no AWS Runtime or Gateway")],
    });
    expect(provider.trust).toEqual({ transport: "agentcore-standin", localStandin: true });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      name: "PilotStandin___pilot_read_market_context",
      requestId: "standin-1",
      scope: { tenantId: "tenant-1", network: "testnet" },
    });
  });
});
