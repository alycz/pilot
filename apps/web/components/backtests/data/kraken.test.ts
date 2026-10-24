import { describe, expect, it, vi } from "vitest";

import {
  fetchKrakenXrpUsdDailyBars,
  isTrustedKrakenDailyBarArtifact,
  normalizeKrakenXrpUsdDailyPayloads,
  type PrivateDailyBarCacheRecord,
} from "./kraken";
import { sha256Utf8 } from "./hash";

const epoch = (day: string) => Date.parse(`${day}T00:00:00.000Z`) / 1_000;
const metadata = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  error: [],
  result: {
    "XRP/USD": {
      altname: "XRPUSD",
      wsname: "XRP/USD",
      base: "XRP",
      quote: "USD",
      pair_decimals: 5,
      lot_decimals: 8,
      status: "online",
      ...overrides,
    },
  },
});
const row = (day: string, values: Partial<Record<"open" | "high" | "low" | "close", string>> = {}) => [
  epoch(day),
  values.open ?? "2.00000",
  values.high ?? "3.00000",
  values.low ?? "1.00000",
  values.close ?? "2.50000",
  "2.40000",
  "1000.00000000",
  42,
];
const ohlc = (rows: unknown[]) => JSON.stringify({ error: [], result: { "XRP/USD": rows, last: epoch("2025-01-04") } });

