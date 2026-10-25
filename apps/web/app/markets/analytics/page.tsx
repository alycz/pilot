import type { Metadata } from "next";

import { AnalyticsView } from "@/components/markets";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  title: "XRPL Market Analytics",
  description: "Source-labelled XRPL order-book, AMM and executable-liquidity analytics through Harbor.",
};

/** The analytics terminal moved here so /markets keeps the approved market list. */
export default function MarketAnalyticsPage() {
  return (
    <AppShell active="markets" title="Markets" ownHeading>
      <AnalyticsView />
    </AppShell>
  );
}
