import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import { StrategyWorkspace } from "@/components/strategy";

export const metadata: Metadata = {
  title: "Autonomous strategy",
  description: "Bounded declarative XRP and test-RLUSD strategies for XRPL Testnet test funds.",
};

export default function StrategyPage() {
  return <AppShell active="strategy" title="Autonomous strategy" eyebrow="XRPL Testnet · test funds" ownHeading><StrategyWorkspace /></AppShell>;
}
