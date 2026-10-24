"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

import { allCardStateEvents } from "@/app/chat/fixtures";
import { IntentCard } from "@/components/cards";

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

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-end bg-black/45 sm:place-items-center sm:p-6"
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
        className="flex max-h-[92dvh] w-full max-w-5xl flex-col border border-border-strong bg-background shadow-xl shadow-black/[0.12] outline-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="label-mono text-[10px]">Reference</p>
            <h2 id={titleId} className="mt-1 text-lg font-normal tracking-[-0.01em]">Transaction card states</h2>
            <p id={descriptionId} className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">
              Every action Pilot plans moves through these ten states, from drafting the intent to the result on the ledger. These are examples, not live transactions.
            </p>
          </div>
          <button
            type="button"
            data-autofocus
            onClick={onClose}
            className="bracket bracket-light grid h-9 w-9 shrink-0 place-items-center border border-border bg-white/[0.03] text-foreground transition hover:bg-white/[0.06] pointer-coarse:h-11 pointer-coarse:w-11"
            aria-label="Close card states"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4 sm:p-6" tabIndex={0} role="region" aria-label="All transaction card states">
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            {allCardStateEvents.map((event) => <IntentCard key={event.intent_id} event={event} />)}
          </div>
        </div>
      </section>
    </div>
  );
}
