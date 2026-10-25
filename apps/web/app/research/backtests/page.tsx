import type { Metadata } from "next";

import { BacktestsClient } from "@/components/backtests/integration/client";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  title: "Backtests",
  description: "A deterministic, reproducible investing-strategy backtest workspace with explicit source, cost, and evaluation boundaries.",
};

export default function BacktestsPage() {
  return (
    <AppShell active="backtests" title="Backtests" eyebrow="Research only" ownHeading>
      <BacktestsClient />
    </AppShell>
  );
}
