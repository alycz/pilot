import type { Metadata } from "next";

import { HostedSpeculosCompanion } from "@/components/ledger/hosted-speculos-companion";

export const metadata: Metadata = {
  title: "Hosted Ledger companion demo",
  description: "A default-off, Testnet-only software-emulator signing companion demo.",
};

export default function HostedLedgerCompanionPage() {
  return <HostedSpeculosCompanion />;
}
