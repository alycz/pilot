import React from "react";

import type { OwnerReviewPublicState } from "./x402-owner-review-client";

export type X402OwnerReviewViewProps = Readonly<{
  owner?: string;
  record?: OwnerReviewPublicState;
  busy: boolean;
  reviewReady: boolean;
  openPayment: boolean;
  notice?: string;
  error?: string;
  onPrepare(): void;
  onResumeReview(): void;
  onReject(): void;
  onRecover(): void;
}>;

/** Presentation-only shell. Wallet, recovery, signing, and relay state stay in the workspace controller. */
export function X402OwnerReviewView(props: X402OwnerReviewViewProps) {
  const { record } = props;
  return (
    <main className="min-h-[800px] bg-background px-4 py-8 text-foreground">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <header className="border-b border-border pb-4">
          <p className="label-mono text-primary">Ledger owner-reviewed x402</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold tracking-[-0.04em]">Review the actual payment—not a request digest.</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            This local-only lane fixes the merchant, Testnet, native XRP asset, and 5,000-drop price.
            Ledger signs the exact Payment; Harbor never receives the owner key and never relays twice.
          </p>
        </header>

        <p className="rounded-xl border border-warning/35 bg-warning/[0.06] px-4 py-3 text-xs font-semibold text-warning" role="note">
          Default off · local mock merchant and settlement adapters only · Speculos is simulation and does not attest a physical Ledger.
        </p>

        <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border text-sm sm:grid-cols-2">
          <div className="bg-card p-3"><dt className="label-mono text-muted-foreground">Merchant</dt><dd className="mt-1 break-all font-mono text-xs">rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr</dd></div>
          <div className="bg-card p-3"><dt className="label-mono text-muted-foreground">Exact payment</dt><dd className="mt-1 font-mono text-xs">0.005 XRP · Testnet</dd></div>
          <div className="bg-card p-3"><dt className="label-mono text-muted-foreground">Owner</dt><dd className="mt-1 break-all font-mono text-xs">{props.owner ?? "Wallet session required"}</dd></div>
          <div className="bg-card p-3"><dt className="label-mono text-muted-foreground">State</dt><dd className="mt-1 font-mono text-xs uppercase">{record?.status ?? "not prepared"}</dd></div>
        </dl>

        <div className="flex flex-wrap gap-2">
          <button className="min-h-11 rounded-md border border-primary bg-primary px-4 text-xs font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-45" disabled={props.busy || !props.owner || props.openPayment} onClick={props.onPrepare} type="button">{props.busy ? "Working…" : props.openPayment ? "Resolve saved payment first" : "Prepare exact Payment"}</button>
          {record?.status === "awaiting_approval" && !props.reviewReady ? <button className="min-h-11 rounded-md border border-primary bg-card px-4 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-45" disabled={props.busy} onClick={props.onResumeReview} type="button">Resume exact Ledger review</button> : null}
          {record?.status === "awaiting_approval" ? <button className="min-h-11 rounded-md border border-blocked/45 bg-card px-4 text-xs font-semibold text-blocked focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-45" disabled={props.busy} onClick={props.onReject} type="button">Reject offer</button> : null}
          {record && ["awaiting_approval", "relaying", "settlement_unknown", "settled", "delivering"].includes(record.status) ? <button className="min-h-11 rounded-md border border-border bg-card px-4 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-45" disabled={props.busy} onClick={props.onRecover} type="button">Reconcile same payment</button> : null}
        </div>

        {props.notice ? <p className="rounded-xl border border-executed/35 bg-executed/10 px-4 py-3 text-sm text-executed" role="status">{props.notice}</p> : null}
        {props.error ? <p className="rounded-xl border border-blocked/35 bg-blocked/10 px-4 py-3 text-sm text-blocked" role="alert">{props.error}</p> : null}
        {record?.receipt ? <section className="rounded-xl border border-executed/35 bg-card p-4" aria-label="Validated local simulation receipt"><h2 className="font-serif text-sm font-semibold">Validated local simulation receipt</h2><p className="mt-2 break-all font-mono text-xs">{record.receipt.tx_hash}</p><p className="mt-2 text-xs text-muted-foreground">Fixture ledger {record.receipt.validated_ledger_index} · {record.receipt.provenance}</p></section> : null}
      </div>
    </main>
  );
}
