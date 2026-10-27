import { describe, expect, it } from "vitest";

import {
  NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE,
  nearExecutableReviewAttestationResponseHeaders,
  readNearExecutableReviewQuoteAttestation,
} from "./near-executable-review-attestation";
import type { NearExecutableReviewQuoteBinding } from "./near-executable-review-proof";
import {
  NEAR_PRINCIPAL_AUTHORIZATION_COOKIE,
  sealNearPrincipalAuthorization,
} from "./near-wallet-proof";
import {
  nearExecutableReviewAuthorization,
  nearExecutableReviewQuote,
  nearNativeExecutableReviewQuote,
} from "../test/near-executable-review-fixture";

const NOW = Date.parse("2098-01-01T00:00:00.000Z");
const ENVIRONMENT = {
  SESSION_SECRET:
    "near-executable-review-attestation-secret-over-thirty-two-characters",
};

function request(cookies: Record<string, string>): Request {
  return new Request("https://pilot.example/api/harbor/near.intents.executable-quote.review", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "pilot.example",
      origin: "https://pilot.example",
      cookie: Object.entries(cookies)
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join("; "),
    },
    body: "{}",
  });
}

function body(value: unknown): ArrayBuffer {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
}

function args(
  quote: NearExecutableReviewQuoteBinding = nearExecutableReviewQuote(),
) {
  return {
    route: quote.version === "pilot-near-native-to-arbitrum-usdc-quote-binding-v1"
      ? "near-native-to-arbitrum-usdc-v1"
      : "arbitrum-usdc-to-near-wnear-v1",
    amount_atomic: quote.amount_in,
    slippage_bps: quote.request_echo.slippageTolerance,
    recipient: quote.recipient,
    refund_to: quote.refund_to,
    refund_deadline: quote.request_echo.deadline,
    quote_waiting_time_ms: quote.request_echo.quoteWaitingTimeMs,
  };
}

function liveEnvelope(
  quote: NearExecutableReviewQuoteBinding = nearExecutableReviewQuote(),
) {
  return {
    ok: true,
    data: {
      source: "live",
      provider_signature_verified: true,
      route: quote.route,
      quote_hash: quote.quote_hash,
      quote_binding: quote,
    },
  };
}

function principal(input = nearExecutableReviewAuthorization()) {
  return sealNearPrincipalAuthorization(input, ENVIRONMENT);
}

