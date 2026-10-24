import type { Metadata } from "next";

import { MemoryWorkspace } from "@/components/memory";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  title: "Memory",
  description: "Review workspace vault notes, knowledge graph, and execution policy.",
};

export default function MemoryPage() {
  return (
    <AppShell active="memory" eyebrow="Vault & guardrails" title="Memory" ownHeading>
      <MemoryWorkspace />
    </AppShell>
  );
}
