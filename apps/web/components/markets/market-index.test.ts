import type { Venue } from "@pilot/contracts";
import { createMockHarborClient } from "@pilot/harbor-client";
import { beforeAll, describe, expect, it } from "vitest";

import {
  catalogMarketRows,
  filterAndSortMarkets,
  quotedMarketRows,
  QUOTED_VENUE_IDS,
  type MarketRow,
} from "./market-index";
import { ammSummary, bookSummary, depthSide, marketPair, routeSummary } from "./markets-data";
import { fixtureAmm, fixtureCompare, fixtureDepth } from "./markets-fixtures";

const pair = marketPair("testnet", { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" });
let venues: Venue[] = [];

beforeAll(async () => {
  const result = await createMockHarborClient().op("venues.list", {});
  if (!result.ok) throw new Error("mock venues.list failed");
  venues = result.data;
});

function quoted() {
  const book = bookSummary(depthSide(fixtureDepth(pair, "bid"), "bid"), depthSide(fixtureDepth(pair, "ask"), "ask"));
  return quotedMarketRows({
    venues,
    book,
    bookState: "ready",
    amm: ammSummary(fixtureAmm(pair), pair.base, pair.quote),
    ammState: "ready",
    routes: routeSummary(fixtureCompare(pair, "1000")),
    routesState: "ready",
    sizeLabel: "1,000 XRP",
    baseSymbol: "XRP",
    quoteSymbol: "RLUSD",
  });
}

describe("quoted markets", () => {
  it("has one row per executable route with catalog venue names", () => {
    const rows = quoted();
    expect(rows.map((row) => row.route)).toEqual(["order-book", "amm", "path"]);
    expect(rows.map((row) => row.venueName)).toEqual([
      "XRPL DEX Order Book",
      "XRPL Automated Market Maker",
      "XRPL Payment Paths",
    ]);
    for (const row of rows) {
      expect(row.state).toBe("ready");
      expect(row.price).toBeGreaterThan(0);
    }
  });

  it("prices agree within a sensible band", () => {
    const prices = quoted().map((row) => row.price as number);
    const spread = (Math.max(...prices) - Math.min(...prices)) / Math.min(...prices);
    expect(spread).toBeLessThan(0.01);
  });

  it("marks a missing path quote as an error rather than inventing a price", () => {
    const rows = quotedMarketRows({
      venues,
      book: bookSummary([], []),
      bookState: "loading",
      amm: null,
      ammState: "error",
      routes: { routes: [], unavailable: [], best: null, worst: null, savings: 0, savingsBps: 0 },
      routesState: "ready",
      sizeLabel: "100 XRP",
      baseSymbol: "XRP",
      quoteSymbol: "RLUSD",
    });
    expect(rows.find((row) => row.route === "path")).toMatchObject({ state: "error", price: null });
    expect(rows.find((row) => row.route === "amm")).toMatchObject({ state: "error", price: null });
  });
});

describe("catalogued markets", () => {
  it("lists trading venues Harbor does not quote, without the quoted ones or payments-only primitives", () => {
    const rows = catalogMarketRows(venues, "testnet");
    const ids = rows.map((row) => row.venueId);
    for (const id of QUOTED_VENUE_IDS) expect(ids).not.toContain(id);
    expect(ids).not.toContain("xrpl-escrow");
    expect(ids).not.toContain("xrpl-checks");
    expect(ids).not.toContain("xrpl-x402");
    expect(ids).toContain("hyperliquid-xrp-perps");
    expect(ids).toContain("tx-network-sologenic");
    expect(rows.find((row) => row.venueId === "hyperliquid-xrp-perps")?.type).toBe("perps");
    expect(rows.find((row) => row.venueId === "xrpl-lending")?.availability).toBe("unavailable");
  });
});

describe("filter and sort", () => {
  it("filters by kind and type, and sorts by name for real", () => {
    const rows: MarketRow[] = [...quoted(), ...catalogMarketRows(venues, "testnet")];
    const onlyQuoted = filterAndSortMarkets(rows, { filter: "quoted", type: "all", query: "", sort: { key: "default", direction: "asc" } });
    expect(onlyQuoted).toHaveLength(3);
    const perps = filterAndSortMarkets(rows, { filter: "all", type: "perps", query: "", sort: { key: "default", direction: "asc" } });
    expect(perps.every((row) => row.type === "perps")).toBe(true);
    const byName = filterAndSortMarkets(rows, { filter: "all", type: "all", query: "", sort: { key: "name", direction: "desc" } });
    const names = byName.map((row) => row.venueName);
    expect(names).toEqual([...names].sort((a, b) => b.localeCompare(a)));
    const byStatus = filterAndSortMarkets(rows, { filter: "all", type: "all", query: "", sort: { key: "status", direction: "asc" } });
    expect(byStatus.slice(0, 3).every((row) => row.kind === "quoted")).toBe(true);
    const search = filterAndSortMarkets(rows, { filter: "all", type: "all", query: "sologenic", sort: { key: "default", direction: "asc" } });
    expect(search.map((row) => row.venueId)).toEqual(["tx-network-sologenic"]);
  });
});
