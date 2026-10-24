import { CheckCircle2 } from "lucide-react";
import React from "react";

import type { MandateDraft, MandatePayeeOption } from "./types";

export function MandateSummary({
  draft,
  mandateId,
  payees,
  setupTransactionHashes,
}: {
  draft: MandateDraft;
  mandateId: string;
  payees: readonly MandatePayeeOption[];
  setupTransactionHashes: readonly string[];
}) {
  return (
    <section aria-label="Active AP4M mandate" className="border border-emerald-300 bg-emerald-50 p-5 text-slate-950 rounded-xl overflow-hidden">
      <div className="flex items-start gap-3"><CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 text-emerald-700" /><div><p className="text-[13px] font-bold text-emerald-800">ACTIVE · XRPL Testnet</p><h3 className="mt-1 text-lg font-semibold">Agent mandate registered</h3></div></div>
      <p className="mt-3 break-all font-mono text-xs text-slate-600">{mandateId}</p>
      <p className="mt-3 text-sm text-slate-700">Up to ${draft.perPaymentMaxUsd} per payment, ${draft.dailyMaxUsd} per day, and ${draft.totalMaxUsd} total for {payees.filter((payee) => draft.payees.includes(payee.id)).map((payee) => payee.name).join(", ")}.</p>
      <p className="mt-2 text-xs text-slate-600">{setupTransactionHashes.length} validated setup transaction{setupTransactionHashes.length === 1 ? "" : "s"} recorded. Raw Verifiable Intent credentials and private keys are not stored here.</p>
      <div className="mt-4 space-y-1 text-[11px] text-slate-600"><p>Demo Network — Mastercard&apos;s role in production</p><p>Verifiable Intent v0.1 · verified with Mastercard&apos;s reference implementation</p></div>
    </section>
  );
}
