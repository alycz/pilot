import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { MarketsView } from "@/components/markets";
import { MARKET_CATALOG } from "@/components/markets/markets-catalog";
import { AppShell } from "@/components/shell";

type Params = Promise<{ market: string }>;
type Search = Promise<{ network?: string; route?: string }>;

/** `/markets/xrp-rlusd?network=mainnet&route=amm` → `mainnet:xrp-rlusd:amm`. */
function marketKey(slug: string, network: string | undefined, route: string | undefined): { key: string; label: string } | null {
  const networks: readonly ("mainnet" | "testnet")[] = network === "testnet" || network === "mainnet" ? [network] : ["mainnet", "testnet"];
  for (const option of networks) {
    const pair = MARKET_CATALOG[option].find((candidate) => candidate.id === `${option}:${slug}`);
    if (pair) return { key: `${pair.id}:${route === "amm" ? "amm" : "order-book"}`, label: pair.label };
  }
  return null;
}

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: Search }): Promise<Metadata> {
  const { market } = await params;
  const { network, route } = await searchParams;
  const resolved = marketKey(market, network, route);
  return { title: resolved ? `${resolved.label} · Markets` : "Markets" };
}

export default async function MarketPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { market } = await params;
  const { network, route } = await searchParams;
  const resolved = marketKey(market, network, route);
  if (!resolved) notFound();
  return (
    <AppShell active="markets" eyebrow="XRP Ledger" title={resolved.label} ownHeading>
      <MarketsView key={resolved.key} marketKey={resolved.key} />
    </AppShell>
  );
}
