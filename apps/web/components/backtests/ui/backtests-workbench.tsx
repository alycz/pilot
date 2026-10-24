import { AlertTriangle, BarChart3, Database, FlaskConical, LockKeyhole, Scale, ShieldCheck } from "lucide-react";
import React from "react";

import type { BacktestMetric, BacktestsViewModel, EquityDatum } from "./view-model";

const availabilityTone: Record<BacktestsViewModel["availability"], string> = {
  "validated-historical": "border-executed/35 bg-executed/[0.045] text-executed",
  "deterministic-fixture": "border-warning/35 bg-warning/[0.045] text-warning",
  unavailable: "border-border bg-surface text-muted-foreground",
};

export function BacktestsWorkbench({ model }: { model: BacktestsViewModel }) {
  return (
    <div className="min-w-0">
      <section aria-labelledby="backtests-title" className="relative overflow-hidden border-b border-border bg-surface/50">
        <div className="relative px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          <p className="label-mono flex items-center gap-2 text-primary"><FlaskConical className="size-3.5" aria-hidden="true" />Research · deterministic simulation</p>
          <h1 id="backtests-title" className="mt-3 max-w-4xl text-2xl font-medium tracking-tight sm:text-3xl font-display">Backtest an investing rule before acting</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Review source coverage, freeze a bounded strategy and its costs, then compare post-cost equity with a hold benchmark. The calculation engine owns results; AI may explain a completed run but cannot change its numbers or grant execution authority.
          </p>
        </div>
      </section>

      <div className="min-w-0 space-y-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <section aria-labelledby="availability-title" className={`rounded-xl border shadow-sm ${availabilityTone[model.availability]}`}>
          <div className="flex gap-3 px-4 py-4 sm:px-5">
            {model.availability === "validated-historical" ? <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
            <div>
              <p className="label-mono">{model.availabilityLabel}</p>
              <h2 id="availability-title" className="mt-1 text-base font-medium text-foreground">{model.availabilityTitle}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{model.availabilityDetail}</p>
            </div>
          </div>
        </section>

        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-5">
            <SetupPanel model={model} />
            <ResultsPanel model={model} />
            <TradeLog model={model} />
            <SavedRunTable model={model} />
          </div>

          <aside className="min-w-0 space-y-5" aria-label="Backtest evidence and limitations">
            <ProviderPanel model={model} />
            <ReproducibilityPanel model={model} />
            <ExperimentPanel model={model} />
            <section aria-labelledby="authority-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <header className="border-b border-border px-4 py-3"><h2 id="authority-title" className="flex items-center gap-2 text-sm font-medium"><LockKeyhole className="size-4 text-primary" aria-hidden="true" />Research boundary</h2></header>
              <ul className="space-y-2 px-4 py-4 text-xs leading-5 text-muted-foreground">
                <li>No wallet address or balance is required.</li>
                <li>No leverage, shorts, transaction building, signing, approval, or submission.</li>
                <li>Market-level bars do not prove historical XRPL DEX fills or liquidity.</li>
                <li>Saved evidence cannot expand permissions, mandates, or risk limits.</li>
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

function SetupPanel({ model }: { model: BacktestsViewModel }) {
  return (
    <section aria-labelledby="setup-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <p className="label-mono">1 · Setup and freeze</p>
        <h2 id="setup-title" className="mt-1 text-lg font-medium">Dataset, portfolio, strategy, and costs</h2>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{model.availability === "unavailable" ? "Review and edit inputs above, then run the deterministic engine before interpreting any result." : "These frozen inputs produced the deterministic result below; changing them requires a new run."}</p>
      </header>
      <form aria-label="Frozen backtest setup" className="grid gap-4 px-4 py-5 sm:grid-cols-2 sm:px-5">
        {model.setup.map((field) => {
          const helpId = `${field.id}-help`;
          return (
            <div key={field.id} className="min-w-0">
              <label htmlFor={field.id} className="label-mono text-[10px]">{field.label}</label>
              <input id={field.id} aria-describedby={helpId} readOnly value={field.value} className="mt-2 min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none" />
              <p id={helpId} className="mt-2 text-xs leading-5 text-muted-foreground">{field.help}</p>
            </div>
          );
        })}
      </form>
      <div className="border-t border-border bg-surface px-4 py-3 text-xs leading-5 text-muted-foreground sm:px-5"><strong className="font-medium text-foreground">Lookahead guard:</strong> {model.splitDisclosure}</div>
    </section>
  );
}

function ResultsPanel({ model }: { model: BacktestsViewModel }) {
  return (
    <section aria-labelledby="results-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <p className="label-mono">2 · Deterministic results</p>
        <h2 id="results-title" className="mt-1 text-lg font-medium">Equity, benchmark, and drawdown</h2>
      </header>
      <dl className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
        {model.metrics.map((metric) => <Metric key={metric.label} metric={metric} />)}
      </dl>
      <div className="border-t border-border px-4 py-5 sm:px-5">
        <EquityChart points={model.equity} />
        <div className="mt-4 overflow-x-auto" role="region" aria-label="Equity and drawdown data table" tabIndex={0}>
          <table className="w-full min-w-[34rem] border-collapse text-left text-xs">
            <caption className="sr-only">Date-by-date strategy equity, hold benchmark equity, and drawdown.</caption>
            <thead className="border-b border-border bg-surface"><tr><th scope="col" className="px-3 py-2 font-medium">Date</th><th scope="col" className="px-3 py-2 text-right font-medium">Strategy equity</th><th scope="col" className="px-3 py-2 text-right font-medium">Hold benchmark</th><th scope="col" className="px-3 py-2 text-right font-medium">Drawdown</th></tr></thead>
            <tbody className="divide-y divide-border">{model.equity.map((point) => <tr key={point.date}><th scope="row" className="px-3 py-2 font-mono font-medium">{point.date}</th><td className="px-3 py-2 text-right font-mono">{point.strategyEquityDisplay}</td><td className="px-3 py-2 text-right font-mono">{point.benchmarkEquityDisplay}</td><td className="px-3 py-2 text-right font-mono">{point.drawdownDisplay}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Metric({ metric }: { metric: BacktestMetric }) {
  const tone = metric.tone === "positive" ? "text-executed" : metric.tone === "warning" ? "text-warning" : "text-foreground";
  return <div className="bg-card px-4 py-4"><dt className="label-mono text-[10px]">{metric.label}</dt><dd className={`mt-1 font-mono text-sm font-medium ${tone}`}>{metric.value}</dd><p className="mt-1 text-[11px] text-muted-foreground">{metric.detail}</p></div>;
}

function EquityChart({ points }: { points: readonly EquityDatum[] }) {
  if (points.length < 2) return <p role="status" className="text-sm text-muted-foreground">At least two validated observations are required to draw an equity comparison.</p>;
  const allValues = points.flatMap(({ strategyEquity, benchmarkEquity }) => [strategyEquity, benchmarkEquity]);
  const minimum = Math.min(...allValues);
  const maximum = Math.max(...allValues);
  const range = Math.max(1, maximum - minimum);
  const coordinate = (value: number, index: number) => `${((index / (points.length - 1)) * 100).toFixed(2)},${(92 - ((value - minimum) / range) * 76).toFixed(2)}`;
  const strategy = points.map((point, index) => coordinate(point.strategyEquity, index)).join(" ");
  const benchmark = points.map((point, index) => coordinate(point.benchmarkEquity, index)).join(" ");
  return (
    <figure>
      <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs"><span className="flex items-center gap-2"><span className="h-0.5 w-5 bg-primary" aria-hidden="true" />Strategy equity</span><span className="flex items-center gap-2"><span className="h-0.5 w-5 bg-muted-foreground" aria-hidden="true" />Hold benchmark</span></figcaption>
      <svg className="mt-3 h-52 w-full rounded-xl border border-border bg-surface" viewBox="0 0 100 100" role="img" aria-labelledby="equity-chart-title equity-chart-description" preserveAspectRatio="none">
        <title id="equity-chart-title">Strategy and hold benchmark equity comparison</title>
        <desc id="equity-chart-description">A non-interactive visual summary. Exact values are available in the keyboard-readable table immediately below.</desc>
        <path d="M0 25H100M0 50H100M0 75H100" stroke="currentColor" className="text-border" strokeWidth="0.35" vectorEffect="non-scaling-stroke" />
        <polyline points={benchmark} fill="none" stroke="currentColor" className="text-muted-foreground" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        <polyline points={strategy} fill="none" stroke="currentColor" className="text-primary" strokeWidth="1.7" vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}

function TradeLog({ model }: { model: BacktestsViewModel }) {
  return (
    <section aria-labelledby="trade-log-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-4 py-4 sm:px-5"><p className="label-mono">3 · Event audit</p><h2 id="trade-log-title" className="mt-1 text-lg font-medium">Signals, next-bar fills, and rejections</h2></header>
      <div className="overflow-x-auto" role="region" aria-label="Backtest trade event log" tabIndex={0}>
        <table className="w-full min-w-[58rem] border-collapse text-left text-xs">
          <caption className="sr-only">Backtest signals with later fill time, side, notional, costs, ending cash, and status.</caption>
          <thead className="border-b border-border bg-surface"><tr>{["Signal", "Fill", "Side", "Gross notional", "Costs", "Ending cash", "Status"].map((label) => <th key={label} scope="col" className="px-4 py-3 font-medium">{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-border">{model.trades.map((trade, index) => <tr key={`${trade.signalAt}-${index}`}><td className="px-4 py-3 font-mono">{trade.signalAt}</td><td className="px-4 py-3 font-mono">{trade.fillAt}</td><td className="px-4 py-3">{trade.side}</td><td className="px-4 py-3 font-mono">{trade.grossNotional}</td><td className="px-4 py-3 font-mono">{trade.costs}</td><td className="px-4 py-3 font-mono">{trade.endingCash}</td><td className="px-4 py-3">{trade.status}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function SavedRunTable({ model }: { model: BacktestsViewModel }) {
  return (
    <section aria-labelledby="saved-runs-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-4 py-4 sm:px-5"><p className="label-mono">4 · Compare evidence</p><h2 id="saved-runs-title" className="mt-1 text-lg font-medium">Saved-run comparison</h2><p className="mt-2 text-xs leading-5 text-muted-foreground">Only runs with compatible dataset, strategy, and quote-currency fingerprints should be compared.</p></header>
      <div className="overflow-x-auto" role="region" aria-label="Saved backtest run comparison" tabIndex={0}>
        <table className="w-full min-w-[48rem] border-collapse text-left text-xs">
          <caption className="sr-only">Compatible saved runs with performance, benchmark, drawdown, and cost values.</caption>
          <thead className="border-b border-border bg-surface"><tr>{["Run", "Compatibility", "Strategy", "Benchmark", "Drawdown", "Costs"].map((label) => <th key={label} scope="col" className="px-4 py-3 font-medium">{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-border">{model.savedRuns.map((run) => <tr key={run.runId}><th scope="row" className="px-4 py-3"><span className="font-medium">{run.label}</span><span className="mt-1 block font-mono text-[10px] text-muted-foreground">{run.runId}</span></th><td className="px-4 py-3">{run.compatible ? "Compatible" : "Blocked"}</td><td className="px-4 py-3 font-mono">{run.strategyReturn}</td><td className="px-4 py-3 font-mono">{run.benchmarkReturn}</td><td className="px-4 py-3 font-mono">{run.maxDrawdown}</td><td className="px-4 py-3 font-mono">{run.totalCosts}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function ProviderPanel({ model }: { model: BacktestsViewModel }) {
  return (
    <section aria-labelledby="provider-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-4 py-3"><h2 id="provider-title" className="flex items-center gap-2 text-sm font-medium"><Database className="size-4 text-primary" aria-hidden="true" />Data source</h2></header>
      <dl className="divide-y divide-border text-xs">
        <Row label="Provider" value={model.provider.name} />
        <Row label="Pair" value={model.provider.pair} />
        <Row label="Capability" value={model.provider.capability} />
        <Row label="Cost / access" value={model.provider.cost} />
        <Row label="Requested" value={model.provider.requestedWindow} />
        <Row label="Actual coverage" value={model.provider.actualCoverage} />
        <Row label="Incomplete candle" value={model.provider.incompleteCandlePolicy} />
      </dl>
    </section>
  );
}

function ReproducibilityPanel({ model }: { model: BacktestsViewModel }) {
  return (
    <details open className="overflow-hidden rounded-xl border border-border bg-card shadow-sm motion-reduce:transition-none">
      <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium">Reproducibility report</summary>
      <dl className="divide-y divide-border border-t border-border text-xs">
        <Row label="Run ID" value={model.reproducibility.runId} />
        <Row label="Strategy version" value={model.reproducibility.strategyVersion} />
        <Row label="Parameter fingerprint" value={model.reproducibility.parameterFingerprint} />
        <Row label="Raw hash" value={model.reproducibility.rawHash} />
        <Row label="Normalized hash" value={model.reproducibility.normalizedHash} />
        <Row label="Coverage" value={model.reproducibility.coverage} />
        <Row label="Missing data" value={model.reproducibility.missingData} />
      </dl>
    </details>
  );
}

function ExperimentPanel({ model }: { model: BacktestsViewModel }) {
  return (
    <section aria-labelledby="experiment-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-4 py-3"><h2 id="experiment-title" className="flex items-center gap-2 text-sm font-medium"><Scale className="size-4 text-primary" aria-hidden="true" />Hypothesis → experiment → outcome</h2></header>
      <ol className="space-y-4 px-4 py-4 text-xs leading-5">
        <Step label="Hypothesis" value={model.experiment.hypothesis} />
        <Step label="Experiment" value={model.experiment.experiment} />
        <Step label="Outcome" value={model.experiment.outcome} />
      </ol>
      <p className="border-t border-border px-4 py-3 text-xs leading-5 text-muted-foreground"><BarChart3 className="mr-1.5 inline size-3.5" aria-hidden="true" />A model may explain this saved evidence, but only the deterministic report defines the result.</p>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="px-4 py-3"><dt className="label-mono text-[9px]">{label}</dt><dd className="mt-1 break-words font-mono leading-5">{value}</dd></div>;
}

function Step({ label, value }: { label: string; value: string }) {
  return <li><p className="label-mono text-[9px]">{label}</p><p className="mt-1 text-muted-foreground">{value}</p></li>;
}
