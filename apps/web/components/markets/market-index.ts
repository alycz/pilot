import type { Network, Venue } from "@pilot/contracts";
import type { VenueRouteQuote } from "@pilot/harbor-client";

import { venueAvailability, type VenueAvailability } from "../map/venue-utils";

import type { PairSnapshot } from "./ledger-markets";
import type { CatalogPair } from "./markets-catalog";
import type { AmmSummary, BookSummary, RouteSummary } from "./markets-data";

/**
 * Builds the "All markets" index. A market is a pair × venue. Only the pair
 * Pilot is configured for (XRP / stable asset) can be quoted through Harbor
 * today, one row per executable route. Every other trading venue in Harbor's
 * catalog is listed without prices — the index never invents a quote.
 */

export type MarketType = "clob" | "amm" | "path" | "dex" | "spot" | "perps" | "lending";

export const MARKET_TYPE_LABELS: Record<MarketType, string> = {
  clob: "Order book",
  amm: "AMM",
  path: "Path",
  dex: "DEX",
  spot: "Spot",
  perps: "Perps",
  lending: "Lending",
};

export type QuotedMarketRow = {
  kind: "quoted";
  key: string;
  /** Catalog pair id (live ledger rows). */
  pairId?: string;
  /** Pair label shown in the row ("XRP / RLUSD"). */
  pairLabel?: string;
  venueId: string;
  venueName: string;
  route: VenueRouteQuote["route"];
  type: MarketType;
  layer: Venue["layer"];
  /** Price in quote per base, or null while loading / unavailable. */
  price: number | null;
  priceBasis: string;
  costLabel: string;
  cost: number | null;
  liquidityLabel: string;
  liquidity: number | null;
  liquidityUnit: string;
  state: "ready" | "loading" | "error";
};

export type CatalogMarketRow = {
  kind: "catalog";
  key: string;
  venueId: string;
  venueName: string;
  type: MarketType;
  layer: Venue["layer"];
  discovery: boolean;
  availability: VenueAvailability;
};

export type MarketRow = QuotedMarketRow | CatalogMarketRow;

const QUOTED_ROUTES: Array<{ venueId: string; route: VenueRouteQuote["route"]; type: MarketType; fallbackName: string }> = [
  { venueId: "xrpl-dex-clob", route: "order-book", type: "clob", fallbackName: "XRPL DEX Order Book" },
  { venueId: "xrpl-amm", route: "amm", type: "amm", fallbackName: "XRPL Automated Market Maker" },
  { venueId: "xrpl-payments", route: "path", type: "path", fallbackName: "XRPL Payment Paths" },
];

const TRADING_CATEGORIES = new Set<Venue["category"][number]>(["spot", "liquidity", "perps", "lending"]);

export const QUOTED_VENUE_IDS = new Set(QUOTED_ROUTES.map((entry) => entry.venueId));

type PanelState = "ready" | "loading" | "error";

export function quotedMarketRows(input: {
  venues: Venue[] | null;
  book: BookSummary;
  bookState: PanelState;
  amm: AmmSummary | null;
  ammState: PanelState;
  routes: RouteSummary | null;
  routesState: PanelState;
  sizeLabel: string;
  baseSymbol: string;
  quoteSymbol: string;
}): QuotedMarketRow[] {
  const byId = new Map((input.venues ?? []).map((venue) => [venue.id, venue]));
  return QUOTED_ROUTES.map(({ venueId, route, type, fallbackName }) => {
    const venue = byId.get(venueId);
    const base = {
      kind: "quoted" as const,
      key: `quoted:${venueId}`,
      venueId,
      venueName: venue?.name ?? fallbackName,
      route,
      type,
      layer: venue?.layer ?? ("xrpl-l1" as const),
    };
    if (route === "order-book") {
      const depth = input.book.bidDepth + input.book.askDepth;
      return {
        ...base,
        price: input.book.mid,
        priceBasis: "Mid",
        costLabel: "Spread",
        cost: input.book.spreadBps,
        liquidityLabel: "Book depth",
        liquidity: depth > 0 ? depth : null,
        liquidityUnit: input.baseSymbol,
        state: input.bookState,
      };
    }
    if (route === "amm") {
      return {
        ...base,
        price: input.amm?.price ?? null,
        priceBasis: "Pool",
        costLabel: "Fee",
        cost: input.amm?.feePercent ?? null,
        liquidityLabel: "Pool TVL",
        liquidity: input.amm?.tvlQuote ?? null,
        liquidityUnit: input.quoteSymbol,
        state: input.ammState,
      };
    }
    const quote = input.routes?.routes.find((candidate) => candidate.route === "path");
    return {
      ...base,
      price: quote?.effectivePrice ?? null,
      priceBasis: `Quote · ${input.sizeLabel}`,
      costLabel: "Impact",
      cost: quote?.price_impact_bps ?? null,
      liquidityLabel: "Routed",
      liquidity: null,
      liquidityUnit: input.quoteSymbol,
      state: input.routesState === "ready" && !quote ? "error" : input.routesState,
    };
  });
}

/**
 * Live rows: one order-book row and one AMM row per catalog pair, priced from
 * what the visitor's browser read off the ledger. A pair without a pool gets an
 * honest "No pool" row rather than a price.
 */
