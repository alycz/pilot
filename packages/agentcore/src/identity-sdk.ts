import {
  BedrockAgentCoreClient,
  GetResourceOauth2TokenCommand,
  type GetResourceOauth2TokenCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import { z } from "zod";

import {
  AgentCoreJwtError,
  type AgentCoreWorkloadJwtResolver,
} from "./jwt";

const RegionSchema = z.literal("us-east-1");
const NameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const ValueSchema = z.string().min(1).max(256).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "invalid value",
);

export type AgentCoreIdentityM2mConfig = Readonly<{
  region: "us-east-1";
  resourceCredentialProviderName: string;
  scopes: readonly string[];
  audiences: readonly string[];
  timeoutMs?: number;
}>;

type IdentitySender = Readonly<{
  send(
    command: GetResourceOauth2TokenCommand,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<GetResourceOauth2TokenCommandOutput>;
}>;

function exactValues(values: readonly string[], maximum: number): readonly string[] {
  const result = z.array(ValueSchema).min(1).max(maximum).safeParse(values);
  if (!result.success || new Set(result.data).size !== result.data.length) {
    throw new AgentCoreJwtError("configuration");
  }
  return Object.freeze([...result.data]);
}

function exactList(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function token(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 131_072 || /\s/.test(value)) {
    throw new AgentCoreJwtError("authorization");
  }
  return value;
}

/**
 * Exchange the Runtime platform's per-invocation WorkloadAccessToken for one
 * bounded resource token. A service-managed Runtime must not call
 * GetWorkloadAccessToken for itself. The caller must extract this token from
 * the documented AgentCore invocation headers and pass it only on the current
 * resolveAuthorization request; environment/static-token fallback is
 * intentionally absent.
 */
export function createAgentCoreIdentityM2mJwtResolver(
  rawConfig: AgentCoreIdentityM2mConfig,
  dependencies: Readonly<{ client?: IdentitySender }> = {},
): AgentCoreWorkloadJwtResolver {
  const region = RegionSchema.safeParse(rawConfig.region);
  const providerName = NameSchema.safeParse(rawConfig.resourceCredentialProviderName);
  const timeoutMs = rawConfig.timeoutMs ?? 10_000;
  if (
    !region.success || !providerName.success ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000
  ) {
    throw new AgentCoreJwtError("configuration");
  }
  const scopes = exactValues(rawConfig.scopes, 16);
  const audiences = exactValues(rawConfig.audiences, 8);
  const client: IdentitySender = dependencies.client ?? (new BedrockAgentCoreClient({
    region: region.data,
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
  }) as IdentitySender);

  const resolver: AgentCoreWorkloadJwtResolver = {
    async resolveAuthorization(request, options = {}) {
      if (
        !exactList(request.audiences, audiences) ||
        !exactList(request.requiredScopes, scopes) ||
        !ValueSchema.safeParse(request.tenantId).success
      ) {
        throw new AgentCoreJwtError("authorization");
      }
      const workloadIdentityToken = token(request.workloadIdentityToken);
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      try {
        const resource = await client.send(new GetResourceOauth2TokenCommand({
          workloadIdentityToken,
          resourceCredentialProviderName: providerName.data,
          scopes: [...scopes],
          oauth2Flow: "M2M",
          audiences: [...audiences],
        }), { abortSignal: signal });
        if (resource.authorizationUrl || resource.sessionUri || resource.sessionStatus) {
          throw new AgentCoreJwtError("authorization");
        }
        return `Bearer ${token(resource.accessToken)}`;
      } catch (error) {
        if (error instanceof AgentCoreJwtError) throw error;
        throw new AgentCoreJwtError("authorization");
      }
    },
  };
  return Object.freeze(resolver);
}
