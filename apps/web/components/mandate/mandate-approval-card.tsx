"use client";

import { Check, ShieldCheck } from "lucide-react";
import React from "react";

import type { MandateChannelPreview, MandateDraft, MandatePayeeOption } from "./types";

export type MandateApprovalCardProps = {
  channels: readonly MandateChannelPreview[];
  disabled?: boolean;
  draft: MandateDraft;
  onApprove: () => void;
  onBack?: () => void;
  payees: readonly MandatePayeeOption[];
  promptCount: number;
  signingMode: "batch" | "sequential";
};

export function MandateApprovalCard({
  channels,
  disabled = false,
  draft,
  onApprove,
  onBack,
  payees,
  promptCount,
  signingMode,
}: MandateApprovalCardProps) {
  const selectedPayees = payees.filter((payee) => draft.payees.includes(payee.id));
  const expiry = new Date(draft.expiresAt);
  const approvalLabel = signingMode === "batch"
    ? "Approve once in wallet"
    : `Approve ${promptCount} transactions in wallet`;

  return (
    <article aria-labelledby="mandate-approval-title" className="border-2 border-sky-700 bg-slate-50 text-slate-950 rounded-xl overflow-hidden">
      <header className="border-b border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[13px] font-bold text-sky-700">XRPL Testnet · one mandate approval</p>
            <h3 className="mt-1 text-xl font-semibold" id="mandate-approval-title">Authorize once, transact within limits</h3>
          </div>
          <ShieldCheck aria-hidden="true" className="size-7 text-sky-700" />
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          The agent can never exceed these limits. It cannot add merchants, increase budgets, or extend the expiry.
        </p>
      </header>

      <div className="grid gap-px bg-slate-200 sm:grid-cols-2">
        <Limit label="Per payment" value={`$${draft.perPaymentMaxUsd}`} />
        <Limit label="Daily maximum" value={`$${draft.dailyMaxUsd}`} />
        <Limit label="Total maximum" value={`$${draft.totalMaxUsd}`} />
        <Limit label="Expires" value={Number.isNaN(expiry.getTime()) ? draft.expiresAt : expiry.toLocaleString()} />
      </div>

      <section className="border-t border-slate-200 bg-white p-5" aria-labelledby="allowed-payees-title">
        <h4 className="text-sm font-semibold" id="allowed-payees-title">Allowed merchants only</h4>
        <ul className="mt-2 space-y-2">
          {selectedPayees.map((payee) => (
            <li className="flex items-center gap-2 text-sm" key={payee.id}><Check aria-hidden="true" className="size-4 text-emerald-700" />{payee.name}</li>
          ))}
        </ul>
      </section>

      <section className="border-t border-slate-200 bg-white p-5" aria-labelledby="channel-locks-title">
        <h4 className="text-sm font-semibold" id="channel-locks-title">Merchant channel locks</h4>
        <p className="mt-1 text-xs leading-5 text-slate-500">Channel collateral stays locked for merchants until mandate expiry plus one day.</p>
        <ul className="mt-3 space-y-2">
          {channels.map((channel) => (
            <li className="border border-slate-200 p-3 text-sm rounded-xl" key={channel.merchantId}>
              <span className="font-medium">{channel.merchantName}</span>
              <span className="mt-1 block font-mono text-xs text-slate-600">{channel.amountDrops} drops · locked until {new Date(channel.lockedUntil).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="border-t border-slate-200 bg-white p-5">
        <p className="text-xs leading-5 text-slate-600">
          {signingMode === "batch"
            ? "Your wallet supports XRPL Batch: one sign-only prompt covers the full setup."
            : `This wallet does not support Batch. Sequential mode is selected before signing and requires ${promptCount} sign-only prompts. Pilot will stop on cancellation or an uncertain result and will not retry automatically.`}
        </p>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          {onBack ? <button className="border border-slate-300 px-4 py-3 text-sm font-semibold rounded-md" disabled={disabled} onClick={onBack} type="button">Back</button> : <span />}
          <button className="bg-sky-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50" disabled={disabled} onClick={onApprove} type="button">{approvalLabel}</button>
        </div>
      </footer>
    </article>
  );
}

function Limit({ label, value }: { label: string; value: string }) {
  return <div className="bg-white p-4"><p className="text-xs font-bold text-slate-500">{label}</p><p className="mt-1 font-mono text-sm font-semibold">{value}</p></div>;
}
