"use client";

import type { StrategyAuditEvent } from "@pilot/contracts";
import React from "react";

import type { DemoStrategyPlan } from "@/components/strategy/demo-strategy";
import { useStrategyHub, type DemoStrategy } from "@/components/strategy/strategy-hub";
import type { StrategyController } from "@/components/strategy/use-strategy-controller";

import { StrategyCard, type StrategyCardActions, type StrategyCardData, type StrategyCardState, type StrategyTradeRow } from "./strategy-card";
import { strategyCreateInputFromProposal, type StrategyProposalView } from "./strategy-proposal";

/** What a chat turn knows about the strategy it proposed. */
export type ChatStrategyTurn =
  | { source: "api"; status: "drafting" }
  | { source: "api"; status: "proposal"; proposal: StrategyProposalView }
  | { source: "api"; status: "error"; message: string }
  | { source: "demo"; status: "drafting" | "proposal"; plan: DemoStrategyPlan };

export function StrategyTurnCard({ cardId, strategy }: { cardId: string; strategy: ChatStrategyTurn }) {
  const hub = useStrategyHub();
  if (strategy.source === "demo") return <DemoStrategyTurnCard cardId={cardId} strategy={strategy} />;
  if (strategy.status === "drafting") return <StrategyCard data={{ state: "drafting", title: "Autonomous strategy" }} />;
  if (strategy.status === "error") {
    return <StrategyCard data={{ state: "needs_changes", title: "Autonomous strategy", issues: [strategy.message] }} />;
  }
  const proposal = strategy.proposal;
  if (proposal.state === "rejected") {
    return <StrategyCard data={{ state: "needs_changes", title: "Autonomous strategy", issues: proposal.issues }} />;
  }

  const { controller } = hub;
  const link = hub.link?.cardId === cardId ? hub.link : undefined;
  const settingUp = hub.settingUpCardId === cardId;
  const base = { title: proposal.summary.title, rules: proposal.summary.rules, facts: proposal.summary.facts, preview: proposal.preview };
  // Bind only to the exact strategy and mandate this card created, never to whatever is current.
  const bound = link && controller.context?.mode === "real" && controller.strategy &&
    controller.strategy.strategy_id === link.strategyId &&
    controller.strategy.mandate.digest === link.mandateDigest &&
    controller.strategy.mandate.version === link.mandateVersion;
  if (bound) {
    const { data, actions } = liveStrategyCard(controller, base, () => hub.openManager());
    return <StrategyCard data={data} actions={actions} />;
  }

  const context = controller.context;
  const existing = controller.strategy && controller.strategy.lifecycle !== "stopped" ? controller.strategy : undefined;
  const setUpBlockedReason = context?.mode !== "real"
    ? "Connect your wallet to set this up."
    : proposal.proposal.account !== context.account
      ? "This plan was drafted for a different account. Ask Pilot to draft it again."
      : existing
        ? "You already have a strategy. Stop it before starting another."
        : controller.blocked
          ? "Resolve the pending request in Details first."
          : undefined;
  return (
    <StrategyCard
      data={{
        state: "proposed",
        ...base,
        busy: settingUp,
        note: link ? "This card's strategy was replaced. Open Details to see the current one." : settingUp ? undefined : controller.error,
        noteTone: "warning",
      }}
      actions={{
        onSetUp: link ? undefined : () => void hub.setUpFromCard(cardId, strategyCreateInputFromProposal(proposal.proposal)),
        setUpBlockedReason: link ? undefined : setUpBlockedReason,
        onDetails: existing || controller.blocked || link ? () => hub.openManager() : undefined,
      }}
    />
  );
}

