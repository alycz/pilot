import { z } from "zod";

import { canonicalDecimal, compareDecimals, isCanonicalDecimal, positiveDecimal } from "./decimal";
import { canonicalJson, sha256Utf8 } from "./hash";
import {
  isTrustedDailyBarSourceId,
  trustedDailyBarSource,
  type TrustedDailyBarSourceId,
} from "./registry";

export const DAILY_BAR_DATASET_SCHEMA_VERSION = "pilot.daily-bar-dataset.v1" as const;

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const UtcDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((day) => {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day;
}, "date must be a real UTC calendar day");
const DecimalSchema = z.string().refine(isCanonicalDecimal, "must be a canonical nonnegative decimal string").transform(canonicalDecimal);
const PositiveDecimalSchema = z.string().refine(positiveDecimal, "must be a positive canonical decimal string").transform(canonicalDecimal);

export const DailyBarSchema = z.object({
  day: UtcDaySchema,
  open: PositiveDecimalSchema,
  high: PositiveDecimalSchema,
  low: PositiveDecimalSchema,
  close: PositiveDecimalSchema,
  volumeBase: DecimalSchema,
  vwap: PositiveDecimalSchema.optional(),
  tradeCount: z.number().int().nonnegative().safe().optional(),
  complete: z.literal(true),
}).strict().superRefine((bar, context) => {
  const maximum = [bar.open, bar.low, bar.close].reduce((result, value) => compareDecimals(value, result) > 0 ? value : result, bar.high);
  const minimum = [bar.open, bar.high, bar.close].reduce((result, value) => compareDecimals(value, result) < 0 ? value : result, bar.low);
  if (compareDecimals(bar.high, maximum) < 0) {
    context.addIssue({ code: "custom", path: ["high"], message: "high must be at least open, low, and close" });
  }
  if (compareDecimals(bar.low, minimum) > 0) {
    context.addIssue({ code: "custom", path: ["low"], message: "low must be at most open, high, and close" });
  }
});

const CoverageSchema = z.object({
  requestedStartDay: UtcDaySchema,
  requestedEndDay: UtcDaySchema,
  expectedBuckets: z.number().int().positive().max(720),
  observedBuckets: z.number().int().nonnegative().max(720),
  missingDays: z.array(UtcDaySchema).max(720),
  status: z.enum(["complete", "partial", "unavailable"]),
}).strict();

export const DailyBarDatasetSchema = z.object({
  schemaVersion: z.literal(DAILY_BAR_DATASET_SCHEMA_VERSION),
  datasetId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/),
  sourceKind: z.literal("validated_historical"),
  sourceRegistryId: z.string().refine(isTrustedDailyBarSourceId, "source is not in the server-owned registry"),
  marketKind: z.literal("provider_spot_market"),
  baseSymbol: z.literal("XRP"),
  quoteSymbol: z.literal("USD"),
  intervalSeconds: z.literal(86_400),
  collectedAt: z.string().datetime({ offset: true }),
  providerLastCursor: z.number().int().nonnegative().safe(),
  coverage: CoverageSchema,
  provenance: z.object({
    metadataPayloadSha256: DigestSchema,
    rawPayloadSha256: DigestSchema,
    rawBundleSha256: DigestSchema,
    normalizedSha256: DigestSchema,
    normalizationVersion: z.literal("kraken-ohlc-daily.v1"),
    methodology: z.string().trim().min(1).max(500),
    redistribution: z.literal("rights-review-required-before-publication"),
  }).strict(),
  bars: z.array(DailyBarSchema).max(720),
}).strict().superRefine((dataset, context) => {
  const source = trustedDailyBarSource(dataset.sourceRegistryId as TrustedDailyBarSourceId);
  if (dataset.baseSymbol !== source.baseSymbol || dataset.quoteSymbol !== source.quoteSymbol || dataset.intervalSeconds !== source.intervalSeconds) {
    context.addIssue({ code: "custom", path: ["sourceRegistryId"], message: "dataset market does not match its trusted source" });
  }
  const start = utcDayEpoch(dataset.coverage.requestedStartDay);
  const end = utcDayEpoch(dataset.coverage.requestedEndDay);
  if (start > end) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "requested start must not be after requested end" });
    return;
  }
  const expectedDays = enumerateUtcDays(dataset.coverage.requestedStartDay, dataset.coverage.requestedEndDay);
  if (expectedDays.length !== dataset.coverage.expectedBuckets) {
    context.addIssue({ code: "custom", path: ["coverage", "expectedBuckets"], message: "expected buckets do not match the requested UTC window" });
  }
  const seen = new Set<string>();
  let previous = -Infinity;
  for (let index = 0; index < dataset.bars.length; index += 1) {
    const bar = dataset.bars[index]!;
    const time = utcDayEpoch(bar.day);
    if (seen.has(bar.day)) context.addIssue({ code: "custom", path: ["bars", index, "day"], message: "bar days must be unique" });
    if (time <= previous) context.addIssue({ code: "custom", path: ["bars", index, "day"], message: "bar days must increase strictly" });
    if (time < start || time > end) context.addIssue({ code: "custom", path: ["bars", index, "day"], message: "bar is outside the requested window" });
    seen.add(bar.day);
    previous = time;
  }
  const actualMissing = expectedDays.filter((day) => !seen.has(day));
  if (JSON.stringify(actualMissing) !== JSON.stringify(dataset.coverage.missingDays)) {
    context.addIssue({ code: "custom", path: ["coverage", "missingDays"], message: "declared missing days do not match the normalized bars" });
  }
  if (dataset.coverage.observedBuckets !== dataset.bars.length) {
    context.addIssue({ code: "custom", path: ["coverage", "observedBuckets"], message: "observed bucket count does not match bars" });
  }
  const status = dataset.bars.length === 0 ? "unavailable" : actualMissing.length === 0 ? "complete" : "partial";
  if (dataset.coverage.status !== status) {
    context.addIssue({ code: "custom", path: ["coverage", "status"], message: "coverage status does not match observed bars" });
  }
});

