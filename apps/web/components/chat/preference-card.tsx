"use client";

import { AlertTriangle, Check, LoaderCircle, SlidersHorizontal, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import type { PreferenceProposalEvent } from "./stream-parts";

export type PreferenceState = "proposed" | "accepting" | "accepted" | "rejected" | "error";
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class PreferenceProposalConflictError extends Error {}

export async function acceptPreferenceProposal(
  proposal: PreferenceProposalEvent,
  fetcher: Fetcher = fetch,
  idempotencyKey?: string,
) {
  if (proposal.structured && !idempotencyKey) {
    throw new Error("Pilot could not safely identify this acceptance request. Nothing changed.");
  }
  const endpoint = proposal.structured
    ? "/api/vault/preferences/structured"
    : "/api/vault/preferences/accept";
  const body = proposal.structured
    ? {
        action: "accept",
        recordId: proposal.structured.recordId,
        expectedRevision: proposal.structured.revision,
        expectedVersion: proposal.structured.version,
        idempotencyKey,
      }
    : {
        id: proposal.id,
        preference: proposal.preference,
        ...(proposal.reason ? { reason: proposal.reason } : {}),
        accepted: true,
      };
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = "Pilot could not save this preference. Nothing changed.";
    try {
      const payload = await response.json() as { error?: { message?: unknown } };
      if (typeof payload.error?.message === "string" && payload.error.message.trim()) {
        message = payload.error.message;
      }
    } catch {
      // Keep the safe generic error when the route returned a non-JSON body.
    }
    if (response.status === 409) throw new PreferenceProposalConflictError(message);
    throw new Error(message);
  }
  let payload: {
    data?: {
      profile?: { preferences?: unknown };
      record?: { id?: unknown; status?: unknown };
    };
  };
  try {
    payload = await response.json() as typeof payload;
  } catch {
    throw new Error("Pilot did not confirm this preference in your profile. Nothing was marked saved.");
  }
  if (proposal.structured) {
    if (
      payload.data?.record?.id !== proposal.structured.recordId ||
      payload.data.record.status !== "accepted"
    ) {
      throw new Error("Pilot did not confirm this structured preference. Nothing was marked saved.");
    }
    return payload.data.record;
  }
  if (
    !Array.isArray(payload.data?.profile?.preferences) ||
    !payload.data.profile.preferences.includes(proposal.preference)
  ) {
    throw new Error("Pilot did not confirm this preference in your profile. Nothing was marked saved.");
  }
  return payload.data.profile;
}

export async function rejectStructuredPreferenceProposal(
  proposal: PreferenceProposalEvent,
  idempotencyKey: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  if (!proposal.structured) return;
  const response = await fetcher("/api/vault/preferences/structured", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "reject",
      recordId: proposal.structured.recordId,
      expectedRevision: proposal.structured.revision,
      expectedVersion: proposal.structured.version,
      idempotencyKey,
    }),
  });
  let payload: { data?: { record?: { id?: unknown; status?: unknown } }; error?: { message?: unknown } } = {};
  try { payload = await response.json() as typeof payload; } catch { /* safe fallback below */ }
  if (!response.ok) {
    const message = typeof payload.error?.message === "string" && payload.error.message.trim()
      ? payload.error.message
      : "Pilot could not reject this preference. Nothing changed.";
    if (response.status === 409) throw new PreferenceProposalConflictError(message);
    throw new Error(message);
  }
  if (
    payload.data?.record?.id !== proposal.structured.recordId ||
    payload.data.record.status !== "rejected"
  ) {
    throw new Error("Pilot did not confirm this preference rejection. Nothing was marked rejected.");
  }
}

export async function refreshStructuredPreferenceProposal(
  proposal: PreferenceProposalEvent,
  fetcher: Fetcher = fetch,
): Promise<PreferenceProposalEvent> {
  if (!proposal.structured) return proposal;
  const response = await fetcher("/api/vault/preferences/structured", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "list" }),
  });
  let payload: { data?: { revision?: unknown; records?: unknown }; error?: { message?: unknown } } = {};
  try { payload = await response.json() as typeof payload; } catch { /* safe fallback below */ }
  if (!response.ok) {
    throw new Error(
      typeof payload.error?.message === "string" && payload.error.message.trim()
        ? payload.error.message
        : "Pilot could not refresh this preference. Nothing changed.",
    );
  }
  if (!Number.isSafeInteger(payload.data?.revision) ||
      (payload.data?.revision as number) <= proposal.structured.revision ||
      !Array.isArray(payload.data?.records)) {
    throw new Error("Pilot returned an invalid preference refresh.");
  }
  const record = payload.data.records.find((candidate): candidate is Record<string, unknown> =>
    Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).id === proposal.structured!.recordId));
  if (
    !record ||
    record.status !== "proposed" ||
    record.value !== proposal.preference ||
    record.version !== proposal.structured.version ||
    record.category !== proposal.structured.category ||
    record.key !== proposal.structured.key ||
    record.origin !== proposal.structured.origin ||
    record.confidence !== proposal.structured.confidence
  ) {
    throw new Error("This preference proposal changed. Review it in Personal preferences before deciding.");
  }
  return {
    ...proposal,
    structured: {
      ...proposal.structured,
      revision: payload.data.revision as number,
    },
  };
}

