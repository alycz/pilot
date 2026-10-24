"use client";

import {
  AlertTriangle,
  CirclePause,
  CircleStop,
  FileKey2,
  LockKeyhole,
  OctagonX,
  Play,
  ShieldAlert,
} from "lucide-react";
import React, { forwardRef, useEffect, useRef, useState, type ComponentType } from "react";
import type { StrategyKillSwitch } from "@pilot/contracts";

import { describeRule } from "./declarative-model";
import type { StrategyAuditView, StrategyDecisionView, StrategyDraft, StrategyLifecycle, StrategyView } from "./types";

const lifecycleTone: Record<StrategyLifecycle, string> = {
  draft: "border-border bg-surface text-muted-foreground",
  active: "border-executed/35 bg-executed/10 text-executed",
  paused: "border-approval/35 bg-approval/10 text-approval",
  stopped: "border-border bg-surface text-muted-foreground",
  error: "border-blocked/35 bg-blocked/10 text-blocked",
};

export function MandateReview({ draft, digest, version, busy, blocked, authorizationBlocked, onBack, onReject, onApprove }: { draft: StrategyDraft; digest: string; version: number; busy?: boolean; blocked?: boolean; authorizationBlocked?: string; onBack: () => void; onReject?: () => void; onApprove: () => void }) {
  const items = [
    ["Network", "XRPL Testnet · test funds"], ["Budget account", draft.account], ["Pair", "XRP / test-RLUSD"],
    ["Currency", draft.issuedAsset.currency], ["Issuer", draft.issuedAsset.issuer],
    ["Strategy semantics", draft.strategyMode === "declarative" ? "harbor.declarative-strategy/1 · ordered first-match" : "xrp_issued_rebalancer_v1 · preserved"],
    ...(draft.strategyMode === "legacy_rebalancer" ? [["Allocation", `${draft.targetXrpBps} bps target · ${draft.lowerXrpBps}–${draft.upperXrpBps} band`]] : [
      ["Rules", draft.declarative.rules.map((rule, index) => `${index + 1}. ${describeRule(rule)}`).join(" ")],
      ["Daily / total trades", `${draft.declarative.maxDailyTrades} / ${draft.declarative.maxTotalTrades}`],
      ["Immutable mandate action cap", `${draft.declarative.maxMandateOccurrences} reserved, committed, or outcome-unknown trade actions`],
      ["Cumulative value", `${draft.declarative.maxCumulativeValue} test-RLUSD`],
      ["Daily / cumulative fees", `${draft.declarative.maxDailyFeeDrops} / ${draft.declarative.maxCumulativeFeeDrops} drops`],
    ]),
    ["Minimum / maximum order", `${draft.minOrderValue} / ${draft.maxOrderValue} test-RLUSD`],
    ["Daily value cap", `${draft.maxDailyValue} test-RLUSD`],
    ["Fee / slippage / price impact", `${draft.maxFeeDrops} drops · ${draft.maxSlippageBps} bps · ${draft.maxPriceImpactBps} bps`],
    ["Reserve + buffer", `${draft.minimumXrpReserveDrops} + ${draft.feeBufferDrops} drops`],
    ["Exposure", `${draft.maxXrpExposureDrops} drops XRP · ${draft.maxIssuedExposure} test-RLUSD`],
    ["Liquidity / quote freshness", `${draft.minimumLiquidityValue} test-RLUSD · ${draft.maxQuoteAgeSeconds}s maximum age`],
    ["Cooldown / interval", `${draft.cooldownSeconds}s · ${draft.strategyMode === "declarative" ? `${draft.declarative.intervalSeconds}s` : "5 minutes"}`],
    ["Execution", "First matching rule · at most one fill-or-kill order per evaluation · 1 validated-ledger quote gap"],
    ["Expires", draft.mandateExpiresAt],
  ];
  return <section aria-labelledby="mandate-review-title" className="bracket bracket-accent border border-primary/40 bg-card">
    <header className="border-b border-border px-4 py-4 sm:px-5"><p className="label-mono flex items-center gap-2 text-primary"><FileKey2 className="size-3.5" aria-hidden="true" />Mandate v{version}</p><h2 id="mandate-review-title" className="mt-1 text-lg font-medium">Approve immutable strategy authority</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">This one exact account, pair, strategy version, and set of limits is what the wallet proof authorizes. Editing anything creates a new draft and requires a fresh approval.</p></header>
    <dl className="grid gap-px bg-border sm:grid-cols-2">{items.map(([label, value]) => <div key={label} className="min-w-0 bg-card px-4 py-3"><dt className="label-mono text-[10px]">{label}</dt><dd className="mt-1 break-all font-mono text-xs leading-5 text-foreground">{value}</dd></div>)}</dl>
    <div className="border-t border-border bg-surface px-4 py-4 sm:px-5"><p className="label-mono">Mandate digest</p><p className="mt-1 break-all font-mono text-xs">{digest}</p><p className="mt-3 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />Model preferences, memory, and chat cannot change this mandate, its semantics version, ordered rules, assets, execution behavior, or limits. Any expansion requires a new version and wallet approval.</p>{draft.strategyMode === "declarative" ? <><p className="mt-2 text-xs leading-5 text-muted-foreground">The immutable mandate action cap counts reserved, committed, and outcome-unknown trade actions once per decision; retrying the same decision does not count twice. It is separate from the owner, Testnet, exact-asset lifetime total-trades cap.</p><p className="mt-2 text-xs leading-5 text-muted-foreground">Lifetime cumulative counters bind this owner, Testnet, and exact XRP/test-RLUSD assets. Historical usage survives restarts and is not reset by a copied plan, new strategy ID, model revision, or approval window; fresh approval may change caps but cannot erase usage.</p></> : null}{authorizationBlocked ? <p role="status" className="mt-3 border border-approval/35 bg-approval/[0.06] px-3 py-2 text-xs leading-5 text-approval">{authorizationBlocked}</p> : null}<div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{onReject ? <button type="button" disabled={busy || blocked} onClick={onReject} className="min-h-11 border border-blocked/35 px-4 text-sm text-blocked disabled:opacity-55">Reject and stop draft</button> : null}<button type="button" disabled={busy || blocked} onClick={onBack} className="min-h-11 border border-border px-4 text-sm disabled:opacity-55">Edit draft</button><button type="button" disabled={busy || blocked || Boolean(authorizationBlocked)} onClick={onApprove} className="min-h-11 border border-primary/50 bg-primary/[0.09] px-4 text-sm font-medium disabled:opacity-55">{blocked ? "Reconcile unknown request first" : authorizationBlocked ? "Global kill must be cleared first" : busy ? "Waiting for wallet…" : "Approve and activate this mandate"}</button></div></div>
  </section>;
}

