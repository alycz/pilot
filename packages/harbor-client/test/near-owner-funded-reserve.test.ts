import { computeNearNativeNearToArbitrumUsdcApprovalDigest } from "@pilot/contracts/near";
import { describe, expect, it, vi } from "vitest";

import {
  HarborArgsSchemas,
  HarborResultSchemas,
  createHarborRestClient,
  type ArgsFor,
  type ResultFor,
} from "../src/index.js";

const recipient = `0x${"6".repeat(40)}`;
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
  destination_asset_id:
    "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" as const,
  destination_token_contract:
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as const,
  destination_decimals: 6 as const,
  deposit_mode: "SIMPLE" as const,
  funding_mode: "manual-owner-wallet-send" as const,
  manual_owner_funding_only: true as const,
  pilot_budget_scope: "does-not-control-owner-wallet-send" as const,
};
const quoteRequest = {
  swapType: "EXACT_INPUT" as const,
  slippageTolerance: 100,
  originAsset: route.origin_asset_id,
  depositType: "ORIGIN_CHAIN" as const,
  destinationAsset: route.destination_asset_id,
  amount: "1000000000000000000000000",
  refundTo: "alice.near",
  refundType: "ORIGIN_CHAIN" as const,
  recipient,
  recipientType: "DESTINATION_CHAIN" as const,
  deadline: "2026-11-02T13:00:00.000Z",
  depositMode: "SIMPLE" as const,
  confidentiality: "public" as const,
  quoteWaitingTimeMs: 0,
  insured: false as const,
  dry: false as const,
};
const providerQuoteResponse = {
  correlationId: "near-to-arb-quote-1",
  timestamp: "2026-11-02T12:50:00.000Z",
  signature: "verified-provider-signature",
  quoteRequest,
  quote: {
    amountIn: quoteRequest.amount,
    amountInFormatted: "1",
    amountInUsd: "2.79",
    minAmountIn: quoteRequest.amount,
    amountOut: "2790000",
    amountOutFormatted: "2.79",
    amountOutUsd: "2.79",
    minAmountOut: "2750000",
    timeEstimate: 120,
    depositAddress: "deposit-router.near",
    deadline: quoteRequest.deadline,
    timeWhenInactive: "2026-11-02T12:59:00.000Z",
  },
};
const quoteBinding = {
  version: "pilot-near-native-to-arbitrum-usdc-quote-binding-v1" as const,
  route,
  provider_signature_verified: true as const,
  provider_signature: providerQuoteResponse.signature,
  quote_hash: "7".repeat(44),
  correlation_id: providerQuoteResponse.correlationId,
  provider_timestamp: providerQuoteResponse.timestamp,
  request_echo: quoteRequest,
  provider_quote_response: providerQuoteResponse,
  amount_in: quoteRequest.amount,
  min_amount_out: providerQuoteResponse.quote.minAmountOut,
  recipient,
  refund_to: quoteRequest.refundTo,
  deposit_address: providerQuoteResponse.quote.depositAddress,
  deposit_memo_present: false as const,
  provider_deadline_at: quoteRequest.deadline,
  provider_time_when_inactive_at: providerQuoteResponse.quote.timeWhenInactive,
  approval_expires_at: "2026-11-02T12:57:00.000Z",
};
const reservation = {
  version: "pilot-near-native-near-to-arbitrum-usdc-reservation-v1" as const,
  reservation_id: "reverse-reservation-1",
  attempt_id: "reverse-attempt-1",
  principal_id: "principal-1",
  near_account_id: "alice.near",
  network: "near:mainnet" as const,
  idempotency_version: "pilot-near-idempotency-v1" as const,
  idempotency_key: "reverse-request-1",
  request_digest: "8".repeat(64),
  asset_id: route.origin_asset_id,
  amount_atomic: quoteBinding.amount_in,
  expected_revision: 0,
  reserved_revision: 1,
};
const approvalPayload = {
  version: "pilot-near-native-near-to-arbitrum-usdc-approval-payload-v1" as const,
  route,
  principal_id: reservation.principal_id,
  near_account_id: reservation.near_account_id,
  network: "near:mainnet" as const,
  policy_digest: "9".repeat(64),
  quote_hash: quoteBinding.quote_hash,
  correlation_id: quoteBinding.correlation_id,
  origin_asset_id: route.origin_asset_id,
  destination_asset_id: route.destination_asset_id,
  amount_in: quoteBinding.amount_in,
  min_amount_out: quoteBinding.min_amount_out,
  recipient: quoteBinding.recipient,
  refund_to: quoteBinding.refund_to,
  deposit_address: quoteBinding.deposit_address,
  deposit_memo_present: false as const,
  provider_deadline_at: quoteBinding.provider_deadline_at,
  approved_at: "2026-11-02T12:52:00.000Z",
  approval_expires_at: quoteBinding.approval_expires_at,
  reservation,
};
const accountControl = {
  version: "pilot-near-account-control-proof-v1" as const,
  proof_kind: "nep413" as const,
  scope: "source-account-control-only" as const,
  grants_economic_transfer_approval: false as const,
  authorization_id: "reverse-account-control-1",
  principal_id: reservation.principal_id,
  near_account_id: reservation.near_account_id,
  network: "near:mainnet" as const,
  verified_at: "2026-11-02T12:51:00.000Z",
};
const fundingInstructions = {
  version: "pilot-near-native-near-to-arbitrum-usdc-funding-instructions-v1" as const,
  route_version: route.version,
  funding_method: "manual-native-near-transfer" as const,
  network: "near:mainnet" as const,
  quote_hash: quoteBinding.quote_hash,
  correlation_id: quoteBinding.correlation_id,
  source_account_id: reservation.near_account_id,
  refund_account_id: quoteBinding.refund_to,
  destination_recipient: quoteBinding.recipient,
  deposit_account_id: quoteBinding.deposit_address,
  deposit_memo_present: false as const,
  amount_yocto_near: quoteBinding.amount_in,
  provider_deadline_at: quoteBinding.provider_deadline_at,
};

