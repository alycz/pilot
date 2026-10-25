import {
  readAgentCoreIdentityAcceptancePreflight,
  type AgentCoreIdentityAcceptanceStatus,
} from "./identity-acceptance";
import {
  createAgentCoreRuntimeOAuthJwtResolverFromEnv,
  type AgentCoreSecretProvider,
} from "./runtime-oauth";
import { createAgentCoreProposalProviderFromEnv } from "./runtime";

type Env = Readonly<Record<string, string | undefined>>;

export type AgentCoreIdentityLiveAcceptanceReport = Readonly<{
  schemaVersion: 1;
  mode: "live";
  provenance: "aws-account-read-only";
  runId: string;
  approvedAt: string;
  region: "us-east-2";
  runtimeInvocations: 1;
  scenario: Readonly<{
    id: "bounded-public-market-read";
    status: AgentCoreIdentityAcceptanceStatus;
  }>;
}>;

export type AgentCoreIdentityNotRunReport = Readonly<{
  schemaVersion: 1;
  mode: "offline";
  provenance: "no-live-transport";
  runtimeInvocations: 0;
  scenario: Readonly<{
    id: "bounded-public-market-read";
    status: "NOT_RUN";
  }>;
}>;

/**
 * Execute exactly one fixed, read-only Runtime request after the existing
 * fresh approval preflight succeeds. No caller prompt, wallet data, token, or
 * response body is included in the returned report.
 */
export async function runAgentCoreIdentityLiveAcceptance(input: Readonly<{
  args?: readonly string[];
  env?: Env;
  now?: () => number;
  secretProvider?: AgentCoreSecretProvider;
  oauthFetch?: typeof fetch;
  runtimeFetch?: typeof fetch;
  jwksFetch?: typeof fetch;
}> = {}): Promise<AgentCoreIdentityLiveAcceptanceReport | AgentCoreIdentityNotRunReport> {
  const env = input.env ?? process.env;
  const args = input.args ?? [];
  const preflight = readAgentCoreIdentityAcceptancePreflight({
    args,
    env,
    ...(input.now ? { now: input.now } : {}),
  });
  if (preflight.mode === "offline") {
    return Object.freeze({
      schemaVersion: 1,
      mode: "offline",
      provenance: "no-live-transport",
      runtimeInvocations: 0,
      scenario: { id: "bounded-public-market-read", status: "NOT_RUN" } as const,
    });
  }
  if (!input.secretProvider) {
    throw new Error("Live identity acceptance requires a server-only secret provider");
  }
  const runtimeJwtResolver = createAgentCoreRuntimeOAuthJwtResolverFromEnv({
    env,
    secretProvider: input.secretProvider,
    ...(input.oauthFetch ? { fetch: input.oauthFetch } : {}),
  });
  const provider = createAgentCoreProposalProviderFromEnv({
    env,
    runtimeJwtResolver,
    scope: {
      tenantId: preflight.runtimeTenantId,
      owner: preflight.acceptanceOwner,
      network: "testnet",
      invocationNonce: `acceptance-${preflight.runId}`,
    },
    ...(input.runtimeFetch ? { fetch: input.runtimeFetch } : {}),
    ...(input.jwksFetch ? { runtimeJwksFetch: input.jwksFetch } : {}),
  });
  if (!provider.enabled || provider.trust.transport !== "aws-agentcore-runtime") {
    throw new Error("Live identity acceptance Runtime is unavailable");
  }
  const result = await provider.propose({
    requestId: `acceptance-${preflight.runId}`,
    purpose: "read",
    prompt: "Read the fixed public XRP/RLUSD Testnet market context.",
    context: {
      pair: "XRP/RLUSD",
      venue: "xrpl-testnet-dex",
      timeframe: "spot",
    },
  });
  if (result.kind !== "read_only") throw new Error("Live identity acceptance returned a non-read result");
  return Object.freeze({
    schemaVersion: 1,
    mode: "live",
    provenance: "aws-account-read-only",
    runId: preflight.runId,
    approvedAt: preflight.approvedAt,
    region: preflight.region,
    runtimeInvocations: 1,
    scenario: { id: "bounded-public-market-read", status: "PASS" } as const,
  });
}

export function serializeAgentCoreIdentityLiveAcceptanceReport(
  report: AgentCoreIdentityLiveAcceptanceReport | AgentCoreIdentityNotRunReport,
): string {
  return JSON.stringify(report);
}
