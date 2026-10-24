import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  AGENTCORE_MCP_PROTOCOL_VERSION,
  AgentCoreGatewayArgumentsSchema,
  AgentCoreGatewayErrorSchema,
  AgentCoreGatewayInitializeResultSchema,
  AgentCoreGatewayResultSchema,
  AgentCoreGatewaySessionIdSchema,
  AgentCoreGatewayToolNameSchema,
  type AgentCoreGatewayArguments,
} from "./contracts";

export type AgentCoreGatewayAuth = Readonly<{
  authorization(signal?: AbortSignal): Promise<string>;
}>;

export type AgentCoreGatewayClient = Readonly<{
  callReadTool(
    input: Omit<AgentCoreGatewayArguments, "scopeDigest">,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<Record<string, unknown>>>;
}>;

async function boundedBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
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
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new Error("AgentCore Gateway response read timed out");
      }
      const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>(
        (resolve, reject) => {
          let settled = false;
          const finish = (work: () => void): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            work();
          };
          const onAbort = (): void => {
            void reader.cancel().catch(() => undefined);
            finish(() => reject(new Error("AgentCore Gateway response read timed out")));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
            return;
          }
          reader.read().then(
            (result) => finish(() => resolve(result)),
            () => finish(() => reject(new Error("AgentCore Gateway response read failed"))),
          );
        },
      );
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("AgentCore Gateway response exceeded the byte limit");
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A non-compliant stream may retain a pending read after cancellation.
    }
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function boundedPayloads(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown[]> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const bytes = await boundedBytes(response, maxBytes, signal);
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
  scopeDigest: string;
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
  const scopeDigest = z.string().regex(/^[a-f0-9]{64}$/).parse(input.scopeDigest);
  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxResponseBytes = input.maxResponseBytes ?? 256 * 1024;

  return {
    async callReadTool(raw, options = {}) {
      const args = AgentCoreGatewayArgumentsSchema.parse({ ...raw, scopeDigest });
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
      const initializeId = randomUUID();
      let initializeResponse: Response;
      try {
        initializeResponse = await transport(url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            accept: "application/json, text/event-stream",
            authorization,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: initializeId,
            method: "initialize",
            params: {
              protocolVersion: AGENTCORE_MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "pilot-agentcore-runtime", version: "1.0.0" },
            },
          }),
        });
      } catch {
        throw new Error("AgentCore Gateway initialization failed");
      }
      if (!initializeResponse.ok || initializeResponse.redirected) {
        await initializeResponse.body?.cancel().catch(() => undefined);
        throw new Error(`AgentCore Gateway initialization failed with status ${initializeResponse.status}`);
      }
      const sessionId = AgentCoreGatewaySessionIdSchema.safeParse(
        initializeResponse.headers.get("mcp-session-id"),
      );
      if (!sessionId.success) {
        await initializeResponse.body?.cancel().catch(() => undefined);
        throw new Error("AgentCore Gateway returned an invalid session");
      }
      const sessionHeaders = {
        accept: "application/json, text/event-stream",
        authorization,
        "content-type": "application/json",
        "mcp-session-id": sessionId.data,
        "mcp-protocol-version": AGENTCORE_MCP_PROTOCOL_VERSION,
      } as const;
      const cleanupTimeoutMs = Math.max(100, Math.min(timeoutMs, 1_000));
      const boundedCleanup = async (
        work: (cleanupSignal: AbortSignal) => Promise<void>,
        cleanupSignal: AbortSignal,
      ): Promise<void> => {
        if (cleanupSignal.aborted) return;
        const pending = Promise.resolve().then(() => work(cleanupSignal));
        let onAbort!: () => void;
        const aborted = new Promise<void>((resolve) => {
          onAbort = resolve;
          cleanupSignal.addEventListener("abort", onAbort, { once: true });
          if (cleanupSignal.aborted) onAbort();
        });
        try {
          await Promise.race([pending.catch(() => undefined), aborted]);
        } finally {
          cleanupSignal.removeEventListener("abort", onAbort);
          void pending.catch(() => undefined);
        }
      };
      const cleanup = async (cancelRequestId?: string): Promise<void> => {
        if (cancelRequestId) {
          await boundedCleanup(async (requestSignal) => {
            const cancellation = await transport(url, {
              method: "POST",
              redirect: "error",
              signal: requestSignal,
              headers: sessionHeaders,
              body: JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/cancelled",
                params: { requestId: cancelRequestId, reason: "request cancelled" },
              }),
            });
            await cancellation.body?.cancel().catch(() => undefined);
          }, AbortSignal.timeout(cleanupTimeoutMs));
        }
        await boundedCleanup(async (requestSignal) => {
          const ended = await transport(url, {
            method: "DELETE",
            redirect: "error",
            signal: requestSignal,
            headers: {
              accept: "application/json, text/event-stream",
              authorization,
              "mcp-session-id": sessionId.data,
              "mcp-protocol-version": AGENTCORE_MCP_PROTOCOL_VERSION,
            },
          });
          await ended.body?.cancel().catch(() => undefined);
        }, AbortSignal.timeout(cleanupTimeoutMs));
      };

      let toolRequestId: string | undefined;
      let toolDispatched = false;
      let cleanupStarted = false;
      try {
        const initializePayloads = await boundedPayloads(initializeResponse, maxResponseBytes, signal);
        if (initializePayloads.some((payload) => {
          const parsed = AgentCoreGatewayErrorSchema.safeParse(payload);
          return parsed.success && parsed.data.id === initializeId;
        })) {
          throw new Error("AgentCore Gateway initialization returned a JSON-RPC error");
        }
        const initialized = initializePayloads
          .map((payload) => AgentCoreGatewayInitializeResultSchema.safeParse(payload))
          .filter((parsed) => parsed.success && parsed.data.id === initializeId);
        if (initialized.length !== 1) {
          throw new Error("AgentCore Gateway returned an invalid initialization result");
        }
        let notificationResponse: Response;
        try {
          notificationResponse = await transport(url, {
            method: "POST",
            redirect: "error",
            signal,
            headers: sessionHeaders,
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            }),
          });
        } catch {
          throw new Error("AgentCore Gateway initialization acknowledgement failed");
        }
        if (notificationResponse.redirected || notificationResponse.status !== 202) {
          await notificationResponse.body?.cancel().catch(() => undefined);
          throw new Error(
            `AgentCore Gateway initialization acknowledgement failed with status ${notificationResponse.status}`,
          );
        }
        await notificationResponse.body?.cancel().catch(() => undefined);
        toolRequestId = randomUUID();
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: toolRequestId,
          method: "tools/call",
          params: { name: gatewayToolName, arguments: args },
        });
        if (signal.aborted) throw new Error("AgentCore Gateway transport failed");
        let response: Response;
        try {
          toolDispatched = true;
          response = await transport(url, {
            method: "POST",
            redirect: "error",
            signal,
            headers: sessionHeaders,
            body,
          });
        } catch {
          throw new Error("AgentCore Gateway transport failed");
        }
        if (!response.ok || response.redirected) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`AgentCore Gateway request failed with status ${response.status}`);
        }
        const payloads = await boundedPayloads(response, maxResponseBytes, signal);
        if (payloads.some((payload) => {
          const parsed = AgentCoreGatewayErrorSchema.safeParse(payload);
          return parsed.success && parsed.data.id === toolRequestId;
        })) {
          throw new Error("AgentCore Gateway returned a JSON-RPC error");
        }
        const matches = payloads
          .map((payload) => AgentCoreGatewayResultSchema.safeParse(payload))
          .filter((parsed) => parsed.success && parsed.data.id === toolRequestId);
        const match = matches[0];
        if (matches.length !== 1 || !match?.success) {
          throw new Error("AgentCore Gateway returned an invalid scoped result");
        }
        return match.data.result.structuredContent;
      } catch (error) {
        if (toolDispatched) {
          cleanupStarted = true;
          await cleanup(toolRequestId);
        }
        throw error;
      } finally {
        if (!cleanupStarted) await cleanup();
      }
    },
  };
}
