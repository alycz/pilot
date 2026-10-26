import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";

import type {
  NearArbitrumUsdcToWnearExecutableQuoteBinding,
  NearPrincipalAuthorization,
} from "@pilot/contracts/near";
import { describe, expect, it, vi } from "vitest";

import {
  HarborNearExecutableReviewNonceConsumer,
  deriveHostedNearExecutableReviewScopeId,
} from "./near-executable-review-replay";
import {
  issueNearExecutableReviewChallenge,
  verifyNearExecutableReviewProof,
  type NearExecutableReviewNonceConsumer,
} from "./near-executable-review-proof";
import {
  NearNep413VerifierError,
  createNearNep413FullAccessKeyVerifier,
  encodeNearNep413Payload,
} from "./near-nep413-verifier";
import type { NearWalletProofRuntime } from "./near-wallet-proof";
import { nearNativeExecutableReviewQuote } from "../test/near-executable-review-fixture";

const NOW = Date.parse("2098-01-01T00:00:00.000Z");
const SECRET = "near-executable-review-proof-secret-over-thirty-two-characters";
const ENVIRONMENT = { SESSION_SECRET: SECRET };
const NONCE = Buffer.alloc(32, 7).toString("base64url");
const OWNER_ADDRESS = `0x${"1".repeat(40)}`;
const DEPOSIT_ADDRESS = `0x${"2".repeat(40)}`;
const ORIGIN_ASSET =
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";

const RUNTIME: NearWalletProofRuntime = {
  mode: "verify",
  provider: "nep413-full-access-key",
  recipient: "pilot.near",
};

function authorization(
  input: Partial<NearPrincipalAuthorization> = {},
): NearPrincipalAuthorization {
  return {
    version: "pilot-near-principal-authorization-v1",
    authorization_id: "authorization-principal-alice",
    principal_id: "principal-alice",
    account_id: "alice.near",
    network: "near:mainnet",
    operations: [
      "near.intents.approval.review",
      "near.intents.executable-quote.review",
    ],
    issued_at: "2097-12-31T23:59:00.000Z",
    expires_at: "2098-01-01T01:00:00.000Z",
    ...input,
  };
}

function quoteBinding(): NearArbitrumUsdcToWnearExecutableQuoteBinding {
  const route = {
    version: "pilot-near-arbitrum-usdc-to-wnear-route-v1" as const,
    origin_chain: "arb" as const,
    origin_chain_id: 42161 as const,
    origin_token_contract:
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as const,
    origin_asset_id: ORIGIN_ASSET as typeof ORIGIN_ASSET,
    origin_decimals: 6 as const,
    destination_chain: "near" as const,
    destination_network: "mainnet" as const,
    destination_token_contract: "wrap.near" as const,
    destination_asset_id: "nep141:wrap.near" as const,
    destination_decimals: 24 as const,
    funding_mode: "manual-owner-wallet-send" as const,
    manual_owner_funding_only: true as const,
    pilot_budget_scope: "does-not-control-owner-wallet-send" as const,
  };
  const request = {
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: 100,
    originAsset: route.origin_asset_id,
    depositType: "ORIGIN_CHAIN" as const,
    destinationAsset: route.destination_asset_id,
    amount: "1000000",
    refundTo: OWNER_ADDRESS,
    refundType: "ORIGIN_CHAIN" as const,
    recipient: "alice.near",
    recipientType: "DESTINATION_CHAIN" as const,
    deadline: "2098-01-01T00:30:00.000Z",
    depositMode: "SIMPLE" as const,
    confidentiality: "public" as const,
    quoteWaitingTimeMs: 0,
    insured: false as const,
    dry: false as const,
  };
  const response = {
    correlationId: "arb-usdc-quote-1",
    timestamp: "2097-12-31T23:59:30.000Z",
    signature: "verified-provider-signature",
    quoteRequest: request,
    quote: {
      amountIn: "1000000",
      amountInFormatted: "1",
      amountInUsd: "1",
      minAmountIn: "1000000",
      amountOut: "310000000000000000000000",
      amountOutFormatted: "0.31",
      amountOutUsd: "1",
      minAmountOut: "300000000000000000000000",
      timeEstimate: 120,
      depositAddress: DEPOSIT_ADDRESS,
      deadline: "2098-01-01T00:30:00.000Z",
      timeWhenInactive: "2098-01-01T00:10:00.000Z",
    },
  };
  return {
    version: "pilot-near-arbitrum-usdc-to-wnear-quote-binding-v1",
    route,
    provider_signature_verified: true,
    provider_signature: response.signature,
    quote_hash: "3".repeat(44),
    correlation_id: response.correlationId,
    provider_timestamp: response.timestamp,
    request_echo: request,
    provider_quote_response: response,
    amount_in: "1000000",
    min_amount_out: "300000000000000000000000",
    recipient: "alice.near",
    refund_to: OWNER_ADDRESS,
    deposit_address: DEPOSIT_ADDRESS,
    deposit_memo_present: false,
    provider_deadline_at: "2098-01-01T00:30:00.000Z",
    provider_time_when_inactive_at: "2098-01-01T00:10:00.000Z",
    approval_expires_at: "2098-01-01T00:05:00.000Z",
  };
}

