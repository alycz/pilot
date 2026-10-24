import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  AGENTCORE_MCP_PROTOCOL_VERSION,
  AGENTCORE_STANDIN_TOOL,
  AgentCoreGatewayCallSchema,
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

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
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
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", origin || "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/ping") {
        json(response, 200, { status: "Healthy" });
        return;
      }
      if (request.method !== "POST") {
        json(response, 404, { error: "not_found" });
        return;
      }
      if (url.pathname === "/mcp") {
        if (
          request.headers.authorization !== bearer ||
          request.headers["mcp-protocol-version"] !== AGENTCORE_MCP_PROTOCOL_VERSION ||
          request.headers["content-type"] !== "application/json" ||
          !String(request.headers.accept).split(",").map((value) => value.trim()).includes("application/json")
        ) {
          json(response, 401, { error: "unauthorized" });
          return;
        }
        const call = AgentCoreGatewayCallSchema.parse(await readBody(request, maxRequestBytes));
        if (call.params.name !== gatewayToolName) {
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
          scope: args.scope,
          prompt: args.prompt,
          context: args.context,
        }));
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
