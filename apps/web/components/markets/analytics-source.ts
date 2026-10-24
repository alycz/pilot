import { z } from "zod";

import type {
  AnalyticsAsset,
  AnalyticsAssetInput,
  AnalyticsCoverage,
  AnalyticsDepthLevel,
  AnalyticsMode,
  AnalyticsNetwork,
  AnalyticsObservationMeta,
  AnalyticsPanelState,
  AnalyticsPair,
  AnalyticsPairInput,
  AnalyticsPricePoint,
  AnalyticsRecentTrades,
  PairAnalyticsSnapshot,
} from "./analytics-types";

export const ANALYTICS_MAX_LEVELS = 100;
export const ANALYTICS_MAX_HISTORY_SAMPLES = 250;
export const ANALYTICS_MAX_QUOTE_SIZES = 5;
export const ANALYTICS_MAX_RESPONSE_BYTES = 512 * 1024;
export const ANALYTICS_DEFAULT_FRESHNESS_MS = 30_000;

const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const ISSUED_CURRENCY = /^(?:[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}|[A-Fa-f0-9]{40})$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const AssetSchema = z
  .object({
    currency: z.string().trim().min(1).max(40),
    issuer: z.string().regex(CLASSIC_ADDRESS).optional(),
  })
  .strict()
  .superRefine((asset, context) => {
    if (asset.currency === "XRP" && asset.issuer !== undefined) {
      context.addIssue({ code: "custom", path: ["issuer"], message: "XRP must not have an issuer" });
    } else if (asset.currency !== "XRP") {
      if (!ISSUED_CURRENCY.test(asset.currency)) {
        context.addIssue({ code: "custom", path: ["currency"], message: "Issued currency must be a 3-character or 40-hex XRPL code" });
      }
      if (!asset.issuer) {
        context.addIssue({ code: "custom", path: ["issuer"], message: "Issued currency requires an issuer" });
      }
    }
  });

const PositiveDecimalSchema = z.string().regex(DECIMAL).refine((value) => !/^0(?:\.0+)?(?:e[+-]?\d+)?$/i.test(value), "must be greater than zero");
const IsoTimeSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), "must be an ISO-8601 timestamp");
const NetworkSchema = z.enum(["mainnet", "testnet", "devnet"]);
const IdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native"), currency: z.literal("XRP"), issuer: z.null() }).strict(),
  z.object({ kind: z.literal("issued"), currency: z.string().min(1).max(40), issuer: z.string().regex(CLASSIC_ADDRESS) }).strict(),
]);

const DepthLevelSchema = z.object({
  price: PositiveDecimalSchema,
  base_size: PositiveDecimalSchema,
  quote_size: PositiveDecimalSchema.nullish(),
  offer_count: z.number().int().min(1),
  cumulative_base_size: PositiveDecimalSchema,
}).strict();

const TradeSchema = z.object({
  hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
  ledger_index: z.number().int().positive(),
  observed_at: IsoTimeSchema,
  side: z.enum(["buy", "sell", "unknown"]),
  price: PositiveDecimalSchema,
  base_amount: PositiveDecimalSchema,
  quote_amount: PositiveDecimalSchema,
}).strict();

const RecentTradesSchema = z.discriminatedUnion("support", [
  z.object({
    support: z.literal("supported"),
    rows: z.array(TradeSchema).max(200),
    limited: z.boolean(),
  }).strict(),
  z.object({
    support: z.literal("unsupported"),
    rows: z.tuple([]),
    reason: z.string().trim().min(1).max(300),
  }).strict(),
]);

