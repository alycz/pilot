import { describe, expect, it } from "vitest";

import { HarborArgsSchemas, HarborResultSchemas } from "../src/types";

const quoteHash = "3".repeat(44);
const recipient = "0x2222222222222222222222222222222222222222";
const request = {
  dry: false as const,
  swapType: "EXACT_INPUT" as const,
  slippageTolerance: 100,
  originAsset: "nep141:wrap.near",
  depositType: "ORIGIN_CHAIN" as const,
  destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  amount: "1000000000000000000000000",
  refundTo: "owner.near",
  refundType: "ORIGIN_CHAIN" as const,
  recipient,
  recipientType: "DESTINATION_CHAIN" as const,
  deadline: "2027-01-01T00:00:00.000Z",
  depositMode: "SIMPLE" as const,
  confidentiality: "public" as const,
  quoteWaitingTimeMs: 0,
  insured: false as const,
};
const route = {
  version: "pilot-near-native-to-arbitrum-usdc-route-v1" as const,
  profile_status: "hosted-default-off" as const,
  execution_default: "off" as const,
  activation_gate: "independent-source-and-destination-receipt-verification-required" as const,
  origin_chain: "near" as const,
  origin_network: "near:mainnet" as const,
  origin_asset_id: "nep141:wrap.near" as const,
  origin_token_contract: "wrap.near" as const,
  origin_decimals: 24 as const,
  source_transfer_asset: "native-near" as const,
  managed_wrapping_by_1click: true as const,
  destination_chain: "arb" as const,
  destination_chain_id: 42161 as const,
  destination_asset_id: request.destinationAsset,
  destination_token_contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as const,
  destination_decimals: 6 as const,
  deposit_mode: "SIMPLE" as const,
  funding_mode: "manual-owner-wallet-send" as const,
  manual_owner_funding_only: true as const,
  pilot_budget_scope: "does-not-control-owner-wallet-send" as const,
};
const response = {
  correlationId: "native-live-correlation",
  timestamp: "2026-10-26T12:00:00.000Z",
  signature: "verified-provider-signature",
  quoteRequest: request,
  quote: {
    amountIn: request.amount,
    amountInFormatted: "1",
    amountInUsd: "1",
    minAmountIn: request.amount,
    amountOut: "995000",
    amountOutFormatted: "0.995",
    amountOutUsd: "0.995",
    minAmountOut: "990000",
    timeEstimate: 30,
    depositAddress: "deposit.near",
    deadline: request.deadline,
    timeWhenInactive: "2026-12-31T23:55:00.000Z",
  },
};
const binding = {
  version: "pilot-near-native-to-arbitrum-usdc-quote-binding-v1" as const,
  route,
  provider_signature_verified: true as const,
  provider_signature: response.signature,
  quote_hash: quoteHash,
  correlation_id: response.correlationId,
  provider_timestamp: response.timestamp,
  request_echo: request,
  provider_quote_response: response,
  amount_in: request.amount,
  min_amount_out: response.quote.minAmountOut,
  recipient,
  refund_to: request.refundTo,
  deposit_address: response.quote.depositAddress,
  deposit_memo_present: false as const,
  provider_deadline_at: request.deadline,
  provider_time_when_inactive_at: response.quote.timeWhenInactive,
  approval_expires_at: "2026-10-26T12:05:00.000Z",
};
const ownerReview = {
  action: "manually-transfer-native-near" as const,
  network: "near-mainnet" as const,
  funding_asset: "native-near" as const,
  amount_atomic: request.amount,
  amount_unit: "yoctoNEAR" as const,
  deposit_address: response.quote.depositAddress,
  deposit_memo: null,
  managed_wrapping_by_1click: true as const,
  owner_should_send_native_near: true as const,
  owner_should_not_pre_wrap: true as const,
  provider_deadline: request.deadline,
  provider_time_when_inactive: response.quote.timeWhenInactive,
  quote_correlation_id: response.correlationId,
  destination_chain_id: 42161 as const,
  destination_token_contract: route.destination_token_contract,
  destination_token_decimals: 6 as const,
  destination_recipient: recipient,
  estimated_amount_out: response.quote.amountOut,
  minimum_amount_out: response.quote.minAmountOut,
  app_fee_bps: 0 as const,
  transaction_built: false as const,
  transaction_signed: false as const,
  transaction_broadcast: false as const,
  funding_state: "not-funded" as const,
  warning: "Owner must manually fund the exact native NEAR quote.",
};
const result = {
  provider: "near-intents-1click" as const,
  source: "live" as const,
  mode: "executable-review" as const,
  provider_signature_verified: true as const,
  route,
  execution_enabled: false as const,
  manual_funding_required: true as const,
  quote_hash: quoteHash,
  quote_binding: binding,
  owner_review: {
    ...ownerReview,
    status_lookup: {
      operation: "near.intents.status" as const,
      profile: "near-native-to-arbitrum-usdc-v1" as const,
      deposit_address: response.quote.depositAddress,
      deposit_memo: null,
      expected_correlation_id: response.correlationId,
      expected_quote_hash: quoteHash,
    },
  },
};

describe("native NEAR to Arbitrum USDC executable review client contract", () => {
  it("accepts the exact route and its live provider binding", () => {
    const args = {
      route: "near-native-to-arbitrum-usdc-v1",
      amount_atomic: request.amount,
      slippage_bps: 100,
      recipient,
      refund_to: request.refundTo,
      refund_deadline: request.deadline,
    };
    expect(HarborArgsSchemas["near.intents.executable-quote.review"].safeParse(args).success).toBe(true);
    expect(HarborResultSchemas["near.intents.executable-quote.review"].parse(result)).toEqual(result);
  });

  it("rejects reversed address roles, missing activation gate, and mismatched economics", () => {
    expect(HarborArgsSchemas["near.intents.executable-quote.review"].safeParse({
      route: "near-native-to-arbitrum-usdc-v1",
      amount_atomic: request.amount,
      slippage_bps: 100,
      recipient: "owner.near",
      refund_to: recipient,
      refund_deadline: request.deadline,
    }).success).toBe(false);
    expect(HarborResultSchemas["near.intents.executable-quote.review"].safeParse({
      ...result,
      route: { ...route, activation_gate: undefined },
    }).success).toBe(false);
    expect(HarborResultSchemas["near.intents.executable-quote.review"].safeParse({
      ...result,
      owner_review: { ...result.owner_review, minimum_amount_out: "1" },
    }).success).toBe(false);
  });

  it("requires fully bound status arguments for the native route profile", () => {
    expect(HarborArgsSchemas["near.intents.status"].safeParse({
      profile: "near-native-to-arbitrum-usdc-v1",
      deposit_address: "deposit.near",
      expected_quote_hash: quoteHash,
      expected_correlation_id: response.correlationId,
    }).success).toBe(true);
    expect(HarborArgsSchemas["near.intents.status"].safeParse({
      profile: "near-native-to-arbitrum-usdc-v1",
      deposit_address: "deposit.near",
    }).success).toBe(false);
  });
});
