import { describe, expect, it, vi } from "vitest";

import { runTrustedDailyBarBacktest } from "./pipeline";

const epoch = (day: string) => Date.parse(`${day}T00:00:00.000Z`) / 1_000;
const metadata = JSON.stringify({
  error: [],
  result: { "XRP/USD": { altname: "XRPUSD", wsname: "XRP/USD", base: "XRP", quote: "USD" } },
});
const row = (day: string, price: string) => [epoch(day), price, price, price, price, price, "1000", 10];
const days = Array.from({ length: 11 }, (_, index) => `2025-01-${String(index + 1).padStart(2, "0")}`);
const ohlc = JSON.stringify({
  error: [],
  result: {
    "XRP/USD": days.map((day, index) => row(day, ["1", "1", "2", "2", "2", "4", "4", "3", "3", "3", "3"][index]!)),
    last: epoch("2025-01-11"),
  },
});

const request = {
  startDay: "2025-01-01",
  endDay: "2025-01-10",
  outOfSampleStartDay: "2025-01-07",
  initialBase: "0",
  initialQuote: "100",
  targetBaseBps: 5_000,
  bandBps: 100,
  maxTradeQuote: "25",
  spreadBps: 10,
  venueFeeBps: 10,
  slippageBps: 25,
  networkCostQuote: "0.01",
  embargoBars: 1,
  hypothesis: "A bounded allocation band may improve OOS excess return after explicit costs.",
} as const;

function providerFetcher() {
  const responses = [metadata, ohlc];
  return vi.fn<typeof fetch>(async () => new Response(responses.shift()!, { status: 200 }));
}

describe("trusted daily-bar backtest pipeline", () => {
  it("maps trusted bars into a deterministic, reproducible, JSON-safe research response", async () => {
    const cacheWrites: unknown[] = [];
    const fetcher = providerFetcher();
    const response = await runTrustedDailyBarBacktest(request, {
      now: new Date("2025-01-12T12:00:00.000Z"),
      fetcher,
      cache: { write: async (record) => { cacheWrites.push(record); } },
    });

    expect(response.version).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cacheWrites).toHaveLength(1);
    expect(response.viewModel.availability).toBe("validated-historical");
    expect(response.viewModel.provider.actualCoverage).toContain("10/10");
    expect(response.savedRun.report.strategy.parameterFingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(response.savedRun.report.result.engineOutputHashSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(response.chatEvidence).toMatchObject({
      runId: response.savedRun.report.runId,
      resultFingerprint: response.savedRun.report.result.resultFingerprintSha256,
      datasetNormalizedHash: response.savedRun.report.dataset.normalizedHashSha256,
      sourceKind: "validated_historical",
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toMatch(/"bars"|"open"|"high"|"low"|"close"|volumeBase|metadataRaw|ohlcRaw/);
    expect(serialized).not.toMatch(/walletAddress|approvalId|transactionJson|capabilityId/i);
  });

  it("fails closed when the provider is unavailable and never substitutes a fixture", async () => {
    await expect(runTrustedDailyBarBacktest(request, {
      now: new Date("2025-01-12T12:00:00.000Z"),
      fetcher: vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 })),
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("rejects current windows and authority-shaped fields before fetching", async () => {
    const fetcher = providerFetcher();
    await expect(runTrustedDailyBarBacktest({ ...request, endDay: "2025-01-12" }, {
      now: new Date("2025-01-12T12:00:00.000Z"),
      fetcher,
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(runTrustedDailyBarBacktest({ ...request, walletAddress: "rNever" }, {
      now: new Date("2025-01-12T12:00:00.000Z"),
      fetcher,
    })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
