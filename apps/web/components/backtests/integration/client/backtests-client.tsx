"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes } from "react";

import { encodeBacktestChatReference } from "../../chat/evidence-reference";
import { BACKTESTS_FIXTURE_VIEW_MODEL, BacktestsWorkbench } from "../../ui";
import { compareRunEvidence, savedRunRows } from "./comparison";
import {
  BacktestRunBundleSchema,
  BacktestRunRequestSchema,
  apiErrorMessage,
  type BacktestRunBundle,
  type BacktestRunRequest,
  type StoredBacktestRun,
} from "./contracts";
import { loadStoredBacktestRuns, saveBacktestRun } from "./storage";
import { BACKTEST_SESSION_INVALIDATED_EVENT } from "./session-lifecycle-guard";

type Draft = Record<keyof BacktestRunRequest, string>;

const INITIAL_DRAFT: Draft = {
  startDay: "2025-01-01",
  endDay: "2026-09-30",
  outOfSampleStartDay: "2026-01-01",
  initialBase: "1000",
  initialQuote: "1000",
  targetBaseBps: "5000",
  bandBps: "500",
  maxTradeQuote: "250",
  spreadBps: "10",
  venueFeeBps: "10",
  slippageBps: "25",
  networkCostQuote: "0.01",
  embargoBars: "1",
  hypothesis: "A bounded allocation band may reduce turnover while remaining competitive with static holdings after explicit costs.",
};

export function requestFromDraft(draft: Draft): BacktestRunRequest {
  return BacktestRunRequestSchema.parse({
    ...draft,
    targetBaseBps: Number(draft.targetBaseBps),
    bandBps: Number(draft.bandBps),
    spreadBps: Number(draft.spreadBps),
    venueFeeBps: Number(draft.venueFeeBps),
    slippageBps: Number(draft.slippageBps),
    embargoBars: Number(draft.embargoBars),
  });
}

