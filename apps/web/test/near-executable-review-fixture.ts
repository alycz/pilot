import type {
  NearArbitrumUsdcToWnearExecutableQuoteBinding,
  NearNativeNearToArbitrumUsdcExecutableQuoteBinding,
  NearPrincipalAuthorization,
} from "@pilot/contracts/near";

const ORIGIN_ASSET =
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const OWNER_ADDRESS = `0x${"1".repeat(40)}`;
const DEPOSIT_ADDRESS = `0x${"2".repeat(40)}`;

export function nearExecutableReviewAuthorization(
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

export function nearExecutableReviewQuote():
  NearArbitrumUsdcToWnearExecutableQuoteBinding {
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

export function nearNativeExecutableReviewQuote():
  NearNativeNearToArbitrumUsdcExecutableQuoteBinding {
  const route = {
    version: "pilot-near-native-to-arbitrum-usdc-route-v1" as const,
    profile_status: "hosted-default-off" as const,
    execution_default: "off" as const,
    activation_gate:
      "independent-source-and-destination-receipt-verification-required" as const,
    origin_chain: "near" as const,
    origin_network: "near:mainnet" as const,
    origin_asset_id: "nep141:wrap.near" as const,
    origin_token_contract: "wrap.near" as const,
    origin_decimals: 24 as const,
    source_transfer_asset: "native-near" as const,
    managed_wrapping_by_1click: true as const,
    destination_chain: "arb" as const,
    destination_chain_id: 42161 as const,
    destination_asset_id: ORIGIN_ASSET as typeof ORIGIN_ASSET,
    destination_token_contract:
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as const,
    destination_decimals: 6 as const,
    deposit_mode: "SIMPLE" as const,
    funding_mode: "manual-owner-wallet-send" as const,
    manual_owner_funding_only: true as const,
    pilot_budget_scope: "does-not-control-owner-wallet-send" as const,
  };
  const recipient = `0x${"4".repeat(40)}`;
  const request = {
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: 75,
    originAsset: route.origin_asset_id,
    depositType: "ORIGIN_CHAIN" as const,
    destinationAsset: route.destination_asset_id,
    amount: "1000000000000000000000000",
    refundTo: "alice.near",
    refundType: "ORIGIN_CHAIN" as const,
    recipient,
    recipientType: "DESTINATION_CHAIN" as const,
    deadline: "2098-01-01T00:30:00.000Z",
    depositMode: "SIMPLE" as const,
    confidentiality: "public" as const,
    quoteWaitingTimeMs: 0,
    insured: false as const,
    dry: false as const,
  };
  const response = {
    correlationId: "near-native-arb-usdc-quote-1",
    timestamp: "2097-12-31T23:59:30.000Z",
    signature: "verified-native-provider-signature",
    quoteRequest: request,
    quote: {
      amountIn: request.amount,
      amountInFormatted: "1",
      amountInUsd: "3",
      minAmountIn: request.amount,
      amountOut: "3000000",
      amountOutFormatted: "3",
      amountOutUsd: "3",
      minAmountOut: "2970000",
      timeEstimate: 120,
      depositAddress: "native-deposit.near",
      deadline: request.deadline,
      timeWhenInactive: "2098-01-01T00:10:00.000Z",
    },
  };
  return {
    version: "pilot-near-native-to-arbitrum-usdc-quote-binding-v1",
    route,
    provider_signature_verified: true,
    provider_signature: response.signature,
    quote_hash: "5".repeat(44),
    correlation_id: response.correlationId,
    provider_timestamp: response.timestamp,
    request_echo: request,
    provider_quote_response: response,
    amount_in: request.amount,
    min_amount_out: response.quote.minAmountOut,
    recipient,
    refund_to: "alice.near",
    deposit_address: "native-deposit.near",
    deposit_memo_present: false,
    provider_deadline_at: request.deadline,
    provider_time_when_inactive_at: response.quote.timeWhenInactive,
    approval_expires_at: "2098-01-01T00:05:00.000Z",
  };
}
