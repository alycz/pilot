import {
  computeNearApprovalDigest,
  type NearApprovalBinding,
  type NearPrincipalAuthorization,
  type NearWalletConnection,
} from "@pilot/contracts";
import { describe, expect, it } from "vitest";

import {
  NearWalletAuthorizationError,
  authorizeNearApprovalForSession,
  createNearWalletAuthorizationSession,
} from "./near-wallet-authorization";

const SECRET = "pilot-near-wallet-session-secret-for-focused-tests";
const NOW = Date.parse("2098-01-01T00:00:00.000Z");
const EXECUTION_POLICY = {
  mode: "owner-approval" as const,
  mainnet_execution_enabled: true,
};

function connection(accountId: string): NearWalletConnection {
  return {
    connection_id: `connection-${accountId}`,
    provider_id: "test-wallet-provider",
    account_id: accountId,
    network: "near:mainnet",
    connected_at: "2097-12-31T23:59:00.000Z",
    capabilities: {
      sign_message: true,
      sign_transaction: false,
      sign_and_send_transaction: false,
    },
  };
}

function principalAuthorization(
  principalId: string,
  accountId: string,
  input: Partial<NearPrincipalAuthorization> = {},
): NearPrincipalAuthorization {
  return {
    version: "pilot-near-principal-authorization-v1",
    authorization_id: `authorization-${principalId}`,
    principal_id: principalId,
    account_id: accountId,
    network: "near:mainnet",
    operations: ["near.intents.approval.review"],
    issued_at: "2097-12-31T23:58:00.000Z",
    expires_at: "2098-01-01T00:30:00.000Z",
    ...input,
  };
}

function approval(
  principalId: string,
  accountId: string,
  input: Partial<NearApprovalBinding> = {},
): NearApprovalBinding {
  return {
    version: "pilot-near-1click-approval-v2",
    principal_id: principalId,
    account_id: accountId,
    network: "near:mainnet",
    idempotency_version: "pilot-near-idempotency-v1",
    idempotency_key: `attempt-${accountId}`,
    policy_digest: "A".repeat(64),
    quote_id: `quote-${accountId}`,
    quote_hash: "B".repeat(44),
    provider_signature_verified: true,
    origin_asset: "nep141:input.example",
    destination_asset: "nep141:output.example",
    amount_in: "100",
    min_amount_out: "90",
    recipient: accountId,
    refund_to: accountId,
    deposit_address: "provider-deposit-address",
    approval_expires_at: "2098-01-01T00:05:00.000Z",
    provider_deadline_at: "2098-01-01T00:10:00.000Z",
    ...input,
  };
}

async function exactRequest(
  accountId = "alice.near",
  principalId = `principal-${accountId}`,
) {
  const session = createNearWalletAuthorizationSession({
    serverPrincipalAuthorization: principalAuthorization(principalId, accountId),
    verifiedConnection: connection(accountId),
    sessionSecret: SECRET,
    now: NOW,
  });
  const binding = approval(session.principal_authorization.principal_id, accountId);
  return {
    session,
    binding,
    approvalDigest: await computeNearApprovalDigest(binding),
    executionPolicy: EXECUTION_POLICY,
    sessionSecret: SECRET,
    now: NOW,
  };
}

describe("server-side NEAR wallet authorization", () => {
  it("authorizes only the exact principal and wallet account binding", async () => {
    const request = await exactRequest();
    await expect(authorizeNearApprovalForSession(request)).resolves.toEqual(
      expect.objectContaining({
        principal_id: request.session.principal_authorization.principal_id,
        account_id: "alice.near",
        session_scope: request.session.session_scope,
      }),
    );
  });

  it("keeps execution disabled when no explicit runtime policy is supplied", async () => {
    const { executionPolicy: _policy, ...request } = await exactRequest();
    await expect(authorizeNearApprovalForSession(request)).rejects.toMatchObject({
      code: "EXECUTION_DISABLED",
    });
  });

  it("denies a valid approval from another principal", async () => {
    const alice = await exactRequest("alice.near");
    const bob = await exactRequest("bob.near");
    const crossPrincipal = approval(
      bob.session.principal_authorization.principal_id,
      "alice.near",
    );

    await expect(authorizeNearApprovalForSession({
      ...alice,
      binding: crossPrincipal,
      approvalDigest: await computeNearApprovalDigest(crossPrincipal),
    })).rejects.toMatchObject({ code: "PRINCIPAL_MISMATCH" });
  });

  it("denies cross-user reuse even when that other user's digest is exact", async () => {
    const alice = await exactRequest("alice.near");
    const bob = await exactRequest("bob.near");

    await expect(authorizeNearApprovalForSession({
      ...bob,
      binding: alice.binding,
      approvalDigest: alice.approvalDigest,
    })).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });

  it("denies an account changed inside an attested wallet session", async () => {
    const request = await exactRequest();
    const tampered = {
      ...request.session,
      connection: {
        ...request.session.connection,
        account_id: "mallory.near",
      },
    };

    await expect(authorizeNearApprovalForSession({
      ...request,
      session: tampered,
    })).rejects.toMatchObject({ code: "SESSION_ATTESTATION_INVALID" });
  });

  it("denies an expired server wallet session", async () => {
    const request = await exactRequest();
    await expect(authorizeNearApprovalForSession({
      ...request,
      now: request.session.expires_at_ms,
    })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("does not create a wallet session beyond the one-hour bound", () => {
    expect(() => createNearWalletAuthorizationSession({
      serverPrincipalAuthorization: principalAuthorization(
        "principal-alice",
        "alice.near",
      ),
      verifiedConnection: connection("alice.near"),
      sessionSecret: SECRET,
      now: NOW,
      ttlMs: 60 * 60 * 1_000 + 1,
    })).toThrow(NearWalletAuthorizationError);
  });

  it("denies a server principal authorization mapped to another account", () => {
    try {
      createNearWalletAuthorizationSession({
        serverPrincipalAuthorization: principalAuthorization(
          "principal-alice",
          "bob.near",
        ),
        verifiedConnection: connection("alice.near"),
        sessionSecret: SECRET,
        now: NOW,
      });
      throw new Error("expected the cross-account authorization to be denied");
    } catch (error) {
      expect(error).toMatchObject({ code: "PRINCIPAL_AUTHORIZATION_INVALID" });
    }
  });

  it("caps the wallet session to the server principal authorization expiry", () => {
    const authorizationExpiresAt = NOW + 5 * 60 * 1_000;
    const session = createNearWalletAuthorizationSession({
      serverPrincipalAuthorization: principalAuthorization(
        "principal-alice",
        "alice.near",
        { expires_at: new Date(authorizationExpiresAt).toISOString() },
      ),
      verifiedConnection: connection("alice.near"),
      sessionSecret: SECRET,
      now: NOW,
      ttlMs: 30 * 60 * 1_000,
    });

    expect(session.expires_at_ms).toBe(authorizationExpiresAt);
  });
});
