import type { Metadata } from "next";

import { mastercardIntegration } from "@/components/integrations/content";
import { IntegrationPage } from "@/components/integrations/integration-page";

export const metadata: Metadata = {
  title: "Mastercard AP4M integration — Workspace",
  description:
    "An interactive, mock-first explanation of the workspace's bounded agent-commerce flow using AP4M patterns and XRPL Testnet rails.",
};

export default function MastercardIntegrationPage() {
  return <IntegrationPage explainer={mastercardIntegration} />;
}
