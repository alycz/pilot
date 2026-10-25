import type { Metadata } from "next";

import { MarketsView } from "@/components/markets";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  title: "Markets",
  description: "Order books, AMM pools and the best route for each XRP Ledger pair.",
};

export default function MarketsPage() {
  return (
    <AppShell active="markets" title="Markets" ownHeading>
      <MarketsView />
    </AppShell>
  );
}
