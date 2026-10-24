import { describe, expect, it } from "vitest";

import {
  DailyBarDatasetSchema,
  enumerateUtcDays,
  normalizedDailyBarDatasetHash,
  parseDailyBarDataset,
} from "./contract";
import { canonicalDecimal, compareDecimals, isCanonicalDecimal } from "./decimal";
import { normalizeKrakenXrpUsdDailyPayloads } from "./kraken";

const epoch = (day: string) => Date.parse(`${day}T00:00:00.000Z`) / 1_000;
const metadataRaw = JSON.stringify({
  error: [],
  result: {
    "XRP/USD": { altname: "XRPUSD", wsname: "XRP/USD", base: "XRP", quote: "USD", status: "online" },
  },
});
const row = (day: string, open = "2.00000", high = "3.00000", low = "1.00000", close = "2.50000") => [
  epoch(day), open, high, low, close, "2.40000", "1000.00000000", 42,
];

function dataset() {
  return normalizeKrakenXrpUsdDailyPayloads({
    startDay: "2025-01-01",
    endDay: "2025-01-03",
    now: new Date("2025-01-05T12:00:00.000Z"),
    metadataRaw,
    ohlcRaw: JSON.stringify({
      error: [],
      result: {
        "XRP/USD": [row("2025-01-01"), row("2025-01-02"), row("2025-01-03"), row("2025-01-04")],
        last: epoch("2025-01-04"),
      },
    }),
  });
}

describe("daily-bar dataset contract", () => {
  it("uses canonical decimal strings without floating-point comparison", () => {
    expect(isCanonicalDecimal("0.10000000")).toBe(true);
    expect(() => canonicalDecimal("0001.0")).toThrow(/canonical string/);
    expect(canonicalDecimal("1.23000000")).toBe("1.23");
    expect(compareDecimals("9007199254740993.1", "9007199254740993.09")).toBe(1);
    expect(isCanonicalDecimal("1e-8")).toBe(false);
    expect(isCanonicalDecimal("-1")).toBe(false);
  });

  it("counts the frozen UTC window without assuming provider coverage", () => {
    const days = enumerateUtcDays("2025-01-01", "2026-09-30");
    expect(days).toHaveLength(638);
    expect(days[0]).toBe("2025-01-01");
    expect(days.at(-1)).toBe("2026-09-30");
    expect(() => enumerateUtcDays("2024-01-01", "2026-09-30")).toThrow(/720-bar limit/);
  });

  it("verifies normalized content hashes and detects tampering", () => {
    const original = dataset();
    expect(parseDailyBarDataset(original)).toEqual(original);
    expect(normalizedDailyBarDatasetHash(original)).toBe(original.provenance.normalizedSha256);
    const tampered = structuredClone(original);
    tampered.bars[0]!.close = "2.6";
    expect(() => parseDailyBarDataset(tampered)).toThrow(/digest/);
  });

  it("rejects invalid OHLC, duplicates, and dishonest coverage declarations", () => {
    const invalidOhlc = structuredClone(dataset());
    invalidOhlc.bars[0]!.high = "1.5";
    expect(DailyBarDatasetSchema.safeParse(invalidOhlc).success).toBe(false);

    const duplicate = structuredClone(dataset());
    duplicate.bars[1]!.day = duplicate.bars[0]!.day;
    expect(DailyBarDatasetSchema.safeParse(duplicate).success).toBe(false);

    const hiddenGap = structuredClone(dataset());
    hiddenGap.bars.splice(1, 1);
    hiddenGap.coverage.observedBuckets -= 1;
    expect(DailyBarDatasetSchema.safeParse(hiddenGap).success).toBe(false);
  });
});
