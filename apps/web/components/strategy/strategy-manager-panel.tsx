"use client";

import { Bot, X } from "lucide-react";
import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useStrategyHub } from "./strategy-hub";
import { StrategyWorkspace } from "./strategy-workspace";

/**
 * Full strategy controls in a side panel over the chat: mandate review,
 * owner controls, the account-wide kill switch, decisions and the audit trail.
 * Signed out, it shows a short walkthrough of one strategy run.
 */
export function StrategyManagerPanel({ onStart }: { onStart: () => void }) {
  const hub = useStrategyHub();
  const closeRef = useRef<HTMLButtonElement>(null);
  const open = hub.managerOpen;
  const close = hub.closeManager;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Confirmation dialogs inside the panel handle their own Escape first.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      previous?.focus({ preventScroll: true });
    };
  }, [close, open]);

  if (!open || typeof document === "undefined") return null;
  const demo = hub.controller.context?.mode !== "real";

  return createPortal(
    <div className="pilot-strategy-manager fixed inset-0 z-[70] flex justify-end">
      <button type="button" tabIndex={-1} aria-hidden="true" onClick={close} className="pilot-strategy-manager-scrim absolute inset-0 cursor-default bg-black/30" />
      <section aria-labelledby="strategy-manager-title" className="pilot-strategy-manager-panel relative flex h-full w-full max-w-[min(100vw,72rem)] flex-col border-l border-border bg-background shadow-2xl shadow-black/20 lg:w-[min(92vw,72rem)]">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <p className="label-mono flex items-center gap-1.5"><Bot className="h-3 w-3" aria-hidden="true" />Strategies</p>
            <h2 id="strategy-manager-title" className="mt-0.5 truncate text-sm font-medium">{demo ? "How a strategy runs" : "Manage your strategy"}</h2>
          </div>
          <button ref={closeRef} type="button" onClick={close} aria-label="Close strategies" className="grid h-9 w-9 place-items-center border border-border text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground pointer-coarse:h-11 pointer-coarse:w-11 rounded-md">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <StrategyWorkspace controller={hub.controller} onStart={() => { close(); onStart(); }} />
        </div>
      </section>
    </div>,
    document.body,
  );
}
