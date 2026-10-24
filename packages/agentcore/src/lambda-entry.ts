import { z } from "zod";

import {
  createAgentCoreLambdaTargetHandler,
  type AgentCoreLambdaContext,
} from "./lambda-target";
import {
  AGENTCORE_PUBLIC_MARKET_PAIR,
  AGENTCORE_PUBLIC_MARKET_VENUE,
} from "./contracts";
import {
  AGENTCORE_RLUSD_CURRENCY,
  AGENTCORE_XRPL_TESTNET_RPC,
  createXrplPublicMarketSource,
} from "./public-market";

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optionalInteger(env: Env, name: string): number | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${name}`);
  return Number(value);
}

export function createAgentCorePublicMarketLambda(input: Readonly<{
  env: Env;
  fetch?: typeof fetch;
  now?: () => number;
}>) {
  const endpoint = z.literal(AGENTCORE_XRPL_TESTNET_RPC).parse(
    input.env.AGENTCORE_MARKET_XRPL_ENDPOINT?.trim() || AGENTCORE_XRPL_TESTNET_RPC,
  );
  const source = createXrplPublicMarketSource({
    config: {
      endpoint,
      pair: AGENTCORE_PUBLIC_MARKET_PAIR,
      venue: AGENTCORE_PUBLIC_MARKET_VENUE,
      base: { symbol: "XRP", currency: "XRP" },
      quote: {
        symbol: "RLUSD",
        currency: AGENTCORE_RLUSD_CURRENCY,
        issuer: required(input.env, "AGENTCORE_MARKET_RLUSD_ISSUER"),
      },
      maxLedgerAgeSeconds: optionalInteger(
        input.env,
        "AGENTCORE_MARKET_MAX_LEDGER_AGE_SECONDS",
      ),
    },
    fetch: input.fetch,
    now: input.now,
  });
  return createAgentCoreLambdaTargetHandler({
    gatewayId: required(input.env, "AGENTCORE_LAMBDA_GATEWAY_ID"),
    targetId: required(input.env, "AGENTCORE_LAMBDA_TARGET_ID"),
    targetName: required(input.env, "AGENTCORE_LAMBDA_TARGET_NAME"),
    source,
  });
}

let configured: ReturnType<typeof createAgentCorePublicMarketLambda> | undefined;

export async function handler(event: unknown, context: AgentCoreLambdaContext) {
  configured ??= createAgentCorePublicMarketLambda({ env: process.env });
  return configured(event, context);
}
