import type { OpContext } from "./catalog/registry";
import { localTradingIsolatedV1MarkersPresent } from "./local-trading-isolated-v1";
import { localTradingIsolatedOnboardingV1MarkersPresent } from "./local-trading-isolated-onboarding-v1";
import { localTradingOnboardingMarkersPresent } from "./local-trading-onboarding";

export const LOCAL_TRADING_SIGNING_PROFILE =
  "reviewed-testnet-local-trading-v1";
export const LOCAL_TRADING_BUILD_ORIGIN = "local-trading";

const TRADING_MARKERS = [
  "HARBOR_LOCAL_TRADING_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_SIGNING_PROFILE",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function localTradingMarkersPresent(env: unknown): boolean {
  const values = record(env);
  return (
    values !== undefined &&
    TRADING_MARKERS.some((name) => name in values)
  );
}

export function isReviewedLocalTradingContext(ctx: OpContext): boolean {
  const env = record(ctx.env);
  if (env === undefined) return false;
  return (
    ctx.localDevRequest === true &&
    ctx.principal.length > 0 &&
    ctx.principal !== "local-dev" &&
    env.EXEC_NETWORK === "testnet" &&
    env.EXECUTOR === "quickjs" &&
    env.MAINNET_EXECUTION === "false" &&
    env.HARBOR_LOCAL_DEV === "true" &&
    env.HARBOR_LOCAL_READ_ONLY === "false" &&
    env.HARBOR_LOCAL_AUTH_REQUIRED === "true" &&
    env.HARBOR_LOCAL_CRON_DISABLED === "true" &&
    env.HARBOR_LOCAL_X402 === "false" &&
    env.HARBOR_LOCAL_X402_RUNTIME_ENABLED === "false" &&
    env.HARBOR_LOCAL_TRADING_RUNTIME_ENABLED === "true" &&
    env.HARBOR_LOCAL_TRADING_SIGNING_PROFILE ===
      LOCAL_TRADING_SIGNING_PROFILE &&
    env.HARBOR_SOURCE_TAG === "2610240" &&
    !localTradingIsolatedV1MarkersPresent(env) &&
    !localTradingIsolatedOnboardingV1MarkersPresent(env) &&
    !localTradingOnboardingMarkersPresent(env)
  );
}

export function localTradingSafetyMarkersPresent(env: unknown): boolean {
  return (
    localTradingMarkersPresent(env) ||
    localTradingOnboardingMarkersPresent(env) ||
    localTradingIsolatedV1MarkersPresent(env) ||
    localTradingIsolatedOnboardingV1MarkersPresent(env)
  );
}

export function assertLocalTradingTestnet(
  ctx: OpContext,
  network: string,
): void {
  if (localTradingSafetyMarkersPresent(ctx.env) && network !== "testnet") {
    throw new Error("Local trading profile permits only testnet state");
  }
}
