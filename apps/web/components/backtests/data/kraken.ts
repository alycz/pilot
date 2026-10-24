import { z } from "zod";

import {
  enumerateUtcDays,
  sealDailyBarDataset,
  type DailyBar,
  type DailyBarDataset,
} from "./contract";
import { canonicalDecimal } from "./decimal";
import { rawProviderPayloadHash, sha256Utf8 } from "./hash";
import {
  KRAKEN_XRP_USD_DAILY_SOURCE_ID,
  trustedDailyBarSource,
} from "./registry";

const KrakenEnvelopeSchema = z.object({ error: z.array(z.string()), result: z.record(z.unknown()) }).passthrough();
const KrakenPairSchema = z.object({
  altname: z.string(),
  wsname: z.string(),
  base: z.string(),
  quote: z.string(),
}).passthrough();
const KrakenOhlcRowSchema = z.tuple([
  z.number().int().nonnegative().safe(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.number().int().nonnegative().safe(),
]);

export type KrakenDailyBarFetchOptions = Readonly<{
  startDay: string;
  endDay: string;
  now: Date;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maximumAttempts?: 1 | 2;
  retryBackoffMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  cache?: PrivateDailyBarCache;
}>;

export type PrivateDailyBarCacheRecord = Readonly<{
  cacheKey: string;
  scope: "private-local-outside-repository";
  metadataRaw: string;
  ohlcRaw: string;
  dataset: DailyBarDataset;
}>;

export interface PrivateDailyBarCache {
  write(record: PrivateDailyBarCacheRecord): Promise<void>;
}

const TRUSTED_KRAKEN_ARTIFACT = Symbol("trusted-kraken-daily-bar-artifact");

export type KrakenDailyBarArtifact = Readonly<{
  dataset: DailyBarDataset;
  cacheKey: string;
  providerEndpointsRequested: 2;
  incompleteProviderBarDiscarded: true;
  [TRUSTED_KRAKEN_ARTIFACT]: true;
}>;

function dayToEpochSeconds(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1_000);
}

function epochToDay(epochSeconds: number): string {
  return new Date(epochSeconds * 1_000).toISOString().slice(0, 10);
}

function parseEnvelope(raw: string, label: string): z.infer<typeof KrakenEnvelopeSchema> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new TypeError(`${label} returned invalid JSON`);
  }
  const envelope = KrakenEnvelopeSchema.parse(json);
  if (envelope.error.length > 0) throw new Error(`${label} returned provider errors: ${envelope.error.join(", ")}`);
  return envelope;
}

async function boundedGet(
  url: string,
  fetcher: typeof fetch,
  options: Required<Pick<KrakenDailyBarFetchOptions, "timeoutMs" | "maximumAttempts" | "retryBackoffMs" | "sleep">>,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maximumAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Kraken public data request timed out")), options.timeoutMs);
    try {
      const response = await fetcher(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === options.maximumAttempts) {
          const failure = new Error(`Kraken public data request failed with HTTP ${response.status}`);
          Object.assign(failure, { retryable: false });
          throw failure;
        }
        lastError = new Error(`Kraken public data request failed with HTTP ${response.status}`);
      } else {
        return await response.text();
      }
    } catch (cause) {
      lastError = cause;
      if (cause instanceof Error && "retryable" in cause && cause.retryable === false) throw cause;
      if (attempt === options.maximumAttempts) throw cause;
    } finally {
      clearTimeout(timer);
    }
    await options.sleep(options.retryBackoffMs * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error("Kraken public data request failed");
}

function verifyPairMetadata(metadataText: string): void {
  const source = trustedDailyBarSource(KRAKEN_XRP_USD_DAILY_SOURCE_ID);
  const envelope = parseEnvelope(metadataText, "Kraken pair metadata");
  const keys = Object.keys(envelope.result);
  if (keys.length !== 1 || keys[0] !== source.providerResultKey) {
    throw new TypeError("Kraken pair metadata did not resolve to the exact trusted XRP/USD result key");
  }
  const pair = KrakenPairSchema.parse(envelope.result[source.providerResultKey]);
  if (
    pair.altname !== source.providerAltName ||
    pair.wsname !== source.providerWebsocketName ||
    pair.base !== source.providerBaseCode ||
    pair.quote !== source.providerQuoteCode
  ) {
    throw new TypeError("Kraken pair metadata does not match the trusted XRP/USD market identity");
  }
}

