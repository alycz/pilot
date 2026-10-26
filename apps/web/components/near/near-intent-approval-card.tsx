"use client";

import { FileKey2, ShieldCheck } from "lucide-react";
import React from "react";

import type { NearApprovalReview } from "@/lib/near-approval";
import { DetailGrid } from "../cards/card-frame";

export type NearIntentApprovalCardProps = Readonly<{
  review: NearApprovalReview;
  provenance?: "live" | "fixture";
  busy?: boolean;
  onApprove?: () => void;
}>;

function statusLabel(review: NearApprovalReview): string {
  switch (review.readiness) {
    case "ready": return "Ready to sign";
    case "signing-disabled": return "Review only";
    case "digest-mismatch": return "Digest mismatch";
    case "approval-expired": return "Approval expired";
    case "provider-refund-window-started": return "Reconciliation required";
    case "invalid": return "Not executable";
  }
}

function badgeStyle(review: NearApprovalReview): string {
  if (review.canSign) {
    return "border-approval/40 bg-approval/10 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]";
  }
  if (review.readiness === "signing-disabled") {
    return "border-border-strong bg-white/[0.03] text-muted-foreground";
  }
  return "border-destructive/40 bg-destructive/10 text-[color-mix(in_oklab,var(--destructive)_80%,var(--foreground))]";
}

/**
 * Presentational NEAR Intents review card. It mirrors Pilot's existing card
 * frame and never connects, signs, deposits, submits, or upgrades a dry quote.
 */
export function NearIntentApprovalCard({
  review,
  provenance = "live",
  busy = false,
  onApprove,
}: NearIntentApprovalCardProps) {
  const blocked = !review.canSign || !onApprove;
  return (
    <article
      data-near-approval-state={review.readiness}
      aria-label="NEAR Intents exact approval"
      className="min-w-0 overflow-hidden border border-approval/35 bg-card rounded-xl"
    >
      <div className="flex min-w-0 items-start gap-3 p-4">
        <span className="grid h-8 w-8 shrink-0 place-items-center border border-approval/35 bg-white/[0.02] text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] rounded-md">
          <FileKey2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium tracking-tight">Owner approval required</h3>
          <p className="mt-0.5 text-balance break-words text-xs leading-relaxed text-muted-foreground">
            {provenance === "fixture"
              ? "Inspect an executable-shaped fixture. No provider signature, deposit, or wallet action occurred."
              : "Review this exact verified NEAR Intents quote before opening your wallet."}
          </p>
          <span className={`mt-2 inline-block border px-1.5 py-0.5 text-xs font-medium rounded ${badgeStyle(review)}`}>
            {statusLabel(review)}
          </span>
          <p role="status" className="mt-3 break-words text-xs leading-5 text-foreground/90">
            {review.notice}
          </p>
        </div>
      </div>

      <div className="border-t border-border px-4 py-3.5">
        {review.rows.length > 0 ? (
          <DetailGrid items={review.rows.map((row) => ({
            label: provenance === "fixture"
              ? row.label.replace("Verified quote", "Fixture quote")
              : row.label,
            value: row.value,
            mono: row.exact,
          }))} />
        ) : null}

        {review.approvalDigest ? (
          <div className="mt-3 border border-approval/30 bg-approval/[0.06] px-3 py-2 text-[11px] leading-4 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] rounded-xl">
            <p className="flex items-center gap-2 font-medium">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {provenance === "fixture" ? "Principal-bound fixture digest" : "Principal-bound approval digest"}
            </p>
            <p className="mt-1 break-all font-mono">{review.approvalDigest}</p>
            <p className="mt-2 text-muted-foreground">
              The digest commits to the displayed principal. Server wallet-session policy separately verifies that principal against the connected wallet account.
            </p>
          </div>
        ) : null}

        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          The provider deposit memo is routing metadata only. It is not an XRP destination tag, and this card does not submit a deposit.
        </p>
      </div>

      <div className="border-t border-border bg-white/[0.015] px-4 py-3">
        <button
          type="button"
          disabled={blocked || busy}
          onClick={onApprove}
          className="inline-flex h-9 items-center gap-1.5 border border-primary bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md"
        >
          <FileKey2 className="h-3.5 w-3.5" aria-hidden="true" />
          {busy ? "Waiting for wallet…" : review.canSign ? "Review & sign" : "NEAR execution disabled"}
        </button>
      </div>
    </article>
  );
}

