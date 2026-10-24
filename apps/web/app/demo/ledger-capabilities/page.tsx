import type { Metadata } from "next";

import { LedgerCapabilityWorkspace } from "@/components/capabilities/ledger-capability-workspace";

export const metadata: Metadata = {
  title: "Ledger capability broker | Pilot",
  description: "A local-only Ledger owner-reviewed mock capability lifecycle.",
};

export default function LedgerCapabilityPage() {
  return <LedgerCapabilityWorkspace />;
}
