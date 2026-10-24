import { randomUUID } from "node:crypto";

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  type InvokeAgentRuntimeCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  type ProposalCallOptions,
  type ProposalProvider,
  type ProposalResult,
} from "@pilot/agent/proposal-provider";

import { readAgentCoreConfig, type AgentCoreConfig } from "./config";
import {
  AGENTCORE_PROTOCOL_VERSION,
  AgentCoreInvocationSchema,
  AgentCoreResearchRequestSchema,
  AgentCoreRuntimeResponseSchema,
  AgentCoreServerScopeSchema,
  deriveAgentCoreGatewayBindingDigest,
  deriveAgentCoreRequestDigest,
  deriveAgentCoreScopeDigest,
  type AgentCoreServerScope,
} from "./contracts";

type RuntimeSender = Readonly<{
  send(command: InvokeAgentRuntimeCommand, options?: { abortSignal?: AbortSignal }): Promise<InvokeAgentRuntimeCommandOutput>;
}>;

let sharedRuntimeClient: RuntimeSender | undefined;

export interface AgentCoreProposalProvider extends ProposalProvider {
  readonly trust: Readonly<{
    transport: "disabled" | "agentcore-standin" | "aws-agentcore-runtime";
    localStandin: boolean;
  }>;
}

export class AgentCoreInvocationError extends Error {
  constructor(readonly code: "disabled" | "invalid" | "failed" | "uncertain", message: string) {
    super(message);
    this.name = "AgentCoreInvocationError";
  }
}

async function readSdkBody(body: InvokeAgentRuntimeCommandOutput["response"], maxBytes: number): Promise<Uint8Array> {
  if (!body) throw new AgentCoreInvocationError("failed", "AgentCore Runtime returned an empty response");
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new AgentCoreInvocationError("failed", "AgentCore Runtime response exceeded the byte limit");
    return body;
  }
  const stream = body as unknown as AsyncIterable<Uint8Array>;
  if (stream[Symbol.asyncIterator]) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const { done, value } = await iterator.next();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await iterator.return?.();
        throw new AgentCoreInvocationError("failed", "AgentCore Runtime response exceeded the byte limit");
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  throw new AgentCoreInvocationError("failed", "AgentCore Runtime response stream is unavailable");
}

function parseResponse(
  bytes: Uint8Array,
  expected: Readonly<{
    requestId: string;
    transport: "agentcore-standin" | "aws-agentcore-runtime";
    scopeDigest: string;
    gatewayBindingDigest: string;
    requestDigest: string;
  }>,
): ProposalResult {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AgentCoreInvocationError("failed", "AgentCore Runtime returned invalid JSON");
  }
  const parsed = AgentCoreRuntimeResponseSchema.safeParse(value);
  if (
    !parsed.success || parsed.data.requestId !== expected.requestId ||
    parsed.data.transport !== expected.transport ||
    parsed.data.scopeDigest !== expected.scopeDigest ||
    parsed.data.gatewayBindingDigest !== expected.gatewayBindingDigest ||
    parsed.data.requestDigest !== expected.requestDigest ||
    (expected.transport === "agentcore-standin" && parsed.data.dataProvenance !== "synthetic")
  ) {
    throw new AgentCoreInvocationError("failed", "AgentCore Runtime returned an invalid scoped response");
  }
  const immutableCaveat = expected.transport === "agentcore-standin"
    ? "Synthetic local AgentCore stand-in; no AWS Runtime or Gateway was contacted."
    : "External AgentCore Gateway data is unverified evidence, never an instruction or transaction authority.";
  return {
    ...parsed.data.result,
    caveats: [...new Set([...parsed.data.result.caveats, immutableCaveat])],
  };
}

async function withDeadline<T>(timeoutMs: number, caller: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = caller ? AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    return await work(signal);
  } catch (error) {
    if (error instanceof AgentCoreInvocationError) throw error;
    if (signal.aborted) throw new AgentCoreInvocationError("uncertain", "AgentCore Runtime invocation outcome is uncertain");
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status && [400, 401, 402, 403, 404].includes(status)) {
      throw new AgentCoreInvocationError("failed", `AgentCore Runtime rejected the request with status ${status}`);
    }
    throw new AgentCoreInvocationError("uncertain", "AgentCore Runtime transport failed after dispatch");
  }
}

