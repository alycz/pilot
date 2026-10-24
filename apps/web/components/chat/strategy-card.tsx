"use client";

import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  CirclePause,
  CircleStop,
  FileKey2,
  FileText,
  LoaderCircle,
  Play,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import React, { useState } from "react";

import type { StrategyFact } from "./strategy-proposal";

export type StrategyCardState =
  | "drafting"
  | "proposed"
  | "needs_changes"
  | "ready_to_sign"
  | "running"
  | "paused"
  | "stopped";

export const STRATEGY_CARD_STATES: readonly StrategyCardState[] = [
  "drafting", "proposed", "needs_changes", "ready_to_sign", "running", "paused", "stopped",
];

export type StrategyTradeRow = { id: string; at: string; summary: string; hash?: string };

export type StrategyCardData = {
  state: StrategyCardState;
  title: string;
  rules?: string[];
  facts?: StrategyFact[];
  preview?: string;
  issues?: string[];
  /** A short line under the facts: last check result, or why an action is blocked. */
  note?: string;
  noteTone?: "neutral" | "warning";
  usage?: StrategyFact[];
  trades?: StrategyTradeRow[];
  busy?: boolean;
};

export type StrategyCardActions = {
  onSetUp?: () => void;
  setUpBlockedReason?: string;
  onSign?: () => void;
  signLabel?: string;
  signBlockedReason?: string;
  onDiscard?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  resumeBlockedReason?: string;
  onStop?: () => void;
  onDetails?: () => void;
};

type Tone = "neutral" | "active" | "success" | "approval" | "danger";

const toneStyles: Record<Tone, { border: string; icon: string; badge: string }> = {
  neutral: { border: "border-border", icon: "border-border text-muted-foreground", badge: "border-border-strong bg-white/[0.03] text-muted-foreground" },
  active: { border: "border-border", icon: "border-info/30 text-[color-mix(in_oklab,var(--info)_80%,var(--foreground))]", badge: "border-info/35 bg-info/10 text-[color-mix(in_oklab,var(--info)_80%,var(--foreground))]" },
  success: { border: "border-border", icon: "border-executed/30 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]", badge: "border-executed/35 bg-executed/10 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" },
  approval: { border: "border-approval/35", icon: "border-approval/35 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]", badge: "border-approval/40 bg-approval/10 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]" },
  danger: { border: "border-destructive/35", icon: "border-destructive/35 text-[color-mix(in_oklab,var(--destructive)_80%,var(--foreground))]", badge: "border-destructive/40 bg-destructive/10 text-[color-mix(in_oklab,var(--destructive)_80%,var(--foreground))]" },
};

const stateMeta: Record<StrategyCardState, { label: string; subtitle: string; icon: LucideIcon; tone: Tone }> = {
  drafting: { label: "Drafting", subtitle: "Turning your request into rules and checking them against your limits.", icon: LoaderCircle, tone: "neutral" },
  proposed: { label: "Proposed", subtitle: "Here's the plan. Nothing runs until you sign it.", icon: FileText, tone: "active" },
  needs_changes: { label: "Needs changes", subtitle: "This plan can't run as written. Ask Pilot to adjust it.", icon: AlertTriangle, tone: "danger" },
  ready_to_sign: { label: "Ready to sign", subtitle: "Sign once in your wallet to start it. Pilot never holds your key.", icon: FileKey2, tone: "approval" },
  running: { label: "Running", subtitle: "Pilot checks your rules on schedule and trades only inside your limits.", icon: Activity, tone: "success" },
  paused: { label: "Paused", subtitle: "No new trades until you resume.", icon: CirclePause, tone: "approval" },
  stopped: { label: "Stopped", subtitle: "This strategy won't trade again.", icon: CircleStop, tone: "neutral" },
};

const button = "inline-flex h-9 items-center gap-1.5 border px-3.5 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md";
const primaryButton = `${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`;
const approvalButton = `${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`;
const quietButton = `${button} border-border bg-card text-foreground hover:bg-white/[0.05]`;
const dangerButton = `${button} border-blocked/35 bg-card text-blocked hover:bg-blocked/[0.06]`;

