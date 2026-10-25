"use client";

import { AlertTriangle, Database, FlaskConical, Play, RotateCcw, ShieldCheck } from "lucide-react";
import React, { useMemo, useState } from "react";

import { researchArbitrage, type ArbitrageResearchResult } from "./arbitrage";
import { runBacktest, type BacktestConfig, type BacktestMetrics, type BacktestReport } from "./backtest";
import { DETERMINISTIC_STRATEGY_FIXTURE } from "./fixtures";

export type ResearchHypothesisId = "balanced" | "tight-band" | "cost-stress";

export type ResearchDemoDraft = Readonly<{
  hypothesis: ResearchHypothesisId;
  targetBaseBps: 4_000 | 5_000 | 6_000;
  bandBps: 250 | 500 | 1_000;
  maxTradeQuote: 10 | 25 | 50;
  assumedSlippageBps: 10 | 25 | 75;
  minimumNetEdgeBps: 0 | 20 | 50;
}>;

type ResearchDemoResult = Readonly<{
  report: BacktestReport;
  arbitrage: ArbitrageResearchResult;
  fingerprint: string;
}>;

const HYPOTHESES: ReadonlyArray<Readonly<{
  id: ResearchHypothesisId;
  title: string;
  question: string;
  draft: ResearchDemoDraft;
}>> = [
  {
    id: "balanced",
    title: "Balanced rebalance",
    question: "Does a 50% XRP target with a ±5% band outperform holding after modeled costs?",
    draft: { hypothesis: "balanced", targetBaseBps: 5_000, bandBps: 500, maxTradeQuote: 25, assumedSlippageBps: 25, minimumNetEdgeBps: 20 },
  },
  {
    id: "tight-band",
    title: "Tighter intervention band",
    question: "Does intervening at ±2.5% improve tracking enough to justify more modeled fills?",
    draft: { hypothesis: "tight-band", targetBaseBps: 5_000, bandBps: 250, maxTradeQuote: 25, assumedSlippageBps: 25, minimumNetEdgeBps: 20 },
  },
  {
    id: "cost-stress",
    title: "Cost-stress case",
    question: "Does the same rule still hold up when assumed slippage rises to 75 bps?",
    draft: { hypothesis: "cost-stress", targetBaseBps: 5_000, bandBps: 500, maxTradeQuote: 25, assumedSlippageBps: 75, minimumNetEdgeBps: 50 },
  },
];

export const DEFAULT_RESEARCH_DEMO_DRAFT: ResearchDemoDraft = HYPOTHESES[0]!.draft;

function backtestConfig(draft: ResearchDemoDraft): BacktestConfig {
  return {
    initialBase: 100,
    initialQuote: 50,
    targetBaseBps: draft.targetBaseBps,
    bandBps: draft.bandBps,
    maxTradeQuote: draft.maxTradeQuote,
    venueFeeBps: 10,
    assumedSlippageBps: draft.assumedSlippageBps,
    networkFeeQuote: 0.01,
  };
}

/** Pure signed-out demo evaluation: no clock, storage, model, wallet, fetch, or provider access. */
export function evaluateResearchDemo(draft: ResearchDemoDraft): ResearchDemoResult {
  const report = runBacktest(DETERMINISTIC_STRATEGY_FIXTURE, backtestConfig(draft));
  const arbitrage = researchArbitrage(DETERMINISTIC_STRATEGY_FIXTURE, {
    now: "2026-01-01T08:00:10.000Z",
    tradeSizeBase: 100,
    maxQuoteAgeSeconds: 30,
    clobFeeBps: 10,
    assumedSlippageBps: draft.assumedSlippageBps,
    networkFeeQuotePerLeg: 0.01,
    minimumNetEdgeBps: draft.minimumNetEdgeBps,
  });
  const metrics = report.metrics.full;
  return {
    report,
    arbitrage,
    fingerprint: [
      draft.hypothesis,
      metrics.strategyReturnBps,
      metrics.benchmarkReturnBps,
      metrics.maxDrawdownBps,
      metrics.tradeCount,
      metrics.totalCostsQuote,
    ].join(":"),
  };
}

export function resetResearchDemoDraft(): ResearchDemoDraft {
  return { ...DEFAULT_RESEARCH_DEMO_DRAFT };
}

const HYPOTHESIS_RESULTS = HYPOTHESES.map((hypothesis) => ({
  ...hypothesis,
  result: evaluateResearchDemo(hypothesis.draft),
}));

