import {
  AGENTCORE_MCP_PROTOCOL_VERSION,
  AgentCoreGatewayToolNameSchema,
  AgentCoreInvocationSchema,
  AgentCoreRuntimeResponseSchema,
  AgentCoreServerScopeSchema,
  deriveAgentCoreGatewayBindingDigest,
  deriveAgentCoreRequestDigest,
  deriveAgentCoreScopeDigest,
} from "./contracts";
import {
  createAgentCoreJwtVerifier,
  createVerifiedJwtGatewayAuth,
  type AgentCoreJwtPolicy,
  type AgentCoreTokenRevocationChecker,
  type AgentCoreWorkloadJwtResolver,
} from "./jwt";
import { createAgentCoreRuntimeHandler } from "./runtime-handler";
import {
  AgentCoreReplayError,
  deriveAgentCoreReplayBinding,
  deriveAgentCoreReplayNamespace,
  validateAgentCoreReplayDurations,
  type AgentCoreReplayStore,
  type AgentCoreRuntimeResponse,
} from "./replay";
import {
  startAgentCoreRuntimeHttpServer,
  type AgentCoreRuntimeInvocationContext,
  type AgentCoreRuntimeHttpServer,
  type AgentCoreRuntimeInvoker,
} from "./runtime-http";

export type AgentCoreProductionRuntimeConfig = Readonly<{
  gatewayUrl: string;
  gatewayToolName: string;
  jwtDeploymentTenantId: string;
  replayDeploymentId: string;
  replayLeaseMs: number;
  replayRetentionMs: number;
  jwtPolicy: AgentCoreJwtPolicy;
  requestTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxConcurrentRequests?: number;
}>;

/**
 * Compose the production Runtime-to-Gateway path without embedding a token.
 * Account-specific token acquisition is a required injected dependency. Every
 * acquired token is verified against the exact tenant before it reaches the
 * Gateway transport.
 */
