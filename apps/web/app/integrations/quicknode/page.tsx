import type { Metadata } from "next";

import { quickNodeExplainer } from "@/components/integrations/content";
import { IntegrationPage } from "@/components/integrations/integration-page";

export const metadata: Metadata = {
  title: "QuickNode integration — Workspace",
  description:
    "An interactive mock walkthrough of the workspace QuickNode transport, confirmation, fallback, watchdog, and on-ledger revocation boundaries.",
};

export default function QuickNodeIntegrationPage() {
  return <IntegrationPage explainer={quickNodeExplainer} />;
}
