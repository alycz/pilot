import { describe, expect, it, vi } from "vitest";

import { nearNativeExecutableReviewQuote } from "../test/near-executable-review-fixture";
import { createNearNativeLiveClient } from "./near-native-live-client";

const NONCE = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const PROOF = {
  account_id: "alice.near",
  public_key: `ed25519:${"B".repeat(44)}`,
  signature: `${"A".repeat(86)}==`,
};

function responseFor(path: string) {
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
    execution_enabled: false,
    manual_owner_funding_only: true,
  };
}

describe("native NEAR live same-origin client", () => {
  it("posts the exact bootstrap, proof, verify, and separate approval bodies", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(responseFor(String(input))));
    const client = createNearNativeLiveClient(fetchImpl as typeof fetch);
    const quote = nearNativeExecutableReviewQuote();

    await client.bootstrap("alice.near");
    await client.genericChallenge();
    await client.upgradeSession(PROOF);
    await client.quoteChallenge(quote);
    await client.verifyQuoteProof(quote, PROOF);
    await client.approveAndReserve(quote);

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
    ]);
    expect(calls[0]?.body).toEqual({
      bootstrap: true,
      account_id: "alice.near",
      network: "near:mainnet",
    });
    expect(calls[2]?.body).toEqual(PROOF);
    expect(calls[4]?.body).toEqual({ quote_binding: quote, proof: PROOF });
    expect(calls[5]?.body).toEqual({ owner_confirmed: true, quote_binding: quote });
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