export type DailyBar = z.infer<typeof DailyBarSchema>;
export type DailyBarDataset = z.infer<typeof DailyBarDatasetSchema>;

function utcDayEpoch(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function enumerateUtcDays(startDay: string, endDay: string): string[] {
  const start = utcDayEpoch(UtcDaySchema.parse(startDay));
  const end = utcDayEpoch(UtcDaySchema.parse(endDay));
  if (start > end) throw new TypeError("requested start must not be after requested end");
  const count = Math.floor((end - start) / 86_400_000) + 1;
  if (count > 720) throw new TypeError("requested daily window exceeds the provider's 720-bar limit");
  return Array.from({ length: count }, (_, index) => utcDay(start + index * 86_400_000));
}

function normalizedDigestPayload(dataset: DailyBarDataset): unknown {
  return {
    schemaVersion: dataset.schemaVersion,
    datasetId: dataset.datasetId,
    sourceKind: dataset.sourceKind,
    sourceRegistryId: dataset.sourceRegistryId,
    marketKind: dataset.marketKind,
    baseSymbol: dataset.baseSymbol,
    quoteSymbol: dataset.quoteSymbol,
    intervalSeconds: dataset.intervalSeconds,
    coverage: dataset.coverage,
    normalizationVersion: dataset.provenance.normalizationVersion,
    bars: dataset.bars,
  };
}

export function normalizedDailyBarDatasetHash(input: unknown): string {
  const dataset = DailyBarDatasetSchema.parse(input);
  return sha256Utf8(canonicalJson(normalizedDigestPayload(dataset)));
}

export function parseDailyBarDataset(input: unknown): DailyBarDataset {
  const dataset = DailyBarDatasetSchema.parse(input);
  const computed = sha256Utf8(canonicalJson(normalizedDigestPayload(dataset)));
  if (computed !== dataset.provenance.normalizedSha256) {
    throw new TypeError("normalized dataset digest does not match its canonical payload");
  }
  return dataset;
}

/** Internal normalization helper. Source trust is established only by a provider adapter artifact. */
export function sealDailyBarDataset(input: Omit<DailyBarDataset, "provenance"> & {
  provenance: Omit<DailyBarDataset["provenance"], "normalizedSha256">;
}): DailyBarDataset {
  const provisional = {
    ...input,
    provenance: { ...input.provenance, normalizedSha256: "0".repeat(64) },
  };
  const parsed = DailyBarDatasetSchema.parse(provisional);
  const normalizedSha256 = sha256Utf8(canonicalJson(normalizedDigestPayload(parsed)));
  return parseDailyBarDataset({
    ...parsed,
    provenance: { ...parsed.provenance, normalizedSha256 },
  });
}