const SnapshotWireSchema = z.object({
  network: NetworkSchema,
  pair: z.object({ base: IdentitySchema, quote: IdentitySchema }).strict(),
  source: z.object({
    operation: z.string().trim().min(1).max(100),
    providers: z.array(z.string().trim().min(1).max(120)).min(1).max(8),
    request_count: z.number().int().min(1).max(10),
    bounded: z.boolean(),
  }).strict(),
  observed_at: IsoTimeSchema,
  ledger_index: z.number().int().positive().nullish(),
  ledger_indexes: z.object({
    bids: z.number().int().positive().nullable(),
    asks: z.number().int().positive().nullable(),
    amm: z.number().int().positive().nullable(),
  }).strict().nullish(),
  freshness: z.object({
    status: z.enum(["live-observation", "partial-observation", "mixed-ledger"]),
    basis: z.literal("validated-ledger"),
    age_seconds: z.null(),
    note: z.string().min(1).max(500),
  }).strict(),
  units: z.object({
    base_size: z.string().min(1), quote_size: z.string().min(1), price: z.string().min(1), spread_bps: z.string().min(1),
  }).strict(),
  book: z.object({
    bids: z.array(DepthLevelSchema).max(ANALYTICS_MAX_LEVELS),
    asks: z.array(DepthLevelSchema).max(ANALYTICS_MAX_LEVELS),
    limited: z.boolean(),
    max_levels: z.number().int().min(1).max(ANALYTICS_MAX_LEVELS),
    availability: z.object({
      bids: z.enum(["available", "empty", "error"]),
      asks: z.enum(["available", "empty", "error"]),
    }).strict(),
    invalid_offer_count: z.number().int().min(0),
  }).strict(),
  metrics: z.object({
    best_bid: PositiveDecimalSchema.nullable(),
    best_ask: PositiveDecimalSchema.nullable(),
    mid: PositiveDecimalSchema.nullable(),
    spread: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/).nullable(),
    spread_bps: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/).nullable(),
  }).strict(),
  executable_liquidity: z.array(z.object({
    base_amount: PositiveDecimalSchema,
    sell_base: z.object({
      direction: z.literal("sell-base"), requested_base: PositiveDecimalSchema, filled_base: z.string().regex(DECIMAL), quote_amount: z.string().regex(DECIMAL),
      average_price: PositiveDecimalSchema.nullable(), price_impact_bps: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/).nullable(),
      benchmark: z.literal("book-mid").nullable(), available: z.boolean(), limited_by_depth: z.boolean(), levels_consumed: z.number().int().min(0),
    }).strict(),
    buy_base: z.object({
      direction: z.literal("buy-base"), requested_base: PositiveDecimalSchema, filled_base: z.string().regex(DECIMAL), quote_amount: z.string().regex(DECIMAL),
      average_price: PositiveDecimalSchema.nullable(), price_impact_bps: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/).nullable(),
      benchmark: z.literal("book-mid").nullable(), available: z.boolean(), limited_by_depth: z.boolean(), levels_consumed: z.number().int().min(0),
    }).strict(),
  }).strict()).max(5),
  amm: z.object({
    account: z.string().regex(CLASSIC_ADDRESS).nullish(),
    base_reserve: PositiveDecimalSchema,
    quote_reserve: PositiveDecimalSchema,
    trading_fee_bps: z.string().regex(DECIMAL).nullish(),
    implied_price: PositiveDecimalSchema,
    units: z.record(z.string(), z.string()),
  }).strict().nullish(),
  availability: z.object({ amm: z.enum(["available", "unavailable", "error"]) }).strict(),
  history: z.object({
    points: z.array(z.object({
      observed_at: IsoTimeSchema,
      ledger_index: z.number().int().positive().nullish(),
      price: PositiveDecimalSchema,
    }).strict()).max(ANALYTICS_MAX_HISTORY_SAMPLES),
    started_at: IsoTimeSchema,
    ended_at: IsoTimeSchema.nullish(),
    max_samples: z.number().int().min(1).max(ANALYTICS_MAX_HISTORY_SAMPLES),
    interval_hint_ms: z.number().int().positive().nullish(),
    complete: z.boolean(),
    reason: z.string().trim().min(1).max(300).optional(),
  }).strict().nullish(),
  recent_trades: RecentTradesSchema.nullish(),
  partial: z.boolean(),
  partial_reasons: z.array(z.string().min(1).max(300)).max(20),
}).strict();

const EnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    data: SnapshotWireSchema,
    asOf: z.string(),
    asOfBasis: z.string(),
    caveat: z.array(z.string()).optional(),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      service: z.string().optional(),
      kind: z.enum(["error", "soft-empty"]).optional(),
      message: z.string().trim().min(1).max(500),
      code: z.string().optional(),
      hint: z.string().optional(),
    }).passthrough(),
  }).passthrough(),
]);