export function createAgentCoreProductionRuntimeInvoker(input: Readonly<{
  config: AgentCoreProductionRuntimeConfig;
  workloadJwtResolver: AgentCoreWorkloadJwtResolver;
  replayStore: AgentCoreReplayStore;
  jwksFetch?: typeof fetch;
  gatewayFetch?: typeof fetch;
  now?: () => number;
  jwtRevocationChecker?: AgentCoreTokenRevocationChecker;
}>): AgentCoreRuntimeInvoker {
  const gatewayToolName = AgentCoreGatewayToolNameSchema.parse(input.config.gatewayToolName);
  const jwtDeploymentTenantId = AgentCoreServerScopeSchema.shape.tenantId.parse(
    input.config.jwtDeploymentTenantId,
  );
  const verifier = createAgentCoreJwtVerifier(input.config.jwtPolicy, {
    ...(input.jwksFetch ? { fetch: input.jwksFetch } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.jwtRevocationChecker
      ? { revocationChecker: input.jwtRevocationChecker }
      : {}),
  });
  validateAgentCoreReplayDurations({
    leaseMs: input.config.replayLeaseMs,
    retentionMs: input.config.replayRetentionMs,
  });
  const replayNamespace = deriveAgentCoreReplayNamespace({
    deploymentId: input.config.replayDeploymentId,
    tenantId: jwtDeploymentTenantId,
  });
  const now = input.now ?? Date.now;

  const validateReplay = (
    value: unknown,
    expected: Readonly<{
      requestId: string;
      requestDigest: string;
      scopeDigest: string;
      gatewayBindingDigest: string;
    }>,
  ): AgentCoreRuntimeResponse => {
    const parsed = AgentCoreRuntimeResponseSchema.safeParse(value);
    if (
      !parsed.success || parsed.data.transport !== "aws-agentcore-runtime" ||
      parsed.data.dataProvenance !== "external-unverified" ||
      parsed.data.requestId !== expected.requestId ||
      parsed.data.requestDigest !== expected.requestDigest ||
      parsed.data.scopeDigest !== expected.scopeDigest ||
      parsed.data.gatewayBindingDigest !== expected.gatewayBindingDigest
    ) {
      throw new AgentCoreReplayError("binding");
    }
    return parsed.data;
  };

  return Object.freeze({
    async invoke(raw: unknown, context: AgentCoreRuntimeInvocationContext) {
      const invocation = AgentCoreInvocationSchema.parse(raw);
      const gatewayBindingDigest = deriveAgentCoreGatewayBindingDigest({
        gatewayUrl: input.config.gatewayUrl,
        gatewayToolName,
        gatewayProtocolVersion: AGENTCORE_MCP_PROTOCOL_VERSION,
        gatewayAuthMode: "custom_jwt",
      });
      const scopeDigest = deriveAgentCoreScopeDigest(invocation.scope);
      const requestDigest = deriveAgentCoreRequestDigest({
        request: invocation.request,
        scopeDigest,
        gatewayBindingDigest,
      });
      if (
        invocation.gatewayBindingDigest !== gatewayBindingDigest ||
        invocation.allowedTools[0] !== gatewayToolName ||
        invocation.requestDigest !== requestDigest
      ) {
        throw new AgentCoreReplayError("binding");
      }
      const replayBinding = deriveAgentCoreReplayBinding({
        requestDigest,
        scopeDigest,
        gatewayBindingDigest,
      });
      const gatewayAuth = createVerifiedJwtGatewayAuth({
        resolver: input.workloadJwtResolver,
        verifier,
        tenantId: jwtDeploymentTenantId,
        workloadIdentityToken: context.workloadAccessToken,
      });
      // Authenticate every invocation, including cache hits. A syntactically
      // valid WorkloadAccessToken must never be enough to read a replay.
      const authorization = await gatewayAuth.authorization(context.signal);
      const handler = createAgentCoreRuntimeHandler({
        transport: "aws-agentcore-runtime",
        dataProvenance: "external-unverified",
        gatewayUrl: input.config.gatewayUrl,
        gatewayToolName,
        gatewayAuthMode: "custom_jwt",
        gatewayAuth: { async authorization() { return authorization; } },
        ...(input.gatewayFetch ? { gatewayFetch: input.gatewayFetch } : {}),
        ...(input.config.requestTimeoutMs ? { timeoutMs: input.config.requestTimeoutMs } : {}),
        ...(input.config.maxResponseBytes ? { maxResponseBytes: input.config.maxResponseBytes } : {}),
      });
      const claim = await input.replayStore.claim({
        namespaceDigest: replayNamespace,
        requestDigest,
        bindingDigest: replayBinding,
        nowMs: now(),
        leaseMs: input.config.replayLeaseMs,
        retentionMs: input.config.replayRetentionMs,
        signal: context.signal,
      });
      const expected = {
        requestId: invocation.request.requestId,
        requestDigest,
        scopeDigest,
        gatewayBindingDigest,
      } as const;
      if (claim.status === "completed") return validateReplay(claim.response, expected);
      if (claim.status === "busy") throw new AgentCoreReplayError("busy");
      if (claim.status === "uncertain") throw new AgentCoreReplayError("uncertain");

      const lease = {
        namespaceDigest: replayNamespace,
        requestDigest,
        bindingDigest: replayBinding,
        leaseId: claim.leaseId,
        fence: claim.fence,
      } as const;
      if (context.signal.aborted) {
        await input.replayStore.releaseClaim({
          ...lease,
          nowMs: now(),
          retentionMs: input.config.replayRetentionMs,
          signal: AbortSignal.timeout(1_000),
        });
        throw context.signal.reason ?? new AgentCoreReplayError("fenced");
      }

      // This conditional transition is the last operation before dispatch.
      // If its outcome is unknown, never call the Gateway and never release the
      // claim: the store will either fence/take over an expired claim or report
      // a terminal dispatched-without-result outcome.
      await input.replayStore.markDispatched({
        ...lease,
        nowMs: now(),
        retentionMs: input.config.replayRetentionMs,
        signal: context.signal,
      });
      const response = validateReplay(
        await handler.invoke(invocation, context.signal),
        expected,
      );
      await input.replayStore.complete({
        ...lease,
        response,
        nowMs: now(),
        retentionMs: input.config.replayRetentionMs,
        // The external call succeeded. Persist completion even if the caller
        // disconnected at that boundary so a retry can recover the one result.
        signal: AbortSignal.timeout(1_000),
      });
      return response;
    },
  });
}

export async function startAgentCoreProductionRuntime(input: Readonly<{
  config: AgentCoreProductionRuntimeConfig;
  workloadJwtResolver: AgentCoreWorkloadJwtResolver;
  replayStore: AgentCoreReplayStore;
  jwksFetch?: typeof fetch;
  gatewayFetch?: typeof fetch;
  now?: () => number;
  host?: string;
  port?: number;
}>): Promise<AgentCoreRuntimeHttpServer> {
  return startAgentCoreRuntimeHttpServer({
    handler: createAgentCoreProductionRuntimeInvoker(input),
    ...(input.host ? { host: input.host } : {}),
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.config.requestTimeoutMs ? { requestTimeoutMs: input.config.requestTimeoutMs } : {}),
    ...(input.config.maxRequestBytes ? { maxRequestBytes: input.config.maxRequestBytes } : {}),
    ...(input.config.maxResponseBytes ? { maxResponseBytes: input.config.maxResponseBytes } : {}),
    ...(input.config.maxConcurrentRequests
      ? { maxConcurrentRequests: input.config.maxConcurrentRequests }
      : {}),
  });
}
