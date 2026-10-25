import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createProvider,
  createResolver,
  createSecretProvider,
  readConfig,
} = vi.hoisted(() => ({
  createProvider: vi.fn(() => ({
    enabled: true,
    trust: { transport: "aws-agentcore-runtime", localStandin: false, runtimeAuthMode: "oauth_jwt" },
    propose: vi.fn(),
  })),
  createResolver: vi.fn(() => ({ resolveAuthorization: vi.fn() })),
  createSecretProvider: vi.fn(() => ({ resolveSecret: vi.fn() })),
  readConfig: vi.fn(),
}));

vi.mock("@pilot/agentcore", () => ({
  createAgentCoreProposalProviderFromEnv: createProvider,
  createAgentCoreRuntimeOAuthJwtResolverFromEnv: createResolver,
  createMountedFileAgentCoreSecretProvider: createSecretProvider,
  readAgentCoreConfig: readConfig,
}));

import { createAgentCoreProviderFactoryFromEnvironment } from "./agentcore-runtime";

const scope = {
  tenantId: "pilot-deployment",
  owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  network: "testnet" as const,
  invocationNonce: "request-1",
};

describe("production AgentCore provider composition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("composes OAuth through the server-only secret provider for AWS oauth_jwt mode", async () => {
    readConfig.mockReturnValue({ mode: "aws", runtimeAuthMode: "oauth_jwt" });
    const env = { AGENTCORE_RUNTIME_OAUTH_SECRET_MOUNT_ROOT: "/run/secrets/pilot" };
    const factory = createAgentCoreProviderFactoryFromEnvironment(env);
    await expect(factory({ scope, signal: new AbortController().signal })).resolves.toMatchObject({ enabled: true });
    expect(createSecretProvider).toHaveBeenCalledWith({ root: "/run/secrets/pilot" });
    expect(createResolver).toHaveBeenCalledWith(expect.objectContaining({
      env,
      secretProvider: expect.objectContaining({ resolveSecret: expect.any(Function) }),
    }));
    expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({
      env,
      scope,
      runtimeJwtResolver: expect.objectContaining({ resolveAuthorization: expect.any(Function) }),
    }));
  });

  it("does not construct or read a secret provider when AgentCore is off", async () => {
    readConfig.mockReturnValue({ mode: "off" });
    const factory = createAgentCoreProviderFactoryFromEnvironment({ AGENTCORE_MODE: "off" });
    await factory({ scope, signal: new AbortController().signal });
    expect(createSecretProvider).not.toHaveBeenCalled();
    expect(createResolver).not.toHaveBeenCalled();
    expect(createProvider).toHaveBeenCalledWith({ env: { AGENTCORE_MODE: "off" }, scope });
  });
});
