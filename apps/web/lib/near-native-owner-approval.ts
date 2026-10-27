import {
  NearNativeNearToArbitrumUsdcEconomicApprovalEnvelopeSchema,
  NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
  computeNearNativeNearToArbitrumUsdcApprovalDigest,
  type NearNativeNearToArbitrumUsdcEconomicApprovalEnvelope,
  type NearNativeNearToArbitrumUsdcExecutableQuoteBinding,
} from "@pilot/contracts/near";
import { z } from "zod";

const NearApprovalChallengeSchema = z.object({
  authorization_id: z.string().min(1).max(128),
  principal_id: z.string().min(1).max(128),
  account_id: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/),
  network: z.literal("near:mainnet"),
  nonce: z.string().refine((value) => {
    try {
      const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
      return globalThis.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")).length === 32;
    } catch {
      return false;
    }
  }, "nonce must encode exactly 32 bytes"),
  recipient: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/),
  issued_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }),
}).strict();

export type NearApprovalChallenge = z.infer<typeof NearApprovalChallengeSchema>;

export type NearNativeOwnerApprovalReadiness =
  | "ready"
  | "fixture-only"
  | "invalid"
  | "expired";

export type NearNativeOwnerApprovalReview = Readonly<{
  provenance: "live" | "fixture";
  readiness: NearNativeOwnerApprovalReadiness;
  canRequestWalletControl: boolean;
  canConfirmEconomicApproval: boolean;
  notice: string;
  quote?: NearNativeNearToArbitrumUsdcExecutableQuoteBinding;
  envelope?: NearNativeNearToArbitrumUsdcEconomicApprovalEnvelope;
  challenge?: NearApprovalChallenge;
  approvalRows: readonly Readonly<{ label: string; value: string; mono?: boolean }>[];
  fundingRows: readonly Readonly<{ label: string; value: string; mono?: boolean }>[];
}>;

function invalid(provenance: "live" | "fixture", message: string): NearNativeOwnerApprovalReview {
  return Object.freeze({
    provenance,
    readiness: "invalid",
    canRequestWalletControl: false,
    canConfirmEconomicApproval: false,
    notice: message,
    quote: undefined,
    envelope: undefined,
    challenge: undefined,
    approvalRows: Object.freeze([]),
    fundingRows: Object.freeze([]),
  });
}

function quoteMatchesApproval(
  quote: NearNativeNearToArbitrumUsdcExecutableQuoteBinding,
  envelope: NearNativeNearToArbitrumUsdcEconomicApprovalEnvelope,
): boolean {
  const approval = envelope.payload;
  return JSON.stringify(approval.route) === JSON.stringify(quote.route)
    && approval.quote_hash === quote.quote_hash
    && approval.correlation_id === quote.correlation_id
    && approval.origin_asset_id === quote.route.origin_asset_id
    && approval.destination_asset_id === quote.route.destination_asset_id
    && approval.amount_in === quote.amount_in
    && approval.min_amount_out === quote.min_amount_out
    && approval.recipient.toLowerCase() === quote.recipient.toLowerCase()
    && approval.refund_to === quote.refund_to
    && approval.deposit_address === quote.deposit_address
    && approval.deposit_memo_present === quote.deposit_memo_present
    && approval.provider_deadline_at === quote.provider_deadline_at;
}

