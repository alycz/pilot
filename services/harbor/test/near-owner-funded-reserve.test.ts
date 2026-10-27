import { describe, expect, it, vi } from "vitest";

import type {
  NearHostedNativeToArbitrumBinding,
  NearHostedReserveInput,
} from "../src/near/attempt-store";
import { ops } from "../src/ops/near-intents";

const NOW = "2026-10-26T12:00:30.000Z";
const GATEWAY_PRINCIPAL = "approval-gateway";
const USER_PRINCIPAL = "near-wallet-principal-v1-owner";
const TENANT = "pilot-internal";
const OWNER = "owner.near";
const DEPOSIT = "native-near-deposit.near";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const QUOTE_HASH = "1".repeat(44);
const REQUEST_DIGEST = "A".repeat(64);
const POLICY_DIGEST = "B".repeat(64);
const AMOUNT = "100000000000000000000000";
const BUDGET = "200000000000000000000000";
const MIN_OUT = "297000";

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
  destination_asset_id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" as const,
  destination_token_contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as const,
  destination_decimals: 6 as const,
  deposit_mode: "SIMPLE" as const,
  funding_mode: "manual-owner-wallet-send" as const,
  manual_owner_funding_only: true as const,
  pilot_budget_scope: "does-not-control-owner-wallet-send" as const,
};

const quoteRequest = {
  dry: false as const,
  swapType: "EXACT_INPUT" as const,
  slippageTolerance: 100,
  originAsset: route.origin_asset_id,
  depositType: "ORIGIN_CHAIN" as const,
  destinationAsset: route.destination_asset_id,
  amount: AMOUNT,
  refundTo: OWNER,
  refundType: "ORIGIN_CHAIN" as const,
  recipient: RECIPIENT,
  recipientType: "DESTINATION_CHAIN" as const,
  deadline: "2026-10-26T12:05:00.000Z",
  depositMode: "SIMPLE" as const,
  confidentiality: "public" as const,
  quoteWaitingTimeMs: 0,
  insured: false as const,
};

const providerQuoteResponse = {
  correlationId: "native-near-owner-funded",
  timestamp: "2026-10-26T11:59:00.000Z",
  signature: "provider-signature",
  quoteRequest,
  quote: {
    amountIn: AMOUNT,
    amountInFormatted: "0.1",
    amountInUsd: "0.3",
    minAmountIn: AMOUNT,
    amountOut: "300000",
    amountOutFormatted: "0.3",
    amountOutUsd: "0.3",
    minAmountOut: MIN_OUT,
    timeEstimate: 120,
    depositAddress: DEPOSIT,
    deadline: quoteRequest.deadline,
    timeWhenInactive: "2026-10-26T12:04:00.000Z",
  },
};

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new Error("unsupported fixture value");
}

async function digest(payload: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `pilot.near-intents.native-near-to-arbitrum-usdc.approval.v1\0${canonical(payload)}`,
    ),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function request() {
  const quoteBinding = {
    version: "pilot-near-native-to-arbitrum-usdc-quote-binding-v1" as const,
    route,
    provider_signature_verified: true as const,
    provider_signature: providerQuoteResponse.signature,
    quote_hash: QUOTE_HASH,
    correlation_id: providerQuoteResponse.correlationId,
    provider_timestamp: providerQuoteResponse.timestamp,
    request_echo: quoteRequest,
    provider_quote_response: providerQuoteResponse,
    amount_in: AMOUNT,
    min_amount_out: MIN_OUT,
    recipient: RECIPIENT,
    refund_to: OWNER,
    deposit_address: DEPOSIT,
    deposit_memo_present: false as const,
    provider_deadline_at: quoteRequest.deadline,
    provider_time_when_inactive_at: providerQuoteResponse.quote.timeWhenInactive,
    approval_expires_at: "2026-10-26T12:03:00.000Z",
  };
  const payload = {
    version: "pilot-near-native-near-to-arbitrum-usdc-approval-payload-v1" as const,
    route,
    principal_id: USER_PRINCIPAL,
    near_account_id: OWNER,
    network: "near:mainnet" as const,
    policy_digest: POLICY_DIGEST,
    quote_hash: QUOTE_HASH,
    correlation_id: providerQuoteResponse.correlationId,
    origin_asset_id: route.origin_asset_id,
    destination_asset_id: route.destination_asset_id,
    amount_in: AMOUNT,
    min_amount_out: MIN_OUT,
    recipient: RECIPIENT,
    refund_to: OWNER,
    deposit_address: DEPOSIT,
    deposit_memo_present: false as const,
    provider_deadline_at: quoteRequest.deadline,
    approved_at: "2026-10-26T12:00:00.000Z",
    approval_expires_at: quoteBinding.approval_expires_at,
    reservation: {
      version: "pilot-near-native-near-to-arbitrum-usdc-reservation-v1" as const,
      reservation_id: "reservation-1",
      attempt_id: "attempt-1",
      principal_id: USER_PRINCIPAL,
      near_account_id: OWNER,
      network: "near:mainnet" as const,
      idempotency_version: "pilot-near-idempotency-v1" as const,
      idempotency_key: "idempotency-1",
      request_digest: REQUEST_DIGEST,
      asset_id: route.origin_asset_id,
      amount_atomic: AMOUNT,
      expected_revision: 0 as const,
      reserved_revision: 1 as const,
    },
  };
  const approvalDigest = await digest(payload);
  return {
    version: "pilot-near-native-to-arbitrum-usdc-reserve-request-v1" as const,
    quote_binding: quoteBinding,
    approval: {
      version: "pilot-near-native-near-to-arbitrum-usdc-economic-approval-v1" as const,
      payload,
      approval_digest: approvalDigest,
      account_control: {
        version: "pilot-near-account-control-proof-v1" as const,
        proof_kind: "nep413" as const,
        scope: "source-account-control-only" as const,
        grants_economic_transfer_approval: false as const,
        authorization_id: "wallet-proof-1",
        principal_id: USER_PRINCIPAL,
        near_account_id: OWNER,
        network: "near:mainnet" as const,
        verified_at: "2026-10-26T11:59:30.000Z",
      },
      economic_approval: {
        approval_id: "owner-approval-1",
        method: "owner-reviewed-native-near-transfer" as const,
        owner_confirmed: true as const,
        approved_payload_digest: approvalDigest,
        confirmed_at: payload.approved_at,
      },
    },
    idempotency_version: "pilot-near-idempotency-v1" as const,
    idempotency_key: payload.reservation.idempotency_key,
    attempt_id: payload.reservation.attempt_id,
    reservation_id: payload.reservation.reservation_id,
  };
}

