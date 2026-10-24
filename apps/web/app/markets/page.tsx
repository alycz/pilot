import type { Metadata } from "next";

import { AnalyticsView } from "@/components/markets";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  title: "XRPL Market Analytics",
  description: "Source-labelled XRPL order-book, AMM and executable-liquidity analytics through Harbor.",
};

export default function MarketsPage() {
  return (
    <AppShell active="markets" eyebrow="XRP Ledger" title="Market Analytics" ownHeading>
      <AnalyticsView />
    </AppShell>
  );
}
