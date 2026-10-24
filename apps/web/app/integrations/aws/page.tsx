import type { Metadata } from "next";

import { awsIntegration } from "@/components/integrations/content";
import { IntegrationPage } from "@/components/integrations/integration-page";

export const metadata: Metadata = {
  title: "AWS trust layer — Workspace",
  description:
    "An interactive architecture simulation of Guardrails screening, optional Bedrock models, KMS-backed delegate signing, and Harbor policy boundaries.",
};

export default function AwsIntegrationPage() {
  return <IntegrationPage explainer={awsIntegration} />;
}