export type AnalyticsRequest = {
  network: AnalyticsNetwork;
  pair: AnalyticsPairInput;
  depthLimit?: number;
  sampleBaseAmounts?: string[];
};

export type ScopedAnalyticsRequest = {
  network: AnalyticsNetwork;
  pair: { base: AnalyticsAssetInput; quote: AnalyticsAssetInput };
  depth_limit: number;
  sample_base_amounts: string[];
};

function sameAsset(left: { currency: string; issuer?: string | null }, right: { currency: string; issuer?: string | null }): boolean {
  return left.currency === right.currency && (left.issuer ?? null) === (right.issuer ?? null);
}

export function scopeAnalyticsRequest(request: AnalyticsRequest): ScopedAnalyticsRequest {
  const network = NetworkSchema.parse(request.network);
  const base = AssetSchema.parse(request.pair.base) as AnalyticsAssetInput;
  const quote = AssetSchema.parse(request.pair.quote) as AnalyticsAssetInput;
  if (sameAsset(base, quote)) throw new Error("Analytics pair assets must be different.");
  const depthLimit = Math.max(1, Math.min(ANALYTICS_MAX_LEVELS, Math.trunc(request.depthLimit ?? 50)));
  const sampleBaseAmounts = [...new Set((request.sampleBaseAmounts ?? ["1", "10", "100"]).map((size) => PositiveDecimalSchema.parse(size)))].slice(0, ANALYTICS_MAX_QUOTE_SIZES);
  return { network, pair: { base, quote }, depth_limit: depthLimit, sample_base_amounts: sampleBaseAmounts };
}

function normalizeLevel(level: z.infer<typeof DepthLevelSchema>): AnalyticsDepthLevel {
  return {
    price: level.price,
    baseSize: level.base_size,
    quoteSize: level.quote_size ?? null,
    offerCount: level.offer_count,
    cumulativeBaseSize: level.cumulative_base_size,
  };
}

function coverageFromWire(history: z.infer<typeof SnapshotWireSchema>["history"]): AnalyticsCoverage | undefined {
  if (!history) return undefined;
  return {
    startedAt: history.started_at,
    endedAt: history.ended_at ?? null,
    sampleCount: history.points.length,
    maxSamples: history.max_samples,
    intervalHintMs: history.interval_hint_ms ?? null,
    complete: history.complete,
    ...(history.reason ? { reason: history.reason } : {}),
  };
}

function freshness(observedAt: string, nowMs: number, maxAgeMs: number): AnalyticsObservationMeta["freshness"] {
  const observedMs = Date.parse(observedAt);
  const ageMs = nowMs - observedMs;
  if (!Number.isFinite(observedMs)) return { state: "unknown", ageMs: null, maxAgeMs, reason: "Invalid observation timestamp" };
  if (ageMs < -30_000) return { state: "unknown", ageMs, maxAgeMs, reason: "Observation clock is ahead of this client" };
  if (ageMs > maxAgeMs) return { state: "stale", ageMs, maxAgeMs, reason: "Observation exceeded the freshness window" };
  return { state: "fresh", ageMs: Math.max(0, ageMs), maxAgeMs };
}

function unitLabel(asset: AnalyticsAsset): string {
  return asset.currency === "XRP" ? "XRP" : `${asset.currency}.${asset.issuer}`;
}

