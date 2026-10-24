import type { Metadata } from "next";

import { MarketsView } from "@/components/markets";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  title: "Markets",
  description: "Live XRPL order books, AMM pools and route quotes, read in your browser.",
};

export default function MarketsPage() {
  return (
    <AppShell active="markets" eyebrow="XRP Ledger" title="Markets" ownHeading>
      <MarketsView />
    </AppShell>
  );
}
