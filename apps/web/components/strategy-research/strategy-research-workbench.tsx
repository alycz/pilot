import { AlertTriangle, Database, FlaskConical, ShieldCheck } from "lucide-react";
import React from "react";

import { researchArbitrage } from "./arbitrage";
import { runBacktest, type BacktestMetrics } from "./backtest";
import { DETERMINISTIC_STRATEGY_FIXTURE, FIXTURE_DISCLOSURE } from "./fixtures";

const report = runBacktest(DETERMINISTIC_STRATEGY_FIXTURE, {
  initialBase: 100,
  initialQuote: 50,
  targetBaseBps: 5_000,
  bandBps: 500,
  maxTradeQuote: 25,
  venueFeeBps: 10,
  assumedSlippageBps: 25,
  networkFeeQuote: 0.01,
});

const arbitrage = researchArbitrage(DETERMINISTIC_STRATEGY_FIXTURE, {
  now: "2026-01-01T08:00:10.000Z",
  tradeSizeBase: 100,
  maxQuoteAgeSeconds: 30,
  clobFeeBps: 10,
  assumedSlippageBps: 25,
  networkFeeQuotePerLeg: 0.01,
  minimumNetEdgeBps: 20,
});

const signedBps = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)} bps`;
const quote = (value: number) => value.toFixed(4);

export function StrategyResearchWorkbench() {
  const fixture = DETERMINISTIC_STRATEGY_FIXTURE;
  return (
    <div className="min-w-0">
      <section aria-labelledby="research-title" className="relative overflow-hidden border-b border-border bg-surface/50">
        <div className="relative px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          <div className="max-w-4xl">
            <p className="label-mono flex items-center gap-2 text-primary">
              <FlaskConical className="size-3.5" aria-hidden="true" />
              Strategy research · simulation only
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
          <section aria-labelledby="dataset-boundary-title" className="rounded-xl border border-warning/35 bg-warning/[0.045] shadow-sm">
            <div className="flex gap-3 px-4 py-4 sm:px-5">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              <div>
                <p className="label-mono text-warning">Fixture data · historical coverage unavailable</p>
                <h2 id="dataset-boundary-title" className="mt-1 text-base font-medium">Reproducible software evidence, not market performance</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{FIXTURE_DISCLOSURE}</p>
              </div>
            </div>
          </section>

          <section aria-labelledby="results-title" className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <header className="border-b border-border px-4 py-4 sm:px-5">
              <p className="label-mono">Research output</p>
              <h2 id="results-title" className="mt-1 text-lg font-medium">Strategy, benchmark, and drawdown</h2>
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
              <Limit label="Target / band" value="50% / ±5%" />
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
