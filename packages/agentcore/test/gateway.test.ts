import { describe, expect, it, vi } from "vitest";

import { createAgentCoreGatewayClient } from "../src/gateway";

const scope = {
  tenantId: "tenant-1",
  owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  network: "testnet" as const,
  invocationNonce: "nonce-123456789",
};
const gatewayToolName = "PilotReadTarget___pilot.read_market_context";
const market = { summary: "Market fixture", evidence: [], caveats: [] };

describe("AgentCore Gateway MCP client", () => {
  it("sends the pinned protocol and one exact read-only tool", async () => {
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body));
      expect(call).toMatchObject({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: gatewayToolName },
      });
      expect(new Headers(init?.headers).get("mcp-protocol-version")).toBe("2025-11-25");
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: call.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(market) }],
          structuredContent: market,
          isError: false,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
      gatewayToolName,
      scope,
      auth: { async authorization() { return "Bearer opaque-test-token"; } },
      fetch: transport as typeof fetch,
    });
    await expect(client.callReadTool({
      requestId: "research-1",
      prompt: "Compare public market context",
      context: {},
    })).resolves.toEqual(market);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("fails closed on bad auth, host, or mismatched JSON-RPC identity", async () => {
    expect(() => createAgentCoreGatewayClient({
      gatewayUrl: "https://example.com/mcp",
      gatewayToolName,
      scope,
      auth: { async authorization() { return "Bearer no"; } },
    })).toThrow("Invalid AgentCore Gateway endpoint");

    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scope,
      auth: { async authorization() { return "secret"; } },
      fetch: vi.fn() as typeof fetch,
    });
    await expect(client.callReadTool({
      requestId: "research-1",
      prompt: "Read only",
      context: {},
    })).rejects.toThrow("authorization is unavailable");
  });

  it("accepts one bounded MCP SSE result and rejects a mismatched response id", async () => {
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body));
      return new Response(
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(market) }],
            structuredContent: market,
            isError: false,
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scope,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: transport as typeof fetch,
    });
    await expect(client.callReadTool({
      requestId: "research-2",
      prompt: "Read only",
      context: {},
    })).resolves.toEqual(market);

    const mismatched = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scope,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: async () => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "wrong",
        result: { content: [{ type: "text", text: "{}" }], structuredContent: market, isError: false },
      }), { headers: { "content-type": "application/json" } }),
    });
    await expect(mismatched.callReadTool({
      requestId: "research-3",
      prompt: "Read only",
      context: {},
    })).rejects.toThrow("invalid scoped result");
  });

  it("cancels an oversized streaming response", async () => {
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scope,
      auth: { async authorization() { return "Bearer standin"; } },
      maxResponseBytes: 100,
      fetch: async () => new Response("x".repeat(101), {
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(client.callReadTool({
      requestId: "research-4",
      prompt: "Read only",
      context: {},
    })).rejects.toThrow("byte limit");
  });

  it("bounds and redacts authorization resolution", async () => {
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scope,
      timeoutMs: 10,
      auth: {
        authorization: (signal) => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Bearer must-not-leak")), { once: true });
        }),
      },
      fetch: vi.fn() as typeof fetch,
    });
    const error = await client.callReadTool({
      requestId: "research-auth-timeout",
      prompt: "Read only",
      context: {},
    }).catch((value: unknown) => value);
    expect(String(error)).toBe("Error: AgentCore Gateway authorization is unavailable");
    expect(String(error)).not.toContain("must-not-leak");
  });

  it("rejects an MCP JSON-RPC error without echoing its message", async () => {
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scope,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: async (_url, init) => {
        const call = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          error: { code: -32000, message: "secret must-not-leak" },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    const error = await client.callReadTool({
      requestId: "research-jsonrpc-error",
      prompt: "Read only",
      context: {},
    }).catch((value: unknown) => value);
    expect(String(error)).toBe("Error: AgentCore Gateway returned a JSON-RPC error");
    expect(String(error)).not.toContain("must-not-leak");
  });
});
