import { createHmac } from "node:crypto";

import {
  NearAccountIdSchema,
  NearPrincipalAuthorizationSchema,
  type NearPrincipalAuthorization,
} from "@pilot/contracts/near";

import type { WalletSession } from "./wallet-session";

const PRINCIPAL_DOMAIN = "pilot.near.principal.from-wallet-session.v1";
const AUTHORIZATION_DOMAIN = "pilot.near.principal.authorization.wallet-bound.v1";
const PRINCIPAL_PREFIX = "near-wallet-principal-v1-";
const PREAUTHORIZATION_PREFIX = "near-preauthorization-v1-";
const AUTHORIZATION_PREFIX = "near-authorization-v1-";
export const NEAR_PRINCIPAL_PREAUTHORIZATION_TTL_MS = 5 * 60_000;
export const NEAR_PRINCIPAL_AUTHORIZATION_TTL_MS = 15 * 60_000;

export const NEAR_UPGRADED_AUTHORIZED_OPERATIONS = Object.freeze([
  "near.intents.approval.review",
  "near.intents.executable-quote.review",
  "near.intents.status",
  "near.intents.owner-funded.reserve",
  "near.intents.owner-funded.reconcile",
] as const);

export type NearPrincipalBootstrapEnvironment = Readonly<{
  NEXT_PUBLIC_PILOT_BUILD_MARKER?: string;
  PILOT_DEPLOYMENT_PROFILE?: string;
  PILOT_NEAR_PRINCIPAL_BOOTSTRAP_ENABLED?: string;
  SESSION_SECRET?: string;
}>;

