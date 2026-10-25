"use client";

import { LoaderCircle, ShieldCheck } from "lucide-react";
import React from "react";

import { StrategyDraftForm } from "./strategy-draft-form";
import { StrategySignedOutDemo } from "./strategy-demo";
import { AuditTrail, DecisionList, GlobalKillControl, InflightWarning, MandateReview, StrategyControls, StrategyStatus } from "./strategy-panels";
import { fromMandate, useStrategyController, type StrategyClient, type StrategyController } from "./use-strategy-controller";

/**
 * Full owner controls for one Testnet strategy. Pass a shared `controller`
 * (the chat strategy panel does) or a `client` to run standalone.
 */
export function StrategyWorkspace({ client, controller, onStart }: { client?: StrategyClient; controller?: StrategyController; onStart?: () => void }) {
  if (controller) return <StrategyWorkspaceView controller={controller} onStart={onStart} />;
  return <StandaloneStrategyWorkspace client={client} />;
}

function StandaloneStrategyWorkspace({ client }: { client?: StrategyClient }) {
  const controller = useStrategyController(client);
  return <StrategyWorkspaceView controller={controller} />;
}

export function StrategyWorkspaceView({ controller, onStart }: { controller: StrategyController; onStart?: () => void }) {
  const { context, draft, setDraft, screen, setScreen, strategy, view, busy, error, pendingMutation, pendingGlobalKill, globalKill, globalKillError, blocked } = controller;
  if (context === undefined) return <Loading />;
  if (context.mode === "demo") return <StrategySignedOutDemo realModeStatus={context.realModeStatus} onStart={onStart} />;

  return <div className="min-w-0">
    {view && screen === "status" ? <StrategyStatus strategy={view} /> : null}
    <div className="grid min-w-0 gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-5">
        {error ? <div role="alert" className="border border-blocked/35 bg-blocked/[0.06] px-4 py-3 text-sm text-blocked rounded-xl"><p>{error}</p>{pendingMutation || pendingGlobalKill ? <><p className="mt-2 break-all font-mono text-xs">Retained {pendingMutation?.action ?? "global kill"} request ID: {pendingMutation?.requestId ?? pendingGlobalKill?.requestId}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void controller.refresh()} className="min-h-11 border border-blocked/40 px-3 text-sm rounded-md">Check durable evidence</button>{controller.canReplayPending ? <button type="button" onClick={() => void controller.replayPending()} className="min-h-11 border border-blocked/40 px-3 text-sm rounded-md">Replay exact request ID</button> : null}{controller.canReplayPendingGlobalKill ? <button type="button" onClick={() => void controller.replayPendingGlobalKill()} className="min-h-11 border border-blocked/40 px-3 text-sm rounded-md">Replay exact request ID</button> : null}</div></> : null}</div> : null}
        {screen === "draft" ? <StrategyDraftForm draft={draft} disabled={Boolean(busy || blocked)} onChange={setDraft} onReview={(candidate) => void controller.createDraft(candidate)} /> : null}
        {screen === "review" && strategy ? <MandateReview draft={fromMandate(strategy, draft)} digest={strategy.mandate.digest} version={strategy.mandate.version} busy={Boolean(busy)} blocked={blocked} authorizationBlocked={controller.authorizationBlocked} onBack={() => setScreen("draft")} onReject={() => void controller.reject()} onApprove={() => void controller.approve()} /> : null}
        {view && screen === "status" ? <>{view.unresolvedTransaction ? <InflightWarning transaction={view.unresolvedTransaction} onRefresh={() => void controller.refresh()} /> : null}<DecisionList decisions={view.decisions} /><AuditTrail events={view.audit} /></> : null}
      </div>
      <aside className="min-w-0 space-y-5">
        <GlobalKillControl account={context.account} killSwitch={globalKill} unavailableReason={globalKillError} hasMandate={Boolean(strategy)} busy={Boolean(busy)} blocked={blocked} onEnable={() => void controller.enableGlobalKill()} onClear={() => void controller.clearGlobalKill()} />
        {view && strategy && screen === "status" ? <StrategyControls strategy={view} busyAction={busy ?? (pendingMutation ? "outcome-unknown" : undefined)} resumeBlockedReason={controller.resumeBlockedReason} onPause={() => void controller.pause()} onResume={() => void controller.resume()} onStop={() => void controller.stop()} onKill={() => void controller.kill()} /> : <SafetySummary />}
      </aside>
    </div>
  </div>;
}

function Loading() { return <div role="status" className="flex min-h-[20rem] items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />Loading owner-scoped Testnet strategy…</div>; }
function SafetySummary() { return <section className="border border-border bg-card p-4 rounded-xl overflow-hidden"><p className="label-mono flex items-center gap-2"><ShieldCheck className="size-3.5 text-executed" aria-hidden="true" />Activation boundary</p><ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground"><li>• Exact Testnet account, currency and issuer.</li><li>• Immutable, expiring, versioned wallet proof.</li><li>• No model-controlled permissions or limits.</li><li>• Fill-or-kill execution; uncertainty blocks follow-up orders.</li></ul></section>; }