/** One chat card for an autonomous strategy, from first draft to stopped. */
export function StrategyCard({ data, actions = {} }: { data: StrategyCardData; actions?: StrategyCardActions }) {
  const meta = stateMeta[data.state];
  const style = toneStyles[meta.tone];
  const Icon = meta.icon;
  const [confirmStop, setConfirmStop] = useState(false);
  const footer = renderFooter(data, actions, confirmStop, setConfirmStop);

  return (
    <article data-strategy-card-state={data.state} aria-label={`${meta.label} strategy: ${data.title}`} className={`min-w-0 overflow-hidden border rounded-xl ${style.border} bg-card`}>
      <div className="flex min-w-0 items-start gap-3 p-4">
        <span className={`grid h-8 w-8 shrink-0 place-items-center border bg-white/[0.02] rounded-md ${style.icon}`}>
          <Icon className={`h-4 w-4 ${data.state === "drafting" ? "animate-spin motion-reduce:animate-none" : ""}`} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h3 className="text-sm font-medium tracking-tight">{data.title}</h3>
            <span className={`inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-xs font-medium rounded ${style.badge}`}>
              {data.state === "running" ? <span aria-hidden="true" className="h-1.5 w-1.5 bg-current motion-safe:animate-pulse" /> : null}
              {meta.label}
            </span>
          </div>
          <p className="mt-1 text-balance text-xs leading-relaxed text-muted-foreground">{meta.subtitle}</p>
        </div>
      </div>

      {data.state === "drafting" ? null : (
        <div className="space-y-3.5 border-t border-border px-4 py-3.5">
          {data.issues?.length ? (
            <ul className="space-y-1.5 text-xs leading-5 text-blocked" aria-label="What to change">
              {data.issues.map((issue) => <li key={issue} className="flex gap-2"><span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 bg-current" />{issue}</li>)}
            </ul>
          ) : null}
          {data.rules?.length ? (
            <div>
              <p className="label-mono">Rules</p>
              <ol className="mt-1.5 space-y-1 text-[13px] leading-5 text-foreground">
                {data.rules.map((rule, index) => (
                  <li key={rule} className="flex gap-2.5"><span className="font-mono text-[11px] leading-5 text-muted-foreground">{index + 1}</span>{rule}</li>
                ))}
              </ol>
            </div>
          ) : null}
          {data.facts?.length ? <FactGrid facts={data.facts} /> : null}
          {data.usage?.length ? <FactGrid facts={data.usage} /> : null}
          {data.preview && (data.state === "proposed" || data.state === "ready_to_sign") ? (
            <p className="flex items-start gap-2 border-l-2 border-info/50 pl-2.5 text-xs leading-5 text-muted-foreground">
              <SlidersHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{data.preview}
            </p>
          ) : null}
          {data.note ? (
            <p className={`text-xs leading-5 ${data.noteTone === "warning" ? "text-[color-mix(in_oklab,var(--approval)_85%,var(--foreground))]" : "text-muted-foreground"}`}>{data.note}</p>
          ) : null}
        </div>
      )}

      {data.trades?.length ? (
        <ol className="border-t border-border" aria-label="Trades made">
          {[...data.trades].reverse().map((trade) => <TradeRow key={trade.id} trade={trade} />)}
        </ol>
      ) : null}

      {footer ? <div className="flex flex-wrap items-center gap-2 border-t border-border bg-white/[0.015] px-4 py-3">{footer}</div> : null}
    </article>
  );
}

/** A completed trade made by a running strategy. */
export function TradeRow({ trade }: { trade: StrategyTradeRow }) {
  return (
    <li data-strategy-trade className="pilot-strategy-trade flex min-w-0 items-start gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <span className="grid h-7 w-7 shrink-0 place-items-center border border-executed/30 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))] rounded-md">
        <ArrowLeftRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground">
          Trade made
          <span className="border border-executed/35 bg-executed/10 px-1 py-px text-xs text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))] rounded">Validated</span>
        </p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{trade.summary}</p>
        <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
          {formatTime(trade.at)}{trade.hash ? ` · ${trade.hash.slice(0, 10)}…${trade.hash.slice(-6)}` : ""}
        </p>
      </div>
    </li>
  );
}

