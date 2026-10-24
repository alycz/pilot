import type { OpContext } from "./catalog/registry";
import { localTradingIsolatedV1MarkersPresent } from "./local-trading-isolated-v1";
import { localTradingIsolatedOnboardingV1MarkersPresent } from "./local-trading-isolated-onboarding-v1";

export const LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE =
  "reviewed-testnet-local-trading-onboarding-v1";
export const LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN =
  "local-trading-onboarding";

const ONBOARDING_MARKERS = [
  "HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Any partial or malformed marker activates the fail-closed boundary. */
export function localTradingOnboardingMarkersPresent(env: unknown): boolean {
  const values = record(env);
  return values !== undefined && ONBOARDING_MARKERS.some((name) => name in values);
}

export function isReviewedLocalTradingOnboardingContext(ctx: OpContext): boolean {
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
    env.HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED === "true" &&
    env.HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE ===
      LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE &&
    env.HARBOR_SOURCE_TAG === "2610240" &&
    !localTradingIsolatedV1MarkersPresent(env) &&
    !localTradingIsolatedOnboardingV1MarkersPresent(env) &&
    !("HARBOR_LOCAL_TRADING_RUNTIME_ENABLED" in env) &&
    !("HARBOR_LOCAL_TRADING_SIGNING_PROFILE" in env)
  );
}
