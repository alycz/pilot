export const AGENTCORE_AWS_REGIONS = ["us-east-1", "us-east-2"] as const;
export type AgentCoreAwsRegion = (typeof AGENTCORE_AWS_REGIONS)[number];

export const DEFAULT_AGENTCORE_AWS_REGION: AgentCoreAwsRegion = "us-east-2";

export function isAgentCoreAwsRegion(value: string): value is AgentCoreAwsRegion {
  return (AGENTCORE_AWS_REGIONS as readonly string[]).includes(value);
}

export function parseAgentCoreAwsRegion(
  value: string | undefined,
  fallback: AgentCoreAwsRegion = DEFAULT_AGENTCORE_AWS_REGION,
): AgentCoreAwsRegion {
  const candidate = value?.trim() || fallback;
  if (!isAgentCoreAwsRegion(candidate)) {
    throw new Error(`AGENTCORE_AWS_REGION must be one of: ${AGENTCORE_AWS_REGIONS.join(", ")}`);
  }
  return candidate;
}

export function isExactAgentCoreGatewayHost(
  hostname: string,
  region: AgentCoreAwsRegion,
): boolean {
  return new RegExp(
    `^[0-9a-z](?:[0-9a-z-]{0,98}[0-9a-z])?-[0-9a-z]{10}\\.gateway\\.bedrock-agentcore\\.${region}\\.amazonaws\\.com$`,
  ).test(hostname);
}