export async function reviewNearNativeOwnerApproval(input: Readonly<{
  provenance: "live" | "fixture";
  quote: unknown;
  envelope: unknown;
  challenge: unknown;
  now?: number;
}>): Promise<NearNativeOwnerApprovalReview> {
  const quote = NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema.safeParse(input.quote);
  const envelope = NearNativeNearToArbitrumUsdcEconomicApprovalEnvelopeSchema.safeParse(
    input.envelope,
  );
  const challenge = NearApprovalChallengeSchema.safeParse(input.challenge);
  if (!quote.success || !envelope.success || !challenge.success) {
    return invalid(input.provenance, "The quote, wallet-control challenge, or economic approval is incomplete.");
  }
  const approval = envelope.data.payload;
  const control = envelope.data.account_control;
  const exactDigest = await computeNearNativeNearToArbitrumUsdcApprovalDigest(approval);
  if (
    exactDigest !== envelope.data.approval_digest
    || !quoteMatchesApproval(quote.data, envelope.data)
    || challenge.data.authorization_id !== control.authorization_id
    || challenge.data.principal_id !== approval.principal_id
    || challenge.data.account_id !== approval.near_account_id
    || challenge.data.network !== approval.network
  ) {
    return invalid(input.provenance, "The wallet-control proof or economic approval does not bind the exact verified quote.");
  }
  const now = input.now ?? Date.now();
  if (
    Date.parse(challenge.data.issued_at) > now
    || Date.parse(challenge.data.expires_at) <= now
    || Date.parse(approval.approved_at) > now
    || Date.parse(approval.approval_expires_at) <= now
    || Date.parse(approval.provider_deadline_at) <= now
  ) {
    return Object.freeze({
      provenance: input.provenance,
      readiness: "expired",
      canRequestWalletControl: false,
      canConfirmEconomicApproval: false,
      notice: "The wallet-control challenge or economic approval expired. Request a fresh verified quote.",
      quote: quote.data,
      envelope: envelope.data,
      challenge: challenge.data,
      approvalRows: Object.freeze([]),
      fundingRows: Object.freeze([]),
    });
  }

  const approvalRows = Object.freeze([
    { label: "Principal", value: approval.principal_id, mono: true },
    { label: "Source account", value: approval.near_account_id, mono: true },
    { label: "Network", value: approval.network, mono: true },
    { label: "NEP-413 challenge nonce", value: challenge.data.nonce, mono: true },
    { label: "NEP-413 recipient", value: challenge.data.recipient, mono: true },
    { label: "Wallet-control proof expires", value: challenge.data.expires_at, mono: true },
    { label: "Quote hash", value: approval.quote_hash, mono: true },
    { label: "Correlation ID", value: approval.correlation_id, mono: true },
    { label: "Input asset ID", value: approval.origin_asset_id, mono: true },
    { label: "Input amount · yoctoNEAR", value: approval.amount_in, mono: true },
    { label: "Destination asset ID", value: approval.destination_asset_id, mono: true },
    { label: "Minimum output · USDC atomic", value: approval.min_amount_out, mono: true },
    { label: "Arbitrum recipient", value: approval.recipient, mono: true },
    { label: "NEAR refund account", value: approval.refund_to, mono: true },
    { label: "Provider deposit account", value: approval.deposit_address, mono: true },
    { label: "Deposit memo", value: "None · SIMPLE deposit only" },
    { label: "Economic approval expires", value: approval.approval_expires_at, mono: true },
    { label: "Provider refund processing begins after", value: approval.provider_deadline_at, mono: true },
    { label: "Reservation ID", value: approval.reservation.reservation_id, mono: true },
    { label: "Approval digest", value: envelope.data.approval_digest, mono: true },
  ]);
  const fundingRows = Object.freeze([
    { label: "Owner wallet network", value: "NEAR mainnet" },
    { label: "Transfer asset", value: "Native NEAR · not a wNEAR token transfer" },
    { label: "Exact amount · yoctoNEAR", value: approval.amount_in, mono: true },
    { label: "Exact deposit account", value: approval.deposit_address, mono: true },
    { label: "Memo", value: "None · do not add one" },
    { label: "Destination", value: `Canonical Arbitrum USDC · ${approval.recipient}`, mono: true },
    { label: "Canonical USDC contract", value: approval.route.destination_token_contract, mono: true },
    { label: "Transaction actor", value: "Owner wallet only" },
  ]);
  const fixtureOnly = input.provenance === "fixture";
  return Object.freeze({
    provenance: input.provenance,
    readiness: fixtureOnly ? "fixture-only" : "ready",
    canRequestWalletControl: !fixtureOnly,
    canConfirmEconomicApproval: !fixtureOnly,
    notice: fixtureOnly
      ? "Local fixture only. No provider quote was requested and no wallet-control or economic approval occurred."
      : "Fresh wallet control and a distinct owner economic approval are required for this exact quote.",
    quote: quote.data,
    envelope: envelope.data,
    challenge: challenge.data,
    approvalRows,
    fundingRows,
  });
}

const ROUTE = Object.freeze({
  version: "pilot-near-native-to-arbitrum-usdc-route-v1",
  profile_status: "hosted-default-off",
  execution_default: "off",
  activation_gate: "independent-source-and-destination-receipt-verification-required",
  origin_chain: "near",
  origin_network: "near:mainnet",
  origin_asset_id: "nep141:wrap.near",
  origin_token_contract: "wrap.near",
  origin_decimals: 24,
  source_transfer_asset: "native-near",
  managed_wrapping_by_1click: true,
  destination_chain: "arb",
  destination_chain_id: 42161,
  destination_asset_id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  destination_token_contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  destination_decimals: 6,
  deposit_mode: "SIMPLE",
  funding_mode: "manual-owner-wallet-send",
  manual_owner_funding_only: true,
  pilot_budget_scope: "does-not-control-owner-wallet-send",
} as const);

