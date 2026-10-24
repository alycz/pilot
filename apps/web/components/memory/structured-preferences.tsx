"use client";

import type { StructuredPreferenceRecord } from "@pilot/vault";
import {
  AlertTriangle,
  Check,
  Eraser,
  LoaderCircle,
  PencilLine,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type PreferenceView = { revision: number; records: StructuredPreferenceRecord[] };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type PreferenceAction =
  | { action: "list" }
  | {
      action: "accept" | "reject" | "forget";
      recordId: string;
      expectedRevision: number;
      expectedVersion: number;
      idempotencyKey: string;
    }
  | {
      action: "correct";
      recordId: string;
      expectedRevision: number;
      expectedVersion: number;
      idempotencyKey: string;
      value: string;
    };

export class StructuredPreferencesDisabledError extends Error {}
export class StructuredPreferenceConflictError extends Error {}

export class StructuredPreferenceMutationGuard {
  private active = false;
  begin(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }
  end(): void { this.active = false; }
}

export function shouldApplyStructuredPreferenceResponse(expected: number, current: number): boolean {
  return expected === current;
}

export function structuredPreferenceFailureAction(cause: unknown): "reload" | "error" {
  return cause instanceof StructuredPreferenceConflictError ? "reload" : "error";
}

export function normalizedStructuredPreferenceCorrection(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export async function requestStructuredPreferences(
  action: PreferenceAction,
  fetcher: Fetcher = fetch,
): Promise<PreferenceView> {
  const response = await fetcher("/api/vault/preferences/structured", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
  let payload: {
    data?: { revision?: unknown; records?: unknown };
    error?: { code?: unknown; message?: unknown };
  } = {};
  try {
    payload = await response.json() as typeof payload;
  } catch {
    // Keep the safe generic failure below.
  }
  if (response.status === 404 && payload.error?.code === "STRUCTURED_PREFERENCES_DISABLED") {
    throw new StructuredPreferencesDisabledError("Structured preferences are disabled");
  }
  if (response.status === 409) {
    throw new StructuredPreferenceConflictError(
      typeof payload.error?.message === "string" ? payload.error.message : "Structured preference conflict",
    );
  }
  if (!response.ok) {
    throw new Error(
      typeof payload.error?.message === "string" && payload.error.message.trim()
        ? payload.error.message
        : "Pilot could not update structured preferences. Nothing changed.",
    );
  }
  if (
    !Number.isSafeInteger(payload.data?.revision) ||
    (payload.data?.revision as number) < 0 ||
    !Array.isArray(payload.data?.records)
  ) {
    throw new Error("Pilot returned an invalid structured preference confirmation.");
  }
  return {
    revision: payload.data.revision as number,
    records: payload.data.records as StructuredPreferenceRecord[],
  };
}

function operationId(): string {
  return `ui:${globalThis.crypto.randomUUID()}`;
}

export class StructuredPreferenceRequestCache {
  private readonly requests = new Map<string, PreferenceAction>();

  mutation(
    record: StructuredPreferenceRecord,
    revision: number,
    action: "accept" | "reject" | "forget" | "correct",
    value?: string,
  ): PreferenceAction {
    const signature = [action, record.id, record.version, value ?? ""].join("\0");
    const existing = this.requests.get(signature);
    if (existing) return existing;
    const base = {
      recordId: record.id,
      expectedRevision: revision,
      expectedVersion: record.version,
      idempotencyKey: operationId(),
    };
    const request: PreferenceAction = action === "correct"
      ? { ...base, action, value: value! }
      : { ...base, action };
    this.requests.set(signature, request);
    return request;
  }

  confirm(request: PreferenceAction): void {
    for (const [signature, candidate] of this.requests) {
      if (candidate === request) this.requests.delete(signature);
    }
  }

  clear(): void {
    this.requests.clear();
  }
}

export function StructuredPreferencesPanel({ scopeKey }: { scopeKey: string }) {
  const [view, setView] = useState<PreferenceView>();
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [correction, setCorrection] = useState<Record<string, string>>({});
  const generation = useRef(0);
  const mutationGuard = useRef(new StructuredPreferenceMutationGuard());
  const requestCache = useRef(new StructuredPreferenceRequestCache());

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(undefined);
    try {
      const next = await requestStructuredPreferences({ action: "list" });
      if (generation.current === current) setView(next);
    } catch (cause) {
      if (generation.current !== current) return;
      if (cause instanceof StructuredPreferencesDisabledError) setDisabled(true);
      else setError(cause instanceof Error ? cause.message : "Structured preferences are unavailable.");
    }
  }, []);

  useEffect(() => {
    setView(undefined);
    setDisabled(false);
    setError(undefined);
    setCorrection({});
    void load();
    mutationGuard.current.end();
    requestCache.current.clear();
    setBusy(undefined);
    return () => {
      generation.current += 1;
      mutationGuard.current.end();
      requestCache.current.clear();
    };
  }, [load, scopeKey]);

  const mutate = async (
    record: StructuredPreferenceRecord,
    action: "accept" | "reject" | "forget" | "correct",
  ) => {
    if (!view) return;
    const nextValue = normalizedStructuredPreferenceCorrection(correction[record.id]);
    if (action === "correct" && !nextValue) {
      setError("Enter the corrected preference before saving it.");
      return;
    }
    if (!mutationGuard.current.begin()) return;
    const requestGeneration = generation.current;
    setBusy(record.id);
    setError(undefined);
    const request = requestCache.current.mutation(record, view.revision, action, nextValue);
    try {
      const next = await requestStructuredPreferences(request);
      if (!shouldApplyStructuredPreferenceResponse(requestGeneration, generation.current)) return;
      requestCache.current.confirm(request);
      setView(next);
      setCorrection((current) => ({ ...current, [record.id]: "" }));
    } catch (cause) {
      if (!shouldApplyStructuredPreferenceResponse(requestGeneration, generation.current)) return;
      if (structuredPreferenceFailureAction(cause) === "reload") {
        requestCache.current.confirm(request);
        mutationGuard.current.end();
        setBusy(undefined);
        await load();
        return;
      }
      setError(cause instanceof Error ? cause.message : "Pilot could not update the preference.");
    } finally {
      if (shouldApplyStructuredPreferenceResponse(requestGeneration, generation.current)) {
        mutationGuard.current.end();
        setBusy(undefined);
      }
    }
  };

  if (disabled) return null;
  const visible = view?.records.filter((record) =>
    record.status === "proposed" || record.status === "accepted") ?? [];

  return (
    <section className="rounded-2xl border border-white/8 bg-card/72 p-4" aria-labelledby="structured-preferences-title">
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <SlidersHorizontal className="h-4 w-4" />
        </span>
        <div>
          <h2 id="structured-preferences-title" className="text-sm font-semibold">Personal preferences</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Preferences affect presentation and workflow only. They never grant signing, spending, or policy authority.
          </p>
        </div>
      </div>

      {!view && !error ? (
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />Loading preferences…
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-blocked" role="alert">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}
        </p>
      ) : null}
      {view && visible.length === 0 ? (
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          No structured preferences are active or awaiting review. Legacy profile strings remain unchanged.
        </p>
      ) : null}

      <div className="mt-4 space-y-3">
        {visible.map((record) => (
          <article key={record.id} className="rounded-xl border border-white/8 bg-background/25 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">
                  {record.category} · {record.origin}
                </p>
                <p className="mt-1 break-words text-xs font-semibold">{record.value}</p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">{record.key} · v{record.version}</p>
              </div>
              <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-muted-foreground">
                {record.status}
              </span>
            </div>

            {record.status === "proposed" ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={Boolean(busy)} onClick={() => void mutate(record, "accept")} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-semibold text-primary-foreground disabled:opacity-50"><Check className="h-3 w-3" />Accept</button>
                <button type="button" disabled={Boolean(busy)} onClick={() => void mutate(record, "reject")} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground disabled:opacity-50"><X className="h-3 w-3" />Reject</button>
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground" htmlFor={`correction-${record.id}`}>Correct this preference</label>
                <textarea id={`correction-${record.id}`} value={correction[record.id] ?? ""} onChange={(event) => setCorrection((current) => ({ ...current, [record.id]: event.target.value }))} maxLength={500} rows={2} className="w-full resize-y rounded-lg border border-white/10 bg-background/40 px-3 py-2 text-xs outline-none focus:border-primary/50" />
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={Boolean(busy)} onClick={() => void mutate(record, "correct")} className="inline-flex items-center gap-1.5 rounded-lg border border-primary/25 px-3 py-1.5 text-[11px] font-semibold text-primary disabled:opacity-50"><PencilLine className="h-3 w-3" />Save correction</button>
                  <button type="button" disabled={Boolean(busy)} onClick={() => void mutate(record, "forget")} className="inline-flex items-center gap-1.5 rounded-lg border border-blocked/25 px-3 py-1.5 text-[11px] font-semibold text-blocked disabled:opacity-50"><Eraser className="h-3 w-3" />Forget</button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
