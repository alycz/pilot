import type {
  AmmInfoResult,
  DexDepthResult,
  TokenLookupResult,
  VenueComparisonResult,
  VenueRouteQuote,
  YieldOptionsResult,
} from "@pilot/harbor-client";

import { XRP, type MarketPair } from "./markets-data";

/**
 * Deterministic fixture data for mock mode. The mock Harbor does not
 * implement the market read operations, so the Markets view renders these
 * instead and labels them as fixture data everywhere. Every panel derives
 * from one small market model so prices agree across the book, the pool and
 * the routing quotes.
 */

export const FIXTURE_LEDGER_INDEX = 9_345_210;
export const FIXTURE_AS_OF = "2026-10-18T00:00:00.000Z";

const MID = 0.518;
const HALF_SPREAD = 0.0006;

/** Ask ladder: [price offset from best ask, size in XRP]. */
const ASK_STEPS: Array<[number, number]> = [
  [0, 1_850], [0.0006, 2_400], [0.0015, 3_900], [0.0029, 5_200],
  [0.0047, 7_600], [0.0074, 9_800], [0.0114, 14_500], [0.0169, 21_000],
];
const BID_STEPS: Array<[number, number]> = [
  [0, 2_100], [0.0006, 2_750], [0.0015, 3_300], [0.0029, 5_900],
  [0.0048, 8_100], [0.0074, 11_200], [0.0114, 15_800], [0.0169, 19_500],
];
const OFFER_COUNTS = [3, 4, 6, 5, 8, 7, 11, 9];

const AMM_XRP = 412_500;
const AMM_FEE = 300; // 0.300%
const AMM_QUOTE = AMM_XRP * (MID + 0.00045);

function fixed(value: number, digits = 6): string {
  return value.toFixed(digits);
}

export function fixtureDepth(pair: MarketPair, side: "ask" | "bid"): DexDepthResult {
  const steps = side === "ask" ? ASK_STEPS : BID_STEPS;
  const levels = steps.map(([offset, size], index) => {
    const price = side === "ask" ? MID + HALF_SPREAD + offset : MID - HALF_SPREAD - offset;
    const quoteAmount = size * price;
    return side === "ask"
      ? {
          price: fixed(price),
          quality: fixed(quoteAmount / (size * 1_000_000), 12),
          taker_gets: fixed(size, 6),
          taker_pays: fixed(quoteAmount, 6),
          offer_count: OFFER_COUNTS[index] ?? 1,
        }
      : {
          price: fixed(price),
          quality: fixed((size * 1_000_000) / quoteAmount, 6),
          taker_gets: fixed(quoteAmount, 6),
          taker_pays: fixed(size, 6),
          offer_count: OFFER_COUNTS[index] ?? 1,
        };
  });
  const totals = levels.reduce(
    (sum, level) => ({
      taker_gets: sum.taker_gets + Number(level.taker_gets),
      taker_pays: sum.taker_pays + Number(level.taker_pays),
      offer_count: sum.offer_count + level.offer_count,
    }),
    { taker_gets: 0, taker_pays: 0, offer_count: 0 },
  );
  return {
    network: pair.network,
    taker_gets: side === "ask" ? XRP : pair.quote,
    taker_pays: side === "ask" ? pair.quote : XRP,
    ledger_index: FIXTURE_LEDGER_INDEX,
    levels,
    totals: {
      taker_gets: fixed(totals.taker_gets),
      taker_pays: fixed(totals.taker_pays),
      offer_count: totals.offer_count,
    },
  };
}

export function fixtureAmm(pair: MarketPair): AmmInfoResult {
  return {
    network: pair.network,
    ledger_index: FIXTURE_LEDGER_INDEX,
    amm: {
      account: "rPiLotDemoAmmXRPRLUSD7kq3Mv9Ww",
      amount: String(Math.round(AMM_XRP * 1_000_000)),
      amount2: { currency: pair.quote.currency, issuer: pair.quote.issuer ?? "", value: fixed(AMM_QUOTE, 4) },
      lp_token: {
        currency: "03930D02208264E2E40EC1B0C09E4DB96EE197B1",
        issuer: "rPiLotDemoAmmXRPRLUSD7kq3Mv9Ww",
        value: fixed(Math.sqrt(AMM_XRP * AMM_QUOTE), 4),
      },
      trading_fee: AMM_FEE,
    },
  };
}

