"use client";

import { AlertTriangle, FlaskConical, Plus, Trash2 } from "lucide-react";
import React from "react";

import {
  MAX_DECLARATIVE_RULES,
  describeRule,
  newDeclarativeRule,
  previewDeclarativePlan,
  validateDeclarativePlan,
  type DeclarativePlanDraft,
  type DeclarativeRuleDraft,
  type PaperInputs,
} from "./declarative-model";

export function DeclarativePlanEditor({ plan, paperInputs, disabled, onChange, onPaperInputsChange }: {
  plan: DeclarativePlanDraft;
  paperInputs: PaperInputs;
  disabled?: boolean;
  onChange: (plan: DeclarativePlanDraft) => void;
  onPaperInputsChange: (inputs: PaperInputs) => void;
}) {
  const diagnostics = validateDeclarativePlan(plan);
  const preview = previewDeclarativePlan(plan, paperInputs);
  const updateRule = (index: number, patch: Partial<DeclarativeRuleDraft>) => onChange({
    ...plan,
    rules: plan.rules.map((rule, position) => position === index ? { ...rule, ...patch } : rule),
  });

  return <div className="space-y-6">
    <section aria-labelledby="supported-primitives-title" className="border border-primary/25 bg-primary/[0.045] p-4">
      <p className="label-mono text-primary">Reviewed primitive registry · v1</p>
      <h3 id="supported-primitives-title" className="mt-1 text-sm font-medium">What this engine can express</h3>
      <ul className="mt-3 grid gap-2 text-xs leading-5 text-muted-foreground sm:grid-cols-2">
        <li>• Scheduled fixed-value XRP buys (DCA).</li>
        <li>• Buy at or below an executable ask.</li>
        <li>• Sell at or above an executable bid.</li>
        <li>• XRP allocation-band rebalancing.</li>
      </ul>
      <p className="mt-3 border-l-2 border-approval/45 pl-3 text-xs leading-5 text-muted-foreground">Unsupported assets, issuers, venues, URLs, scripts, transfers, recursive rules, external data, arbitrary model code, and more than {MAX_DECLARATIVE_RULES} rules are rejected. Rules are checked in order; only the first match may plan one fill-or-kill order per evaluation.</p>
    </section>

    <fieldset className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <legend className="label-mono mb-3 w-full border-b border-border pb-2">Schedule &amp; lifetime counters</legend>
      <Text label="Evaluation interval" value={plan.intervalSeconds} suffix="seconds" disabled={disabled} onChange={(value) => onChange({ ...plan, intervalSeconds: value })} />
      <Text label="Maximum daily trades" value={plan.maxDailyTrades} suffix="orders" disabled={disabled} onChange={(value) => onChange({ ...plan, maxDailyTrades: value })} />
      <Text label="Maximum total trades" value={plan.maxTotalTrades} suffix="orders" disabled={disabled} onChange={(value) => onChange({ ...plan, maxTotalTrades: value })} />
      <Text label="Maximum actions for this mandate" value={plan.maxMandateOccurrences} suffix="actions" disabled={disabled} onChange={(value) => onChange({ ...plan, maxMandateOccurrences: value })} />
      <Text label="Cumulative value cap" value={plan.maxCumulativeValue} suffix="test-RLUSD" disabled={disabled} onChange={(value) => onChange({ ...plan, maxCumulativeValue: value })} />
      <Text label="Daily fee cap" value={plan.maxDailyFeeDrops} suffix="drops" disabled={disabled} onChange={(value) => onChange({ ...plan, maxDailyFeeDrops: value })} />
      <Text label="Cumulative fee cap" value={plan.maxCumulativeFeeDrops} suffix="drops" disabled={disabled} onChange={(value) => onChange({ ...plan, maxCumulativeFeeDrops: value })} />
      <p className="sm:col-span-2 xl:col-span-3 text-xs leading-5 text-muted-foreground">Daily counters use UTC days. Maximum actions for this mandate counts reserved, committed, and outcome-unknown trade actions attributed to this immutable mandate; retrying the same decision does not count twice. It is separate from the owner/Testnet/exact-asset lifetime total-trades counter. Neither counter invents reset behavior. An older approved mandate may not record this field; the explicit value shown while editing applies only after fresh approval and never reinterprets that old mandate.</p>
      <p className="sm:col-span-2 xl:col-span-3 text-xs leading-5 text-muted-foreground">Lifetime cumulative value, fees, and trade count bind the exact owner, Testnet, and XRP/test-RLUSD assets; historical usage does not reset after a restart, copied plan, new strategy ID, model revision, or approval window. Fresh approval may change caps, never erase usage.</p>
    </fieldset>

    <fieldset className="space-y-3">
      <legend className="label-mono mb-3 w-full border-b border-border pb-2">Ordered rules · first match wins</legend>
      {plan.rules.map((rule, index) => <div key={`${rule.id}-${index}`} className="border border-border bg-surface p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1"><span className="label-mono block">Rule ID</span><input disabled={disabled} value={rule.id} maxLength={32} onChange={(event) => updateRule(index, { id: event.target.value })} className="mt-1.5 h-11 w-full border border-input bg-background px-3 font-mono text-xs" /></label>
          <label className="min-w-0 flex-1"><span className="label-mono block">Supported rule</span><select disabled={disabled} value={rule.kind} onChange={(event) => updateRule(index, { kind: event.target.value as DeclarativeRuleDraft["kind"] })} className="mt-1.5 h-11 w-full border border-input bg-background px-3 text-sm">
            <option value="scheduled_buy">Scheduled fixed buy</option><option value="price_buy">Price-threshold buy</option><option value="price_sell">Price-threshold sell</option><option value="rebalance">Allocation rebalance</option>
          </select></label>
          <button type="button" disabled={disabled || plan.rules.length === 1} onClick={() => onChange({ ...plan, rules: plan.rules.filter((_, position) => position !== index) })} className="inline-flex min-h-11 items-center justify-center gap-2 border border-blocked/30 px-3 text-sm text-blocked disabled:opacity-50"><Trash2 className="size-4" aria-hidden="true" />Remove</button>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {rule.kind === "price_buy" || rule.kind === "price_sell" ? <Text label={rule.kind === "price_buy" ? "Maximum executable ask" : "Minimum executable bid"} value={rule.price} suffix="test-RLUSD/XRP" disabled={disabled} onChange={(value) => updateRule(index, { price: value })} /> : null}
          {rule.kind !== "rebalance" ? <Text label="Fixed order value" value={rule.fixedValue} suffix="test-RLUSD" disabled={disabled} onChange={(value) => updateRule(index, { fixedValue: value })} /> : <><Text label="Lower XRP band" value={rule.lowerXrpBps} suffix="bps" disabled={disabled} onChange={(value) => updateRule(index, { lowerXrpBps: value })} /><Text label="Target XRP" value={rule.targetXrpBps} suffix="bps" disabled={disabled} onChange={(value) => updateRule(index, { targetXrpBps: value })} /><Text label="Upper XRP band" value={rule.upperXrpBps} suffix="bps" disabled={disabled} onChange={(value) => updateRule(index, { upperXrpBps: value })} /></>}
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground"><span className="font-mono text-foreground">{index + 1}.</span> {describeRule(rule)}</p>
      </div>)}
      <button type="button" disabled={disabled || plan.rules.length >= MAX_DECLARATIVE_RULES} onClick={() => onChange({ ...plan, rules: [...plan.rules, newDeclarativeRule(plan.rules.length)] })} className="inline-flex min-h-11 items-center gap-2 border border-border px-3 text-sm disabled:opacity-50"><Plus className="size-4" aria-hidden="true" />Add supported rule</button>
    </fieldset>

    {diagnostics.length > 0 ? <section role="alert" aria-labelledby="plan-errors-title" className="border border-blocked/35 bg-blocked/[0.05] p-4"><h3 id="plan-errors-title" className="flex items-center gap-2 text-sm font-medium text-blocked"><AlertTriangle className="size-4" aria-hidden="true" />Plan cannot be compiled</h3><ul className="mt-2 space-y-1 text-xs leading-5 text-blocked">{diagnostics.map((diagnostic) => <li key={`${diagnostic.path}-${diagnostic.code}`}><span className="font-mono">{diagnostic.path}</span> · {diagnostic.message}</li>)}</ul></section> : null}

    <section aria-labelledby="paper-preview-title" className="border border-border bg-card">
      <header className="border-b border-border px-4 py-3"><p className="label-mono flex items-center gap-2"><FlaskConical className="size-3.5 text-primary" aria-hidden="true" />Deterministic paper preview</p><h3 id="paper-preview-title" className="mt-1 text-sm font-medium">Explicit inputs only</h3></header>
      <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4"><Text label="Observation time" type="datetime-local" value={paperInputs.observedAt} disabled={disabled} onChange={(value) => onPaperInputsChange({ ...paperInputs, observedAt: value })} /><Text label="Paper executable bid" value={paperInputs.executableBid} suffix="test-RLUSD/XRP" disabled={disabled} onChange={(value) => onPaperInputsChange({ ...paperInputs, executableBid: value })} /><Text label="Paper executable ask" value={paperInputs.executableAsk} suffix="test-RLUSD/XRP" disabled={disabled} onChange={(value) => onPaperInputsChange({ ...paperInputs, executableAsk: value })} /><Text label="Paper XRP allocation" value={paperInputs.xrpAllocationBps} suffix="bps" disabled={disabled} onChange={(value) => onPaperInputsChange({ ...paperInputs, xrpAllocationBps: value })} /></div>
      <div aria-live="polite" className="border-t border-border bg-surface px-4 py-3"><p className="font-mono text-xs font-medium uppercase">{preview.status.replace("_", " ")}{preview.matchedRuleId ? ` · ${preview.matchedRuleId}` : ""}</p>{preview.action ? <p className="mt-1 text-sm">{preview.action}</p> : null}<p className="mt-1 text-xs leading-5 text-muted-foreground">{preview.explanation}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">Paper evaluation is deterministic validation/dry-run evidence only. It is not a live signal, projected return, fill promise, signed transaction, submission, or ledger acceptance.</p></div>
    </section>
  </div>;
}

function Text({ label, value, suffix, type = "text", disabled, onChange }: { label: string; value: string; suffix?: string; type?: "text" | "datetime-local"; disabled?: boolean; onChange: (value: string) => void }) {
  return <label className="min-w-0"><span className="label-mono block">{label}</span><span className="relative mt-1.5 block"><input type={type} inputMode={type === "text" ? "decimal" : undefined} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} className={`h-11 w-full border border-input bg-background px-3 font-mono text-xs ${suffix ? "pr-28" : ""}`} />{suffix ? <span className="pointer-events-none absolute inset-y-0 right-3 flex max-w-24 items-center text-right font-mono text-[9px] uppercase text-muted-foreground">{suffix}</span> : null}</span></label>;
}
