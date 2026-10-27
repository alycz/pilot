import { describe, expect, it } from "vitest";

import {
  canonicalNearApprovalJson,
  computeNearNativeNearToArbitrumUsdcApprovalDigest,
  computeNearApprovalDigest,
  NEAR_APPROVAL_DIGEST_DOMAIN,
  Near1ClickDryQuoteRequestSchema,
  Near1ClickDryQuoteResponseSchema,
  Near1ClickExecutableQuoteResponseSchema,
  Near1ClickProviderStatusSchema,
  Near1ClickTokenSchema,
  NearArbitrumUsdcOriginReceiptEvidenceSchema,
  NearArbitrumUsdcOwnerFundingEvidenceSchema,
  NearArbitrumUsdcToWnearExecutableQuoteBindingSchema,
  NearArbitrumUsdcToWnearOwnerFundedExecutionSchema,
  NearArbitrumUsdcToWnearRouteSchema,
  NearArbitrumUsdcToWnearSettlementEvidenceSchema,
  NearApprovalBindingSchema,
  NearAuthorizedOperationSchema,
  NearBudgetReservationSchema,
  NearBudgetReservationTransitionSchema,
  NearExecutionAttemptSchema,
  NearExecutionReplayDecisionSchema,
  NearIdempotencyBindingSchema,
  NearNativeNearAccountControlProofSchema,
  NearNativeNearToArbitrumUsdcApprovalPayloadSchema,
  NearNativeNearToArbitrumUsdcEconomicApprovalEnvelopeSchema,
  NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
  NearNativeNearToArbitrumUsdcFundingInstructionsSchema,
  NearNativeNearToArbitrumUsdcOwnerFundedExecutionSchema,
  NearNativeNearToArbitrumUsdcReconciliationSchema,
  NearNativeNearToArbitrumUsdcReservationBindingSchema,
  NearNativeNearToArbitrumUsdcReserveRequestSchema,
  NearNativeNearToArbitrumUsdcReserveResultSchema,
  NearNativeNearToArbitrumUsdcRouteSchema,
  NearNativeNearSourceFundingEvidenceSchema,
  NearPrincipalAuthorizationSchema,
  NearReconciliationEvidenceSchema,
  NearWalletExecutionPolicySchema,
  verifyNearNativeNearToArbitrumUsdcEconomicApproval,
  verifyNearNativeNearToArbitrumUsdcOwnerFundedExecution,
  verifyNearNativeNearToArbitrumUsdcReserveRequest,
  type NearApprovalBinding,
} from "../src/near";

const dryRequest = {
  slippageTolerance: 100,
  originAsset: "nep141:wrap.near",
  destinationAsset: "nep141:eth-0xa0b8.omft.near",
  amount: "1000000000000000000000000",
  refundTo: "alice.near",
  recipient: "0x0123456789abcdef",
  deadline: "2026-11-02T12:00:00.000Z",
};

const quoteAmounts = {
  amountIn: "1000000000000000000000000",
  amountInFormatted: "1",
  amountInUsd: "2.79",
  minAmountIn: "1000000000000000000000000",
  amountOut: "2780000",
  amountOutFormatted: "2.78",
  amountOutUsd: "2.78",
  minAmountOut: "2750000",
  timeEstimate: 120,
};

const responseHeader = {
  correlationId: "quote-123",
  timestamp: "2026-11-02T11:55:00.000Z",
  signature: "provider-signature",
};

const approval: NearApprovalBinding = {
  version: "pilot-near-1click-approval-v2",
  principal_id: "principal-1",
  account_id: "alice.near",
  network: "near:mainnet",
  idempotency_version: "pilot-near-idempotency-v1",
  idempotency_key: "attempt-1",
  policy_digest: "A".repeat(64),
  quote_id: "quote-123",
  quote_hash: "3".repeat(44),
  provider_signature_verified: true,
  origin_asset: "nep141:wrap.near",
  destination_asset: "nep141:eth-0xa0b8.omft.near",
  amount_in: "1000000000000000000000000",
  min_amount_out: "2750000",
  recipient: "0x0123456789abcdef",
  refund_to: "alice.near",
  deposit_address: "deposit.near",
  approval_expires_at: "2026-11-02T11:58:00.000Z",
  provider_deadline_at: "2026-11-02T12:00:00.000Z",
};

const ownerAddress = `0x${"1".repeat(40)}`;
const depositAddress = `0x${"2".repeat(40)}`;
const fundingTransactionHash = `0x${"A".repeat(64)}`;
const originBlockHash = `0x${"B".repeat(64)}`;

const ownerFundedRoute = {
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

const ownerFundedRequestEcho = {
  swapType: "EXACT_INPUT" as const,
  slippageTolerance: 100,
  originAsset: ownerFundedRoute.origin_asset_id,
  depositType: "ORIGIN_CHAIN" as const,
  destinationAsset: ownerFundedRoute.destination_asset_id,
  amount: "1000000",
  refundTo: ownerAddress,
  refundType: "ORIGIN_CHAIN" as const,
  recipient: "alice.near",
  recipientType: "DESTINATION_CHAIN" as const,
  deadline: "2026-11-02T12:00:00.000Z",
  depositMode: "SIMPLE" as const,
  confidentiality: "public" as const,
  quoteWaitingTimeMs: 0,
  insured: false as const,
  dry: false as const,
};

const ownerFundedProviderQuoteResponse = {
  correlationId: "arb-usdc-quote-1",
  timestamp: "2026-11-02T11:55:00.000Z",
  signature: "verified-provider-signature",
  quoteRequest: ownerFundedRequestEcho,
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
    depositAddress,
    deadline: "2026-11-02T12:00:00.000Z",
    timeWhenInactive: "2026-11-02T11:59:00.000Z",
  },
};

const ownerFundedQuote = {
  version: "pilot-near-arbitrum-usdc-to-wnear-quote-binding-v1" as const,
  route: ownerFundedRoute,
  provider_signature_verified: true as const,
  provider_signature: ownerFundedProviderQuoteResponse.signature,
  quote_hash: "3".repeat(44),
  correlation_id: ownerFundedProviderQuoteResponse.correlationId,
  provider_timestamp: ownerFundedProviderQuoteResponse.timestamp,
  request_echo: ownerFundedRequestEcho,
  provider_quote_response: ownerFundedProviderQuoteResponse,
  amount_in: "1000000",
  min_amount_out: "300000000000000000000000",
  recipient: "alice.near",
  refund_to: ownerAddress,
  deposit_address: depositAddress,
  deposit_memo_present: false as const,
  provider_deadline_at: "2026-11-02T12:00:00.000Z",
  provider_time_when_inactive_at: "2026-11-02T11:59:00.000Z",
  approval_expires_at: "2026-11-02T11:58:00.000Z",
};

