import { describe, expect, it, vi } from "vitest";

import {
  IndexerError,
  INDEXER_MAX_RESPONSE_BYTES,
  createIndexer,
  ledgerCurrency,
  xrplToTokenId,
  type IndexerFetch,
} from "../src/adapters/indexer";

const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD_HEX = "524C555344000000000000000000000000000000";
const TESTNET_RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("indexer adapter", () => {
  it("converts nonstandard codes to the XRPL 160-bit currency form", () => {
    expect(ledgerCurrency("USD")).toBe("USD");
    expect(ledgerCurrency("RLUSD")).toBe(RLUSD_HEX);
    expect(ledgerCurrency(RLUSD_HEX.toLowerCase())).toBe(
      RLUSD_HEX.toLowerCase(),
    );
    expect(() => ledgerCurrency("X".repeat(21))).toThrow();
  });

  it("uses XRPL.to first and normalizes a documented token response", async () => {
    const fetcher = vi.fn<IndexerFetch>().mockResolvedValue(
      json({
        success: true,
        token: {
          issuer: ISSUER,
          currency: RLUSD_HEX,
          name: "RLUSD",
          holders: 67_564,
          trustlines: 100_195,
          supply: "1029443742.8616456089",
          verified: 1,
          kyc: true,
          exch: 0.7694786083203587,
          marketcap: 792134938.6012803,
          assessmentScore: 0.2,
          trendingScore: 1.6,
        },
      }),
    );
    const indexer = createIndexer({
      fetcher,
      env: { XRPLTO_API_KEY: "fixture-key" },
    });

    await expect(
      indexer.lookupToken({ currency: "RLUSD", issuer: ISSUER }),
    ).resolves.toEqual({
      source: "xrpl.to",
      data: {
        currency: RLUSD_HEX,
        issuer: ISSUER,
        code: "RLUSD",
        name: "RLUSD",
        verified: true,
        kyc: true,
        holders: 67_564,
        trustlines: 100_195,
        supply: "1029443742.8616456089",
        marketCapXrp: "792134938.6012803",
        priceXrp: "0.7694786083203587",
        trendingScore: 1.6,
        assessmentScore: 0.2,
      },
    });

    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe(
      `https://api.xrpl.to/v1/token/${ISSUER}_${RLUSD_HEX}`,
    );
    expect(url.searchParams.get("desc")).toBe("yes");
    expect((init?.headers as Headers).get("x-api-key")).toBe("fixture-key");
    expect(init?.redirect).toBe("error");
  });

  it("demonstrably uses XRPSCAN when the forced primary request fails", async () => {
    const fetcher = vi.fn<IndexerFetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "api.xrpl.to") return json({}, 503);
      if (url.hostname === "api.xrpscan.com") {
        return json([
          {
            index: "A".repeat(64),
            Account: "rNVWpnUrR5RMjLsV3dcvjbFm6knaGcqd4Q",
            Asset: { currency: "XRP" },
            Asset2: { currency: RLUSD_HEX, issuer: ISSUER },
            TradingFee: 205,
          },
        ]);
      }
      throw new Error("unexpected provider");
    });
    const indexer = createIndexer({ fetcher });

    await expect(indexer.ammPools({ limit: 5 })).resolves.toEqual({
      source: "xrpscan",
      data: [
        {
          id: "A".repeat(64),
          account: "rNVWpnUrR5RMjLsV3dcvjbFm6knaGcqd4Q",
          asset1: { currency: "XRP" },
          asset2: { currency: RLUSD_HEX, issuer: ISSUER },
          tradingFee: 205,
        },
      ],
    });
    expect(
      fetcher.mock.calls.map(([input]) => new URL(String(input)).hostname),
    ).toEqual(["api.xrpl.to", "api.xrpscan.com"]);
  });

  it("uses Bithomp as the second fallback after HTTP and schema failures", async () => {
    const fetcher = vi.fn<IndexerFetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "api.xrpl.to") return json({}, 500);
      if (url.hostname === "api.xrpscan.com") {
        return json({ not: "the documented token list array" });
      }
      return json({
        tokens: [
          {
            issuer: ISSUER,
            currency: RLUSD_HEX,
            name: "Ripple USD",
            supply: "65905296.29",
            kyc: true,
            trustlines: 62_683,
            holders: 33_945,
            rating: 7_969,
          },
        ],
      });
    });
    const indexer = createIndexer({
      fetcher,
      env: { BITHOMP_API_KEY: "bithomp-fixture-key" },
    });

    const result = await indexer.trendingTokens({ limit: 7 });
    expect(result).toMatchObject({
      source: "bithomp",
      data: [
        {
          currency: RLUSD_HEX,
          issuer: ISSUER,
          name: "Ripple USD",
          assessmentScore: 7_969,
        },
      ],
    });
    expect(
      fetcher.mock.calls.map(([input]) => new URL(String(input)).hostname),
    ).toEqual(["api.xrpl.to", "api.xrpscan.com", "bithomp.com"]);
    expect(
      (fetcher.mock.calls[2]![1]?.headers as Headers).get("x-bithomp-token"),
    ).toBe("bithomp-fixture-key");
  });

  it("caps trending results exactly to the caller's limit", async () => {
    const tokens = Array.from({ length: 3 }, (_, index) => ({
      issuer: ISSUER,
      currency: RLUSD_HEX,
      name: `RLUSD ${index}`,
    }));
    const fetcher = vi
      .fn<IndexerFetch>()
      .mockResolvedValue(json({ success: true, tokens }));

    const result = await createIndexer({ fetcher }).trendingTokens({ limit: 1 });
    expect(result.source).toBe("xrpl.to");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.name).toBe("RLUSD 0");
  });

  it("caps AMM pool results exactly to the caller's limit", async () => {
    const pools = Array.from({ length: 3 }, (_, index) => ({
      _id: `pool-${index}`,
      ammAccount: "rNVWpnUrR5RMjLsV3dcvjbFm6knaGcqd4Q",
      asset1: { currency: "XRP" },
      asset2: { currency: RLUSD_HEX, issuer: ISSUER },
      tradingFee: 100,
    }));
    const fetcher = vi
      .fn<IndexerFetch>()
      .mockResolvedValue(json({ success: true, pools }));

    const result = await createIndexer({ fetcher }).ammPools({ limit: 2 });
    expect(result.source).toBe("xrpl.to");
    expect(result.data).toHaveLength(2);
    expect(result.data.map(({ id }) => id)).toEqual(["pool-0", "pool-1"]);
  });

  it("uses XRPL.to's documented md5 Testnet token endpoint first", async () => {
    const fetcher = vi.fn<IndexerFetch>().mockResolvedValue(
      json({
        success: true,
        token: {
          issuer: TESTNET_RLUSD_ISSUER,
          currency: RLUSD_HEX,
          name: "RLUSD",
          holders: 608,
          supply: 594444.2264395611,
          vol24h: 273967.59346,
        },
        pool: null,
      }),
    );

    await expect(
      createIndexer({ fetcher }).lookupToken({
        network: "testnet",
        currency: "RLUSD",
        issuer: TESTNET_RLUSD_ISSUER,
      }),
    ).resolves.toMatchObject({
      source: "xrpl.to",
      data: {
        issuer: TESTNET_RLUSD_ISSUER,
        currency: RLUSD_HEX,
        volume24hXrp: "273967.59346",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(xrplToTokenId(TESTNET_RLUSD_ISSUER, RLUSD_HEX)).toBe(
      "06f7c0eacf368e67799e24a9af9e1268",
    );
    expect(new URL(String(fetcher.mock.calls[0]![0])).pathname).toBe(
      "/v1/testnet/tokens/06f7c0eacf368e67799e24a9af9e1268",
    );
  });

  it("validates and truncates the XRPL.to verified scam blocklist", async () => {
    const fetcher = vi.fn<IndexerFetch>().mockResolvedValue(
      json({
        success: true,
        addresses: [
          "r13cHG7iwsHMFeFkVpf3NZYr1dRFiTS9v",
          "r1hEJo4VBe7ktLQaKs8fszDz3HS8SVKws",
        ],
      }),
    );
    const result = await createIndexer({ fetcher }).flaggedTokens({ limit: 1 });

    expect(result).toEqual({
      source: "xrpl.to",
      data: [
        {
          issuer: "r13cHG7iwsHMFeFkVpf3NZYr1dRFiTS9v",
          reason: "verified-blocklist",
        },
      ],
    });
  });

  it("rejects undocumented external shapes and reports only safe attempt codes", async () => {
    const fetcher = vi
      .fn<IndexerFetch>()
      .mockImplementation(async () => json({ nope: true }));
    const indexer = createIndexer({ fetcher });

    const error = await indexer.ammPools({ limit: 3 }).catch((caught) => caught);
    expect(error).toBeInstanceOf(IndexerError);
    expect(error.attempts).toEqual([
      { source: "xrpl.to", code: "INVALID_RESPONSE" },
      { source: "xrpscan", code: "INVALID_RESPONSE" },
      { source: "bithomp", code: "INVALID_RESPONSE" },
    ]);
    expect(error.message).not.toContain("nope");
  });

  it("keeps the timeout active while reading a stalled response body", async () => {
    const fetcher = vi.fn<IndexerFetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "api.xrpl.to") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Deliberately never enqueue or close: the adapter must time out.
            },
          }),
        );
      }
      return json([
        {
          code: "RLUSD",
          currency: RLUSD_HEX,
          issuer: ISSUER,
          score: 10,
        },
      ]);
    });

    await expect(
      createIndexer({ fetcher, timeoutMs: 10 }).trendingTokens({ limit: 1 }),
    ).resolves.toMatchObject({ source: "xrpscan" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("caps both declared and chunked response bodies", async () => {
    const declaredFetcher = vi.fn<IndexerFetch>().mockImplementation(async () =>
      new Response("{}", {
        headers: {
          "content-length": String(INDEXER_MAX_RESPONSE_BYTES + 1),
        },
      }),
    );
    const declaredError = await createIndexer({ fetcher: declaredFetcher })
      .ammPools({ limit: 1 })
      .catch((caught) => caught);
    expect(declaredError.attempts).toEqual([
      { source: "xrpl.to", code: "RESPONSE_TOO_LARGE" },
      { source: "xrpscan", code: "RESPONSE_TOO_LARGE" },
      { source: "bithomp", code: "RESPONSE_TOO_LARGE" },
    ]);

    const chunkedFetcher = vi.fn<IndexerFetch>().mockImplementation(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(10));
            controller.enqueue(new Uint8Array(10));
            controller.close();
          },
        }),
      ),
    );
    const chunkedError = await createIndexer({
      fetcher: chunkedFetcher,
      maxResponseBytes: 16,
    })
      .ammPools({ limit: 1 })
      .catch((caught) => caught);
    expect(chunkedError.attempts).toEqual([
      { source: "xrpl.to", code: "RESPONSE_TOO_LARGE" },
      { source: "xrpscan", code: "RESPONSE_TOO_LARGE" },
      { source: "bithomp", code: "RESPONSE_TOO_LARGE" },
    ]);
  });

  it("rejects mismatched lookup identities and invalid direct adapter inputs", async () => {
    const fetcher = vi.fn<IndexerFetch>().mockImplementation(async () =>
      json({
        success: true,
        token: {
          issuer: "rNVWpnUrR5RMjLsV3dcvjbFm6knaGcqd4Q",
          currency: RLUSD_HEX,
        },
      }),
    );
    const indexer = createIndexer({ fetcher });

    const error = await indexer
      .lookupToken({ currency: "RLUSD", issuer: ISSUER })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(IndexerError);
    expect(error.attempts).toEqual([
      { source: "xrpl.to", code: "TOKEN_IDENTITY_MISMATCH" },
      { source: "xrpscan", code: "INVALID_RESPONSE" },
      { source: "bithomp", code: "INVALID_RESPONSE" },
    ]);
    expect(() => indexer.ammPools({ limit: 0 })).toThrow();
  });
});
