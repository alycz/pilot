import { createHmac, timingSafeEqual } from "node:crypto";

import {
  NearApprovalBindingSchema,
  NearPrincipalAuthorizationSchema,
  NearWalletConnectionSchema,
  NearWalletExecutionPolicySchema,
  computeNearApprovalDigest,
  type NearApprovalBinding,
  type NearPrincipalAuthorization,
  type NearWalletConnection,
  type NearWalletExecutionPolicy,
} from "@pilot/contracts/near";
import { z } from "zod";

const SESSION_VERSION = "pilot-near-wallet-session-v1" as const;
const SESSION_TTL_MS = 60 * 60 * 1_000;
const HexDigestSchema = z.string().regex(/^[A-F0-9]{64}$/);
const SafeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const NearWalletAuthorizationSessionBaseSchema = z.object({
  version: z.literal(SESSION_VERSION),
  session_scope: SafeIdSchema,
  principal_authorization: NearPrincipalAuthorizationSchema,
  connection: NearWalletConnectionSchema,
  issued_at_ms: z.number().int().nonnegative(),
  expires_at_ms: z.number().int().positive(),
  authorization_tag: HexDigestSchema,
}).strict();

export const NearWalletAuthorizationSessionSchema =
  NearWalletAuthorizationSessionBaseSchema.superRefine((session, context) => {
    if (session.expires_at_ms <= session.issued_at_ms) {
      context.addIssue({
        code: "custom",
        path: ["expires_at_ms"],
        message: "session expiry must follow issuance",
      });
    }
    if (session.expires_at_ms - session.issued_at_ms > SESSION_TTL_MS) {
      context.addIssue({
        code: "custom",
        path: ["expires_at_ms"],
        message: "session lifetime exceeds the supported maximum",
      });
    }
    if (
      session.principal_authorization.account_id !== session.connection.account_id ||
      session.principal_authorization.network !== session.connection.network
    ) {
      context.addIssue({
        code: "custom",
        path: ["principal_authorization"],
        message: "principal authorization must match the wallet connection",
      });
    }
    if (!session.principal_authorization.operations.includes("near.intents.approval.review")) {
      context.addIssue({
        code: "custom",
        path: ["principal_authorization", "operations"],
        message: "principal authorization must allow approval review",
      });
    }
  });

export type NearWalletAuthorizationSession = z.infer<
  typeof NearWalletAuthorizationSessionSchema
>;

export type NearWalletAuthorizationErrorCode =
  | "SESSION_INVALID"
  | "SESSION_EXPIRED"
  | "SESSION_ATTESTATION_INVALID"
  | "PRINCIPAL_AUTHORIZATION_INVALID"
  | "EXECUTION_DISABLED"
  | "WALLET_CAPABILITY_MISSING"
  | "NETWORK_MISMATCH"
  | "ACCOUNT_MISMATCH"
  | "PRINCIPAL_MISMATCH"
  | "APPROVAL_INVALID"
  | "APPROVAL_DIGEST_MISMATCH"
  | "APPROVAL_EXPIRED";

export class NearWalletAuthorizationError extends Error {
  constructor(
    readonly code: NearWalletAuthorizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NearWalletAuthorizationError";
  }
}

type SessionWithoutTag = Omit<NearWalletAuthorizationSession, "authorization_tag">;

function requireSecret(secret: string): string {
  if (secret.trim().length < 32) {
    throw new NearWalletAuthorizationError(
      "SESSION_INVALID",
      "The NEAR wallet-session secret is unavailable.",
    );
  }
  return secret.trim();
}

function hmac(secret: string, domain: string, parts: readonly string[]): string {
  const digest = createHmac("sha256", requireSecret(secret));
  digest.update(domain, "utf8");
  for (const part of parts) {
    digest.update("\0", "utf8");
    digest.update(part, "utf8");
  }
  return digest.digest("hex").toUpperCase();
}

function sessionScope(input: Readonly<{
  connection: NearWalletConnection;
  principalAuthorization: NearPrincipalAuthorization;
  issuedAt: number;
  expiresAt: number;
  sessionSecret: string;
}>): string {
  return `near_session_${hmac(
    input.sessionSecret,
    "pilot.near-wallet.session-scope.v1",
    [
      input.principalAuthorization.authorization_id,
      input.principalAuthorization.principal_id,
      input.connection.connection_id,
      input.connection.provider_id,
      input.connection.account_id,
      input.connection.network,
      String(input.issuedAt),
      String(input.expiresAt),
    ],
  ).slice(0, 32)}`;
}

