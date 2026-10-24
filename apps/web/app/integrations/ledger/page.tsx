import type { Metadata } from "next";

import { ledgerExplainer } from "@/components/integrations/content";
import { IntegrationPage } from "@/components/integrations/integration-page";

export const metadata: Metadata = {
  title: "Ledger signing simulation — Workspace",
  description:
    "An interactive Speculos simulation of the workspace Ledger owner-signing boundary. Physical hardware is not required for this pitch.",
};

export default function LedgerIntegrationPage() {
  return <IntegrationPage explainer={ledgerExplainer} />;
}
