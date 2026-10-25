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

const QualifierSchema = z.union([
  z.literal("DEFAULT"),
  z.string().min(1).max(48).regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/),
  z.string().regex(/^\d+$/),
]);

type Env = Readonly<Record<string, string | undefined>>;
type Limits = Readonly<{ timeoutMs: number; maxRequestBytes: number; maxResponseBytes: number }>;

export type AgentCoreConfig =
  | ({ mode: "off" } & Limits)
  | ({ mode: "standin"; endpoint: string; gatewayToolName: string } & Limits)
  | ({
      mode: "aws";
      region: AgentCoreAwsRegion;
      runtimeAuthMode: "iam";
      runtimeArn: string;
      qualifier: string;
      gatewayUrl: string;
      gatewayToolName: string;
      gatewayAuthMode: "custom_jwt";
      gatewayProtocolVersion: typeof AGENTCORE_MCP_PROTOCOL_VERSION;
    } & Limits);

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
  const runtimeArnPattern = new RegExp(
    `^arn:aws:bedrock-agentcore:${region}:\\d{12}:runtime\\/[A-Za-z][A-Za-z0-9_]{0,47}-[A-Za-z0-9]{10}$`,
  );
  if (!runtimeArnPattern.test(runtimeArn)) throw new Error(`AGENTCORE_RUNTIME_ARN must be an exact ${region} Runtime ARN`);
  const qualifier = QualifierSchema.parse(env.AGENTCORE_RUNTIME_QUALIFIER?.trim() || "DEFAULT");
  if ((env.AGENTCORE_RUNTIME_AUTH_MODE?.trim() || "iam") !== "iam") {
    throw new Error("AGENTCORE_RUNTIME_AUTH_MODE must be iam for the SDK Runtime adapter");
  }
  if ((env.AGENTCORE_GATEWAY_AUTH_MODE?.trim() || "custom_jwt") !== "custom_jwt") {
    throw new Error("AGENTCORE_GATEWAY_AUTH_MODE must be custom_jwt for the HTTP Gateway adapter");
  }
  const protocol = env.AGENTCORE_GATEWAY_PROTOCOL_VERSION?.trim() || AGENTCORE_MCP_PROTOCOL_VERSION;
  if (protocol !== AGENTCORE_MCP_PROTOCOL_VERSION) {
    throw new Error(`AGENTCORE_GATEWAY_PROTOCOL_VERSION must be ${AGENTCORE_MCP_PROTOCOL_VERSION}`);
  }
  return {
    mode,
    region,
    runtimeAuthMode: "iam",
    runtimeArn,
    qualifier,
    gatewayUrl: gatewayUrl(env.AGENTCORE_GATEWAY_URL, region),
    gatewayToolName: AgentCoreGatewayToolNameSchema.parse(env.AGENTCORE_GATEWAY_TOOL_NAME),
    gatewayAuthMode: "custom_jwt",
    gatewayProtocolVersion: AGENTCORE_MCP_PROTOCOL_VERSION,
    ...bounded,
  };
}