const ownerFundingEvidence = {
  version: "pilot-near-arbitrum-usdc-owner-funding-v1" as const,
  provenance: "owner-reported" as const,
  independently_verified: false as const,
  funding_mode: "manual-owner-wallet-send" as const,
  chain: "arb" as const,
  chain_id: 42161 as const,
  token_contract: ownerFundedRoute.origin_token_contract,
  token_decimals: 6 as const,
  transaction_hash: fundingTransactionHash,
  source_address: ownerAddress,
  deposit_address: depositAddress,
  amount_in: "1000000",
  reported_at: "2026-11-02T11:58:30.000Z",
};

const providerOnlySettlement = {
  version: "pilot-near-arbitrum-usdc-to-wnear-settlement-v1" as const,
  evidence_level: "provider-reported-only" as const,
  correlation_id: ownerFundedQuote.correlation_id,
  quote_hash: ownerFundedQuote.quote_hash,
  nested_quote_signature_verified: true as const,
  deposit_address: depositAddress,
  deposit_memo_present: false as const,
  provider_status: "SUCCESS" as const,
  provider_checked_at: "2026-11-02T12:03:00.000Z",
  safe_to_resubmit: false as const,
  independent_destination_receipt: false as const,
};

const reverseRecipient = `0x${"6".repeat(40)}`;
const reverseRoute = {
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
  destination_asset_id: ownerFundedRoute.origin_asset_id,
  destination_token_contract: ownerFundedRoute.origin_token_contract,
  destination_decimals: 6 as const,
  deposit_mode: "SIMPLE" as const,
  funding_mode: "manual-owner-wallet-send" as const,
  manual_owner_funding_only: true as const,
  pilot_budget_scope: "does-not-control-owner-wallet-send" as const,
};

const reverseRequestEcho = {
  swapType: "EXACT_INPUT" as const,
  slippageTolerance: 100,
  originAsset: reverseRoute.origin_asset_id,
  depositType: "ORIGIN_CHAIN" as const,
  destinationAsset: reverseRoute.destination_asset_id,
  amount: "1000000000000000000000000",
  refundTo: "alice.near",
  refundType: "ORIGIN_CHAIN" as const,
  recipient: reverseRecipient,
  recipientType: "DESTINATION_CHAIN" as const,
  deadline: "2026-11-02T13:00:00.000Z",
  depositMode: "SIMPLE" as const,
  confidentiality: "public" as const,
  quoteWaitingTimeMs: 0,
  insured: false as const,
  dry: false as const,
};

const reverseProviderQuoteResponse = {
  correlationId: "near-to-arb-quote-1",
  timestamp: "2026-11-02T12:50:00.000Z",
  signature: "reverse-provider-signature",
  quoteRequest: reverseRequestEcho,
  quote: {
    amountIn: reverseRequestEcho.amount,
    amountInFormatted: "1",
    amountInUsd: "2.79",
    minAmountIn: reverseRequestEcho.amount,
    amountOut: "2790000",
    amountOutFormatted: "2.79",
    amountOutUsd: "2.79",
    minAmountOut: "2750000",
    timeEstimate: 120,
    depositAddress: "deposit-router.near",
    deadline: reverseRequestEcho.deadline,
    timeWhenInactive: "2026-11-02T12:59:00.000Z",
  },
};

const reverseQuote = {
  version: "pilot-near-native-to-arbitrum-usdc-quote-binding-v1" as const,
  route: reverseRoute,
  provider_signature_verified: true as const,
  provider_signature: reverseProviderQuoteResponse.signature,
  quote_hash: "7".repeat(44),
  correlation_id: reverseProviderQuoteResponse.correlationId,
  provider_timestamp: reverseProviderQuoteResponse.timestamp,
  request_echo: reverseRequestEcho,
  provider_quote_response: reverseProviderQuoteResponse,
  amount_in: reverseRequestEcho.amount,
  min_amount_out: reverseProviderQuoteResponse.quote.minAmountOut,
  recipient: reverseRecipient,
  refund_to: "alice.near",
  deposit_address: "deposit-router.near",
  deposit_memo_present: false as const,
  provider_deadline_at: reverseRequestEcho.deadline,
  provider_time_when_inactive_at: reverseProviderQuoteResponse.quote.timeWhenInactive,
  approval_expires_at: "2026-11-02T12:57:00.000Z",
};

const reverseReservation = {
  version: "pilot-near-native-near-to-arbitrum-usdc-reservation-v1" as const,
  reservation_id: "reverse-reservation-1",
  attempt_id: "reverse-attempt-1",
  principal_id: "principal-1",
  near_account_id: "alice.near",
  network: "near:mainnet" as const,
  idempotency_version: "pilot-near-idempotency-v1" as const,
  idempotency_key: "reverse-request-1",
  request_digest: "8".repeat(64),
  asset_id: "nep141:wrap.near" as const,
  amount_atomic: reverseQuote.amount_in,
  expected_revision: 0,
  reserved_revision: 1,
};

const reverseApprovalPayload = {
  version: "pilot-near-native-near-to-arbitrum-usdc-approval-payload-v1" as const,
  route: reverseRoute,
  principal_id: "principal-1",
  near_account_id: "alice.near",
  network: "near:mainnet" as const,
  policy_digest: "9".repeat(64),
  quote_hash: reverseQuote.quote_hash,
  correlation_id: reverseQuote.correlation_id,
  origin_asset_id: reverseRoute.origin_asset_id,
  destination_asset_id: reverseRoute.destination_asset_id,
  amount_in: reverseQuote.amount_in,
  min_amount_out: reverseQuote.min_amount_out,
  recipient: reverseQuote.recipient,
  refund_to: reverseQuote.refund_to,
  deposit_address: reverseQuote.deposit_address,
  deposit_memo_present: false as const,
  provider_deadline_at: reverseQuote.provider_deadline_at,
  approved_at: "2026-11-02T12:52:00.000Z",
  approval_expires_at: "2026-11-02T12:57:00.000Z",
  reservation: reverseReservation,
};

const reverseAccountControl = {
  version: "pilot-near-account-control-proof-v1" as const,
  proof_kind: "nep413" as const,
  scope: "source-account-control-only" as const,
  grants_economic_transfer_approval: false as const,
  authorization_id: "reverse-account-control-1",
  principal_id: "principal-1",
  near_account_id: "alice.near",
  network: "near:mainnet" as const,
  verified_at: "2026-11-02T12:51:00.000Z",
};

const reverseFundingInstructions = {
  version: "pilot-near-native-near-to-arbitrum-usdc-funding-instructions-v1" as const,
  route_version: reverseRoute.version,
  funding_method: "manual-native-near-transfer" as const,
  network: "near:mainnet" as const,
  quote_hash: reverseQuote.quote_hash,
  correlation_id: reverseQuote.correlation_id,
  source_account_id: "alice.near",
  refund_account_id: reverseQuote.refund_to,
  destination_recipient: reverseQuote.recipient,
  deposit_account_id: reverseQuote.deposit_address,
  deposit_memo_present: false as const,
  amount_yocto_near: reverseQuote.amount_in,
  provider_deadline_at: reverseQuote.provider_deadline_at,
};