const env = {
  HARBOR_NEAR_INTENTS_OWNER_FUNDED_RESERVE_ENABLED: "true",
  HARBOR_NEAR_INTENTS_OWNER_FUNDED_REVIEW_ENABLED: "true",
  HARBOR_NEAR_INTENTS_EXECUTABLE_REVIEW_PROFILE: "near-native-to-arbitrum-usdc-v1",
  HARBOR_NEAR_INTENTS_APPROVAL_GATEWAY_PRINCIPAL: GATEWAY_PRINCIPAL,
  HARBOR_NEAR_INTENTS_TENANT_ID: TENANT,
  HARBOR_NEAR_INTENTS_NATIVE_NEAR_BUDGET_LIMIT_ATOMIC: BUDGET,
  HARBOR_API_KEYS: `${GATEWAY_PRINCIPAL}:secret`,
  MAINNET_EXECUTION: "false",
};

function reserveOp() {
  const op = ops.find((candidate) => candidate.name === "near.intents.owner-funded.reserve");
  if (!op) throw new Error("missing owner-funded reserve operation");
  return op;
}

function store(replay = false) {
  return {
    reserveNativeNearToArbitrum: vi.fn(async (
      input: NearHostedReserveInput,
      _binding: NearHostedNativeToArbitrumBinding,
    ) => ({
      replay,
      attempt: {
        tenantId: TENANT,
        principalId: USER_PRINCIPAL,
        accountId: input.accountId,
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
        attemptId: input.attemptId,
        reservationId: input.reservationId,
        assetId: input.assetId,
        amountAtomic: input.amountAtomic,
        budgetLimitAtomic: input.budgetLimitAtomic,
        state: "approved" as const,
        reservationState: "reserved" as const,
        entryRevision: 1,
        reservationRevision: 1,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
      lifecycle: {
        tenantId: TENANT,
        principalId: USER_PRINCIPAL,
        accountId: input.accountId,
        idempotencyKey: input.idempotencyKey,
        attemptId: input.attemptId,
        reservationId: input.reservationId,
        lifecycleState: "reserved" as const,
        lifecycleRevision: 0,
        entryRevision: 1,
        updatedAt: input.createdAt,
      },
    })),
  };
}

function context(reservationStore = store(), overrides: Record<string, unknown> = {}) {
  return {
    principal: GATEWAY_PRINCIPAL,
    env,
    db: { prepare: vi.fn(), batch: vi.fn() },
    nearNativeAttemptStore: reservationStore,
    nearOneClickAdmissionQuoteVerifier: vi.fn(() => true),
    nearOneClickAdmissionQuoteHasher: vi.fn(() => QUOTE_HASH),
    ...overrides,
  };
}

describe("near.intents.owner-funded.reserve", () => {
  it("durably admits an exact live approval before returning manual funding instructions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const reservationStore = store();
    const result = await reserveOp().handler(context(reservationStore), await request()) as Record<string, any>;

    expect(reservationStore.reserveNativeNearToArbitrum).toHaveBeenCalledOnce();
    const [input, binding] = reservationStore.reserveNativeNearToArbitrum.mock.calls[0]!;
    expect(input).toMatchObject({
      accountId: OWNER,
      authorizationId: "wallet-proof-1",
      idempotencyKey: "idempotency-1",
      requestDigest: REQUEST_DIGEST,
      requestFingerprint: REQUEST_DIGEST,
      approvalDigest: result.approval_digest,
      policyDigest: POLICY_DIGEST,
      quoteHash: QUOTE_HASH,
      depositAddress: DEPOSIT,
      amountAtomic: AMOUNT,
      budgetLimitAtomic: BUDGET,
      artifactKind: "provider_verified_executable_quote",
      providerSignatureVerified: true,
    });
    expect(input).not.toHaveProperty("depositMemo");
    expect(binding).toMatchObject({
      version: "pilot-near-native-to-arbitrum-usdc-hosted-binding-v1",
      accountId: OWNER,
      quoteHash: QUOTE_HASH,
      amountIn: AMOUNT,
      refundTo: OWNER,
      depositAddress: DEPOSIT,
      destinationRecipient: RECIPIENT,
      minAmountOut: MIN_OUT,
    });
    expect(result).toMatchObject({
      version: "pilot-near-native-to-arbitrum-usdc-reserve-result-v1",
      source: "live",
      provider_signature_verified: true,
      action: "reserved",
      replayed_existing: false,
      admission_id: "owner-approval-1",
      attempt_state: "approved",
      reservation_state: "reserved",
      execution_enabled: false,
      manual_owner_funding_only: true,
      funding_instructions: {
        funding_method: "manual-native-near-transfer",
        source_account_id: OWNER,
        refund_account_id: OWNER,
        deposit_account_id: DEPOSIT,
        destination_recipient: RECIPIENT,
        amount_yocto_near: AMOUNT,
        deposit_memo_present: false,
      },
    });
    expect(result).not.toHaveProperty("transaction");
    expect(result).not.toHaveProperty("signing_request");
    expect(result).not.toHaveProperty("broadcast");
    expect(result.funding_instructions).not.toHaveProperty("transaction");
    expect(result.funding_instructions).not.toHaveProperty("signing_request");
    expect(result.funding_instructions).not.toHaveProperty("broadcast");
    vi.useRealTimers();
  });

  it("returns a truthful replay result for the exact durable reservation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const result = await reserveOp().handler(context(store(true)), await request()) as Record<string, unknown>;
    expect(result).toMatchObject({ action: "replay", replayed_existing: true });
    vi.useRealTimers();
  });

  it("rejects disabled, untrusted-principal, and non-D1 runtimes before store admission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const args = await request();
    await expect(reserveOp().handler(context(store(), {
      env: { ...env, HARBOR_NEAR_INTENTS_OWNER_FUNDED_RESERVE_ENABLED: "false" },
    }), args)).rejects.toMatchObject({ code: "OWNER_FUNDED_RESERVE_DISABLED" });
    await expect(reserveOp().handler(context(store(), { principal: "other-principal" }), args))
      .rejects.toMatchObject({ code: "OWNER_FUNDED_RESERVE_AUTH_REQUIRED" });
    await expect(reserveOp().handler(context(store(), { db: undefined }), args))
      .rejects.toMatchObject({ code: "OWNER_FUNDED_RESERVE_D1_REQUIRED" });
    vi.useRealTimers();
  });

  it("rejects browser budget fields, over-budget amounts, fixtures, tampering, and cross-owner approvals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const op = reserveOp();
    const valid = await request();
    expect(op.args.safeParse({ ...valid, budget_limit_atomic: BUDGET }).success).toBe(false);
    await expect(op.handler(context(store(), {
      env: { ...env, HARBOR_NEAR_INTENTS_NATIVE_NEAR_BUDGET_LIMIT_ATOMIC: "1" },
    }), valid)).rejects.toMatchObject({ code: "OWNER_FUNDED_RESERVE_BUDGET_EXCEEDED" });
    await expect(op.handler(context(store(), {
      nearOneClickAdmissionQuoteVerifier: vi.fn(() => false),
    }), valid)).rejects.toMatchObject({ code: "OWNER_FUNDED_RESERVE_PROVIDER_VERIFICATION_FAILED" });
    await expect(op.handler(context(), {
      ...valid,
      approval: { ...valid.approval, approval_digest: "C".repeat(64) },
    })).rejects.toMatchObject({ code: "OWNER_FUNDED_RESERVE_INVALID" });
    await expect(op.handler(context(), {
      ...valid,
      approval: {
        ...valid.approval,
        account_control: { ...valid.approval.account_control, near_account_id: "attacker.near" },
      },
    })).rejects.toMatchObject({ code: "OWNER_FUNDED_RESERVE_INVALID" });
    vi.useRealTimers();
  });

  it("rejects stale approvals before durable admission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-26T12:03:00.000Z");
    const reservationStore = store();
    await expect(reserveOp().handler(context(reservationStore), await request()))
      .rejects.toMatchObject({ code: "OWNER_FUNDED_RESERVE_EXPIRED" });
    expect(reservationStore.reserveNativeNearToArbitrum).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