function normalizedBars(ohlcText: string, startDay: string, endDay: string): {
  bars: DailyBar[];
  lastCursor: number;
} {
  const source = trustedDailyBarSource(KRAKEN_XRP_USD_DAILY_SOURCE_ID);
  const envelope = parseEnvelope(ohlcText, "Kraken OHLC");
  const resultKeys = Object.keys(envelope.result).filter((key) => key !== "last");
  if (resultKeys.length !== 1 || resultKeys[0] !== source.providerResultKey) {
    throw new TypeError("Kraken OHLC did not resolve to the exact trusted XRP/USD result key");
  }
  const lastCursor = z.number().int().nonnegative().safe().parse(envelope.result.last);
  const rows = z.array(KrakenOhlcRowSchema).max(source.maximumRecentBars).parse(envelope.result[source.providerResultKey]);
  if (rows.length === 0) throw new TypeError("Kraken OHLC returned no bars");

  // Kraken documents the final OHLC row as the current, not-yet-committed candle.
  const committedRows = rows.slice(0, -1);
  const start = dayToEpochSeconds(startDay);
  const endExclusive = dayToEpochSeconds(endDay) + source.intervalSeconds;
  return {
    lastCursor,
    bars: committedRows
      .filter((row) => row[0] >= start && row[0] < endExclusive)
      .map((row) => {
        if (row[0] % source.intervalSeconds !== 0) {
          throw new TypeError("Kraken daily OHLC timestamp is not aligned to a UTC daily bucket");
        }
        return {
          day: epochToDay(row[0]),
          open: canonicalDecimal(row[1]),
          high: canonicalDecimal(row[2]),
          low: canonicalDecimal(row[3]),
          close: canonicalDecimal(row[4]),
          vwap: canonicalDecimal(row[5]),
          volumeBase: canonicalDecimal(row[6]),
          tradeCount: row[7],
          complete: true as const,
        };
      }),
  };
}

export function normalizeKrakenXrpUsdDailyPayloads(input: Readonly<{
  startDay: string;
  endDay: string;
  now: Date;
  metadataRaw: string;
  ohlcRaw: string;
}>): DailyBarDataset {
  const expectedDays = enumerateUtcDays(input.startDay, input.endDay);
  const { metadataRaw, ohlcRaw } = input;
  verifyPairMetadata(metadataRaw);
  const normalized = normalizedBars(ohlcRaw, input.startDay, input.endDay);
  const observed = new Set(normalized.bars.map(({ day }) => day));
  const missingDays = expectedDays.filter((day) => !observed.has(day));
  return sealDailyBarDataset({
    schemaVersion: "pilot.daily-bar-dataset.v1",
    datasetId: `kraken.xrp-usd.daily.${input.startDay}.${input.endDay}`,
    sourceKind: "validated_historical",
    sourceRegistryId: KRAKEN_XRP_USD_DAILY_SOURCE_ID,
    marketKind: "provider_spot_market",
    baseSymbol: "XRP",
    quoteSymbol: "USD",
    intervalSeconds: 86_400,
    collectedAt: input.now.toISOString(),
    providerLastCursor: normalized.lastCursor,
    coverage: {
      requestedStartDay: input.startDay,
      requestedEndDay: input.endDay,
      expectedBuckets: expectedDays.length,
      observedBuckets: normalized.bars.length,
      missingDays,
      status: normalized.bars.length === 0 ? "unavailable" : missingDays.length === 0 ? "complete" : "partial",
    },
    provenance: {
      metadataPayloadSha256: sha256Utf8(metadataRaw),
      rawPayloadSha256: sha256Utf8(ohlcRaw),
      rawBundleSha256: rawProviderPayloadHash(metadataRaw, ohlcRaw),
      normalizationVersion: "kraken-ohlc-daily.v1",
      methodology: "Exact Kraken XRP/USD daily OHLC rows, filtered to the requested UTC window after discarding the provider's final incomplete candle. No interpolation, source splicing, or executable-liquidity inference.",
      redistribution: "rights-review-required-before-publication",
    },
    bars: normalized.bars,
  });
}

export async function fetchKrakenXrpUsdDailyBars(options: KrakenDailyBarFetchOptions): Promise<KrakenDailyBarArtifact> {
  const source = trustedDailyBarSource(KRAKEN_XRP_USD_DAILY_SOURCE_ID);
  enumerateUtcDays(options.startDay, options.endDay);
  const fetcher = options.fetcher ?? fetch;
  const requestOptions = {
    timeoutMs: options.timeoutMs ?? 5_000,
    maximumAttempts: options.maximumAttempts ?? 2,
    retryBackoffMs: options.retryBackoffMs ?? 200,
    sleep: options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
  } as const;

  const metadataRaw = await boundedGet(source.metadataEndpoint, fetcher, requestOptions);
  const query = new URL(source.dataEndpoint);
  query.searchParams.set("pair", source.requestedPair);
  query.searchParams.set("assetVersion", "1");
  query.searchParams.set("interval", String(source.intervalMinutes));
  query.searchParams.set("since", String(dayToEpochSeconds(options.startDay)));
  const ohlcRaw = await boundedGet(query.toString(), fetcher, requestOptions);
  const dataset = normalizeKrakenXrpUsdDailyPayloads({
    startDay: options.startDay,
    endDay: options.endDay,
    now: options.now,
    metadataRaw,
    ohlcRaw,
  });
  const cacheKey = `${dataset.sourceRegistryId}/${dataset.datasetId}/${dataset.provenance.rawPayloadSha256}`;
  if (options.cache) {
    await options.cache.write({
      cacheKey,
      scope: "private-local-outside-repository",
      metadataRaw,
      ohlcRaw,
      dataset,
    });
  }
  return {
    dataset,
    cacheKey,
    providerEndpointsRequested: 2,
    incompleteProviderBarDiscarded: true,
    [TRUSTED_KRAKEN_ARTIFACT]: true,
  };
}

export function isTrustedKrakenDailyBarArtifact(input: unknown): input is KrakenDailyBarArtifact {
  return typeof input === "object" && input !== null && TRUSTED_KRAKEN_ARTIFACT in input;
}
