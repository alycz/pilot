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

  // Without a verified wallet scope there is nothing to review, so the panel
  // stays a single quiet row instead of a large card above the conversation.
  if (!scope) {
    const message =
      state.kind === "checking"
        ? "Checking the wallet-bound memory scope…"
        : state.kind === "signed-out"
          ? "Connect a wallet to review its accepted memory. Signed-out visitors do not receive another wallet's preferences or lessons."
          : state.kind === "unavailable"
            ? state.reason?.trim() || "Wallet-bound memory is unavailable. Pilot will not substitute demo memory for this wallet."
            : null;
    return (
      <section
        aria-labelledby="what-pilot-remembers-title"
        className="flex min-w-0 items-start gap-3 rounded-xl border border-border bg-card px-4 py-3"
      >
        <span className="mt-0.5 shrink-0 text-primary">
          {state.kind === "checking" ? (
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <Brain className="size-4" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 text-xs leading-5 text-muted-foreground">
          <h2 id="what-pilot-remembers-title" className="text-sm font-medium tracking-tight text-foreground">
            {REMEMBERED_CONTEXT_BOUNDARY.title}
          </h2>
          {message ? (
            <p role={state.kind === "unavailable" ? "alert" : state.kind === "checking" ? "status" : "note"} className="mt-0.5">
              {message}
            </p>
          ) : null}
          <p className="mt-0.5">{REMEMBERED_CONTEXT_BOUNDARY.authority}</p>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="what-pilot-remembers-title"
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex min-w-0 flex-col gap-4 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-primary/25 bg-primary/[0.07] text-primary">
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
            className="shrink-0 rounded border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
            aria-label={`Memory scope: ${scope.network}, wallet ${scope.owner}`}
            title={scope.owner}
          >
            {scope.network} · {abbreviatedRememberedOwner(scope.owner)}
          </p>
        ) : null}
      </div>

      <div className="p-4">
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-border bg-background/60 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
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
    <div role={role} className="flex items-start gap-2.5 rounded-xl border border-border bg-background/40 p-4 text-xs leading-5 text-muted-foreground">
      <span className="mt-0.5 shrink-0 text-primary">{icon}</span>
      <p>{children}</p>
    </div>
  );
}