export function BacktestsClient() {
  const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT);
  const [bundle, setBundle] = useState<BacktestRunBundle>();
  const [saved, setSaved] = useState<readonly StoredBacktestRun[]>([]);
  const [compareRunId, setCompareRunId] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "complete" | "error">("idle");
  const [error, setError] = useState<string>();
  const controllerRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    setSaved(loadStoredBacktestRuns(window.sessionStorage));
    const clearForSessionInvalidation = () => {
      controllerRef.current?.abort();
      setBundle(undefined);
      setSaved([]);
      setCompareRunId("");
      setStatus("idle");
      setError(undefined);
    };
    window.addEventListener(BACKTEST_SESSION_INVALIDATED_EVENT, clearForSessionInvalidation);
    return () => {
      window.removeEventListener(BACKTEST_SESSION_INVALIDATED_EVENT, clearForSessionInvalidation);
      controllerRef.current?.abort();
    };
  }, []);

  const model = useMemo(() => ({
    ...(bundle?.viewModel ?? BACKTESTS_FIXTURE_VIEW_MODEL),
    savedRuns: savedRunRows(bundle, saved),
  }), [bundle, saved]);
  const baseline = saved.find(({ bundle: candidate }) => candidate.chatEvidence.runId === compareRunId)?.bundle;
  const comparison = bundle && baseline ? compareRunEvidence(bundle, baseline) : undefined;

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    controllerRef.current?.abort();
    setError(undefined);
    let request: BacktestRunRequest;
    try {
      request = requestFromDraft(draft);
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Backtest inputs are invalid.");
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus("running");
    try {
      const response = await fetch("/api/research/backtests/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("The backtest service returned an unreadable response.");
      }
      if (!response.ok) throw new Error(apiErrorMessage(payload) ?? `Backtest service failed with HTTP ${response.status}.`);
      const next = BacktestRunBundleSchema.parse(payload);
      const nextSaved = saveBacktestRun(window.sessionStorage, next);
      setBundle(next);
      setSaved(nextSaved);
      setCompareRunId(nextSaved.find(({ bundle: item }) => item.chatEvidence.runId !== next.chatEvidence.runId)?.bundle.chatEvidence.runId ?? "");
      setStatus("complete");
    } catch (cause) {
      if (controller.signal.aborted) return;
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "The backtest could not be completed.");
    }
  }

  const chatHref = bundle ? `/chat?${encodeBacktestChatReference({
    version: "v1",
    runId: bundle.chatEvidence.runId,
    resultFingerprint: bundle.chatEvidence.resultFingerprint,
    datasetNormalizedHash: bundle.chatEvidence.datasetNormalizedHash,
    strategyVersion: bundle.chatEvidence.strategyVersion,
  })}` : undefined;

  return (
    <>
      <section aria-labelledby="backtest-config-title" className="bg-background px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <form onSubmit={(event) => void run(event)} className="mx-auto max-w-6xl space-y-6 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6">
          <div>
            <p className="label-mono">Configure a bounded experiment</p>
            <h2 id="backtest-config-title" className="mt-1 text-lg font-medium">Validated daily bars · deterministic calculation</h2>
            <p className="mt-2 max-w-3xl text-xs leading-5 text-muted-foreground">Data loads only when you run the experiment. Provider failures stay visible; Pilot never silently substitutes fixture data.</p>
            <p className="mt-3 inline-flex rounded-md border border-info/30 bg-info/5 px-2.5 py-1.5 text-xs font-medium text-info">External public historical data · not verified for executable liquidity</p>
          </div>
          <fieldset disabled={status === "running"} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 disabled:opacity-70">
            <legend className="sr-only">Backtest configuration</legend>
            <ReadOnlyField id="source" label="Dataset" value="Kraken XRP / USD daily bars" help="Public, read-only, no API key. Redistribution rights remain under review." />
            <ReadOnlyField id="strategy-id" label="Strategy" value="Long-only allocation band v1" help="No leverage, shorts, optimizer, or generated code." />
            <Field id="start-day" label="Start day" type="date" value={draft.startDay} onChange={(value) => update("startDay", value)} help="UTC daily bucket." />
            <Field id="end-day" label="End day" type="date" value={draft.endDay} onChange={(value) => update("endDay", value)} help="Maximum 720 inclusive daily buckets." />
            <Field id="oos-day" label="Out-of-sample start" type="date" value={draft.outOfSampleStartDay} onChange={(value) => update("outOfSampleStartDay", value)} help="Parameters freeze before this date." />
            <Field id="embargo-bars" label="Embargo days" type="number" value={draft.embargoBars} onChange={(value) => update("embargoBars", value)} help="At least one full daily bar." min="1" max="30" step="1" />
            <Field id="initial-base" label="Starting XRP" type="text" value={draft.initialBase} onChange={(value) => update("initialBase", value)} help="Research input; no wallet balance is read." inputMode="decimal" />
            <Field id="initial-quote" label="Starting USD" type="text" value={draft.initialQuote} onChange={(value) => update("initialQuote", value)} help="Long-only cash balance." inputMode="decimal" />
            <Field id="target-bps" label="Target base (bps)" type="number" value={draft.targetBaseBps} onChange={(value) => update("targetBaseBps", value)} help="5,000 bps = 50%." min="1" max="9999" step="1" />
            <Field id="band-bps" label="Allocation band (bps)" type="number" value={draft.bandBps} onChange={(value) => update("bandBps", value)} help="No signal while allocation stays inside the band." min="0" max="4999" step="1" />
            <Field id="max-trade" label="Max trade (USD)" type="text" value={draft.maxTradeQuote} onChange={(value) => update("maxTradeQuote", value)} help="Explicit research cap; not a liquidity claim." inputMode="decimal" />
            <Field id="spread-bps" label="Spread assumption (bps)" type="number" value={draft.spreadBps} onChange={(value) => update("spreadBps", value)} help="Modeled, not observed historical spread." min="0" max="5000" step="1" />
            <Field id="venue-fee-bps" label="Venue fee (bps)" type="number" value={draft.venueFeeBps} onChange={(value) => update("venueFeeBps", value)} help="Explicit sensitivity input." min="0" max="5000" step="1" />
            <Field id="slippage-bps" label="Slippage (bps)" type="number" value={draft.slippageBps} onChange={(value) => update("slippageBps", value)} help="Market-level bars do not prove executable liquidity." min="0" max="5000" step="1" />
            <Field id="network-cost" label="Other cost / fill (USD)" type="text" value={draft.networkCostQuote} onChange={(value) => update("networkCostQuote", value)} help="Fixed quote-denominated assumption." inputMode="decimal" />
            <label htmlFor="hypothesis" className="min-w-0 sm:col-span-2 xl:col-span-4">
              <span className="label-mono text-[10px]">Hypothesis</span>
              <textarea id="hypothesis" value={draft.hypothesis} onChange={(event) => update("hypothesis", event.target.value)} aria-describedby="hypothesis-help" rows={3} maxLength={500} className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm leading-6 outline-none transition focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none" />
              <span id="hypothesis-help" className="mt-2 block text-xs leading-5 text-muted-foreground">Recorded before out-of-sample results are returned.</span>
            </label>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={status === "running"} className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 font-mono text-xs font-medium uppercase tracking-wide text-primary-foreground transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none">
              {status === "running" ? "Validating and running…" : "Run deterministic backtest"}
            </button>
            {chatHref ? <Link href={chatHref} className="inline-flex min-h-11 items-center rounded-md border border-border bg-background px-4 font-mono text-xs uppercase tracking-wide transition hover:bg-primary/[0.07] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none">Explain saved evidence in chat</Link> : null}
            <p aria-live="polite" className="text-xs text-muted-foreground">{status === "complete" ? "Validated run saved for this tab session." : status === "running" ? "Reading public data and calculating on the server…" : ""}</p>
          </div>
          {error ? <p role="alert" className="rounded-xl border border-destructive/35 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive">{error} No historical result was substituted.</p> : null}
          {bundle && saved.length > 1 ? (
            <div className="grid gap-3 rounded-xl border border-border bg-surface px-4 py-4 sm:grid-cols-[minmax(0,18rem)_1fr] sm:items-end">
              <label htmlFor="comparison-run" className="text-xs"><span className="label-mono text-[10px]">Compare saved run</span><select id="comparison-run" value={compareRunId} onChange={(event) => setCompareRunId(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"><option value="">Choose a prior run</option>{saved.filter(({ bundle: item }) => item.chatEvidence.runId !== bundle.chatEvidence.runId).map(({ bundle: item }) => <option key={item.chatEvidence.runId} value={item.chatEvidence.runId}>{item.savedRun.label}</option>)}</select></label>
              <p role="status" className="text-xs leading-5 text-muted-foreground">{comparison?.detail ?? "Choose a prior run. Incompatible datasets, strategies, currencies, or periods remain blocked."}</p>
            </div>
          ) : null}
        </form>
      </section>
      <BacktestsWorkbench model={model} />
    </>
  );
}

function ReadOnlyField({ id, label, value, help }: { id: string; label: string; value: string; help: string }) {
  const helpId = `${id}-help`;
  return <label htmlFor={id} className="min-w-0"><span className="label-mono text-[10px]">{label}</span><input id={id} value={value} readOnly aria-describedby={helpId} className="mt-2 min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-muted-foreground" /><span id={helpId} className="mt-2 block text-xs leading-5 text-muted-foreground">{help}</span></label>;
}

function Field({ id, label, value, help, onChange, type, ...input }: { id: string; label: string; value: string; help: string; onChange: (value: string) => void; type: "text" | "date" | "number" } & Pick<InputHTMLAttributes<HTMLInputElement>, "min" | "max" | "step" | "inputMode">) {
  const helpId = `${id}-help`;
  return <label htmlFor={id} className="min-w-0"><span className="label-mono text-[10px]">{label}</span><input {...input} id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} required aria-describedby={helpId} className="mt-2 min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none" /><span id={helpId} className="mt-2 block text-xs leading-5 text-muted-foreground">{help}</span></label>;
}

export { INITIAL_DRAFT };
