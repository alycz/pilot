import { z } from "zod";

import type { AgentCoreGatewayAuth } from "./gateway";

const IdentityRequestSchema = z
  .object({
    providerName: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    flow: z.enum(["M2M", "USER_FEDERATION", "ON_BEHALF_OF_TOKEN_EXCHANGE"]),
    allowedScopes: z.array(z.string().min(1).max(256)).min(1).max(16),
    scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type AgentCoreIdentityRequest = z.infer<typeof IdentityRequestSchema>;

export type AgentCoreIdentityResolution =
  | Readonly<{ status: "authorized"; authorization: string; expiresAt: string }>
  | Readonly<{
      status: "authorization_required";
      providerName: string;
      allowedScopes: readonly string[];
    }>;

/**
 * Server-only seam for future AgentCore Identity data-plane integration.
 * Implementations may obtain a short-lived token, but it is handed directly to
 * the Gateway transport and never serialized into model context or receipts.
 * Provider/grant creation is deliberately absent from this package.
 */
export interface AgentCoreIdentityResolver {
  resolve(
    request: AgentCoreIdentityRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentCoreIdentityResolution>;
}

export function createIdentityGatewayAuth(
  resolver: AgentCoreIdentityResolver,
  rawRequest: AgentCoreIdentityRequest,
): AgentCoreGatewayAuth {
  const request = IdentityRequestSchema.parse(rawRequest);
  return {
    async authorization(signal) {
      let resolution: AgentCoreIdentityResolution;
      try {
        resolution = await resolver.resolve(request, { signal });
      } catch {
        throw new Error("AgentCore Identity authorization is unavailable");
      }
      if (resolution.status !== "authorized") {
        throw new Error("AgentCore Gateway authorization is required");
      }
      if (!/^Bearer [^\s]+$/.test(resolution.authorization)) {
        throw new Error("AgentCore Identity returned invalid authorization");
      }
      const expiry = Date.parse(resolution.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.now()) {
        throw new Error("AgentCore Identity authorization is expired");
      }
      return resolution.authorization;
    },
  };
}
