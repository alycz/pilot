import { describe, expect, it, vi } from "vitest";
import {
  NearNativeNearToArbitrumUsdcReserveRequestSchema,
  computeNearNativeNearToArbitrumUsdcApprovalDigest,
} from "@pilot/contracts/near";

import { nearNativeExecutableReviewQuote } from "../test/near-executable-review-fixture";
import { createNearNativeLiveClient } from "./near-native-live-client";

const NONCE = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const PROOF = {
  account_id: "alice.near",
  public_key: `ed25519:${"B".repeat(44)}`,
  signature: `${"A".repeat(86)}==`,
};

async function reconciliationContext() {
  const quote = nearNativeExecutableReviewQuote();
  const payload = {
    version: "pilot-near-native-near-to-arbitrum-usdc-approval-payload-v1" as const,
    route: quote.route,
    principal_id: "principal-alice",
    near_account_id: "alice.near",
    network: "near:mainnet" as const,
    policy_digest: "A".repeat(64),
    quote_hash: quote.quote_hash,
    correlation_id: quote.correlation_id,
    origin_asset_id: quote.route.origin_asset_id,
    destination_asset_id: quote.route.destination_asset_id,
    amount_in: quote.amount_in,
    min_amount_out: quote.min_amount_out,
    recipient: quote.recipient,
    refund_to: quote.refund_to,
    deposit_address: quote.deposit_address,
    deposit_memo_present: false as const,
    provider_deadline_at: quote.provider_deadline_at,
    approved_at: "2098-01-01T00:00:01.000Z",
    approval_expires_at: quote.approval_expires_at,
    reservation: {
      version:
        "pilot-near-native-near-to-arbitrum-usdc-reservation-v1" as const,
      reservation_id: "reservation-1",
      attempt_id: "attempt-1",
      principal_id: "principal-alice",
      near_account_id: "alice.near",
      network: "near:mainnet" as const,
      idempotency_version: "pilot-near-idempotency-v1" as const,
      idempotency_key: "idempotency-1",
      request_digest: "B".repeat(64),
      asset_id: quote.route.origin_asset_id,
      amount_atomic: quote.amount_in,
      expected_revision: 0,
      reserved_revision: 1,
    },
  };
  const approvalDigest = await
    computeNearNativeNearToArbitrumUsdcApprovalDigest(payload);
  return NearNativeNearToArbitrumUsdcReserveRequestSchema.parse({
    version: "pilot-near-native-to-arbitrum-usdc-reserve-request-v1",
    quote_binding: quote,
    approval: {
      version: "pilot-near-native-near-to-arbitrum-usdc-economic-approval-v1",
      payload,
      approval_digest: approvalDigest,
      account_control: {
        version: "pilot-near-account-control-proof-v1",
        proof_kind: "nep413",
        scope: "source-account-control-only",
        grants_economic_transfer_approval: false,
        authorization_id: "authorization-alice",
        principal_id: "principal-alice",
        near_account_id: "alice.near",
        network: "near:mainnet",
        verified_at: "2098-01-01T00:00:00.000Z",
      },
      economic_approval: {
        approval_id: "approval-1",
        method: "owner-reviewed-native-near-transfer",
        owner_confirmed: true,
        approved_payload_digest: approvalDigest,
        confirmed_at: payload.approved_at,
      },
    },
    idempotency_version: "pilot-near-idempotency-v1",
    idempotency_key: "idempotency-1",
    attempt_id: "attempt-1",
    reservation_id: "reservation-1",
  });
}

async function responseFor(path: string) {
  const quote = nearNativeExecutableReviewQuote();
  if (path.endsWith("/bootstrap")) return {
    preauthorized: true,
    account_id: "alice.near",
    network: "near:mainnet",
    operations: ["near.intents.approval.review"],
    expires_at: "2098-01-01T00:05:00.000Z",
    wallet_control_verified: false,
    execution_enabled: false,
  };
  if (path.endsWith("/challenge") && !path.includes("executable-review")) return {
    account_id: "alice.near",
    network: "near:mainnet",
    provider: "nep413-full-access-key",
    expires_at: "2098-01-01T00:05:00.000Z",
    sign_message: { message: "bootstrap", nonce: NONCE, recipient: "pilot.near" },
    verification_available: true,
    execution_enabled: false,
  };
  if (path.endsWith("/session")) return {
    authenticated: true,
    wallet_control_verified: true,
    account_id: "alice.near",
    network: "near:mainnet",
    authorization_upgraded: true,
    operations: [
      "near.intents.approval.review",
      "near.intents.executable-quote.review",
      "near.intents.status",
      "near.intents.owner-funded.reserve",
      "near.intents.owner-funded.reconcile",
    ],
    execution_enabled: false,
  };
  if (path.endsWith("/executable-review/challenge")) return {
    account_id: "alice.near",
    network: "near:mainnet",
    operation: "near.intents.executable-quote.review",
    quote_digest: "a".repeat(64),
    expires_at: "2098-01-01T00:05:00.000Z",
    sign_message: {
      message: "quote-bound",
      message_digest: "b".repeat(64),
      nonce: NONCE,
      recipient: "pilot.near",
    },
    execution_enabled: false,
  };
  if (path.endsWith("/executable-review/verify")) return {
    authenticated: true,
    wallet_control_verified: true,
    account_id: "alice.near",
    network: "near:mainnet",
    operation: "near.intents.executable-quote.review",
    quote_digest: "a".repeat(64),
    execution_enabled: false,
  };
  if (path.endsWith("/owner-funded/reconcile")) return {
    version: "pilot-near-native-to-arbitrum-usdc-reconcile-result-v1",
    stage: "source-funding",
    action: "source-verified",
    attempt_id: "attempt-1",
    lifecycle_state: "source_verified",
    attempt_revision: 2,
    lifecycle_revision: 1,
    source_transaction_hash: "B".repeat(44),
    safe_to_resubmit: false,
    execution_enabled: false,
  };
  return {
    approved: true,
    reserved: true,
    action: "reserved",
    replayed_existing: false,
    approval_digest: "C".repeat(64),
    reservation_id: "reservation-1",
    attempt_id: "attempt-1",
    idempotency_key: "idempotency-1",
    funding_instructions: {
      version: "pilot-near-native-near-to-arbitrum-usdc-funding-instructions-v1",
      route_version: "pilot-near-native-to-arbitrum-usdc-route-v1",
      funding_method: "manual-native-near-transfer",
      network: "near:mainnet",
      quote_hash: quote.quote_hash,
      correlation_id: quote.correlation_id,
      source_account_id: "alice.near",
      refund_account_id: quote.refund_to,
      destination_recipient: quote.recipient,
      deposit_account_id: quote.deposit_address,
      deposit_memo_present: false,
      amount_yocto_near: quote.amount_in,
      provider_deadline_at: quote.provider_deadline_at,
    },
    reconciliation_context: await reconciliationContext(),
    execution_enabled: false,
    manual_owner_funding_only: true,
  };
}

