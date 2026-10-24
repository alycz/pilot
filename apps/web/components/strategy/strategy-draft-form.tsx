"use client";

import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import React, { useState } from "react";

import {
  validateStrategyDraft,
  type DraftErrors,
  type StrategyDraft,
} from "./types";
import { DeclarativePlanEditor } from "./declarative-plan-editor";

export function StrategyDraftForm({
  draft,
  disabled = false,
  onChange,
  onReview,
}: {
  draft: StrategyDraft;
  disabled?: boolean;
  onChange: (draft: StrategyDraft) => void;
  onReview: (draft: StrategyDraft) => void;
}) {
  const [errors, setErrors] = useState<DraftErrors>({});
  const update = <K extends keyof StrategyDraft>(key: K, value: StrategyDraft[K]) => {
    onChange({ ...draft, [key]: value });
    setErrors((current) => ({ ...current, [key]: undefined }));
  };
  const review = () => {
    const next = validateStrategyDraft(draft);
    setErrors(next);
    if (Object.keys(next).length === 0) onReview(draft);
  };

  return (
    <section aria-labelledby="strategy-draft-title" className="bracket border border-border bg-card">
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <p className="label-mono flex items-center gap-2"><ShieldCheck className="size-3.5 text-primary" aria-hidden="true" />Bounded deterministic rules</p>
        <h2 id="strategy-draft-title" className="mt-1 text-lg font-medium tracking-tight">Create a strategy draft</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Saving this draft cannot trade. Every value below is frozen into a versioned mandate before activation.</p>
      </header>

      <div className="space-y-7 px-4 py-5 sm:px-5">
        <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2">
          <legend className="label-mono mb-3 w-full border-b border-border pb-2">Exact Testnet scope</legend>
          <ReadOnlyField label="Network" value="XRPL Testnet · test funds" />
          <ReadOnlyField label="Budget account" value={draft.account || "Connect a Testnet wallet"} error={errors.account} />
          <ReadOnlyField label="Asset" value="XRP / test-RLUSD" />
          <ReadOnlyField label="Currency code" value={draft.issuedAsset.currency} mono />
          <div className="sm:col-span-2"><ReadOnlyField label="Issuer" value={draft.issuedAsset.issuer} mono error={errors.issuedAsset} /></div>
        </fieldset>

        <fieldset>
          <legend className="label-mono mb-3 w-full border-b border-border pb-2">Strategy grammar</legend>
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Strategy grammar">
            <ModeButton checked={draft.strategyMode === "legacy_rebalancer"} disabled={disabled} title="Existing rebalancer" detail="Preserves the original xrp_issued_rebalancer_v1 semantics without reinterpretation." onClick={() => update("strategyMode", "legacy_rebalancer")} />
            <ModeButton checked={draft.strategyMode === "declarative"} disabled={disabled} title="Declarative plan v1" detail="Compose only the scheduled, price-threshold, and allocation primitives listed below." onClick={() => update("strategyMode", "declarative")} />
          </div>
        </fieldset>

        {draft.strategyMode === "legacy_rebalancer" ? <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="label-mono mb-3 w-full border-b border-border pb-2">Allocation · basis points</legend>
          <TextField label="Lower band" name="lowerXrpBps" value={draft.lowerXrpBps} error={errors.lowerXrpBps} disabled={disabled} onChange={(value) => update("lowerXrpBps", value)} suffix="bps" />
          <TextField label="Target XRP" name="targetXrpBps" value={draft.targetXrpBps} error={errors.targetXrpBps} disabled={disabled} onChange={(value) => update("targetXrpBps", value)} suffix="bps" />
          <TextField label="Upper band" name="upperXrpBps" value={draft.upperXrpBps} error={errors.upperXrpBps} disabled={disabled} onChange={(value) => update("upperXrpBps", value)} suffix="bps" />
        </fieldset> : <><DeclarativePlanEditor plan={draft.declarative} paperInputs={draft.paperInputs} disabled={disabled} onChange={(declarative) => update("declarative", declarative)} onPaperInputsChange={(paperInputs) => update("paperInputs", paperInputs)} />{errors.declarative ? <p role="alert" className="border border-blocked/35 bg-blocked/[0.05] px-4 py-3 text-xs leading-5 text-blocked">{errors.declarative}</p> : null}</>}

        <fieldset className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <legend className="label-mono mb-3 w-full border-b border-border pb-2">Execution limits</legend>
          <TextField label="Maximum order value" name="maxOrderValue" value={draft.maxOrderValue} error={errors.maxOrderValue} disabled={disabled} onChange={(value) => update("maxOrderValue", value)} suffix="test-RLUSD" />
          <TextField label="Daily value cap" name="maxDailyValue" value={draft.maxDailyValue} error={errors.maxDailyValue} disabled={disabled} onChange={(value) => update("maxDailyValue", value)} suffix="test-RLUSD" />
          <TextField label="Minimum order value" name="minOrderValue" value={draft.minOrderValue} error={errors.minOrderValue} disabled={disabled} onChange={(value) => update("minOrderValue", value)} suffix="test-RLUSD" />
          <TextField label="Maximum fee" name="maxFeeDrops" value={draft.maxFeeDrops} error={errors.maxFeeDrops} disabled={disabled} onChange={(value) => update("maxFeeDrops", value)} suffix="drops" />
          <TextField label="Maximum slippage" name="maxSlippageBps" value={draft.maxSlippageBps} error={errors.maxSlippageBps} disabled={disabled} onChange={(value) => update("maxSlippageBps", value)} suffix="bps" />
          <TextField label="Maximum price impact" name="maxPriceImpactBps" value={draft.maxPriceImpactBps} error={errors.maxPriceImpactBps} disabled={disabled} onChange={(value) => update("maxPriceImpactBps", value)} suffix="bps" />
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <legend className="label-mono mb-3 w-full border-b border-border pb-2">Reserve, exposure &amp; freshness</legend>
          <TextField label="Minimum XRP reserve" name="minimumXrpReserveDrops" value={draft.minimumXrpReserveDrops} error={errors.minimumXrpReserveDrops} disabled={disabled} onChange={(value) => update("minimumXrpReserveDrops", value)} suffix="drops" />
          <TextField label="Fee buffer" name="feeBufferDrops" value={draft.feeBufferDrops} error={errors.feeBufferDrops} disabled={disabled} onChange={(value) => update("feeBufferDrops", value)} suffix="drops" />
          <TextField label="Maximum XRP exposure" name="maxXrpExposureDrops" value={draft.maxXrpExposureDrops} error={errors.maxXrpExposureDrops} disabled={disabled} onChange={(value) => update("maxXrpExposureDrops", value)} suffix="drops" />
          <TextField label="Maximum issued exposure" name="maxIssuedExposure" value={draft.maxIssuedExposure} error={errors.maxIssuedExposure} disabled={disabled} onChange={(value) => update("maxIssuedExposure", value)} suffix="test-RLUSD" />
          <TextField label="Minimum executable liquidity" name="minimumLiquidityValue" value={draft.minimumLiquidityValue} error={errors.minimumLiquidityValue} disabled={disabled} onChange={(value) => update("minimumLiquidityValue", value)} suffix="test-RLUSD" />
          <TextField label="Cooldown" name="cooldownSeconds" value={draft.cooldownSeconds} error={errors.cooldownSeconds} disabled={disabled} onChange={(value) => update("cooldownSeconds", value)} suffix="seconds" />
          <TextField label="Maximum quote age" name="maxQuoteAgeSeconds" value={draft.maxQuoteAgeSeconds} error={errors.maxQuoteAgeSeconds} disabled={disabled} onChange={(value) => update("maxQuoteAgeSeconds", value)} suffix="seconds" />
          <ReadOnlyField label="Evaluation interval" value={draft.strategyMode === "declarative" ? `Every ${draft.declarative.intervalSeconds} seconds` : "Every 5 minutes"} />
          <TextField label="Mandate expiry" name="mandateExpiresAt" value={draft.mandateExpiresAt} error={errors.mandateExpiresAt} disabled={disabled} onChange={(value) => update("mandateExpiresAt", value)} type="datetime-local" />
        </fieldset>
      </div>

      <footer className="flex flex-col gap-3 border-t border-border bg-surface px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <p className="flex items-center gap-2 text-xs leading-5 text-muted-foreground"><LockKeyhole className="size-3.5 shrink-0" aria-hidden="true" />Agent text is an untrusted proposal. No model, memory, or chat instruction can execute code or expand these limits.</p>
        <button type="button" onClick={review} disabled={disabled} className="inline-flex min-h-11 items-center justify-center gap-2 border border-primary/50 bg-primary/[0.08] px-4 text-sm font-medium text-foreground transition hover:bg-primary/[0.13] disabled:cursor-not-allowed disabled:opacity-55">Review immutable mandate <ArrowRight className="size-4" aria-hidden="true" /></button>
      </footer>
    </section>
  );
}
function ModeButton({ checked, disabled, title, detail, onClick }: { checked: boolean; disabled?: boolean; title: string; detail: string; onClick: () => void }) {
  return <button type="button" role="radio" aria-checked={checked} disabled={disabled} onClick={onClick} className={`min-h-20 border p-3 text-left transition motion-reduce:transition-none disabled:opacity-50 ${checked ? "border-primary/55 bg-primary/[0.07]" : "border-border bg-surface hover:border-primary/30"}`}><span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{detail}</span></button>;
}
function ReadOnlyField({ label, value, mono = false, error }: { label: string; value: string; mono?: boolean; error?: string }) {
  return <div className="min-w-0"><p className="label-mono">{label}</p><p className={`mt-1.5 min-w-0 break-all border border-border bg-surface px-3 py-2.5 text-sm ${mono ? "font-mono text-xs" : ""}`}>{value}</p>{error ? <p className="mt-1 text-xs text-blocked" role="alert">{error}</p> : null}</div>;
}

function TextField({ label, name, value, suffix, error, disabled, type = "text", onChange }: { label: string; name: keyof StrategyDraft; value: string; suffix?: string; error?: string; disabled?: boolean; type?: "text" | "datetime-local"; onChange: (value: string) => void }) {
  const errorId = `${name}-error`;
  return <label className="min-w-0"><span className="label-mono block">{label}</span><span className="relative mt-1.5 block"><input aria-describedby={error ? errorId : undefined} aria-invalid={Boolean(error)} disabled={disabled} inputMode={type === "text" ? "decimal" : undefined} maxLength={type === "text" ? 64 : undefined} name={name} onChange={(event) => onChange(event.target.value)} type={type} value={value} className={`h-11 w-full min-w-0 border bg-background/60 px-3 font-mono text-xs text-foreground focus-visible:border-primary/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55 ${suffix ? "pr-24" : ""} ${error ? "border-blocked/70" : "border-input"}`} />{suffix ? <span className="pointer-events-none absolute inset-y-0 right-3 flex max-w-20 items-center text-right font-mono text-[10px] uppercase text-muted-foreground">{suffix}</span> : null}</span>{error ? <span id={errorId} className="mt-1 block text-xs text-blocked" role="alert">{error}</span> : null}</label>;
}
