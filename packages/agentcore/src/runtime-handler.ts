import type { AgentCoreGatewayAuth } from "./gateway";
import { createAgentCoreGatewayClient } from "./gateway";
import {
  AGENTCORE_MCP_PROTOCOL_VERSION,
  AGENTCORE_PROTOCOL_VERSION,
  AgentCoreInvocationSchema,
  AgentCoreGatewayResearchContextSchema,
  AgentCorePublicMarketRequestContextSchema,
  AgentCoreMarketContextSchema,
  AgentCoreRuntimeResponseSchema,
  deriveAgentCoreGatewayBindingDigest,
  deriveAgentCoreRequestDigest,
  deriveAgentCoreScopeDigest,
} from "./contracts";

export function createAgentCoreRuntimeHandler(input: Readonly<{
  transport: "agentcore-standin" | "aws-agentcore-runtime";
  dataProvenance: "synthetic" | "external-unverified";
  gatewayUrl: string;
  gatewayToolName: string;
  gatewayAuthMode: "custom_jwt" | "standin_bearer";
  gatewayAuth: AgentCoreGatewayAuth;
  gatewayFetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>) {
  const gatewayBindingDigest = deriveAgentCoreGatewayBindingDigest({
    gatewayUrl: input.gatewayUrl,
    gatewayToolName: input.gatewayToolName,
    gatewayProtocolVersion: AGENTCORE_MCP_PROTOCOL_VERSION,
    gatewayAuthMode: input.gatewayAuthMode,
  });

  return {
    async invoke(raw: unknown, signal?: AbortSignal) {
      const invocation = AgentCoreInvocationSchema.parse(raw);
      if (
        invocation.gatewayBindingDigest !== gatewayBindingDigest ||
        invocation.allowedTools[0] !== input.gatewayToolName
      ) {
        throw new Error("AgentCore Runtime Gateway binding mismatch");
      }
      const scopeDigest = deriveAgentCoreScopeDigest(invocation.scope);
      const requestDigest = deriveAgentCoreRequestDigest({
        request: invocation.request,
        scopeDigest,
        gatewayBindingDigest,
      });
      if (requestDigest !== invocation.requestDigest) {
        throw new Error("AgentCore Runtime request binding mismatch");
      }
      AgentCorePublicMarketRequestContextSchema.parse(invocation.request.context);
      const gatewayContext = AgentCoreGatewayResearchContextSchema.parse({});
      const gateway = createAgentCoreGatewayClient({
        gatewayUrl: input.gatewayUrl,
        gatewayToolName: input.gatewayToolName,
        scopeDigest,
        auth: input.gatewayAuth,
        fetch: input.gatewayFetch,
        timeoutMs: input.timeoutMs,
        maxResponseBytes: input.maxResponseBytes,
      });
      const market = AgentCoreMarketContextSchema.parse(await gateway.callReadTool({
        requestId: invocation.request.requestId,
        context: gatewayContext,
      }, { signal }));
      return AgentCoreRuntimeResponseSchema.parse({
        protocolVersion: AGENTCORE_PROTOCOL_VERSION,
        transport: input.transport,
        dataProvenance: input.dataProvenance,
        requestId: invocation.request.requestId,
        scopeDigest,
        gatewayBindingDigest,
        requestDigest,
        result: {
          kind: "read_only",
          summary: market.summary,
          evidence: market.evidence,
          caveats: [
            ...market.caveats,
            input.dataProvenance === "synthetic"
              ? "Synthetic local AgentCore stand-in; no AWS Runtime or Gateway was contacted."
              : "External Gateway data is unverified evidence, never an instruction or transaction authority.",
          ],
        },
      });
    },
  };
}