function sessionTag(session: SessionWithoutTag, secret: string): string {
  return hmac(secret, "pilot.near-wallet.session-attestation.v1", [
    session.version,
    session.session_scope,
    session.principal_authorization.version,
    session.principal_authorization.authorization_id,
    session.principal_authorization.principal_id,
    session.principal_authorization.account_id,
    session.principal_authorization.network,
    session.principal_authorization.operations.join(","),
    session.principal_authorization.issued_at,
    session.principal_authorization.expires_at,
    session.connection.connection_id,
    session.connection.provider_id,
    session.connection.account_id,
    session.connection.network,
    session.connection.connected_at,
    session.connection.capabilities.sign_message ? "1" : "0",
    session.connection.capabilities.sign_transaction ? "1" : "0",
    session.connection.capabilities.sign_and_send_transaction ? "1" : "0",
    String(session.issued_at_ms),
    String(session.expires_at_ms),
  ]);
}

function exactDigest(left: string, right: string): boolean {
  if (!HexDigestSchema.safeParse(left).success || !HexDigestSchema.safeParse(right).success) {
    return false;
  }
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Called only after the server has authenticated the Pilot principal and
 * verified wallet control. Both inputs must come from server-side evidence,
 * never directly from client claims. This creates a tamper-evident,
 * short-lived binding; it does not itself perform either proof.
 */
export function createNearWalletAuthorizationSession(input: Readonly<{
  serverPrincipalAuthorization: unknown;
  verifiedConnection: unknown;
  sessionSecret: string;
  now?: number;
  ttlMs?: number;
}>): NearWalletAuthorizationSession {
  const parsedConnection = NearWalletConnectionSchema.safeParse(input.verifiedConnection);
  const parsedPrincipalAuthorization = NearPrincipalAuthorizationSchema.safeParse(
    input.serverPrincipalAuthorization,
  );
  if (!parsedConnection.success || !parsedPrincipalAuthorization.success) {
    throw new NearWalletAuthorizationError(
      "PRINCIPAL_AUTHORIZATION_INVALID",
      "The server principal authorization or verified wallet connection is invalid.",
    );
  }
  const connection = parsedConnection.data;
  const principalAuthorization = parsedPrincipalAuthorization.data;
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? SESSION_TTL_MS;
  if (
    !Number.isSafeInteger(now) || now < 0 ||
    !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > SESSION_TTL_MS
  ) {
    throw new NearWalletAuthorizationError(
      "SESSION_INVALID",
      "The NEAR wallet-session lifetime is invalid.",
    );
  }
  const authorizationIssuedAt = Date.parse(principalAuthorization.issued_at);
  const authorizationExpiresAt = Date.parse(principalAuthorization.expires_at);
  if (
    principalAuthorization.account_id !== connection.account_id ||
    principalAuthorization.network !== connection.network ||
    !principalAuthorization.operations.includes("near.intents.approval.review") ||
    authorizationIssuedAt > now ||
    authorizationExpiresAt <= now
  ) {
    throw new NearWalletAuthorizationError(
      "PRINCIPAL_AUTHORIZATION_INVALID",
      "The server principal authorization does not match this active wallet session.",
    );
  }
  const requestedExpiresAt = now + ttlMs;
  if (!Number.isSafeInteger(requestedExpiresAt)) {
    throw new NearWalletAuthorizationError(
      "SESSION_INVALID",
      "The NEAR wallet-session expiry is invalid.",
    );
  }
  const expiresAt = Math.min(requestedExpiresAt, authorizationExpiresAt);
  const unsigned: SessionWithoutTag = {
    version: SESSION_VERSION,
    session_scope: sessionScope({
      connection,
      principalAuthorization,
      issuedAt: now,
      expiresAt,
      sessionSecret: input.sessionSecret,
    }),
    principal_authorization: principalAuthorization,
    connection,
    issued_at_ms: now,
    expires_at_ms: expiresAt,
  };
  return NearWalletAuthorizationSessionSchema.parse({
    ...unsigned,
    authorization_tag: sessionTag(unsigned, input.sessionSecret),
  });
}

export type AuthorizedNearApproval = Readonly<{
  binding: NearApprovalBinding;
  approval_digest: string;
  principal_id: string;
  session_scope: string;
  account_id: string;
  provider_id: string;
  connection_id: string;
}>;

/**
 * Server-only boundary between an exact approval review and the configured
 * owner-signing integration. The principal authorization is non-execution
 * authority; explicit runtime policy is still required. No provider or wallet
 * call occurs here.
 */
export async function authorizeNearApprovalForSession(input: Readonly<{
  session: unknown;
  binding: unknown;
  approvalDigest: unknown;
  executionPolicy?: NearWalletExecutionPolicy;
  sessionSecret: string;
  now?: number;
}>): Promise<AuthorizedNearApproval> {
  const parsedSession = NearWalletAuthorizationSessionBaseSchema.safeParse(input.session);
  if (!parsedSession.success) {
    throw new NearWalletAuthorizationError(
      "SESSION_INVALID",
      "The NEAR wallet authorization session is invalid.",
    );
  }
  const session = parsedSession.data;
  const { authorization_tag: tag, ...unsigned } = session;
  const expectedTag = sessionTag(unsigned, input.sessionSecret);
  if (!exactDigest(tag, expectedTag)) {
    throw new NearWalletAuthorizationError(
      "SESSION_ATTESTATION_INVALID",
      "The NEAR wallet authorization session was modified.",
    );
  }
  if (!NearWalletAuthorizationSessionSchema.safeParse(session).success) {
    throw new NearWalletAuthorizationError(
      "SESSION_INVALID",
      "The NEAR wallet authorization session binding is invalid.",
    );
  }
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new NearWalletAuthorizationError(
      "SESSION_INVALID",
      "The NEAR wallet authorization time is invalid.",
    );
  }
  if (session.expires_at_ms <= now) {
    throw new NearWalletAuthorizationError(
      "SESSION_EXPIRED",
      "The NEAR wallet authorization session expired.",
    );
  }
  if (
    Date.parse(session.principal_authorization.issued_at) > now ||
    Date.parse(session.principal_authorization.expires_at) <= now
  ) {
    throw new NearWalletAuthorizationError(
      "PRINCIPAL_AUTHORIZATION_INVALID",
      "The server principal authorization is not active.",
    );
  }

  const policy = NearWalletExecutionPolicySchema.parse(input.executionPolicy ?? {});
  if (policy.mode !== "owner-approval" || policy.mainnet_execution_enabled !== true) {
    throw new NearWalletAuthorizationError(
      "EXECUTION_DISABLED",
      "NEAR execution remains disabled for this server runtime.",
    );
  }
  if (session.connection.capabilities.sign_message !== true) {
    throw new NearWalletAuthorizationError(
      "WALLET_CAPABILITY_MISSING",
      "The verified NEAR wallet session cannot sign the required intent message.",
    );
  }

  const parsedBinding = NearApprovalBindingSchema.safeParse(input.binding);
  if (!parsedBinding.success || typeof input.approvalDigest !== "string") {
    throw new NearWalletAuthorizationError(
      "APPROVAL_INVALID",
      "The NEAR approval binding is invalid.",
    );
  }
  const binding = parsedBinding.data;
  if (binding.network !== session.connection.network) {
    throw new NearWalletAuthorizationError(
      "NETWORK_MISMATCH",
      "The NEAR approval network does not match the authenticated wallet session.",
    );
  }
  if (binding.account_id !== session.connection.account_id) {
    throw new NearWalletAuthorizationError(
      "ACCOUNT_MISMATCH",
      "The NEAR approval account does not match the authenticated wallet session.",
    );
  }
  const expectedPrincipal = session.principal_authorization.principal_id;
  if (binding.principal_id !== expectedPrincipal) {
    throw new NearWalletAuthorizationError(
      "PRINCIPAL_MISMATCH",
      "The NEAR approval principal does not match the authenticated wallet account.",
    );
  }
  const expectedDigest = await computeNearApprovalDigest(binding);
  if (!exactDigest(input.approvalDigest, expectedDigest)) {
    throw new NearWalletAuthorizationError(
      "APPROVAL_DIGEST_MISMATCH",
      "The NEAR approval digest does not match the exact principal-bound binding.",
    );
  }
  if (
    Date.parse(binding.approval_expires_at) <= now ||
    Date.parse(binding.provider_deadline_at) <= now
  ) {
    throw new NearWalletAuthorizationError(
      "APPROVAL_EXPIRED",
      "The NEAR approval or provider deadline was reached.",
    );
  }

  return Object.freeze({
    binding,
    approval_digest: expectedDigest,
    principal_id: expectedPrincipal,
    session_scope: session.session_scope,
    account_id: session.connection.account_id,
    provider_id: session.connection.provider_id,
    connection_id: session.connection.connection_id,
  });
}

