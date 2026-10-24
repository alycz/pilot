import type { Metadata } from "next";

import { LandingPage } from "@/components/landing";
import { AwsTrustSection } from "@/components/landing/aws-trust-section";
import { LedgerApprovalSection } from "@/components/landing/ledger-approval-section";
import { SimulatedDevice } from "@/components/ledger/simulated-device";
import trustSetTranscript from "@/components/ledger/transcripts/trust-set.json";

export const metadata: Metadata = {
  title: { absolute: "XRPL agent infrastructure and trading workspace" },
  description:
    "An execution service provides XRPL market data and controlled transactions to this AI trading workspace.",
};

export default function HomePage() {
  return (
    <LandingPage integrations={<><AwsTrustSection /><LedgerApprovalSection trustSetDevicePreview={<SimulatedDevice transcript={trustSetTranscript} />} /></>} />
  );
}
