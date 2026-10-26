import { describe, expect, it } from "vitest";

import {
  canonicalNearApprovalJson,
  computeNearApprovalDigest,
  NEAR_APPROVAL_DIGEST_DOMAIN,
  Near1ClickDryQuoteRequestSchema,
  Near1ClickDryQuoteResponseSchema,
  Near1ClickExecutableQuoteResponseSchema,
  Near1ClickProviderStatusSchema,
  Near1ClickTokenSchema,
  NearApprovalBindingSchema,
  NearBudgetReservationSchema,
  NearBudgetReservationTransitionSchema,
  NearExecutionAttemptSchema,
  NearExecutionReplayDecisionSchema,
  NearIdempotencyBindingSchema,
  NearPrincipalAuthorizationSchema,
  NearReconciliationEvidenceSchema,
  NearWalletExecutionPolicySchema,
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
