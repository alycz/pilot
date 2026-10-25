import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createAgentCoreIdentityM2mJwtResolver } from "./identity-sdk";
import type { AgentCoreJwtAlgorithm, AgentCoreJwtPolicy, AgentCoreWorkloadJwtResolver } from "./jwt";
import type { AgentCoreReplayStore } from "./replay";
import { createAwsSdkDynamoDbAgentCoreReplayStore } from "./replay-dynamodb";
import {
  isExactAgentCoreGatewayHost,
  parseAgentCoreAwsRegion,
  type AgentCoreAwsRegion,
} from "./regions";
import {
  startAgentCoreProductionRuntime,
  type AgentCoreProductionRuntimeConfig,
} from "./runtime-production";
import type { AgentCoreRuntimeHttpServer } from "./runtime-http";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CLAIM = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

type Env = Readonly<Record<string, string | undefined>>;

export type AgentCoreRuntimeEnvironment = Readonly<{
  region: AgentCoreAwsRegion;
  resourceCredentialProviderName: string;
  replayTableName: string;
  config: AgentCoreProductionRuntimeConfig;
}>;

function required(env: Env, name: string, maximum = 256): string {
  const value = env[name];
  if (
    value === undefined || value.length < 1 || value.length > maximum || value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} is required and must be a bounded non-secret identifier`);
  }
  return value;
}

function identifier(env: Env, name: string, pattern = NAME): string {
  const value = required(env, name);
  if (!pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function replayTableName(env: Env): string {
  const value = required(env, "AGENTCORE_REPLAY_TABLE", 255);
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(value)) {
    throw new Error("AGENTCORE_REPLAY_TABLE is invalid");
  }
  return value;
}

function replayDeploymentId(env: Env): string {
  const value = required(env, "AGENTCORE_REPLAY_DEPLOYMENT_ID", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)) {
    throw new Error("AGENTCORE_REPLAY_DEPLOYMENT_ID is invalid");
  }
  return value;
}

function exactList(
  env: Env,
  name: string,
  maximum: number,
  accepted?: ReadonlySet<string>,
): readonly string[] {
  const raw = required(env, name, 8_192);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${name} must be a JSON array`);
  }
  if (
    !Array.isArray(value) || value.length < 1 || value.length > maximum ||
    value.some((entry) =>
      typeof entry !== "string" || entry.length < 1 || entry.length > 256 ||
      entry.trim() !== entry || /[\u0000-\u001f\u007f]/.test(entry) ||
      (accepted !== undefined && !accepted.has(entry))
    ) || new Set(value).size !== value.length
  ) {
    throw new Error(`${name} must contain unique bounded values`);
  }
  return Object.freeze([...value] as string[]);
}

