import type { Metadata } from "next";

import { LivePortfolioDashboard } from "@/components/portfolio";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  title: "Portfolio",
  description: "Balances, positions, delegated budget, and XRPL activity.",
};

export default function PortfolioPage() {
  return (
    <AppShell active="portfolio" title="Portfolio" eyebrow="Budget account">
      <LivePortfolioDashboard />
    </AppShell>
  );
}
