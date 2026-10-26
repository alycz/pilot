import { describe, expect, it, vi } from "vitest";

import { createOneClickClient } from "../src/near/one-click";
import {
  ONE_CLICK_EXECUTABLE_REVIEW_FIXTURE_ID,
  ONE_CLICK_EXECUTABLE_REVIEW_PROFILE,
  OneClickExecutableReviewError,
  ops,
} from "../src/ops/near-intents";

const ORIGIN_ASSET = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const DESTINATION_ASSET = "nep141:wrap.near";
const DEPOSIT_ADDRESS = "0x2222222222222222222222222222222222222222";

const args = {
  route: "arbitrum-usdc-to-near-wnear-v1" as const,
  amount_atomic: "1000000",
  slippage_bps: 100,
  recipient: "owner.near",
  refund_to: "0x1111111111111111111111111111111111111111",
  refund_deadline: "2027-01-01T00:00:00.000Z",
};

const runtimeEnv = {
  HARBOR_LOCAL_DEV: "true",
  HARBOR_LOCAL_NEAR_INTENTS_EXECUTABLE_REVIEW_ENABLED: "true",
  HARBOR_LOCAL_NEAR_INTENTS_PROVIDER_POST_ENABLED: "true",
  HARBOR_LOCAL_NEAR_INTENTS_EXECUTABLE_REVIEW_PROFILE: ONE_CLICK_EXECUTABLE_REVIEW_PROFILE,
  MAINNET_EXECUTION: "false",
  HARBOR_API_KEYS: "reviewer:secret",
};

