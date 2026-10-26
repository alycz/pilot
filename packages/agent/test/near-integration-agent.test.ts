import type {
  Near1ClickDryQuoteRequest,
  Near1ClickDryQuoteResponse,
  Near1ClickToken,
} from "@pilot/contracts";
import { describe, expect, it, vi } from "vitest";

import { discoverNearEarn } from "../src/near-tools";

const request: Near1ClickDryQuoteRequest = {
  dry: true,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: "near:test-input",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "near:test-output",
  amount: "100",
  refundTo: "refund.near",
  refundType: "ORIGIN_CHAIN",
  recipient: "recipient.near",
  recipientType: "DESTINATION_CHAIN",
  deadline: "2026-11-01T00:00:00.000Z",
  depositMode: "SIMPLE",
  confidentiality: "public",
  quoteWaitingTimeMs: 250,
  insured: false,
};

const response = (quoteRequest: Near1ClickDryQuoteRequest): Near1ClickDryQuoteResponse => ({
  correlationId: "quote-correlation",
  timestamp: "2026-10-26T12:00:00.000Z",
  signature: "provider-signature",
  quoteRequest,
  quote: {
    amountIn: "100",
    amountInFormatted: "1",
    amountInUsd: "1",
    minAmountIn: "100",
    amountOut: "95",
    amountOutFormatted: "0.95",
    amountOutUsd: "0.95",
    minAmountOut: "94",
    timeEstimate: 60,
  },
});

const token = (assetId: Near1ClickToken["assetId"]): Near1ClickToken => ({
  assetId,
  decimals: 24,
  blockchain: "near",
  symbol: "TOKEN",
  price: 1,
  priceUpdatedAt: "2026-10-26T12:00:00.000Z",
});

function dependencies(quoteRequest: Near1ClickDryQuoteRequest) {
  return {
    listTokens: vi.fn(async () => [
      token(request.originAsset),
      token(request.destinationAsset),
    ]),
    requestDryQuote: vi.fn(async () => ({
      response: response(quoteRequest),
      providerSignatureVerified: true as const,
    })),
  };
}

describe("NEAR read-only agent integration boundaries", () => {
  it("binds the complete dry request rather than only amount and addresses", async () => {
    const mutations: Array<[string, Near1ClickDryQuoteRequest]> = [
      ["slippage", { ...request, slippageTolerance: 101 }],
      ["deposit type", { ...request, depositType: "INTENTS" } as unknown as Near1ClickDryQuoteRequest],
      ["refund type", { ...request, refundType: "INTENTS" } as unknown as Near1ClickDryQuoteRequest],
      ["recipient type", { ...request, recipientType: "INTENTS" } as unknown as Near1ClickDryQuoteRequest],
      ["deposit mode", { ...request, depositMode: "MEMO" }],
      ["waiting time", { ...request, quoteWaitingTimeMs: 500 }],
    ];

    for (const [name, mutated] of mutations) {
      await expect(
        discoverNearEarn({ quoteRequest: request }, dependencies(mutated)),
        name,
      ).rejects.toThrow("does not match");
    }
  });

  it("never exposes a submit or signing dependency in the read-only tool", async () => {
    const deps = dependencies(request);
    const result = await discoverNearEarn({ quoteRequest: request }, deps);
    expect(result.executable).toBe(false);
    expect(result.mode).toBe("read-only-dry-quote");
    expect(Object.keys(deps).sort()).toEqual(["listTokens", "requestDryQuote"]);
    expect(JSON.stringify(result)).not.toContain("depositAddress");
  });
});
