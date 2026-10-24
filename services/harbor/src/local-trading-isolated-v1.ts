import type { OpContext } from "./catalog/registry";

export const LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE =
  "local-wallet-isolated-v1";
export const LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN =
  "local-trading-isolated-v1";
export const LOCAL_TRADING_ISOLATED_V1_HARBOR_ORIGIN =
  "http://127.0.0.2:8791";
const LOCAL_TRADING_ISOLATED_V1_HOST = "127.0.0.2:8791";

const ISOLATED_MARKERS = [
  "HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE",
] as const;

const CONFLICTING_PROFILE_MARKERS = [
  "HARBOR_LOCAL_TRADING_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_SIGNING_PROFILE",
  "HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE",
  "HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE",
  "HARBOR_LOCAL_X402_SIGNING_PROFILE",
  "HARBOR_LOCAL_X402_MERCHANT_PAY_TO",
] as const;

const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Any partial or malformed isolated marker activates fail-closed safety. */
export function localTradingIsolatedV1MarkersPresent(env: unknown): boolean {
  const values = record(env);
  return values !== undefined && ISOLATED_MARKERS.some((name) => name in values);
}

function hasConflictingProfileMarkers(env: Record<string, unknown>): boolean {
  return CONFLICTING_PROFILE_MARKERS.some((name) => name in env);
}

function exactIsolatedMarkerPair(env: Record<string, unknown>): boolean {
  return (
    env.HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED === "true" &&
    env.HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE ===
      LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE &&
    !hasConflictingProfileMarkers(env)
  );
}

export function isReviewedLocalTradingIsolatedV1Context(
  ctx: OpContext,
): boolean {
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
    env.HARBOR_SOURCE_TAG === "2610240" &&
    exactIsolatedMarkerPair(env)
  );
}

function hasCanonicalIsolatedUrl(request: Request): boolean {
  const rawUrl = request.url;
  if (!rawUrl.startsWith(`${LOCAL_TRADING_ISOLATED_V1_HARBOR_ORIGIN}/`)) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  return (
    rawUrl === url.href &&
    url.origin === LOCAL_TRADING_ISOLATED_V1_HARBOR_ORIGIN &&
    url.protocol === "http:" &&
    url.hostname === "127.0.0.2" &&
    url.port === "8791" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
}

function hasSafeBrowserMetadata(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (
    origin !== null &&
    origin !== LOCAL_TRADING_ISOLATED_V1_HARBOR_ORIGIN
  ) {
    return false;
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}

/**
 * Establish the isolated local capability from the frozen request topology.
 * Forwarding metadata is rejected rather than interpreted, so no proxy chain
 * can substitute a host, scheme, or source address for the request URL.
 */
export function isLocalTradingIsolatedV1Request(
  request: Request,
  env: unknown,
): boolean {
  const values = record(env);
  return (
    values !== undefined &&
    exactIsolatedMarkerPair(values) &&
    hasCanonicalIsolatedUrl(request) &&
    request.headers.get("host") === LOCAL_TRADING_ISOLATED_V1_HOST &&
    FORWARDING_HEADERS.every((name) => !request.headers.has(name)) &&
    hasSafeBrowserMetadata(request)
  );
}
