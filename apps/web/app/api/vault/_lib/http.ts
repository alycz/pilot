import { createHmac, timingSafeEqual } from "node:crypto";
import type { VaultScope } from "@pilot/vault";

import { resolvePilotRequestAuthority } from "../../../../lib/runtime-profile";
import { readWalletSession } from "../../../../lib/wallet-session";
import {
  isPersonalizationFixtureBrowserRequest,
  readPersonalizationFixtureSession,
} from "../../../../lib/personalization-fixture-session";

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function authorizationToken(secret: string): string {
  return createHmac("sha256", secret).update("pilot/vault-api/v1").digest("base64url");
}

function vaultSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32 || secret !== secret.trim()) {
    throw new Error("Vault API authorization is not configured");
  }
  return secret;
}

/** For server components/actions only. Never import this helper into a client bundle. */
export function vaultApiAuthorizationHeader(): string {
  return `Bearer ${authorizationToken(vaultSessionSecret())}`;
}

function assertJsonMutation(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return;
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new Error("Request content type must be application/json");
  }
}

function hasVaultApiAuthorization(request: Request): boolean {
  const secret = vaultSessionSecret();
  const header = request.headers.get("authorization");
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = authorizationToken(secret);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return false;
  }
  return true;
}

/**
 * Internal vault requests require the server-only bearer. Mock mode does not
 * weaken this boundary, including for loopback request URLs.
 */
export function assertVaultRequestAuthorized(request: Request): void {
  assertJsonMutation(request);
  if (hasVaultApiAuthorization(request)) return;

  throw new Error("Vault API authorization failed");
}

/**
 * Authorize one browser-originated, wallet-scoped vault mutation. The caller
 * must additionally bind the returned scope to the resource in its request.
 */
export function assertWalletBoundVaultMutationAuthorized(
  request: Request,
): VaultScope | undefined {
  assertJsonMutation(request);
  if (hasVaultApiAuthorization(request)) return undefined;

  let expectedOrigin: string;
  try {
    expectedOrigin = resolvePilotRequestAuthority(process.env, request).origin;
  } catch {
    throw new Error("Vault wallet authorization failed");
  }
  const configuredNetwork = process.env.EXEC_NETWORK?.trim();
  const session = readWalletSession(request);
  if (
    request.headers.get("origin") !== expectedOrigin ||
    request.headers.get("sec-fetch-site") !== "same-origin" ||
    (configuredNetwork !== "testnet" && configuredNetwork !== "devnet") ||
    session?.network !== configuredNetwork
  ) {
    throw new Error("Vault wallet authorization failed");
  }
  return { owner: session.account, network: session.network };
}

/**
 * Preference acceptance requires the server bearer or an exact same-origin
 * request bound to the configured test-network wallet session. The separate
 * development fixture cookie is accepted only by the structured-preference
 * and workflow-lesson endpoints.
 */
export function assertPreferenceAcceptanceAuthorized(request: Request): VaultScope | undefined {
  assertJsonMutation(request);
  if (hasVaultApiAuthorization(request)) return undefined;

  const path = new URL(request.url).pathname;
  const fixturePath = path === "/api/vault/preferences/structured" ||
    path === "/api/vault/lessons";
  const fixture = fixturePath && isPersonalizationFixtureBrowserRequest(request)
    ? readPersonalizationFixtureSession(request)
    : undefined;
  const configuredNetwork = process.env.EXEC_NETWORK?.trim();
  if (fixture && fixture.network === configuredNetwork) {
    return { owner: fixture.owner, network: fixture.network };
  }

  let expectedOrigin: string;
  try {
    expectedOrigin = resolvePilotRequestAuthority(process.env, request).origin;
  } catch {
    throw new Error("Vault preference authorization failed");
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  const session = readWalletSession(request);
  if (
    request.headers.get("origin") !== expectedOrigin ||
    fetchSite !== "same-origin" ||
    (configuredNetwork !== "testnet" && configuredNetwork !== "devnet")
  ) {
    throw new Error("Vault API authorization failed");
  }
  if (session?.network === configuredNetwork) {
    return { owner: session.account, network: session.network };
  }
  throw new Error("Vault API authorization failed");
}

function redactConfiguredSecrets(message: string): string {
  const secrets = [
    process.env.VAULT_GITHUB_TOKEN,
    process.env.HARBOR_API_KEY,
    process.env.SESSION_SECRET,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return secrets.reduce(
    (redacted, secret) => redacted.split(secret).join("[redacted]"),
    message,
  );
}

export function errorResponse(error: unknown): Response {
  const message = redactConfiguredSecrets(
    error instanceof Error ? error.message : "Vault request failed",
  );
  const lower = message.toLowerCase();
  const validationError =
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray((error as { issues?: unknown }).issues);
  const status =
    lower.includes("authorization")
      ? 401
      : lower.includes("conflict") || lower.includes("storage is busy")
        ? 409
      : validationError ||
          lower.includes("required") ||
          lower.includes("invalid") ||
          lower.includes("unsupported") ||
          lower.includes("must") ||
          lower.includes("cannot")
        ? 400
        : 500;
  return json({ ok: false, error: { message } }, status);
}

export async function objectBody(request: Request): Promise<Record<string, unknown>> {
  assertJsonMutation(request);
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
}
