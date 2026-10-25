"use client";

import React, { useEffect, useState } from "react";

import { BacktestEvidenceCard, type BacktestEvidenceCardState } from "../backtests/chat/backtest-evidence-card";
import { loadBrowserBacktestEvidence } from "../backtests/chat/browser-evidence";
import { createEvidenceGenerationGuard } from "../backtests/chat/evidence-generation";
import { BACKTEST_SESSION_INVALIDATED_EVENT } from "../backtests/integration/client/session-lifecycle-guard";
import { ActionPreparationCard } from "../cards";
import type { PublicPilotConfig, WalletSessionStatus } from "../../lib/harbor-browser";

import { initialCopilotHandoff, type InitialCopilotHandoff } from "./action-handoff";

export function CopilotChatContext({
  pathname,
  publicConfig,
  onUseDraft,
}: {
  pathname: string;
  publicConfig: PublicPilotConfig | null | undefined;
  walletSession: WalletSessionStatus | null | undefined;
  onUseDraft: (prompt: string) => void;
}) {
  const [handoff, setHandoff] = useState<InitialCopilotHandoff>({});
  const [backtestEvidence, setBacktestEvidence] = useState<BacktestEvidenceCardState>();

  useEffect(() => {
    if (pathname !== "/chat") {
      setHandoff({});
      setBacktestEvidence(undefined);
      return;
    }

    let active = true;
    let evidenceController: AbortController | undefined;
    const evidenceGeneration = createEvidenceGenerationGuard();
    const loadCurrentLocation = () => {
      evidenceGeneration.invalidate();
      evidenceController?.abort();
      evidenceController = new AbortController();
      const search = window.location.search;
      setHandoff(initialCopilotHandoff(search));
      setBacktestEvidence(undefined);
      const requestedGeneration = evidenceGeneration.capture();
      void loadBrowserBacktestEvidence({
        search,
        storage: window.sessionStorage,
        fetcher: globalThis.fetch,
        signal: evidenceController.signal,
      }).then((value) => {
        if (active && evidenceGeneration.accepts(requestedGeneration)) setBacktestEvidence(value);
      }).catch((cause) => {
        if (!active || !evidenceGeneration.accepts(requestedGeneration)) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setBacktestEvidence({ kind: "error", reason: "The saved backtest evidence could not be verified." });
      });
    };
    const clearEvidenceForSessionInvalidation = () => {
      evidenceGeneration.invalidate();
      evidenceController?.abort();
      const params = new URLSearchParams(window.location.search);
      setBacktestEvidence(params.has("pilot_backtest")
        ? { kind: "unavailable", reason: "Saved research was cleared because the wallet session changed." }
        : undefined);
    };

    loadCurrentLocation();
    window.addEventListener("popstate", loadCurrentLocation);
    window.addEventListener(BACKTEST_SESSION_INVALIDATED_EVENT, clearEvidenceForSessionInvalidation);
    return () => {
      active = false;
      evidenceGeneration.invalidate();
      evidenceController?.abort();
      window.removeEventListener("popstate", loadCurrentLocation);
      window.removeEventListener(BACKTEST_SESSION_INVALIDATED_EVENT, clearEvidenceForSessionInvalidation);
    };
  }, [pathname]);

  if (pathname !== "/chat") return null;

  return (
    <div className="mb-8 space-y-4" aria-label="Reviewable chat context">
      {backtestEvidence ? <BacktestEvidenceCard state={backtestEvidence} /> : null}
      {handoff.context ? (
        <ActionPreparationCard
          context={handoff.context}
          runtimeNetwork={publicConfig?.network ?? handoff.context.network}
        />
      ) : null}
      {handoff.draft ? (
        <ReviewableHandoffPrompt prompt={handoff.draft} onUseDraft={onUseDraft} />
      ) : null}
      {handoff.error ? (
        <p role="alert" className="border border-destructive/35 bg-destructive/[0.06] px-4 py-3 text-xs leading-5 text-destructive">
          This market handoff is unavailable: {handoff.error} Nothing was prepared or submitted.
        </p>
      ) : null}
    </div>
  );
}

export function ReviewableHandoffPrompt({
  prompt,
  onUseDraft,
}: {
  prompt: string;
  onUseDraft: (prompt: string) => void;
}) {
  return (
    <section aria-labelledby="handoff-prompt-title" className="border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="handoff-prompt-title" className="text-sm font-medium">Reviewable Ask Pilot draft</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Structured research context becomes a draft only. It is never submitted, signed, or approved automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onUseDraft(prompt)}
          className="inline-flex min-h-11 shrink-0 items-center justify-center border border-border px-3 font-mono text-[10px] uppercase tracking-wide transition hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Review in composer
        </button>
      </div>
      <p className="mt-3 break-words border border-border bg-background/50 p-3 font-mono text-[11px] leading-5 text-muted-foreground">{prompt}</p>
    </section>
  );
}