describe("Kraken XRP/USD daily adapter", () => {
  it("normalizes the bounded window, drops the final incomplete candle, and records exact hashes", () => {
    const metadataRaw = metadata();
    const ohlcRaw = ohlc([row("2025-01-01"), row("2025-01-02"), row("2025-01-03"), row("2025-01-04")]);
    const dataset = normalizeKrakenXrpUsdDailyPayloads({
      startDay: "2025-01-01",
      endDay: "2025-01-03",
      now: new Date("2025-01-05T00:00:00.000Z"),
      metadataRaw,
      ohlcRaw,
    });

    expect(dataset.bars.map(({ day }) => day)).toEqual(["2025-01-01", "2025-01-02", "2025-01-03"]);
    expect(dataset.bars.every(({ complete }) => complete)).toBe(true);
    expect(dataset.coverage).toMatchObject({ expectedBuckets: 3, observedBuckets: 3, missingDays: [], status: "complete" });
    expect(dataset.provenance.rawPayloadSha256).toBe(sha256Utf8(ohlcRaw));
    expect(dataset.provenance.metadataPayloadSha256).toBe(sha256Utf8(metadataRaw));
    expect(dataset.provenance.methodology).toMatch(/No interpolation, source splicing, or executable-liquidity inference/);
  });

  it("makes gaps explicit without interpolation or fixture fallback", () => {
    const dataset = normalizeKrakenXrpUsdDailyPayloads({
      startDay: "2025-01-01",
      endDay: "2025-01-03",
      now: new Date("2025-01-05T00:00:00.000Z"),
      metadataRaw: metadata(),
      ohlcRaw: ohlc([row("2025-01-01"), row("2025-01-03"), row("2025-01-04")]),
    });
    expect(dataset.coverage).toMatchObject({ observedBuckets: 2, missingDays: ["2025-01-02"], status: "partial" });
    expect(dataset.bars).toHaveLength(2);
  });

  it("fails closed on pair-identity or OHLC violations", () => {
    const input = {
      startDay: "2025-01-01",
      endDay: "2025-01-01",
      now: new Date("2025-01-03T00:00:00.000Z"),
      ohlcRaw: ohlc([row("2025-01-01"), row("2025-01-02")]),
    } as const;
    expect(() => normalizeKrakenXrpUsdDailyPayloads({ ...input, metadataRaw: metadata({ quote: "EUR" }) })).toThrow(/market identity/);
    expect(() => normalizeKrakenXrpUsdDailyPayloads({
      ...input,
      metadataRaw: metadata(),
      ohlcRaw: ohlc([row("2025-01-01", { high: "1.5" }), row("2025-01-02")]),
    })).toThrow(/high/);

    const misaligned = row("2025-01-01");
    misaligned[0] = Number(misaligned[0]) + 60;
    expect(() => normalizeKrakenXrpUsdDailyPayloads({
      ...input,
      metadataRaw: metadata(),
      ohlcRaw: ohlc([misaligned, row("2025-01-02")]),
    })).toThrow(/not aligned to a UTC daily bucket/);
  });

  it("keeps the normalized hash stable across collection time, raw formatting, and trailing current rows", () => {
    const first = normalizeKrakenXrpUsdDailyPayloads({
      startDay: "2025-01-01",
      endDay: "2025-01-02",
      now: new Date("2025-01-04T00:00:00.000Z"),
      metadataRaw: metadata(),
      ohlcRaw: ohlc([row("2025-01-01"), row("2025-01-02"), row("2025-01-03")]),
    });
    const second = normalizeKrakenXrpUsdDailyPayloads({
      startDay: "2025-01-01",
      endDay: "2025-01-02",
      now: new Date("2025-01-05T00:00:00.000Z"),
      metadataRaw: `${metadata()}\n`,
      ohlcRaw: JSON.stringify({
        error: [],
        result: {
          "XRP/USD": [row("2025-01-01"), row("2025-01-02"), row("2025-01-03"), row("2025-01-04")],
          last: epoch("2025-01-04"),
        },
      }),
    });
    expect(second.provenance.rawBundleSha256).not.toBe(first.provenance.rawBundleSha256);
    expect(second.provenance.normalizedSha256).toBe(first.provenance.normalizedSha256);
  });

  it("performs only metadata plus one OHLC request, caches privately, and returns runtime trust evidence", async () => {
    const writes: PrivateDailyBarCacheRecord[] = [];
    const responses = [metadata(), ohlc([row("2025-01-01"), row("2025-01-02"), row("2025-01-03")])];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(responses.shift()!, { status: 200 }));
    const artifact = await fetchKrakenXrpUsdDailyBars({
      startDay: "2025-01-01",
      endDay: "2025-01-02",
      now: new Date("2025-01-04T00:00:00.000Z"),
      fetcher,
      maximumAttempts: 1,
      cache: { write: async (record) => { writes.push(record); } },
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toContain("AssetPairs?pair=XRPUSD&assetVersion=1");
    expect(String(fetcher.mock.calls[1]![0])).toContain("pair=XRPUSD&assetVersion=1&interval=1440&since=1735689600");
    expect(artifact.providerEndpointsRequested).toBe(2);
    expect(isTrustedKrakenDailyBarArtifact(artifact)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ scope: "private-local-outside-repository" });
    expect(JSON.stringify(artifact)).not.toMatch(/api[_-]?key|credential|ledger_index|clob|amm/i);
  });

  it("fails closed when the private cache cannot accept validated provider data", async () => {
    const responses = [metadata(), ohlc([row("2025-01-01"), row("2025-01-02"), row("2025-01-03")])];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(responses.shift()!, { status: 200 }));
    await expect(fetchKrakenXrpUsdDailyBars({
      startDay: "2025-01-01",
      endDay: "2025-01-02",
      now: new Date("2025-01-04T00:00:00.000Z"),
      fetcher,
      maximumAttempts: 1,
      cache: { write: async () => { throw new Error("unsafe cache"); } },
    })).rejects.toThrow(/unsafe cache/i);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses one bounded retry for transient failures but does not retry non-retryable responses", async () => {
    const sleep = vi.fn(async () => undefined);
    const transientResponses = [
      new Response("busy", { status: 503 }),
      new Response(metadata(), { status: 200 }),
      new Response(ohlc([row("2025-01-01"), row("2025-01-02")]), { status: 200 }),
    ];
    const transientFetcher = vi.fn<typeof fetch>(async () => transientResponses.shift()!);
    await fetchKrakenXrpUsdDailyBars({
      startDay: "2025-01-01",
      endDay: "2025-01-01",
      now: new Date("2025-01-03T00:00:00.000Z"),
      fetcher: transientFetcher,
      maximumAttempts: 2,
      sleep,
    });
    expect(transientFetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(1);

    const rejected = vi.fn<typeof fetch>(async () => new Response("bad", { status: 400 }));
    await expect(fetchKrakenXrpUsdDailyBars({
      startDay: "2025-01-01",
      endDay: "2025-01-01",
      now: new Date("2025-01-03T00:00:00.000Z"),
      fetcher: rejected,
      maximumAttempts: 2,
      sleep,
    })).rejects.toThrow(/HTTP 400/);
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});
