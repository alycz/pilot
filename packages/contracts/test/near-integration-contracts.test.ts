import { describe, expect, it } from "vitest";

import {
  computeNearApprovalDigest,
  Near1ClickDryQuoteRequestSchema,
  Near1ClickDryQuoteResponseSchema,
  Near1ClickExecutableQuoteRequestSchema,
  Near1ClickExecutableQuoteResponseSchema,
  Near1ClickQuoteResponseSchema,
  Near1ClickStatusResponseSchema,
  NearApprovalBindingSchema,
  NearExecutionAttemptSchema,
  NearExecutionReplayDecisionSchema,
  NearWalletExecutionPolicySchema,
  type NearApprovalBinding,
} from "../src/near";

const request = {
  dry: true as const,
  swapType: "EXACT_INPUT" as const,
  slippageTolerance: 100,
  originAsset: "nep141:wrap.near",
  depositType: "ORIGIN_CHAIN" as const,
  destinationAsset: "nep141:eth-0xa0b8.omft.near",
  amount: "1000000000000000000000000",
  refundTo: "alice.near",
  refundType: "ORIGIN_CHAIN" as const,
  recipient: "0x0123456789abcdef",
  recipientType: "DESTINATION_CHAIN" as const,
  deadline: "2026-11-02T12:00:00.000Z",
  depositMode: "SIMPLE" as const,
  confidentiality: "public" as const,
  quoteWaitingTimeMs: 0,
  insured: false as const,
};

const amounts = {
  amountIn: request.amount,
  amountInFormatted: "1",
  amountInUsd: "2.79",
  minAmountIn: request.amount,
  amountOut: "2780000",
  amountOutFormatted: "2.78",
  amountOutUsd: "2.78",
  minAmountOut: "2750000",
  timeEstimate: 120,
};

const header = {
  correlationId: "correlation-123",
  timestamp: "2026-11-02T11:55:00.000Z",
  signature: "provider-signature",
};

const executableRequest = { ...request, dry: false as const };
const executableQuote = {
  ...header,
  quoteRequest: executableRequest,
  quote: {
    ...amounts,
    depositAddress: "deposit.near",
    depositMemo: "route-123",
    deadline: "2026-11-02T12:00:00.000Z",
    timeWhenInactive: "2026-11-02T12:00:00.000Z",
  },
};

const approval: NearApprovalBinding = {
  version: "pilot-near-1click-approval-v2",
  principal_id: "principal-1",
  account_id: "alice.near",
  network: "near:mainnet",
  idempotency_version: "pilot-near-idempotency-v1",
  idempotency_key: "attempt-1",
  policy_digest: "A".repeat(64),
  quote_id: header.correlationId,
  quote_hash: "4".repeat(44),
  provider_signature_verified: true,
  origin_asset: request.originAsset,
  destination_asset: request.destinationAsset,
  amount_in: request.amount,
  min_amount_out: amounts.minAmountOut,
  recipient: request.recipient,
  refund_to: request.refundTo,
  deposit_address: executableQuote.quote.depositAddress,
  deposit_memo: executableQuote.quote.depositMemo,
  approval_expires_at: "2026-11-02T11:58:00.000Z",
  provider_deadline_at: executableQuote.quote.deadline,
};

describe("NEAR cross-layer contract boundaries", () => {
  it("parses the official nested dry shape while rejecting flat legacy shapes", () => {
    const parsedRequest = Near1ClickDryQuoteRequestSchema.parse(request);
    const nested = { ...header, quoteRequest: parsedRequest, quote: amounts };

    expect(Near1ClickDryQuoteResponseSchema.parse(nested)).toEqual(nested);
    expect(Near1ClickQuoteResponseSchema.safeParse({
      ...header,
      quoteRequest: parsedRequest,
      ...amounts,
      depositAddress: "deposit.near",
    }).success).toBe(false);
  });

  it("never upgrades a dry quote into executable authorization", () => {
    const parsedRequest = Near1ClickDryQuoteRequestSchema.parse(request);
    for (const executionField of ["depositAddress", "depositMemo", "deadline", "timeWhenInactive"] as const) {
      expect(Near1ClickDryQuoteResponseSchema.safeParse({
        ...header,
        quoteRequest: parsedRequest,
        quote: { ...amounts, [executionField]: "must-not-be-consumed" },
      }).success, executionField).toBe(false);
    }

    expect(Near1ClickExecutableQuoteResponseSchema.safeParse({
      ...header,
      quoteRequest: parsedRequest,
      quote: executableQuote.quote,
    }).success).toBe(false);
  });

  it("requires a fresh executable request and all provider execution bounds", () => {
    expect(Near1ClickExecutableQuoteRequestSchema.parse(executableRequest).dry).toBe(false);
    expect(Near1ClickExecutableQuoteResponseSchema.parse(executableQuote)).toEqual(executableQuote);

    for (const field of ["depositAddress", "deadline", "timeWhenInactive"] as const) {
      const quote = { ...executableQuote.quote };
      delete quote[field];
      expect(Near1ClickExecutableQuoteResponseSchema.safeParse({
        ...executableQuote,
        quote,
      }).success, field).toBe(false);
    }
  });

  it("accepts transaction hashes only under swapDetails", () => {
    const status = {
      correlationId: header.correlationId,
      quoteResponse: executableQuote,
      status: "PROCESSING" as const,
      updatedAt: "2026-11-02T11:59:00.000Z",
      swapDetails: {
        intentHashes: ["intent-hash"],
        nearTxHashes: ["near-hash"],
        originChainTxHashes: [],
        destinationChainTxHashes: [],
      },
    };
    expect(Near1ClickStatusResponseSchema.parse(status)).toEqual(status);
    expect(Near1ClickStatusResponseSchema.safeParse({
      ...status,
      nearTxHashes: ["forged-top-level-hash"],
    }).success).toBe(false);
  });

  it("allows only HTTPS explorer links in provider transaction details", () => {
    const status = {
      correlationId: header.correlationId,
      quoteResponse: executableQuote,
      status: "SUCCESS" as const,
      updatedAt: "2026-11-02T11:59:00.000Z",
      swapDetails: {
        intentHashes: ["intent-hash"],
        nearTxHashes: ["near-hash"],
        originChainTxHashes: [{
          hash: "origin-hash",
          explorerUrl: "https://explorer.example/tx/origin-hash",
        }],
        destinationChainTxHashes: [],
      },
    };
    expect(Near1ClickStatusResponseSchema.safeParse(status).success).toBe(true);
    for (const explorerUrl of [
      "http://explorer.example/tx/origin-hash",
      "https://user:password@explorer.example/tx/origin-hash",
      "javascript:alert(1)",
      "data:text/html,unsafe",
    ]) {
      expect(Near1ClickStatusResponseSchema.safeParse({
        ...status,
        swapDetails: {
          ...status.swapDetails,
          originChainTxHashes: [{ hash: "origin-hash", explorerUrl }],
        },
      }).success, explorerUrl).toBe(false);
    }
  });
});