describe("native NEAR live same-origin client", () => {
  it("posts the exact bootstrap, proof, verify, and separate approval bodies", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(await responseFor(String(input))));
    const client = createNearNativeLiveClient(fetchImpl as typeof fetch);
    const quote = nearNativeExecutableReviewQuote();

    await client.bootstrap("alice.near");
    await client.genericChallenge();
    await client.upgradeSession(PROOF);
    await client.quoteChallenge(quote);
    await client.verifyQuoteProof(quote, PROOF);
    const approval = await client.approveAndReserve(quote);
    await client.reconcile({
      context: approval.reconciliation_context,
      stage: "source-funding",
      transitionId: "source-owner-report-1",
      expectedEntryRevision: 1,
      nearTransactionHash: "B".repeat(44),
    });

    const calls = fetchImpl.mock.calls.map(([path, init]) => ({
      path,
      init,
      body: JSON.parse(String(init?.body)),
    }));
    expect(calls.map(({ path }) => path)).toEqual([
      "/api/auth/near/bootstrap",
      "/api/auth/near/challenge",
      "/api/auth/near/session",
      "/api/auth/near/executable-review/challenge",
      "/api/auth/near/executable-review/verify",
      "/api/auth/near/executable-review/approve",
      "/api/auth/near/owner-funded/reconcile",
    ]);
    expect(calls[0]?.body).toEqual({
      bootstrap: true,
      account_id: "alice.near",
      network: "near:mainnet",
    });
    expect(calls[2]?.body).toEqual(PROOF);
    expect(calls[4]?.body).toEqual({ quote_binding: quote, proof: PROOF });
    expect(calls[5]?.body).toEqual({ owner_confirmed: true, quote_binding: quote });
    expect(calls[6]?.body).toMatchObject({
      reconciliation_context: approval.reconciliation_context,
      stage: "source-funding",
      transition_id: "source-owner-report-1",
      expected_entry_revision: 1,
      near_transaction_hash: "B".repeat(44),
    });
    for (const { init } of calls) {
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
    }
  });

  it("fails closed on server errors and invalid success payloads", async () => {
    const denied = createNearNativeLiveClient(vi.fn(async () =>
      Response.json({ error: "bootstrap disabled" }, { status: 503 })) as typeof fetch);
    await expect(denied.bootstrap("alice.near")).rejects.toThrow("bootstrap disabled");

    const invalid = createNearNativeLiveClient(vi.fn(async () =>
      Response.json({ preauthorized: true })) as typeof fetch);
    await expect(invalid.bootstrap("alice.near")).rejects.toThrow("strict validation");
  });

  it.each([
    ["missing", undefined],
    ["lying", "2"],
  ] as const)("bounds a streamed response with %s Content-Length", async (_label, declared) => {
    const chunk = new Uint8Array(128 * 1_024).fill(65);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(Uint8Array.of(65));
        controller.close();
      },
    });
    const client = createNearNativeLiveClient(vi.fn(async () => new Response(body, {
      headers: declared === undefined ? {} : { "content-length": declared },
    })) as typeof fetch);

    await expect(client.bootstrap("alice.near")).rejects.toThrow(
      "response was too large",
    );
  });

  it("aborts on caller cancellation and bounds every POST timeout", async () => {
    const pendingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(
          new DOMException("aborted", "AbortError"),
        ), { once: true });
      }));
    const controller = new AbortController();
    const cancelled = createNearNativeLiveClient(pendingFetch as typeof fetch, {
      timeoutMs: 100,
    }).bootstrap("alice.near", controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    const timedOut = createNearNativeLiveClient(pendingFetch as typeof fetch, {
      timeoutMs: 5,
    }).genericChallenge();
    await expect(timedOut).rejects.toThrow("timed out");
    expect(pendingFetch.mock.calls.at(-1)?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
