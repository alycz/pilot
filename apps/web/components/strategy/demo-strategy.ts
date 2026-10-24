import type { StrategyPlanSummary } from "@/components/chat/strategy-proposal";

/** Local, scripted strategies for the signed-out chat. Nothing here touches a network. */
export type DemoStrategyKind = "rebalance" | "recurring" | "price";

export type DemoStrategyPlan = StrategyPlanSummary & {
  kind: DemoStrategyKind;
  preview: string;
  intervalLabel: string;
  dailyCap: number;
};

export type DemoTrade = { id: string; at: string; summary: string; hash: string };

export const DEMO_STRATEGY_PROMPTS = {
  rebalance: "Keep me at 50% XRP and rebalance if it drifts 5%",
  recurring: "Buy 25 RLUSD of XRP every day",
  price: "Sell 50 XRP if the price reaches 0.80",
} as const;

export function classifyDemoStrategy(prompt: string): DemoStrategyKind {
  const text = prompt.toLowerCase();
  if (/\b(if|when|once)\b.*\b(reach|reaches|hits|drops to|falls to|rises to|price)\b|price trigger/.test(text)) return "price";
  if (/\b(every|daily|weekly|hourly|each|recurring|dca|schedule)\b/.test(text)) return "recurring";
  return "rebalance";
}

export function demoStrategyPlan(kind: DemoStrategyKind): DemoStrategyPlan {
  const ends = "In 7 days";
  if (kind === "recurring") {
    return {
      kind,
      title: "Recurring buy",
      rules: ["Buy 25 RLUSD of XRP once a day.", "Skip a day if the quote is older than 20 seconds or the fee is above 20 drops."],
      facts: [
        { label: "Checks", value: "Every day" },
        { label: "Per trade", value: "25 RLUSD" },
        { label: "Per day", value: "25 RLUSD · 1 trade" },
        { label: "Ends", value: ends },
      ],
      preview: "If it ran now, it would buy 25 RLUSD of XRP at 0.512.",
      intervalLabel: "day",
      dailyCap: 25,
    };
  }
  if (kind === "price") {
    return {
      kind,
      title: "Price trigger",
      rules: ["Sell 50 XRP once the bid is at or above 0.80 RLUSD.", "Run once, then stop."],
      facts: [
        { label: "Checks", value: "Every 5 min" },
        { label: "Per trade", value: "Up to 40 RLUSD" },
        { label: "Per day", value: "40 RLUSD · 1 trade" },
        { label: "Ends", value: ends },
      ],
      preview: "If it ran now, it would hold. The bid is 0.512, below 0.80.",
      intervalLabel: "5 min",
      dailyCap: 40,
    };
  }
  return {
    kind,
    title: "Rebalance XRP and RLUSD",
    rules: ["Keep XRP between 45% and 55% of the portfolio, trading back to 50%.", "Hold while it stays inside the band."],
    facts: [
      { label: "Checks", value: "Every 5 min" },
      { label: "Per trade", value: "Up to 25 RLUSD" },
      { label: "Per day", value: "60 RLUSD · 6 trades" },
      { label: "Ends", value: ends },
    ],
    preview: "If it ran now, it would hold. XRP is at 50.2%, inside the band.",
    intervalLabel: "5 min",
    dailyCap: 60,
  };
}

/** Which ticks of a running demo produce a trade, and what it says. */
export function demoTradeForTick(kind: DemoStrategyKind, tick: number, seed: number): DemoTrade | undefined {
  const scripted: Record<DemoStrategyKind, Record<number, string>> = {
    rebalance: {
      2: "Sold 18.40 RLUSD of XRP · XRP was at 57.1%, now 50.4%",
      5: "Bought 14.75 RLUSD of XRP · XRP was at 43.6%, now 49.8%",
    },
    recurring: {
      1: "Bought 25 RLUSD of XRP at 0.512",
    },
    price: {
      3: "Sold 50 XRP at 0.801 for 40.05 RLUSD",
    },
  };
  const summary = scripted[kind][tick];
  if (!summary) return undefined;
  return { id: `demo-trade-${seed}-${tick}`, at: new Date().toISOString(), summary, hash: demoHash(seed * 31 + tick) };
}

export function demoHoldForTick(kind: DemoStrategyKind, tick: number): string {
  if (kind === "price") return tick > 3 ? "Done. The trigger already fired." : "Held. The bid is below 0.80.";
  if (kind === "recurring") return tick > 1 ? "Held. Today's buy is done." : "Held. Waiting for today's slot.";
  return "Held. XRP is inside the 45–55% band.";
}

function demoHash(seed: number): string {
  let value = Math.imul(seed + 1, 2654435761) >>> 0;
  let hash = "";
  for (let index = 0; index < 64; index += 1) {
    value = (Math.imul(value, 1103515245) + 12345) >>> 0;
    hash += "0123456789ABCDEF"[(value >>> 16) % 16];
  }
  return hash;
}