function proof() {
  return {
    account_id: "alice.near",
    public_key: `ed25519:${"B".repeat(44)}`,
    signature: "A".repeat(88),
  };
}

function verifier() {
  return {
    verify: vi.fn(async (input) => ({
      accountId: input.accountId,
      publicKey: input.publicKey,
      signatureValid: true as const,
      fullAccessKeyVerified: true as const,
    })),
  };
}

function consumer(consumed = true): NearExecutableReviewNonceConsumer & {
  consume: ReturnType<typeof vi.fn>;
} {
  return { consume: vi.fn(async () => consumed) };
}

function issued() {
  return issueNearExecutableReviewChallenge({
    authorization: authorization(),
    quoteBinding: quoteBinding(),
    runtime: RUNTIME,
    environment: ENVIRONMENT,
    now: NOW,
    nonce: NONCE,
  });
}

function changedAmountQuote(): NearArbitrumUsdcToWnearExecutableQuoteBinding {
  const changed = structuredClone(quoteBinding());
  changed.amount_in = "2000000";
  changed.request_echo.amount = "2000000";
  changed.provider_quote_response.quoteRequest.amount = "2000000";
  changed.provider_quote_response.quote.amountIn = "2000000";
  changed.provider_quote_response.quote.minAmountIn = "2000000";
  return changed;
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(value: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of value) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const next = digits[index] * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }
  return "1".repeat(leadingZeroes) +
    digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join("");
}

