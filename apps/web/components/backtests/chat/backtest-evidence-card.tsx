"use client";

import { Clipboard, ClipboardCheck, FlaskConical, ShieldAlert } from "lucide-react";
import React from "react";
import { useState } from "react";

import type { BacktestChatEvidenceContext } from "./evidence-reference";

export type BacktestEvidenceCardState =
  | Readonly<{ kind: "ready"; evidence: BacktestChatEvidenceContext }>
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{ kind: "error"; reason: string }>;

function signedBps(value: string): string {
  return value.startsWith("-") || value === "0" ? `${value} bps` : `+${value} bps`;
}

/**
 * Creates a bounded, reviewable explanation request. It contains research
 * evidence only and deliberately asks for no recommendation or action.
 */
export function backtestExplanationDraft(evidence: BacktestChatEvidenceContext): string {
  return [
    "Explain this saved deterministic backtest as research evidence only.",
    `Dataset: ${evidence.dataset.label} (${evidence.dataset.startDate} through ${evidence.dataset.endDate}).`,
    `Strategy version: ${evidence.reference.strategyVersion}.`,
    `Strategy return: ${evidence.result.strategyReturnBps} bps; hold benchmark: ${evidence.result.benchmarkReturnBps} bps; maximum drawdown: ${evidence.result.maxDrawdownBps} bps.`,
    `Ending equity: ${evidence.result.endingEquityQuote} ${evidence.result.quoteSymbol}; modeled costs: ${evidence.result.totalCostsQuote} ${evidence.result.quoteSymbol}; modeled trades: ${evidence.result.tradeCount}.`,
    "Discuss assumptions, cost sensitivity, dataset limits, and the difference between market-level bars and executable liquidity.",
    "Do not treat this run as a live quote, forecast, permission, approval, or instruction to trade.",
  ].join(" ");
}

export function BacktestEvidenceCard({ state }: { state: BacktestEvidenceCardState }) {
  const [copied, setCopied] = useState(false);

  if (state.kind !== "ready") {
    const isError = state.kind === "error";
    return (
      <section
        aria-labelledby="backtest-evidence-state-title"
        className={`rounded-xl border px-4 py-4 shadow-sm ${isError ? "border-destructive/35 bg-destructive/[0.06]" : "border-warning/35 bg-warning/[0.045]"}`}
      >
        <div className="flex gap-3">
          <ShieldAlert className={`mt-0.5 size-4 shrink-0 ${isError ? "text-destructive" : "text-warning"}`} aria-hidden="true" />
          <div>
            <p className="label-mono">Backtest evidence · {isError ? "invalid" : "unavailable"}</p>
            <h2 id="backtest-evidence-state-title" className="mt-1 text-sm font-medium">
              No research result was added to chat
            </h2>
            <p role={isError ? "alert" : "status"} className="mt-2 text-xs leading-5 text-muted-foreground">
              {state.reason} Nothing was prepared, approved, or submitted.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const { evidence } = state;
  const draft = backtestExplanationDraft(evidence);

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-labelledby="backtest-evidence-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="label-mono flex items-center gap-2 text-primary">
            <FlaskConical className="size-3.5" aria-hidden="true" />
            Saved backtest · research only
          </p>
          <h2 id="backtest-evidence-title" className="mt-1 text-sm font-medium">{evidence.dataset.label}</h2>
          <p className="mt-1 font-mono text-[10px] leading-5 text-muted-foreground">
            {evidence.dataset.startDate} → {evidence.dataset.endDate} · {evidence.reference.strategyVersion}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void copyDraft()}
          className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 font-mono text-[10px] uppercase tracking-wide transition hover:bg-primary/[0.07] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none"
        >
          {copied ? <ClipboardCheck className="size-3.5" aria-hidden="true" /> : <Clipboard className="size-3.5" aria-hidden="true" />}
          {copied ? "Copied" : "Copy explanation draft"}
        </button>
      </header>

      <dl className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
        <EvidenceMetric label="Strategy return" value={signedBps(evidence.result.strategyReturnBps)} />
        <EvidenceMetric label="Hold benchmark" value={signedBps(evidence.result.benchmarkReturnBps)} />
        <EvidenceMetric label="Maximum drawdown" value={`-${evidence.result.maxDrawdownBps} bps`} />
        <EvidenceMetric label="Ending equity" value={`${evidence.result.endingEquityQuote} ${evidence.result.quoteSymbol}`} />
        <EvidenceMetric label="Modeled costs" value={`${evidence.result.totalCostsQuote} ${evidence.result.quoteSymbol}`} />
        <EvidenceMetric label="Modeled trades" value={String(evidence.result.tradeCount)} />
      </dl>

      <div className="space-y-2 px-4 py-4 text-xs leading-5 text-muted-foreground">
        <p>{evidence.dataset.sourceDisclosure}</p>
        <p className="border-l-2 border-warning pl-3 text-foreground">{evidence.disclosure}</p>
        <details className="rounded-xl border border-border motion-reduce:transition-none">
          <summary className="min-h-11 cursor-pointer px-3 py-2.5 font-medium text-foreground">Review explanation draft</summary>
          <p className="border-t border-border px-3 py-3 font-mono text-[11px] leading-5">{draft}</p>
        </details>
      </div>
      <p className="sr-only" aria-live="polite">{copied ? "Backtest explanation draft copied." : ""}</p>
    </section>
  );
}

function EvidenceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="label-mono text-[9px]">{label}</dt>
      <dd className="mt-1 break-words font-mono text-xs font-medium">{value}</dd>
    </div>
  );
}
