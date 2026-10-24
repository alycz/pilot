import { createHmac, timingSafeEqual } from "node:crypto";

import { readCookie } from "./openrouter-session";

export const PERSONALIZATION_FIXTURE_COOKIE =
  "__Host-pilot-personalization-fixture" as const;
export const PERSONALIZATION_FIXTURE_ORIGIN = "http://127.0.0.1:3004" as const;
export const PERSONALIZATION_FIXTURE_OWNER =
  "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59" as const;
export const PERSONALIZATION_FIXTURE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: 60 * 60,
};

type FixtureEnvironment = Readonly<Record<string, string | undefined>>;
export type PersonalizationFixtureScope = {
  owner: typeof PERSONALIZATION_FIXTURE_OWNER;
  network: "testnet" | "devnet";
};

type FixtureSession = PersonalizationFixtureScope & {
  version: 1;
  expiresAt: number;
};
export type PersonalizationFixtureSession = PersonalizationFixtureScope & {
  expiresAt: number;
};

/**
 * The fixture cookie is useful only on the exact Playwright loopback slot. It
 * must never inherit the broader runtime-profile authority rules used by real
 * wallet sessions, and it never authorizes a wallet or transaction endpoint.
 */
export function isPersonalizationFixtureBrowserRequest(
  request: Request,
  environment: FixtureEnvironment = process.env,
): boolean {
  if (!resolvePersonalizationFixtureScope(environment)) return false;
  try {
    const expectedOrigin = resolvePersonalizationFixtureOrigin(environment);
    if (!expectedOrigin) return false;
    const expected = new URL(expectedOrigin);
    const url = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const forwardedFor = request.headers.get("x-forwarded-for");
    return request.headers.get("host") === expected.host &&
      request.headers.get("origin") === expectedOrigin &&
      request.headers.get("sec-fetch-site") === "same-origin" &&
      url.protocol === "http:" &&
      url.port === expected.port &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      !url.username && !url.password && !url.hash &&
      request.headers.get("forwarded") === null &&
      (forwardedHost === null || forwardedHost === expected.host) &&
      (forwardedProto === null || forwardedProto === "http") &&
      (forwardedFor === null || forwardedFor === "127.0.0.1");
  } catch {
    return false;
  }
}

function resolvePersonalizationFixtureOrigin(
  environment: FixtureEnvironment,
): string | undefined {
  const value = environment.PILOT_PERSONALIZATION_FIXTURE_ORIGIN?.trim() ||
    PERSONALIZATION_FIXTURE_ORIGIN;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      !Number.isInteger(port) ||
      port < 1_024 ||
      port > 65_535
    ) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function resolvePersonalizationFixtureScope(
  environment: FixtureEnvironment = process.env,
): PersonalizationFixtureScope | undefined {
  if (environment.PILOT_PERSONALIZATION_FIXTURE !== "1") return undefined;
  if (environment.NODE_ENV !== "development" && environment.NODE_ENV !== "test") return undefined;
  if (environment.PILOT_DEPLOYMENT_PROFILE !== undefined &&
      environment.PILOT_DEPLOYMENT_PROFILE !== "local-wallet") return undefined;
  if (environment.NEXT_PUBLIC_PILOT_BUILD_MARKER !== undefined) return undefined;
  if (environment.HARBOR_MOCK !== "1" || environment.PILOT_STRUCTURED_PREFERENCES !== "1") {
    return undefined;
  }
  if (!resolvePersonalizationFixtureOrigin(environment)) return undefined;
  if (!environment.PILOT_PERSONALIZATION_TENANT_ID?.trim() ||
      !environment.PILOT_PERSONALIZATION_STATE_DIR?.trim()) return undefined;
  const secret = environment.SESSION_SECRET;
  if (!secret || secret.length < 32 || secret !== secret.trim()) return undefined;
  const network = environment.EXEC_NETWORK?.trim() || "testnet";
  if (network !== "testnet" && network !== "devnet") return undefined;
  return { owner: PERSONALIZATION_FIXTURE_OWNER, network };
}

function sessionSecret(environment: FixtureEnvironment): string {
  const secret = environment.SESSION_SECRET;
  if (!secret || secret.length < 32 || secret !== secret.trim()) {
    throw new Error("Personalization fixture authorization is not configured");
  }
  return secret;
}

function signature(encoded: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`pilot/personalization-fixture/v1\0${encoded}`, "utf8")
    .digest("base64url");
}

function equal(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function sealPersonalizationFixtureSession(
  scope: PersonalizationFixtureScope,
  options: {
    environment?: FixtureEnvironment;
    now?: number;
  } = {},
): { token: string; expiresAt: number } {
  const environment = options.environment ?? process.env;
  const configured = resolvePersonalizationFixtureScope(environment);
  if (!configured || configured.owner !== scope.owner || configured.network !== scope.network) {
    throw new Error("Personalization fixture scope is unavailable");
  }
  const expiresAt = (options.now ?? Date.now()) +
    PERSONALIZATION_FIXTURE_COOKIE_OPTIONS.maxAge * 1_000;
  const payload: FixtureSession = { version: 1, ...configured, expiresAt };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { token: `v1.${encoded}.${signature(encoded, sessionSecret(environment))}`, expiresAt };
}

export function readPersonalizationFixtureSession(
  request: Request,
  options: {
    environment?: FixtureEnvironment;
    now?: number;
  } = {},
): PersonalizationFixtureSession | undefined {
  const environment = options.environment ?? process.env;
  const configured = resolvePersonalizationFixtureScope(environment);
  if (!configured) return undefined;
  const token = readCookie(request, PERSONALIZATION_FIXTURE_COOKIE);
  if (!token) return undefined;
  try {
    const [version, encoded, supplied, extra] = token.split(".");
    if (version !== "v1" || !encoded || !supplied || extra !== undefined) return undefined;
    if (!equal(supplied, signature(encoded, sessionSecret(environment)))) return undefined;
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const session = value as Record<string, unknown>;
    if (
      Object.keys(session).sort().join(",") !== "expiresAt,network,owner,version" ||
      session.version !== 1 ||
      session.owner !== configured.owner ||
      session.network !== configured.network ||
      !Number.isSafeInteger(session.expiresAt) ||
      (session.expiresAt as number) <= (options.now ?? Date.now())
    ) return undefined;
    return { ...configured, expiresAt: session.expiresAt as number };
  } catch {
    return undefined;
  }
}
