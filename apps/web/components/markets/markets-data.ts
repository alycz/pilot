import type { Asset, Network } from "@pilot/contracts";
import type {
  AmmInfoResult,
  DexDepthResult,
  VenueComparisonResult,
  VenueRouteQuote,
} from "@pilot/harbor-client";

/**
 * Pure parsing and derivation for the Markets view. Everything here is
 * deterministic and side-effect free so it can be unit tested and shared by
 * the live (Harbor) and fixture paths.
 */

export type MarketNetwork = Extract<Network, "testnet" | "devnet">;

export type MarketPair = {
  network: MarketNetwork;
  base: Asset;
  quote: Asset;
  label: string;
};

export const XRP: Asset = { currency: "XRP" };

export function assetSymbol(asset: Asset): string {
  const code = asset.currency;
  // 40-hex currency codes encode an ASCII ticker; decode when printable.
  if (/^[0-9A-F]{40}$/i.test(code)) {
    const bytes = code.match(/../g) ?? [];
    const text = bytes
      .map((byte) => Number.parseInt(byte, 16))
      .filter((value) => value !== 0)
      .map((value) => String.fromCharCode(value))
      .join("");
    if (/^[\x20-\x7e]+$/.test(text)) return text;
  }
  return code;
}

export function marketPair(network: MarketNetwork, stableAsset: { currency: string; issuer: string }): MarketPair {
  const quote: Asset = { currency: stableAsset.currency, issuer: stableAsset.issuer };
  return { network, base: XRP, quote, label: `XRP / ${assetSymbol(quote)}` };
}

export function isXrp(asset: Asset): boolean {
  return asset.currency === "XRP" && !asset.issuer;
}

