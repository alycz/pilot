import { z } from "zod";

import {
  AGENTCORE_MCP_PROTOCOL_VERSION,
  AGENTCORE_STANDIN_TOOL,
  AgentCoreGatewayToolNameSchema,
} from "./contracts";
import {
  isExactAgentCoreGatewayHost,
  parseAgentCoreAwsRegion,
  type AgentCoreAwsRegion,
} from "./regions";
import type { AgentCoreJwtAlgorithm, AgentCoreJwtPolicy } from "./jwt";

export const AgentCoreRuntimeQualifierSchema = z.union([
  z.literal("DEFAULT"),
  z.string().min(1).max(48).regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/),
  z.string().regex(/^\d+$/),
]);

export function isExactAgentCoreRuntimeArn(
  value: string,
  region: AgentCoreAwsRegion,
): boolean {
  return new RegExp(
    `^arn:aws:bedrock-agentcore:${region}:\\d{12}:runtime\\/[A-Za-z][A-Za-z0-9_]{0,47}-[A-Za-z0-9]{10}$`,
  ).test(value);
}

type Env = Readonly<Record<string, string | undefined>>;
type Limits = Readonly<{ timeoutMs: number; maxRequestBytes: number; maxResponseBytes: number }>;
type AwsConfig = Readonly<{
  mode: "aws";
  region: AgentCoreAwsRegion;
  runtimeArn: string;
  qualifier: string;
  gatewayUrl: string;
  gatewayToolName: string;
  gatewayAuthMode: "custom_jwt";
  gatewayProtocolVersion: typeof AGENTCORE_MCP_PROTOCOL_VERSION;
}> & Limits;

export type AgentCoreConfig =
  | ({ mode: "off" } & Limits)
  | ({ mode: "standin"; endpoint: string; gatewayToolName: string } & Limits)
  | (AwsConfig & Readonly<{ runtimeAuthMode: "iam" }>)
  | (AwsConfig & Readonly<{
      runtimeAuthMode: "oauth_jwt";
      runtimeJwtTenantId: string;
      runtimeJwtPolicy: AgentCoreJwtPolicy;
    }>);

const STATIC_RUNTIME_TOKEN_ENV = Object.freeze([
  "AGENTCORE_RUNTIME_ACCESS_TOKEN",
  "AGENTCORE_RUNTIME_BEARER_TOKEN",
  "AGENTCORE_RUNTIME_INBOUND_JWT",
  "AGENTCORE_RUNTIME_JWT_TOKEN",
  "AGENTCORE_RUNTIME_OAUTH_TOKEN",
  "AGENTCORE_WORKLOAD_ACCESS_TOKEN",
]);

function integer(name: string, value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value?.trim() || fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > max) {
    throw new Error(`${name} must be an integer between 100 and ${max}`);
  }
  return parsed;
}

function limits(env: Env): Limits {
  return {
    timeoutMs: integer("AGENTCORE_TIMEOUT_MS", env.AGENTCORE_TIMEOUT_MS, 30_000, 60_000),
    maxRequestBytes: integer("AGENTCORE_MAX_REQUEST_BYTES", env.AGENTCORE_MAX_REQUEST_BYTES, 64 * 1024, 256 * 1024),
    maxResponseBytes: integer("AGENTCORE_MAX_RESPONSE_BYTES", env.AGENTCORE_MAX_RESPONSE_BYTES, 256 * 1024, 1024 * 1024),
  };
}

function required(env: Env, name: string, maximum = 2_048): string {
  const value = env[name];
  if (
    value === undefined || value.length < 1 || value.length > maximum || value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error(`${name} is required and must be bounded`);
  return value;
}

function requiredInteger(
  env: Env,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = required(env, name, 16);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function exactList(
  env: Env,
  name: string,
  maximum: number,
  accepted?: ReadonlySet<string>,
): readonly string[] {
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
      entry.trim() !== entry || /[\u0000-\u001f\u007f]/.test(entry) ||
      (accepted !== undefined && !accepted.has(entry))
    ) || new Set(value).size !== value.length
  ) throw new Error(`${name} must contain unique bounded values`);
  return Object.freeze([...value] as string[]);
}

