import type {
  Near1ClickDryQuoteRequest,
  Near1ClickDryQuoteResponse,
  Near1ClickToken,
} from "@pilot/contracts/near";
import { describe, expect, it, vi } from "vitest";

import { discoverNearEarn, readNearAccount } from "../src/near-tools";

const request: Near1ClickDryQuoteRequest = {
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: "near:asset-in",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "near:asset-out",
  amount: "100",
  refundTo: "refund.near",
  refundType: "ORIGIN_CHAIN",
  recipient: "recipient.near",
  recipientType: "DESTINATION_CHAIN",
  deadline: "2026-11-01T00:00:00.000Z",
  depositMode: "SIMPLE",
  confidentiality: "public",
  quoteWaitingTimeMs: 0,
  insured: false,
  dry: true,
};

const response: Near1ClickDryQuoteResponse = {
  correlationId: "quote-correlation",
  timestamp: "2026-10-26T12:00:00.000Z",
  signature: "provider-signature",
  quoteRequest: request,
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
};

const token = (assetId: Near1ClickToken["assetId"]): Near1ClickToken => ({
  assetId,
  decimals: 24,
  blockchain: "near",
  symbol: "TOKEN",
  price: 1,
  priceUpdatedAt: "2026-10-26T12:00:00.000Z",
});

describe("NEAR read-only agent tools", () => {
  it("returns only a verified dry Earn quote for exact current asset ids", async () => {
    const verifiedQuote = { response, providerSignatureVerified: true } as const;
    const result = await discoverNearEarn({ quoteRequest: request }, {
      listTokens: vi.fn(async () => [token(request.originAsset), token(request.destinationAsset)]),
      requestDryQuote: vi.fn(async () => verifiedQuote),
    });
    expect(result).toMatchObject({ mode: "read-only-dry-quote", executable: false, quote: verifiedQuote });
    expect(result.caveats.join(" ")).toContain("not a completed swap");
  });

  it("rejects unsupported ids and mismatched quote scope", async () => {
    const base = {
      listTokens: vi.fn(async () => [token(request.destinationAsset)]),
      requestDryQuote: vi.fn(async () => ({ response, providerSignatureVerified: true as const })),
    };
    await expect(discoverNearEarn({ quoteRequest: request }, base)).rejects.toThrow("exact ids");
    await expect(discoverNearEarn({ quoteRequest: request }, {
      ...base,
      listTokens: vi.fn(async () => [token(request.originAsset), token(request.destinationAsset)]),
      requestDryQuote: vi.fn(async () => ({
        response: { ...response, quoteRequest: { ...request, recipient: "other.near" } },
        providerSignatureVerified: true as const,
      })),
    })).rejects.toThrow("does not match");
  });

  it.each([
    { slippageTolerance: 101 },
    { depositMode: "MEMO" as const },
    { quoteWaitingTimeMs: 1 },
    { refundTo: "different-refund.near" },
  ])("rejects any signed quote-request field drift: %#", async (mutation) => {
    await expect(discoverNearEarn({ quoteRequest: request }, {
      listTokens: vi.fn(async () => [token(request.originAsset), token(request.destinationAsset)]),
      requestDryQuote: vi.fn(async () => ({
        response: { ...response, quoteRequest: { ...request, ...mutation } },
        providerSignatureVerified: true as const,
      })),
    })).rejects.toThrow("does not match");
  });

  it("carries address and memo together when observing existing settlement", async () => {
    const readStatus = vi.fn(async () => ({
      status: "PROCESSING" as const,
      correlationId: "quote-correlation",
      updatedAt: "2026-10-26T12:01:00.000Z",
    }));
    await discoverNearEarn({
      quoteRequest: request,
      observe: { depositAddress: "deposit-address", depositMemo: "route-memo" },
    }, {
      listTokens: vi.fn(async () => [token(request.originAsset), token(request.destinationAsset)]),
      requestDryQuote: vi.fn(async () => ({ response, providerSignatureVerified: true as const })),
      readStatus,
    });
    expect(readStatus).toHaveBeenCalledWith({
      depositAddress: "deposit-address",
      depositMemo: "route-memo",
    }, undefined);
  });

  it("keeps account access read-only and optional", async () => {
    const viewAccount = vi.fn(async () => ({ amount: "7" }));
    await expect(readNearAccount("pilot.near", {
      listTokens: vi.fn(),
      requestDryQuote: vi.fn(),
      viewAccount,
    })).resolves.toEqual({ amount: "7" });
    expect(viewAccount).toHaveBeenCalledWith("pilot.near", undefined);
  });
});

