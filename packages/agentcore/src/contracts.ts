import { createHash } from "node:crypto";

import {
  ReadOnlyProposalResultSchema,
  type ProposalRequest,
  type ProposalResult,
} from "@pilot/agent/proposal-provider";
import { z } from "zod";

export const AGENTCORE_PROTOCOL_VERSION = "pilot-agentcore.research.v1" as const;
export const AGENTCORE_MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const AGENTCORE_STANDIN_TOOL = "PilotStandin___pilot_read_market_context" as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const SENSITIVE_TEXT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_ -]?key|client[_ -]?secret|private[_ -]?key|recovery[_ -]?phrase|refresh[_ -]?token|secret|seed|session[_ -]?token|signed[_ -]?blob)\b\s*[:=]/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b[0-9a-f]{64}\b/i,
];

function publicText(max: number) {
  return z.string().trim().min(1).max(max).superRefine((value, context) => {
    if (SENSITIVE_TEXT.some((pattern) => pattern.test(value))) {
      context.addIssue({ code: "custom", message: "Sensitive material is not accepted" });
    }
  });
}

export const AgentCoreServerScopeSchema = z
  .object({
    tenantId: IdentifierSchema,
    owner: z.string().trim().min(25).max(35).regex(/^r[1-9A-HJ-NP-Za-km-z]+$/),
    network: z.enum(["testnet", "devnet", "lending-devnet"]),
    invocationNonce: IdentifierSchema,
  })
  .strict();

export type AgentCoreServerScope = z.infer<typeof AgentCoreServerScopeSchema>;

export const AgentCoreGatewayToolNameSchema = z
  .string()
  .min(5)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+___[A-Za-z0-9_.-]+$/);

export const AgentCoreResearchContextSchema = z
  .object({
    pair: z.string().trim().min(3).max(32).regex(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/).optional(),
    venue: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
    timeframe: z.enum(["spot", "1h", "1d", "7d", "30d"]).optional(),
  })
  .strict();

export const AgentCoreResearchRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    purpose: z.literal("read"),
    prompt: publicText(4_000),
    context: AgentCoreResearchContextSchema,
  })
  .strict();

export const AgentCoreMarketContextSchema = z
  .object({
    summary: publicText(2_000),
    evidence: z.array(z.object({
      source: publicText(200),
      claim: publicText(500),
      freshness: z.string().datetime({ offset: true }).optional(),
    }).strict()).max(12).default([]),
    caveats: z.array(publicText(500)).max(12).default([]),
  })
  .strict();

export function deriveAgentCoreScopeDigest(scope: AgentCoreServerScope): string {
  return createHash("sha256")
    .update(JSON.stringify(AgentCoreServerScopeSchema.parse(scope)), "utf8")
    .digest("hex");
}

export function deriveAgentCoreGatewayBindingDigest(input: Readonly<{
  gatewayUrl: string;
  gatewayToolName: string;
  gatewayProtocolVersion: string;
  gatewayAuthMode: "custom_jwt" | "standin_bearer";
}>): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

export function deriveAgentCoreRequestDigest(input: Readonly<{
  request: ProposalRequest;
  scopeDigest: string;
  gatewayBindingDigest: string;
}>): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

export const AgentCoreInvocationSchema = z
  .object({
    protocolVersion: z.literal(AGENTCORE_PROTOCOL_VERSION),
    request: AgentCoreResearchRequestSchema,
    scope: AgentCoreServerScopeSchema,
    allowedTools: z.tuple([AgentCoreGatewayToolNameSchema]),
    gatewayBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type AgentCoreInvocation = z.infer<typeof AgentCoreInvocationSchema>;

export const AgentCoreRuntimeResponseSchema = z
  .object({
    protocolVersion: z.literal(AGENTCORE_PROTOCOL_VERSION),
    transport: z.enum(["agentcore-standin", "aws-agentcore-runtime"]),
    dataProvenance: z.enum(["synthetic", "external-unverified"]),
    requestId: IdentifierSchema,
    scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    gatewayBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    result: ReadOnlyProposalResultSchema,
  })
  .strict();

export const AgentCoreGatewayArgumentsSchema = z
  .object({
    requestId: IdentifierSchema,
    scope: AgentCoreServerScopeSchema,
    prompt: publicText(4_000),
    context: AgentCoreResearchContextSchema,
  })
  .strict();

export type AgentCoreGatewayArguments = z.infer<typeof AgentCoreGatewayArgumentsSchema>;

const JsonRpcIdSchema = z.union([z.string().max(128), z.number().int().nonnegative()]);

export const AgentCoreGatewayCallSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    method: z.literal("tools/call"),
    params: z
      .object({
        name: AgentCoreGatewayToolNameSchema,
        arguments: AgentCoreGatewayArgumentsSchema,
      })
      .strict(),
  })
  .strict();

export const AgentCoreGatewayResultSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    result: z
      .object({
        content: z.array(z.object({
          type: z.literal("text"),
          text: z.string().max(64 * 1024),
        }).strict()).min(1).max(8),
        structuredContent: AgentCoreMarketContextSchema,
        isError: z.literal(false).optional(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

export const AgentCoreGatewayErrorSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema.nullable(),
    error: z.object({
      code: z.number().int(),
      message: z.string().max(500),
    }).passthrough(),
  })
  .strict();

export interface AgentCoreScopedToolInvoker {
  invoke(input: Readonly<{
    name: string;
    requestId: string;
    scope: AgentCoreServerScope;
    prompt: string;
    context: z.infer<typeof AgentCoreResearchContextSchema>;
    signal?: AbortSignal;
  }>): Promise<unknown>;
}

export type { ProposalRequest, ProposalResult };
