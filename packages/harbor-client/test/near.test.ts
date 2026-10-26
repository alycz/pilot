import { describe, expect, it } from "vitest";

import { createMockHarborClient } from "../src/mock";
import { createHarborRestClient } from "../src/rest";
import { HarborArgsSchemas, HarborResultSchemas } from "../src/types";

const quoteArgs = {
  dry: true as const,
  origin_asset_id: "nep141:fixture-origin.near",
  destination_asset_id: "nep141:fixture-destination.near",
  amount: "1000000",
  slippage_bps: 100,
  deposit_type: "ORIGIN_CHAIN" as const,
  recipient: "recipient.near",
  recipient_type: "DESTINATION_CHAIN" as const,
  refund_to: "refund.near",
  refund_type: "ORIGIN_CHAIN" as const,
  refund_deadline: "2027-01-01T00:00:00.000Z",
};

const dryQuote = {
  correlationId: "fixture-correlation",
  timestamp: "2026-10-26T12:00:00.000Z",
  signature: "fixture-provider-signature",
  quoteRequest: {
    dry: true as const,
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: quoteArgs.slippage_bps,
    originAsset: quoteArgs.origin_asset_id,
    depositType: "ORIGIN_CHAIN" as const,
    destinationAsset: quoteArgs.destination_asset_id,
    amount: quoteArgs.amount,
    refundTo: quoteArgs.refund_to,
    refundType: "ORIGIN_CHAIN" as const,
    recipient: quoteArgs.recipient,
    recipientType: "DESTINATION_CHAIN" as const,
    deadline: quoteArgs.refund_deadline,
    depositMode: "SIMPLE" as const,
    confidentiality: "public" as const,
    quoteWaitingTimeMs: 0,
    insured: false as const,
  },
  quote: {
    amountIn: quoteArgs.amount,
    amountInFormatted: "1",
    amountInUsd: "1",
    minAmountIn: quoteArgs.amount,
    amountOut: "995000",
    amountOutFormatted: "0.995",
    amountOutUsd: "0.995",
    minAmountOut: "990000",
    timeEstimate: 30,
  },
};

const executableQuote = {
  ...dryQuote,
  quoteRequest: { ...dryQuote.quoteRequest, dry: false as const },
  quote: {
    ...dryQuote.quote,
    depositAddress: "fixture-deposit-address",
    depositMemo: "fixture-deposit-memo",
    deadline: "2027-01-01T00:00:00.000Z",
    timeWhenInactive: "2027-01-01T00:00:00.000Z",
  },
};

