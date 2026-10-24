import {
  GetResourceOauth2TokenCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { describe, expect, it, vi } from "vitest";

import { createAgentCoreIdentityM2mJwtResolver } from "../src/identity-sdk";

const config = {
  region: "us-east-1",
  resourceCredentialProviderName: "pilot-gateway-jwt",
  scopes: ["gateway:invoke"],
  audiences: ["pilot-agentcore-gateway"],
} as const;

describe("AgentCore Identity M2M resolver", () => {
  it("exchanges the platform-injected workload token for one bounded resource token", async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetResourceOauth2TokenCommand);
      expect((command as GetResourceOauth2TokenCommand).input).toEqual({
        workloadIdentityToken: "opaque-workload-token",
        resourceCredentialProviderName: "pilot-gateway-jwt",
        scopes: ["gateway:invoke"],
        oauth2Flow: "M2M",
        audiences: ["pilot-agentcore-gateway"],
      });
      return { accessToken: "header.payload.signature" };
    });
    const resolver = createAgentCoreIdentityM2mJwtResolver(config, {
      client: { send } as never,
    });
    await expect(resolver.resolveAuthorization({
      tenantId: "pilot-runtime-deployment",
      audiences: ["pilot-agentcore-gateway"],
      requiredScopes: ["gateway:invoke"],
      workloadIdentityToken: "opaque-workload-token",
    })).resolves.toBe("Bearer header.payload.signature");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails before AWS when requested audience or scopes escape configuration", async () => {
    const send = vi.fn();
    const resolver = createAgentCoreIdentityM2mJwtResolver(config, {
      client: { send } as never,
    });
    await expect(resolver.resolveAuthorization({
      tenantId: "pilot-runtime-deployment",
      audiences: ["another-audience"],
      requiredScopes: ["gateway:invoke"],
      workloadIdentityToken: "opaque-workload-token",
    })).rejects.toMatchObject({ code: "authorization" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { authorizationUrl: "https://identity.example/authorize" },
    { sessionUri: "opaque-session", sessionStatus: "IN_PROGRESS" },
    { accessToken: undefined },
  ])("fails closed on missing tokens or interactive authorization", async (resource) => {
    const send = vi.fn().mockResolvedValueOnce(resource);
    const resolver = createAgentCoreIdentityM2mJwtResolver(config, {
      client: { send } as never,
    });
    await expect(resolver.resolveAuthorization({
      tenantId: "pilot-runtime-deployment",
      audiences: ["pilot-agentcore-gateway"],
      requiredScopes: ["gateway:invoke"],
      workloadIdentityToken: "opaque-workload-token",
    })).rejects.toMatchObject({
      code: "authorization",
      message: "AgentCore workload authorization is invalid",
    });
  });

  it("refuses an invocation without the platform-injected workload token", async () => {
    const resolver = createAgentCoreIdentityM2mJwtResolver(config, {
      client: { send: vi.fn() } as never,
    });
    await expect(resolver.resolveAuthorization({
      tenantId: "pilot-runtime-deployment",
      audiences: ["pilot-agentcore-gateway"],
      requiredScopes: ["gateway:invoke"],
    })).rejects.toMatchObject({
      code: "authorization",
      message: "AgentCore workload authorization is invalid",
    });
  });
});
