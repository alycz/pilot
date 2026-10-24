import { randomUUID } from "node:crypto";

import {
  AGENTCORE_MCP_PROTOCOL_VERSION,
  AgentCoreGatewayArgumentsSchema,
  AgentCoreGatewayErrorSchema,
  AgentCoreGatewayResultSchema,
  AgentCoreGatewayToolNameSchema,
  AgentCoreServerScopeSchema,
  type AgentCoreGatewayArguments,
  type AgentCoreServerScope,
} from "./contracts";

export type AgentCoreGatewayAuth = Readonly<{
  authorization(signal?: AbortSignal): Promise<string>;
}>;

export type AgentCoreGatewayClient = Readonly<{
  callReadTool(
    input: Omit<AgentCoreGatewayArguments, "scope">,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<Record<string, unknown>>>;
}>;

async function boundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("AgentCore Gateway response exceeded the byte limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("AgentCore Gateway response exceeded the byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function boundedPayloads(response: Response, maxBytes: number): Promise<unknown[]> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const bytes = await boundedBytes(response, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("AgentCore Gateway returned invalid UTF-8");
  }
  try {
    if (contentType === "application/json") return [JSON.parse(text)];
    if (contentType === "text/event-stream") {
      const events = text
        .split(/\r?\n\r?\n/)
        .map((block) => block.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n"))
        .filter((entry) => entry && entry !== "[DONE]");
      return events.map((event) => JSON.parse(event));
    }
  } catch {
    throw new Error("AgentCore Gateway returned invalid JSON-RPC data");
  }
  throw new Error("AgentCore Gateway returned an unsupported content type");
}

export function createAgentCoreGatewayClient(input: Readonly<{
  gatewayUrl: string;
  gatewayToolName: string;
  scope: AgentCoreServerScope;
  auth: AgentCoreGatewayAuth;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>): AgentCoreGatewayClient {
  const url = new URL(input.gatewayUrl);
  const isLoopback = url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  const isAws = url.protocol === "https:" && url.hostname.endsWith(".gateway.bedrock-agentcore.us-east-1.amazonaws.com");
  if (
    (!isLoopback && !isAws) || url.pathname !== "/mcp" ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error("Invalid AgentCore Gateway endpoint");
  }
  const transport = input.fetch ?? globalThis.fetch;
  const gatewayToolName = AgentCoreGatewayToolNameSchema.parse(input.gatewayToolName);
  const scope = AgentCoreServerScopeSchema.parse(input.scope);
  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxResponseBytes = input.maxResponseBytes ?? 256 * 1024;

  return {
    async callReadTool(raw, options = {}) {
      const args = AgentCoreGatewayArgumentsSchema.parse({ ...raw, scope });
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      let authorization: string;
      try {
        authorization = await input.auth.authorization(signal);
      } catch {
        throw new Error("AgentCore Gateway authorization is unavailable");
      }
      if (!/^Bearer [^\s]+$/.test(authorization)) {
        throw new Error("AgentCore Gateway authorization is unavailable");
      }
      const id = randomUUID();
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: gatewayToolName, arguments: args },
      });
      let response: Response;
      try {
        response = await transport(url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            accept: "application/json, text/event-stream",
            authorization,
            "content-type": "application/json",
            "mcp-protocol-version": AGENTCORE_MCP_PROTOCOL_VERSION,
          },
          body,
        });
      } catch {
        throw new Error("AgentCore Gateway transport failed");
      }
      if (!response.ok || response.redirected) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`AgentCore Gateway request failed with status ${response.status}`);
      }
      const payloads = await boundedPayloads(response, maxResponseBytes);
      if (payloads.some((payload) => {
        const parsed = AgentCoreGatewayErrorSchema.safeParse(payload);
        return parsed.success && parsed.data.id === id;
      })) {
        throw new Error("AgentCore Gateway returned a JSON-RPC error");
      }
      const matches = payloads
        .map((payload) => AgentCoreGatewayResultSchema.safeParse(payload))
        .filter((parsed) => parsed.success && parsed.data.id === id);
      const match = matches[0];
      if (matches.length !== 1 || !match?.success) {
        throw new Error("AgentCore Gateway returned an invalid scoped result");
      }
      return match.data.result.structuredContent;
    },
  };
}
