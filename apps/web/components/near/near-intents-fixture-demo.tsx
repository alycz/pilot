"use client";

import { ArrowLeft, ArrowRight, CircleCheck, FlaskConical } from "lucide-react";
import React, { useState } from "react";

import type { NearApprovalReview } from "@/lib/near-approval";
import { NearIntentApprovalCard } from "./near-intent-approval-card";

const stages = ["Discovery", "Dry quote", "Approval", "Status"] as const;

export function NearIntentsFixtureDemo({ review }: { review: NearApprovalReview }) {
  const [step, setStep] = useState(0);
  const next = Math.min(step + 1, stages.length - 1);
  const previous = Math.max(step - 1, 0);

  return (
    <section aria-labelledby="near-fixture-title" className="overflow-hidden border border-border bg-card rounded-xl">
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center border border-primary/30 bg-primary-soft text-primary rounded-md">
            <FlaskConical className="size-4" aria-hidden="true" />
          </span>
          <div>
            <p className="label-mono">Local fixture · no provider calls</p>
            <h2 id="near-fixture-title" className="mt-1 text-sm font-medium tracking-tight">NEAR Intents review path</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Walk through Pilot&apos;s bounded discovery and approval states without enabling settlement.</p>
          </div>
        </div>
      </header>

      <ol className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-4" aria-label="Fixture steps">
        {stages.map((label, index) => (
          <li key={label} className={`bg-card px-3 py-3 text-xs ${index === step ? "text-foreground" : "text-muted-foreground"}`} aria-current={index === step ? "step" : undefined}>
            <span className="font-mono text-[10px]">0{index + 1}</span>
            <span className="mt-0.5 block">{label}</span>
          </li>
        ))}
      </ol>

      <div className="p-4 sm:p-5">
        {step === 0 ? <FixturePanel title="Supported-asset discovery fixture" status="Schema-valid fixture, not current provider inventory" rows={[
          ["Input asset ID", "nep141:wrap.near"],
          ["Output asset ID", "nep141:usdt.tether-token.near"],
          ["Execution", "Disabled"],
        ]} /> : null}
        {step === 1 ? <FixturePanel title="Dry exact-input quote fixture" status="Preview only · cannot be approved or funded" rows={[
          ["Input atomic amount", "1000000000000000000000000"],
          ["Minimum output atomic amount", "990000"],
          ["Provider signature", "Not verified · fixture"],
        ]} /> : null}
        {step === 2 ? <NearIntentApprovalCard review={review} provenance="fixture" /> : null}
        {step === 3 ? <FixturePanel title="Truthful status fixture" status="Pending · no settlement evidence" rows={[
          ["Tracking source", "Local fixture only"],
          ["Transaction hashes", "None"],
          ["Destination validation", "Not performed"],
        ]} /> : null}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-border bg-white/[0.015] px-4 py-3 sm:px-5">
        <button type="button" disabled={step === 0} onClick={() => setStep(previous)} className="inline-flex h-9 items-center gap-1.5 border border-border px-3 text-[13px] transition hover:bg-white/[0.05] disabled:opacity-40 pointer-coarse:h-11 rounded-md">
          <ArrowLeft className="size-3.5" aria-hidden="true" /> Back
        </button>
        <button type="button" disabled={step === stages.length - 1} onClick={() => setStep(next)} className="inline-flex h-9 items-center gap-1.5 bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40 pointer-coarse:h-11 rounded-md">
          {step === stages.length - 1 ? "Execution remains disabled" : `Next: ${stages[next]}`}
          {step < stages.length - 1 ? <ArrowRight className="size-3.5" aria-hidden="true" /> : null}
        </button>
      </footer>
    </section>
  );
}

function FixturePanel({ title, status, rows }: { title: string; status: string; rows: readonly (readonly [string, string])[] }) {
  return (
    <div className="overflow-hidden border border-border bg-background/50 rounded-xl">
      <div className="flex items-start gap-3 p-4">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div><h3 className="text-sm font-medium">{title}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{status}</p></div>
      </div>
      <dl className="grid gap-px border-t border-border bg-border sm:grid-cols-3">
        {rows.map(([label, value]) => <div key={label} className="min-w-0 bg-card px-3.5 py-3"><dt className="label-mono">{label}</dt><dd className="mt-1 break-all font-mono text-xs text-foreground">{value}</dd></div>)}
      </dl>
    </div>
  );
}