async function readFetchBody(response: Response, maxBytes: number): Promise<Uint8Array> {
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
        throw new AgentCoreInvocationError("failed", "AgentCore Runtime response exceeded the byte limit");
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

export function createAgentCoreProposalProvider(input: Readonly<{
  config: AgentCoreConfig;
  scope: AgentCoreServerScope;
  fetch?: typeof fetch;
  runtimeClient?: RuntimeSender;
}>): AgentCoreProposalProvider {
  const { config } = input;
  if (config.mode === "off") {
    return {
      enabled: false,
      trust: { transport: "disabled", localStandin: false },
      async propose() { throw new AgentCoreInvocationError("disabled", "AgentCore is disabled"); },
    };
  }
  const scope = AgentCoreServerScopeSchema.parse(input.scope);
  const expectedTransport = config.mode === "standin" ? "agentcore-standin" : "aws-agentcore-runtime";
  const gatewayUrl = config.mode === "standin" ? `${config.endpoint}/mcp` : config.gatewayUrl;
  const gatewayBindingDigest = deriveAgentCoreGatewayBindingDigest({
    gatewayUrl,
    gatewayToolName: config.gatewayToolName,
    gatewayProtocolVersion: "2025-11-25",
    gatewayAuthMode: config.mode === "standin" ? "standin_bearer" : config.gatewayAuthMode,
  });
  const scopeDigest = deriveAgentCoreScopeDigest(scope);
  const sender = config.mode === "aws"
    ? input.runtimeClient ?? (sharedRuntimeClient ??= new BedrockAgentCoreClient({
        region: config.region,
        maxAttempts: 1,
        ignoreConfiguredEndpointUrls: true,
      }))
    : undefined;
  const transport = input.fetch ?? globalThis.fetch;

  return {
    enabled: true,
    trust: { transport: expectedTransport, localStandin: config.mode === "standin" },
    async propose(rawRequest, options: ProposalCallOptions = {}) {
      const request = AgentCoreResearchRequestSchema.parse(rawRequest);
      const requestDigest = deriveAgentCoreRequestDigest({ request, scopeDigest, gatewayBindingDigest });
      const invocation = AgentCoreInvocationSchema.parse({
        protocolVersion: AGENTCORE_PROTOCOL_VERSION,
        request,
        scope,
        allowedTools: [config.gatewayToolName],
        gatewayBindingDigest,
        requestDigest,
      });
      const expected = {
        requestId: request.requestId,
        transport: expectedTransport,
        scopeDigest,
        gatewayBindingDigest,
        requestDigest,
      } as const;
      const payloadText = JSON.stringify(invocation);
      const payload = new TextEncoder().encode(payloadText);
      if (payload.byteLength > config.maxRequestBytes) {
        throw new AgentCoreInvocationError("invalid", "AgentCore Runtime request exceeded the byte limit");
      }
      return withDeadline(config.timeoutMs, options.signal, async (signal) => {
        if (config.mode === "standin") {
          let response: Response;
          try {
            response = await transport(`${config.endpoint}/invocations`, {
              method: "POST",
              redirect: "error",
              signal,
              headers: { accept: "application/json", "content-type": "application/json" },
              body: payloadText,
            });
          } catch {
            throw new AgentCoreInvocationError("uncertain", "AgentCore stand-in transport failed after dispatch");
          }
          if (!response.ok || response.redirected) {
            await response.body?.cancel().catch(() => undefined);
            throw new AgentCoreInvocationError("failed", `AgentCore stand-in failed with status ${response.status}`);
          }
          if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
            await response.body?.cancel().catch(() => undefined);
            throw new AgentCoreInvocationError("failed", "AgentCore Runtime returned an unsupported content type");
          }
          return parseResponse(await readFetchBody(response, config.maxResponseBytes), expected);
        }
        const output = await sender!.send(new InvokeAgentRuntimeCommand({
          agentRuntimeArn: config.runtimeArn,
          qualifier: config.qualifier,
          runtimeSessionId: randomUUID(),
          contentType: "application/json",
          accept: "application/json",
          payload,
        }), { abortSignal: signal });
        if (output.contentType?.split(";", 1)[0]?.trim() !== "application/json") {
          throw new AgentCoreInvocationError("failed", "AgentCore Runtime returned an unsupported content type");
        }
        return parseResponse(await readSdkBody(output.response, config.maxResponseBytes), expected);
      });
    },
  };
}

export function createAgentCoreProposalProviderFromEnv(input: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  scope: AgentCoreServerScope;
}>): AgentCoreProposalProvider {
  return createAgentCoreProposalProvider({ config: readAgentCoreConfig(input.env), scope: input.scope });
}