describe("NEAR approval and replay integrity", () => {
  it("digest-binds every economic, routing, provider, and tenant field", async () => {
    const digest = await computeNearApprovalDigest(NearApprovalBindingSchema.parse(approval));
    const mutations: Array<[string, NearApprovalBinding]> = [
      ["principal", { ...approval, principal_id: "principal-2" }],
      ["account", { ...approval, account_id: "mallory.near" }],
      ["idempotency", { ...approval, idempotency_key: "attempt-2" }],
      ["policy", { ...approval, policy_digest: "C".repeat(64) }],
      ["quote id", { ...approval, quote_id: "correlation-456" }],
      ["quote hash", { ...approval, quote_hash: "5".repeat(44) }],
      ["origin asset", { ...approval, origin_asset: "nep141:other.near" }],
      ["destination asset", { ...approval, destination_asset: "nep141:other.omft.near" }],
      ["amount", { ...approval, amount_in: "2" }],
      ["minimum output", { ...approval, min_amount_out: "1" }],
      ["recipient", { ...approval, recipient: "bob.near" }],
      ["refund", { ...approval, refund_to: "refund.near" }],
      ["deposit address", { ...approval, deposit_address: "different.near" }],
      ["memo value", { ...approval, deposit_memo: "route-456" }],
      ["memo presence", { ...approval, deposit_memo: undefined }],
      ["approval expiry", { ...approval, approval_expires_at: "2026-11-02T11:57:00.000Z" }],
      ["provider deadline", { ...approval, provider_deadline_at: "2026-11-02T12:01:00.000Z" }],
    ];

    for (const [name, mutation] of mutations) {
      expect(await computeNearApprovalDigest(NearApprovalBindingSchema.parse(mutation)), name).not.toBe(digest);
    }
    expect(NearApprovalBindingSchema.safeParse({
      ...approval,
      provider_signature_verified: false,
    }).success).toBe(false);
    expect(NearApprovalBindingSchema.safeParse({
      ...approval,
      idempotency_version: "pilot-near-idempotency-v2",
    }).success).toBe(false);
  });

  it("keeps an unknown outcome non-retryable until reconciliation", async () => {
    const attempt = NearExecutionAttemptSchema.parse({
      version: "pilot-near-execution-attempt-v1",
      attempt_id: "attempt-1",
      principal_id: approval.principal_id,
      account_id: approval.account_id,
      network: "near:mainnet",
      idempotency_version: approval.idempotency_version,
      idempotency_key: approval.idempotency_key,
      idempotency_request_digest: "D".repeat(64),
      reservation_id: "reservation-1",
      approval_digest: await computeNearApprovalDigest(approval),
      quote_id: approval.quote_id,
      state: "unknown",
      reconciliation: {
        version: "pilot-near-reconciliation-v1",
        outcome: "unknown",
        attempt_id: "attempt-1",
        principal_id: approval.principal_id,
        account_id: approval.account_id,
        network: "near:mainnet",
        checked_at: "2026-11-02T11:59:00.000Z",
        deposit_address: approval.deposit_address,
        deposit_memo: approval.deposit_memo,
        reason: "not_found",
        safe_to_resubmit: false,
      },
      created_at: "2026-11-02T11:58:00.000Z",
      updated_at: "2026-11-02T11:59:00.000Z",
      unknown_since: "2026-11-02T11:59:00.000Z",
    });
    expect(NearExecutionReplayDecisionSchema.parse({
      action: "blocked_unknown",
      attempt,
      safe_to_resubmit: false,
    }).action).toBe("blocked_unknown");
    expect(NearExecutionReplayDecisionSchema.safeParse({
      action: "return_existing",
      attempt,
      safe_to_resubmit: true,
    }).success).toBe(false);
    expect(NearExecutionReplayDecisionSchema.safeParse({
      action: "retry",
      attempt,
    }).success).toBe(false);
  });

  it("does not mistake a function-call gas allowance for an asset budget", () => {
    expect(NearWalletExecutionPolicySchema.safeParse({
      mode: "owner-approval",
      mainnet_execution_enabled: true,
      function_call_allowance: "1000000000000000000000000",
    }).success).toBe(false);
    expect(NearWalletExecutionPolicySchema.safeParse({
      mode: "disabled",
      mainnet_execution_enabled: true,
    }).success).toBe(false);
  });
});