function integer(
  env: Env,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function exactGatewayUrl(env: Env, region: AgentCoreAwsRegion): string {
  const raw = required(env, "AGENTCORE_GATEWAY_URL", 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AGENTCORE_GATEWAY_URL must be an exact AgentCore MCP endpoint");
  }
  if (
    url.protocol !== "https:" || !isExactAgentCoreGatewayHost(url.hostname, region) || url.pathname !== "/mcp" ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error(`AGENTCORE_GATEWAY_URL must be an exact ${region} AgentCore MCP endpoint`);
  }
  return url.href;
}

/**
 * Read only non-secret deployment configuration. The Runtime is default-off:
 * it binds a socket only when the operator explicitly selects `aws` and every
 * allowlist/binding is complete.
 */
export function readAgentCoreRuntimeEnvironment(env: Env = process.env): AgentCoreRuntimeEnvironment {
  if ((env.AGENTCORE_RUNTIME_SERVER_MODE?.trim() || "off") !== "aws") {
    throw new Error("AGENTCORE_RUNTIME_SERVER_MODE must be aws to bind the Runtime server");
  }
  if (
    env.AGENTCORE_WORKLOAD_ACCESS_TOKEN !== undefined ||
    env.AGENTCORE_GATEWAY_BEARER_TOKEN !== undefined
  ) {
    throw new Error("Static AgentCore token environment variables are unsupported");
  }
  const region = parseAgentCoreAwsRegion(env.AGENTCORE_AWS_REGION);
  const audiences = exactList(env, "AGENTCORE_GATEWAY_JWT_AUDIENCES_JSON", 8);
  const requiredScopes = exactList(env, "AGENTCORE_GATEWAY_JWT_REQUIRED_SCOPES_JSON", 16);
  const clientClaim = required(env, "AGENTCORE_GATEWAY_JWT_CLIENT_CLAIM");
  if (clientClaim !== "client_id" && clientClaim !== "azp") {
    throw new Error("AGENTCORE_GATEWAY_JWT_CLIENT_CLAIM must be client_id or azp");
  }
  const algorithms = exactList(
    env,
    "AGENTCORE_GATEWAY_JWT_ALGORITHMS_JSON",
    2,
    new Set(["RS256", "ES256"]),
  ) as readonly AgentCoreJwtAlgorithm[];
  const jwtPolicy: AgentCoreJwtPolicy = {
    issuer: required(env, "AGENTCORE_GATEWAY_JWT_ISSUER", 2_048),
    jwksUrl: required(env, "AGENTCORE_GATEWAY_JWT_JWKS_URL", 2_048),
    audiences,
    allowedSubjects: exactList(env, "AGENTCORE_GATEWAY_JWT_ALLOWED_SUBJECTS_JSON", 64),
    allowedClients: exactList(env, "AGENTCORE_GATEWAY_JWT_ALLOWED_CLIENTS_JSON", 16),
    requiredScopes,
    clientClaim,
    tenantClaim: identifier(env, "AGENTCORE_GATEWAY_JWT_TENANT_CLAIM", CLAIM),
    algorithms,
  };
  const replayLeaseMs = integer(env, "AGENTCORE_REPLAY_LEASE_MS", 30_000, 1_000, 120_000);
  const replayRetentionMs = integer(
    env,
    "AGENTCORE_REPLAY_RETENTION_MS",
    86_400_000,
    60_000,
    86_400_000,
  );
  if (replayRetentionMs <= replayLeaseMs) {
    throw new Error("AGENTCORE_REPLAY_RETENTION_MS must exceed AGENTCORE_REPLAY_LEASE_MS");
  }
  return Object.freeze({
    region,
    resourceCredentialProviderName: identifier(
      env,
      "AGENTCORE_IDENTITY_CREDENTIAL_PROVIDER_NAME",
    ),
    replayTableName: replayTableName(env),
    config: Object.freeze({
      gatewayUrl: exactGatewayUrl(env, region),
      gatewayToolName: required(env, "AGENTCORE_GATEWAY_TOOL_NAME"),
      jwtDeploymentTenantId: required(env, "AGENTCORE_GATEWAY_JWT_DEPLOYMENT_TENANT_ID"),
      replayDeploymentId: replayDeploymentId(env),
      replayLeaseMs,
      replayRetentionMs,
      jwtPolicy,
      requestTimeoutMs: integer(env, "AGENTCORE_RUNTIME_REQUEST_TIMEOUT_MS", 30_000, 100, 60_000),
      maxRequestBytes: integer(env, "AGENTCORE_RUNTIME_MAX_REQUEST_BYTES", 65_536, 1_024, 1_048_576),
      maxResponseBytes: integer(env, "AGENTCORE_RUNTIME_MAX_RESPONSE_BYTES", 262_144, 1_024, 1_048_576),
      maxConcurrentRequests: integer(env, "AGENTCORE_RUNTIME_MAX_CONCURRENT_REQUESTS", 1, 1, 32),
    }),
  });
}

export async function startAgentCoreRuntimeFromEnvironment(input: Readonly<{
  env?: Env;
  workloadJwtResolver?: AgentCoreWorkloadJwtResolver;
  replayStore: AgentCoreReplayStore;
  jwksFetch?: typeof fetch;
  gatewayFetch?: typeof fetch;
  now?: () => number;
  /** Test-only listen override. Deployment always uses 0.0.0.0:8080. */
  listen?: Readonly<{ host: string; port: number }>;
}>): Promise<AgentCoreRuntimeHttpServer> {
  const environment = readAgentCoreRuntimeEnvironment(input.env);
  const resolver = input.workloadJwtResolver ?? createAgentCoreIdentityM2mJwtResolver({
    region: environment.region,
    resourceCredentialProviderName: environment.resourceCredentialProviderName,
    scopes: environment.config.jwtPolicy.requiredScopes,
    audiences: environment.config.jwtPolicy.audiences,
    timeoutMs: environment.config.requestTimeoutMs,
  });
  return startAgentCoreProductionRuntime({
    config: environment.config,
    workloadJwtResolver: resolver,
    replayStore: input.replayStore,
    ...(input.jwksFetch ? { jwksFetch: input.jwksFetch } : {}),
    ...(input.gatewayFetch ? { gatewayFetch: input.gatewayFetch } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.listen ? input.listen : {}),
  });
}

export async function runAgentCoreRuntimeMain(
  replayStore?: AgentCoreReplayStore,
): Promise<void> {
  const environment = readAgentCoreRuntimeEnvironment();
  const durableResources = replayStore ? undefined : createAwsSdkDynamoDbAgentCoreReplayStore({
    tableName: environment.replayTableName,
    region: environment.region,
  });
  let runtime: AgentCoreRuntimeHttpServer;
  try {
    runtime = await startAgentCoreRuntimeFromEnvironment({
      replayStore: replayStore ?? durableResources!.replayStore,
    });
  } catch (error) {
    durableResources?.destroy();
    throw error;
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void runtime.close().then(() => {
      durableResources?.destroy();
      process.exitCode = 0;
    }).catch(() => {
      durableResources?.destroy();
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.info("AgentCore Runtime listening on 0.0.0.0:8080");
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void runAgentCoreRuntimeMain().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown configuration error";
    console.error(`AgentCore Runtime failed closed: ${message}`);
    process.exitCode = 1;
  });
}
