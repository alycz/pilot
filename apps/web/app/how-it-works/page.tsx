import type { Metadata } from "next";

import { ArchitectureExplainer } from "@/components/harness-explainer";

export const metadata: Metadata = {
  title: "How the workspace works",
  description:
    "An interactive tour of workspace personalization, policy enforcement, XRPL execution, and reviewed learning.",
};

export default function HowItWorksPage() {
  return <ArchitectureExplainer />;
}