const catalog = [
  {
    assetId: ORIGIN_ASSET,
    decimals: 6,
    blockchain: "arb",
    symbol: "USDC",
    price: 1,
    priceUpdatedAt: "2026-10-26T00:00:00.000Z",
    contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  },
  {
    assetId: DESTINATION_ASSET,
    decimals: 24,
    blockchain: "near",
    symbol: "wNEAR",
    price: 3,
    priceUpdatedAt: "2026-10-26T00:00:00.000Z",
    contractAddress: "wrap.near",
  },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function executableResponse(
  request: Record<string, unknown>,
  quoteOverrides: Record<string, unknown> = {},
) {
  return {
    correlationId: "arb-usdc-wnear-review",
    timestamp: "2026-10-26T12:00:00.000Z",
    signature: "fixture-signature",
    quoteRequest: request,
    quote: {
      amountIn: args.amount_atomic,
      amountInFormatted: "1",
      amountInUsd: "1",
      minAmountIn: args.amount_atomic,
      amountOut: "300000000000000000000000",
      amountOutFormatted: "0.3",
      amountOutUsd: "0.9",
      minAmountOut: "297000000000000000000000",
      timeEstimate: 120,
      depositAddress: DEPOSIT_ADDRESS,
      deadline: "2027-01-01T00:00:00.000Z",
      timeWhenInactive: "2026-12-31T23:00:00.000Z",
      ...quoteOverrides,
    },
  };
}

function reviewOp() {
  const op = ops.find((candidate) => candidate.name === "near.intents.executable-quote.review");
  if (!op) throw new Error("missing executable review operation");
  return op;
}

function context(client: ReturnType<typeof createOneClickClient>, env = runtimeEnv) {
  return {
    principal: "reviewer",
    localDevRequest: true,
    env,
    nearOneClickClient: client,
  };
}

describe("local-only NEAR 1Click executable quote review", () => {
  it("catalog-attests the fixed route and returns manual-funding instructions only", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v0/tokens")) return json(catalog);
      expect(String(input)).toBe("https://1click.chaindefuser.com/v0/quote");
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({
        dry: false,
        swapType: "EXACT_INPUT",
        originAsset: ORIGIN_ASSET,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: DESTINATION_ASSET,
        amount: args.amount_atomic,
        refundType: "ORIGIN_CHAIN",
        recipientType: "DESTINATION_CHAIN",
        depositMode: "SIMPLE",
        confidentiality: "public",
        insured: false,
      });
      expect(request).not.toHaveProperty("appFees");
      return json(executableResponse(request));
    });
    const client = createOneClickClient({
      allowExecutableQuotes: true,
      fetch: fetcher,
      verifyQuoteSignature: () => true,
    });

    const result = await reviewOp().handler(context(client), args) as Record<string, any>;

    expect(result).toMatchObject({
      provider: "near-intents-1click",
      source: "fixture",
      mode: "executable-review",
      provider_signature_verified: false,
      local_fixture_id: ONE_CLICK_EXECUTABLE_REVIEW_FIXTURE_ID,
      execution_enabled: false,
      manual_funding_required: true,
      route: {
        version: "pilot-near-arbitrum-usdc-to-wnear-route-v1",
        origin_asset_id: ORIGIN_ASSET,
        origin_chain_id: 42161,
        origin_decimals: 6,
        destination_asset_id: DESTINATION_ASSET,
        destination_decimals: 24,
        manual_owner_funding_only: true,
      },
      fixture_quote: {
        amount_in: args.amount_atomic,
        amount_out: "300000000000000000000000",
        min_amount_out: "297000000000000000000000",
        deposit_address: DEPOSIT_ADDRESS,
        deposit_memo_present: false,
      },
      owner_review: {
        action: "manually-transfer-origin-asset",
        chain_id: 42161,
        token_contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        amount_atomic: args.amount_atomic,
        deposit_address: DEPOSIT_ADDRESS,
        deposit_memo: null,
        app_fee_bps: 0,
        transaction_built: false,
        transaction_signed: false,
        transaction_broadcast: false,
        funding_state: "not-funded",
        estimated_amount_out: "300000000000000000000000",
        minimum_amount_out: "297000000000000000000000",
        status_lookup: {
          operation: "near.intents.status",
          deposit_address: DEPOSIT_ADDRESS,
          expected_correlation_id: "arb-usdc-wnear-review",
          local_fixture_id: ONE_CLICK_EXECUTABLE_REVIEW_FIXTURE_ID,
        },
      },
    });
    expect(result).not.toHaveProperty("quote_hash");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("is disabled unless every local runtime marker and explicit principal is present", async () => {
    const fetcher = vi.fn();
    const client = createOneClickClient({ fetch: fetcher });
    const cases = [
      { ...context(client), localDevRequest: false },
      context(client, { ...runtimeEnv, HARBOR_LOCAL_NEAR_INTENTS_EXECUTABLE_REVIEW_ENABLED: "false" }),
      { ...context(client), principal: "local-dev" },
    ];

    for (const candidate of cases) {
      await expect(reviewOp().handler(candidate, args)).rejects.toBeInstanceOf(
        OneClickExecutableReviewError,
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails before quote creation when current token metadata does not exactly attest the route", async () => {
    const fetcher = vi.fn(async () => json([
      { ...catalog[0], decimals: 18 },
      catalog[1],
    ]));
    const client = createOneClickClient({
      allowExecutableQuotes: true,
      fetch: fetcher,
      verifyQuoteSignature: () => true,
    });

    await expect(reviewOp().handler(context(client), args)).rejects.toMatchObject({
      code: "ROUTE_CATALOG_MISMATCH",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ["memo", { depositMemo: "123" }],
    ["foreign chain deposit", {
      chainDepositAddresses: [{ blockchain: "base", address: DEPOSIT_ADDRESS }],
    }],
  ])("rejects unsupported %s provider funding metadata", async (_label, quoteOverrides) => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v0/tokens")) return json(catalog);
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json(executableResponse(request, quoteOverrides));
    });
    const client = createOneClickClient({
      allowExecutableQuotes: true,
      fetch: fetcher,
      verifyQuoteSignature: () => true,
    });

    await expect(reviewOp().handler(context(client), args)).rejects.toMatchObject({
      code: "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
    });
  });

  it("does not register the optional deposit transaction notification mutation", () => {
    expect(ops.some((candidate) => candidate.name === "near.intents.deposit-tx.submit")).toBe(false);
  });
});
