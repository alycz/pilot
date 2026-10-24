import type { PairSnapshot } from "./ledger-markets";
import { MARKET_CATALOG } from "./markets-catalog";
import { bookSummary, type AmmSummary, type DepthLevel } from "./markets-data";
import { FIXTURE_LEDGER_INDEX } from "./markets-fixtures";

/** The snapshot shown when no public XRPL node answers covers every mainnet pair. */
export const DEMO_MARKET_NETWORK = "mainnet" as const;

type DemoMarket = {
  mid: number;
  /** Half spread as a fraction of mid. */
  halfSpread: number;
  /** Price step between levels as a fraction of mid. */
  step: number;
  /** Size of the best level in base units; deeper levels grow from it. */
  size: number;
  ammBase: number;
  ammFeePercent: number;
  ammAccount: string;
  /** AMM price offset from mid as a fraction (positive: pool above the book). */
  ammSkew: number;
};

const DEMO_MARKETS: Record<string, DemoMarket> = {
  "mainnet:xrp-rlusd": { mid: 0.5182, halfSpread: 0.0011, step: 0.0013, size: 1_850, ammBase: 412_500, ammFeePercent: 0.3, ammAccount: "rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3", ammSkew: 0.0009 },
  "mainnet:xrp-usdc": { mid: 0.5176, halfSpread: 0.0016, step: 0.0018, size: 1_240, ammBase: 268_900, ammFeePercent: 0.5, ammAccount: "rGHt6LT5v9DVaEAmFzj5ciuxuj41ZjLofs", ammSkew: -0.0012 },
  "mainnet:rlusd-usdc": { mid: 1.0001, halfSpread: 0.00008, step: 0.00006, size: 18_500, ammBase: 2_150_000, ammFeePercent: 0.05, ammAccount: "rLGkKMwShpdXsBtvShbJ6vtCKVB1g4AMpN", ammSkew: 0.00004 },
};

const SIZE_GROWTH = [1, 1.3, 2.1, 2.8, 4.1, 5.3, 7.8, 11.4];
const OFFERS = [3, 4, 6, 5, 8, 7, 11, 9];

function side(market: DemoMarket, direction: "bid" | "ask"): DepthLevel[] {
  let cumulative = 0;
  return SIZE_GROWTH.map((growth, index) => {
    const distance = market.halfSpread + market.step * index * (1 + index * 0.35);
    const price = direction === "ask" ? market.mid * (1 + distance) : market.mid * (1 - distance);
    const size = Math.round(market.size * growth * (direction === "bid" ? 1.08 : 1));
    cumulative += size;
    return { price, size, cumulative, offers: OFFERS[index] ?? 1 };
  });
}

function amm(market: DemoMarket): AmmSummary {
  const price = market.mid * (1 + market.ammSkew);
  const quoteReserve = market.ammBase * price;
  return {
    baseReserve: market.ammBase,
    quoteReserve,
    price,
    feePercent: market.ammFeePercent,
    lpSupply: Math.sqrt(market.ammBase * quoteReserve),
    tvlQuote: quoteReserve * 2,
    account: market.ammAccount,
  };
}

export function demoMarketSnapshots(): Record<string, PairSnapshot> {
  const entries = MARKET_CATALOG[DEMO_MARKET_NETWORK].flatMap((pair) => {
    const market = DEMO_MARKETS[pair.id];
    if (!market) return [];
    const bids = side(market, "bid");
    const asks = side(market, "ask");
    return [[pair.id, { bids, asks, book: bookSummary(bids, asks), amm: amm(market), ledgerIndex: FIXTURE_LEDGER_INDEX }] as const];
  });
  return Object.fromEntries(entries);
}
