import { z } from "zod";

import {
  fetchHyperliquidMarkets,
  parseHyperliquidMarkets,
} from "../adapters/hyperliquid";
import type { OpDef } from "../catalog/registry";

type HyperliquidMarketsReader = () => Promise<unknown>;

export const ops: OpDef[] = [
  {
    name: "perps.markets",
    family: "perps",
    summary:
      "Read the XRP perpetual market on Hyperliquid; trading and order management are unavailable.",
    tags: ["perps", "xrp", "hyperliquid", "read-only", "market-data"],
    args: z.object({}).strict(),
    returns:
      "read-only Hyperliquid XRP market metadata, mark/oracle prices, funding, open interest, and 24-hour volume",
    caveats: ["off-ledger"],
    example: "await harbor.perps.markets({})",
    handler: async (ctx) => {
      const injectedReader = ctx.hyperliquidMarkets;
      const readMarkets =
        typeof injectedReader === "function"
          ? (injectedReader as HyperliquidMarketsReader)
          : fetchHyperliquidMarkets;
      const markets = parseHyperliquidMarkets(await readMarkets());
      const xrpMarket = markets.find(
        ({ coin }) => coin.toUpperCase() === "XRP",
      );

      if (!xrpMarket) {
        throw new Error("Hyperliquid XRP perpetual market is unavailable");
      }

      return {
        venue: "hyperliquid",
        venueId: "hyperliquid-xrp-perps",
        readOnly: true as const,
        executionAvailable: false as const,
        markets: [xrpMarket],
      };
    },
  },
];
