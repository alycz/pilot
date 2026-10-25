"use client";

import { AlertCircle, Brain, LoaderCircle, LockKeyhole } from "lucide-react";
import React from "react";

import { StructuredPreferencesPanel } from "../memory/structured-preferences";
import { WorkflowLessonsPanel } from "../memory/workflow-lessons";

import {
  REMEMBERED_CONTEXT_BOUNDARY,
  abbreviatedRememberedOwner,
  rememberedContextScope,
  type RememberedContextState,
} from "./remembered-context";

export function WhatPilotRemembers({ state }: { state: RememberedContextState }) {
  const scope = rememberedContextScope(state);

  return (
    <section
      aria-labelledby="what-pilot-remembers-title"
      className="min-w-0 border border-border bg-card"
    >
      <div className="flex min-w-0 flex-col gap-4 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center border border-primary/25 bg-primary/[0.07] text-primary">
            <Brain className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="what-pilot-remembers-title" className="text-sm font-medium tracking-tight">
              {REMEMBERED_CONTEXT_BOUNDARY.title}
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              Review, correct, or forget accepted preferences and workflow lessons.
              {" "}{REMEMBERED_CONTEXT_BOUNDARY.persistence}
            </p>
          </div>
        </div>
        {scope ? (
          <p
            className="shrink-0 border border-border bg-background px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
            aria-label={`Memory scope: ${scope.network}, wallet ${scope.owner}`}
            title={scope.owner}
          >
            {scope.network} · {abbreviatedRememberedOwner(scope.owner)}
          </p>
        ) : null}
      </div>

      <div className="p-4">
        <div className="mb-4 flex items-start gap-2.5 border border-border bg-background/60 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          <LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <p>{REMEMBERED_CONTEXT_BOUNDARY.authority}</p>
        </div>

        {state.kind === "checking" ? (
          <MemoryStateMessage role="status" icon={<LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}>
            Checking the wallet-bound memory scope…
          </MemoryStateMessage>
        ) : null}

        {state.kind === "signed-out" ? (
          <MemoryStateMessage icon={<LockKeyhole className="size-4" aria-hidden="true" />}>
            Connect a wallet to review its accepted memory. Signed-out visitors do not receive another wallet&apos;s preferences or lessons.
          </MemoryStateMessage>
        ) : null}

        {state.kind === "unavailable" ? (
          <MemoryStateMessage role="alert" icon={<AlertCircle className="size-4" aria-hidden="true" />}>
            {state.reason?.trim() || "Wallet-bound memory is unavailable. Pilot will not substitute demo memory for this wallet."}
          </MemoryStateMessage>
        ) : null}

        {scope ? (
          <div className="grid min-w-0 gap-4 xl:grid-cols-2">
            <StructuredPreferencesPanel scopeKey={scope.scopeKey} />
            <WorkflowLessonsPanel scopeKey={scope.scopeKey} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
function MemoryStateMessage({
  children,
  icon,
  role = "note",
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  role?: "alert" | "status" | "note";
}) {
  return (
    <div role={role} className="flex items-start gap-2.5 border border-border bg-background/40 p-4 text-xs leading-5 text-muted-foreground">
      <span className="mt-0.5 shrink-0 text-primary">{icon}</span>
      <p>{children}</p>
    </div>
  );
}