function secret(environment: NearPrincipalBootstrapEnvironment): string {
  const value = environment.SESSION_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new Error("NEAR principal bootstrap is unavailable.");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => `${JSON.stringify(name)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(
  environment: NearPrincipalBootstrapEnvironment,
  domain: string,
  value: unknown,
): string {
  return createHmac("sha256", secret(environment))
    .update(domain, "utf8").update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function deploymentBinding(environment: NearPrincipalBootstrapEnvironment) {
  return {
    deployment_profile: environment.PILOT_DEPLOYMENT_PROFILE ?? "unset",
    build_marker: environment.NEXT_PUBLIC_PILOT_BUILD_MARKER ?? "unset",
  };
}

function principalBinding(
  wallet: WalletSession,
  environment: NearPrincipalBootstrapEnvironment,
) {
  return {
    version: wallet.version,
    account: wallet.account,
    network: wallet.network,
    wallet_deployment_profile: wallet.deployment_profile ?? "unset",
    ...deploymentBinding(environment),
  };
}

export function deriveNearPrincipalIdFromWalletSession(
  wallet: WalletSession,
  environment: NearPrincipalBootstrapEnvironment = process.env,
): string {
  return `${PRINCIPAL_PREFIX}${digest(
    environment,
    PRINCIPAL_DOMAIN,
    principalBinding(wallet, environment),
  )}`;
}

function authorizationId(
  kind: "preauthorization" | "authorization",
  authorization: Omit<NearPrincipalAuthorization, "authorization_id">,
  wallet: WalletSession,
  environment: NearPrincipalBootstrapEnvironment,
): string {
  const prefix = kind === "preauthorization"
    ? PREAUTHORIZATION_PREFIX
    : AUTHORIZATION_PREFIX;
  return `${prefix}${digest(environment, AUTHORIZATION_DOMAIN, {
    kind,
    authorization,
    wallet_session: {
      ...principalBinding(wallet, environment),
      expires_at_ms: wallet.expiresAt,
    },
  })}`;
}

function exactOperations(
  authorization: NearPrincipalAuthorization,
): "preauthorization" | "authorization" | null {
  if (
    authorization.operations.length === 1 &&
    authorization.operations[0] === "near.intents.approval.review"
  ) return "preauthorization";
  if (
    authorization.operations.length === NEAR_UPGRADED_AUTHORIZED_OPERATIONS.length &&
    authorization.operations.every((operation, index) =>
      operation === NEAR_UPGRADED_AUTHORIZED_OPERATIONS[index])
  ) return "authorization";
  return null;
}

export function isWalletBoundNearPrincipalAuthorization(
  authorization: NearPrincipalAuthorization,
): boolean {
  return authorization.principal_id.startsWith(PRINCIPAL_PREFIX);
}

export function isNearPrincipalPreauthorization(
  authorization: NearPrincipalAuthorization,
): boolean {
  return isWalletBoundNearPrincipalAuthorization(authorization) &&
    authorization.authorization_id.startsWith(PREAUTHORIZATION_PREFIX) &&
    exactOperations(authorization) === "preauthorization";
}

export function matchesWalletBoundNearPrincipalAuthorization(
  authorization: NearPrincipalAuthorization,
  wallet: WalletSession,
  environment: NearPrincipalBootstrapEnvironment = process.env,
): boolean {
  if (!isWalletBoundNearPrincipalAuthorization(authorization)) return true;
  const kind = exactOperations(authorization);
  if (!kind) return false;
  if (
    authorization.principal_id !==
      deriveNearPrincipalIdFromWalletSession(wallet, environment) ||
    authorization.network !== "near:mainnet" ||
    Date.parse(authorization.expires_at) > wallet.expiresAt
  ) return false;
  const { authorization_id: _authorizationId, ...unsigned } = authorization;
  return authorization.authorization_id === authorizationId(
    kind,
    unsigned,
    wallet,
    environment,
  );
}

export function createNearPrincipalPreauthorization(input: Readonly<{
  accountId: string;
  wallet: WalletSession;
  environment?: NearPrincipalBootstrapEnvironment;
  now?: number;
}>): NearPrincipalAuthorization {
  const environment = input.environment ?? process.env;
  if (environment.PILOT_NEAR_PRINCIPAL_BOOTSTRAP_ENABLED !== "true") {
    throw new Error("NEAR principal bootstrap is disabled.");
  }
  const accountId = NearAccountIdSchema.parse(input.accountId);
  const now = input.now ?? Date.now();
  const expiresAt = Math.min(
    now + NEAR_PRINCIPAL_PREAUTHORIZATION_TTL_MS,
    input.wallet.expiresAt,
  );
  if (!Number.isSafeInteger(now) || now < 0 || expiresAt <= now) {
    throw new Error("NEAR principal bootstrap is unavailable.");
  }
  const unsigned = {
    version: "pilot-near-principal-authorization-v1" as const,
    principal_id: deriveNearPrincipalIdFromWalletSession(
      input.wallet,
      environment,
    ),
    account_id: accountId,
    network: "near:mainnet" as const,
    operations: ["near.intents.approval.review"] as Array<
      "near.intents.approval.review"
    >,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  };
  return NearPrincipalAuthorizationSchema.parse({
    ...unsigned,
    authorization_id: authorizationId(
      "preauthorization",
      unsigned,
      input.wallet,
      environment,
    ),
  });
}

export function upgradeNearPrincipalAuthorization(input: Readonly<{
  preauthorization: NearPrincipalAuthorization;
  wallet: WalletSession;
  environment?: NearPrincipalBootstrapEnvironment;
  now?: number;
}>): NearPrincipalAuthorization {
  const environment = input.environment ?? process.env;
  const now = input.now ?? Date.now();
  if (
    !isNearPrincipalPreauthorization(input.preauthorization) ||
    !matchesWalletBoundNearPrincipalAuthorization(
      input.preauthorization,
      input.wallet,
      environment,
    ) ||
    Date.parse(input.preauthorization.issued_at) > now ||
    Date.parse(input.preauthorization.expires_at) <= now
  ) {
    throw new Error("The NEAR principal preauthorization is invalid.");
  }
  const expiresAt = Math.min(
    now + NEAR_PRINCIPAL_AUTHORIZATION_TTL_MS,
    input.wallet.expiresAt,
  );
  if (expiresAt <= now) {
    throw new Error("The NEAR principal authorization is unavailable.");
  }
  const unsigned = {
    version: "pilot-near-principal-authorization-v1" as const,
    principal_id: input.preauthorization.principal_id,
    account_id: input.preauthorization.account_id,
    network: "near:mainnet" as const,
    operations: [...NEAR_UPGRADED_AUTHORIZED_OPERATIONS],
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  };
  return NearPrincipalAuthorizationSchema.parse({
    ...unsigned,
    authorization_id: authorizationId(
      "authorization",
      unsigned,
      input.wallet,
      environment,
    ),
  });
}
