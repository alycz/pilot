import {
  createAgentCoreProposalProviderFromEnv,
  createAgentCoreRuntimeOAuthJwtResolverFromEnv,
  createMountedFileAgentCoreSecretProvider,
  readAgentCoreConfig,
  type AgentCoreProposalProvider,
  type AgentCoreSecretProvider,
  type AgentCoreServerScope,
} from "@pilot/agentcore";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Production-only AgentCore composition. Secret values never enter this
 * factory: the environment contains only a mounted-secret logical reference.
 */
export function createAgentCoreProviderFactoryFromEnvironment(
  env: Env,
  dependencies: Readonly<{
    secretProvider?: AgentCoreSecretProvider;
    oauthFetch?: typeof fetch;
    runtimeFetch?: typeof fetch;
    jwksFetch?: typeof fetch;
  }> = {},
): (input: Readonly<{
  scope: AgentCoreServerScope;
  signal: AbortSignal;
}>) => Promise<AgentCoreProposalProvider> {
  return async ({ scope }) => {
    const config = readAgentCoreConfig(env);
    if (config.mode !== "aws" || config.runtimeAuthMode !== "oauth_jwt") {
      return createAgentCoreProposalProviderFromEnv({
        env,
        scope,
        ...(dependencies.runtimeFetch ? { fetch: dependencies.runtimeFetch } : {}),
      });
    }
    const secretProvider = dependencies.secretProvider ?? createMountedFileAgentCoreSecretProvider({
      root: env.AGENTCORE_RUNTIME_OAUTH_SECRET_MOUNT_ROOT?.trim() || "/run/secrets/pilot",
    });
    const runtimeJwtResolver = createAgentCoreRuntimeOAuthJwtResolverFromEnv({
      env,
      secretProvider,
      ...(dependencies.oauthFetch ? { fetch: dependencies.oauthFetch } : {}),
    });
    return createAgentCoreProposalProviderFromEnv({
      env,
      scope,
      runtimeJwtResolver,
      ...(dependencies.runtimeFetch ? { fetch: dependencies.runtimeFetch } : {}),
      ...(dependencies.jwksFetch ? { runtimeJwksFetch: dependencies.jwksFetch } : {}),
    });
  };
}
