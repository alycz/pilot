import type { Metadata } from "next";

import { X402OwnerReviewWorkspace } from "@/components/chat/x402-owner-review-workspace";

export const metadata: Metadata = {
  title: "Ledger owner-reviewed x402",
  description: "Local-only native-XRP x402 payment review with an exact Ledger-signed Payment.",
};

export default function LedgerOwnerReviewedX402Page() {
  return <X402OwnerReviewWorkspace />;
}
