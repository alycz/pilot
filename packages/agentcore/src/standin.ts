import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  AGENTCORE_MCP_PROTOCOL_VERSION,
  AGENTCORE_STANDIN_TOOL,
  AgentCoreGatewayCancelledNotificationSchema,
  AgentCoreGatewayCallSchema,
  AgentCoreGatewayInitializedNotificationSchema,
  AgentCoreGatewayInitializeCallSchema,
  AgentCoreMarketContextSchema,
  type AgentCoreScopedToolInvoker,
} from "./contracts";
import { createAgentCoreRuntimeHandler } from "./runtime-handler";

async function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

export async function startAgentCoreStandin(input: Readonly<{
  tools: AgentCoreScopedToolInvoker;
  gatewayToolName?: string;
  maxRequestBytes?: number;
}>): Promise<Readonly<{ origin: string; close(): Promise<void> }>> {
  let origin = "";
  const gatewayToolName = input.gatewayToolName ?? AGENTCORE_STANDIN_TOOL;
  const maxRequestBytes = input.maxRequestBytes ?? 64 * 1024;
  const bearer = `Bearer ${randomBytes(32).toString("hex")}`;
  const sessions = new Map<string, {
    state: "created" | "initialized" | "in_flight" | "completed" | "cancelled";
    requestId?: string | number;
    controller?: AbortController;
  }>();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", origin || "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/ping") {
        json(response, 200, { status: "Healthy" });
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/mcp") {
        const sessionId = request.headers["mcp-session-id"];
        if (
          request.headers.authorization !== bearer ||
          request.headers["mcp-protocol-version"] !== AGENTCORE_MCP_PROTOCOL_VERSION ||
          typeof sessionId !== "string" || !sessions.has(sessionId)
        ) {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        sessions.get(sessionId)?.controller?.abort(new Error("session_ended"));
        sessions.delete(sessionId);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method !== "POST") {
        json(response, 404, { error: "not_found" });
        return;
      }
      if (url.pathname === "/mcp") {
        const accepted = String(request.headers.accept)
          .split(",")
          .map((value) => value.trim());
        if (
          request.headers.authorization !== bearer ||
          request.headers["content-type"] !== "application/json" ||
          !accepted.includes("application/json") ||
          !accepted.includes("text/event-stream")
        ) {
          json(response, 401, { error: "unauthorized" });
          return;
        }
        const body = await readBody(request, maxRequestBytes);
        const initialize = AgentCoreGatewayInitializeCallSchema.safeParse(body);
        if (initialize.success) {
          if (request.headers["mcp-session-id"] || request.headers["mcp-protocol-version"]) {
            json(response, 400, { error: "invalid_initialize" });
            return;
          }
          const sessionId = randomBytes(24).toString("base64url");
          sessions.set(sessionId, { state: "created" });
          json(response, 200, {
            jsonrpc: "2.0",
            id: initialize.data.id,
            result: {
              protocolVersion: AGENTCORE_MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "pilot-agentcore-standin", version: "1.0.0" },
            },
          }, { "mcp-session-id": sessionId });
          return;
        }
        const sessionId = request.headers["mcp-session-id"];
        const initialized = AgentCoreGatewayInitializedNotificationSchema.safeParse(body);
        if (
          initialized.success &&
          request.headers["mcp-protocol-version"] === AGENTCORE_MCP_PROTOCOL_VERSION &&
          typeof sessionId === "string" && sessions.get(sessionId)?.state === "created"
        ) {
          sessions.set(sessionId, { state: "initialized" });
          response.writeHead(202, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const cancelled = AgentCoreGatewayCancelledNotificationSchema.safeParse(body);
        const active = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
        if (
          cancelled.success &&
          request.headers["mcp-protocol-version"] === AGENTCORE_MCP_PROTOCOL_VERSION &&
          active?.state === "in_flight" && active.requestId === cancelled.data.params.requestId
        ) {
          active.controller?.abort(new Error("request_cancelled"));
          sessions.set(sessionId as string, { state: "cancelled", requestId: active.requestId });
          response.writeHead(202, { "cache-control": "no-store" });
          response.end();
          return;
        }
        if (
          request.headers["mcp-protocol-version"] !== AGENTCORE_MCP_PROTOCOL_VERSION ||
          typeof sessionId !== "string" || sessions.get(sessionId)?.state !== "initialized"
        ) {
          json(response, 401, { error: "invalid_session" });
          return;
        }
        const call = AgentCoreGatewayCallSchema.parse(body);
        const controller = new AbortController();
        sessions.set(sessionId, { state: "in_flight", requestId: call.id, controller });
        if (call.params.name !== gatewayToolName) {
          sessions.set(sessionId, { state: "completed", requestId: call.id });
          json(response, 200, {
            jsonrpc: "2.0",
            id: call.id,
            error: { code: -32601, message: "Tool is not allowlisted" },
          });
          return;
        }
        const args = call.params.arguments;
        const result = AgentCoreMarketContextSchema.parse(await input.tools.invoke({
          name: gatewayToolName,
          requestId: args.requestId,
          scopeDigest: args.scopeDigest,
          context: args.context,
          signal: controller.signal,
        }));
        if (sessions.get(sessionId)?.state === "in_flight") {
          sessions.set(sessionId, { state: "completed", requestId: call.id });
        }
        json(response, 200, {
          jsonrpc: "2.0",
          id: call.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          },
        });
        return;
      }
      if (url.pathname === "/invocations") {
        if (
          request.headers["content-type"] !== "application/json" ||
          !String(request.headers.accept).split(",").map((value) => value.trim()).includes("application/json")
        ) {
          json(response, 415, { error: "unsupported_media_type" });
          return;
        }
        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        const runtime = createAgentCoreRuntimeHandler({
          transport: "agentcore-standin",
          dataProvenance: "synthetic",
          gatewayUrl: `${origin}/mcp`,
          gatewayToolName,
          gatewayAuthMode: "standin_bearer",
          gatewayAuth: { async authorization() { return bearer; } },
        });
        json(response, 200, await runtime.invoke(
          await readBody(request, maxRequestBytes),
          controller.signal,
        ));
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch {
      json(response, 400, { error: "invalid_request" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("AgentCore stand-in failed to bind");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