const signedBps = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)} bps`;
const quote = (value: number) => value.toFixed(4);

export function StrategyResearchWorkbench() {
  const fixture = DETERMINISTIC_STRATEGY_FIXTURE;
  const [draft, setDraft] = useState<ResearchDemoDraft>(() => resetResearchDemoDraft());
  const [activeDraft, setActiveDraft] = useState<ResearchDemoDraft>(() => resetResearchDemoDraft());
  const [runNumber, setRunNumber] = useState(1);
  const result = useMemo(() => evaluateResearchDemo(activeDraft), [activeDraft]);
  const { report, arbitrage } = result;
  const hypothesis = HYPOTHESES.find(({ id }) => id === activeDraft.hypothesis) ?? HYPOTHESES[0]!;
  const dirty = JSON.stringify(draft) !== JSON.stringify(activeDraft);

  const selectHypothesis = (id: ResearchHypothesisId) => {
    const next = HYPOTHESES.find((entry) => entry.id === id)?.draft ?? DEFAULT_RESEARCH_DEMO_DRAFT;
    setDraft({ ...next });
  };
  const run = () => {
    setActiveDraft({ ...draft });
    setRunNumber((current) => current + 1);
  };
  const reset = () => {
    const next = resetResearchDemoDraft();
    setDraft(next);
    setActiveDraft({ ...next });
    setRunNumber(1);
  };
  return (
    <div className="min-w-0">
      <section aria-labelledby="research-title" className="relative overflow-hidden border-b border-border bg-surface/50">
        <div className="relative px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          <div className="max-w-4xl">
            <p className="label-mono flex items-center gap-2 text-primary">
              <FlaskConical className="size-3.5" aria-hidden="true" />
              Strategy research
            </p>
            <h1 id="research-title" className="mt-3 text-2xl font-medium tracking-tight sm:text-3xl font-display">
              Test assumptions before preparing an action
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
              Compare a bounded rebalancing rule with a hold benchmark, inspect modeled costs and drawdown, and research cross-venue price differences. This workbench cannot build, sign, approve, or submit a transaction.
            </p>
          </div>
        </div>
      </section>

      <div className="grid min-w-0 gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-5">
          <section aria-labelledby="demo-controls-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <header className="border-b border-border px-4 py-4 sm:px-5">
              <p className="label-mono text-primary">Interactive simulated research</p>
              <h2 id="demo-controls-title" className="mt-1 text-lg font-medium">Choose a hypothesis and rerun the fixture</h2>
              <p className="mt-2 max-w-3xl text-xs leading-5 text-muted-foreground">
                Every control below reruns the same checked-in synthetic observations in this browser. No AI model, wallet, provider, live price feed, or execution endpoint is contacted.
              </p>
            </header>
            <div className="grid gap-4 px-4 py-5 sm:px-5 lg:grid-cols-3">
              <Field label="Sample hypothesis" id="research-hypothesis">
                <select
                  id="research-hypothesis"
                  value={draft.hypothesis}
                  onChange={(event) => selectHypothesis(event.target.value as ResearchHypothesisId)}
                  className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                  {HYPOTHESES.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
                </select>
              </Field>
              <Field label="Target XRP allocation" id="research-target">
                <select id="research-target" value={draft.targetBaseBps} onChange={(event) => setDraft((current) => ({ ...current, targetBaseBps: Number(event.target.value) as ResearchDemoDraft["targetBaseBps"] }))} className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
                  <option value={4_000}>40%</option><option value={5_000}>50%</option><option value={6_000}>60%</option>
                </select>
              </Field>
              <Field label="Allocation band" id="research-band">
                <select id="research-band" value={draft.bandBps} onChange={(event) => setDraft((current) => ({ ...current, bandBps: Number(event.target.value) as ResearchDemoDraft["bandBps"] }))} className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
                  <option value={250}>±2.5%</option><option value={500}>±5%</option><option value={1_000}>±10%</option>
                </select>
              </Field>
              <Field label="Maximum modeled trade" id="research-max-trade">
                <select id="research-max-trade" value={draft.maxTradeQuote} onChange={(event) => setDraft((current) => ({ ...current, maxTradeQuote: Number(event.target.value) as ResearchDemoDraft["maxTradeQuote"] }))} className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
                  <option value={10}>10 test-RLUSD</option><option value={25}>25 test-RLUSD</option><option value={50}>50 test-RLUSD</option>
                </select>
              </Field>
              <Field label="Assumed slippage" id="research-slippage">
                <select id="research-slippage" value={draft.assumedSlippageBps} onChange={(event) => setDraft((current) => ({ ...current, assumedSlippageBps: Number(event.target.value) as ResearchDemoDraft["assumedSlippageBps"] }))} className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
                  <option value={10}>10 bps</option><option value={25}>25 bps</option><option value={75}>75 bps</option>
                </select>
              </Field>
              <Field label="Minimum research edge" id="research-edge">
                <select id="research-edge" value={draft.minimumNetEdgeBps} onChange={(event) => setDraft((current) => ({ ...current, minimumNetEdgeBps: Number(event.target.value) as ResearchDemoDraft["minimumNetEdgeBps"] }))} className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
                  <option value={0}>0 bps</option><option value={20}>20 bps</option><option value={50}>50 bps</option>
                </select>
              </Field>
            </div>
            <div className="flex flex-col gap-3 border-t border-border bg-surface px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div aria-live="polite" className="min-w-0">
                <p className="text-sm font-medium">{dirty ? "Parameters changed · run to update the evidence" : `Simulated run ${runNumber} · deterministic result`}</p>
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={result.fingerprint}>Evidence fingerprint · {result.fingerprint}</p>
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <button type="button" onClick={reset} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-4 text-sm font-medium hover:bg-muted/60">
                  <RotateCcw className="size-3.5" aria-hidden="true" /> Reset
                </button>
                <button type="button" onClick={run} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                  <Play className="size-3.5" aria-hidden="true" /> Run simulated research
                </button>
              </div>
            </div>
          </section>

          <section aria-labelledby="results-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <header className="border-b border-border px-4 py-4 sm:px-5">
              <p className="label-mono">Research output</p>
              <h2 id="results-title" className="mt-1 text-lg font-medium">Strategy, benchmark, and drawdown</h2>
              <p className="mt-2 text-sm font-medium">{hypothesis.title}: {hypothesis.question}</p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">Each evaluation window opens at pre-trade marked equity, so modeled costs at its boundary observation remain inside return and drawdown.</p>
            </header>
            <dl className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Full strategy" value={signedBps(report.metrics.full.strategyReturnBps)} />
              <Metric label="Hold benchmark" value={signedBps(report.metrics.full.benchmarkReturnBps)} />
              <Metric label="Excess vs benchmark" value={signedBps(report.metrics.full.excessReturnBps)} />
              <Metric label="Maximum drawdown" value={signedBps(-report.metrics.full.maxDrawdownBps)} />
            </dl>
            <div className="grid gap-4 px-4 py-5 sm:grid-cols-2 sm:px-5">
              <Window title="Training window" metrics={report.metrics.inSample} />
              <Window title="Out-of-sample window" metrics={report.metrics.outOfSample} />
            </div>
          </section>

          <section aria-labelledby="hypothesis-comparison-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <header className="border-b border-border px-4 py-4 sm:px-5">
              <p className="label-mono">Sample comparison</p>
              <h2 id="hypothesis-comparison-title" className="mt-1 text-lg font-medium">How the three simulated hypotheses differ</h2>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">These rows are recomputed from the same deterministic fixture. They are software evidence, not real AI recommendations or expected returns.</p>
            </header>
            <div className="overflow-x-auto" role="region" aria-label="Simulated hypothesis comparison" tabIndex={0}>
              <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
                <thead className="border-b border-border bg-surface">
                  <tr className="label-mono text-[10px]">
                    <th scope="col" className="px-4 py-3 font-medium">Hypothesis</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Strategy</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Excess</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Drawdown</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Fills</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Modeled costs</th>
                    <th scope="col" className="px-4 py-3"><span className="sr-only">Use hypothesis</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {HYPOTHESIS_RESULTS.map((entry) => {
                    const metrics = entry.result.report.metrics.full;
                    return (
                      <tr key={entry.id} className={draft.hypothesis === entry.id ? "bg-primary-soft/60" : undefined}>
                        <th scope="row" className="px-4 py-3"><span className="block font-medium">{entry.title}</span><span className="mt-1 block max-w-sm text-xs font-normal leading-5 text-muted-foreground">{entry.question}</span></th>
                        <td className="px-4 py-3 text-right font-mono text-xs">{signedBps(metrics.strategyReturnBps)}</td>
                        <td className="px-4 py-3 text-right font-mono text-xs">{signedBps(metrics.excessReturnBps)}</td>
                        <td className="px-4 py-3 text-right font-mono text-xs">{signedBps(-metrics.maxDrawdownBps)}</td>
                        <td className="px-4 py-3 text-right font-mono text-xs">{metrics.tradeCount}</td>
                        <td className="px-4 py-3 text-right font-mono text-xs">{quote(metrics.totalCostsQuote)}</td>
                        <td className="px-4 py-3 text-right"><button type="button" onClick={() => selectHypothesis(entry.id)} className="min-h-11 rounded-md border border-border px-3 text-xs font-medium hover:bg-muted/60">Use sample</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="trades-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <header className="flex flex-col gap-2 border-b border-border px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-5">
              <div>
                <p className="label-mono">Deterministic event log</p>
                <h2 id="trades-title" className="mt-1 text-lg font-medium">Modeled research fills</h2>
              </div>
              <p className="font-mono text-xs text-muted-foreground">{report.trades.length} fills · {report.metrics.full.partialFillCount} partial</p>
            </header>
            <div className="overflow-x-auto" role="region" aria-label="Modeled research fills table" tabIndex={0}>
              <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
                <caption className="sr-only">Simulated fills with observed ledger, direction, requested gross value, gross notional, signed net cash flow, and modeled costs.</caption>
                <thead className="border-b border-border bg-surface">
                  <tr className="label-mono text-[10px]">
                    <th scope="col" className="px-4 py-3 font-medium">Observation</th>
                    <th scope="col" className="px-4 py-3 font-medium">Ledger</th>
                    <th scope="col" className="px-4 py-3 font-medium">Side</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Requested gross</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Gross notional</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Net cash flow</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Modeled costs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {report.trades.map((trade) => (
                    <tr key={trade.observationId}>
                      <th scope="row" className="px-4 py-3 font-mono text-xs font-medium">{trade.observationId}{trade.partial ? <span className="ml-2 text-warning">partial</span> : null}</th>
                      <td className="px-4 py-3 font-mono text-xs">{trade.ledgerIndex}</td>
                      <td className="px-4 py-3">{trade.side.replaceAll("_", " ")}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{quote(trade.requestedGrossQuote)}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{quote(trade.grossNotionalQuote)}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{quote(trade.netCashFlowQuote)}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{quote(trade.modeledCostsQuote)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="arbitrage-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <header className="border-b border-border px-4 py-4 sm:px-5">
              <p className="label-mono">Research alerts only</p>
              <h2 id="arbitrage-title" className="mt-1 text-lg font-medium">CLOB ↔ native XRPL AMM comparison</h2>
            </header>
            <div className="px-4 py-5 sm:px-5">
              <p className="text-sm leading-6 text-muted-foreground">
                Operational alerts require fresh executable quotes from the same validated ledger. This page uses only the labeled deterministic fixture while applying CLOB costs, native constant-product AMM pricing, pool fees, modeled slippage, and two network-fee assumptions. XRPL AMMs are one pool per pair; this is not concentrated-range liquidity.
              </p>
              {arbitrage.alerts.length > 0 ? (
                <ul className="mt-4 space-y-3" aria-label="Arbitrage research alerts">
                  {arbitrage.alerts.map((alert) => <li key={alert.route} className="rounded-xl border border-warning/35 bg-warning/[0.04] px-4 py-3"><p className="font-medium">{alert.route.replaceAll("_", " ")} · {signedBps(alert.netEdgeBps)}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{alert.disclosure}</p></li>)}
                </ul>
              ) : (
                <div role="status" className="mt-4 rounded-xl border border-border bg-surface px-4 py-3">
                  <p className="text-sm font-medium">No qualifying net edge in this fixture</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{arbitrage.reasons.join(" ")}</p>
                </div>
              )}
              <p className="mt-4 text-xs leading-5 text-muted-foreground">No automatic arbitrage execution is implemented or implied. Any future action must return to the existing builder, capability, policy, and wallet-approval flow.</p>
            </div>
          </section>
        </div>

        <aside className="min-w-0 space-y-5" aria-label="Research assumptions and dataset coverage">
          <section aria-labelledby="assumptions-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <header className="border-b border-border px-4 py-3"><h2 id="assumptions-title" className="text-sm font-medium">Explicit assumptions</h2></header>
            <dl className="divide-y divide-border text-xs">
              <Limit label="Target / band" value={`${report.assumptions.targetBaseBps / 100}% / ±${report.assumptions.bandBps / 100}%`} />
              <Limit label="Maximum gross notional" value={`${report.assumptions.maxTradeQuote} test-RLUSD`} />
              <Limit label="Venue fee" value={`${report.assumptions.venueFeeBps} bps`} />
              <Limit label="Modeled slippage" value={`${report.assumptions.assumedSlippageBps} bps`} />
              <Limit label="Network fee / fill" value={`${report.assumptions.networkFeeQuote} test-RLUSD`} />
              <Limit label="Liquidity" value="Capped by observed CLOB side" />
            </dl>
          </section>

          <section aria-labelledby="coverage-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <header className="border-b border-border px-4 py-3"><h2 id="coverage-title" className="text-sm font-medium">Dataset contract</h2></header>
            <div className="px-4 py-4">
              <div className="flex items-center gap-2 text-sm font-medium"><Database className="size-4 text-primary" aria-hidden="true" />{fixture.label}</div>
              <dl className="mt-4 space-y-3 text-xs">
                <Row label="Source kind" value={fixture.source_kind.replaceAll("_", " ")} />
                <Row label="Observed / expected" value={`${report.coverage.observed} / ${report.coverage.expected}`} />
                <Row label="Missing intervals" value={String(report.coverage.missing)} />
                <Row label="Coverage" value={`${report.coverage.coveragePercent}%`} />
                <Row label="Interval / tolerance" value={`${fixture.coverage.expected_interval_seconds}s / ±${fixture.coverage.alignment_tolerance_seconds}s`} />
                <Row label="Training ends" value={fixture.split.train_end_at} />
                <Row label="OOS starts" value={fixture.split.out_of_sample_start_at} />
              </dl>
              <meter className="mt-4 h-2 w-full" min={0} max={100} value={report.coverage.coveragePercent} aria-label="Dataset coverage percent">{report.coverage.coveragePercent}%</meter>
            </div>
          </section>

          <details className="overflow-hidden rounded-xl border border-border bg-card shadow-sm motion-reduce:transition-none">
            <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium">Availability gates</summary>
            <ul className="space-y-2 border-t border-border px-4 py-4 text-xs leading-5 text-muted-foreground">
              <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-executed" aria-hidden="true" />Dataset shape and provenance validated.</li>
              <li className="flex gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />Validated historical coverage is not supplied.</li>
              <li className="flex gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />Fixture results cannot be live-submitted.</li>
            </ul>
          </details>

          <section aria-labelledby="optional-account-title" className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <p className="label-mono text-primary">Optional transition</p>
            <h2 id="optional-account-title" className="mt-1 text-sm font-medium">Keep exploring without an account</h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">This demo needs no wallet or sign-in. If you connect later, this local fixture state is discarded; it never becomes an approval, mandate, order, or research authority.</p>
            <a href="/onboarding" className="link-dashed mt-3 inline-flex min-h-11 items-center text-sm font-medium text-foreground">Connect a wallet only when you choose</a>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="bg-card px-4 py-4"><dt className="label-mono text-[10px]">{label}</dt><dd className="mt-1 font-mono text-sm font-medium">{value}</dd></div>;
}

function Window({ title, metrics }: { title: string; metrics: BacktestMetrics }) {
  return <article className="rounded-xl border border-border bg-surface px-4 py-4"><h3 className="text-sm font-medium">{title}</h3><p className="mt-1 font-mono text-[10px] text-muted-foreground">{metrics.startAt} → {metrics.endAt}</p><dl className="mt-4 grid grid-cols-2 gap-3"><SmallMetric label="Strategy" value={signedBps(metrics.strategyReturnBps)} /><SmallMetric label="Benchmark" value={signedBps(metrics.benchmarkReturnBps)} /><SmallMetric label="Drawdown" value={signedBps(-metrics.maxDrawdownBps)} /><SmallMetric label="Modeled costs" value={quote(metrics.totalCostsQuote)} /></dl></article>;
}

function SmallMetric({ label, value }: { label: string; value: string }) {
  return <div><dt className="label-mono text-[9px]">{label}</dt><dd className="mt-1 font-mono text-xs font-medium">{value}</dd></div>;
}

function Limit({ label, value }: { label: string; value: string }) {
  return <div className="px-4 py-3"><dt className="label-mono text-[9px]">{label}</dt><dd className="mt-1 font-mono leading-5">{value}</dd></div>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="grid gap-1"><dt className="label-mono text-[9px]">{label}</dt><dd className="break-words font-mono leading-5">{value}</dd></div>;
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return <label htmlFor={id} className="grid gap-2"><span className="label-mono text-[10px]">{label}</span>{children}</label>;
}