export async function createNearNativeOwnerApprovalFixture(): Promise<NearNativeOwnerApprovalReview> {
  const request = {
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: 100,
    originAsset: ROUTE.origin_asset_id,
    depositType: "ORIGIN_CHAIN" as const,
    destinationAsset: ROUTE.destination_asset_id,
    amount: "1000000000000000000000000",
    refundTo: "owner-demo.near",
    refundType: "ORIGIN_CHAIN" as const,
    recipient: "0x1111111111111111111111111111111111110042",
    recipientType: "DESTINATION_CHAIN" as const,
    deadline: "2099-01-02T00:00:00.000Z",
    depositMode: "SIMPLE" as const,
    confidentiality: "public" as const,
    quoteWaitingTimeMs: 0,
    insured: false as const,
    dry: false as const,
  };
  const providerQuote = {
    correlationId: "fixture-native-near-correlation-001",
    timestamp: "2099-01-01T00:00:00.000Z",
    signature: "fixture-provider-signature-not-verified-here",
    quoteRequest: request,
    quote: {
      amountIn: request.amount,
      amountInFormatted: "1",
      amountInUsd: "5",
      minAmountIn: request.amount,
      amountOut: "4980000",
      amountOutFormatted: "4.98",
      amountOutUsd: "4.98",
      minAmountOut: "4900000",
      timeEstimate: 60,
      depositAddress: "deposit-demo.near",
      deadline: request.deadline,
      timeWhenInactive: "2099-01-01T23:55:00.000Z",
    },
  };
  const quote = {
    version: "pilot-near-native-to-arbitrum-usdc-quote-binding-v1" as const,
    route: ROUTE,
    provider_signature_verified: true as const,
    provider_signature: providerQuote.signature,
    quote_hash: "B".repeat(44),
    correlation_id: providerQuote.correlationId,
    provider_timestamp: providerQuote.timestamp,
    request_echo: request,
    provider_quote_response: providerQuote,
    amount_in: request.amount,
    min_amount_out: providerQuote.quote.minAmountOut,
    recipient: request.recipient,
    refund_to: request.refundTo,
    deposit_address: providerQuote.quote.depositAddress,
    deposit_memo_present: false as const,
    provider_deadline_at: request.deadline,
    provider_time_when_inactive_at: providerQuote.quote.timeWhenInactive,
    approval_expires_at: "2099-01-01T00:06:00.000Z",
  };
  const payload = {
    version: "pilot-near-native-near-to-arbitrum-usdc-approval-payload-v1" as const,
    route: ROUTE,
    principal_id: "fixture-principal",
    near_account_id: "owner-demo.near",
    network: "near:mainnet" as const,
    policy_digest: "A".repeat(64),
    quote_hash: quote.quote_hash,
    correlation_id: quote.correlation_id,
    origin_asset_id: ROUTE.origin_asset_id,
    destination_asset_id: ROUTE.destination_asset_id,
    amount_in: quote.amount_in,
    min_amount_out: quote.min_amount_out,
    recipient: quote.recipient,
    refund_to: quote.refund_to,
    deposit_address: quote.deposit_address,
    deposit_memo_present: false as const,
    provider_deadline_at: quote.provider_deadline_at,
    approved_at: "2099-01-01T00:01:00.000Z",
    approval_expires_at: "2099-01-01T00:06:00.000Z",
    reservation: {
      version: "pilot-near-native-near-to-arbitrum-usdc-reservation-v1" as const,
      reservation_id: "fixture-reservation-001",
      attempt_id: "fixture-attempt-001",
      principal_id: "fixture-principal",
      near_account_id: "owner-demo.near",
      network: "near:mainnet" as const,
      idempotency_version: "pilot-near-idempotency-v1" as const,
      idempotency_key: "fixture-idempotency-001",
      request_digest: "C".repeat(64),
      asset_id: ROUTE.origin_asset_id,
      amount_atomic: quote.amount_in,
      expected_revision: 0,
      reserved_revision: 1,
    },
  };
  const approvalDigest = await computeNearNativeNearToArbitrumUsdcApprovalDigest(payload);
  const envelope = {
    version: "pilot-near-native-near-to-arbitrum-usdc-economic-approval-v1" as const,
    payload,
    approval_digest: approvalDigest,
    account_control: {
      version: "pilot-near-account-control-proof-v1" as const,
      proof_kind: "nep413" as const,
      scope: "source-account-control-only" as const,
      grants_economic_transfer_approval: false as const,
      authorization_id: "fixture-authorization-001",
      principal_id: payload.principal_id,
      near_account_id: payload.near_account_id,
      network: payload.network,
      verified_at: payload.approved_at,
    },
    economic_approval: {
      approval_id: "fixture-economic-approval-001",
      method: "owner-reviewed-native-near-transfer" as const,
      owner_confirmed: true as const,
      approved_payload_digest: approvalDigest,
      confirmed_at: payload.approved_at,
    },
  };
  return reviewNearNativeOwnerApproval({
    provenance: "fixture",
    quote,
    envelope,
    challenge: {
      authorization_id: envelope.account_control.authorization_id,
      principal_id: payload.principal_id,
      account_id: payload.near_account_id,
      network: payload.network,
      nonce: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
      recipient: "pilot.near",
      issued_at: "2099-01-01T00:00:00.000Z",
      expires_at: "2099-01-01T00:05:00.000Z",
    },
    now: Date.parse("2099-01-01T00:02:00.000Z"),
  });
}

