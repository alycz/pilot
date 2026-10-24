"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { allCardStateEvents } from "@/app/chat/fixtures";
import { IntentCard } from "@/components/cards";
import { demoStrategyPlan } from "@/components/strategy/demo-strategy";

import { StrategyCard, STRATEGY_CARD_STATES, type StrategyCardData, type StrategyCardState } from "./strategy-card";

const examplePlan = demoStrategyPlan("rebalance");
const exampleTrade = { id: "example-trade", at: "2026-10-24T14:05:00.000Z", summary: "Sold 18.40 RLUSD of XRP · XRP was at 57.1%, now 50.4%", hash: "8F3A21C94D7E0B5A6C1F2E3D4B5A69788F3A21C94D7E0B5A6C1F2E3D4B5A6978" };

function strategyExample(state: StrategyCardState): StrategyCardData {
  const base = { state, title: examplePlan.title };
  switch (state) {
    case "drafting":
      return base;
    case "proposed":
    case "ready_to_sign":
      return { ...base, rules: examplePlan.rules, facts: examplePlan.facts, preview: examplePlan.preview };
    case "needs_changes":
      return { ...base, issues: ["A single trade of 500 RLUSD is above your 25 RLUSD per-trade limit.", "Pick a band at least 2% wide."] };
    case "running":
      return { ...base, rules: examplePlan.rules, usage: [{ label: "Checks run", value: "6" }, { label: "Every", value: "5 min" }, { label: "Trades made", value: "1" }, { label: "Used today", value: "18.40 / 60 RLUSD" }], note: "Held. XRP is inside the 45–55% band.", trades: [exampleTrade] };
    case "paused":
      return { ...base, usage: [{ label: "Checks run", value: "6" }, { label: "Every", value: "5 min" }, { label: "Trades made", value: "1" }, { label: "Used today", value: "18.40 / 60 RLUSD" }], note: "Paused by you. No new trades." };
    case "stopped":
      return { ...base, note: "Stopped by you. It won't trade again.", trades: [exampleTrade] };
  }
}

/**
 * Reference sheet of every transaction card state. Opened from the
 * conversation bar's info button; purely presentational (no actions).
 */
export function CardStatesDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        onClose();
        return;
      }
      if (keyEvent.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])") ?? [],
      );
      if (focusable.length === 0) {
        keyEvent.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (keyEvent.shiftKey && document.activeElement === first) {
        keyEvent.preventDefault();
        last.focus();
      } else if (!keyEvent.shiftKey && document.activeElement === last) {
        keyEvent.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portaled so the app header and sidebar never sit above the sheet.
  return createPortal(
    <div
      className="fixed inset-0 z-[90] grid place-items-end bg-black/45 sm:place-items-center sm:p-6"
      role="presentation"
      onMouseDown={(mouseEvent) => {
        if (mouseEvent.currentTarget === mouseEvent.target) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="flex max-h-[92dvh] w-full max-w-5xl flex-col border border-border-strong bg-background shadow-xl shadow-black/[0.12] outline-none rounded-xl overflow-hidden"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="label-mono">Reference</p>
            <h2 id={titleId} className="mt-1 text-lg font-normal tracking-[-0.01em]">Card states</h2>
            <p id={descriptionId} className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">
              Every trade moves through ten states, from drafting the intent to the result on the ledger. Every strategy moves through seven, from first draft to stopped.
            </p>
          </div>
          <button
            type="button"
            data-autofocus
            onClick={onClose}
            className="bracket bracket-light grid h-9 w-9 shrink-0 place-items-center border border-border bg-white/[0.03] text-foreground transition hover:bg-white/[0.06] pointer-coarse:h-11 pointer-coarse:w-11 rounded-md"
            aria-label="Close card states"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4 sm:p-6" tabIndex={0} role="region" aria-label="All card states">
          <h3 className="label-mono mb-3">Trades</h3>
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            {allCardStateEvents.map((event) => <IntentCard key={event.intent_id} event={event} />)}
          </div>
          <h3 className="label-mono mb-3 mt-8">Strategies</h3>
          <div className="grid min-w-0 items-start gap-3 md:grid-cols-2">
            {STRATEGY_CARD_STATES.map((state) => <StrategyCard key={state} data={strategyExample(state)} />)}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
