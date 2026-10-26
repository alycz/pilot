import { describe, expect, it } from "vitest";

import {
  computeNearApprovalDigest,
  Near1ClickDryQuoteRequestSchema,
  Near1ClickDryQuoteResponseSchema,
  Near1ClickExecutableQuoteResponseSchema,
  Near1ClickProviderStatusSchema,
  Near1ClickTokenSchema,
  NearApprovalBindingSchema,
  NearExecutionAttemptSchema,
  NearExecutionReplayDecisionSchema,
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
  version: "pilot-near-1click-approval-v1",
  principal_id: "principal-1",
  network: "near:mainnet",
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
    expect(await computeNearApprovalDigest({ ...approval })).toBe(digest);
    expect(await computeNearApprovalDigest({ ...approval, recipient: "bob.near" })).not.toBe(digest);
    expect(await computeNearApprovalDigest({ ...approval, deposit_memo: "12345" })).not.toBe(digest);
  });

  it("expires Pilot approval no later than the provider refund deadline", () => {
    expect(NearApprovalBindingSchema.safeParse({
      ...approval,
      approval_expires_at: "2026-11-02T12:00:01.000Z",
    }).success).toBe(false);
  });

  it("requires durable uncertainty evidence and exposes no retry action", async () => {
    const base = {
      attempt_id: "attempt-1",
      principal_id: "principal-1",
      idempotency_key: "attempt-1",
      approval_digest: await computeNearApprovalDigest(approval),
      quote_id: "quote-123",
      state: "unknown" as const,
      updated_at: "2026-11-02T11:59:00.000Z",
    };
    expect(NearExecutionAttemptSchema.safeParse(base).success).toBe(false);
    const attempt = NearExecutionAttemptSchema.parse({
      ...base,
      unknown_since: "2026-11-02T11:59:00.000Z",
    });
    expect(NearExecutionReplayDecisionSchema.parse({
      action: "blocked_unknown",
      attempt,
      safe_to_resubmit: false,
    }).action).toBe("blocked_unknown");
    expect(NearExecutionReplayDecisionSchema.options.every((option) =>
      option.safeParse({ action: "retry", attempt }).success === false)).toBe(true);
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
