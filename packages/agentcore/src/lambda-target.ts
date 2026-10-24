import { z } from "zod";

import {
  AgentCoreGatewayArgumentsSchema,
  AgentCoreMarketContextSchema,
} from "./contracts";

export const AGENTCORE_LAMBDA_TOOL_NAME = "pilot.read_market_context" as const;

const ContextIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

const TargetNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);

const GatewayContextSchema = z
  .object({
    bedrockAgentCoreMessageVersion: z.literal("1.0"),
    bedrockAgentCoreAwsRequestId: ContextIdentifierSchema,
    bedrockAgentCoreMcpMessageId: ContextIdentifierSchema,
    bedrockAgentCoreGatewayId: ContextIdentifierSchema,
    bedrockAgentCoreTargetId: ContextIdentifierSchema,
    bedrockAgentCoreToolName: z.string().min(5).max(256),
  })
  .strict();

export type AgentCoreLambdaMarketRead = Readonly<{
  requestId: string;
  scopeDigest: string;
}>;

/**
 * The injected public-market source receives only a request ID and opaque
 * scope digest. Fixed public-market selectors stay in managed configuration;
 * the external boundary receives no user prompt, wallet identity, signing
 * material, payment state, or secrets.
 */
export interface AgentCoreLambdaMarketSource {
  read(
    input: AgentCoreLambdaMarketRead,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<unknown>;
}

export type AgentCoreLambdaContext = Readonly<{
  clientContext?: Readonly<{ custom?: Readonly<Record<string, unknown>> | null }> | null;
}>;

export class AgentCoreLambdaTargetError extends Error {
  constructor(readonly code:
    | "configuration"
    | "invalid_event"
    | "invalid_context"
    | "source_failed"
    | "source_timeout"
    | "invalid_response") {
    super(`AgentCore Lambda target ${code.replaceAll("_", " ")}`);
    this.name = "AgentCoreLambdaTargetError";
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new AgentCoreLambdaTargetError("configuration");
  }
  return result;
}

function serializedSize(value: unknown, failure: "invalid_event" | "invalid_response"): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new AgentCoreLambdaTargetError(failure);
  }
}

function gatewayContext(raw: unknown) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentCoreLambdaTargetError("invalid_context");
  }
  const clientContext = (raw as AgentCoreLambdaContext).clientContext;
  const parsed = GatewayContextSchema.safeParse(clientContext?.custom);
  if (!parsed.success) throw new AgentCoreLambdaTargetError("invalid_context");
  return parsed.data;
}

async function beforeDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  if (signal.aborted) throw new AgentCoreLambdaTargetError("source_timeout");
  const pending = Promise.resolve().then(() => work(signal));
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new AgentCoreLambdaTargetError("source_timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    void pending.catch(() => undefined);
  }
}

/**
 * Build the one production Gateway Lambda target boundary. Account-specific
 * Gateway and target identifiers are injected by the eventual deployment
 * entrypoint and must exactly match AgentCore's trusted Lambda context.
 */
export function createAgentCoreLambdaTargetHandler(input: Readonly<{
  gatewayId: string;
  targetId: string;
  targetName: string;
  source: AgentCoreLambdaMarketSource;
  timeoutMs?: number;
  maxEventBytes?: number;
  maxResponseBytes?: number;
}>) {
  const gatewayId = ContextIdentifierSchema.safeParse(input.gatewayId);
  const targetId = ContextIdentifierSchema.safeParse(input.targetId);
  const targetName = TargetNameSchema.safeParse(input.targetName);
  if (!gatewayId.success || !targetId.success || !targetName.success) {
    throw new AgentCoreLambdaTargetError("configuration");
  }
  const expectedToolName = `${targetName.data}___${AGENTCORE_LAMBDA_TOOL_NAME}`;
  const timeoutMs = boundedInteger(input.timeoutMs, 5_000, 100, 30_000);
  const maxEventBytes = boundedInteger(input.maxEventBytes, 32 * 1024, 1_024, 256 * 1024);
  const maxResponseBytes = boundedInteger(input.maxResponseBytes, 64 * 1024, 1_024, 256 * 1024);

  return async (rawEvent: unknown, rawContext: unknown) => {
    if (serializedSize(rawEvent, "invalid_event") > maxEventBytes) {
      throw new AgentCoreLambdaTargetError("invalid_event");
    }
    const event = AgentCoreGatewayArgumentsSchema.safeParse(rawEvent);
    if (!event.success) throw new AgentCoreLambdaTargetError("invalid_event");

    const context = gatewayContext(rawContext);
    if (
      context.bedrockAgentCoreGatewayId !== gatewayId.data ||
      context.bedrockAgentCoreTargetId !== targetId.data ||
      context.bedrockAgentCoreToolName !== expectedToolName
    ) {
      throw new AgentCoreLambdaTargetError("invalid_context");
    }

    let rawResult: unknown;
    try {
      rawResult = await beforeDeadline((signal) => input.source.read({
        requestId: event.data.requestId,
        scopeDigest: event.data.scopeDigest,
        ...event.data.context,
      }, { signal }), timeoutMs);
    } catch (error) {
      if (error instanceof AgentCoreLambdaTargetError && error.code === "source_timeout") {
        throw error;
      }
      throw new AgentCoreLambdaTargetError("source_failed");
    }

    const result = AgentCoreMarketContextSchema.safeParse(rawResult);
    if (!result.success || serializedSize(result.data, "invalid_response") > maxResponseBytes) {
      throw new AgentCoreLambdaTargetError("invalid_response");
    }
    return result.data;
  };
}
