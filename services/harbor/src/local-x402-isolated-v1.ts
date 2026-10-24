import type { OpContext } from "./catalog/registry";

export const LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE =
  "reviewed-testnet-isolated-v1";
export const LOCAL_X402_ISOLATED_V1_HARBOR_ORIGIN =
  "http://127.0.0.2:8792";
export const LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO =
  "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr";
const LOCAL_X402_ISOLATED_V1_HOST = "127.0.0.2:8792";

const ISOLATED_MARKERS = [
  "HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED",
  "HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE",
] as const;

const CONFLICTING_PROFILE_MARKERS = [
  "HARBOR_LOCAL_TRADING_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_SIGNING_PROFILE",
  "HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE",
  "HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE",
  "HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE",
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

/** Any partial isolated-x402 marker activates fail-closed handling. */
export function localX402IsolatedV1MarkersPresent(env: unknown): boolean {
  const values = record(env);
  return values !== undefined && ISOLATED_MARKERS.some((name) => name in values);
}

function exactMarkerPair(env: Record<string, unknown>): boolean {
  return (
    env.HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED === "true" &&
    env.HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE ===
      LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE &&
    !CONFLICTING_PROFILE_MARKERS.some((name) => name in env)
  );
}

export function isReviewedLocalX402IsolatedV1Context(ctx: OpContext): boolean {
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
    env.HARBOR_LOCAL_READ_ONLY === "true" &&
    env.HARBOR_LOCAL_AUTH_REQUIRED === "true" &&
    env.HARBOR_LOCAL_CRON_DISABLED === "true" &&
    env.HARBOR_LOCAL_X402 === "true" &&
    env.HARBOR_LOCAL_X402_RUNTIME_ENABLED === "true" &&
    env.HARBOR_LOCAL_X402_SIGNING_PROFILE ===
      LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE &&
    env.HARBOR_LOCAL_X402_MERCHANT_PAY_TO ===
      LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO &&
    env.HARBOR_SOURCE_TAG === "2610240" &&
    exactMarkerPair(env)
  );
}

function hasCanonicalUrl(request: Request): boolean {
  const rawUrl = request.url;
  if (!rawUrl.startsWith(`${LOCAL_X402_ISOLATED_V1_HARBOR_ORIGIN}/`)) {
    return false;
  }
  try {
    const url = new URL(rawUrl);
    return (
      rawUrl === url.href &&
      url.origin === LOCAL_X402_ISOLATED_V1_HARBOR_ORIGIN &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.2" &&
      url.port === "8792" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function hasSafeBrowserMetadata(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== LOCAL_X402_ISOLATED_V1_HARBOR_ORIGIN) {
    return false;
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}

/** Establish the dedicated isolated-x402 local capability. */
export function isLocalX402IsolatedV1Request(
  request: Request,
  env: unknown,
): boolean {
  const values = record(env);
  return (
    values !== undefined &&
    exactMarkerPair(values) &&
    hasCanonicalUrl(request) &&
    request.headers.get("host") === LOCAL_X402_ISOLATED_V1_HOST &&
    FORWARDING_HEADERS.every((name) => !request.headers.has(name)) &&
    hasSafeBrowserMetadata(request)
  );
}