/** Parses a finite decimal string; returns null for anything else. */
export function parseDecimal(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Ledger amounts are either an XRP drops string or an issued-currency object.
 */
export function ledgerAmountValue(amount: unknown): number | null {
  if (typeof amount === "string") {
    if (!/^\d+$/.test(amount)) return null;
    return Number(amount) / 1_000_000;
  }
  if (amount && typeof amount === "object" && "value" in amount) {
    return parseDecimal((amount as { value: unknown }).value);
  }
  return null;
}

/**
 * Depth level amounts are decimal strings. For XRP they may arrive in drops
 * (integer strings) or in XRP units (decimal strings). An integer string of
 * seven or more digits on the XRP side is treated as drops.
 */
export function depthAmountValue(value: string, asset: Asset): number | null {
  const parsed = parseDecimal(value);
  if (parsed === null) return null;
  if (isXrp(asset) && /^\d{7,}$/.test(value.trim())) return parsed / 1_000_000;
  return parsed;
}

export type DepthLevel = {
  /** Price in quote units per one base unit. */
  price: number;
  /** Size in base units at this level. */
  size: number;
  /** Running total of base units from the best level outwards. */
  cumulative: number;
  offers: number;
};

/**
 * Normalises one side of the book.
 * - "ask": offers selling base (taker_gets = base, taker_pays = quote).
 * - "bid": offers buying base (taker_gets = quote, taker_pays = base).
 * Prices are always expressed as quote per base and levels are sorted from
 * the best price outwards.
 */
export function depthSide(result: DexDepthResult, side: "ask" | "bid"): DepthLevel[] {
  const levels: Omit<DepthLevel, "cumulative">[] = [];
  for (const level of result.levels) {
    const gets = depthAmountValue(level.taker_gets, result.taker_gets);
    const pays = depthAmountValue(level.taker_pays, result.taker_pays);
    if (gets === null || pays === null || gets <= 0 || pays <= 0) continue;
    if (side === "ask") levels.push({ price: pays / gets, size: gets, offers: level.offer_count });
    else levels.push({ price: gets / pays, size: pays, offers: level.offer_count });
  }
  levels.sort((a, b) => (side === "ask" ? a.price - b.price : b.price - a.price));
  let running = 0;
  return levels.map((level) => {
    running += level.size;
    return { ...level, cumulative: running };
  });
}

export type BookSummary = {
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  spreadBps: number | null;
  bidDepth: number;
  askDepth: number;
};

export function bookSummary(bids: DepthLevel[], asks: DepthLevel[]): BookSummary {
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const spreadBps = spread !== null && mid ? (spread / mid) * 10_000 : null;
  return {
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadBps,
    bidDepth: bids.at(-1)?.cumulative ?? 0,
    askDepth: asks.at(-1)?.cumulative ?? 0,
  };
}

export type AmmSummary = {
  baseReserve: number;
  quoteReserve: number;
  /** Quote per base implied by the reserves. */
  price: number;
  /** Trading fee as a percentage (XRPL trading_fee is in 1/100,000 units). */
  feePercent: number | null;
  lpSupply: number | null;
  /** Total value of both reserves in quote units. */
  tvlQuote: number;
  account: string | null;
};

function amountMatches(amount: unknown, asset: Asset): boolean {
  if (typeof amount === "string") return isXrp(asset);
  if (amount && typeof amount === "object") {
    const record = amount as { currency?: unknown; issuer?: unknown };
    return record.currency === asset.currency && (asset.issuer === undefined || record.issuer === asset.issuer);
  }
  return false;
}

export function ammSummary(result: AmmInfoResult, base: Asset, quote: Asset): AmmSummary | null {
  const amm = result.amm;
  const first = amm.amount;
  const second = amm.amount2;
  let baseAmount: unknown;
  let quoteAmount: unknown;
  if (amountMatches(first, base) && amountMatches(second, quote)) {
    baseAmount = first;
    quoteAmount = second;
  } else if (amountMatches(second, base) && amountMatches(first, quote)) {
    baseAmount = second;
    quoteAmount = first;
  } else {
    return null;
  }
  const baseReserve = ledgerAmountValue(baseAmount);
  const quoteReserve = ledgerAmountValue(quoteAmount);
  if (!baseReserve || !quoteReserve) return null;
  const fee = typeof amm.trading_fee === "number" ? amm.trading_fee : parseDecimal(amm.trading_fee);
  const lp = ledgerAmountValue(amm.lp_token);
  const price = quoteReserve / baseReserve;
  return {
    baseReserve,
    quoteReserve,
    price,
    feePercent: fee === null ? null : fee / 1000,
    lpSupply: lp,
    tvlQuote: quoteReserve + baseReserve * price,
    account: typeof amm.account === "string" ? amm.account : null,
  };
}

export type RankedRoute = VenueRouteQuote & {
  output: number;
  input: number;
  effectivePrice: number;
  /** Shortfall versus the best available route, in basis points. */
  deltaBps: number;
  best: boolean;
};

export type RouteSummary = {
  routes: RankedRoute[];
  unavailable: VenueRouteQuote[];
  best: RankedRoute | null;
  worst: RankedRoute | null;
  /** Extra output of the best route over the worst available, in output units. */
  savings: number;
  savingsBps: number;
};

export function routeSummary(result: VenueComparisonResult): RouteSummary {
  const available: RankedRoute[] = [];
  const unavailable: VenueRouteQuote[] = [];
  for (const route of result.routes) {
    const output = parseDecimal(route.output_amount);
    const input = parseDecimal(route.input_amount);
    if (!route.available || output === null || input === null || output <= 0 || input <= 0) {
      unavailable.push(route);
      continue;
    }
    available.push({ ...route, output, input, effectivePrice: output / input, deltaBps: 0, best: false });
  }
  available.sort((a, b) => b.output - a.output);
  const best = available[0] ?? null;
  const worst = available.at(-1) ?? null;
  const ranked = available.map((route) => ({
    ...route,
    best: route === best,
    deltaBps: best ? ((best.output - route.output) / best.output) * 10_000 : 0,
  }));
  const savings = best && worst ? best.output - worst.output : 0;
  return {
    routes: ranked,
    unavailable,
    best: ranked[0] ?? null,
    worst: ranked.at(-1) ?? null,
    savings,
    savingsBps: best && worst && worst.output > 0 ? (savings / worst.output) * 10_000 : 0,
  };
}

/** Basis-point deviation of `value` from `reference`. */
export function deviationBps(value: number | null, reference: number | null): number | null {
  if (value === null || reference === null || reference === 0) return null;
  return ((value - reference) / reference) * 10_000;
}

export function formatPrice(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function formatAmount(value: number | null, maximumFractionDigits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits, minimumFractionDigits: 0 }).format(value);
}

export function formatCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

export function formatBps(value: number | null, signed = false): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.abs(value) < 10 ? value.toFixed(1) : value.toFixed(0);
  return `${signed && value > 0 ? "+" : ""}${rounded} bps`;
}

export function formatUsd(value: string | undefined, compact = false): string {
  const parsed = parseDecimal(value);
  if (parsed === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 2 : parsed < 10 ? 4 : 2,
  }).format(parsed);
}

export const ROUTE_LABELS: Record<VenueRouteQuote["route"], string> = {
  "order-book": "Order book",
  amm: "AMM pool",
  path: "Path payment",
};
