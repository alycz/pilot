import { describe, expect, it, vi } from "vitest";

import { createAgentCoreGatewayClient } from "../src/gateway";

const scopeDigest = "a".repeat(64);
const gatewayToolName = "PilotReadTarget___pilot.read_market_context";
const market = { summary: "Market fixture", evidence: [], caveats: [] };
const publicContext = {} as const;
const sessionId = "session-abcdefghijklmnop";

function initializedTransport(
  onTool: (call: Record<string, unknown>, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      expect(new Headers(init.headers).get("mcp-session-id")).toBe(sessionId);
      expect(new Headers(init.headers).get("mcp-protocol-version")).toBe("2025-11-25");
      return new Response(null, { status: 204 });
    }
    const call = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const accepted = String(new Headers(init?.headers).get("accept"))
      .split(",")
      .map((value) => value.trim());
    expect(accepted).toEqual(expect.arrayContaining(["application/json", "text/event-stream"]));
    if (call.method === "initialize") {
      expect(new Headers(init?.headers).get("mcp-session-id")).toBeNull();
      expect(new Headers(init?.headers).get("mcp-protocol-version")).toBeNull();
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: call.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture-gateway", version: "1.0.0" },
        },
      }), {
        headers: { "content-type": "application/json", "mcp-session-id": sessionId },
      });
    }
    expect(new Headers(init?.headers).get("mcp-session-id")).toBe(sessionId);
    expect(new Headers(init?.headers).get("mcp-protocol-version")).toBe("2025-11-25");
    if (call.method === "notifications/initialized") {
      expect(call).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
      return new Response(null, { status: 202 });
    }
    return onTool(call, init);
  });
}

