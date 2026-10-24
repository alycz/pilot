"use client";

import {
  ArrowRight,
  Bot,
  CalendarClock,
  CirclePause,
  FlaskConical,
  Gauge,
  Play,
  RotateCcw,
  RefreshCw,
  Scale,
  ShieldCheck,
  SkipForward,
  type LucideIcon,
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
  hold: "border-border-strong bg-card text-foreground",
  rebalance: "border-primary/45 bg-primary-soft text-[color-mix(in_oklab,var(--primary)_85%,var(--foreground))]",
  blocked: "border-blocked/40 bg-blocked/[0.07] text-blocked",
};

const outcomeLabel: Record<DemoOutcome, string> = {
  hold: "Hold",
  rebalance: "Trade",
  blocked: "Blocked",
};

const strategyKinds: readonly { icon: LucideIcon; title: string; body: string; example: string }[] = [
  {
    icon: CalendarClock,
    title: "Recurring buy",
    body: "Buy or sell a fixed amount on a schedule, from every 5 minutes to once a day.",
    example: "Buy 25 RLUSD of XRP every day",
  },
  {
    icon: Gauge,
    title: "Price trigger",
    body: "Trade once when the price crosses a level you set, using a fresh quote.",
    example: "Sell 50 XRP if it reaches 0.80",
  },
  {
    icon: Scale,
    title: "Rebalance",
    body: "Keep your XRP share inside a band. Pilot trades back only when it drifts out.",
    example: "Keep XRP at 50% ± 5%",
  },
];

/**
 * The strategy walkthrough shown before a wallet is connected: what the strategies are,
 * then one rebalance strategy playing through seven market moments.
 */
