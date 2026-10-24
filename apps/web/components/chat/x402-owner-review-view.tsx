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
    <main className="min-h-[800px] bg-[#f3f1ea] px-4 py-8 text-[#171814]">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <header className="border-b border-slate-400 pb-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#235a52]">Ledger owner-reviewed x402</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">Review the actual payment—not a request digest.</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">
            This local-only lane fixes the merchant, Testnet, native XRP asset, and 5,000-drop price.
            Ledger signs the exact Payment; Harbor never receives the owner key and never relays twice.
          </p>
        </header>

        <p className="border border-amber-700/40 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-950" role="note">
          Default off · local mock merchant and settlement adapters only · Speculos is simulation and does not attest a physical Ledger.
        </p>

        <dl className="grid gap-px border border-slate-300 bg-slate-300 text-sm sm:grid-cols-2">
          <div className="bg-white p-3"><dt className="text-xs font-semibold text-slate-600">Merchant</dt><dd className="mt-1 break-all font-mono text-xs">rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr</dd></div>
          <div className="bg-white p-3"><dt className="text-xs font-semibold text-slate-600">Exact payment</dt><dd className="mt-1 font-mono text-xs">0.005 XRP · Testnet</dd></div>
          <div className="bg-white p-3"><dt className="text-xs font-semibold text-slate-600">Owner</dt><dd className="mt-1 break-all font-mono text-xs">{props.owner ?? "Wallet session required"}</dd></div>
          <div className="bg-white p-3"><dt className="text-xs font-semibold text-slate-600">State</dt><dd className="mt-1 font-mono text-xs uppercase">{record?.status ?? "not prepared"}</dd></div>
        </dl>

        <div className="flex flex-wrap gap-2">
          <button className="border border-[#235a52] bg-[#235a52] px-4 py-2 text-xs font-semibold text-white disabled:opacity-45" disabled={props.busy || !props.owner || props.openPayment} onClick={props.onPrepare} type="button">{props.busy ? "Working…" : props.openPayment ? "Resolve saved payment first" : "Prepare exact Payment"}</button>
          {record?.status === "awaiting_approval" && !props.reviewReady ? <button className="border border-[#235a52] bg-white px-4 py-2 text-xs font-semibold disabled:opacity-45" disabled={props.busy} onClick={props.onResumeReview} type="button">Resume exact Ledger review</button> : null}
          {record?.status === "awaiting_approval" ? <button className="border border-slate-500 bg-white px-4 py-2 text-xs font-semibold disabled:opacity-45" disabled={props.busy} onClick={props.onReject} type="button">Reject offer</button> : null}
          {record && ["awaiting_approval", "relaying", "settlement_unknown", "settled", "delivering"].includes(record.status) ? <button className="border border-slate-500 bg-white px-4 py-2 text-xs font-semibold disabled:opacity-45" disabled={props.busy} onClick={props.onRecover} type="button">Reconcile same payment</button> : null}
        </div>

        {props.notice ? <p className="border border-emerald-700/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-950" role="status">{props.notice}</p> : null}
        {props.error ? <p className="border border-red-700/30 bg-red-50 px-4 py-3 text-sm text-red-950" role="alert">{props.error}</p> : null}
        {record?.receipt ? <section className="border border-emerald-700/30 bg-white p-4" aria-label="Validated local simulation receipt"><h2 className="text-sm font-semibold">Validated local simulation receipt</h2><p className="mt-2 break-all font-mono text-xs">{record.receipt.tx_hash}</p><p className="mt-2 text-xs text-slate-600">Fixture ledger {record.receipt.validated_ledger_index} · {record.receipt.provenance}</p></section> : null}
      </div>
    </main>
  );
}