describe("NEAR Intents Harbor client contracts", () => {
  it("keeps the public quote operation dry-only and requires exact provider asset IDs", () => {
    expect(HarborArgsSchemas["near.intents.quote"].parse(quoteArgs).dry).toBe(true);
    expect(HarborArgsSchemas["near.intents.quote"].safeParse({
      ...quoteArgs,
      dry: false,
    }).success).toBe(false);
    expect(HarborArgsSchemas["near.intents.quote"].safeParse({
      ...quoteArgs,
      origin_asset_id: "NEAR",
    }).success).toBe(false);
    expect(HarborArgsSchemas["near.intents.quote"].safeParse({
      ...quoteArgs,
      amount: "1.5",
    }).success).toBe(false);
    expect(HarborArgsSchemas["near.intents.quote"].safeParse({
      ...quoteArgs,
      destination_asset_id: quoteArgs.origin_asset_id,
    }).success).toBe(false);
    expect(HarborArgsSchemas["near.intents.tokens"].safeParse({
      blockchain: "unsupported-fixture-chain",
    }).success).toBe(false);
  });

  it("validates truthful live-read metadata and returned token count", () => {
    const result = {
      provider: "near-intents-1click" as const,
      source: "live" as const,
      live: true as const,
      execution_enabled: false as const,
      count: 1,
      tokens: [{
        assetId: "nep141:fixture-origin.near",
        decimals: 24,
        blockchain: "near" as const,
        symbol: "FIXTURE",
        price: 1,
        priceUpdatedAt: "2026-10-26T12:00:00.000Z",
      }],
    };
    expect(HarborResultSchemas["near.intents.tokens"].parse(result)).toEqual(result);
    expect(HarborResultSchemas["near.intents.tokens"].safeParse({
      ...result,
      count: 2,
    }).success).toBe(false);
    expect(HarborResultSchemas["near.intents.tokens"].safeParse({
      ...result,
      execution_enabled: true,
    }).success).toBe(false);
  });

  it("accepts a verified dry quote envelope through the live REST validator", async () => {
    const data = {
      provider: "near-intents-1click" as const,
      source: "live" as const,
      mode: "dry" as const,
      signature_verified: true as const,
      execution_enabled: false as const,
      quote_hash: "3".repeat(44),
      quote: dryQuote,
    };
    const client = createHarborRestClient({
      apiKey: "fixture-key",
      baseUrl: "https://harbor.example",
      mock: false,
      fetch: async () => Response.json({
        ok: true,
        data,
        asOf: "2026-10-26T12:00:00.000Z",
        asOfBasis: "near-intents-1click",
      }),
    });

    const envelope = await client.op("near.intents.quote", quoteArgs);
    expect(envelope.ok && envelope.data).toEqual(data);
    expect(HarborResultSchemas["near.intents.quote"].safeParse({
      ...data,
      signature_verified: false,
    }).success).toBe(false);
    expect(HarborResultSchemas["near.intents.quote"].safeParse({
      ...data,
      quote: { ...dryQuote, quote: executableQuote.quote },
    }).success).toBe(false);
  });

  it("accepts only official status values and nested swap hashes", () => {
    const result = {
      provider: "near-intents-1click" as const,
      source: "live" as const,
      signature_verified: true as const,
      execution_enabled: false as const,
      status: {
        correlationId: executableQuote.correlationId,
        quoteResponse: executableQuote,
        status: "PROCESSING" as const,
        updatedAt: "2026-10-26T12:01:00.000Z",
        swapDetails: {
          intentHashes: ["fixture-intent-hash"],
          nearTxHashes: ["fixture-near-hash"],
          originChainTxHashes: [],
          destinationChainTxHashes: [],
        },
      },
    };
    expect(HarborResultSchemas["near.intents.status"].parse(result)).toEqual(result);
    expect(HarborResultSchemas["near.intents.status"].safeParse({
      ...result,
      status: { ...result.status, status: "UNKNOWN" },
    }).success).toBe(false);
    expect(HarborResultSchemas["near.intents.status"].safeParse({
      ...result,
      status: { ...result.status, nearTxHashes: ["forged-top-level-hash"] },
    }).success).toBe(false);
  });

  it("keeps all offline NEAR fixtures explicitly non-live and non-executable", async () => {
    const client = createMockHarborClient();
    const tokens = await client.op("near.intents.tokens", {});
    const quote = await client.op("near.intents.quote", quoteArgs);
    const status = await client.op("near.intents.status", {
      deposit_address: "fixture-deposit-address",
      deposit_memo: "fixture-deposit-memo",
    });

    expect(tokens.ok && tokens.data).toMatchObject({
      source: "fixture",
      live: false,
      execution_enabled: false,
    });
    expect(quote.ok && quote.data).toMatchObject({
      source: "fixture",
      signature_verified: false,
      execution_enabled: false,
      local_fixture_id: "near-fixture-dry-quote-001",
    });
    expect(quote.ok && "quote_hash" in quote.data).toBe(false);
    expect(status.ok && status.data).toMatchObject({
      source: "fixture",
      signature_verified: false,
      execution_enabled: false,
      status: { status: "PENDING_DEPOSIT", swapDetails: {
        intentHashes: [],
        nearTxHashes: [],
        originChainTxHashes: [],
        destinationChainTxHashes: [],
      } },
    });
  });

  it("rejects fixture metadata that claims provider verification", () => {
    expect(HarborResultSchemas["near.intents.quote"].safeParse({
      provider: "near-intents-1click",
      source: "fixture",
      mode: "dry",
      signature_verified: true,
      execution_enabled: false,
      quote_hash: "3".repeat(44),
      quote: dryQuote,
    }).success).toBe(false);
    expect(HarborResultSchemas["near.intents.tokens"].safeParse({
      provider: "near-intents-1click",
      source: "fixture",
      live: true,
      execution_enabled: false,
      count: 0,
      tokens: [],
    }).success).toBe(false);
  });
});