const reverseSourceFunding = {
  version: "pilot-near-native-near-source-funding-v1" as const,
  provenance: "near-rpc-finalized-native-transfer" as const,
  network: "near:mainnet" as const,
  transaction_hash: "A".repeat(44),
  receipt_id: "B".repeat(44),
  block_height: 123456,
  finality: "final" as const,
  execution_status: "SUCCESS" as const,
  source_account_id: "alice.near",
  receiver_account_id: reverseQuote.deposit_address,
  amount_yocto_near: reverseQuote.amount_in,
  included_at: "2026-11-02T12:53:00.000Z",
  verified_at: "2026-11-02T12:54:00.000Z",
};

const reverseProviderSuccess = {
  version: "pilot-near-native-near-to-arbitrum-usdc-reconciliation-v1" as const,
  outcome: "provider-success-only" as const,
  quote_hash: reverseQuote.quote_hash,
  correlation_id: reverseQuote.correlation_id,
  deposit_account_id: reverseQuote.deposit_address,
  deposit_memo_present: false as const,
  checked_at: "2026-11-02T12:58:00.000Z",
  safe_to_resubmit: false as const,
  provider_status: "SUCCESS" as const,
  independent_destination_receipt: false as const,
};

async function reverseApprovalEnvelope(
  payload = reverseApprovalPayload,
) {
  const approvalDigest = await computeNearNativeNearToArbitrumUsdcApprovalDigest(payload);
  return {
    version: "pilot-near-native-near-to-arbitrum-usdc-economic-approval-v1" as const,
    payload,
    approval_digest: approvalDigest,
    account_control: reverseAccountControl,
    economic_approval: {
      approval_id: "reverse-economic-approval-1",
      method: "owner-reviewed-native-near-transfer" as const,
      owner_confirmed: true as const,
      approved_payload_digest: approvalDigest,
      confirmed_at: payload.approved_at,
    },
  };
}

describe("NEAR 1Click contracts", () => {
  it("requires exact provider asset identifiers rather than ticker symbols", () => {
    expect(Near1ClickTokenSchema.safeParse({
      assetId: "NEAR",
      decimals: 24,
      blockchain: "near",
      symbol: "wNEAR",
      price: 2.79,
      priceUpdatedAt: "2026-11-02T11:55:00.000Z",
    }).success).toBe(false);
  });

  it.each(["qtc", "abs"])("accepts the %s chain code observed in live provider inventory", (blockchain) => {
    expect(Near1ClickTokenSchema.safeParse({
      assetId: `nep141:${blockchain}.example.near`,
      decimals: 18,
      blockchain,
      symbol: "TOKEN",
      price: 1,
      priceUpdatedAt: "2026-10-26T00:00:00.000Z",
    }).success).toBe(true);
  });

  it("defaults quote requests to dry and bounded exact input", () => {
    const parsed = Near1ClickDryQuoteRequestSchema.parse(dryRequest);
    expect(parsed).toMatchObject({
      dry: true,
      swapType: "EXACT_INPUT",
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
    });
  });

  it("never accepts execution fields on a dry quote", () => {
    const parsedRequest = Near1ClickDryQuoteRequestSchema.parse(dryRequest);
    expect(Near1ClickDryQuoteResponseSchema.safeParse({
      ...responseHeader,
      quoteRequest: parsedRequest,
      quote: { ...quoteAmounts, depositAddress: "must-not-exist.near" },
    }).success).toBe(false);
  });

  it("requires deposit and provider deadlines for an executable quote", () => {
    const executableRequest = { ...Near1ClickDryQuoteRequestSchema.parse(dryRequest), dry: false };
    expect(Near1ClickExecutableQuoteResponseSchema.safeParse({
      ...responseHeader,
      quoteRequest: executableRequest,
      quote: quoteAmounts,
    }).success).toBe(false);
    expect(Near1ClickExecutableQuoteResponseSchema.safeParse({
      ...responseHeader,
      quoteRequest: executableRequest,
      quote: {
        ...quoteAmounts,
        depositAddress: "deposit.near",
        deadline: "2026-11-02T12:00:00.000Z",
        timeWhenInactive: "2026-11-02T12:00:00.000Z",
      },
    }).success).toBe(true);
  });

  it("keeps provider UNKNOWN outside the official status enum", () => {
    expect(Near1ClickProviderStatusSchema.safeParse("UNKNOWN").success).toBe(false);
  });
});