export function ledgerMarketRows(
  entries: Array<{ pair: CatalogPair; snapshot: PairSnapshot | null; state: "loading" | "ready" | "error" }>,
): QuotedMarketRow[] {
  return entries.flatMap(({ pair, snapshot, state }) => {
    const base = pair.base.symbol;
    const quote = pair.quote.symbol;
    const book: QuotedMarketRow = {
      kind: "quoted",
      key: `${pair.id}:order-book`,
      pairId: pair.id,
      pairLabel: pair.label,
      venueId: "xrpl-dex-clob",
      venueName: "XRPL DEX order book",
      route: "order-book",
      type: "clob",
      layer: "xrpl-l1",
      price: snapshot?.book.mid ?? null,
      priceBasis: `Mid · ${quote}`,
      costLabel: "Spread",
      cost: snapshot?.book.spreadBps ?? null,
      liquidityLabel: "Book depth",
      liquidity: snapshot ? snapshot.book.bidDepth + snapshot.book.askDepth || null : null,
      liquidityUnit: base,
      state: state === "ready" && snapshot && snapshot.book.mid === null ? "error" : state,
    };
    const amm: QuotedMarketRow = {
      kind: "quoted",
      key: `${pair.id}:amm`,
      pairId: pair.id,
      pairLabel: pair.label,
      venueId: "xrpl-amm",
      venueName: "XRPL AMM pool",
      route: "amm",
      type: "amm",
      layer: "xrpl-l1",
      price: snapshot?.amm?.price ?? null,
      priceBasis: `Pool · ${quote}`,
      costLabel: "Fee",
      cost: snapshot?.amm?.feePercent ?? null,
      liquidityLabel: "Pool TVL",
      liquidity: snapshot?.amm?.tvlQuote ?? null,
      liquidityUnit: quote,
      state: state === "ready" && !snapshot?.amm ? "error" : state,
    };
    return [book, amm];
  });
}

export function catalogMarketType(venue: Venue): MarketType {
  if (venue.category.includes("perps")) return "perps";
  if (venue.category.includes("lending")) return "lending";
  if (venue.category.includes("liquidity")) return "dex";
  return "spot";
}

/** Trading venues from the catalog that Harbor does not quote today. */
export function catalogMarketRows(venues: Venue[], network: Network): CatalogMarketRow[] {
  return venues
    .filter((venue) => !QUOTED_VENUE_IDS.has(venue.id))
    .filter((venue) => venue.category.some((category) => TRADING_CATEGORIES.has(category)))
    .map((venue) => ({
      kind: "catalog" as const,
      key: `catalog:${venue.id}`,
      venueId: venue.id,
      venueName: venue.name,
      type: catalogMarketType(venue),
      layer: venue.layer,
      discovery: venue.kind === "discovery-venue",
      availability: venueAvailability(venue, network),
    }));
}

export type MarketFilter = "all" | "quoted" | "catalog";
export type MarketSortKey = "default" | "name" | "type" | "status";
export type MarketSort = { key: MarketSortKey; direction: "asc" | "desc" };

const AVAILABILITY_RANK: Record<VenueAvailability, number> = {
  live: 1,
  "devnet-only": 2,
  voting: 3,
  unavailable: 4,
  unlisted: 5,
};

function statusRank(row: MarketRow): number {
  return row.kind === "quoted" ? 0 : AVAILABILITY_RANK[row.availability];
}

export function filterAndSortMarkets(
  rows: MarketRow[],
  options: { filter: MarketFilter; type: MarketType | "all"; query: string; sort: MarketSort },
): MarketRow[] {
  const query = options.query.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => {
    if (options.filter === "quoted" && row.kind !== "quoted") return false;
    if (options.filter === "catalog" && row.kind !== "catalog") return false;
    if (options.type !== "all" && row.type !== options.type) return false;
    if (query && !`${row.venueName} ${row.venueId} ${MARKET_TYPE_LABELS[row.type]}`.toLocaleLowerCase().includes(query)) return false;
    return true;
  });
  if (options.sort.key === "default") return filtered;
  const factor = options.sort.direction === "asc" ? 1 : -1;
  const compare = (a: MarketRow, b: MarketRow): number => {
    switch (options.sort.key) {
      case "name":
        return a.venueName.localeCompare(b.venueName);
      case "type":
        return MARKET_TYPE_LABELS[a.type].localeCompare(MARKET_TYPE_LABELS[b.type]) || a.venueName.localeCompare(b.venueName);
      case "status":
        return statusRank(a) - statusRank(b) || a.venueName.localeCompare(b.venueName);
      default:
        return 0;
    }
  };
  return [...filtered].sort((a, b) => compare(a, b) * factor);
}

/**
 * Status chip for a catalogued (not priced) venue. Harbor's catalog gives most
 * discovery venues no per-network status, so "unlisted" is shown as what it
 * means here rather than as a warning.
 */
export function catalogStatusLabel(availability: VenueAvailability, networkLabel: string, discovery: boolean): string {
  switch (availability) {
    case "live":
      return "Live · not priced";
    case "devnet-only":
      return "Devnet only";
    case "voting":
      return "Amendment voting";
    case "unavailable":
      return `Not on ${networkLabel}`;
    default:
      return discovery ? "Discovery only" : "Not integrated";
  }
}

export function availabilityLabel(availability: VenueAvailability): string {
  switch (availability) {
    case "live":
      return "Live · not quoted";
    case "devnet-only":
      return "Devnet only";
    case "voting":
      return "Voting";
    case "unavailable":
      return "Unavailable";
    default:
      return "Unlisted";
  }
}