export function GlobalKillControl({ account, killSwitch, unavailableReason, hasMandate, busy, blocked, onEnable, onClear }: {
  account: string;
  killSwitch?: StrategyKillSwitch;
  unavailableReason?: string;
  hasMandate: boolean;
  busy?: boolean;
  blocked?: boolean;
  onEnable: () => void;
  onClear: () => void;
}) {
  const [confirm, setConfirm] = useState<"enable" | "clear" | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const enableRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirm) cancelRef.current?.focus(); }, [confirm]);
  useEffect(() => {
    if (!confirm) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const opener = confirm === "enable" ? enableRef : clearRef;
        setConfirm(null);
        opener.current?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [confirm]);
  const unavailable = !killSwitch;
  const mutationBlocked = Boolean(busy || blocked || unavailable);
  return <section aria-labelledby="global-kill-title" className="border border-border bg-card">
    <header className="border-b border-border px-4 py-3"><h2 id="global-kill-title" className="text-sm font-medium">Account-wide autonomous safety</h2></header>
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-3"><span className="label-mono text-[10px]">Global kill · XRPL Testnet</span><span role="status" className={`border px-2 py-1 font-mono text-[10px] uppercase ${unavailable || killSwitch.enabled ? "border-blocked/35 bg-blocked/[0.06] text-blocked" : "border-executed/35 bg-executed/[0.06] text-executed"}`}>{unavailable ? "unavailable · fail closed" : killSwitch.enabled ? "enabled" : "cleared"}</span></div>
      <p className="break-all font-mono text-[11px] text-muted-foreground">Owner: {account}</p>
      {unavailable ? <p role="alert" className="text-xs leading-5 text-blocked">{unavailableReason ?? "Pilot could not verify the account-wide switch. New autonomous authorization stays blocked."}</p> : killSwitch.enabled ? <><p className="text-xs leading-5 text-muted-foreground">New autonomous submissions are blocked for every strategy owned by this exact account on Testnet.</p>{hasMandate ? <button ref={clearRef} type="button" disabled={mutationBlocked} onClick={() => setConfirm("clear")} className="min-h-11 w-full border border-primary/40 bg-primary/[0.06] px-3 text-left text-sm disabled:opacity-55">Authorize autonomous submissions…</button> : <p className="border border-border bg-surface px-3 py-2 text-xs leading-5 text-muted-foreground">Create and review an immutable mandate before asking the wallet to clear global kill.</p>}</> : <><p className="text-xs leading-5 text-muted-foreground">The account-wide switch is cleared. Only separately approved, unexpired mandate limits can authorize a submission.</p><button ref={enableRef} type="button" disabled={mutationBlocked} onClick={() => setConfirm("enable")} className="min-h-11 w-full border border-blocked/35 px-3 text-left text-sm text-blocked disabled:opacity-55">Enable global kill…</button></>}
      {killSwitch?.updated_at ? <p className="label-mono text-[10px]">Last durable update: {killSwitch.updated_at}</p> : null}
    </div>
    <p className="border-t border-border bg-surface px-4 py-3 text-xs leading-5 text-muted-foreground">Global kill stops new submissions across this owner account. It cannot cancel an already submitted or ambiguous transaction; reconciliation remains visible and blocked from replacement.</p>
    {confirm ? <div role="dialog" aria-modal="true" aria-labelledby="global-kill-confirm-title" className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4"><div className="w-full max-w-md border border-blocked/45 bg-background p-5 shadow-xl"><h2 id="global-kill-confirm-title" className="text-lg font-medium">{confirm === "enable" ? "Enable account-wide global kill?" : "Authorize autonomous submissions?"}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{confirm === "enable" ? "This blocks new autonomous submissions for every strategy on this exact Testnet owner account. It does not cancel or hide any submitted or unresolved transaction." : "Your wallet will sign a non-broadcast proof for this exact Testnet owner and immutable mandate. Clearing global kill does not create a strategy, expand its limits, or authorize another account."}</p><div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button ref={cancelRef} type="button" onClick={() => { const opener = confirm === "enable" ? enableRef : clearRef; setConfirm(null); opener.current?.focus(); }} className="min-h-11 border border-border px-4 text-sm">Cancel</button><button type="button" onClick={() => { const action = confirm; setConfirm(null); action === "enable" ? onEnable() : onClear(); }} className={`min-h-11 border px-4 text-sm font-medium ${confirm === "enable" ? "border-blocked/45 bg-blocked/10 text-blocked" : "border-primary/50 bg-primary/[0.09]"}`}>{confirm === "enable" ? "Confirm · block new submissions" : "Continue to wallet proof"}</button></div></div></div> : null}
  </section>;
}

export function StrategyStatus({ strategy }: { strategy: StrategyView }) {
  const declarative = strategy.strategyKind === "declarative_strategy_v1";
  return <section aria-labelledby="strategy-status-title" className="relative overflow-hidden border-b border-border"><div aria-hidden="true" className="bg-rules absolute inset-0" /><div className="relative px-4 py-7 sm:px-6 lg:px-8"><div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between"><div><p className="label-mono flex items-center gap-2"><span aria-hidden="true" className="size-1.5 bg-primary" />XRPL TESTNET · TEST FUNDS ONLY · LIVE DEFAULT OFF</p><div className="mt-3 flex flex-wrap items-center gap-3"><h1 id="strategy-status-title" className="text-2xl font-medium tracking-tight">{strategy.strategyLabel ?? (declarative ? "Bounded declarative strategy" : "50 / 50 deterministic rebalancer")}</h1><span role="status" aria-live="polite" className={`inline-flex items-center gap-1.5 border px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-wide ${lifecycleTone[strategy.lifecycle]}`}><span aria-hidden="true" className="size-1.5 bg-current" />{strategy.lifecycle}</span></div><p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{strategy.strategySummary ?? (declarative ? "Ordered allowlisted rules are evaluated deterministically; only the first match can plan one bounded fill-or-kill order." : `Small fill-or-kill swaps are considered only outside the approved ${strategy.lowerXrpBps / 100}–${strategy.upperXrpBps / 100}% XRP band.`)} Built and offline-tested for Testnet; live bounded acceptance has not been performed.</p></div><dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-3"><Metric label="Mandate" value={`v${strategy.mandateVersion}`} /><Metric label="Schedule" value={strategy.schedulerEnabled ? `${strategy.evaluationIntervalSeconds ?? 300}s · enabled` : "Disabled"} />{declarative ? <Metric label="Mandate action cap" value={strategy.maxMandateOccurrences === undefined ? "Legacy mandate · not recorded" : `${strategy.maxMandateOccurrences} actions`} /> : null}<Metric label="Reserved budget" value={strategy.budgetReserved ? `${strategy.budgetReserved} test-RLUSD` : "Unavailable from status API"} /><Metric label="Committed budget" value={strategy.budgetCommitted ? `${strategy.budgetCommitted} test-RLUSD` : "Unavailable from status API"} /></dl></div></div></section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><dt className="label-mono text-[10px]">{label}</dt><dd className="mt-1 font-mono text-xs text-foreground">{value}</dd></div>; }

export function InflightWarning({ transaction, onRefresh }: { transaction: NonNullable<StrategyView["unresolvedTransaction"]>; onRefresh?: () => void }) {
  const approval = transaction.state === "needs_approval";
  return <section role="alert" className="border border-approval/45 bg-approval/[0.07] p-4"><div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-approval" aria-hidden="true" /><div><h2 className="font-medium text-approval">{approval ? "Owner approval required" : "Transaction outcome unresolved"}</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">{approval ? "This strategy is paused. Complete the existing Harbor owner-approval workflow for this exact approval ID. Pilot will not sign for the owner or create a replacement order." : "Follow-up orders are blocked until read-only reconciliation proves validation or complete non-inclusion. Pilot will not retry this trade as a new order."}</p>{transaction.approvalId ? <p className="mt-2 break-all font-mono text-xs">Approval ID: {transaction.approvalId}</p> : null}{transaction.hash ? <p className="mt-2 break-all font-mono text-xs">Transaction hash: {transaction.hash}</p> : null}<button type="button" onClick={onRefresh} className="mt-3 min-h-11 border border-approval/40 px-3 text-sm text-approval">Refresh reconciliation</button></div></div></section>;
}

const outcomeTone: Record<StrategyDecisionView["outcome"], string> = { hold: "text-muted-foreground", planned: "text-primary", needs_approval: "text-approval", submitted: "text-approval", validated: "text-executed", failed: "text-blocked", unknown: "text-blocked" };
export function DecisionList({ decisions }: { decisions: StrategyDecisionView[] }) {
  return <section aria-labelledby="decisions-title" className="border border-border bg-card"><header className="border-b border-border px-4 py-3"><h2 id="decisions-title" className="text-sm font-medium">Decisions &amp; explainable holds</h2></header>{decisions.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">No evaluation has run for this mandate.</p> : <ul className="divide-y divide-border">{decisions.map((decision) => <li key={decision.id} className="px-4 py-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className={`font-mono text-xs font-medium uppercase ${outcomeTone[decision.outcome]}`}>{decision.outcome.replace("_", " ")}</span><time className="label-mono text-[10px]">{decision.at}</time></div><p className="mt-2 text-sm leading-6 text-muted-foreground">{decision.explanation}</p><dl className="mt-3 grid gap-2 sm:grid-cols-2"><Metric label="Decision / trigger" value={`${decision.id} · ${decision.triggerId}`} />{decision.allocation ? <Metric label="XRP allocation" value={decision.allocation} /> : null}{decision.amount ? <Metric label="Planned value" value={decision.amount} /> : null}{decision.approvalId ? <Metric label="Approval ID" value={decision.approvalId} /> : null}{decision.txHash ? <Metric label="Transaction" value={decision.txHash} /> : null}</dl></li>)}</ul>}</section>;
}

