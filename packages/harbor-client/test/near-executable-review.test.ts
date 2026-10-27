import { describe, expect, it } from "vitest";

import { createHarborRestClient } from "../src/rest";
import {
  HarborArgsSchemas,
  HarborResultSchemas,
  NEAR_EXECUTABLE_REVIEW_FIXTURE_ID,
} from "../src/types";

const quoteHash = "3".repeat(44);
const depositAddress = "0x2222222222222222222222222222222222222222";
const refundAddress = "0x1111111111111111111111111111111111111111";
const deadline = "2027-01-01T00:00:00.000Z";
const inactiveAt = "2026-12-31T23:55:00.000Z";
const approvalExpiresAt = "2026-10-26T12:05:00.000Z";

const args = {
  route: "arbitrum-usdc-to-near-wnear-v1" as const,
  amount_atomic: "1000000",
  slippage_bps: 100,
  recipient: "owner.near",
  refund_to: refundAddress,
  refund_deadline: deadline,
};

const route = {
  version: "pilot-near-arbitrum-usdc-to-wnear-route-v1" as const,
  origin_chain: "arb" as const,
  origin_chain_id: 42161 as const,
  origin_token_contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as const,
  origin_asset_id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" as const,
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

const requestEcho = {
  dry: false as const,
  swapType: "EXACT_INPUT" as const,
  slippageTolerance: 100,
  originAsset: route.origin_asset_id,
  depositType: "ORIGIN_CHAIN" as const,
  destinationAsset: route.destination_asset_id,
  amount: args.amount_atomic,
  refundTo: refundAddress,
  refundType: "ORIGIN_CHAIN" as const,
  recipient: args.recipient,
  recipientType: "DESTINATION_CHAIN" as const,
  deadline,
  depositMode: "SIMPLE" as const,
  confidentiality: "public" as const,
  quoteWaitingTimeMs: 0,
  insured: false as const,
};

const providerQuoteResponse = {
  correlationId: "live-correlation",
  timestamp: "2026-10-26T12:00:00.000Z",
  signature: "verified-provider-signature",
  quoteRequest: requestEcho,
  quote: {
    amountIn: "1000000",
    amountInFormatted: "1",
    amountInUsd: "1",
    minAmountIn: "1000000",
    amountOut: "5000000000000000000000000",
    amountOutFormatted: "5",
    amountOutUsd: "0.99",
    minAmountOut: "4900000000000000000000000",
    timeEstimate: 30,
    depositAddress,
    deadline,
    timeWhenInactive: inactiveAt,
  },
};

const quoteBinding = {
  version: "pilot-near-arbitrum-usdc-to-wnear-quote-binding-v1" as const,
  route,
  provider_signature_verified: true as const,
  provider_signature: providerQuoteResponse.signature,
  quote_hash: quoteHash,
  correlation_id: providerQuoteResponse.correlationId,
  provider_timestamp: providerQuoteResponse.timestamp,
  request_echo: requestEcho,
  provider_quote_response: providerQuoteResponse,
  amount_in: args.amount_atomic,
  min_amount_out: providerQuoteResponse.quote.minAmountOut,
  recipient: args.recipient,
  refund_to: refundAddress,
  deposit_address: depositAddress,
  deposit_memo_present: false as const,
  provider_deadline_at: deadline,
  provider_time_when_inactive_at: inactiveAt,
  approval_expires_at: approvalExpiresAt,
};

const ownerReview = {
  action: "manually-transfer-origin-asset" as const,
  network: "arbitrum-mainnet" as const,
  chain_id: 42161 as const,
  token_contract: route.origin_token_contract,
  token_decimals: 6 as const,
  amount_atomic: args.amount_atomic,
  deposit_address: depositAddress,
  deposit_memo: null,
  provider_deadline: deadline,
  provider_time_when_inactive: inactiveAt,
  quote_correlation_id: providerQuoteResponse.correlationId,
  destination_asset_id: route.destination_asset_id,
  destination_recipient: args.recipient,
  estimated_amount_out: providerQuoteResponse.quote.amountOut,
  minimum_amount_out: providerQuoteResponse.quote.minAmountOut,
  app_fee_bps: 0 as const,
  transaction_built: false as const,
  transaction_signed: false as const,
  transaction_broadcast: false as const,
  funding_state: "not-funded" as const,
  warning: "Owner must manually fund this exact provider-verified route.",
};

const liveResult = {
  provider: "near-intents-1click" as const,
  source: "live" as const,
  mode: "executable-review" as const,
  provider_signature_verified: true as const,
  route,
  execution_enabled: false as const,
  manual_funding_required: true as const,
  quote_hash: quoteHash,
  quote_binding: quoteBinding,
  owner_review: {
    ...ownerReview,
    status_lookup: {
      operation: "near.intents.status" as const,
      deposit_address: depositAddress,
      deposit_memo: null,
      expected_correlation_id: providerQuoteResponse.correlationId,
      expected_quote_hash: quoteHash,
    },
  },
};

const fixtureResult = {
  provider: "near-intents-1click" as const,
  source: "fixture" as const,
  mode: "executable-review" as const,
  provider_signature_verified: false as const,
  route,
  execution_enabled: false as const,
  manual_funding_required: true as const,
  local_fixture_id: NEAR_EXECUTABLE_REVIEW_FIXTURE_ID,
  fixture_quote: {
    version: "pilot-near-arbitrum-usdc-to-wnear-quote-fixture-v1" as const,
    route,
    correlation_id: providerQuoteResponse.correlationId,
    provider_timestamp: providerQuoteResponse.timestamp,
    request_echo: requestEcho,
    amount_in: args.amount_atomic,
    amount_out: providerQuoteResponse.quote.amountOut,
    min_amount_out: providerQuoteResponse.quote.minAmountOut,
    recipient: args.recipient,
    refund_to: refundAddress,
    deposit_address: depositAddress,
    deposit_memo_present: false as const,
    provider_deadline_at: deadline,
    provider_time_when_inactive_at: inactiveAt,
    approval_expires_at: approvalExpiresAt,
  },
  owner_review: {
    ...ownerReview,
    status_lookup: {
      operation: "near.intents.status" as const,
      deposit_address: depositAddress,
      deposit_memo: null,
      expected_correlation_id: providerQuoteResponse.correlationId,
      local_fixture_id: NEAR_EXECUTABLE_REVIEW_FIXTURE_ID,
    },
  },
};

describe("NEAR owner-funded executable review client contract", () => {
  it("accepts only the exact supported route arguments", () => {
    expect(HarborArgsSchemas["near.intents.executable-quote.review"].parse(args)).toEqual(args);
    for (const mutation of [
      { ...args, route: "another-route" },
      { ...args, amount_atomic: "1.5" },
      { ...args, slippage_bps: 1001 },
      { ...args, recipient: "INVALID!" },
      { ...args, refund_to: "owner.near" },
    ]) {
      expect(HarborArgsSchemas["near.intents.executable-quote.review"].safeParse(mutation).success).toBe(false);
    }
  });

  it("accepts a provider-verified live review through REST envelope validation", async () => {
    const client = createHarborRestClient({
      apiKey: "fixture-key",
      baseUrl: "https://harbor.example",
      mock: false,
      fetch: async () => Response.json({
        ok: true,
        data: liveResult,
        asOf: "2026-10-26T12:00:00.000Z",
        asOfBasis: "near-intents-1click",
      }),
    });
    const envelope = await client.op("near.intents.executable-quote.review", args);
    expect(envelope.ok && envelope.data).toEqual(liveResult);
  });

  it("keeps fixture provenance non-verified and separate from the live binding", () => {
    expect(HarborResultSchemas["near.intents.executable-quote.review"].parse(fixtureResult))
      .toEqual(fixtureResult);
    expect(HarborResultSchemas["near.intents.executable-quote.review"].safeParse({
      ...fixtureResult,
      provider_signature_verified: true,
      quote_hash: quoteHash,
      quote_binding: quoteBinding,
    }).success).toBe(false);
  });

  it("rejects dry, cross-route, and internally inconsistent live reviews", () => {
    const mutations = [
      { ...liveResult, execution_enabled: true },
      { ...liveResult, quote_hash: "4".repeat(44) },
      { ...liveResult, owner_review: { ...liveResult.owner_review, deposit_address: refundAddress } },
      {
        ...liveResult,
        quote_binding: {
          ...quoteBinding,
          request_echo: { ...requestEcho, dry: true },
        },
      },
      {
        ...liveResult,
        quote_binding: {
          ...quoteBinding,
          route: { ...route, destination_asset_id: "nep141:not-wrap.near" },
        },
      },
    ];
    for (const mutation of mutations) {
      expect(HarborResultSchemas["near.intents.executable-quote.review"].safeParse(mutation).success)
        .toBe(false);
    }
  });

  it("validates optional exact status identity bindings", () => {
    expect(HarborArgsSchemas["near.intents.status"].safeParse({
      deposit_address: depositAddress,
      expected_quote_hash: quoteHash,
      expected_correlation_id: providerQuoteResponse.correlationId,
    }).success).toBe(true);
    expect(HarborArgsSchemas["near.intents.status"].safeParse({
      deposit_address: depositAddress,
      expected_quote_hash: "not-a-provider-hash",
    }).success).toBe(false);
  });
});