describe("AgentCore Gateway MCP client", () => {
  it("sends the pinned protocol and one exact read-only tool", async () => {
    const transport = initializedTransport(async (call, init) => {
      expect(call).toMatchObject({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: gatewayToolName },
      });
      const parameters = call.params as Readonly<Record<string, unknown>>;
      const argumentsValue = parameters.arguments;
      expect(argumentsValue).toEqual({
        requestId: "research-1",
        scopeDigest,
        context: publicContext,
      });
      const serializedArguments = JSON.stringify(argumentsValue);
      for (const forbidden of [
        "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        "tenant-1",
        "testnet",
        "personalization",
        "prompt",
        "token",
        "privateKey",
      ]) {
        expect(serializedArguments).not.toContain(forbidden);
      }
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
      scopeDigest,
      auth: { async authorization() { return "Bearer opaque-test-token"; } },
      fetch: transport as typeof fetch,
    });
    await expect(client.callReadTool({
      requestId: "research-1",
      context: publicContext,
    })).resolves.toEqual(market);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("fails closed on bad auth, host, or mismatched JSON-RPC identity", async () => {
    expect(() => createAgentCoreGatewayClient({
      gatewayUrl: "https://example.com/mcp",
      gatewayToolName,
      scopeDigest,
      auth: { async authorization() { return "Bearer no"; } },
    })).toThrow("Invalid AgentCore Gateway endpoint");

    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scopeDigest,
      auth: { async authorization() { return "secret"; } },
      fetch: vi.fn() as typeof fetch,
    });
    await expect(client.callReadTool({
      requestId: "research-1",
      context: publicContext,
    })).rejects.toThrow("authorization is unavailable");
  });

  it("accepts one bounded MCP SSE result and rejects a mismatched response id", async () => {
    const transport = initializedTransport(async (call) => {
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
      scopeDigest,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: transport as typeof fetch,
    });
    await expect(client.callReadTool({
      requestId: "research-2",
      context: publicContext,
    })).resolves.toEqual(market);

    const mismatched = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scopeDigest,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: initializedTransport(async () => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "wrong",
        result: { content: [{ type: "text", text: "{}" }], structuredContent: market, isError: false },
      }), { headers: { "content-type": "application/json" } })) as typeof fetch,
    });
    await expect(mismatched.callReadTool({
      requestId: "research-3",
      context: publicContext,
    })).rejects.toThrow("invalid scoped result");
  });

  it("cancels an oversized streaming response", async () => {
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scopeDigest,
      auth: { async authorization() { return "Bearer standin"; } },
      maxResponseBytes: 512,
      fetch: initializedTransport(async () => new Response("x".repeat(513), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });
    await expect(client.callReadTool({
      requestId: "research-4",
      context: publicContext,
    })).rejects.toThrow("byte limit");
  });

  it("bounds and redacts authorization resolution", async () => {
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scopeDigest,
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
      context: publicContext,
    }).catch((value: unknown) => value);
    expect(String(error)).toBe("Error: AgentCore Gateway authorization is unavailable");
    expect(String(error)).not.toContain("must-not-leak");
  });

  it("requires a valid session and exact negotiated protocol", async () => {
    const missingSession = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scopeDigest,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: async (_url, init) => {
        const call = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "fixture", version: "1" },
          },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    await expect(missingSession.callReadTool({
      requestId: "research-no-session",
      context: publicContext,
    })).rejects.toThrow("invalid session");

    let wrongProtocolDeleted = false;
    const wrongProtocolTransport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        wrongProtocolDeleted = true;
        return new Response(null, { status: 204 });
      }
      const call = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: call.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "fixture", version: "1" },
        },
      }), {
        headers: { "content-type": "application/json", "mcp-session-id": sessionId },
      });
    });
    const wrongProtocol = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scopeDigest,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: wrongProtocolTransport as typeof fetch,
    });
    await expect(wrongProtocol.callReadTool({
      requestId: "research-wrong-protocol",
      context: publicContext,
    })).rejects.toThrow("invalid initialization result");
    expect(wrongProtocolDeleted).toBe(true);
  });

  it("never calls a tool unless the initialized notification returns 202", async () => {
    let toolsCalled = 0;
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const call = JSON.parse(String(init?.body));
      if (call.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "fixture", version: "1" },
          },
        }), {
          headers: { "content-type": "application/json", "mcp-session-id": sessionId },
        });
      }
      if (call.method === "notifications/initialized") {
        return new Response("do-not-read-secret-body", { status: 200 });
      }
      toolsCalled += 1;
      return new Response(null, { status: 500 });
    });
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scopeDigest,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: transport as typeof fetch,
    });
    await expect(client.callReadTool({
      requestId: "research-notification-rejected",
      context: publicContext,
    })).rejects.toThrow("acknowledgement failed with status 200");
    expect(toolsCalled).toBe(0);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("cancels an in-flight tool before deleting its session on timeout", async () => {
    const order: string[] = [];
    let toolRequestId = "";
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        order.push("delete");
        return new Response(null, { status: 204 });
      }
      const call = JSON.parse(String(init?.body));
      order.push(String(call.method));
      if (call.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "fixture", version: "1" },
          },
        }), {
          headers: { "content-type": "application/json", "mcp-session-id": sessionId },
        });
      }
      if (call.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (call.method === "tools/call") {
        toolRequestId = call.id;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("secret timeout")), { once: true });
        });
      }
      expect(call).toEqual({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: toolRequestId, reason: "request cancelled" },
      });
      return new Response(null, { status: 202 });
    });
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scopeDigest,
      timeoutMs: 10,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: transport as typeof fetch,
    });
    await expect(client.callReadTool({
      requestId: "research-cancelled",
      context: publicContext,
    })).rejects.toThrow("AgentCore Gateway transport failed");
    expect(order).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "notifications/cancelled",
      "delete",
    ]);
  });

  it("cancels before deleting after an exceptional post-dispatch HTTP result", async () => {
    const order: string[] = [];
    let toolRequestId = "";
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        order.push("delete");
        return new Response(null, { status: 204 });
      }
      const call = JSON.parse(String(init?.body));
      order.push(String(call.method));
      if (call.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "fixture", version: "1" },
          },
        }), {
          headers: { "content-type": "application/json", "mcp-session-id": sessionId },
        });
      }
      if (call.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (call.method === "tools/call") {
        toolRequestId = call.id;
        return new Response("upstream details must-not-leak", { status: 503 });
      }
      expect(call).toEqual({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: toolRequestId, reason: "request cancelled" },
      });
      return new Response(null, { status: 202 });
    });
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scopeDigest,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: transport as typeof fetch,
    });
    const error = await client.callReadTool({
      requestId: "research-post-dispatch-error",
      context: {},
    }).catch((value: unknown) => value);
    expect(String(error)).toBe("Error: AgentCore Gateway request failed with status 503");
    expect(String(error)).not.toContain("must-not-leak");
    expect(order).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "notifications/cancelled",
      "delete",
    ]);
  });

  it("bounds a never-ending response body and performs cancellation cleanup", async () => {
    const order: string[] = [];
    let toolRequestId = "";
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        order.push("delete");
        return new Response(null, { status: 204 });
      }
      const call = JSON.parse(String(init?.body));
      order.push(String(call.method));
      if (call.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "fixture", version: "1" },
          },
        }), {
          headers: { "content-type": "application/json", "mcp-session-id": sessionId },
        });
      }
      if (call.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (call.method === "tools/call") {
        toolRequestId = call.id;
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(call).toEqual({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: toolRequestId, reason: "request cancelled" },
      });
      return new Response(null, { status: 202 });
    });
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scopeDigest,
      timeoutMs: 10,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: transport as typeof fetch,
    });
    const started = Date.now();
    await expect(client.callReadTool({
      requestId: "research-never-ending-body",
      context: {},
    })).rejects.toThrow("response read timed out");
    expect(Date.now() - started).toBeLessThan(500);
    expect(order).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "notifications/cancelled",
      "delete",
    ]);
  });

  it("deletes without cancelling when the caller aborts before tool dispatch", async () => {
    const order: string[] = [];
    const caller = new AbortController();
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        order.push("delete");
        return new Response(null, { status: 204 });
      }
      const call = JSON.parse(String(init?.body));
      order.push(String(call.method));
      if (call.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "fixture", version: "1" },
          },
        }), {
          headers: { "content-type": "application/json", "mcp-session-id": sessionId },
        });
      }
      expect(call.method).toBe("notifications/initialized");
      caller.abort();
      return new Response(null, { status: 202 });
    });
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scopeDigest,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: transport as typeof fetch,
    });
    await expect(client.callReadTool({
      requestId: "research-aborted-before-tool",
      context: publicContext,
    }, { signal: caller.signal })).rejects.toThrow("AgentCore Gateway transport failed");
    expect(order).toEqual(["initialize", "notifications/initialized", "delete"]);
  });

  it.each(["failure", "timeout"] as const)(
    "preserves the primary error when cancellation cleanup has a %s",
    async (cleanupMode) => {
      const order: string[] = [];
      const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          order.push("delete");
          return new Response(null, { status: 204 });
        }
        const call = JSON.parse(String(init?.body));
        order.push(String(call.method));
        if (call.method === "initialize") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: call.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "fixture", version: "1" },
            },
          }), {
            headers: { "content-type": "application/json", "mcp-session-id": sessionId },
          });
        }
        if (call.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (call.method === "tools/call") {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("primary hidden")), { once: true });
          });
        }
        if (cleanupMode === "failure") throw new Error("cleanup hidden");
        return await new Promise<Response>(() => undefined);
      });
      const client = createAgentCoreGatewayClient({
        gatewayUrl: "http://127.0.0.1:32147/mcp",
        gatewayToolName,
        scopeDigest,
        timeoutMs: 10,
        auth: { async authorization() { return "Bearer standin"; } },
        fetch: transport as typeof fetch,
      });
      const started = Date.now();
      await expect(client.callReadTool({
        requestId: `research-cleanup-${cleanupMode}`,
        context: publicContext,
      })).rejects.toThrow("AgentCore Gateway transport failed");
      expect(Date.now() - started).toBeLessThan(500);
      expect(order).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/call",
        "notifications/cancelled",
        "delete",
      ]);
    },
  );

  it("rejects an MCP JSON-RPC error without echoing its message", async () => {
    const client = createAgentCoreGatewayClient({
      gatewayUrl: "http://127.0.0.1:32147/mcp",
      gatewayToolName,
      scopeDigest,
      auth: { async authorization() { return "Bearer standin"; } },
      fetch: initializedTransport(async (call) => {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          error: { code: -32000, message: "secret must-not-leak" },
        }), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const error = await client.callReadTool({
      requestId: "research-jsonrpc-error",
      context: publicContext,
    }).catch((value: unknown) => value);
    expect(String(error)).toBe("Error: AgentCore Gateway returned a JSON-RPC error");
    expect(String(error)).not.toContain("must-not-leak");
  });
});
