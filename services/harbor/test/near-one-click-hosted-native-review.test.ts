import { describe, expect, it, vi } from "vitest";

import { createOneClickClient } from "../src/near/one-click";
import {
  ONE_CLICK_HOSTED_NATIVE_NEAR_FIXTURE_ID,
  ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE,
  ops,
} from "../src/ops/near-intents";

const WNEAR_ASSET = "nep141:wrap.near";
const ARB_USDC_ASSET = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const ARB_USDC_CONTRACT = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const DEPOSIT_ACCOUNT = "native-near-deposit.near";

const args = {
  route: "near-native-to-arbitrum-usdc-v1" as const,
  amount_atomic: "100000000000000000000000",
  slippage_bps: 100,
  recipient: "0x1111111111111111111111111111111111111111",
  refund_to: "owner.near",
  refund_deadline: "2027-01-01T00:00:00.000Z",
};

const hostedEnv = {
  HARBOR_NEAR_INTENTS_OWNER_FUNDED_REVIEW_ENABLED: "true",
  HARBOR_NEAR_INTENTS_PROVIDER_POST_ENABLED: "true",
  HARBOR_NEAR_INTENTS_STATUS_ENABLED: "true",
  HARBOR_NEAR_INTENTS_EXECUTABLE_REVIEW_PROFILE: ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE,
  MAINNET_EXECUTION: "false",
  HARBOR_API_KEYS: "hosted-reviewer:secret",
};

const catalog = [
  {
    assetId: WNEAR_ASSET,
    decimals: 24,
    blockchain: "near",
    symbol: "wNEAR",
    price: 3,
    priceUpdatedAt: "2026-10-26T00:00:00.000Z",
    contractAddress: "wrap.near",
  },
  {
    assetId: ARB_USDC_ASSET,
    decimals: 6,
    blockchain: "arb",
    symbol: "USDC",
    price: 1,
    priceUpdatedAt: "2026-10-26T00:00:00.000Z",
    contractAddress: ARB_USDC_CONTRACT,
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
    correlationId: "native-near-arb-usdc-review",
    timestamp: "2026-10-26T12:00:00.000Z",
    signature: "fixture-signature",
    quoteRequest: request,
    quote: {
      amountIn: args.amount_atomic,
      amountInFormatted: "0.1",
      amountInUsd: "0.3",
      minAmountIn: args.amount_atomic,
      amountOut: "300000",
      amountOutFormatted: "0.3",
      amountOutUsd: "0.3",
      minAmountOut: "297000",
      timeEstimate: 120,
      depositAddress: DEPOSIT_ACCOUNT,
      deadline: args.refund_deadline,
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

function statusOp() {
  const op = ops.find((candidate) => candidate.name === "near.intents.status");
  if (!op) throw new Error("missing status operation");
  return op;
}

function context(client: ReturnType<typeof createOneClickClient>, env = hostedEnv) {
  return {
    principal: "hosted-reviewer",
    localDevRequest: false,
    env,
    nearOneClickClient: client,
  };
}

describe("hosted-capable native NEAR to Arbitrum USDC review profile", () => {
  it("works without HARBOR_LOCAL_DEV and returns native-NEAR manual funding instructions", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v0/tokens")) return json(catalog);
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({
        dry: false,
        swapType: "EXACT_INPUT",
        originAsset: WNEAR_ASSET,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: ARB_USDC_ASSET,
        amount: args.amount_atomic,
        refundTo: args.refund_to,
        refundType: "ORIGIN_CHAIN",
        recipient: args.recipient,
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
      local_fixture_id: ONE_CLICK_HOSTED_NATIVE_NEAR_FIXTURE_ID,
      execution_enabled: false,
      manual_funding_required: true,
      route: {
        version: "pilot-near-native-to-arbitrum-usdc-route-v1",
        profile_status: "hosted-default-off",
        execution_default: "off",
        activation_gate: "independent-source-and-destination-receipt-verification-required",
        origin_network: "near:mainnet",
        source_transfer_asset: "native-near",
        origin_asset_id: WNEAR_ASSET,
        managed_wrapping_by_1click: true,
        destination_asset_id: ARB_USDC_ASSET,
        destination_chain_id: 42161,
        deposit_mode: "SIMPLE",
      },
      fixture_quote: {
        amount_in: args.amount_atomic,
        min_amount_out: "297000",
        deposit_address: DEPOSIT_ACCOUNT,
        deposit_memo_present: false,
      },
      owner_review: {
        action: "manually-transfer-native-near",
        funding_asset: "native-near",
        amount_unit: "yoctoNEAR",
        deposit_address: DEPOSIT_ACCOUNT,
        managed_wrapping_by_1click: true,
        owner_should_send_native_near: true,
        owner_should_not_pre_wrap: true,
        transaction_built: false,
        transaction_signed: false,
        transaction_broadcast: false,
        funding_state: "not-funded",
        status_lookup: {
          operation: "near.intents.status",
          profile: ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE,
          deposit_address: DEPOSIT_ACCOUNT,
          local_fixture_id: ONE_CLICK_HOSTED_NATIVE_NEAR_FIXTURE_ID,
        },
      },
    });
    expect(result).not.toHaveProperty("quote_hash");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("is default-off but does not require local-development markers", async () => {
    const fetcher = vi.fn();
    const client = createOneClickClient({ fetch: fetcher });

    await expect(reviewOp().handler(context(client, {
      ...hostedEnv,
      HARBOR_NEAR_INTENTS_OWNER_FUNDED_REVIEW_ENABLED: "false",
    }), args)).rejects.toMatchObject({ code: "EXECUTABLE_REVIEW_DISABLED" });
    await expect(reviewOp().handler({
      ...context(client),
      principal: "local-dev",
    }, args)).rejects.toMatchObject({ code: "EXECUTABLE_REVIEW_AUTH_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires exact current token metadata before quote creation", async () => {
    const fetcher = vi.fn(async () => json([
      { ...catalog[0], contractAddress: "not-wrap.near" },
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
    ["memo", { depositMemo: "memo-not-supported" }],
    ["foreign deposit route", {
      chainDepositAddresses: [{ blockchain: "arb", address: DEPOSIT_ACCOUNT }],
    }],
  ])("rejects unsupported %s metadata", async (_label, quoteOverrides) => {
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

  it("requires quote identity and forbids memo for hosted status", () => {
    const schema = statusOp().args;
    expect(schema.safeParse({
      profile: ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE,
      deposit_address: DEPOSIT_ACCOUNT,
    }).success).toBe(false);
    expect(schema.safeParse({
      profile: ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE,
      deposit_address: DEPOSIT_ACCOUNT,
      deposit_memo: "memo",
      expected_quote_hash: "1".repeat(44),
      expected_correlation_id: "native-near-arb-usdc-review",
    }).success).toBe(false);
    expect(schema.safeParse({
      profile: ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE,
      deposit_address: DEPOSIT_ACCOUNT,
      expected_quote_hash: "1".repeat(44),
      expected_correlation_id: "native-near-arb-usdc-review",
    }).success).toBe(true);
  });
});