describe("quote-bound NEAR executable-review wallet proof", () => {
  it("binds the signed message and durable nonce to every reviewed quote field", async () => {
    const challenge = issued();
    const message = JSON.parse(challenge.signMessage.message) as Record<string, any>;
    expect(message).toMatchObject({
      version: "pilot-near-executable-review-wallet-control-message-v1",
      domain: "pilot.near.executable-review.wallet-control.v1",
      operation: "near.intents.executable-quote.review",
      authorization: {
        principal_id: "principal-alice",
        account_id: "alice.near",
        network: "near:mainnet",
      },
      quote: {
        quote_digest: challenge.quoteDigest,
        quote_hash: "3".repeat(44),
        economics: {
          amount_in: "1000000",
          min_amount_out: "300000000000000000000000",
          slippage_bps: 100,
          origin_asset_id: ORIGIN_ASSET,
          destination_asset_id: "nep141:wrap.near",
        },
        routing: {
          recipient: "alice.near",
          refund_to: OWNER_ADDRESS,
          deposit_address: DEPOSIT_ADDRESS,
          deposit_memo_present: false,
        },
      },
      challenge: { nonce: NONCE, recipient: "pilot.near" },
    });
    expect(challenge.signMessage.message_digest).toBe(
      createHash("sha256")
        .update(challenge.signMessage.message, "utf8")
        .digest("hex"),
    );

    const verify = verifier();
    const consume = consumer();
    await expect(verifyNearExecutableReviewProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: authorization(),
      currentQuoteBinding: quoteBinding(),
      proof: proof(),
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      verifier: verify,
      nonceConsumer: consume,
      now: NOW + 1,
      clock: () => NOW + 1,
    })).resolves.toMatchObject({
      account_id: "alice.near",
      quote_digest: challenge.quoteDigest,
    });
    expect(consume.consume).toHaveBeenCalledWith(expect.objectContaining({
      principalId: "principal-alice",
      accountId: "alice.near",
      network: "near:mainnet",
      authorizationId: "authorization-principal-alice",
      quoteDigest: challenge.quoteDigest,
      nonce: NONCE,
    }));
  });

  it("verifies the native NEAR funding route and rejects native routing mutation", async () => {
    const quote = nearNativeExecutableReviewQuote();
    const challenge = issueNearExecutableReviewChallenge({
      authorization: authorization(),
      quoteBinding: quote,
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      now: NOW,
      nonce: NONCE,
    });
    const message = JSON.parse(challenge.signMessage.message) as Record<string, any>;
    expect(message).toMatchObject({
      authorization: { account_id: "alice.near", network: "near:mainnet" },
      quote: {
        route: {
          version: "pilot-near-native-to-arbitrum-usdc-route-v1",
          source_transfer_asset: "native-near",
          managed_wrapping_by_1click: true,
        },
        economics: {
          amount_in: "1000000000000000000000000",
          min_amount_out: "2970000",
          origin_asset_id: "nep141:wrap.near",
          destination_asset_id:
            "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
        },
        routing: {
          recipient: `0x${"4".repeat(40)}`,
          refund_to: "alice.near",
          deposit_address: "native-deposit.near",
          deposit_memo_present: false,
        },
      },
    });
    await expect(verifyNearExecutableReviewProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: authorization(),
      currentQuoteBinding: quote,
      proof: proof(),
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      verifier: verifier(),
      nonceConsumer: consumer(),
      now: NOW + 1,
      clock: () => NOW + 1,
    })).resolves.toMatchObject({
      account_id: "alice.near",
      quote_binding: { version: quote.version },
    });

    const mutated = structuredClone(quote);
    mutated.deposit_address = "other-deposit.near";
    mutated.provider_quote_response.quote.depositAddress = "other-deposit.near";
    await expect(verifyNearExecutableReviewProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: authorization(),
      currentQuoteBinding: mutated,
      proof: proof(),
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      verifier: verifier(),
      nonceConsumer: consumer(),
      now: NOW + 1,
    })).rejects.toMatchObject({ code: "QUOTE_MUTATED" });
  });

  it("rejects a valid but economically mutated quote before signature verification", async () => {
    const verify = verifier();
    const consume = consumer();
    await expect(verifyNearExecutableReviewProof({
      challengeCookie: issued().cookie,
      currentAuthorization: authorization(),
      currentQuoteBinding: changedAmountQuote(),
      proof: proof(),
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      verifier: verify,
      nonceConsumer: consume,
      now: NOW + 1,
    })).rejects.toMatchObject({ code: "QUOTE_MUTATED" });
    expect(verify.verify).not.toHaveBeenCalled();
    expect(consume.consume).not.toHaveBeenCalled();
  });

  it.each([
    ["principal", authorization({ principal_id: "principal-bob" }), "PRINCIPAL_MISMATCH"],
    ["account", authorization({ account_id: "bob.near" }), "ACCOUNT_MISMATCH"],
    ["network", { ...authorization(), network: "near:testnet" }, "AUTHORIZATION_INVALID"],
  ])("rejects a changed %s binding", async (_name, current, code) => {
    await expect(verifyNearExecutableReviewProof({
      challengeCookie: issued().cookie,
      currentAuthorization: current as NearPrincipalAuthorization,
      currentQuoteBinding: quoteBinding(),
      proof: proof(),
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      verifier: verifier(),
      nonceConsumer: consumer(),
      now: NOW + 1,
    })).rejects.toMatchObject({ code });
  });

  it("rejects expiry and replay without producing a reusable proof", async () => {
    const challenge = issued();
    await expect(verifyNearExecutableReviewProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: authorization(),
      currentQuoteBinding: quoteBinding(),
      proof: proof(),
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      verifier: verifier(),
      nonceConsumer: consumer(),
      now: challenge.expiresAt,
    })).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });

    await expect(verifyNearExecutableReviewProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: authorization(),
      currentQuoteBinding: quoteBinding(),
      proof: proof(),
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      verifier: verifier(),
      nonceConsumer: consumer(false),
      now: NOW + 1,
    })).rejects.toMatchObject({ code: "PROOF_REPLAYED" });
  });

  it("rejects challenge tampering and a proof from another account", async () => {
    const challenge = issued();
    const challengeParts = challenge.cookie.split(".");
    challengeParts[2] = `${challengeParts[2]?.startsWith("A") ? "B" : "A"}${
      challengeParts[2]?.slice(1) ?? ""
    }`;
    await expect(verifyNearExecutableReviewProof({
      challengeCookie: challengeParts.join("."),
      currentAuthorization: authorization(),
      currentQuoteBinding: quoteBinding(),
      proof: proof(),
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      verifier: verifier(),
      nonceConsumer: consumer(),
      now: NOW + 1,
    })).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });

    await expect(verifyNearExecutableReviewProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: authorization(),
      currentQuoteBinding: quoteBinding(),
      proof: { ...proof(), account_id: "bob.near" },
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      verifier: verifier(),
      nonceConsumer: consumer(),
      now: NOW + 1,
    })).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });

  it("maps an unauthorized full-access key denial to an invalid proof", async () => {
    await expect(verifyNearExecutableReviewProof({
      challengeCookie: issued().cookie,
      currentAuthorization: authorization(),
      currentQuoteBinding: quoteBinding(),
      proof: proof(),
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      verifier: {
        async verify() {
          throw new NearNep413VerifierError(
            "FULL_ACCESS_KEY_REQUIRED",
            "fixture key is not authorized",
          );
        },
      },
      nonceConsumer: consumer(),
      now: NOW + 1,
    })).rejects.toMatchObject({ code: "PROOF_INVALID" });
  });

  it("rejects an untrusted RPC permission using a disposable local Ed25519 key", async () => {
    const challenge = issued();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" });
    const publicKeyText = `ed25519:${encodeBase58(spki.subarray(spki.length - 32))}`;
    const digest = createHash("sha256").update(encodeNearNep413Payload({
      message: challenge.signMessage.message,
      nonce: new Uint8Array(Buffer.from(challenge.signMessage.nonce, "base64url")),
      recipient: challenge.signMessage.recipient,
    })).digest();
    const cryptographicProof = {
      account_id: "alice.near",
      public_key: publicKeyText,
      signature: sign(null, digest, privateKey).toString("base64"),
    };
    const fetchMock = vi.fn(async () => Response.json({
      jsonrpc: "2.0",
      id: "pilot-nep413-full-access-key-v1",
      result: {
        permission: {
          FunctionCall: {
            allowance: "1",
            receiver_id: "untrusted.near",
            method_names: [],
          },
        },
      },
    }));

    await expect(verifyNearExecutableReviewProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: authorization(),
      currentQuoteBinding: quoteBinding(),
      proof: cryptographicProof,
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      verifier: createNearNep413FullAccessKeyVerifier({ fetch: fetchMock }),
      nonceConsumer: consumer(),
      now: NOW + 1,
    })).rejects.toMatchObject({ code: "PROOF_INVALID" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the hosted durable replay scope quote- and principal-specific", async () => {
    const binding = {
      principalId: "principal-alice",
      accountId: "alice.near",
      network: "near:mainnet" as const,
      authorizationId: "authorization-principal-alice",
      quoteDigest: "a".repeat(64),
      recipient: "pilot.near",
    };
    expect(deriveHostedNearExecutableReviewScopeId(binding, SECRET)).not.toBe(
      deriveHostedNearExecutableReviewScopeId({
        ...binding,
        quoteDigest: "b".repeat(64),
      }, SECRET),
    );
    const consumeWalletProof = vi.fn(async () => ({ consumed: true }));
    const durable = new HarborNearExecutableReviewNonceConsumer(
      { consumeWalletProof },
      binding,
      SECRET,
    );
    await expect(durable.consume({
      version: "pilot-near-executable-review-nonce-v1",
      ...binding,
      operation: "near.intents.executable-quote.review",
      nonce: NONCE,
      expiresAt: NOW + 60_000,
      now: NOW,
    })).resolves.toBe(true);
    expect(consumeWalletProof).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "near-wallet-auth",
      scopeId: deriveHostedNearExecutableReviewScopeId(binding, SECRET),
      nonceDigest: createHash("sha256").update(NONCE, "utf8").digest("hex"),
    }));
    await expect(durable.consume({
      version: "pilot-near-executable-review-nonce-v1",
      ...binding,
      quoteDigest: "b".repeat(64),
      operation: "near.intents.executable-quote.review",
      nonce: NONCE,
      expiresAt: NOW + 60_000,
      now: NOW,
    })).resolves.toBe(false);
  });
});
