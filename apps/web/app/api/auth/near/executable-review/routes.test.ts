import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import type {
  NearNativeNearToArbitrumUsdcReserveRequest,
} from "@pilot/contracts/near";

import {
  NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE,
  type NearExecutableReviewQuoteBinding,
} from "../../../../../lib/near-executable-review-proof";
import {
  NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE,
  nearExecutableReviewAttestationResponseHeaders,
} from "../../../../../lib/near-executable-review-attestation";
import {
  createNearExecutableReviewChallengeHandler,
  createNearExecutableReviewApproveHandler,
  createNearExecutableReviewVerifyHandler,
} from "../../../../../lib/near-executable-review-handler";
import {
  createNearOwnerFundedReconcileHandler,
} from "../../../../../lib/near-owner-funded-reconcile-handler";
import {
  NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE,
} from "../../../../../lib/near-executable-review-wallet-control";
import {
  NEAR_PRINCIPAL_AUTHORIZATION_COOKIE,
  sealNearPrincipalAuthorization,
} from "../../../../../lib/near-wallet-proof";
import {
  nearExecutableReviewAuthorization,
  nearExecutableReviewQuote,
  nearNativeExecutableReviewQuote,
} from "../../../../../test/near-executable-review-fixture";

const NOW = Date.parse("2098-01-01T00:00:00.000Z");
const SESSION_SECRET =
  "near-executable-review-route-secret-over-thirty-two-characters";
const ENVIRONMENT = {
  HARBOR_API_KEY: "pilot:separate-broad-key-value-1234567890",
  HARBOR_URL: "https://harbor.example",
  NEXT_PUBLIC_DEV_SIGNER: "0",
  PILOT_DEPLOYMENT_PROFILE: "hosted",
  PILOT_HOSTED_STATE_API_KEY: "state:dedicated-state-key-value-1234567890",
  PILOT_NEAR_WALLET_PROOF_MODE: "verify",
  PILOT_NEAR_WALLET_PROOF_PROVIDER: "nep413-full-access-key",
  PILOT_NEAR_WALLET_PROOF_RECIPIENT: "pilot.near",
  PILOT_NEAR_OWNER_FUNDED_APPROVAL_ENABLED: "true",
  PILOT_NEAR_OWNER_FUNDED_POLICY_DIGEST: "A".repeat(64),
  PILOT_PUBLIC_ORIGIN: "https://pilot.example",
  SESSION_SECRET,
};
const NONCE = Buffer.alloc(32, 9).toString("base64url");
const WALLET_CONTROL_NONCE = Buffer.alloc(32, 7).toString("base64url");

