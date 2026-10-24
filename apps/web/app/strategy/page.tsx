import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import { StrategyWorkspace } from "@/components/strategy";

export const metadata: Metadata = {
  title: "Autonomous strategy",
  description: "A deterministic, bounded XRP and test-RLUSD rebalancer for XRPL Testnet test funds.",
};

export default function StrategyPage() {
  return <AppShell active="strategy" title="Autonomous strategy" eyebrow="XRPL Testnet · test funds" ownHeading><StrategyWorkspace /></AppShell>;
}
