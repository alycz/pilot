import { describe, expect, it, vi } from "vitest";

import { createAgentCorePublicMarketLambda } from "../src/lambda-entry";
import { AGENTCORE_XRPL_TESTNET_RPC } from "../src/public-market";

const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const NOW = Date.parse("2026-10-24T12:00:30.000Z");
const CLOSE = Date.parse("2026-10-24T12:00:00.000Z") / 1_000 - 946_684_800;
const HASH = "A".repeat(64);
const env = {
  AGENTCORE_LAMBDA_GATEWAY_ID: "PilotResearchGateway-AbCdEf1234",
  AGENTCORE_LAMBDA_TARGET_ID: "PilotReadTarget-ZyXwVu9876",
  AGENTCORE_LAMBDA_TARGET_NAME: "PilotReadTarget",
  AGENTCORE_MARKET_XRPL_ENDPOINT: AGENTCORE_XRPL_TESTNET_RPC,
  AGENTCORE_MARKET_RLUSD_ISSUER: ISSUER,
  AGENTCORE_MARKET_MAX_LEDGER_AGE_SECONDS: "120",
};
const context = {
  clientContext: { custom: {
    bedrockAgentCoreMessageVersion: "1.0",
    bedrockAgentCoreAwsRequestId: "aws-request-123",
    bedrockAgentCoreMcpMessageId: "mcp-message-123",
    bedrockAgentCoreGatewayId: env.AGENTCORE_LAMBDA_GATEWAY_ID,
    bedrockAgentCoreTargetId: env.AGENTCORE_LAMBDA_TARGET_ID,
    bedrockAgentCoreToolName: "PilotReadTarget___pilot.read_market_context",
  } },
};

describe("AgentCore public-market Lambda entrypoint", () => {
  it("composes the strict Gateway boundary with the public XRPL source", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      return new Response(JSON.stringify({
        status: "success",
        result: body.method === "ledger" ? {
          ledger_hash: HASH,
          ledger_index: 12_345,
          validated: true,
          ledger: {
            ledger_hash: HASH,
            ledger_index: 12_345,
            close_time: CLOSE,
            close_time_resolution: 10,
            closed: true,
          },
        } : { ledger_hash: HASH, ledger_index: 12_345, offers: [] },
      }), { headers: { "content-type": "application/json" } });
    });
    const invoke = createAgentCorePublicMarketLambda({ env, fetch, now: () => NOW });
    await expect(invoke({
      requestId: "market-1",
      scopeDigest: "a".repeat(64),
      context: {},
    }, context)).resolves.toMatchObject({
      summary: expect.stringContaining("0 ask-side XRP/RLUSD offers"),
      evidence: [{ source: "xrpl-testnet-dex" }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing target ID", { ...env, AGENTCORE_LAMBDA_TARGET_ID: undefined }],
    ["unapproved endpoint", { ...env, AGENTCORE_MARKET_XRPL_ENDPOINT: "https://example.test" }],
    ["invalid max age", { ...env, AGENTCORE_MARKET_MAX_LEDGER_AGE_SECONDS: "0" }],
    ["bad issuer", { ...env, AGENTCORE_MARKET_RLUSD_ISSUER: "not-an-address" }],
  ])("fails configuration closed for %s", (_name, candidate) => {
    expect(() => createAgentCorePublicMarketLambda({ env: candidate })).toThrow();
  });
});