function runtimeJwtConfig(env: Env): Readonly<{
  runtimeJwtTenantId: string;
  runtimeJwtPolicy: AgentCoreJwtPolicy;
}> {
  const clientClaim = required(env, "AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM", 16);
  if (clientClaim !== "client_id") {
    throw new Error("AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM must be client_id");
  }
  const tenantClaim = required(env, "AGENTCORE_RUNTIME_JWT_TENANT_CLAIM", 128);
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(tenantClaim)) {
    throw new Error("AGENTCORE_RUNTIME_JWT_TENANT_CLAIM is invalid");
  }
  const revocationMode = required(env, "AGENTCORE_RUNTIME_JWT_REVOCATION_MODE", 16);
  let revocation: AgentCoreJwtPolicy["revocation"];
  if (revocationMode === "expiry_only") {
    if (env.AGENTCORE_RUNTIME_JWT_REVOCATION_TIMEOUT_MS !== undefined) {
      throw new Error("AGENTCORE_RUNTIME_JWT_REVOCATION_TIMEOUT_MS is valid only in checker mode");
    }
    revocation = { mode: "expiry_only" };
  } else if (revocationMode === "checker") {
    const timeout = Number(required(env, "AGENTCORE_RUNTIME_JWT_REVOCATION_TIMEOUT_MS", 4));
    if (!Number.isSafeInteger(timeout) || timeout < 50 || timeout > 5_000) {
      throw new Error("AGENTCORE_RUNTIME_JWT_REVOCATION_TIMEOUT_MS must be between 50 and 5000");
    }
    revocation = { mode: "checker", timeoutMs: timeout };
  } else {
    throw new Error("AGENTCORE_RUNTIME_JWT_REVOCATION_MODE must be expiry_only or checker");
  }
  return Object.freeze({
    runtimeJwtTenantId: required(env, "AGENTCORE_RUNTIME_JWT_TENANT_ID", 256),
    runtimeJwtPolicy: Object.freeze({
      issuer: required(env, "AGENTCORE_RUNTIME_JWT_ISSUER"),
      jwksUrl: required(env, "AGENTCORE_RUNTIME_JWT_JWKS_URL"),
      audiences: exactList(env, "AGENTCORE_RUNTIME_JWT_AUDIENCES_JSON", 1),
      allowedSubjects: exactList(env, "AGENTCORE_RUNTIME_JWT_ALLOWED_SUBJECTS_JSON", 1),
      allowedClients: exactList(env, "AGENTCORE_RUNTIME_JWT_ALLOWED_CLIENTS_JSON", 1),
      requiredScopes: exactList(env, "AGENTCORE_RUNTIME_JWT_REQUIRED_SCOPES_JSON", 1),
      clientClaim: "client_id",
      tenantClaim,
      algorithms: exactList(
        env,
        "AGENTCORE_RUNTIME_JWT_ALGORITHMS_JSON",
        2,
        new Set(["RS256", "ES256"]),
      ) as readonly AgentCoreJwtAlgorithm[],
      clockToleranceSeconds: requiredInteger(
        env,
        "AGENTCORE_RUNTIME_JWT_CLOCK_TOLERANCE_SECONDS",
        0,
        60,
      ),
      maxTokenAgeSeconds: requiredInteger(
        env,
        "AGENTCORE_RUNTIME_JWT_MAX_TOKEN_AGE_SECONDS",
        30,
        3_600,
      ),
      maxTokenLifetimeSeconds: requiredInteger(
        env,
        "AGENTCORE_RUNTIME_JWT_MAX_TOKEN_LIFETIME_SECONDS",
        30,
        3_600,
      ),
      cacheTtlMs: requiredInteger(
        env,
        "AGENTCORE_RUNTIME_JWT_JWKS_CACHE_TTL_MS",
        1_000,
        900_000,
      ),
      jwksRefreshCooldownMs: requiredInteger(
        env,
        "AGENTCORE_RUNTIME_JWT_JWKS_REFRESH_COOLDOWN_MS",
        1_000,
        60_000,
      ),
      revocation,
    }),
  });
}