function mintedCookie(
  principalCookie: string,
  quote: NearExecutableReviewQuoteBinding = nearExecutableReviewQuote(),
): string {
  const headers = nearExecutableReviewAttestationResponseHeaders(
    request({ [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principalCookie }),
    "near.intents.executable-quote.review",
    args(quote),
    body(liveEnvelope(quote)),
    200,
    { environment: ENVIRONMENT, now: NOW },
  );
  const encoded = headers["set-cookie"]?.match(
    new RegExp(`${NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE}=([^;]+)`),
  )?.[1];
  if (!encoded) throw new Error("missing attestation");
  return decodeURIComponent(encoded);
}

describe("server-sealed executable-review quote attestation", () => {
  it("mints only at the live Harbor response boundary and reopens exact fields", () => {
    const authorization = nearExecutableReviewAuthorization();
    const principalCookie = principal(authorization);
    const quote = nearExecutableReviewQuote();
    const attestationCookie = mintedCookie(principalCookie, quote);
    expect(attestationCookie.length).toBeLessThan(4_000);
    const attestation = readNearExecutableReviewQuoteAttestation(request({
      [NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE]: attestationCookie,
    }), {
      authorization,
      quoteBinding: quote,
      environment: ENVIRONMENT,
      now: NOW + 1,
    });

    expect(attestation).toMatchObject({
      operation: "near.intents.executable-quote.review",
      authorization: {
        principal_id: "principal-alice",
        account_id: "alice.near",
        network: "near:mainnet",
      },
      quote: {
        provider_signature_verified: true,
        quote_hash: quote.quote_hash,
        correlation_id: quote.correlation_id,
        amount_in: quote.amount_in,
        min_amount_out: quote.min_amount_out,
        recipient: quote.recipient,
        refund_to: quote.refund_to,
        deposit_address: quote.deposit_address,
      },
    });
  });

  it("binds native NEAR funding and rejects destination mutation or another principal", () => {
    const authorization = nearExecutableReviewAuthorization();
    const principalCookie = principal(authorization);
    const quote = nearNativeExecutableReviewQuote();
    const attestationCookie = mintedCookie(principalCookie, quote);
    const read = (
      currentAuthorization = authorization,
      quoteBinding = quote,
    ) => readNearExecutableReviewQuoteAttestation(request({
      [NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE]: attestationCookie,
    }), {
      authorization: currentAuthorization,
      quoteBinding,
      environment: ENVIRONMENT,
      now: NOW + 1,
    });

    expect(read()).toMatchObject({
      quote: {
        quote_version: "pilot-near-native-to-arbitrum-usdc-quote-binding-v1",
        origin_asset_id: "nep141:wrap.near",
        destination_asset_id:
          "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
        amount_in: "1000000000000000000000000",
        min_amount_out: "2970000",
        recipient: `0x${"4".repeat(40)}`,
        refund_to: "alice.near",
        deposit_address: "native-deposit.near",
        deposit_memo_present: false,
      },
    });

    expect(read(nearExecutableReviewAuthorization({
      principal_id: "principal-bob",
    }))).toBeNull();

    const mutated = structuredClone(quote);
    mutated.recipient = `0x${"6".repeat(40)}`;
    mutated.request_echo.recipient = mutated.recipient;
    mutated.provider_quote_response.quoteRequest.recipient = mutated.recipient;
    expect(read(authorization, mutated)).toBeNull();
  });

  it.each([
    ["fixture", {
      ok: true,
      data: {
        source: "fixture",
        provider_signature_verified: false,
        local_fixture_id: "fixture-only",
      },
    }],
    ["failed response", liveEnvelope()],
  ])("does not attest a %s result", (_name, envelope) => {
    const principalCookie = principal();
    const headers = nearExecutableReviewAttestationResponseHeaders(
      request({ [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principalCookie }),
      "near.intents.executable-quote.review",
      args(),
      body(envelope),
      _name === "failed response" ? 500 : 200,
      { environment: ENVIRONMENT, now: NOW },
    );
    expect(headers).toEqual({});
  });

  it("rejects tampering, another principal, expiry, and quote mutation", () => {
    const authorization = nearExecutableReviewAuthorization();
    const principalCookie = principal(authorization);
    const quote = nearExecutableReviewQuote();
    const attestationCookie = mintedCookie(principalCookie, quote);
    const parts = attestationCookie.split(".");
    parts[2] = `${parts[2]?.startsWith("A") ? "B" : "A"}${
      parts[2]?.slice(1) ?? ""
    }`;
    const read = (
      cookie: string,
      currentAuthorization = authorization,
      quoteBinding = quote,
      now = NOW + 1,
    ) => readNearExecutableReviewQuoteAttestation(request({
      [NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE]: cookie,
    }), {
      authorization: currentAuthorization,
      quoteBinding,
      environment: ENVIRONMENT,
      now,
    });

    expect(read(parts.join("."))).toBeNull();
    expect(read(attestationCookie, nearExecutableReviewAuthorization({
      principal_id: "principal-bob",
    }))).toBeNull();
    expect(read(
      attestationCookie,
      authorization,
      quote,
      Date.parse(quote.approval_expires_at),
    )).toBeNull();

    const mutated = structuredClone(quote);
    mutated.amount_in = "2000000";
    mutated.request_echo.amount = "2000000";
    mutated.provider_quote_response.quoteRequest.amount = "2000000";
    mutated.provider_quote_response.quote.amountIn = "2000000";
    mutated.provider_quote_response.quote.minAmountIn = "2000000";
    expect(read(attestationCookie, authorization, mutated)).toBeNull();
  });
});
