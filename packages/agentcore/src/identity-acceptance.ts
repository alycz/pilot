import { isIP } from "node:net";

import {
  AgentCoreRuntimeQualifierSchema,
  isExactAgentCoreRuntimeArn,
} from "./config";

export const AGENTCORE_IDENTITY_LIVE_APPROVAL_MARKER =
  "I_APPROVE_ONE_BOUNDED_AGENTCORE_IDENTITY_READ_ONLY_RUN" as const;

export type AgentCoreIdentityAcceptanceStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

export type AgentCoreIdentityAcceptanceReport = Readonly<{
  schemaVersion: 1;
  mode: "offline";
  provenance: "synthetic-local-fixture";
  awsCalls: 0;
  scenarios: readonly Readonly<{
    id: string;
    status: AgentCoreIdentityAcceptanceStatus;
  }>[];
}>;

export type AgentCoreIdentityLivePreflight = Readonly<{
  mode: "live-preflight";
  runId: string;
  approvedAt: string;
  region: "us-east-2";
  runtimeArn: string;
  runtimeQualifier: string;
  runtimeAuthMode: "oauth_jwt";
  runtimeIssuer: string;
  runtimeJwksUrl: string;
  runtimeAudiences: readonly string[];
  runtimeAllowedSubjects: readonly string[];
  runtimeAllowedClients: readonly string[];
  runtimeRequiredScopes: readonly string[];
  runtimeClientClaim: "client_id";
  runtimeTenantClaim: string;
  runtimeTenantId: string;
  runtimeAlgorithms: readonly string[];
  runtimeClockToleranceSeconds: number;
  runtimeMaxTokenAgeSeconds: number;
  runtimeMaxTokenLifetimeSeconds: number;
  runtimeJwksCacheTtlMs: number;
  runtimeJwksRefreshCooldownMs: number;
  runtimeRevocationMode: "expiry_only" | "checker";
  gatewayUrl: string;
  gatewayToolName: string;
  resourceCredentialProviderName: string;
  issuer: string;
  jwksUrl: string;
  audiences: readonly string[];
  allowedSubjects: readonly string[];
  allowedClients: readonly string[];
  requiredScopes: readonly string[];
  clientClaim: "client_id" | "azp";
  tenantClaim: string;
  deploymentTenantId: string;
  gatewayAlgorithms: readonly string[];
  gatewayClockToleranceSeconds: number;
  gatewayMaxTokenAgeSeconds: number;
  gatewayMaxTokenLifetimeSeconds: number;
  gatewayJwksCacheTtlMs: number;
  gatewayJwksRefreshCooldownMs: number;
  gatewayRevocationMode: "expiry_only" | "checker";
  replayTableName: string;
  replayDeploymentId: string;
}>;

export type AgentCoreIdentityAcceptancePreflight =
  | Readonly<{
      mode: "offline";
      provenance: "synthetic-local-fixture";
      awsCalls: 0;
    }>
  | AgentCoreIdentityLivePreflight;

type Env = Readonly<Record<string, string | undefined>>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CLAIM = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const GATEWAY_HOST = /^[0-9a-z](?:[0-9a-z-]{0,98}[0-9a-z])?-[0-9a-z]{10}\.gateway\.bedrock-agentcore\.us-east-2\.amazonaws\.com$/;
const FORBIDDEN_STATIC_TOKEN_ENV = [
  "AGENTCORE_WORKLOAD_ACCESS_TOKEN",
  "AGENTCORE_GATEWAY_BEARER_TOKEN",
  "AGENTCORE_RUNTIME_BEARER_TOKEN",
  "AGENTCORE_RUNTIME_INBOUND_JWT",
  "AGENTCORE_RUNTIME_ACCESS_TOKEN",
  "AGENTCORE_RUNTIME_JWT_TOKEN",
  "AGENTCORE_RUNTIME_OAUTH_TOKEN",
] as const;
const LIVE_APPROVAL_MAX_AGE_MS = 10 * 60 * 1_000;

