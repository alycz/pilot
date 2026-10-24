"use client";

import {
  ArrowRight,
  CirclePause,
  FlaskConical,
  LockKeyhole,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SkipForward,
} from "lucide-react";
import Link from "next/link";
import React, { useCallback, useEffect, useState } from "react";

import {
  createDemoState,
  DEFAULT_DEMO_POLICY,
  DEMO_MARKET_EVENTS,
  isDemoComplete,
  stepDemoState,
  type DemoDecision,
  type DemoOutcome,
  type DemoPolicy,
} from "./strategy-demo-model";

const outcomeTone: Record<DemoOutcome, string> = {
  hold: "border-border bg-surface text-muted-foreground",
  rebalance: "border-primary/40 bg-primary/[0.08] text-primary",
  blocked: "border-blocked/35 bg-blocked/[0.07] text-blocked",
};

export function StrategySignedOutDemo({ realModeStatus = "Signed out · connect a Testnet budget account when you are ready for actual setup.", onCheckRealMode }: { realModeStatus?: string; onCheckRealMode?: () => void } = {}) {
  const [policy, setPolicy] = useState<DemoPolicy>(DEFAULT_DEMO_POLICY);
  const [state, setState] = useState(() => createDemoState(DEFAULT_DEMO_POLICY));
  const [playing, setPlaying] = useState(false);
  const current = state.history.at(-1)!;
  const complete = isDemoComplete(state);

  const advance = useCallback(() => {
    setState((value) => stepDemoState(value, policy));
  }, [policy]);

  useEffect(() => {
    if (!playing || complete) return;
    const timer = window.setInterval(advance, 1_800);
    return () => window.clearInterval(timer);
  }, [advance, complete, playing]);

  useEffect(() => {
    if (complete) setPlaying(false);
  }, [complete]);

  const updatePolicy = (patch: Partial<DemoPolicy>) => {
    const next = { ...policy, ...patch };
    setPolicy(next);
    setState(createDemoState(next));
    setPlaying(false);
  };

  const reset = () => {
    setState(createDemoState(policy));
    setPlaying(false);
  };

  return (
    <div className="min-w-0">
      <section aria-labelledby="strategy-demo-title" className="relative overflow-hidden border-b border-border">
        <div aria-hidden="true" className="bg-rules absolute inset-0" />
        <div className="relative px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <p className="label-mono flex items-center gap-2 text-primary">
                <FlaskConical className="size-3.5" aria-hidden="true" />
                Illustrative simulation · client only
              </p>
              <h1 id="strategy-demo-title" className="mt-3 text-2xl font-medium tracking-tight sm:text-3xl">
                Explore bounded autonomous strategies
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                Review the exact declarative strategies Pilot supports, then step through one allocation-drift example to see when policy holds, plans one order, or blocks. The simulator itself uses no wallet, live prices, model, network-dependent sample data, scheduler, or trading authority.
              </p>
            </div>
            <dl className="bracket bracket-accent grid shrink-0 grid-cols-2 border border-primary/30 bg-card">
              <Metric label="Sample events" value={`${state.cursor + 1} / ${DEMO_MARKET_EVENTS.length}`} />
              <Metric label="Mode" value={playing ? "Playing" : complete ? "Complete" : "Paused"} />
            </dl>
          </div>
        </div>
      </section>

      <div className="grid min-w-0 gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-5">
          <section aria-labelledby="simulation-controls-title" className="bracket border border-border bg-card">
            <header className="flex flex-col gap-4 border-b border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div>
                <p className="label-mono">Deterministic walkthrough</p>
                <h2 id="simulation-controls-title" className="mt-1 text-lg font-medium">Sample market controls</h2>
              </div>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Simulation playback controls">
                <button
                  type="button"
                  aria-pressed={playing}
                  disabled={complete}
                  onClick={() => setPlaying((value) => !value)}
                  className="inline-flex min-h-11 items-center gap-2 border border-primary/45 bg-primary/[0.07] px-3 text-sm font-medium transition hover:bg-primary/[0.12] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                >
                  {playing ? <CirclePause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
                  {playing ? "Pause simulation" : "Play simulation"}
                </button>
                <button type="button" disabled={complete || playing} onClick={advance} className="inline-flex min-h-11 items-center gap-2 border border-border px-3 text-sm transition hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none">
                  <SkipForward className="size-4" aria-hidden="true" />Step to next event
                </button>
                <button type="button" onClick={reset} className="inline-flex min-h-11 items-center gap-2 border border-border px-3 text-sm transition hover:bg-surface motion-reduce:transition-none">
                  <RotateCcw className="size-4" aria-hidden="true" />Reset simulation
                </button>
              </div>
            </header>

            <div className="grid gap-6 px-4 py-5 sm:grid-cols-2 sm:px-5">
              <RangeControl
                label="Target XRP allocation"
                value={policy.targetXrpPercent}
                min={30}
                max={70}
                suffix="%"
                onChange={(value) => updatePolicy({ targetXrpPercent: value })}
              />
              <RangeControl
                label="Allowed drift on either side"
                value={policy.driftPercent}
                min={2}
                max={15}
                suffix="%"
                onChange={(value) => updatePolicy({ driftPercent: value })}
              />
            </div>
          </section>

          <DecisionPanel decision={current} />
          <PortfolioPanel decision={current} dailyCap={policy.maxDailyValue} />
          <Timeline history={state.history} cursor={state.cursor} />
        </div>

        <aside className="min-w-0 space-y-5">
          <section aria-labelledby="demo-capabilities-title" className="border border-border bg-card">
            <header className="border-b border-border px-4 py-3">
              <p className="label-mono">Supported declarative grammar</p>
              <h2 id="demo-capabilities-title" className="mt-1 text-sm font-medium">Three bounded strategy patterns</h2>
            </header>
            <ol className="divide-y divide-border text-xs leading-5">
              <li className="px-4 py-3"><strong className="text-foreground">Scheduled fixed-size trade</strong><span className="mt-1 block text-muted-foreground">An always rule at a 5–1,440 minute interval, bounded by expiry, cooldown, trade-count, value, fee, exposure, liquidity and slippage limits.</span></li>
              <li className="px-4 py-3"><strong className="text-foreground">Price-threshold buy or sell</strong><span className="mt-1 block text-muted-foreground">A bid/ask threshold may propose one allowlisted XRP/test-RLUSD fill-or-kill order only after a fresh executable quote passes every mandate limit.</span></li>
              <li className="px-4 py-3"><strong className="text-foreground">Allocation-drift rebalance</strong><span className="mt-1 block text-muted-foreground">An out-of-band allocation rule may propose one bounded adjustment. Rules are ordered and first-match, so one evaluation can plan at most one action.</span></li>
            </ol>
            <p className="border-t border-border bg-surface px-4 py-3 text-xs leading-5 text-muted-foreground">Unsupported assets, venues, URLs, scripts, recursive plans, arbitrary actions and unavailable data are rejected. New capabilities require reviewed primitive registration; the agent cannot load code.</p>
          </section>

          <section aria-labelledby="demo-limits-title" className="border border-border bg-card">
            <header className="border-b border-border px-4 py-3">
              <p className="label-mono flex items-center gap-2"><ShieldCheck className="size-3.5 text-executed" aria-hidden="true" />Illustrative limits</p>
              <h2 id="demo-limits-title" className="mt-1 text-sm font-medium">What the policy checks</h2>
            </header>
            <dl className="divide-y divide-border">
              <Limit label="Allocation band" value={`${policy.targetXrpPercent - policy.driftPercent}–${policy.targetXrpPercent + policy.driftPercent}% XRP`} />
              <Limit label="Order / daily value" value={`${policy.maxOrderValue.toFixed(0)} / ${policy.maxDailyValue.toFixed(0)} test-RLUSD`} />
              <Limit label="Quote age" value={`≤ ${policy.maxQuoteAgeSeconds}s`} />
              <Limit label="Executable liquidity" value={`≥ ${policy.minimumLiquidityValue} test-RLUSD`} />
              <Limit label="Fee / price impact" value={`≤ ${policy.maxFeeDrops} drops / ${policy.maxPriceImpactBps} bps`} />
            </dl>
          </section>

          <section aria-labelledby="demo-boundary-title" className="border border-border bg-card p-4">
            <p className="label-mono flex items-center gap-2"><LockKeyhole className="size-3.5 text-primary" aria-hidden="true" />How the boundary works</p>
            <h2 id="demo-boundary-title" className="mt-2 text-sm font-medium">Policy → simulation → approval</h2>
            <ol className="mt-3 space-y-3 text-xs leading-5 text-muted-foreground">
              <li><strong className="text-foreground">1 · Policy</strong> checks drift and every limit before an order is considered.</li>
              <li><strong className="text-foreground">2 · Simulation</strong> sizes a hypothetical adjustment using fixed sample inputs.</li>
              <li><strong className="text-foreground">3 · Approval</strong> is a separate real-mode wallet mandate. This demo cannot create one or trade.</li>
            </ol>
          </section>

          <section aria-labelledby="demo-assumptions-title" className="border border-border bg-surface p-4">
            <p className="label-mono">Sample assumptions</p>
            <h2 id="demo-assumptions-title" className="sr-only">Sample assumptions</h2>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
              <li>• Starts with 100 XRP + 50 test-RLUSD.</li>
              <li>• Prices are fixed examples in test-RLUSD per XRP.</li>
              <li>• Adjustments ignore spread and do not predict live fills.</li>
              <li>• No performance or return is estimated.</li>
            </ul>
          </section>

          <section aria-labelledby="real-strategy-title" className="bracket bracket-accent border border-primary/35 bg-card p-4">
            <p className="label-mono text-primary">Actual Testnet setup</p>
            <h2 id="real-strategy-title" className="mt-2 text-sm font-medium">Connect a budget account to continue</h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">Real setup remains unavailable while signed out. Connecting starts a separate wallet and mandate flow; this simulation never grants trading authority.</p>
            <p role="note" className="mt-3 border-l-2 border-approval/50 pl-3 text-xs leading-5 text-muted-foreground">{realModeStatus}</p>
            {onCheckRealMode ? <button type="button" onClick={onCheckRealMode} className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-border px-3 text-sm transition hover:bg-surface motion-reduce:transition-none"><RefreshCw className="size-3.5" aria-hidden="true" />Check real-mode availability</button> : null}
            <Link href="/onboarding" className="mt-4 inline-flex min-h-11 items-center gap-2 border border-primary/45 bg-primary/[0.08] px-3 font-mono text-[11px] font-medium uppercase tracking-wide transition hover:bg-primary/[0.13] motion-reduce:transition-none">
              Connect account for Testnet setup <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}

function RangeControl({ label, value, min, max, suffix, onChange }: { label: string; value: number; min: number; max: number; suffix: string; onChange: (value: number) => void }) {
  return (
    <label className="block min-w-0">
      <span className="flex items-center justify-between gap-3"><span className="label-mono">{label}</span><output className="font-mono text-sm font-medium">{value}{suffix}</output></span>
      <input aria-label={label} aria-valuetext={`${value}${suffix}`} className="mt-4 h-11 w-full accent-[var(--primary)]" type="range" min={min} max={max} step={1} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <span className="flex justify-between font-mono text-[10px] uppercase text-muted-foreground"><span>{min}{suffix}</span><span>{max}{suffix}</span></span>
    </label>
  );
}

function DecisionPanel({ decision }: { decision: DemoDecision }) {
  return (
    <section aria-labelledby="current-decision-title" className="border border-border bg-card" aria-live="polite">
      <header className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div>
          <p className="label-mono">Current illustrative decision</p>
          <h2 id="current-decision-title" className="mt-1 text-lg font-medium">{decision.event.label}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">T+{decision.event.offsetMinutes} min · sample XRP price {decision.event.xrpPrice.toFixed(2)} test-RLUSD</p>
        </div>
        <span role="status" aria-label={`Simulation decision: ${decision.outcome}`} className={`inline-flex w-fit border px-2.5 py-1.5 font-mono text-[11px] font-medium uppercase tracking-wide ${outcomeTone[decision.outcome]}`}>{decision.outcome}</span>
      </header>
      <div className="px-4 py-4 sm:px-5">
        <p className="text-sm font-medium leading-6">{decision.reason}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{decision.event.detail}</p>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2" aria-label="Policy check results">
          {decision.checks.map((check) => {
            const allocationBand = check.label === "Allocation band";
            const label = allocationBand ? (check.passed ? "Trigger" : "Within band") : check.passed ? "Pass" : "Stop";
            const tone = allocationBand ? (check.passed ? "text-primary" : "text-executed") : check.passed ? "text-executed" : "text-blocked";
            return <li key={check.label} className="border border-border bg-surface px-3 py-2.5"><p className={`font-mono text-[10px] font-medium uppercase tracking-wide ${tone}`}>{label} · {check.label}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{check.detail}</p></li>;
          })}
        </ul>
      </div>
    </section>
  );
}

export const SignedOutStrategyDemo = StrategySignedOutDemo;

function PortfolioPanel({ decision, dailyCap }: { decision: DemoDecision; dailyCap: number }) {
  const portfolio = decision.portfolioAfter;
  const price = decision.event.xrpPrice;
  const xrpValue = portfolio.xrp * price;
  const totalValue = xrpValue + portfolio.testRlusd;
  const xrpPercent = totalValue > 0 ? xrpValue / totalValue * 100 : 0;
  const stablePercent = 100 - xrpPercent;
  return (
    <section aria-labelledby="sample-portfolio-title" className="border border-border bg-card">
      <header className="border-b border-border px-4 py-3"><h2 id="sample-portfolio-title" className="text-sm font-medium">Simulated portfolio allocation</h2></header>
      <div className="px-4 py-5 sm:px-5">
        <div className="flex h-4 overflow-hidden border border-border bg-surface" role="img" aria-label={`${xrpPercent.toFixed(1)} percent XRP and ${stablePercent.toFixed(1)} percent test-RLUSD`}>
          <div className="bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${xrpPercent}%` }} />
          <div className="bg-info/55 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${stablePercent}%` }} />
        </div>
        <dl className="mt-4 grid gap-px bg-border sm:grid-cols-4">
          <Metric label="XRP allocation" value={`${xrpPercent.toFixed(1)}%`} compact />
          <Metric label="XRP balance" value={`${portfolio.xrp.toFixed(2)} XRP`} compact />
          <Metric label="test-RLUSD" value={portfolio.testRlusd.toFixed(2)} compact />
          <Metric label="Daily simulated" value={`${portfolio.dailyUsed.toFixed(2)} / ${dailyCap.toFixed(0)}`} compact />
        </dl>
      </div>
    </section>
  );
}

function Timeline({ history, cursor }: { history: DemoDecision[]; cursor: number }) {
  return (
    <section aria-labelledby="event-timeline-title" aria-label="Illustrative event timeline" className="border border-border bg-card">
      <header className="border-b border-border px-4 py-3"><h2 id="event-timeline-title" className="text-sm font-medium">Event timeline</h2></header>
      <ol className="divide-y divide-border">
        {DEMO_MARKET_EVENTS.map((event, index) => {
          const decision = history[index];
          const current = index === cursor;
          const upcoming = index > cursor;
          return <li key={event.id} aria-current={current ? "step" : undefined} data-upcoming={upcoming || undefined} className={`grid gap-2 px-4 py-3 sm:grid-cols-[4.25rem_minmax(0,1fr)_7rem] sm:items-center ${current ? "bg-primary/[0.055]" : ""} ${upcoming ? "bg-surface/35" : ""}`}><span data-demo-timeline-time className="label-mono text-[10px] text-foreground">T+{event.offsetMinutes} min</span><span className="min-w-0"><span className="block text-sm font-medium">{event.label}</span><span data-demo-timeline-price className="mt-0.5 block text-xs leading-5 text-foreground">{event.xrpPrice.toFixed(2)} test-RLUSD / XRP</span></span><span className={`font-mono text-[10px] font-medium uppercase tracking-wide ${decision?.outcome === "blocked" ? "text-blocked" : decision?.outcome === "rebalance" ? "text-primary" : "text-muted-foreground"}`}>{decision?.outcome ?? "Upcoming"}</span></li>;
        })}
      </ol>
    </section>
  );
}

function Metric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return <div className={compact ? "bg-card px-3 py-3" : "min-w-[8.5rem] px-4 py-3"}><dt className="label-mono text-[10px]">{label}</dt><dd className="mt-1 font-mono text-xs font-medium">{value}</dd></div>;
}

function Limit({ label, value }: { label: string; value: string }) {
  return <div className="px-4 py-3"><dt className="label-mono text-[10px]">{label}</dt><dd className="mt-1 font-mono text-xs leading-5">{value}</dd></div>;
}