export function canStartPreferenceAccept(state: PreferenceState, inFlight: boolean) {
  return !inFlight && state !== "accepting" && state !== "accepted" && state !== "rejected";
}

export function canRejectPreference(state: PreferenceState, inFlight: boolean) {
  return !inFlight && state !== "accepting" && state !== "accepted" && state !== "rejected";
}

/** Reject is intentionally local-only. It returns UI state and performs no request. */
export function rejectPreferenceProposal(): PreferenceState {
  return "rejected";
}

export function preferenceProposalRenderKey(proposal: PreferenceProposalEvent): string {
  return JSON.stringify([
    proposal.id,
    proposal.preference,
    proposal.reason ?? null,
    proposal.at,
    proposal.structured?.recordId ?? null,
    proposal.structured?.revision ?? null,
    proposal.structured?.version ?? null,
    proposal.structured?.category ?? null,
    proposal.structured?.key ?? null,
    proposal.structured?.origin ?? null,
    proposal.structured?.confidence ?? null,
    proposal.workflowLesson?.recordId ?? null,
    proposal.workflowLesson?.revision ?? null,
    proposal.workflowLesson?.version ?? null,
    proposal.workflowLesson?.target.category ?? null,
    proposal.workflowLesson?.target.value ?? null,
    proposal.hermesAdvisory?.summary ?? null,
    proposal.hermesAdvisory?.disclosure.provider ?? null,
    proposal.hermesAdvisory?.disclosure.model ?? null,
    proposal.hermesAdvisory?.disclosure.retentionDays ?? null,
    proposal.hermesAdvisory?.usage.totalTokens ?? null,
  ]);
}

