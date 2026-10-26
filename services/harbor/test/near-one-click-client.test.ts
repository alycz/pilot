import { describe, expect, it, vi } from "vitest";

import {
  createOneClickClient,
  OneClickClientError,
  type OneClickQuoteRequest,
} from "../src/near/one-click";

const request: OneClickQuoteRequest = {
  dry: true,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: "nep141:origin.token.near",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:destination.token.near",
  amount: "1000000",
  refundTo: "refund.near",
  refundType: "ORIGIN_CHAIN",
  recipient: "recipient.near",
  recipientType: "DESTINATION_CHAIN",
  deadline: "2027-01-01T00:00:00.000Z",
  confidentiality: "public",
};

function quoteResponse(extraQuote: Record<string, unknown> = {}) {
  return {
    correlationId: "quote-correlation",
    timestamp: "2026-10-26T00:00:00.000Z",
    signature: "provider-signature",
    quoteRequest: request,
    quote: {
      amountIn: "1000000",
      amountInFormatted: "1",
      amountInUsd: "1",
      minAmountIn: "1000000",
      amountOut: "995000",
      amountOutFormatted: "0.995",
      amountOutUsd: "0.995",
      minAmountOut: "990000",
      timeEstimate: 120,
      ...extraQuote,
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

describe("NEAR Intents 1Click client", () => {
  it("uses the pinned endpoint, rejects redirects, and verifies dry quotes before returning them", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://1click.chaindefuser.com/v0/quote");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual(request);
      return jsonResponse(quoteResponse());
    });
    const verifier = vi.fn(() => true);
    const client = createOneClickClient({ fetch: fetcher, verifyQuoteSignature: verifier });

    const result = await client.quote(request);

    expect(verifier).toHaveBeenCalledOnce();
    expect(result.response.quote.depositAddress).toBeUndefined();
    expect(result.quoteHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("fails closed on an invalid provider signature", async () => {
    const client = createOneClickClient({
      fetch: async () => jsonResponse(quoteResponse()),
      verifyQuoteSignature: () => false,
    });

    await expect(client.quote(request)).rejects.toMatchObject({
      code: "INVALID_SIGNATURE",
    });
  });

  it("rejects executable fields in a dry quote even when the signature verifier succeeds", async () => {
    const client = createOneClickClient({
      fetch: async () => jsonResponse(quoteResponse({ depositAddress: "deposit.near" })),
      verifyQuoteSignature: () => true,
    });

    await expect(client.quote(request)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects executable quote requests before calling the provider", async () => {
    const fetcher = vi.fn();
    const client = createOneClickClient({ fetch: fetcher });

    await expect(client.quote({ ...request, dry: false })).rejects.toBeInstanceOf(
      OneClickClientError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends and binds both deposit address and memo for status", async () => {
    const executableQuote = quoteResponse({
      depositAddress: "deposit.near",
      depositMemo: "12345",
      deadline: "2027-01-01T00:00:00.000Z",
      timeWhenInactive: "2026-12-31T23:00:00.000Z",
    });
    executableQuote.quoteRequest = { ...request, dry: false };
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        "https://1click.chaindefuser.com/v0/status?depositAddress=deposit.near&depositMemo=12345",
      );
      return jsonResponse({
        correlationId: "quote-correlation",
        quoteResponse: executableQuote,
        status: "PROCESSING",
        updatedAt: "2026-10-26T00:01:00.000Z",
        swapDetails: {
          intentHashes: [],
          nearTxHashes: [],
          originChainTxHashes: [],
          destinationChainTxHashes: [],
        },
      });
    });
    const client = createOneClickClient({ fetch: fetcher, verifyQuoteSignature: () => true });

    const result = await client.status({
      depositAddress: "deposit.near",
      depositMemo: "12345",
    });

    expect(result.status).toBe("PROCESSING");
    expect(result.quoteResponse.quote.depositMemo).toBe("12345");
  });

  it("bounds token responses before parsing them", async () => {
    const client = createOneClickClient({
      maxResponseBytes: 16,
      fetch: async () => new Response("[]", {
        headers: { "content-type": "application/json", "content-length": "17" },
      }),
    });

    await expect(client.tokens()).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("normalizes live token prices while preserving official chain codes and asset IDs", async () => {
    const client = createOneClickClient({
      fetch: async () => jsonResponse([{
        assetId: "xrpledger:XRP",
        decimals: 6,
        blockchain: "xrp",
        symbol: "XRP",
        price: "2.50",
        priceUpdatedAt: "2026-10-26T00:00:00.000Z",
      }]),
    });

    await expect(client.tokens()).resolves.toEqual([expect.objectContaining({
      assetId: "xrpledger:XRP",
      blockchain: "xrp",
      price: 2.5,
    })]);
  });

  it("accepts the qtc and abs chain codes returned by the live token inventory", async () => {
    const tokens = [
      { assetId: "nep141:qtc.omft.near", decimals: 18, blockchain: "qtc", symbol: "QTC" },
      { assetId: "nep141:abs.omdep.near", decimals: 18, blockchain: "abs", symbol: "ETH" },
    ].map((token) => ({
      ...token,
      price: 1,
      priceUpdatedAt: "2026-10-26T00:00:00.000Z",
    }));
    const client = createOneClickClient({ fetch: async () => jsonResponse(tokens) });
    await expect(client.tokens()).resolves.toEqual(tokens);
  });

  it("keeps missing provider resources in an explicit unknown-outcome state", async () => {
    const client = createOneClickClient({
      fetch: async () => jsonResponse({}, { status: 404 }),
    });

    await expect(client.tokens()).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME",
    });
  });

  it("maps a provider deadline abort to a distinct timeout error", async () => {
    const client = createOneClickClient({
      fetch: async () => {
        throw new DOMException("request timed out", "TimeoutError");
      },
    });

    await expect(client.tokens()).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("rejects insecure or credential-bearing explorer links in status responses", async () => {
    const executableQuote = quoteResponse({
      depositAddress: "deposit.near",
      deadline: "2027-01-01T00:00:00.000Z",
      timeWhenInactive: "2026-12-31T23:00:00.000Z",
    });
    executableQuote.quoteRequest = { ...request, dry: false };
    const client = createOneClickClient({
      fetch: async () => jsonResponse({
        correlationId: "quote-correlation",
        quoteResponse: executableQuote,
        status: "PROCESSING",
        updatedAt: "2026-10-26T00:01:00.000Z",
        swapDetails: {
          intentHashes: [],
          nearTxHashes: [],
          originChainTxHashes: [{ hash: "origin-tx", explorerUrl: "http://user:pass@example.test/tx" }],
          destinationChainTxHashes: [],
        },
      }),
      verifyQuoteSignature: () => true,
    });

    await expect(client.status({ depositAddress: "deposit.near" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