/** Card data for the owner's current real strategy. Shared with the sidebar. */
export function liveStrategyCard(
  controller: StrategyController,
  base: Pick<StrategyCardData, "title" | "rules" | "facts" | "preview">,
  openDetails: () => void,
): { data: StrategyCardData; actions: StrategyCardActions } {
  const strategy = controller.strategy!;
  const view = controller.view!;
  const busy = Boolean(controller.busy) || Boolean(controller.pendingMutation);
  const state: StrategyCardState = strategy.lifecycle === "draft" ? "ready_to_sign" : strategy.lifecycle === "active" ? "running" : strategy.lifecycle === "paused" ? "paused" : "stopped";
  const trades = tradesFromAudit(controller.audit);
  const usage = state === "running" || state === "paused"
    ? [
        { label: "Last check", value: view.lastEvaluationAt ? clock(view.lastEvaluationAt) : "Not yet" },
        { label: "Next check", value: state === "running" && view.nextEvaluationAt ? clock(view.nextEvaluationAt) : "—" },
        { label: "Trades made", value: String(trades.length) },
        { label: "Ends", value: shortDate(view.expiresAt) },
      ]
    : undefined;
  const latestHold = view.decisions.at(-1)?.explanation;
  const note = controller.error ?? (view.unresolvedTransaction ? "A trade is still settling. New trades wait until it's confirmed." : state === "running" ? latestHold : undefined);
  const signBlockedReason = controller.blocked
    ? "A previous request is still being confirmed. Open Details."
    : controller.authorizationBlocked
      ? "Your account-wide kill switch is on. Open Details to allow autonomous trades, then sign."
      : undefined;
  return {
    data: {
      ...base,
      facts: state === "ready_to_sign" ? base.facts : undefined,
      rules: state === "ready_to_sign" || state === "running" ? base.rules : undefined,
      state,
      usage,
      trades,
      note,
      noteTone: controller.error || view.unresolvedTransaction ? "warning" : "neutral",
      busy,
    },
    actions: {
      onSign: () => void controller.approve(),
      signBlockedReason,
      onDiscard: () => void controller.reject(),
      onPause: () => void controller.pause(),
      onResume: () => void controller.resume(),
      resumeBlockedReason: controller.resumeBlockedReason ?? (view.unresolvedTransaction ? "Wait for the last trade to settle." : undefined),
      onStop: () => void controller.stop(),
      onDetails: openDetails,
    },
  };
}

function DemoStrategyTurnCard({ cardId, strategy }: { cardId: string; strategy: Extract<ChatStrategyTurn, { source: "demo" }> }) {
  const hub = useStrategyHub();
  const base = { title: strategy.plan.title, rules: strategy.plan.rules, facts: strategy.plan.facts, preview: strategy.plan.preview };
  if (strategy.status === "drafting") return <StrategyCard data={{ state: "drafting", title: strategy.plan.title }} />;
  const demo = hub.demo?.cardId === cardId ? hub.demo : undefined;
  if (!demo) {
    const other = hub.demo && hub.demo.status !== "stopped" ? hub.demo : undefined;
    return (
      <StrategyCard
        data={{ state: "proposed", ...base }}
        actions={{
          onSetUp: () => hub.demoSetUp(cardId, strategy.plan),
          setUpBlockedReason: other ? "You already have a strategy. Stop it before starting another." : undefined,
        }}
      />
    );
  }
  const { data, actions } = demoStrategyCard(demo, hub);
  return <StrategyCard data={{ ...base, ...data }} actions={actions} />;
}

/** Card data for the local demo strategy. Shared with the sidebar. */
export function demoStrategyCard(
  demo: DemoStrategy,
  hub: Pick<ReturnType<typeof useStrategyHub>, "demoSign" | "demoDiscard" | "demoPause" | "demoResume" | "demoStop">,
): { data: StrategyCardData; actions: StrategyCardActions } {
  const state: StrategyCardState = demo.status === "signing" ? "ready_to_sign" : demo.status;
  const live = state === "running" || state === "paused" || state === "stopped";
  return {
    data: {
      state,
      title: demo.plan.title,
      rules: state === "stopped" ? undefined : demo.plan.rules,
      facts: live ? undefined : demo.plan.facts,
      preview: demo.plan.preview,
      usage: live
        ? [
            { label: "Checks run", value: String(demo.checks) },
            { label: "Every", value: demo.plan.intervalLabel },
            { label: "Trades made", value: String(demo.trades.length) },
            { label: "Used today", value: `${demo.usedToday.toFixed(2)} / ${demo.plan.dailyCap} RLUSD` },
          ]
        : undefined,
      note: live ? demo.lastResult : undefined,
      trades: demo.trades,
      busy: demo.status === "signing",
    },
    actions: {
      onSign: hub.demoSign,
      onDiscard: hub.demoDiscard,
      onPause: hub.demoPause,
      onResume: hub.demoResume,
      onStop: hub.demoStop,
    },
  };
}

function tradesFromAudit(events: StrategyAuditEvent[]): StrategyTradeRow[] {
  return events
    .filter((event) => event.kind === "executed")
    .map((event) => {
      const detail = event.detail;
      const hash = typeof detail.tx_hash === "string" ? detail.tx_hash : typeof detail.hash === "string" ? detail.hash : undefined;
      const summary = typeof detail.summary === "string" ? detail.summary : typeof detail.explanation === "string" ? detail.explanation : "Order filled inside your limits.";
      return { id: event.event_id, at: event.at, summary, hash };
    });
}

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