function required(env: Env, name: string, maximum = 2_048): string {
  const value = env[name];
  if (
    value === undefined || value.length < 1 || value.length > maximum || value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} is required and must be a bounded non-secret value`);
  }
  return value;
}

function identifier(env: Env, name: string, pattern = IDENTIFIER, maximum = 256): string {
  const value = required(env, name, maximum);
  if (!pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function exactList(env: Env, name: string, maximum: number): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(required(env, name, 8_192)) as unknown;
  } catch {
    throw new Error(`${name} must be a JSON array`);
  }
  if (
    !Array.isArray(value) || value.length < 1 || value.length > maximum ||
    value.some((entry) =>
      typeof entry !== "string" || entry.length < 1 || entry.length > 256 ||
      entry.trim() !== entry || /[\u0000-\u001f\u007f]/.test(entry)
    ) || new Set(value).size !== value.length
  ) {
    throw new Error(`${name} must contain unique bounded values`);
  }
  return Object.freeze([...value] as string[]);
}

function boundedInteger(env: Env, name: string, minimum: number, maximum: number): number {
  const raw = required(env, name, 16);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function exactHttpsUrl(raw: string, name: string): URL {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error(`${name} must be an exact HTTPS URL`);
  }
  if (
    value.protocol !== "https:" || value.username || value.password || value.search || value.hash ||
    value.hostname === "localhost" || value.hostname.endsWith(".localhost") || isIP(value.hostname) !== 0
  ) {
    throw new Error(`${name} must be an exact public HTTPS URL`);
  }
  return value;
}

function assertNoStaticToken(env: Env): void {
  const forbidden = FORBIDDEN_STATIC_TOKEN_ENV.find((name) => env[name] !== undefined);
  if (forbidden) throw new Error(`${forbidden} is unsupported by identity acceptance`);
}

function liveGatewayUrl(env: Env): string {
  const raw = required(env, "AGENTCORE_GATEWAY_URL");
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error("AGENTCORE_GATEWAY_URL must be the exact us-east-2 MCP endpoint");
  }
  if (
    value.protocol !== "https:" || !GATEWAY_HOST.test(value.hostname) || value.pathname !== "/mcp" ||
    value.username || value.password || value.search || value.hash
  ) {
    throw new Error("AGENTCORE_GATEWAY_URL must be the exact us-east-2 MCP endpoint");
  }
  return value.href;
}

/**
 * Parse only non-secret acceptance configuration. This function never creates a
 * client or performs I/O. A future live runner must call it before dynamically
 * loading any transport and must not accept static token values.
 */
export function readAgentCoreIdentityAcceptancePreflight(input: Readonly<{
  args?: readonly string[];
  env?: Env;
  now?: () => number;
}> = {}): AgentCoreIdentityAcceptancePreflight {
  const args = input.args ?? [];
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now;
  assertNoStaticToken(env);

  const liveRequested = args.length === 1 && args[0] === "--live";
  const offlineRequested = args.length === 0 || (args.length === 1 && args[0] === "--offline");
  if (!liveRequested && !offlineRequested) {
    throw new Error("Identity acceptance accepts only --offline or --live");
  }
  const requestedMode = env.AGENTCORE_IDENTITY_ACCEPTANCE_MODE?.trim() || "offline";
  if (!liveRequested) {
    if (requestedMode !== "offline") {
      throw new Error("Offline identity acceptance requires AGENTCORE_IDENTITY_ACCEPTANCE_MODE=offline");
    }
    return Object.freeze({
      mode: "offline",
      provenance: "synthetic-local-fixture",
      awsCalls: 0,
    });
  }

  if (requestedMode !== "live") {
    throw new Error("Live identity acceptance requires AGENTCORE_IDENTITY_ACCEPTANCE_MODE=live");
  }
  if (env.AGENTCORE_IDENTITY_LIVE_APPROVAL !== AGENTCORE_IDENTITY_LIVE_APPROVAL_MARKER) {
    throw new Error("Live identity acceptance requires the exact approval marker");
  }
  const runId = required(env, "AGENTCORE_IDENTITY_ACCEPTANCE_RUN_ID", 36);
  if (!UUID_V4.test(runId)) throw new Error("AGENTCORE_IDENTITY_ACCEPTANCE_RUN_ID must be a UUID v4");
  const approvedAt = required(env, "AGENTCORE_IDENTITY_ACCEPTANCE_APPROVED_AT", 24);
  const approvedAtMs = Date.parse(approvedAt);
  const current = now();
  if (
    !Number.isFinite(approvedAtMs) || new Date(approvedAtMs).toISOString() !== approvedAt ||
    approvedAtMs > current || current - approvedAtMs > LIVE_APPROVAL_MAX_AGE_MS
  ) {
    throw new Error("AGENTCORE_IDENTITY_ACCEPTANCE_APPROVED_AT must be a fresh canonical timestamp");
  }
  if (required(env, "AGENTCORE_AWS_REGION", 9) !== "us-east-2") {
    throw new Error("Live identity acceptance is restricted to us-east-2");
  }
  const runtimeArn = required(env, "AGENTCORE_RUNTIME_ARN");
  if (!isExactAgentCoreRuntimeArn(runtimeArn, "us-east-2")) {
    throw new Error("AGENTCORE_RUNTIME_ARN is invalid");
  }
  const runtimeQualifierResult = AgentCoreRuntimeQualifierSchema.safeParse(
    required(env, "AGENTCORE_RUNTIME_QUALIFIER", 48),
  );
  if (!runtimeQualifierResult.success) {
    throw new Error("AGENTCORE_RUNTIME_QUALIFIER is invalid");
  }
  if (required(env, "AGENTCORE_RUNTIME_AUTH_MODE", 9) !== "oauth_jwt") {
    throw new Error("Live identity acceptance requires the documented oauth_jwt inbound path");
  }
  const runtimeIssuer = exactHttpsUrl(required(env, "AGENTCORE_RUNTIME_JWT_ISSUER"), "AGENTCORE_RUNTIME_JWT_ISSUER");
  const runtimeJwksUrl = exactHttpsUrl(required(env, "AGENTCORE_RUNTIME_JWT_JWKS_URL"), "AGENTCORE_RUNTIME_JWT_JWKS_URL");
  if (runtimeIssuer.origin !== runtimeJwksUrl.origin) {
    throw new Error("AGENTCORE_RUNTIME_JWT_JWKS_URL must share the issuer origin");
  }
  if (required(env, "AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM", 9) !== "client_id") {
    throw new Error("AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM must be client_id");
  }
  const runtimeRevocationMode = required(env, "AGENTCORE_RUNTIME_JWT_REVOCATION_MODE", 16);
  if (runtimeRevocationMode !== "expiry_only" && runtimeRevocationMode !== "checker") {
    throw new Error("AGENTCORE_RUNTIME_JWT_REVOCATION_MODE must be expiry_only or checker");
  }
  if (runtimeRevocationMode === "checker") {
    boundedInteger(env, "AGENTCORE_RUNTIME_JWT_REVOCATION_TIMEOUT_MS", 50, 5_000);
  } else if (env.AGENTCORE_RUNTIME_JWT_REVOCATION_TIMEOUT_MS !== undefined) {
    throw new Error("AGENTCORE_RUNTIME_JWT_REVOCATION_TIMEOUT_MS is valid only in checker mode");
  }
  const issuer = exactHttpsUrl(required(env, "AGENTCORE_GATEWAY_JWT_ISSUER"), "AGENTCORE_GATEWAY_JWT_ISSUER");
  const jwksUrl = exactHttpsUrl(required(env, "AGENTCORE_GATEWAY_JWT_JWKS_URL"), "AGENTCORE_GATEWAY_JWT_JWKS_URL");
  if (issuer.origin !== jwksUrl.origin) {
    throw new Error("AGENTCORE_GATEWAY_JWT_JWKS_URL must share the issuer origin");
  }
  const clientClaim = required(env, "AGENTCORE_GATEWAY_JWT_CLIENT_CLAIM", 9);
  if (clientClaim !== "client_id" && clientClaim !== "azp") {
    throw new Error("AGENTCORE_GATEWAY_JWT_CLIENT_CLAIM must be client_id or azp");
  }
  const runtimeAlgorithms = exactList(env, "AGENTCORE_RUNTIME_JWT_ALGORITHMS_JSON", 2);
  const gatewayAlgorithms = exactList(env, "AGENTCORE_GATEWAY_JWT_ALGORITHMS_JSON", 2);
  if ([...runtimeAlgorithms, ...gatewayAlgorithms].some((value) => value !== "RS256" && value !== "ES256")) {
    throw new Error("AgentCore JWT algorithms must be RS256 or ES256");
  }
  const gatewayRevocationMode = required(env, "AGENTCORE_GATEWAY_JWT_REVOCATION_MODE", 16);
  if (gatewayRevocationMode !== "expiry_only" && gatewayRevocationMode !== "checker") {
    throw new Error("AGENTCORE_GATEWAY_JWT_REVOCATION_MODE must be expiry_only or checker");
  }
  if (gatewayRevocationMode === "checker") {
    boundedInteger(env, "AGENTCORE_GATEWAY_JWT_REVOCATION_TIMEOUT_MS", 50, 5_000);
  } else if (env.AGENTCORE_GATEWAY_JWT_REVOCATION_TIMEOUT_MS !== undefined) {
    throw new Error("AGENTCORE_GATEWAY_JWT_REVOCATION_TIMEOUT_MS is valid only in checker mode");
  }

  return Object.freeze({
    mode: "live-preflight",
    runId,
    approvedAt,
    region: "us-east-2",
    runtimeArn,
    runtimeQualifier: runtimeQualifierResult.data,
    runtimeAuthMode: "oauth_jwt",
    runtimeIssuer: runtimeIssuer.href,
    runtimeJwksUrl: runtimeJwksUrl.href,
    runtimeAudiences: exactList(env, "AGENTCORE_RUNTIME_JWT_AUDIENCES_JSON", 1),
    runtimeAllowedSubjects: exactList(env, "AGENTCORE_RUNTIME_JWT_ALLOWED_SUBJECTS_JSON", 1),
    runtimeAllowedClients: exactList(env, "AGENTCORE_RUNTIME_JWT_ALLOWED_CLIENTS_JSON", 1),
    runtimeRequiredScopes: exactList(env, "AGENTCORE_RUNTIME_JWT_REQUIRED_SCOPES_JSON", 1),
    runtimeClientClaim: "client_id",
    runtimeTenantClaim: identifier(env, "AGENTCORE_RUNTIME_JWT_TENANT_CLAIM", CLAIM, 128),
    runtimeTenantId: identifier(env, "AGENTCORE_RUNTIME_JWT_TENANT_ID"),
    runtimeAlgorithms,
    runtimeClockToleranceSeconds: boundedInteger(env, "AGENTCORE_RUNTIME_JWT_CLOCK_TOLERANCE_SECONDS", 0, 60),
    runtimeMaxTokenAgeSeconds: boundedInteger(env, "AGENTCORE_RUNTIME_JWT_MAX_TOKEN_AGE_SECONDS", 30, 3_600),
    runtimeMaxTokenLifetimeSeconds: boundedInteger(env, "AGENTCORE_RUNTIME_JWT_MAX_TOKEN_LIFETIME_SECONDS", 30, 3_600),
    runtimeJwksCacheTtlMs: boundedInteger(env, "AGENTCORE_RUNTIME_JWT_JWKS_CACHE_TTL_MS", 1_000, 900_000),
    runtimeJwksRefreshCooldownMs: boundedInteger(env, "AGENTCORE_RUNTIME_JWT_JWKS_REFRESH_COOLDOWN_MS", 1_000, 60_000),
    runtimeRevocationMode,
    gatewayUrl: liveGatewayUrl(env),
    gatewayToolName: identifier(
      env,
      "AGENTCORE_GATEWAY_TOOL_NAME",
      /^[A-Za-z0-9_-]+___[A-Za-z0-9_.-]+$/,
      256,
    ),
    resourceCredentialProviderName: identifier(
      env,
      "AGENTCORE_IDENTITY_CREDENTIAL_PROVIDER_NAME",
      NAME,
      128,
    ),
    issuer: issuer.href,
    jwksUrl: jwksUrl.href,
    audiences: exactList(env, "AGENTCORE_GATEWAY_JWT_AUDIENCES_JSON", 1),
    allowedSubjects: exactList(env, "AGENTCORE_GATEWAY_JWT_ALLOWED_SUBJECTS_JSON", 1),
    allowedClients: exactList(env, "AGENTCORE_GATEWAY_JWT_ALLOWED_CLIENTS_JSON", 1),
    requiredScopes: exactList(env, "AGENTCORE_GATEWAY_JWT_REQUIRED_SCOPES_JSON", 1),
    clientClaim,
    tenantClaim: identifier(env, "AGENTCORE_GATEWAY_JWT_TENANT_CLAIM", CLAIM, 128),
    deploymentTenantId: identifier(env, "AGENTCORE_GATEWAY_JWT_DEPLOYMENT_TENANT_ID"),
    gatewayAlgorithms,
    gatewayClockToleranceSeconds: boundedInteger(env, "AGENTCORE_GATEWAY_JWT_CLOCK_TOLERANCE_SECONDS", 0, 60),
    gatewayMaxTokenAgeSeconds: boundedInteger(env, "AGENTCORE_GATEWAY_JWT_MAX_TOKEN_AGE_SECONDS", 30, 3_600),
    gatewayMaxTokenLifetimeSeconds: boundedInteger(env, "AGENTCORE_GATEWAY_JWT_MAX_TOKEN_LIFETIME_SECONDS", 30, 3_600),
    gatewayJwksCacheTtlMs: boundedInteger(env, "AGENTCORE_GATEWAY_JWT_JWKS_CACHE_TTL_MS", 1_000, 900_000),
    gatewayJwksRefreshCooldownMs: boundedInteger(env, "AGENTCORE_GATEWAY_JWT_JWKS_REFRESH_COOLDOWN_MS", 1_000, 60_000),
    gatewayRevocationMode,
    replayTableName: identifier(env, "AGENTCORE_REPLAY_TABLE", /^[A-Za-z0-9_.-]{3,255}$/, 255),
    replayDeploymentId: identifier(env, "AGENTCORE_REPLAY_DEPLOYMENT_ID", IDENTIFIER, 128),
  });
}

export function serializeAgentCoreIdentityAcceptanceReport(
  scenarios: readonly Readonly<{ id: string; status: AgentCoreIdentityAcceptanceStatus }>[],
): string {
  if (
    scenarios.length < 1 || scenarios.length > 128 ||
    scenarios.some(({ id, status }) =>
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) ||
      !(["PASS", "FAIL", "BLOCKED", "NOT_RUN"] as const).includes(status)
    ) || new Set(scenarios.map(({ id }) => id)).size !== scenarios.length
  ) {
    throw new Error("Identity acceptance scenarios are invalid");
  }
  const report: AgentCoreIdentityAcceptanceReport = Object.freeze({
    schemaVersion: 1,
    mode: "offline",
    provenance: "synthetic-local-fixture",
    awsCalls: 0,
    scenarios: Object.freeze(scenarios.map(({ id, status }) => Object.freeze({ id, status }))),
  });
  return `${JSON.stringify(report)}\n`;
}