describe("NEAR approval and replay binding", () => {
  it("requires a verified provider signature", () => {
    expect(NearApprovalBindingSchema.safeParse({
      ...approval,
      provider_signature_verified: false,
    }).success).toBe(false);
  });

  it("binds every field and deposit memo presence into a stable digest", async () => {
    const digest = await computeNearApprovalDigest(approval);
    expect(digest).toMatch(/^[A-F0-9]{64}$/);
    const domainSeparated = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${NEAR_APPROVAL_DIGEST_DOMAIN}\0${canonicalNearApprovalJson(approval)}`,
      ),
    );
    expect(digest).toBe(Array.from(new Uint8Array(domainSeparated), (byte) =>
      byte.toString(16).padStart(2, "0")).join("").toUpperCase());
    expect(await computeNearApprovalDigest({ ...approval })).toBe(digest);
    expect(await computeNearApprovalDigest({ ...approval, account_id: "bob.near" })).not.toBe(digest);
    expect(await computeNearApprovalDigest({ ...approval, recipient: "bob.near" })).not.toBe(digest);
    expect(await computeNearApprovalDigest({ ...approval, deposit_memo: "12345" })).not.toBe(digest);
    expect(NearApprovalBindingSchema.safeParse({
      ...approval,
      version: "pilot-near-1click-approval-v1",
    }).success).toBe(false);
    expect(NearApprovalBindingSchema.safeParse({
      ...approval,
      idempotency_version: "pilot-near-idempotency-v2",
    }).success).toBe(false);
  });

  it("expires Pilot approval no later than the provider refund deadline", () => {
    expect(NearApprovalBindingSchema.safeParse({
      ...approval,
      approval_expires_at: "2026-11-02T12:00:01.000Z",
    }).success).toBe(false);
  });

  it("requires durable uncertainty evidence and exposes no retry action", async () => {
    const base = {
      version: "pilot-near-execution-attempt-v1" as const,
      attempt_id: "attempt-1",
      principal_id: "principal-1",
      account_id: "alice.near",
      network: "near:mainnet" as const,
      idempotency_version: "pilot-near-idempotency-v1" as const,
      idempotency_key: "attempt-1",
      idempotency_request_digest: "B".repeat(64),
      reservation_id: "reservation-1",
      approval_digest: await computeNearApprovalDigest(approval),
      quote_id: "quote-123",
      state: "unknown" as const,
      created_at: "2026-11-02T11:58:00.000Z",
      updated_at: "2026-11-02T11:59:00.000Z",
    };
    expect(NearExecutionAttemptSchema.safeParse(base).success).toBe(false);
    const attempt = NearExecutionAttemptSchema.parse({
      ...base,
      unknown_since: "2026-11-02T11:59:00.000Z",
      reconciliation: {
        version: "pilot-near-reconciliation-v1",
        outcome: "unknown",
        attempt_id: "attempt-1",
        principal_id: "principal-1",
        account_id: "alice.near",
        network: "near:mainnet",
        checked_at: "2026-11-02T11:59:00.000Z",
        deposit_address: "deposit.near",
        reason: "not_found",
        safe_to_resubmit: false,
      },
    });
    expect(NearExecutionReplayDecisionSchema.parse({
      action: "blocked_unknown",
      attempt,
      safe_to_resubmit: false,
    }).action).toBe("blocked_unknown");
    expect(NearExecutionReplayDecisionSchema.options.every((option) =>
      option.safeParse({ action: "retry", attempt }).success === false)).toBe(true);
    expect(NearExecutionAttemptSchema.safeParse({
      ...attempt,
      reconciliation: {
        ...attempt.reconciliation,
        account_id: "mallory.near",
      },
    }).success).toBe(false);
  });

  it("binds principal authorization and idempotency to one account", () => {
    expect(NearPrincipalAuthorizationSchema.safeParse({
      version: "pilot-near-principal-authorization-v1",
      authorization_id: "authorization-1",
      principal_id: "principal-1",
      account_id: "alice.near",
      network: "near:mainnet",
      operations: ["near.intents.tokens", "near.intents.quote"],
      issued_at: "2026-11-02T11:00:00.000Z",
      expires_at: "2026-11-02T12:00:00.000Z",
    }).success).toBe(true);
    expect(NearPrincipalAuthorizationSchema.safeParse({
      version: "pilot-near-principal-authorization-v1",
      authorization_id: "authorization-1",
      principal_id: "principal-1",
      account_id: "alice.near",
      network: "near:mainnet",
      operations: ["near.intents.tokens", "near.intents.tokens"],
      issued_at: "2026-11-02T11:00:00.000Z",
      expires_at: "2026-11-02T12:00:00.000Z",
    }).success).toBe(false);
    expect(NearPrincipalAuthorizationSchema.safeParse({
      version: "pilot-near-principal-authorization-v1",
      authorization_id: "authorization-1",
      principal_id: "principal-1",
      account_id: "alice.near",
      network: "near:mainnet",
      operations: ["near.intents.quote"],
      issued_at: "2026-11-02T12:00:00.000Z",
      expires_at: "2026-11-02T11:00:00.000Z",
    }).success).toBe(false);
    expect(NearIdempotencyBindingSchema.safeParse({
      version: "pilot-near-idempotency-v1",
      principal_id: "principal-1",
      account_id: "alice.near",
      network: "near:mainnet",
      idempotency_key: "attempt-1",
      request_digest: "B".repeat(64),
      created_at: "2026-11-02T11:58:00.000Z",
    }).success).toBe(true);
  });

  it("holds an atomic budget reservation while outcome is unknown", () => {
    const base = {
      version: "pilot-near-budget-reservation-v1" as const,
      reservation_id: "reservation-1",
      principal_id: "principal-1",
      account_id: "alice.near",
      network: "near:mainnet" as const,
      idempotency_version: "pilot-near-idempotency-v1" as const,
      idempotency_key: "attempt-1",
      request_digest: "B".repeat(64),
      policy_digest: "A".repeat(64),
      asset_id: "nep141:wrap.near",
      amount_atomic: "1000000000000000000000000",
      revision: 2,
      created_at: "2026-11-02T11:58:00.000Z",
      updated_at: "2026-11-02T11:59:00.000Z",
    };
    const unknownReservation = NearBudgetReservationSchema.parse({
      ...base,
      state: "outcome_unknown",
      counts_against_budget: true,
      unknown_since: "2026-11-02T11:59:00.000Z",
    });
    expect(unknownReservation.counts_against_budget).toBe(true);
    expect(NearBudgetReservationTransitionSchema.safeParse({
      version: "pilot-near-budget-reservation-transition-v1",
      reservation_id: base.reservation_id,
      principal_id: base.principal_id,
      account_id: base.account_id,
      network: base.network,
      expected_state: "committed",
      expected_revision: 1,
      next: unknownReservation,
      reconciliation: {
        version: "pilot-near-reconciliation-v1",
        outcome: "unknown",
        attempt_id: "attempt-1",
        principal_id: base.principal_id,
        account_id: base.account_id,
        network: base.network,
        checked_at: base.updated_at,
        deposit_address: "deposit.near",
        reason: "timeout",
        safe_to_resubmit: false,
      },
    }).success).toBe(false);
    expect(NearBudgetReservationTransitionSchema.safeParse({
      version: "pilot-near-budget-reservation-transition-v1",
      reservation_id: base.reservation_id,
      principal_id: base.principal_id,
      account_id: base.account_id,
      network: base.network,
      expected_state: "committed",
      expected_revision: 2,
      next: unknownReservation,
      reconciliation: {
        version: "pilot-near-reconciliation-v1",
        outcome: "unknown",
        attempt_id: "attempt-1",
        principal_id: base.principal_id,
        account_id: base.account_id,
        network: base.network,
        checked_at: base.updated_at,
        deposit_address: "deposit.near",
        reason: "timeout",
        safe_to_resubmit: false,
      },
    }).success).toBe(false);
    expect(NearBudgetReservationTransitionSchema.safeParse({
      version: "pilot-near-budget-reservation-transition-v1",
      reservation_id: base.reservation_id,
      principal_id: base.principal_id,
      account_id: base.account_id,
      network: base.network,
      expected_state: "outcome_unknown",
      expected_revision: 1,
      next: {
        ...base,
        state: "released",
        counts_against_budget: false,
        released_at: "2026-11-02T12:01:00.000Z",
        release_reason: "provider_refunded",
      },
    }).success).toBe(false);
    expect(NearBudgetReservationSchema.safeParse({
      ...base,
      state: "outcome_unknown",
      counts_against_budget: false,
      unknown_since: "2026-11-02T11:59:00.000Z",
    }).success).toBe(false);
    expect(NearBudgetReservationSchema.safeParse({
      ...base,
      state: "released",
      counts_against_budget: true,
      released_at: "2026-11-02T12:01:00.000Z",
      release_reason: "provider_refunded",
    }).success).toBe(false);
  });

  it("commits an unknown reservation only after terminal SUCCESS reconciliation", () => {
    const committedReservation = {
      version: "pilot-near-budget-reservation-v1" as const,
      reservation_id: "reservation-1",
      principal_id: "principal-1",
      account_id: "alice.near",
      network: "near:mainnet" as const,
      idempotency_version: "pilot-near-idempotency-v1" as const,
      idempotency_key: "attempt-1",
      request_digest: "B".repeat(64),
      policy_digest: "A".repeat(64),
      asset_id: "nep141:wrap.near",
      amount_atomic: "1000000000000000000000000",
      revision: 3,
      created_at: "2026-11-02T11:58:00.000Z",
      updated_at: "2026-11-02T12:01:00.000Z",
      state: "committed" as const,
      counts_against_budget: true as const,
      committed_at: "2026-11-02T12:01:00.000Z",
    };
    const transition = {
      version: "pilot-near-budget-reservation-transition-v1" as const,
      reservation_id: "reservation-1",
      principal_id: "principal-1",
      account_id: "alice.near",
      network: "near:mainnet" as const,
      expected_state: "outcome_unknown" as const,
      expected_revision: 2,
      next: committedReservation,
      reconciliation: {
        version: "pilot-near-reconciliation-v1" as const,
        outcome: "terminal" as const,
        attempt_id: "attempt-1",
        principal_id: "principal-1",
        account_id: "alice.near",
        network: "near:mainnet" as const,
        checked_at: "2026-11-02T12:01:00.000Z",
        deposit_address: "deposit.near",
        provider_status: "SUCCESS" as const,
        safe_to_resubmit: false as const,
      },
    };
    expect(NearBudgetReservationTransitionSchema.safeParse(transition).success).toBe(true);
    expect(NearBudgetReservationTransitionSchema.safeParse({
      ...transition,
      reconciliation: {
        ...transition.reconciliation,
        outcome: "pending",
        provider_status: "PROCESSING",
      },
    }).success).toBe(false);
    expect(NearBudgetReservationTransitionSchema.safeParse({
      ...transition,
      reconciliation: {
        ...transition.reconciliation,
        provider_status: "REFUNDED",
      },
    }).success).toBe(false);
    expect(NearBudgetReservationTransitionSchema.safeParse({
      ...transition,
      expected_state: "reserved",
      reconciliation: undefined,
    }).success).toBe(false);
  });

  it("treats a provider not-found result as explicit non-retryable uncertainty", () => {
    expect(NearReconciliationEvidenceSchema.parse({
      version: "pilot-near-reconciliation-v1",
      outcome: "unknown",
      attempt_id: "attempt-1",
      principal_id: "principal-1",
      account_id: "alice.near",
      network: "near:mainnet",
      checked_at: "2026-11-02T11:59:00.000Z",
      deposit_address: "deposit.near",
      reason: "not_found",
      safe_to_resubmit: false,
    }).safe_to_resubmit).toBe(false);
    expect(NearReconciliationEvidenceSchema.safeParse({
      version: "pilot-near-reconciliation-v1",
      outcome: "unknown",
      attempt_id: "attempt-1",
      principal_id: "principal-1",
      account_id: "alice.near",
      network: "near:mainnet",
      checked_at: "2026-11-02T11:59:00.000Z",
      deposit_address: "deposit.near",
      reason: "not_found",
      safe_to_resubmit: true,
    }).success).toBe(false);
  });

  it("requires matching terminal reconciliation before closing an attempt", async () => {
    const base = {
      version: "pilot-near-execution-attempt-v1",
      attempt_id: "attempt-1",
      principal_id: "principal-1",
      account_id: "alice.near",
      network: "near:mainnet",
      idempotency_version: "pilot-near-idempotency-v1",
      idempotency_key: "attempt-1",
      idempotency_request_digest: "B".repeat(64),
      reservation_id: "reservation-1",
      approval_digest: await computeNearApprovalDigest(approval),
      quote_id: "quote-123",
      state: "settled",
      provider_status: "SUCCESS",
      created_at: "2026-11-02T11:58:00.000Z",
      updated_at: "2026-11-02T12:01:00.000Z",
    };
    expect(NearExecutionAttemptSchema.safeParse(base).success).toBe(false);
    expect(NearExecutionAttemptSchema.safeParse({
      ...base,
      reconciliation: {
        version: "pilot-near-reconciliation-v1",
        outcome: "terminal",
        attempt_id: "attempt-1",
        principal_id: "principal-1",
        account_id: "alice.near",
        network: "near:mainnet",
        checked_at: "2026-11-02T12:01:00.000Z",
        deposit_address: "deposit.near",
        provider_status: "SUCCESS",
        safe_to_resubmit: false,
      },
    }).success).toBe(true);
  });

  it("keeps mainnet wallet execution off unless owner approval is explicit", () => {
    expect(NearWalletExecutionPolicySchema.parse({})).toEqual({
      mode: "disabled",
      mainnet_execution_enabled: false,
    });
    expect(NearWalletExecutionPolicySchema.safeParse({
      mode: "disabled",
      mainnet_execution_enabled: true,
    }).success).toBe(false);
  });
});

describe("Arbitrum USDC to wNEAR owner-funded route contracts", () => {
  it("pins one exact route and explicitly excludes owner sends from Pilot budget control", () => {
    expect(NearArbitrumUsdcToWnearRouteSchema.parse(ownerFundedRoute)).toEqual(ownerFundedRoute);
    expect(NearArbitrumUsdcToWnearRouteSchema.safeParse({
      ...ownerFundedRoute,
      origin_chain_id: 1,
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearRouteSchema.safeParse({
      ...ownerFundedRoute,
      origin_decimals: 18,
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearRouteSchema.safeParse({
      ...ownerFundedRoute,
      origin_token_contract: `0x${"9".repeat(40)}`,
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearRouteSchema.safeParse({
      ...ownerFundedRoute,
      pilot_budget_scope: "app-enforced",
    }).success).toBe(false);
  });

  it("binds the verified executable quote, exact echo, route, amounts, and deadlines", () => {
    expect(NearArbitrumUsdcToWnearExecutableQuoteBindingSchema.safeParse(
      ownerFundedQuote,
    ).success).toBe(true);
    expect(NearArbitrumUsdcToWnearExecutableQuoteBindingSchema.safeParse({
      ...ownerFundedQuote,
      provider_signature_verified: false,
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearExecutableQuoteBindingSchema.safeParse({
      ...ownerFundedQuote,
      amount_in: "1000001",
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearExecutableQuoteBindingSchema.safeParse({
      ...ownerFundedQuote,
      min_amount_out: "299999999999999999999999",
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearExecutableQuoteBindingSchema.safeParse({
      ...ownerFundedQuote,
      provider_quote_response: {
        ...ownerFundedProviderQuoteResponse,
        signature: "different-provider-signature",
      },
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearExecutableQuoteBindingSchema.safeParse({
      ...ownerFundedQuote,
      request_echo: { ...ownerFundedQuote.request_echo, depositMode: "MEMO" },
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearExecutableQuoteBindingSchema.safeParse({
      ...ownerFundedQuote,
      request_echo: { ...ownerFundedQuote.request_echo, originAsset: "nep141:wrap.near" },
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearExecutableQuoteBindingSchema.safeParse({
      ...ownerFundedQuote,
      deposit_memo_present: true,
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearExecutableQuoteBindingSchema.safeParse({
      ...ownerFundedQuote,
      provider_quote_response: {
        ...ownerFundedProviderQuoteResponse,
        quote: {
          ...ownerFundedProviderQuoteResponse.quote,
          depositMemo: "forbidden",
        },
      },
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearExecutableQuoteBindingSchema.safeParse({
      ...ownerFundedQuote,
      deposit_memo: "forbidden",
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearExecutableQuoteBindingSchema.safeParse({
      ...ownerFundedQuote,
      approval_expires_at: "2026-11-02T12:00:01.000Z",
    }).success).toBe(false);
  });

  it("keeps owner-reported funding distinct from origin-chain verification", () => {
    expect(NearArbitrumUsdcOwnerFundingEvidenceSchema.parse(
      ownerFundingEvidence,
    ).independently_verified).toBe(false);
    expect(NearArbitrumUsdcOwnerFundingEvidenceSchema.safeParse({
      ...ownerFundingEvidence,
      independently_verified: true,
    }).success).toBe(false);

    const verifiedOrigin = {
      version: "pilot-near-arbitrum-usdc-origin-receipt-v1" as const,
      provenance: "origin-chain-verified" as const,
      verification_source: "arbitrum-rpc-transaction-receipt" as const,
      outcome: "funding-confirmed" as const,
      receipt_status: "success" as const,
      chain: "arb" as const,
      chain_id: 42161 as const,
      token_contract: ownerFundedRoute.origin_token_contract,
      token_decimals: 6 as const,
      funding_transaction_hash: fundingTransactionHash,
      source_address: ownerAddress,
      deposit_address: depositAddress,
      amount_in: "1000000",
      block_number: 123456,
      block_hash: originBlockHash,
      verified_at: "2026-11-02T11:59:30.000Z",
    };
    expect(NearArbitrumUsdcOriginReceiptEvidenceSchema.safeParse(verifiedOrigin).success).toBe(true);
    expect(NearArbitrumUsdcToWnearOwnerFundedExecutionSchema.safeParse({
      version: "pilot-near-arbitrum-usdc-to-wnear-owner-funded-execution-v1",
      route: ownerFundedRoute,
      quote: ownerFundedQuote,
      funding: ownerFundingEvidence,
      origin_verification: verifiedOrigin,
      settlement: providerOnlySettlement,
    }).success).toBe(true);
    expect(NearArbitrumUsdcToWnearOwnerFundedExecutionSchema.safeParse({
      version: "pilot-near-arbitrum-usdc-to-wnear-owner-funded-execution-v1",
      route: ownerFundedRoute,
      quote: ownerFundedQuote,
      funding: ownerFundingEvidence,
      origin_verification: {
        ...verifiedOrigin,
        funding_transaction_hash: `0x${"C".repeat(64)}`,
      },
      settlement: providerOnlySettlement,
    }).success).toBe(false);
  });

  it("does not treat provider SUCCESS as independent destination evidence", () => {
    expect(NearArbitrumUsdcToWnearSettlementEvidenceSchema.parse(
      providerOnlySettlement,
    )).toMatchObject({
      evidence_level: "provider-reported-only",
      provider_status: "SUCCESS",
      independent_destination_receipt: false,
    });

    const independentlyVerified = {
      ...providerOnlySettlement,
      evidence_level: "independent-destination-receipt" as const,
      independent_destination_receipt: {
        source: "near-rpc-final-receipt" as const,
        network: "near:mainnet" as const,
        receipt_id: "4".repeat(44),
        transaction_hash: "5".repeat(44),
        block_height: 987654,
        execution_status: "SUCCESS" as const,
        recipient: ownerFundedQuote.recipient,
        token_contract: "wrap.near" as const,
        asset_id: "nep141:wrap.near" as const,
        token_decimals: 24 as const,
        amount_received: ownerFundedQuote.min_amount_out,
        verified_at: "2026-11-02T12:04:00.000Z",
      },
    };
    expect(NearArbitrumUsdcToWnearOwnerFundedExecutionSchema.safeParse({
      version: "pilot-near-arbitrum-usdc-to-wnear-owner-funded-execution-v1",
      route: ownerFundedRoute,
      quote: ownerFundedQuote,
      funding: ownerFundingEvidence,
      settlement: independentlyVerified,
    }).success).toBe(true);
    expect(NearArbitrumUsdcToWnearOwnerFundedExecutionSchema.safeParse({
      version: "pilot-near-arbitrum-usdc-to-wnear-owner-funded-execution-v1",
      route: ownerFundedRoute,
      quote: ownerFundedQuote,
      funding: ownerFundingEvidence,
      settlement: {
        ...independentlyVerified,
        independent_destination_receipt: {
          ...independentlyVerified.independent_destination_receipt,
          amount_received: "1",
        },
      },
    }).success).toBe(false);
    expect(NearArbitrumUsdcToWnearSettlementEvidenceSchema.safeParse({
      ...independentlyVerified,
      provider_status: "FAILED",
    }).success).toBe(false);
  });

  it("authorizes only the implemented executable review operation", () => {
    expect(NearAuthorizedOperationSchema.safeParse(
      "near.intents.executable-quote.review",
    ).success).toBe(true);
    expect(NearAuthorizedOperationSchema.safeParse(
      "near.intents.deposit-tx.submit",
    ).success).toBe(false);
    expect(NearAuthorizedOperationSchema.safeParse("near.intents.execute").success).toBe(false);
  });
});

describe("native NEAR to Arbitrum USDC owner-funded route contracts", () => {
  it("pins the provisional default-off route and its exact catalog identities", () => {
    expect(NearNativeNearToArbitrumUsdcRouteSchema.parse(reverseRoute)).toMatchObject({
      profile_status: "hosted-default-off",
      execution_default: "off",
      activation_gate: "independent-source-and-destination-receipt-verification-required",
      origin_asset_id: "nep141:wrap.near",
      source_transfer_asset: "native-near",
      destination_chain_id: 42161,
      destination_token_contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    });
    expect(NearNativeNearToArbitrumUsdcRouteSchema.safeParse({
      ...reverseRoute,
      execution_default: "on",
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcRouteSchema.safeParse({
      ...reverseRoute,
      activation_gate: "storage-required",
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcRouteSchema.safeParse({
      ...reverseRoute,
      destination_asset_id: "USDC",
    }).success).toBe(false);
  });

  it("binds the verified executable quote and rejects memo or material-field drift", () => {
    expect(NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema.safeParse(
      reverseQuote,
    ).success).toBe(true);
    expect(NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema.safeParse({
      ...reverseQuote,
      min_amount_out: "2749999",
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema.safeParse({
      ...reverseQuote,
      recipient: `0x${"7".repeat(40)}`,
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema.safeParse({
      ...reverseQuote,
      provider_quote_response: {
        ...reverseProviderQuoteResponse,
        quote: { ...reverseProviderQuoteResponse.quote, depositMemo: "memo" },
      },
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema.safeParse({
      ...reverseQuote,
      request_echo: { ...reverseRequestEcho, originAsset: ownerFundedRoute.origin_asset_id },
    }).success).toBe(false);
  });

  it("domain-separates a fresh quote-bound economic approval from NEP-413 account control", async () => {
    const envelope = await reverseApprovalEnvelope();
    expect(NearNativeNearAccountControlProofSchema.parse(
      envelope.account_control,
    ).grants_economic_transfer_approval).toBe(false);
    expect(NearNativeNearToArbitrumUsdcReservationBindingSchema.safeParse(
      reverseReservation,
    ).success).toBe(true);
    expect(NearNativeNearToArbitrumUsdcEconomicApprovalEnvelopeSchema.safeParse(
      envelope,
    ).success).toBe(true);
    expect(await verifyNearNativeNearToArbitrumUsdcEconomicApproval(envelope)).toBe(true);

    const changedRecipient = {
      ...reverseApprovalPayload,
      recipient: `0x${"7".repeat(40)}`,
    };
    expect(await computeNearNativeNearToArbitrumUsdcApprovalDigest(changedRecipient))
      .not.toBe(envelope.approval_digest);
    expect(await verifyNearNativeNearToArbitrumUsdcEconomicApproval({
      ...envelope,
      payload: changedRecipient,
    })).toBe(false);
    expect(NearNativeNearAccountControlProofSchema.safeParse({
      ...reverseAccountControl,
      grants_economic_transfer_approval: true,
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcApprovalPayloadSchema.safeParse({
      ...reverseApprovalPayload,
      approval_expires_at: "2026-11-02T12:57:00.001Z",
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcReservationBindingSchema.safeParse({
      ...reverseReservation,
      reserved_revision: 2,
    }).success).toBe(false);
  });

  it("requires exact finalized native funding before recording provider settlement", async () => {
    const approval = await reverseApprovalEnvelope();
    const execution = {
      version: "pilot-near-native-near-to-arbitrum-usdc-owner-funded-execution-v1" as const,
      route: reverseRoute,
      quote: reverseQuote,
      approval,
      funding_instructions: reverseFundingInstructions,
      source_funding: reverseSourceFunding,
      reconciliation: reverseProviderSuccess,
    };
    expect(NearNativeNearToArbitrumUsdcFundingInstructionsSchema.safeParse(
      reverseFundingInstructions,
    ).success).toBe(true);
    expect(NearNativeNearSourceFundingEvidenceSchema.safeParse(
      reverseSourceFunding,
    ).success).toBe(true);
    expect(NearNativeNearToArbitrumUsdcOwnerFundedExecutionSchema.safeParse(
      execution,
    ).success).toBe(true);
    expect(await verifyNearNativeNearToArbitrumUsdcOwnerFundedExecution(execution)).toBe(true);
    expect(NearNativeNearToArbitrumUsdcOwnerFundedExecutionSchema.safeParse({
      ...execution,
      source_funding: {
        ...reverseSourceFunding,
        receiver_account_id: "wrong-deposit.near",
      },
    }).success).toBe(false);
    expect(NearNativeNearSourceFundingEvidenceSchema.safeParse({
      ...reverseSourceFunding,
      finality: "optimistic",
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcOwnerFundedExecutionSchema.safeParse({
      ...execution,
      source_funding: {
        ...reverseSourceFunding,
        included_at: "2026-11-02T12:57:00.001Z",
        verified_at: "2026-11-02T12:58:00.000Z",
      },
    }).success).toBe(false);
  });

  it("keeps unknown and provider SUCCESS non-retryable without claiming final delivery", () => {
    expect(NearNativeNearToArbitrumUsdcReconciliationSchema.parse({
      version: "pilot-near-native-near-to-arbitrum-usdc-reconciliation-v1",
      outcome: "unknown",
      quote_hash: reverseQuote.quote_hash,
      correlation_id: reverseQuote.correlation_id,
      deposit_account_id: reverseQuote.deposit_address,
      deposit_memo_present: false,
      checked_at: "2026-11-02T12:58:00.000Z",
      safe_to_resubmit: false,
      reason: "not_found",
    }).safe_to_resubmit).toBe(false);
    expect(NearNativeNearToArbitrumUsdcReconciliationSchema.safeParse({
      ...reverseProviderSuccess,
      safe_to_resubmit: true,
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcReconciliationSchema.parse(
      reverseProviderSuccess,
    )).toMatchObject({
      outcome: "provider-success-only",
      independent_destination_receipt: false,
    });
  });

  it("requires a canonical finalized USDC Transfer event for independent settlement", async () => {
    const approval = await reverseApprovalEnvelope();
    const destinationReceipt = {
      version: "pilot-near-arbitrum-canonical-usdc-receipt-v1" as const,
      provenance: "arbitrum-rpc-finalized-erc20-transfer" as const,
      chain: "arb" as const,
      chain_id: 42161 as const,
      transaction_hash: `0x${"C".repeat(64)}`,
      block_hash: `0x${"D".repeat(64)}`,
      block_number: 654321,
      transaction_index: 2,
      log_index: 4,
      finality: "final" as const,
      receipt_status: "success" as const,
      event_signature: "Transfer(address,address,uint256)" as const,
      token_contract: ownerFundedRoute.origin_token_contract,
      token_decimals: 6 as const,
      sender_address: `0x${"8".repeat(40)}`,
      recipient_address: reverseRecipient,
      amount_received: reverseQuote.min_amount_out,
      verified_at: "2026-11-02T13:01:00.000Z",
    };
    const reconciliation = {
      ...reverseProviderSuccess,
      outcome: "independently-settled" as const,
      independent_destination_receipt: undefined,
      destination_receipt: destinationReceipt,
    };
    const { independent_destination_receipt: _removed, ...cleanReconciliation } = reconciliation;
    const execution = {
      version: "pilot-near-native-near-to-arbitrum-usdc-owner-funded-execution-v1" as const,
      route: reverseRoute,
      quote: reverseQuote,
      approval,
      funding_instructions: reverseFundingInstructions,
      source_funding: reverseSourceFunding,
      reconciliation: cleanReconciliation,
    };
    expect(await verifyNearNativeNearToArbitrumUsdcOwnerFundedExecution(execution)).toBe(true);
    expect(NearNativeNearToArbitrumUsdcOwnerFundedExecutionSchema.safeParse({
      ...execution,
      reconciliation: {
        ...cleanReconciliation,
        destination_receipt: { ...destinationReceipt, amount_received: "1" },
      },
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcOwnerFundedExecutionSchema.safeParse({
      ...execution,
      reconciliation: {
        ...cleanReconciliation,
        destination_receipt: {
          ...destinationReceipt,
          token_contract: `0x${"9".repeat(40)}`,
        },
      },
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcReconciliationSchema.safeParse({
      ...cleanReconciliation,
      provider_status: "REFUNDED",
    }).success).toBe(false);
  });

  it("binds a finalized provider refund to the reviewed NEAR refund account", async () => {
    const approval = await reverseApprovalEnvelope();
    const refund = {
      version: "pilot-near-native-near-refund-receipt-v1" as const,
      provenance: "near-rpc-finalized-refund" as const,
      network: "near:mainnet" as const,
      transaction_hash: "C".repeat(44),
      receipt_id: "D".repeat(44),
      block_height: 123500,
      finality: "final" as const,
      execution_status: "SUCCESS" as const,
      refund_account_id: reverseQuote.refund_to,
      amount_refunded_yocto_near: "999000000000000000000000",
      verified_at: "2026-11-02T13:02:00.000Z",
    };
    const refunded = {
      version: "pilot-near-native-near-to-arbitrum-usdc-reconciliation-v1" as const,
      outcome: "refunded" as const,
      quote_hash: reverseQuote.quote_hash,
      correlation_id: reverseQuote.correlation_id,
      deposit_account_id: reverseQuote.deposit_address,
      deposit_memo_present: false as const,
      checked_at: "2026-11-02T13:02:00.000Z",
      safe_to_resubmit: false as const,
      provider_status: "REFUNDED" as const,
      refund_receipt: refund,
    };
    const execution = {
      version: "pilot-near-native-near-to-arbitrum-usdc-owner-funded-execution-v1" as const,
      route: reverseRoute,
      quote: reverseQuote,
      approval,
      funding_instructions: reverseFundingInstructions,
      source_funding: reverseSourceFunding,
      reconciliation: refunded,
    };
    expect(NearNativeNearToArbitrumUsdcOwnerFundedExecutionSchema.safeParse(
      execution,
    ).success).toBe(true);
    expect(NearNativeNearToArbitrumUsdcOwnerFundedExecutionSchema.safeParse({
      ...execution,
      reconciliation: {
        ...refunded,
        refund_receipt: { ...refund, refund_account_id: "mallory.near" },
      },
    }).success).toBe(false);
  });

  it("admits only the exact live quote, economic approval, and reservation identifiers", async () => {
    const approval = await reverseApprovalEnvelope();
    const request = {
      version: "pilot-near-native-to-arbitrum-usdc-reserve-request-v1" as const,
      quote_binding: reverseQuote,
      approval,
      idempotency_version: reverseReservation.idempotency_version,
      idempotency_key: reverseReservation.idempotency_key,
      attempt_id: reverseReservation.attempt_id,
      reservation_id: reverseReservation.reservation_id,
    };
    expect(NearAuthorizedOperationSchema.safeParse(
      "near.intents.owner-funded.reserve",
    ).success).toBe(true);
    expect(NearNativeNearToArbitrumUsdcReserveRequestSchema.safeParse(request).success)
      .toBe(true);
    expect(await verifyNearNativeNearToArbitrumUsdcReserveRequest(
      request,
      Date.parse("2026-11-02T12:53:00.000Z"),
    )).toBe(true);
    expect(NearNativeNearToArbitrumUsdcReserveRequestSchema.safeParse({
      ...request,
      reservation_id: "other-reservation",
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcReserveRequestSchema.safeParse({
      ...request,
      budget_limit_atomic: "999999999999999999999999999999",
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcReserveRequestSchema.safeParse({
      ...request,
      policy: { allow: true },
    }).success).toBe(false);
    expect(NearNativeNearToArbitrumUsdcReserveRequestSchema.safeParse({
      ...request,
      execution_enabled: true,
    }).success).toBe(false);
    expect(await verifyNearNativeNearToArbitrumUsdcReserveRequest(
      request,
      Date.parse(reverseApprovalPayload.approval_expires_at),
    )).toBe(false);
    expect(await verifyNearNativeNearToArbitrumUsdcReserveRequest({
      ...request,
      approval: {
        ...approval,
        payload: { ...approval.payload, min_amount_out: "1" },
      },
    }, Date.parse("2026-11-02T12:53:00.000Z"))).toBe(false);
  });

  it("returns only durable reserved or replay state with manual execution disabled", async () => {
    const approval = await reverseApprovalEnvelope();
    const base = {
      version: "pilot-near-native-to-arbitrum-usdc-reserve-result-v1" as const,
      source: "live" as const,
      provider_signature_verified: true as const,
      admission_id: approval.economic_approval.approval_id,
      quote_hash: reverseQuote.quote_hash,
      correlation_id: reverseQuote.correlation_id,
      approval_digest: approval.approval_digest,
      request_digest: reverseReservation.request_digest,
      idempotency_version: reverseReservation.idempotency_version,
      idempotency_key: reverseReservation.idempotency_key,
      attempt_id: reverseReservation.attempt_id,
      reservation_id: reverseReservation.reservation_id,
      attempt_state: "approved" as const,
      reservation_state: "reserved" as const,
      attempt_revision: 1,
      reservation_revision: reverseReservation.reserved_revision,
      funding_instructions: reverseFundingInstructions,
      execution_enabled: false as const,
      manual_owner_funding_only: true as const,
    };
    expect(NearNativeNearToArbitrumUsdcReserveResultSchema.safeParse({
      ...base,
      action: "reserved",
      replayed_existing: false,
    }).success).toBe(true);
    expect(NearNativeNearToArbitrumUsdcReserveResultSchema.safeParse({
      ...base,
      action: "replay",
      replayed_existing: true,
    }).success).toBe(true);
    for (const mutation of [
      { execution_enabled: true },
      { manual_owner_funding_only: false },
      { source: "fixture" },
      { action: "reserved", replayed_existing: true },
      { budget_limit_atomic: "999999999999999999999999999999" },
      { wallet_signature: "forbidden" },
      { signed_transaction: "forbidden" },
      { broadcast: true },
    ]) {
      expect(NearNativeNearToArbitrumUsdcReserveResultSchema.safeParse({
        ...base,
        action: "reserved",
        replayed_existing: false,
        ...mutation,
      }).success).toBe(false);
    }
  });
});