export function normalizeAnalyticsEnvelope(
  payload: unknown,
  request: AnalyticsRequest,
  options: {
    mode?: AnalyticsMode;
    nowMs?: number;
    freshnessMs?: number;
    receivedAt?: string;
  } = {},
): AnalyticsPanelState<PairAnalyticsSnapshot> {
  const receivedAt = options.receivedAt ?? new Date(options.nowMs ?? Date.now()).toISOString();
  const parsed = EnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return { status: "error", message: "Harbor returned an invalid analytics response.", retryable: true, receivedAt };
  }
  if (!parsed.data.ok) {
    const softEmpty = parsed.data.error.kind === "soft-empty";
    if (!softEmpty) {
      return { status: "error", message: parsed.data.error.message, retryable: true, receivedAt };
    }
    return { status: "error", message: parsed.data.error.message, retryable: true, receivedAt };
  }

  let scoped: ScopedAnalyticsRequest;
  try {
    scoped = scopeAnalyticsRequest(request);
  } catch (cause) {
    return { status: "error", message: cause instanceof Error ? cause.message : "Analytics request was invalid.", retryable: false, receivedAt };
  }
  const wire = parsed.data.data;
  if (wire.network !== scoped.network || !sameAsset(wire.pair.base, scoped.pair.base) || !sameAsset(wire.pair.quote, scoped.pair.quote)) {
    return { status: "error", message: "Harbor analytics identity did not match the requested network and pair.", retryable: false, receivedAt };
  }

  const mode = options.mode ?? "live";
  const meta: AnalyticsObservationMeta = {
    network: wire.network,
    mode,
    source: {
      operation: wire.source.operation,
      providers: wire.source.providers,
      requestCount: wire.source.request_count,
      bounded: wire.source.bounded,
    },
    observedAt: wire.observed_at,
    ledgerIndex: wire.ledger_index ?? null,
    ledgerIndexes: wire.ledger_indexes ?? null,
    ledgerCloseTime: null,
    receivedAt,
    freshness: mode === "demo-fixture"
      ? { state: "unknown", ageMs: null, maxAgeMs: options.freshnessMs ?? ANALYTICS_DEFAULT_FRESHNESS_MS, reason: "Illustrative fixture; not a live observation" }
      : wire.freshness.status === "mixed-ledger"
        ? { state: "unknown", ageMs: null, maxAgeMs: options.freshnessMs ?? ANALYTICS_DEFAULT_FRESHNESS_MS, reason: "The upstream reads observed different validated ledgers." }
        : wire.freshness.status === "partial-observation"
          ? { state: "unknown", ageMs: null, maxAgeMs: options.freshnessMs ?? ANALYTICS_DEFAULT_FRESHNESS_MS, reason: "One or more bounded upstream reads were unavailable or incomplete." }
        : freshness(wire.observed_at, options.nowMs ?? Date.now(), options.freshnessMs ?? ANALYTICS_DEFAULT_FRESHNESS_MS),
    units: {
      price: wire.units.price,
      baseSize: wire.units.base_size,
      quoteSize: wire.units.quote_size,
      tradingFeeBps: wire.units.spread_bps,
    },
    ...(coverageFromWire(wire.history) ? { coverage: coverageFromWire(wire.history) } : {}),
  };
  const history: AnalyticsPricePoint[] = (wire.history?.points ?? []).map((point) => ({
    observedAt: point.observed_at,
    ledgerIndex: point.ledger_index ?? null,
    price: point.price,
  }));
  const recentTrades: AnalyticsRecentTrades = wire.recent_trades
    ? wire.recent_trades.support === "supported"
      ? {
          support: "supported",
          limited: wire.recent_trades.limited,
          rows: wire.recent_trades.rows.map((row) => ({
            hash: row.hash,
            ledgerIndex: row.ledger_index,
            observedAt: row.observed_at,
            side: row.side,
            price: row.price,
            baseAmount: row.base_amount,
            quoteAmount: row.quote_amount,
          })),
        }
      : wire.recent_trades
    : { support: "unsupported", rows: [], reason: "The selected source does not expose defensible recent-trade reconstruction." };
  const snapshot: PairAnalyticsSnapshot = {
    pair: wire.pair,
    meta,
    book: {
      bids: wire.book.bids.map(normalizeLevel),
      asks: wire.book.asks.map(normalizeLevel),
      limited: wire.book.limited,
      maxLevels: wire.book.max_levels,
      availability: wire.book.availability,
      invalidOfferCount: wire.book.invalid_offer_count,
    },
    metrics: {
      bestBid: wire.metrics.best_bid,
      bestAsk: wire.metrics.best_ask,
      mid: wire.metrics.mid,
      spread: wire.metrics.spread,
      spreadBps: wire.metrics.spread_bps,
    },
    executableLiquidity: wire.executable_liquidity.map((sample) => ({
      baseAmount: sample.base_amount,
      sellBase: {
        direction: sample.sell_base.direction,
        requestedBase: sample.sell_base.requested_base,
        filledBase: sample.sell_base.filled_base,
        quoteAmount: sample.sell_base.quote_amount,
        averagePrice: sample.sell_base.average_price,
        priceImpactBps: sample.sell_base.price_impact_bps,
        benchmark: sample.sell_base.benchmark,
        available: sample.sell_base.available,
        limitedByDepth: sample.sell_base.limited_by_depth,
        levelsConsumed: sample.sell_base.levels_consumed,
      },
      buyBase: {
        direction: sample.buy_base.direction,
        requestedBase: sample.buy_base.requested_base,
        filledBase: sample.buy_base.filled_base,
        quoteAmount: sample.buy_base.quote_amount,
        averagePrice: sample.buy_base.average_price,
        priceImpactBps: sample.buy_base.price_impact_bps,
        benchmark: sample.buy_base.benchmark,
        available: sample.buy_base.available,
        limitedByDepth: sample.buy_base.limited_by_depth,
        levelsConsumed: sample.buy_base.levels_consumed,
      },
    })),
    amm: wire.amm
      ? {
          account: wire.amm.account ?? null,
          baseReserve: wire.amm.base_reserve,
          quoteReserve: wire.amm.quote_reserve,
          tradingFeeBps: wire.amm.trading_fee_bps ?? null,
          impliedPrice: wire.amm.implied_price,
          units: wire.amm.units,
        }
      : null,
    availability: wire.availability,
    history,
    recentTrades,
  };

  if (!snapshot.book.bids.length && !snapshot.book.asks.length && !snapshot.amm) {
    return { status: "empty", reason: "no-liquidity", message: "No order-book depth or AMM pool was observed for this exact asset pair.", meta };
  }
  const issues: string[] = [];
  if (meta.freshness.state !== "fresh") issues.push(meta.freshness.reason ?? "Freshness is unknown.");
  issues.push(...wire.partial_reasons);
  if (!snapshot.book.bids.length || !snapshot.book.asks.length) issues.push("The observed order book is one-sided.");
  if (snapshot.book.limited) issues.push(`Depth is capped at ${snapshot.book.maxLevels} levels per side.`);
  if (!snapshot.amm) issues.push("No matching AMM pool was observed.");
  if (meta.coverage && !meta.coverage.complete) issues.push(meta.coverage.reason ?? "Sampled history coverage is incomplete.");
  if (snapshot.recentTrades.support === "unsupported") issues.push(snapshot.recentTrades.reason);
  return issues.length ? { status: "partial", data: snapshot, issues: [...new Set(issues)] } : { status: "ready", data: snapshot };
}