/** Walks the bid ladder to fill `xrp`; returns quote received. */
function sellIntoBook(xrp: number): { output: number; filled: number } {
  let remaining = xrp;
  let output = 0;
  for (const [offset, size] of BID_STEPS) {
    if (remaining <= 0) break;
    const take = Math.min(size, remaining);
    output += take * (MID - HALF_SPREAD - offset);
    remaining -= take;
  }
  return { output, filled: xrp - remaining };
}

/** Constant-product output for selling `xrp` into the pool after fee. */
function sellIntoAmm(xrp: number): number {
  const afterFee = xrp * (1 - AMM_FEE / 100_000);
  return (AMM_QUOTE * afterFee) / (AMM_XRP + afterFee);
}

export const FIXTURE_TRADE_SIZES = ["100", "1000", "10000"] as const;

export function fixtureCompare(pair: MarketPair, amount: string): VenueComparisonResult {
  const xrp = Number(amount);
  const book = sellIntoBook(xrp);
  const amm = sellIntoAmm(xrp);
  // Path payments may split across the book and the pool; model a modest
  // improvement on the better single venue that grows with size.
  const pathBoost = xrp >= 10_000 ? 0.0021 : xrp >= 1_000 ? 0.0004 : 0;
  const path = Math.max(book.output, amm) * (1 + pathBoost);
  const impact = (output: number) => Number((((MID - output / xrp) / MID) * 10_000).toFixed(1));
  const quote = (route: VenueRouteQuote["route"], venue: string, output: number, fee?: string): VenueRouteQuote => ({
    venue_id: venue,
    route,
    input_amount: fixed(xrp, 6),
    output_amount: fixed(output, 6),
    price: fixed(output / xrp, 6),
    price_impact_bps: impact(output),
    ...(fee ? { fee } : {}),
    available: true,
  });
  const routes: VenueRouteQuote[] = [
    book.filled < xrp
      ? {
          venue_id: "xrpl-dex-clob",
          route: "order-book",
          input_amount: fixed(xrp, 6),
          output_amount: "0",
          price: "0",
          available: false,
          detail: "Book depth is below the requested size.",
        }
      : quote("order-book", "xrpl-dex-clob", book.output, "12 drops network fee"),
    quote("amm", "xrpl-amm", amm, `${(AMM_FEE / 1000).toFixed(3)}% pool fee`),
    quote("path", "xrpl-payments", path, "12 drops network fee"),
  ];
  return { network: pair.network, sell: XRP, buy: pair.quote, amount: fixed(xrp, 6), side: "sell", routes };
}

export function fixtureToken(pair: MarketPair, which: "base" | "quote"): TokenLookupResult {
  if (which === "base") {
    return {
      network: pair.network,
      asset: XRP,
      name: "XRP",
      symbol: "XRP",
      description: "Native asset of the XRP Ledger.",
      price_usd: "0.5182",
      market_cap_usd: "29400000000",
      volume_24h_usd: "1180000000",
      flags: { require_auth: false, global_freeze: false, clawback: false, blackholed: false },
      sources: ["Hyperliquid reference price", "XRPL.to"],
    };
  }
  return {
    network: pair.network,
    asset: pair.quote,
    name: "Ripple USD",
    symbol: "RLUSD",
    description: "USD stablecoin issued on the XRP Ledger.",
    price_usd: "1.0002",
    market_cap_usd: "1250000000",
    volume_24h_usd: "48200000",
    flags: { require_auth: false, global_freeze: false, clawback: true, blackholed: false },
    sources: ["XRPL.to", "Bithomp"],
  };
}

export function fixtureYield(pair: MarketPair): YieldOptionsResult {
  return {
    network: pair.network,
    asset: XRP,
    options: [
      {
        id: "xrpl-amm-xrp-rlusd",
        name: "XRP / RLUSD AMM pool",
        kind: "amm",
        venue_id: "xrpl-amm",
        network: pair.network,
        asset: XRP,
        asset2: pair.quote,
        apr_percent: "6.84",
        tvl_usd: "427300",
        risks: ["Impermanent loss", "Pool fee can change by vote"],
      },
      {
        id: "xrpl-single-asset-vault-xrp",
        name: "XRP single-asset vault",
        kind: "vault",
        venue_id: "xrpl-single-asset-vault",
        network: "devnet",
        asset: XRP,
        apy_percent: "4.20",
        tvl_usd: "51200",
        risks: ["Devnet only", "Vault owner sets withdrawal policy"],
      },
      {
        id: "xrpl-lending-xrp",
        name: "XRP lending market",
        kind: "protocol",
        venue_id: "xrpl-lending",
        network: "devnet",
        asset: XRP,
        apr_percent: "3.10",
        risks: ["Amendment not enabled on Testnet", "Borrower default"],
      },
    ],
  };
}