export function AuditTrail({ events }: { events: StrategyAuditView[] }) {
  return <section aria-labelledby="audit-title" className="border border-border bg-card"><header className="border-b border-border px-4 py-3"><h2 id="audit-title" className="text-sm font-medium">Decision &amp; transaction audit trail</h2></header>{events.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">No durable strategy events yet.</p> : <><ul className="divide-y divide-border sm:hidden">{events.map((event) => <li key={event.id} className="px-4 py-3"><p className="font-mono text-xs uppercase">{event.event}</p><p className="mt-1 text-sm text-muted-foreground">{event.detail}</p><p className="label-mono mt-2 break-all text-[10px]">{event.at} · {event.identity ?? event.id}</p></li>)}</ul><div role="region" aria-label="Strategy audit table" tabIndex={0} className="hidden overflow-x-auto sm:block"><table className="w-full min-w-[44rem] text-left"><thead className="border-b border-border bg-surface"><tr>{["Time", "Event", "Detail", "Identity"].map((label) => <th key={label} className="label-mono px-4 py-2.5 font-medium">{label}</th>)}</tr></thead><tbody className="font-mono text-xs">{events.map((event) => <tr key={event.id} className="border-b border-border last:border-0"><td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{event.at}</td><td className="px-4 py-3 uppercase">{event.event}</td><td className="max-w-md px-4 py-3 font-sans text-muted-foreground">{event.detail}</td><td className="break-all px-4 py-3">{event.identity ?? event.id}</td></tr>)}</tbody></table></div></>}</section>;
}

export function StrategyControls({ strategy, busyAction, resumeBlockedReason, onPause, onResume, onStop, onKill }: { strategy: StrategyView; busyAction?: string; resumeBlockedReason?: string; onPause: () => void; onResume: () => void; onStop: () => void; onKill: () => void }) {
  const [confirm, setConfirm] = useState<"stop" | "kill" | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const killRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirm) cancelRef.current?.focus(); }, [confirm]);
  useEffect(() => { if (!confirm) return; const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setConfirm(null); (confirm === "kill" ? killRef : stopRef).current?.focus(); } }; document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key); }, [confirm]);
  const blocked = Boolean(busyAction);
  return <section aria-labelledby="controls-title" className="border border-border bg-card"><header className="border-b border-border px-4 py-3"><h2 id="controls-title" className="text-sm font-medium">Owner controls</h2></header><div className="space-y-2 p-4">{strategy.lifecycle === "active" ? <ControlButton icon={CirclePause} label="Pause new evaluations" disabled={blocked} onClick={onPause} /> : null}{strategy.lifecycle === "paused" ? <><ControlButton icon={Play} label="Revalidate and resume" disabled={blocked || Boolean(strategy.unresolvedTransaction) || Boolean(resumeBlockedReason)} onClick={onResume} />{resumeBlockedReason ? <p className="text-xs leading-5 text-approval">{resumeBlockedReason}</p> : null}</> : null}{strategy.lifecycle !== "stopped" ? <ControlButton ref={stopRef} icon={CircleStop} label="Stop this mandate version" disabled={blocked} onClick={() => setConfirm("stop")} danger /> : null}<ControlButton ref={killRef} icon={OctagonX} label="Emergency kill this strategy" disabled={blocked} onClick={() => setConfirm("kill")} danger /></div><p className="border-t border-border bg-surface px-4 py-3 text-xs leading-5 text-muted-foreground"><ShieldAlert className="mr-1.5 inline size-3.5" aria-hidden="true" />Pause, stop, and kill block new submissions for this strategy. An existing or uncertain ledger submission cannot be cancelled here and remains visible until reconciled.</p>{confirm ? <div role="dialog" aria-modal="true" aria-labelledby="strategy-confirm-title" className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4"><div className="w-full max-w-md border border-blocked/45 bg-background p-5 shadow-xl"><h2 id="strategy-confirm-title" className="text-lg font-medium">{confirm === "kill" ? "Emergency kill this strategy?" : "Stop this mandate version?"}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">This stops new submissions for this strategy. It does not cancel, hide, or release any transaction whose outcome is unresolved.</p><div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button ref={cancelRef} type="button" onClick={() => { const opener = confirm === "kill" ? killRef : stopRef; setConfirm(null); opener.current?.focus(); }} className="min-h-11 border border-border px-4 text-sm">Cancel</button><button type="button" onClick={() => { setConfirm(null); confirm === "kill" ? onKill() : onStop(); }} className="min-h-11 border border-blocked/45 bg-blocked/10 px-4 text-sm font-medium text-blocked">Confirm · stop new submissions</button></div></div></div> : null}</section>;
}

const ControlButton = forwardRef<HTMLButtonElement, { icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>; label: string; disabled?: boolean; danger?: boolean; onClick: () => void }>(function ControlButton({ icon: Icon, label, disabled, danger, onClick }, ref) { return <button ref={ref} type="button" disabled={disabled} onClick={onClick} className={`flex min-h-11 w-full items-center gap-2 border px-3 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-55 ${danger ? "border-blocked/30 text-blocked hover:bg-blocked/[0.06]" : "border-border hover:bg-surface"}`}><Icon className="size-4" aria-hidden={true} />{label}</button>; });