async function boundedJson(response: Response): Promise<unknown> {
  const header = response.headers.get("content-length");
  if (header && Number(header) > ANALYTICS_MAX_RESPONSE_BYTES) throw new Error("Harbor analytics response exceeded the size limit.");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > ANALYTICS_MAX_RESPONSE_BYTES) throw new Error("Harbor analytics response exceeded the size limit.");
  return JSON.parse(text) as unknown;
}

/** Browser-safe read through Pilot's existing Harbor proxy; it grants no signing authority. */
export async function fetchMarketAnalytics(
  request: AnalyticsRequest,
  options: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    mode?: AnalyticsMode;
    nowMs?: number;
    freshnessMs?: number;
  } = {},
): Promise<AnalyticsPanelState<PairAnalyticsSnapshot>> {
  const receivedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  let scoped: ScopedAnalyticsRequest;
  try {
    scoped = scopeAnalyticsRequest(request);
  } catch (cause) {
    return { status: "error", message: cause instanceof Error ? cause.message : "Analytics request was invalid.", retryable: false, receivedAt };
  }
  try {
    const response = await (options.fetcher ?? globalThis.fetch)("/api/harbor/analytics.marketSnapshot", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(scoped),
      signal: options.signal,
    });
    const payload = await boundedJson(response);
    if (!response.ok) {
      return { status: "error", message: "Harbor analytics is temporarily unavailable.", retryable: response.status >= 500 || response.status === 429, receivedAt };
    }
    return normalizeAnalyticsEnvelope(payload, request, {
      mode: options.mode,
      nowMs: options.nowMs,
      freshnessMs: options.freshnessMs,
      receivedAt,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    return { status: "error", message: cause instanceof Error ? cause.message : "Harbor analytics is unavailable.", retryable: true, receivedAt };
  }
}