export function StrategySignedOutDemo({
  realModeStatus = "Signed out · connect a Testnet budget account when you are ready for actual setup.",
  onCheckRealMode,
  onStart,
}: {
  realModeStatus?: string;
  onCheckRealMode?: () => void;
  onStart?: () => void;
} = {}) {
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
      {/* Header, in the same style as Map and Portfolio */}
      <section aria-labelledby="strategy-demo-title" className="relative overflow-hidden border-b border-border">
        <div className="relative flex flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8 lg:py-10">
          <div className="max-w-2xl">
            <p className="label-mono flex items-center gap-2 text-primary">
              <FlaskConical className="size-3.5" aria-hidden="true" />
              Illustrative simulation · client only
            </p>
            <h1 id="strategy-demo-title" className="mt-3 text-balance text-[2rem] font-semibold leading-tight tracking-[-0.025em] text-foreground sm:text-[2.5rem] font-display">
              Set the rules once. Pilot trades inside them.
            </h1>
            <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
              Explore how bounded strategies react to fixed sample events. This client-only simulation never connects a wallet, grants a mandate, submits an order or changes live Testnet state.
            </p>
          </div>
          {onStart ? (
            <button
              type="button"
              onClick={onStart}
              className="bracket bracket-light inline-flex h-11 shrink-0 items-center gap-2 self-start bg-primary px-4 text-[13px] text-primary-foreground transition hover:bg-primary/90 lg:self-auto rounded-md"
            >
              Try it in chat <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
          ) : (
            <Link
              href="/onboarding"
              className="bracket bracket-light inline-flex h-11 shrink-0 items-center gap-2 self-start bg-primary px-4 text-[13px] text-primary-foreground transition hover:bg-primary/90 lg:self-auto rounded-md"
            >
              Start a strategy <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          )}
        </div>
      </section>

      <div className="space-y-8 px-4 py-8 sm:px-6 lg:px-8">
        {/* The three kinds */}
        <section aria-labelledby="demo-capabilities-title">
          <h2 id="demo-capabilities-title" className="label-mono">Three kinds of strategy</h2>
          <ol className="mt-3 grid gap-px border border-border bg-border md:grid-cols-3 rounded-xl overflow-hidden">
            {strategyKinds.map(({ icon: Icon, title, body, example }) => (
              <li key={title} className="flex flex-col bg-card p-5">
                <span className="grid size-9 place-items-center border border-border-strong text-foreground rounded-md">
                  <Icon className="size-4" strokeWidth={1.75} aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-[15px] font-medium text-foreground">{title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{body}</p>
                <p className="mt-4 border-t border-border pt-3 font-mono text-[11px] text-foreground/80">{example}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* One strategy, playing */}
        <section aria-labelledby="strategy-run-title" className="border border-border bg-card rounded-xl overflow-hidden">
          <header className="flex flex-col gap-4 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="label-mono">Watch one run</p>
              <h2 id="strategy-run-title" className="mt-1 text-xl font-normal tracking-[-0.01em] text-foreground">Rebalance XRP and RLUSD</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Playback">
              <span className="mr-1 font-mono text-[11px] tabular-nums text-muted-foreground">{state.cursor + 1} / {DEMO_MARKET_EVENTS.length}</span>
              <button type="button" onClick={reset} className="bracket bracket-light inline-flex h-10 items-center gap-2 border border-border px-3.5 text-[13px] transition hover:bg-white/[0.05] motion-reduce:transition-none pointer-coarse:h-11 rounded-md">
                <RotateCcw className="size-3.5" aria-hidden="true" />Reset
              </button>
              <button type="button" disabled={complete || playing} onClick={advance} className="bracket bracket-light inline-flex h-10 items-center gap-2 border border-border px-3.5 text-[13px] transition hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none pointer-coarse:h-11 rounded-md">
                <SkipForward className="size-3.5" aria-hidden="true" />Next event
              </button>
              <button
                type="button"
                aria-pressed={playing}
                disabled={complete}
                onClick={() => setPlaying((value) => !value)}
                className="inline-flex h-10 items-center gap-2 bg-primary px-3.5 text-[13px] text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none pointer-coarse:h-11 rounded-md"
              >
                {playing ? <CirclePause className="size-3.5" aria-hidden="true" /> : <Play className="size-3.5" aria-hidden="true" />}
                {playing ? "Pause" : "Play"}
              </button>
            </div>
          </header>

          {/* Your rule */}
          <div className="grid gap-6 border-b border-border px-5 py-5 sm:grid-cols-2">
            <RangeControl label="Target XRP share" value={policy.targetXrpPercent} min={30} max={70} suffix="%" onChange={(value) => updatePolicy({ targetXrpPercent: value })} />
            <RangeControl label="Allowed drift either way" value={policy.driftPercent} min={2} max={15} suffix="%" onChange={(value) => updatePolicy({ driftPercent: value })} />
          </div>

          <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_19rem]">
            <div className="min-w-0 space-y-6 p-5 lg:border-r lg:border-border">
              <DecisionPanel decision={current} />
              <PortfolioPanel decision={current} dailyCap={policy.maxDailyValue} />
            </div>
            <aside aria-labelledby="demo-limits-title" className="border-t border-border lg:border-t-0">
              <p id="demo-limits-title" className="label-mono flex items-center gap-2 border-b border-border px-5 py-3">
                <ShieldCheck className="size-3.5 text-executed" aria-hidden="true" />Checked before every trade
              </p>
              <dl className="divide-y divide-border">
                <Limit label="Allowed band" value={`${policy.targetXrpPercent - policy.driftPercent}–${policy.targetXrpPercent + policy.driftPercent}% XRP`} />
                <Limit label="Per trade / per day" value={`${policy.maxOrderValue.toFixed(0)} / ${policy.maxDailyValue.toFixed(0)} RLUSD`} />
                <Limit label="Quote age" value={`${policy.maxQuoteAgeSeconds}s or newer`} />
                <Limit label="Liquidity" value={`${policy.minimumLiquidityValue} RLUSD or more`} />
                <Limit label="Fee / price impact" value={`${policy.maxFeeDrops} drops / ${policy.maxPriceImpactBps} bps max`} />
              </dl>
            </aside>
          </div>

          <Timeline history={state.history} cursor={state.cursor} />
        </section>

        {/* Start for real */}
        <section aria-labelledby="real-strategy-title" className="flex flex-col gap-4 border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6 rounded-xl overflow-hidden">
          <div>
            <p className="label-mono text-primary">Actual Testnet setup</p>
            <h2 id="real-strategy-title" className="mt-1 text-[15px] font-medium text-foreground">Connect a budget account to continue</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">Real setup remains unavailable while signed out. Connecting starts a separate wallet and mandate flow; this simulation never grants trading authority.</p>
            <p role="note" className="mt-3 border-l-2 border-approval/50 pl-3 text-xs leading-5 text-muted-foreground">{realModeStatus}</p>
          </div>
          <div className="flex shrink-0 flex-col gap-2">
            {onCheckRealMode ? <button type="button" onClick={onCheckRealMode} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm transition hover:bg-surface motion-reduce:transition-none"><RefreshCw className="size-3.5" aria-hidden="true" />Check real-mode availability</button> : null}
            <Link href="/onboarding" className="bracket bracket-light inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-[13px] text-primary-foreground transition hover:bg-primary/90">
              Connect account for Testnet setup <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

function RangeControl({ label, value, min, max, suffix, onChange }: { label: string; value: number; min: number; max: number; suffix: string; onChange: (value: number) => void }) {
  return (
    <label className="block min-w-0">
      <span className="flex items-baseline justify-between gap-3">
        <span className="label-mono">{label}</span>
        <output className="text-xl font-normal tabular-nums text-foreground">{value}{suffix}</output>
      </span>
      <input aria-label={label} aria-valuetext={`${value}${suffix}`} className="mt-3 h-8 w-full accent-[var(--primary)]" type="range" min={min} max={max} step={1} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <span className="flex justify-between font-mono text-[10px] text-muted-foreground"><span>{min}{suffix}</span><span>{max}{suffix}</span></span>
    </label>
  );
}

function DecisionPanel({ decision }: { decision: DemoDecision }) {
  return (
    <div aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label-mono">T+{decision.event.offsetMinutes} min · XRP {decision.event.xrpPrice.toFixed(2)} RLUSD</p>
          <h3 className="mt-1.5 text-2xl font-normal tracking-[-0.015em] text-foreground">{decision.event.label}</h3>
        </div>
        <span role="status" aria-label={`Decision: ${outcomeLabel[decision.outcome]}`} className={`inline-flex items-center border px-3 py-1.5 text-[13px] font-medium transition-colors duration-300 motion-reduce:transition-none rounded-xl ${outcomeTone[decision.outcome]}`}>
          {outcomeLabel[decision.outcome]}
        </span>
      </div>
      <p className="mt-3 text-[15px] leading-7 text-foreground">{plainReason(decision.reason)}</p>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{decision.event.detail}</p>
      <ul className="mt-4 grid gap-px border border-border bg-border sm:grid-cols-2 rounded-xl overflow-hidden" aria-label="Checks">
        {decision.checks.map((check) => {
          const band = check.label === "Allocation band";
          const label = band ? (check.passed ? "Out of band" : "In band") : check.passed ? "Pass" : "Fail";
          const tone = band ? (check.passed ? "text-[color-mix(in_oklab,var(--primary)_85%,var(--foreground))]" : "text-executed") : check.passed ? "text-executed" : "text-blocked";
          return (
            <li key={check.label} className="bg-card px-3.5 py-3 sm:[&:last-child:nth-child(odd)]:col-span-2">
              <p className="flex items-baseline justify-between gap-2 text-xs text-foreground">
                {band ? "Allowed band" : check.label}
                <span className={`text-xs font-medium ${tone}`}>{label}</span>
              </p>
              <p className="mt-1 font-mono text-[11px] leading-5 text-muted-foreground">{check.detail}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The model's reasons start with a shouted verdict; the chip already shows it. */
function plainReason(reason: string): string {
  return reason.replace(/^(HOLD|BLOCKED|REBALANCE) — /, "");
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
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="label-mono">Portfolio after this event</p>
        <p className="font-mono text-[11px] text-muted-foreground">{xrpPercent.toFixed(1)}% XRP · {stablePercent.toFixed(1)}% RLUSD</p>
      </div>
      <div className="mt-3 flex h-3 overflow-hidden border border-border bg-background rounded-xl" role="img" aria-label={`${xrpPercent.toFixed(1)} percent XRP and ${stablePercent.toFixed(1)} percent RLUSD`}>
        <div className="bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${xrpPercent}%` }} />
        <div className="bg-info/50 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${stablePercent}%` }} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-3 rounded-xl overflow-hidden">
        <Metric label="XRP" value={portfolio.xrp.toFixed(2)} />
        <Metric label="RLUSD" value={portfolio.testRlusd.toFixed(2)} />
        <Metric label="Traded today" value={`${portfolio.dailyUsed.toFixed(2)} / ${dailyCap.toFixed(0)}`} />
      </dl>
    </div>
  );
}

function Timeline({ history, cursor }: { history: DemoDecision[]; cursor: number }) {
  return (
    <section aria-labelledby="event-timeline-title" className="border-t border-border">
      <h3 id="event-timeline-title" className="label-mono px-5 pt-4">Event timeline</h3>
      <ol className="mt-3 grid grid-cols-1 border-t border-border sm:grid-cols-2 lg:grid-cols-7">
        {DEMO_MARKET_EVENTS.map((event, index) => {
          const decision = history[index];
          const current = index === cursor;
          const upcoming = index > cursor;
          const tone = decision?.outcome === "blocked" ? "text-blocked" : decision?.outcome === "rebalance" ? "text-[color-mix(in_oklab,var(--primary)_85%,var(--foreground))]" : "text-muted-foreground";
          return (
            <li
              key={event.id}
              aria-current={current ? "step" : undefined}
              data-upcoming={upcoming || undefined}
              className={`relative border-b border-border px-4 py-3.5 transition-colors duration-300 motion-reduce:transition-none lg:border-b-0 lg:border-r lg:last:border-r-0 ${current ? "bg-primary-soft" : ""}`}
            >
              {current ? <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-primary" /> : null}
              <span data-demo-timeline-time className="font-mono text-[10px] text-muted-foreground">T+{event.offsetMinutes}m</span>
              <span className={`mt-1 block text-[13px] leading-snug ${upcoming ? "text-muted-foreground" : "text-foreground"}`}>{event.label}</span>
              <span className="mt-1.5 flex items-baseline justify-between gap-2">
                <span data-demo-timeline-price className="font-mono text-[11px] text-muted-foreground">{event.xrpPrice.toFixed(2)}</span>
                <span className={`text-xs font-medium ${tone}`}>{decision ? outcomeLabel[decision.outcome] : "—"}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="bg-card px-3.5 py-3"><dt className="label-mono">{label}</dt><dd className="mt-1 font-mono text-sm tabular-nums text-foreground">{value}</dd></div>;
}

function Limit({ label, value }: { label: string; value: string }) {
  return <div className="px-5 py-3"><dt className="label-mono">{label}</dt><dd className="mt-1 font-mono text-xs leading-5 text-foreground">{value}</dd></div>;
}
