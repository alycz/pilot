import { describe, expect, it, vi } from "vitest";

import {
  createOneClickClient,
  type OneClickQuoteRequest,
} from "../src/near/one-click";

const dryRequest: OneClickQuoteRequest = {
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
  depositMode: "SIMPLE",
  confidentiality: "public",
  quoteWaitingTimeMs: 250,
  insured: false,
};

const amounts = {
  amountIn: dryRequest.amount,
  amountInFormatted: "1",
  amountInUsd: "1",
  minAmountIn: dryRequest.amount,
  amountOut: "995000",
  amountOutFormatted: "0.995",
  amountOutUsd: "0.995",
  minAmountOut: "990000",
  timeEstimate: 120,
};

function responseFor(
  request: OneClickQuoteRequest = dryRequest,
  quote: Record<string, unknown> = amounts,
) {
  return {
    correlationId: "quote-correlation",
    timestamp: "2026-10-26T00:00:00.000Z",
    signature: "provider-signature",
    quoteRequest: request,
    quote,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("NEAR 1Click cross-layer fail-closed boundaries", () => {
  it("rejects the obsolete flat quote shape", async () => {
    const client = createOneClickClient({
      fetch: async () => json({
        correlationId: "quote-correlation",
        timestamp: "2026-10-26T00:00:00.000Z",
        signature: "provider-signature",
        quoteRequest: dryRequest,
        ...amounts,
        depositAddress: "must-not-be-top-level.near",
      }),
      verifyQuoteSignature: () => true,
    });

    await expect(client.quote(dryRequest)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("requires all executable provider bounds after a fresh non-dry request", async () => {
    const request = { ...dryRequest, dry: false as const };
    for (const missing of ["deadline", "timeWhenInactive"] as const) {
      const quote: Record<string, unknown> = {
        ...amounts,
        depositAddress: "deposit.near",
        deadline: "2027-01-01T00:00:00.000Z",
        timeWhenInactive: "2026-12-31T23:55:00.000Z",
      };
      delete quote[missing];
      const client = createOneClickClient({
        allowExecutableQuotes: true,
        fetch: async () => json(responseFor(request, quote)),
        verifyQuoteSignature: () => true,
      });

      await expect(client.quote(request), missing).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    }
  });

  it("binds every supplied request option to the provider echo", async () => {
    for (const [field, value] of [
      ["depositMode", "MEMO"],
      ["quoteWaitingTimeMs", 500],
    ] as const) {
      const echoed = { ...dryRequest, [field]: value };
      const client = createOneClickClient({
        fetch: async () => json(responseFor(echoed)),
        verifyQuoteSignature: () => true,
      });

      await expect(client.quote(dryRequest), field).rejects.toMatchObject({
        code: "REQUEST_MISMATCH",
      });
    }

    const missingInsured = { ...dryRequest };
    delete missingInsured.insured;
    const client = createOneClickClient({
      fetch: async () => json(responseFor(missingInsured)),
      verifyQuoteSignature: () => true,
    });
    await expect(client.quote(dryRequest), "insured").rejects.toMatchObject({
      code: "REQUEST_MISMATCH",
    });
  });

  it("binds status correlation to the verified executable quote", async () => {
    const request = { ...dryRequest, dry: false as const };
    const quoteResponse = responseFor(request, {
      ...amounts,
      depositAddress: "deposit.near",
      depositMemo: "route-123",
      deadline: "2027-01-01T00:00:00.000Z",
      timeWhenInactive: "2026-12-31T23:55:00.000Z",
    });
    const client = createOneClickClient({
      fetch: async () => json({
        correlationId: "different-correlation",
        quoteResponse,
        status: "PROCESSING",
        updatedAt: "2026-10-26T00:01:00.000Z",
        swapDetails: {
          intentHashes: [],
          nearTxHashes: [],
          originChainTxHashes: [],
          destinationChainTxHashes: [],
        },
      }),
      verifyQuoteSignature: () => true,
    });

    await expect(client.status({
      depositAddress: "deposit.near",
      depositMemo: "route-123",
    })).rejects.toMatchObject({ code: "REQUEST_MISMATCH" });
  });

  it("binds status to both memo presence and memo value", async () => {
    const request = { ...dryRequest, dry: false as const };
    const quoteResponse = responseFor(request, {
      ...amounts,
      depositAddress: "deposit.near",
      depositMemo: "route-123",
      deadline: "2027-01-01T00:00:00.000Z",
      timeWhenInactive: "2026-12-31T23:55:00.000Z",
    });
    const client = createOneClickClient({
      fetch: async () => json({
        correlationId: quoteResponse.correlationId,
        quoteResponse,
        status: "PROCESSING",
        updatedAt: "2026-10-26T00:01:00.000Z",
        swapDetails: {
          intentHashes: [],
          nearTxHashes: [],
          originChainTxHashes: [],
          destinationChainTxHashes: [],
        },
      }),
      verifyQuoteSignature: () => true,
    });

    await expect(client.status({ depositAddress: "deposit.near" }))
      .rejects.toMatchObject({ code: "REQUEST_MISMATCH" });
    await expect(client.status({
      depositAddress: "deposit.near",
      depositMemo: "route-456",
    })).rejects.toMatchObject({ code: "REQUEST_MISMATCH" });
  });

  it("returns hashes only from the nested swap details", async () => {
    const request = { ...dryRequest, dry: false as const };
    const quoteResponse = responseFor(request, {
      ...amounts,
      depositAddress: "deposit.near",
      deadline: "2027-01-01T00:00:00.000Z",
      timeWhenInactive: "2026-12-31T23:55:00.000Z",
    });
    const client = createOneClickClient({
      fetch: async () => json({
        correlationId: quoteResponse.correlationId,
        quoteResponse,
        status: "PROCESSING",
        updatedAt: "2026-10-26T00:01:00.000Z",
        nearTxHashes: ["forged-top-level"],
        swapDetails: {
          intentHashes: ["intent-nested"],
          nearTxHashes: ["near-nested"],
          originChainTxHashes: [],
          destinationChainTxHashes: [],
        },
      }),
      verifyQuoteSignature: () => true,
    });

    const status = await client.status({ depositAddress: "deposit.near" });
    expect(status.swapDetails.nearTxHashes).toEqual(["near-nested"]);
    expect("nearTxHashes" in status).toBe(false);
  });

  it("fails closed when signature verification throws", async () => {
    const client = createOneClickClient({
      fetch: async () => json(responseFor()),
      verifyQuoteSignature: () => {
        throw new Error("verification unavailable");
      },
    });

    await expect(client.quote(dryRequest)).rejects.toMatchObject({
      code: "INVALID_SIGNATURE",
    });
  });

  it("enforces the streaming response limit without trusting content-length", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      padding: "x".repeat(1_024),
    }), { headers: { "content-type": "application/json" } }));
    const client = createOneClickClient({ fetch: fetcher, maxResponseBytes: 128 });

    await expect(client.tokens()).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("keeps the partner credential in the header only", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://1click.chaindefuser.com/v0/tokens");
      expect(String(input)).not.toContain("secret-partner-jwt");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("x-api-key")).toBe("secret-partner-jwt");
      return json([]);
    });
    const client = createOneClickClient({ fetch: fetcher, apiKey: "secret-partner-jwt" });

    await expect(client.tokens()).resolves.toEqual([]);
  });
});
