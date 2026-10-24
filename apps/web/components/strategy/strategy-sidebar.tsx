"use client";

import type { Strategy } from "@pilot/contracts";
import { ArrowRight, Bot, CirclePause, OctagonX, Play, Settings2 } from "lucide-react";
import React, { useState } from "react";

import { titleFor } from "@/components/chat/strategy-proposal";

import { useStrategyHub } from "./strategy-hub";

type Row = {
  title: string;
  status: string;
  tone: "running" | "paused" | "waiting" | "stopped";
  detail?: string;
  onPause?: () => void;
  onResume?: () => void;
  resumeDisabled?: boolean;
};

const toneDot: Record<Row["tone"], string> = {
  running: "bg-executed motion-safe:animate-pulse",
  paused: "bg-approval",
  waiting: "bg-info",
  stopped: "bg-muted-foreground",
};

/** Matches the sidebar: no fill, hairline border, foreground text. */
const quiet = "inline-flex h-7 items-center gap-1 whitespace-nowrap border border-border bg-transparent px-2 text-xs font-medium text-foreground transition hover:bg-foreground/[0.05] disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-10 rounded-md";

/**
 * Always-visible strategy status in the app sidebar: what's running, quick
 * pause/resume, and the account-wide stop. Full controls open in the manager.
 */
export function StrategySidebarBlock({ onStart }: { onStart: () => void }) {
  const hub = useStrategyHub();
  const { controller, demo } = hub;
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const real = controller.context?.mode === "real";
  const busy = Boolean(controller.busy) || controller.blocked;
  // As in the manager: a pending kill-switch change still allows pausing.
  const pauseBusy = Boolean(controller.busy) || Boolean(controller.pendingMutation);

  let row: Row | undefined;
  if (real && controller.strategy && controller.view) {
    const lifecycle = controller.strategy.lifecycle;
    row = {
      title: strategyTitle(controller.strategy),
      status: lifecycle === "draft" ? "Ready to sign" : lifecycle === "active" ? "Running" : lifecycle === "paused" ? "Paused" : "Stopped",
      tone: lifecycle === "active" ? "running" : lifecycle === "paused" ? "paused" : lifecycle === "draft" ? "waiting" : "stopped",
      detail: controller.error ? "Needs attention" : controller.view.unresolvedTransaction ? "A trade is settling" : undefined,
      onPause: lifecycle === "active" ? () => void controller.pause() : undefined,
      onResume: lifecycle === "paused" ? () => void controller.resume() : undefined,
      resumeDisabled: Boolean(controller.resumeBlockedReason),
    };
  } else if (!real && demo) {
    row = {
      title: demo.plan.title,
      status: demo.status === "running" ? "Running" : demo.status === "paused" ? "Paused" : demo.status === "stopped" ? "Stopped" : "Ready to sign",
      tone: demo.status === "running" ? "running" : demo.status === "paused" ? "paused" : demo.status === "stopped" ? "stopped" : "waiting",
      detail: demo.trades.length ? `${demo.trades.length} trade${demo.trades.length === 1 ? "" : "s"} made` : undefined,
      onPause: demo.status === "running" ? hub.demoPause : undefined,
      onResume: demo.status === "paused" ? hub.demoResume : undefined,
    };
  }

  const killOn = real ? controller.globalKill?.enabled : false;
  const canStopAll = real ? Boolean(controller.globalKill) && !killOn && !busy : Boolean(demo && demo.status !== "stopped");
  const stopAll = () => {
    setConfirmStopAll(false);
    if (real) void controller.enableGlobalKill();
    else hub.demoStop();
  };

  return (
    <section aria-label="Strategies" className="border border-border rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <p className="label-mono flex items-center gap-1.5"><Bot className="h-3 w-3" aria-hidden="true" />Strategies</p>
        <button type="button" onClick={hub.openManager} className="link-dashed text-xs text-muted-foreground hover:text-foreground">
          Manage
        </button>
      </div>

      {row ? (
        <div className="space-y-2.5 px-3 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-medium text-foreground">
              <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 ${toneDot[row.tone]}`} />
              <span className="truncate">{row.title}</span>
            </p>
            <p className="mt-0.5 pl-3.5 text-xs text-muted-foreground">
              {row.status}{row.detail ? ` · ${row.detail}` : ""}
            </p>
          </div>
          {confirmStopAll ? (
            <div className="space-y-2 pl-3.5">
              <p className="text-xs leading-5 text-foreground">Stop all autonomous trading on this account?</p>
              <div className="flex gap-1.5">
                <button type="button" onClick={() => setConfirmStopAll(false)} className={quiet}>Cancel</button>
                <button type="button" onClick={stopAll} className={quiet}><OctagonX className="h-3 w-3 text-blocked" aria-hidden="true" />Stop all</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5 pl-3.5">
              {row.onPause ? <button type="button" disabled={real ? pauseBusy : false} onClick={row.onPause} aria-label="Pause strategy" className={quiet}><CirclePause className="h-3 w-3" aria-hidden="true" />Pause</button> : null}
              {row.onResume ? <button type="button" disabled={busy || row.resumeDisabled} onClick={row.onResume} aria-label="Resume strategy" className={quiet}><Play className="h-3 w-3" aria-hidden="true" />Resume</button> : null}
              {canStopAll ? <button type="button" onClick={() => setConfirmStopAll(true)} className={quiet}><OctagonX className="h-3 w-3 text-blocked" aria-hidden="true" />Stop all</button> : null}
              {killOn ? <button type="button" onClick={hub.openManager} aria-label="Review kill switch" className={quiet}><Settings2 className="h-3 w-3" aria-hidden="true" />Review</button> : null}
            </div>
          )}
          {killOn ? <p className="pl-3.5 text-[11px] leading-4 text-muted-foreground">All autonomous trading is stopped on this account.</p> : null}
        </div>
      ) : (
        <div className="space-y-2.5 px-3 py-3">
          <p className="text-xs leading-5 text-muted-foreground">
            {controller.context === undefined ? "Checking your strategies…" : "Nothing running. Describe a strategy in chat and Pilot drafts it for you."}
          </p>
          <button type="button" onClick={onStart} className="link-dashed inline-flex items-center gap-1 text-xs text-foreground">
            Start a strategy <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}

function strategyTitle(strategy: Strategy): string {
  const mandate = strategy.mandate as { kind?: string; plan?: { rules?: unknown } };
  if (mandate.kind === "declarative_strategy_v1" && Array.isArray(mandate.plan?.rules) && mandate.plan.rules.length) {
    return titleFor(mandate.plan.rules as Parameters<typeof titleFor>[0]);
  }
  return "Rebalance XRP and RLUSD";
}
