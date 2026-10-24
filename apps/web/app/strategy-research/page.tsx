import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import { StrategyResearchWorkbench } from "@/components/strategy-research";

export const metadata: Metadata = {
  title: "Strategy research",
  description: "A bounded, reproducible strategy and route research workbench with explicit data-availability gates.",
};

export default function StrategyResearchPage() {
  return (
    <AppShell active="strategy-research" title="Strategy research" eyebrow="Simulation only" ownHeading>
      <StrategyResearchWorkbench />
    </AppShell>
  );
}
