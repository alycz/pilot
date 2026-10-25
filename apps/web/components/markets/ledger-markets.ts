import type { Asset } from "@pilot/contracts";
import type { VenueRouteQuote } from "@pilot/harbor-client";

import {
  ammSummary,
  bookSummary,
  ledgerAmountValue,
  parseDecimal,
  routeSummary,
  type AmmSummary,
  type BookSummary,
  type DepthLevel,
  type RouteSummary,
} from "./markets-data";

/**
 * Pure derivations from raw rippled responses (book_offers, amm_info,
 * account_info, gateway_balances, server_info). Nothing here touches the
 * network; the Markets view feeds it what the visitor's browser read.
 */

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

/**
 * One side of a book from `book_offers`.
 * - "ask": request taker_gets = base, taker_pays = quote (offers selling base).
 * - "bid": request taker_gets = quote, taker_pays = base (offers buying base).
 * Funded amounts (taker_gets_funded / taker_pays_funded) win over the nominal
 * TakerGets / TakerPays when rippled reports a partially funded offer.
 * Consecutive offers at the same price are merged into one level.
 */
export function levelsFromOffers(offers: unknown, side: "ask" | "bid"): DepthLevel[] {
  if (!Array.isArray(offers)) return [];
  const raw: Array<{ price: number; size: number }> = [];
  for (const entry of offers) {
    const offer = record(entry);
    if (!offer) continue;
    const gets = ledgerAmountValue(offer.taker_gets_funded ?? offer.TakerGets);
    const pays = ledgerAmountValue(offer.taker_pays_funded ?? offer.TakerPays);
    if (gets === null || pays === null || gets <= 0 || pays <= 0) continue;
    if (side === "ask") raw.push({ price: pays / gets, size: gets });
    else raw.push({ price: gets / pays, size: pays });
  }
  raw.sort((a, b) => (side === "ask" ? a.price - b.price : b.price - a.price));
  const merged: Array<{ price: number; size: number; offers: number }> = [];
  for (const level of raw) {
    const last = merged.at(-1);
    if (last && Math.abs(last.price - level.price) <= Math.abs(level.price) * 1e-9) {
      last.size += level.size;
      last.offers += 1;
    } else {
      merged.push({ ...level, offers: 1 });
    }
  }
  let running = 0;
  return merged.map((level) => {
    running += level.size;
    return { ...level, cumulative: running };
  });
}

/** AMM summary from an `amm_info` result, or null when the pool is absent or mismatched. */
export function ammFromInfo(result: unknown, base: Asset, quote: Asset): AmmSummary | null {
  const amm = record(record(result)?.amm);
  if (!amm) return null;
  return ammSummary({ network: "mainnet", ledger_index: 0, amm }, base, quote);
}

export const ROUTE_VENUES = {
  "order-book": "xrpl-dex-clob",
  amm: "xrpl-amm",
} as const;

/** Sells `size` base into the bid side; null when the book is too thin. */
export function sellIntoBook(bids: DepthLevel[], size: number): { output: number; filled: number } {
  let remaining = size;
  let output = 0;
  for (const level of bids) {
    if (remaining <= 0) break;
    const take = Math.min(level.size, remaining);
    output += take * level.price;
    remaining -= take;
  }
  return { output, filled: size - remaining };
}

/** Constant-product output for selling `size` base into the pool after the trading fee. */
export function sellIntoAmm(amm: AmmSummary, size: number): number {
  const fee = (amm.feePercent ?? 0) / 100;
  const afterFee = size * (1 - fee);
  return (amm.quoteReserve * afterFee) / (amm.baseReserve + afterFee);
}

function fixed(value: number, digits = 6): string {
  return value.toFixed(digits);
}

/**
 * Route quotes for selling `size` base, computed locally from live book and
 * pool data. Shaped like Harbor's venues.compare routes so the same ranking
 * and chart code renders both.
 */
export function quoteRoutes(input: {
  size: number;
  bids: DepthLevel[];
  amm: AmmSummary | null;
  mid: number | null;
  ammUnavailableReason?: string;
}): RouteSummary {
  const { size, bids, amm, mid, ammUnavailableReason } = input;
  const impact = (output: number) =>
    mid ? Number((((mid - output / size) / mid) * 10_000).toFixed(1)) : undefined;
  const routes: VenueRouteQuote[] = [];

  const book = sellIntoBook(bids, size);
  if (!bids.length) {
    routes.push({ venue_id: ROUTE_VENUES["order-book"], route: "order-book", input_amount: fixed(size), output_amount: "0", price: "0", available: false, detail: "No resting bids." });
  } else if (book.filled < size) {
    routes.push({
      venue_id: ROUTE_VENUES["order-book"],
      route: "order-book",
      input_amount: fixed(size),
      output_amount: "0",
      price: "0",
      available: false,
      detail: "Book depth read is below this size.",
    });
  } else {
    const quote: VenueRouteQuote = {
      venue_id: ROUTE_VENUES["order-book"],
      route: "order-book",
      input_amount: fixed(size),
      output_amount: fixed(book.output),
      price: fixed(book.output / size),
      fee: "Network fee only",
      available: true,
    };
    const bps = impact(book.output);
    if (bps !== undefined) quote.price_impact_bps = bps;
    routes.push(quote);
  }

  if (!amm) {
    routes.push({
      venue_id: ROUTE_VENUES.amm,
      route: "amm",
      input_amount: fixed(size),
      output_amount: "0",
      price: "0",
      available: false,
      detail: ammUnavailableReason ?? "No AMM pool for this pair.",
    });
  } else {
    const output = sellIntoAmm(amm, size);
    const quote: VenueRouteQuote = {
      venue_id: ROUTE_VENUES.amm,
      route: "amm",
      input_amount: fixed(size),
      output_amount: fixed(output),
      price: fixed(output / size),
      available: output > 0,
      ...(amm.feePercent !== null ? { fee: `${amm.feePercent.toFixed(3)}% pool fee` } : {}),
    };
    const bps = impact(output);
    if (bps !== undefined) quote.price_impact_bps = bps;
    routes.push(quote);
  }

  return routeSummary({ network: "mainnet", sell: { currency: "BASE" }, buy: { currency: "QUOTE" }, amount: fixed(size), side: "sell", routes });
}

