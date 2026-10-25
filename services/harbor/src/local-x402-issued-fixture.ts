import type { OpContext } from "./catalog/registry";
import { LOCAL_HARBOR_ORIGIN } from "./local-x402";

export const LOCAL_X402_ISSUED_FIXTURE_PROFILE =
  "reviewed-offline-issued-fixture-v1" as const;

const PROFILE_MARKERS = [
  "HARBOR_LOCAL_X402_ISSUED_FIXTURE_ENABLED",
  "HARBOR_LOCAL_X402_ISSUED_FIXTURE_PROFILE",
] as const;

const CONFLICTING_PROFILE_MARKERS = [
  "HARBOR_LOCAL_X402",
  "HARBOR_LOCAL_X402_MERCHANT_PAY_TO",
  "HARBOR_LOCAL_X402_RUNTIME_ENABLED",
  "HARBOR_LOCAL_X402_SIGNING_PROFILE",
  "HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED",
  "HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE",
  "HARBOR_LOCAL_AP4M_X402_COMBINED_V1_RUNTIME_ENABLED",
  "HARBOR_LOCAL_AP4M_X402_COMBINED_V1_SIGNING_PROFILE",
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
    ? value as Record<string, unknown>
    : undefined;
}

/** Any partial issued profile activates fail-closed request handling. */
export function localX402IssuedFixtureMarkersPresent(env: unknown): boolean {
  const values = record(env);
  return values !== undefined && PROFILE_MARKERS.some((name) => name in values);
}

export function isLocalX402IssuedFixtureEnvironment(env: unknown): boolean {
  const values = record(env);
  return values !== undefined &&
    values.EXEC_NETWORK === "testnet" &&
    values.EXECUTOR === "quickjs" &&
    values.MAINNET_EXECUTION === "false" &&
    values.HARBOR_LOCAL_DEV === "true" &&
    values.HARBOR_LOCAL_READ_ONLY === "true" &&
    values.HARBOR_LOCAL_AUTH_REQUIRED === "true" &&
    values.HARBOR_LOCAL_CRON_DISABLED === "true" &&
    values.HARBOR_LOCAL_X402_ISSUED_FIXTURE_ENABLED === "true" &&
    values.HARBOR_LOCAL_X402_ISSUED_FIXTURE_PROFILE ===
      LOCAL_X402_ISSUED_FIXTURE_PROFILE &&
    !CONFLICTING_PROFILE_MARKERS.some((name) => name in values);
}

export function isReviewedLocalX402IssuedFixtureContext(
  ctx: OpContext,
): boolean {
  return ctx.localDevRequest === true &&
    typeof ctx.principal === "string" &&
    ctx.principal.trim().length > 0 &&
    ctx.principal !== "local-dev" &&
    isLocalX402IssuedFixtureEnvironment(ctx.env);
}

/** Bind the issued-only profile to the canonical loopback Harbor origin. */
export function isLocalX402IssuedFixtureRequest(
  request: Request,
  env: unknown,
): boolean {
  if (!isLocalX402IssuedFixtureEnvironment(env)) return false;
  const rawUrl = request.url;
  try {
    const url = new URL(rawUrl);
    return rawUrl === url.href &&
      url.origin === LOCAL_HARBOR_ORIGIN &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port === "8791" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      request.headers.get("host") === "127.0.0.1:8791" &&
      FORWARDING_HEADERS.every((name) => !request.headers.has(name)) &&
      (request.headers.get("origin") === null ||
        request.headers.get("origin") === LOCAL_HARBOR_ORIGIN) &&
      (request.headers.get("sec-fetch-site") === null ||
        request.headers.get("sec-fetch-site") === "same-origin");
  } catch {
    return false;
  }
}