export function PreferenceCard({ proposal }: { proposal: PreferenceProposalEvent }) {
  const [activeProposal, setActiveProposal] = useState(proposal);
  const [state, setState] = useState<PreferenceState>("proposed");
  const [error, setError] = useState<string>();
  const acceptingRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const acceptRequestKeyRef = useRef<string | undefined>(undefined);
  const rejectRequestKeyRef = useRef<string | undefined>(undefined);
  const proposalBinding = preferenceProposalRenderKey(proposal);

  useEffect(() => {
    requestGenerationRef.current += 1;
    acceptingRef.current = false;
    acceptRequestKeyRef.current = undefined;
    rejectRequestKeyRef.current = undefined;
    setActiveProposal(proposal);
    setState("proposed");
    setError(undefined);
  }, [proposalBinding]);

  const accept = async () => {
    if (!canStartPreferenceAccept(state, acceptingRef.current)) return;
    const requestGeneration = ++requestGenerationRef.current;
    acceptingRef.current = true;
    setState("accepting");
    setError(undefined);
    try {
      if (activeProposal.structured) {
        acceptRequestKeyRef.current ??= `ui:${globalThis.crypto.randomUUID()}`;
      }
      await acceptPreferenceProposal(activeProposal, fetch, acceptRequestKeyRef.current);
      if (requestGenerationRef.current !== requestGeneration) return;
      setState("accepted");
    } catch (cause) {
      if (requestGenerationRef.current !== requestGeneration) return;
      if (cause instanceof PreferenceProposalConflictError && activeProposal.structured) {
        try {
          const refreshed = await refreshStructuredPreferenceProposal(activeProposal);
          if (requestGenerationRef.current !== requestGeneration) return;
          acceptRequestKeyRef.current = undefined;
          setActiveProposal(refreshed);
          setError("Preferences changed since this card was created. Review this proposal and try again.");
          setState("error");
          return;
        } catch (refreshCause) {
          if (requestGenerationRef.current !== requestGeneration) return;
          setError(refreshCause instanceof Error ? refreshCause.message : "Pilot could not refresh this proposal.");
          setState("error");
          return;
        }
      }
      setError(cause instanceof Error ? cause.message : "Pilot could not save this preference. Nothing changed.");
      setState("error");
    } finally {
      if (requestGenerationRef.current === requestGeneration) acceptingRef.current = false;
    }
  };

  const reject = async () => {
    if (!canRejectPreference(state, acceptingRef.current)) return;
    const requestGeneration = ++requestGenerationRef.current;
    acceptingRef.current = true;
    setError(undefined);
    if (!activeProposal.structured) {
      setState(rejectPreferenceProposal());
      acceptingRef.current = false;
      return;
    }
    setState("accepting");
    rejectRequestKeyRef.current ??= `ui:${globalThis.crypto.randomUUID()}`;
    try {
      await rejectStructuredPreferenceProposal(activeProposal, rejectRequestKeyRef.current);
      if (requestGenerationRef.current === requestGeneration) setState("rejected");
    } catch (cause) {
      if (requestGenerationRef.current !== requestGeneration) return;
      if (cause instanceof PreferenceProposalConflictError) {
        try {
          const refreshed = await refreshStructuredPreferenceProposal(activeProposal);
          if (requestGenerationRef.current !== requestGeneration) return;
          rejectRequestKeyRef.current = undefined;
          setActiveProposal(refreshed);
          setError("Preferences changed since this card was created. Review this proposal and try again.");
          setState("error");
          return;
        } catch (refreshCause) {
          if (requestGenerationRef.current !== requestGeneration) return;
          setError(refreshCause instanceof Error ? refreshCause.message : "Pilot could not refresh this proposal.");
          setState("error");
          return;
        }
      }
      setError(cause instanceof Error ? cause.message : "Pilot could not reject this preference. Nothing changed.");
      setState("error");
    } finally {
      if (requestGenerationRef.current === requestGeneration) acceptingRef.current = false;
    }
  };

  return (
    <section className="bracket mt-3 border border-approval/35 bg-card" aria-label={`Preference proposal: ${activeProposal.preference}`}>
      <header className="flex items-start gap-3 border-b border-border px-4 py-4">
        <span className="grid h-8 w-8 shrink-0 place-items-center border border-approval/35 text-approval"><SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /></span>
        <div className="min-w-0">
          <p className="label-mono text-approval">Preference proposal</p>
          <h3 className="mt-1 break-words text-sm font-medium tracking-tight">{activeProposal.preference}</h3>
          {activeProposal.reason ? <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{activeProposal.reason}</p> : null}
        </div>
      </header>

      <div className="space-y-3 px-4 py-4">
        <p className="text-xs leading-5 text-muted-foreground">This is only a proposal. Pilot {activeProposal.structured ? "uses it in later chats" : <>updates <span className="font-mono text-foreground/80">Pilot/Profile.md</span></>} only after you explicitly accept.</p>
        {activeProposal.workflowLesson ? (
          <p className="border border-primary/15 bg-primary/[0.04] px-3 py-2 text-xs leading-5 text-muted-foreground">
            A separate workflow lesson backed by a validated trade is awaiting review in Memory. Accepting this preference does not accept that lesson.
          </p>
        ) : null}
        {activeProposal.hermesAdvisory ? (
          <div className="border border-primary/15 bg-primary/[0.04] px-3 py-2 text-xs leading-5 text-muted-foreground">
            <p className="font-semibold text-foreground/85">Optional Hermes review</p>
            <p className="mt-1">{activeProposal.hermesAdvisory.summary}</p>
            {activeProposal.hermesAdvisory.caveats.length ? (
              <ul className="mt-1 list-disc pl-4">
                {activeProposal.hermesAdvisory.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
              </ul>
            ) : null}
            <p className="mt-1 text-[11px]">
              Provider: {activeProposal.hermesAdvisory.disclosure.provider} / {activeProposal.hermesAdvisory.disclosure.model} · bounded redacted proposal data · retention up to {activeProposal.hermesAdvisory.disclosure.retentionDays} days · advisory only
            </p>
          </div>
        ) : null}
        {state === "accepted" ? <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-executed" role="status"><Check className="h-4 w-4" aria-hidden="true" />Accepted and saved to your profile.</p> : null}
        {state === "rejected" ? <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground" role="status"><X className="h-4 w-4" aria-hidden="true" />Not saved. Your profile was unchanged.</p> : null}
        {state === "error" ? <p className="flex items-start gap-2 text-xs leading-5 text-blocked" role="alert"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p> : null}

        {state !== "accepted" && state !== "rejected" ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void accept()} disabled={state === "accepting"} className="inline-flex h-9 items-center gap-2 bg-approval px-3.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-approval-foreground hover:brightness-105 disabled:cursor-wait disabled:opacity-60">
              {state === "accepting" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {state === "accepting" ? "Saving" : state === "error" ? "Try again" : "Accept preference"}
            </button>
            <button type="button" onClick={() => void reject()} disabled={state === "accepting"} className="bracket bracket-light h-9 border border-border bg-white/[0.03] px-3.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45">Reject</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