/** Summary of one pair's live state. */
export type PairSnapshot = {
  bids: DepthLevel[];
  asks: DepthLevel[];
  book: BookSummary;
  amm: AmmSummary | null;
  ledgerIndex: number | null;
};

export function pairSnapshot(input: {
  askOffers: unknown;
  bidOffers: unknown;
  ammResult: unknown | null;
  base: Asset;
  quote: Asset;
  ledgerIndex: number | null;
}): PairSnapshot {
  const asks = levelsFromOffers(input.askOffers, "ask");
  const bids = levelsFromOffers(input.bidOffers, "bid");
  return {
    asks,
    bids,
    book: bookSummary(bids, asks),
    amm: input.ammResult ? ammFromInfo(input.ammResult, input.base, input.quote) : null,
    ledgerIndex: input.ledgerIndex,
  };
}

/** AccountRoot flags relevant to holders of an issued asset. */
export const ACCOUNT_FLAGS = {
  requireAuth: 0x00040000,
  noFreeze: 0x00200000,
  globalFreeze: 0x00400000,
  defaultRipple: 0x00800000,
  allowTrustLineClawback: 0x80000000,
} as const;

export type IssuerInfo = {
  account: string;
  domain: string | null;
  /** Transfer fee as a percentage (0 when TransferRate is unset). */
  transferFeePercent: number;
  requireAuth: boolean;
  noFreeze: boolean;
  globalFreeze: boolean;
  defaultRipple: boolean;
  clawback: boolean;
  /** Total issued on the XRPL (gateway_balances obligations), if read. */
  circulating: number | null;
  ledgerIndex: number | null;
};

function hasFlag(flags: number, flag: number): boolean {
  // Flags are 32-bit unsigned; avoid signed bitwise on 0x80000000.
  return Math.floor(flags / flag) % 2 === 1;
}

function hexToAscii(hex: string): string | null {
  if (!/^([0-9A-F]{2})+$/i.test(hex)) return null;
  const text = (hex.match(/../g) ?? []).map((byte) => String.fromCharCode(Number.parseInt(byte, 16))).join("");
  return /^[\x20-\x7e]+$/.test(text) ? text : null;
}

export function issuerFromAccountInfo(result: unknown, gatewayBalances: unknown, currency: string, symbol: string): IssuerInfo | null {
  const data = record(record(result)?.account_data);
  if (!data || typeof data.Account !== "string") return null;
  const flags = typeof data.Flags === "number" ? data.Flags : Number(data.Flags ?? 0) || 0;
  const rate = typeof data.TransferRate === "number" ? data.TransferRate : null;
  const obligations = record(record(gatewayBalances)?.obligations);
  const circulating = obligations ? parseDecimal(obligations[currency] ?? obligations[symbol]) : null;
  const ledger = record(result)?.ledger_index;
  return {
    account: data.Account,
    domain: typeof data.Domain === "string" ? hexToAscii(data.Domain) : null,
    transferFeePercent: rate && rate > 1_000_000_000 ? (rate / 1_000_000_000 - 1) * 100 : 0,
    requireAuth: hasFlag(flags, ACCOUNT_FLAGS.requireAuth),
    noFreeze: hasFlag(flags, ACCOUNT_FLAGS.noFreeze),
    globalFreeze: hasFlag(flags, ACCOUNT_FLAGS.globalFreeze),
    defaultRipple: hasFlag(flags, ACCOUNT_FLAGS.defaultRipple),
    clawback: hasFlag(flags, ACCOUNT_FLAGS.allowTrustLineClawback),
    circulating,
    ledgerIndex: typeof ledger === "number" ? ledger : null,
  };
}

export type LedgerServerInfo = {
  validatedLedger: number | null;
  baseFeeXrp: number | null;
  reserveBaseXrp: number | null;
  reserveIncXrp: number | null;
  closeAgeSeconds: number | null;
  buildVersion: string | null;
};

export function serverInfoSummary(result: unknown): LedgerServerInfo {
  const info = record(record(result)?.info);
  const ledger = record(info?.validated_ledger);
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : parseDecimal(value));
  return {
    validatedLedger: num(ledger?.seq),
    baseFeeXrp: num(ledger?.base_fee_xrp),
    reserveBaseXrp: num(ledger?.reserve_base_xrp),
    reserveIncXrp: num(ledger?.reserve_inc_xrp),
    closeAgeSeconds: num(ledger?.age),
    buildVersion: typeof info?.build_version === "string" ? info.build_version : null,
  };
}

/** Readable request summary for the ledger inspector. */
export function describeRequest(command: string, params: JsonRecord, symbols: (asset: unknown) => string): string {
  switch (command) {
    case "book_offers":
      return `gets ${symbols(params.taker_gets)} · pays ${symbols(params.taker_pays)}${params.limit ? ` · ${String(params.limit)}` : ""}`;
    case "amm_info":
      return `${symbols(params.asset)} / ${symbols(params.asset2)}`;
    case "account_info":
    case "gateway_balances":
      return typeof params.account === "string" ? `${params.account.slice(0, 6)}…${params.account.slice(-4)}` : "";
    case "subscribe":
      return "stream · ledger";
    default:
      return "";
  }
}
