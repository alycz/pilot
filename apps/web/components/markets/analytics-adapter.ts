import type { AnalyticsPanelState, PairAnalyticsSnapshot } from "./analytics-types";
import type { AnalyticsComparison, AnalyticsSnapshot } from "./analytics-panels";

function finite(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function symbol(currency: string): string {
  if (currency === "524C555344000000000000000000000000000000") return "RLUSD";
  return currency.length > 8 ? `${currency.slice(0, 6)}…` : currency;
}

function comparisonRows(snapshot: PairAnalyticsSnapshot): AnalyticsComparison[] {
  const observedAt = snapshot.meta.observedAt ?? snapshot.meta.receivedAt;
  const orderBookDepth = [snapshot.book.bids.at(-1), snapshot.book.asks.at(-1)]
    .map((level) => finite(level?.cumulativeBaseSize) ?? 0)
    .reduce((total, value) => total + value, 0);
  const rows: AnalyticsComparison[] = [
    {
      id: "xrpl-order-book",
      label: "XRPL DEX order book",
      venue: "book_offers · validated ledger",
      price: finite(snapshot.metrics.mid),
      spreadBps: finite(snapshot.metrics.spreadBps),
      depth: orderBookDepth > 0 ? orderBookDepth : null,
      depthUnit: symbol(snapshot.pair.base.currency),
      observedAt,
      status: snapshot.metrics.mid ? "available" : snapshot.book.bids.length || snapshot.book.asks.length ? "partial" : "unavailable",
      note: snapshot.book.limited ? `Read capped at ${snapshot.book.maxLevels} levels per side.` : "Bounded funded-offer observation.",
    },
  ];
  rows.push({
    id: "xrpl-amm",
    label: "XRPL AMM pool",
    venue: "amm_info · validated ledger",
    price: finite(snapshot.amm?.impliedPrice),
    spreadBps: null,
    depth: finite(snapshot.amm?.baseReserve),
    depthUnit: symbol(snapshot.pair.base.currency),
    observedAt,
    status: snapshot.amm ? "available" : snapshot.availability.amm === "error" ? "partial" : "unavailable",
    note: snapshot.amm ? "Reserve ratio is observed pool state, not an executable quote." : "No matching AMM observation.",
  });
  return rows;
}

export function toWorkspaceSnapshot(
  state: Extract<AnalyticsPanelState<PairAnalyticsSnapshot>, { status: "ready" | "partial" }>,
): AnalyticsSnapshot {
  const snapshot = state.data;
  const baseSymbol = symbol(snapshot.pair.base.currency);
  const quoteSymbol = symbol(snapshot.pair.quote.currency);
  const observedAt = snapshot.meta.observedAt ?? snapshot.meta.receivedAt;
  const depth = [
    ...snapshot.book.bids.map((level) => ({
      side: "bid" as const,
      price: finite(level.price) ?? 0,
      size: finite(level.baseSize) ?? 0,
      cumulative: finite(level.cumulativeBaseSize) ?? 0,
      offers: level.offerCount,
    })),
    ...snapshot.book.asks.map((level) => ({
      side: "ask" as const,
      price: finite(level.price) ?? 0,
      size: finite(level.baseSize) ?? 0,
      cumulative: finite(level.cumulativeBaseSize) ?? 0,
      offers: level.offerCount,
    })),
  ];
  const bidDepth = snapshot.book.bids.at(-1)?.cumulativeBaseSize;
  const askDepth = snapshot.book.asks.at(-1)?.cumulativeBaseSize;
  return {
    id: `${snapshot.meta.network}:${snapshot.pair.base.currency}:${snapshot.pair.base.issuer ?? "native"}/${snapshot.pair.quote.currency}:${snapshot.pair.quote.issuer ?? "native"}`,
    label: `${baseSymbol} / ${quoteSymbol}`,
    base: { symbol: baseSymbol, currency: snapshot.pair.base.currency, ...(snapshot.pair.base.issuer ? { issuer: snapshot.pair.base.issuer } : {}) },
    quote: { symbol: quoteSymbol, currency: snapshot.pair.quote.currency, ...(snapshot.pair.quote.issuer ? { issuer: snapshot.pair.quote.issuer } : {}) },
    status: state.status,
    unavailableReason: state.status === "partial" ? state.issues.join(" ") : undefined,
    provenance: {
      network: snapshot.meta.network,
      source: `${snapshot.meta.source.operation} · ${snapshot.meta.source.providers.join(" + ")}`,
      observedAt,
      ...(snapshot.meta.ledgerIndex === null ? {} : { ledgerIndex: snapshot.meta.ledgerIndex }),
      ...(snapshot.meta.freshness.ageMs === null ? {} : { freshnessMs: snapshot.meta.freshness.ageMs }),
      stale: snapshot.meta.freshness.state !== "fresh",
      mode: snapshot.meta.mode === "demo-fixture" ? "demo" : "live",
    },
    price: finite(snapshot.metrics.mid),
    priceUnit: `${quoteSymbol} per ${baseSymbol}`,
    bestBid: finite(snapshot.metrics.bestBid),
    bestAsk: finite(snapshot.metrics.bestAsk),
    spreadBps: finite(snapshot.metrics.spreadBps),
    bidDepth: finite(bidDepth),
    askDepth: finite(askDepth),
    depthUnit: baseSymbol,
    history: {
      points: snapshot.history.map((point) => ({
        at: point.observedAt,
        price: finite(point.price) ?? 0,
        ...(point.ledgerIndex === null ? {} : { ledgerIndex: point.ledgerIndex }),
        ...(point.gapBefore ? { gapBefore: true } : {}),
      })),
      startedAt: snapshot.meta.coverage?.startedAt,
      endedAt: snapshot.meta.coverage?.endedAt ?? undefined,
      coverage: snapshot.meta.mode === "demo-fixture" ? "illustrative-fixture" : "sampled-live",
      incomplete: snapshot.meta.coverage?.complete !== true,
    },
    depth,
    liquidity: snapshot.executableLiquidity.map((sample) => {
      const priceImpactBps = finite(sample.sellBase.priceImpactBps);
      return {
        id: `sell-${sample.baseAmount}`,
        inputAmount: finite(sample.baseAmount) ?? 0,
        estimatedOutput: finite(sample.sellBase.quoteAmount),
        averagePrice: finite(sample.sellBase.averagePrice),
        priceImpactBps: sample.sellBase.available && priceImpactBps !== null ? Math.abs(priceImpactBps) : null,
        route: "XRPL DEX bids · sell base",
        available: sample.sellBase.available,
        reason: sample.sellBase.available ? undefined : `Only ${sample.sellBase.filledBase} ${baseSymbol} observed within bounded depth.`,
      };
    }),
    comparisons: comparisonRows(snapshot),
    amm: snapshot.amm ? {
      ...(snapshot.amm.account ? { account: snapshot.amm.account } : {}),
      baseReserve: finite(snapshot.amm.baseReserve) ?? 0,
      quoteReserve: finite(snapshot.amm.quoteReserve) ?? 0,
      feeBps: finite(snapshot.amm.tradingFeeBps),
      reserveUnit: baseSymbol,
    } : null,
  };
}