function standinEndpoint(value: string | undefined): string {
  if (!value?.trim()) throw new Error("AGENTCORE_STANDIN_URL is required in standin mode");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) throw new Error("AGENTCORE_STANDIN_URL must be an exact loopback HTTP origin");
  return url.origin;
}

function gatewayUrl(value: string | undefined, region: AgentCoreAwsRegion): string {
  if (!value?.trim()) throw new Error("AGENTCORE_GATEWAY_URL is required in aws mode");
  const url = new URL(value);
  if (
    url.protocol !== "https:" || !isExactAgentCoreGatewayHost(url.hostname, region) ||
    url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash
  ) throw new Error(`AGENTCORE_GATEWAY_URL must be the exact ${region} AgentCore MCP endpoint`);
  return url.href;
}

export function readAgentCoreConfig(env: Env = process.env): AgentCoreConfig {
  if (STATIC_RUNTIME_TOKEN_ENV.some((name) => env[name] !== undefined)) {
    throw new Error("Static AgentCore Runtime token environment variables are unsupported");
  }
  const mode = env.AGENTCORE_MODE?.trim() || "off";
  const bounded = limits(env);
  if (mode === "off") return { mode, ...bounded };
  if (mode === "standin") {
    return {
      mode,
      endpoint: standinEndpoint(env.AGENTCORE_STANDIN_URL),
      gatewayToolName: AgentCoreGatewayToolNameSchema.parse(
        env.AGENTCORE_GATEWAY_TOOL_NAME?.trim() || AGENTCORE_STANDIN_TOOL,
      ),
      ...bounded,
    };
  }
  if (mode !== "aws") throw new Error("AGENTCORE_MODE must be off, standin, or aws");
  const region = parseAgentCoreAwsRegion(env.AGENTCORE_AWS_REGION);
  const runtimeArn = env.AGENTCORE_RUNTIME_ARN?.trim() || "";
  if (!isExactAgentCoreRuntimeArn(runtimeArn, region)) {
    throw new Error(`AGENTCORE_RUNTIME_ARN must be an exact ${region} Runtime ARN`);
  }
  const qualifier = AgentCoreRuntimeQualifierSchema.parse(
    env.AGENTCORE_RUNTIME_QUALIFIER?.trim() || "DEFAULT",
  );
  const runtimeAuthMode = env.AGENTCORE_RUNTIME_AUTH_MODE?.trim();
  if (runtimeAuthMode !== "iam" && runtimeAuthMode !== "oauth_jwt") {
    throw new Error("AGENTCORE_RUNTIME_AUTH_MODE must explicitly be iam or oauth_jwt");
  }
  if ((env.AGENTCORE_GATEWAY_AUTH_MODE?.trim() || "custom_jwt") !== "custom_jwt") {
    throw new Error("AGENTCORE_GATEWAY_AUTH_MODE must be custom_jwt for the HTTP Gateway adapter");
  }
  const protocol = env.AGENTCORE_GATEWAY_PROTOCOL_VERSION?.trim() || AGENTCORE_MCP_PROTOCOL_VERSION;
  if (protocol !== AGENTCORE_MCP_PROTOCOL_VERSION) {
    throw new Error(`AGENTCORE_GATEWAY_PROTOCOL_VERSION must be ${AGENTCORE_MCP_PROTOCOL_VERSION}`);
  }
  const common = {
    mode,
    region,
    runtimeArn,
    qualifier,
    gatewayUrl: gatewayUrl(env.AGENTCORE_GATEWAY_URL, region),
    gatewayToolName: AgentCoreGatewayToolNameSchema.parse(env.AGENTCORE_GATEWAY_TOOL_NAME),
    gatewayAuthMode: "custom_jwt",
    gatewayProtocolVersion: AGENTCORE_MCP_PROTOCOL_VERSION,
    ...bounded,
  } as const;
  if (runtimeAuthMode === "oauth_jwt") {
    return { ...common, runtimeAuthMode, ...runtimeJwtConfig(env) };
  }
  return {
    ...common,
    runtimeAuthMode,
  };
}