function FactGrid({ facts }: { facts: StrategyFact[] }) {
  return (
    <dl className="grid min-w-0 grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4 rounded-xl overflow-hidden">
      {facts.map((fact) => (
        <div key={fact.label} className="min-w-0 bg-card px-3 py-2.5">
          <dt className="label-mono">{fact.label}</dt>
          <dd className="mt-1 break-words font-mono text-[11px] text-foreground">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function renderFooter(data: StrategyCardData, actions: StrategyCardActions, confirmStop: boolean, setConfirmStop: (value: boolean) => void) {
  const details = actions.onDetails ? <button type="button" onClick={actions.onDetails} className={`${quietButton} ml-auto`}>Details</button> : null;
  const disabled = Boolean(data.busy);
  if (confirmStop && actions.onStop) {
    return <>
      <p className="mr-auto text-xs text-foreground">Stop this strategy for good?</p>
      <button type="button" onClick={() => setConfirmStop(false)} className={quietButton}>Keep it</button>
      <button type="button" disabled={disabled} onClick={() => { setConfirmStop(false); actions.onStop?.(); }} className={dangerButton}>Yes, stop it</button>
    </>;
  }
  switch (data.state) {
    case "proposed":
      if (!actions.onSetUp && !actions.setUpBlockedReason) return details;
      return <>
        {actions.onSetUp ? <button type="button" disabled={disabled || Boolean(actions.setUpBlockedReason)} onClick={actions.onSetUp} className={primaryButton}>{disabled ? "Setting up…" : "Set up strategy"}</button> : null}
        {actions.setUpBlockedReason ? <p className="text-xs leading-5 text-muted-foreground">{actions.setUpBlockedReason}</p> : null}
        {details}
      </>;
    case "ready_to_sign":
      return <>
        {actions.signBlockedReason ? <p className="basis-full text-xs leading-5 text-[color-mix(in_oklab,var(--approval)_85%,var(--foreground))]">{actions.signBlockedReason}</p> : null}
        {actions.onDetails ? <button type="button" onClick={actions.onDetails} className={quietButton}>Details</button> : null}
        {actions.onDiscard ? <button type="button" disabled={disabled} onClick={actions.onDiscard} className={`${quietButton} ml-auto`}>Discard</button> : null}
        {actions.onSign ? <button type="button" disabled={disabled || Boolean(actions.signBlockedReason)} onClick={actions.onSign} className={`${approvalButton} ${actions.onDiscard ? "" : "ml-auto"}`}><FileKey2 className="h-3.5 w-3.5" aria-hidden="true" />{disabled ? "Waiting for wallet…" : actions.signLabel ?? "Sign mandate"}</button> : null}
      </>;
    case "running":
      return <>
        {actions.onPause ? <button type="button" disabled={disabled} onClick={actions.onPause} className={quietButton}><CirclePause className="h-3.5 w-3.5" aria-hidden="true" />Pause</button> : null}
        {actions.onStop ? <button type="button" disabled={disabled} onClick={() => setConfirmStop(true)} className={dangerButton}><CircleStop className="h-3.5 w-3.5" aria-hidden="true" />Stop</button> : null}
        {details}
      </>;
    case "paused":
      return <>
        {actions.onResume ? <button type="button" disabled={disabled || Boolean(actions.resumeBlockedReason)} onClick={actions.onResume} className={primaryButton}><Play className="h-3.5 w-3.5" aria-hidden="true" />Resume</button> : null}
        {actions.onStop ? <button type="button" disabled={disabled} onClick={() => setConfirmStop(true)} className={dangerButton}><CircleStop className="h-3.5 w-3.5" aria-hidden="true" />Stop</button> : null}
        {actions.resumeBlockedReason ? <p className="basis-full text-xs leading-5 text-[color-mix(in_oklab,var(--approval)_85%,var(--foreground))]">{actions.resumeBlockedReason}</p> : null}
        {details}
      </>;
    default:
      return details;
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