function request(
  path: string,
  body: unknown,
  cookies: Record<string, string> = {},
  origin = "https://pilot.example",
): NextRequest {
  return new NextRequest(`https://pilot.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "pilot.example",
      origin,
      cookie: Object.entries(cookies)
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join("; "),
    },
    body: JSON.stringify(body),
  });
}

function principalCookie() {
  return sealNearPrincipalAuthorization(
    nearExecutableReviewAuthorization(),
    ENVIRONMENT,
  );
}

function quoteAttestationCookie(
  principal: string,
  quote: NearExecutableReviewQuoteBinding = nearExecutableReviewQuote(),
): string {
  const requestWithPrincipal = request(
    "/api/harbor/near.intents.executable-quote.review",
    {},
    { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal },
  );
  const headers = nearExecutableReviewAttestationResponseHeaders(
    requestWithPrincipal,
    "near.intents.executable-quote.review",
    {
      route: quote.version === "pilot-near-native-to-arbitrum-usdc-quote-binding-v1"
        ? "near-native-to-arbitrum-usdc-v1"
        : "arbitrum-usdc-to-near-wnear-v1",
      amount_atomic: quote.amount_in,
      slippage_bps: quote.request_echo.slippageTolerance,
      recipient: quote.recipient,
      refund_to: quote.refund_to,
      refund_deadline: quote.request_echo.deadline,
      quote_waiting_time_ms: quote.request_echo.quoteWaitingTimeMs,
    },
    new TextEncoder().encode(JSON.stringify({
      ok: true,
      data: {
        source: "live",
        provider_signature_verified: true,
        route: quote.route,
        quote_hash: quote.quote_hash,
        quote_binding: quote,
      },
    })).buffer,
    200,
    { environment: ENVIRONMENT, now: NOW },
  );
  const cookie = headers["set-cookie"]?.match(
    new RegExp(`${NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE}=([^;]+)`),
  )?.[1];
  if (!cookie) throw new Error("missing quote attestation fixture");
  return decodeURIComponent(cookie);
}

async function verifiedWalletControlCookie(input: Readonly<{
  principal?: string;
  quote?: ReturnType<typeof nearNativeExecutableReviewQuote>;
  now?: number;
}> = {}): Promise<string> {
  const now = input.now ?? NOW;
  const principal = input.principal ?? principalCookie();
  const quote = input.quote ?? nearNativeExecutableReviewQuote();
  const challengeHandler = createNearExecutableReviewChallengeHandler({
    environment: ENVIRONMENT,
    clock: () => now,
    nonce: () => NONCE,
    replayProtectionConfigured: () => true,
  });
  const challenge = await challengeHandler(request(
    "/api/auth/near/executable-review/challenge",
    { quote_binding: quote },
    {
      [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal,
      [NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE]:
        quoteAttestationCookie(principal, quote),
    },
  ));
  const challengeCookie = challenge.cookies.get(
    NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE,
  )?.value;
  if (!challengeCookie) throw new Error("missing challenge cookie");
  const verifyHandler = createNearExecutableReviewVerifyHandler({
    environment: ENVIRONMENT,
    clock: () => now + 1,
    walletControlNonce: () => WALLET_CONTROL_NONCE,
    verifier: {
      async verify(value) {
        return {
          accountId: value.accountId,
          publicKey: value.publicKey,
          signatureValid: true,
          fullAccessKeyVerified: true,
        };
      },
    },
    nonceConsumerFactory: () => ({ consume: async () => true }),
  });
  const response = await verifyHandler(request(
    "/api/auth/near/executable-review/verify",
    {
      quote_binding: quote,
      proof: {
        account_id: quote.refund_to,
        public_key: `ed25519:${"B".repeat(44)}`,
        signature: "A".repeat(88),
      },
    },
    {
      [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal,
      [NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE]: challengeCookie,
    },
  ));
  const cookie = response.cookies.get(
    NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE,
  )?.value;
  if (!cookie) throw new Error("missing wallet-control cookie");
  expect(cookie.length).toBeLessThan(3_800);
  return cookie;
}

function durableReservationResult(
  reserveRequest: NearNativeNearToArbitrumUsdcReserveRequest,
) {
  const quote = reserveRequest.quote_binding;
  const payload = reserveRequest.approval.payload;
  return {
    version: "pilot-near-native-to-arbitrum-usdc-reserve-result-v1" as const,
    source: "live" as const,
    provider_signature_verified: true as const,
    admission_id: reserveRequest.approval.economic_approval.approval_id,
    quote_hash: quote.quote_hash,
    correlation_id: quote.correlation_id,
    approval_digest: reserveRequest.approval.approval_digest,
    request_digest: payload.reservation.request_digest,
    idempotency_version: reserveRequest.idempotency_version,
    idempotency_key: reserveRequest.idempotency_key,
    attempt_id: reserveRequest.attempt_id,
    reservation_id: reserveRequest.reservation_id,
    attempt_state: "approved" as const,
    reservation_state: "reserved" as const,
    attempt_revision: 1,
    reservation_revision: 1,
    funding_instructions: {
      version:
        "pilot-near-native-near-to-arbitrum-usdc-funding-instructions-v1" as const,
      route_version: quote.route.version,
      funding_method: "manual-native-near-transfer" as const,
      network: "near:mainnet" as const,
      quote_hash: quote.quote_hash,
      correlation_id: quote.correlation_id,
      source_account_id: payload.near_account_id,
      refund_account_id: quote.refund_to,
      destination_recipient: quote.recipient,
      deposit_account_id: quote.deposit_address,
      deposit_memo_present: false as const,
      amount_yocto_near: quote.amount_in,
      provider_deadline_at: quote.provider_deadline_at,
    },
    execution_enabled: false as const,
    manual_owner_funding_only: true as const,
    action: "reserved" as const,
    replayed_existing: false as const,
  };
}

describe("NEAR executable-review proof routes", () => {
  it("issues and verifies one fresh quote-bound proof without enabling execution", async () => {
    const challengeHandler = createNearExecutableReviewChallengeHandler({
      environment: ENVIRONMENT,
      clock: () => NOW,
      nonce: () => NONCE,
      replayProtectionConfigured: () => true,
    });
    const principal = principalCookie();
    const quote = nearNativeExecutableReviewQuote();
    const quoteAttestation = quoteAttestationCookie(principal, quote);
    const challenge = await challengeHandler(request(
      "/api/auth/near/executable-review/challenge",
      { quote_binding: quote },
      {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal,
        [NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE]: quoteAttestation,
      },
    ));

    expect(challenge.status).toBe(200);
    await expect(challenge.json()).resolves.toMatchObject({
      account_id: "alice.near",
      network: "near:mainnet",
      operation: "near.intents.executable-quote.review",
      execution_enabled: false,
      sign_message: { nonce: NONCE, recipient: "pilot.near" },
    });
    const challengeCookie = challenge.cookies.get(
      NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE,
    )?.value;
    expect(challengeCookie).toBeTruthy();
    expect(challenge.cookies.get(
      NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE,
    )?.value).toBe("");

    const consume = vi.fn(async () => true);
    const verifyHandler = createNearExecutableReviewVerifyHandler({
      environment: ENVIRONMENT,
      clock: () => NOW + 1,
      verifier: {
        async verify(input) {
          return {
            accountId: input.accountId,
            publicKey: input.publicKey,
            signatureValid: true,
            fullAccessKeyVerified: true,
          };
        },
      },
      nonceConsumerFactory: () => ({ consume }),
    });
    const response = await verifyHandler(request(
      "/api/auth/near/executable-review/verify",
      {
        quote_binding: quote,
        proof: {
          account_id: "alice.near",
          public_key: `ed25519:${"B".repeat(44)}`,
          signature: "A".repeat(88),
        },
      },
      {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal,
        [NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE]: challengeCookie ?? "",
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      wallet_control_verified: true,
      account_id: "alice.near",
      operation: "near.intents.executable-quote.review",
      execution_enabled: false,
    });
    expect(consume).toHaveBeenCalledOnce();
    expect(response.cookies.get(NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE)?.value)
      .toBe("");
    expect(response.cookies.get(
      NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE,
    )?.value).toBeTruthy();
  });

  it("never mints a wallet-control approval artifact for the reverse route", async () => {
    const principal = principalCookie();
    const quote = nearExecutableReviewQuote();
    const challengeHandler = createNearExecutableReviewChallengeHandler({
      environment: ENVIRONMENT,
      clock: () => NOW,
      nonce: () => NONCE,
      replayProtectionConfigured: () => true,
    });
    const challenge = await challengeHandler(request(
      "/api/auth/near/executable-review/challenge",
      { quote_binding: quote },
      {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal,
        [NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE]:
          quoteAttestationCookie(principal, quote),
      },
    ));
    const verify = createNearExecutableReviewVerifyHandler({
      environment: ENVIRONMENT,
      clock: () => NOW + 1,
      verifier: {
        async verify(value) {
          return {
            accountId: value.accountId,
            publicKey: value.publicKey,
            signatureValid: true,
            fullAccessKeyVerified: true,
          };
        },
      },
      nonceConsumerFactory: () => ({ consume: async () => true }),
    });
    const response = await verify(request(
      "/api/auth/near/executable-review/verify",
      {
        quote_binding: quote,
        proof: {
          account_id: "alice.near",
          public_key: `ed25519:${"B".repeat(44)}`,
          signature: "A".repeat(88),
        },
      },
      {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal,
        [NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE]: challenge.cookies.get(
          NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE,
        )?.value ?? "",
      },
    ));
    expect(response.status).toBe(200);
    expect(response.cookies.get(
      NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE,
    )?.value).toBe("");
  });

  it("consumes fresh wallet control and exposes funding only after durable reservation", async () => {
    const principal = principalCookie();
    const quote = nearNativeExecutableReviewQuote();
    const proof = await verifiedWalletControlCookie({ principal, quote });
    const consume = vi.fn(async () => true);
    const reserve = vi.fn(async (_name, reserveRequest) => ({
      ok: true as const,
      data: durableReservationResult(reserveRequest),
      asOf: new Date(NOW + 2).toISOString(),
      asOfBasis: "durable-admission-store",
    }));
    const approve = createNearExecutableReviewApproveHandler({
      environment: ENVIRONMENT,
      clock: () => NOW + 2,
      walletControlConsumerFactory: () => ({ consume }),
      reserveClient: { op: reserve },
    });
    const response = await approve(request(
      "/api/auth/near/executable-review/approve",
      { owner_confirmed: true, quote_binding: quote },
      {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal,
        [NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE]: proof,
      },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      approved: true,
      reserved: true,
      execution_enabled: false,
      manual_owner_funding_only: true,
      funding_instructions: {
        source_account_id: "alice.near",
        deposit_account_id: quote.deposit_address,
        amount_yocto_near: quote.amount_in,
      },
      reconciliation_context: {
        version: "pilot-near-native-to-arbitrum-usdc-reserve-request-v1",
        quote_binding: quote,
      },
    });
    expect(consume).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
    expect(reserve.mock.calls[0]?.[0]).toBe("near.intents.owner-funded.reserve");
    expect(reserve.mock.calls[0]?.[1]).toMatchObject({
      quote_binding: quote,
      approval: {
        account_control: {
          grants_economic_transfer_approval: false,
          near_account_id: "alice.near",
        },
        economic_approval: { owner_confirmed: true },
      },
    });
    expect(response.cookies.get(
      NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE,
    )?.value).toBe("");
  });

  it("reaches principal-bound source reconciliation through its dedicated route", async () => {
    const authorization = nearExecutableReviewAuthorization({
      operations: [
        "near.intents.approval.review",
        "near.intents.executable-quote.review",
        "near.intents.status",
        "near.intents.owner-funded.reserve",
        "near.intents.owner-funded.reconcile",
      ],
    });
    const principal = sealNearPrincipalAuthorization(authorization, ENVIRONMENT);
    const quote = nearNativeExecutableReviewQuote();
    const proof = await verifiedWalletControlCookie({ principal, quote });
    const reserve = vi.fn(async (_name, reserveRequest) => ({
      ok: true as const,
      data: durableReservationResult(reserveRequest),
      asOf: new Date(NOW + 2).toISOString(),
      asOfBasis: "durable-admission-store",
    }));
    const approved = await createNearExecutableReviewApproveHandler({
      environment: ENVIRONMENT,
      clock: () => NOW + 2,
      walletControlConsumerFactory: () => ({ consume: async () => true }),
      reserveClient: { op: reserve },
    })(request(
      "/api/auth/near/executable-review/approve",
      { owner_confirmed: true, quote_binding: quote },
      {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal,
        [NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE]: proof,
      },
    ));
    const approvalBody = await approved.json();
    const reconcile = vi.fn(async (_name, input) => ({
      ok: true as const,
      data: {
        version: "pilot-near-native-to-arbitrum-usdc-reconcile-result-v1" as const,
        stage: "source-funding" as const,
        action: "source-verified" as const,
        attempt_id: input.attempt_id,
        lifecycle_state: "source_verified" as const,
        attempt_revision: 2,
        lifecycle_revision: 1,
        source_transaction_hash: "B".repeat(44),
        safe_to_resubmit: false as const,
        execution_enabled: false as const,
      },
      asOf: new Date(NOW + 3).toISOString(),
      asOfBasis: "durable-reconciliation-store",
    }));
    const handler = createNearOwnerFundedReconcileHandler({
      environment: ENVIRONMENT,
      clock: () => NOW + 3,
      reconcileClient: { op: reconcile },
    });
    const response = await handler(request(
      "/api/auth/near/owner-funded/reconcile",
      {
        reconciliation_context: approvalBody.reconciliation_context,
        stage: "source-funding",
        transition_id: "source-owner-report-1",
        expected_entry_revision: 1,
        near_transaction_hash: "B".repeat(44),
      },
      { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      action: "source-verified",
      lifecycle_state: "source_verified",
      source_transaction_hash: "B".repeat(44),
      safe_to_resubmit: false,
      execution_enabled: false,
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls[0]?.[0]).toBe(
      "near.intents.owner-funded.reconcile",
    );
    expect(reconcile.mock.calls[0]?.[1]).toMatchObject({
      account_id: "alice.near",
      stage: "source-funding",
      transition_id: "source-owner-report-1",
      expected_entry_revision: 1,
      near_transaction_hash: "B".repeat(44),
    });

    const foreign = sealNearPrincipalAuthorization(
      nearExecutableReviewAuthorization({
        authorization_id: "authorization-principal-bob",
        principal_id: "principal-bob",
        account_id: "bob.near",
        operations: authorization.operations,
      }),
      ENVIRONMENT,
    );
    const denied = await handler(request(
      "/api/auth/near/owner-funded/reconcile",
      {
        reconciliation_context: approvalBody.reconciliation_context,
        stage: "settlement",
        transition_id: "settlement-foreign-1",
        expected_entry_revision: 2,
      },
      { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: foreign },
    ));
    expect(denied.status).toBe(403);
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("rejects replay, mutation, cross-principal use, expiry, and missing config", async () => {
    const principal = principalCookie();
    const quote = nearNativeExecutableReviewQuote();
    const proof = await verifiedWalletControlCookie({ principal, quote });
    const reserve = vi.fn(async (_name, reserveRequest) => ({
      ok: true as const,
      data: durableReservationResult(reserveRequest),
      asOf: new Date(NOW + 2).toISOString(),
      asOfBasis: "durable-admission-store",
    }));
    const call = async (
      overrides: Readonly<{
        environment?: typeof ENVIRONMENT;
        principal?: string;
        proof?: string;
        quote?: ReturnType<typeof nearNativeExecutableReviewQuote>;
        now?: number;
        consume?: boolean;
      }> = {},
    ) => createNearExecutableReviewApproveHandler({
      environment: overrides.environment ?? ENVIRONMENT,
      clock: () => overrides.now ?? NOW + 2,
      walletControlConsumerFactory: () => ({
        consume: async () => overrides.consume ?? true,
      }),
      reserveClient: { op: reserve },
    })(request(
      "/api/auth/near/executable-review/approve",
      { owner_confirmed: true, quote_binding: overrides.quote ?? quote },
      {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: overrides.principal ?? principal,
        [NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE]:
          overrides.proof ?? proof,
      },
    ));

    const replayed = await call({ consume: false });
    expect(replayed.status).toBe(409);
    expect(JSON.stringify(await replayed.json())).not.toContain("funding_instructions");

    const changed = structuredClone(quote);
    changed.amount_in = "2000000000000000000000000";
    changed.request_echo.amount = changed.amount_in;
    changed.provider_quote_response.quoteRequest.amount = changed.amount_in;
    changed.provider_quote_response.quote.amountIn = changed.amount_in;
    changed.provider_quote_response.quote.minAmountIn = changed.amount_in;
    const mutated = await call({ quote: changed });
    expect(mutated.status).toBe(401);

    const tampered = await call({ proof: `${proof.slice(0, -1)}x` });
    expect(tampered.status).toBe(401);

    const foreignPrincipal = sealNearPrincipalAuthorization(
      nearExecutableReviewAuthorization({
        authorization_id: "authorization-principal-bob",
        principal_id: "principal-bob",
        account_id: "bob.near",
      }),
      ENVIRONMENT,
    );
    const crossPrincipal = await call({ principal: foreignPrincipal });
    expect(crossPrincipal.status).toBe(401);

    const expired = await call({ now: NOW + 2 * 60_000 + 2 });
    expect(expired.status).toBe(401);

    const unconfigured = await call({
      environment: {
        ...ENVIRONMENT,
        PILOT_NEAR_OWNER_FUNDED_APPROVAL_ENABLED: "false",
      },
    });
    expect(unconfigured.status).toBe(503);
    for (
      const response of [
        replayed,
        mutated,
        tampered,
        crossPrincipal,
        expired,
        unconfigured,
      ]
    ) {
      expect(response.cookies.get(
        NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE,
      )?.value).toBe("");
    }
    expect(reserve).not.toHaveBeenCalled();
  });

  it("withholds funding when Harbor is absent or does not confirm exact durable state", async () => {
    const principal = principalCookie();
    const quote = nearNativeExecutableReviewQuote();
    const proof = await verifiedWalletControlCookie({ principal, quote });
    const withoutHarbor = createNearExecutableReviewApproveHandler({
      environment: { ...ENVIRONMENT, HARBOR_API_KEY: undefined },
      clock: () => NOW + 2,
      walletControlConsumerFactory: () => ({ consume: async () => true }),
    });
    const unavailable = await withoutHarbor(request(
      "/api/auth/near/executable-review/approve",
      { owner_confirmed: true, quote_binding: quote },
      {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal,
        [NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE]: proof,
      },
    ));
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await unavailable.json())).not.toContain("funding_instructions");

    const mismatch = createNearExecutableReviewApproveHandler({
      environment: ENVIRONMENT,
      clock: () => NOW + 2,
      walletControlConsumerFactory: () => ({ consume: async () => true }),
      reserveClient: {
        async op(_name, reserveRequest) {
          return {
            ok: true,
            data: {
              ...durableReservationResult(reserveRequest),
              reservation_id: "different-reservation",
            },
            asOf: new Date(NOW + 2).toISOString(),
            asOfBasis: "durable-admission-store",
          };
        },
      },
    });
    const rejected = await mismatch(request(
      "/api/auth/near/executable-review/approve",
      { owner_confirmed: true, quote_binding: quote },
      {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal,
        [NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE]: proof,
      },
    ));
    expect(rejected.status).toBe(503);
    expect(JSON.stringify(await rejected.json())).not.toContain("funding_instructions");
  });

  it("is default-off and requires an explicitly scoped principal", async () => {
    const disabled = createNearExecutableReviewChallengeHandler({
      environment: {
        ...ENVIRONMENT,
        PILOT_NEAR_WALLET_PROOF_MODE: "disabled",
      },
      clock: () => NOW,
      replayProtectionConfigured: () => true,
    });
    const disabledResponse = await disabled(request(
      "/api/auth/near/executable-review/challenge",
      { quote_binding: nearExecutableReviewQuote() },
      { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principalCookie() },
    ));
    expect(disabledResponse.status).toBe(503);

    const unscoped = sealNearPrincipalAuthorization(
      nearExecutableReviewAuthorization({
        operations: ["near.intents.approval.review"],
      }),
      ENVIRONMENT,
    );
    const enabled = createNearExecutableReviewChallengeHandler({
      environment: ENVIRONMENT,
      clock: () => NOW,
      replayProtectionConfigured: () => true,
    });
    const unscopedResponse = await enabled(request(
      "/api/auth/near/executable-review/challenge",
      { quote_binding: nearExecutableReviewQuote() },
      { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: unscoped },
    ));
    expect(unscopedResponse.status).toBe(401);
  });

  it("rejects an unsealed browser-supplied quote", async () => {
    const handler = createNearExecutableReviewChallengeHandler({
      environment: ENVIRONMENT,
      clock: () => NOW,
      replayProtectionConfigured: () => true,
    });
    const response = await handler(request(
      "/api/auth/near/executable-review/challenge",
      { quote_binding: nearExecutableReviewQuote() },
      { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principalCookie() },
    ));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "A current server-attested executable quote is required.",
    });
    const nativeResponse = await handler(request(
      "/api/auth/near/executable-review/challenge",
      { quote_binding: nearNativeExecutableReviewQuote() },
      { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principalCookie() },
    ));
    expect(nativeResponse.status).toBe(401);
    expect(nativeResponse.cookies.get(
      NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE,
    )).toBeUndefined();
  });

  it("rejects a foreign origin before reading proof state", async () => {
    const replayProtectionConfigured = vi.fn(() => true);
    const handler = createNearExecutableReviewChallengeHandler({
      environment: ENVIRONMENT,
      replayProtectionConfigured,
    });
    const response = await handler(request(
      "/api/auth/near/executable-review/challenge",
      { quote_binding: nearExecutableReviewQuote() },
      {},
      "https://evil.example",
    ));
    expect(response.status).toBe(403);
    expect(replayProtectionConfigured).not.toHaveBeenCalled();
  });
});