async function reserveRequest(): Promise<ArgsFor<"near.intents.owner-funded.reserve">> {
  const approvalDigest = await computeNearNativeNearToArbitrumUsdcApprovalDigest(
    approvalPayload,
  );
  return {
    version: "pilot-near-native-to-arbitrum-usdc-reserve-request-v1",
    quote_binding: quoteBinding,
    approval: {
      version: "pilot-near-native-near-to-arbitrum-usdc-economic-approval-v1",
      payload: approvalPayload,
      approval_digest: approvalDigest,
      account_control: accountControl,
      economic_approval: {
        approval_id: "reverse-economic-approval-1",
        method: "owner-reviewed-native-near-transfer",
        owner_confirmed: true,
        approved_payload_digest: approvalDigest,
        confirmed_at: approvalPayload.approved_at,
      },
    },
    idempotency_version: reservation.idempotency_version,
    idempotency_key: reservation.idempotency_key,
    attempt_id: reservation.attempt_id,
    reservation_id: reservation.reservation_id,
  };
}

async function reserveResult(
  action: "reserved" | "replay" = "reserved",
): Promise<ResultFor<"near.intents.owner-funded.reserve">> {
  const request = await reserveRequest();
  const common = {
    version: "pilot-near-native-to-arbitrum-usdc-reserve-result-v1" as const,
    source: "live" as const,
    provider_signature_verified: true as const,
    admission_id: request.approval.economic_approval.approval_id,
    quote_hash: quoteBinding.quote_hash,
    correlation_id: quoteBinding.correlation_id,
    approval_digest: request.approval.approval_digest,
    request_digest: reservation.request_digest,
    idempotency_version: reservation.idempotency_version,
    idempotency_key: reservation.idempotency_key,
    attempt_id: reservation.attempt_id,
    reservation_id: reservation.reservation_id,
    attempt_state: "approved" as const,
    reservation_state: "reserved" as const,
    attempt_revision: 1,
    reservation_revision: reservation.reserved_revision,
    funding_instructions: fundingInstructions,
    execution_enabled: false as const,
    manual_owner_funding_only: true as const,
  };
  return action === "reserved"
    ? { ...common, action, replayed_existing: false }
    : { ...common, action, replayed_existing: true };
}

describe("native NEAR owner-funded admission client contract", () => {
  it("registers the exact strict live request and durable reserved/replay results", async () => {
    const request = await reserveRequest();
    const reserved = await reserveResult();
    const replay = await reserveResult("replay");

    expect(HarborArgsSchemas["near.intents.owner-funded.reserve"].parse(request))
      .toEqual(request);
    expect(HarborResultSchemas["near.intents.owner-funded.reserve"].parse(reserved))
      .toEqual(reserved);
    expect(HarborResultSchemas["near.intents.owner-funded.reserve"].parse(replay))
      .toEqual(replay);
  });

  it("rejects fixture, dry, and unknown request fields", async () => {
    const request = await reserveRequest();
    const parses = (candidate: unknown) =>
      HarborArgsSchemas["near.intents.owner-funded.reserve"].safeParse(candidate).success;

    expect(parses({ ...request, source: "fixture" })).toBe(false);
    expect(parses({
      ...request,
      quote_binding: {
        ...request.quote_binding,
        request_echo: { ...request.quote_binding.request_echo, dry: true },
      },
    })).toBe(false);
    expect(parses({ ...request, budget_limit_atomic: request.quote_binding.amount_in }))
      .toBe(false);
    expect(parses({ ...request, execution_enabled: true })).toBe(false);
  });

  it("never accepts fixture provenance, capability fields, or inconsistent replay state", async () => {
    const reserved = await reserveResult();
    const parses = (candidate: unknown) =>
      HarborResultSchemas["near.intents.owner-funded.reserve"].safeParse(candidate).success;

    expect(parses({ ...reserved, source: "fixture" })).toBe(false);
    expect(parses({ ...reserved, execution_enabled: true })).toBe(false);
    expect(parses({ ...reserved, manual_owner_funding_only: false })).toBe(false);
    expect(parses({ ...reserved, replayed_existing: true })).toBe(false);
    expect(parses({ ...reserved, transaction_built: true })).toBe(false);
    expect(parses({ ...reserved, wallet_signature: "forbidden" })).toBe(false);
    expect(parses({ ...reserved, signed_transaction: "forbidden" })).toBe(false);
    expect(parses({ ...reserved, broadcast: true })).toBe(false);
  });

  it("validates the reserve result through the typed REST envelope", async () => {
    const request = await reserveRequest();
    const result = await reserveResult();
    const fetch = vi.fn(async () => Response.json({
      ok: true,
      data: result,
      asOf: "2026-11-02T12:53:00.000Z",
      asOfBasis: "durable-admission-store",
    }));
    const client = createHarborRestClient({
      baseUrl: "http://127.0.0.1:8791",
      apiKey: "fixture-key",
      mock: false,
      fetch,
    });

    await expect(client.op("near.intents.owner-funded.reserve", request))
      .resolves.toMatchObject({ ok: true, data: result });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
