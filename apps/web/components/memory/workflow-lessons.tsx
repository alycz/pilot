"use client";

import type { WorkflowLessonTarget } from "@pilot/agent/workflow-lessons";
import {
  AlertTriangle,
  Check,
  Eraser,
  GraduationCap,
  LoaderCircle,
  PencilLine,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type WorkflowLessonPublicRecord = {
  id: string;
  proposalId: string;
  target: WorkflowLessonTarget;
  evidenceCount: number;
  status: "proposed" | "accepted" | "rejected" | "superseded" | "forgotten";
  version: number;
  createdAt?: string;
  updatedAt?: string;
};

type LessonView = { revision: number; records: WorkflowLessonPublicRecord[] };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type LessonAction =
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
      lesson: WorkflowLessonTarget;
    };

export const WORKFLOW_LESSON_OPTIONS = {
  response_detail: ["concise", "balanced", "detailed"],
  evidence_layout: ["summary_first", "sources_first", "comparison_table"],
  approval_explanation: ["plain_language", "technical_detail", "step_by_step"],
  comparison_emphasis: ["best_price_first", "risk_caveats_first", "balanced"],
  research_risk_posture: ["capital_preservation_first", "balanced", "opportunity_first"],
} as const satisfies Record<WorkflowLessonTarget["category"], readonly string[]>;

export class WorkflowLessonsDisabledError extends Error {}
export class WorkflowLessonConflictError extends Error {}

export class WorkflowLessonMutationGuard {
  private active = false;
  begin(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }
  end(): void { this.active = false; }
}

function operationId(): string {
  return `lesson_ui_${globalThis.crypto.randomUUID()}`;
}

export async function requestWorkflowLessons(
  action: LessonAction,
  fetcher: Fetcher = fetch,
): Promise<LessonView> {
  const response = await fetcher("/api/vault/lessons", {
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
    // The safe generic error below intentionally hides malformed responses.
  }
  if (response.status === 404 && payload.error?.code === "WORKFLOW_LESSONS_DISABLED") {
    throw new WorkflowLessonsDisabledError("Workflow lessons are disabled");
  }
  if (response.status === 409) {
    throw new WorkflowLessonConflictError(
      typeof payload.error?.message === "string" ? payload.error.message : "Workflow lesson conflict",
    );
  }
  if (!response.ok) {
    throw new Error(
      typeof payload.error?.message === "string" && payload.error.message.trim()
        ? payload.error.message
        : "Pilot could not update workflow lessons. Nothing changed.",
    );
  }
  if (!Number.isSafeInteger(payload.data?.revision) || (payload.data?.revision as number) < 0 ||
      !Array.isArray(payload.data?.records)) {
    throw new Error("Pilot returned an invalid workflow lesson confirmation.");
  }
  return {
    revision: payload.data.revision as number,
    records: payload.data.records as WorkflowLessonPublicRecord[],
  };
}

export class WorkflowLessonRequestCache {
  private readonly requests = new Map<string, LessonAction>();

  mutation(
    record: WorkflowLessonPublicRecord,
    revision: number,
    action: "accept" | "reject" | "forget" | "correct",
    target?: WorkflowLessonTarget,
  ): LessonAction {
    const signature = [action, record.id, record.version, JSON.stringify(target ?? null)].join("\0");
    const existing = this.requests.get(signature);
    if (existing) return existing;
    const base = {
      recordId: record.id,
      expectedRevision: revision,
      expectedVersion: record.version,
      idempotencyKey: operationId(),
    };
    const request: LessonAction = action === "correct"
      ? { ...base, action, lesson: target! }
      : { ...base, action };
    this.requests.set(signature, request);
    return request;
  }

  confirm(request: LessonAction): void {
    for (const [key, candidate] of this.requests) {
      if (candidate === request) this.requests.delete(key);
    }
  }

  clear(): void { this.requests.clear(); }
}

function title(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function WorkflowLessonsPanel({ scopeKey }: { scopeKey: string }) {
  const [view, setView] = useState<LessonView>();
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const generation = useRef(0);
  const guard = useRef(new WorkflowLessonMutationGuard());
  const cache = useRef(new WorkflowLessonRequestCache());

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(undefined);
    try {
      const next = await requestWorkflowLessons({ action: "list" });
      if (generation.current === current) setView(next);
    } catch (cause) {
      if (generation.current !== current) return;
      if (cause instanceof WorkflowLessonsDisabledError) setDisabled(true);
      else setError(cause instanceof Error ? cause.message : "Workflow lessons are unavailable.");
    }
  }, []);

  useEffect(() => {
    setView(undefined);
    setDisabled(false);
    setError(undefined);
    setCorrections({});
    guard.current.end();
    cache.current.clear();
    setBusy(undefined);
    void load();
    return () => {
      generation.current += 1;
      guard.current.end();
      cache.current.clear();
    };
  }, [load, scopeKey]);

  const mutate = async (
    record: WorkflowLessonPublicRecord,
    action: "accept" | "reject" | "forget" | "correct",
  ) => {
    if (!view || !guard.current.begin()) return;
    const requestGeneration = generation.current;
    setBusy(record.id);
    setError(undefined);
    let target: WorkflowLessonTarget | undefined;
    if (action === "correct") {
      const value = corrections[record.id];
      if (!value || !WORKFLOW_LESSON_OPTIONS[record.target.category].includes(value as never)) {
        guard.current.end();
        setBusy(undefined);
        setError("Choose a supported lesson correction.");
        return;
      }
      target = { category: record.target.category, value } as WorkflowLessonTarget;
    }
    const request = cache.current.mutation(record, view.revision, action, target);
    try {
      const next = await requestWorkflowLessons(request);
      if (generation.current !== requestGeneration) return;
      cache.current.confirm(request);
      setView(next);
      setCorrections((current) => ({ ...current, [record.id]: "" }));
    } catch (cause) {
      if (generation.current !== requestGeneration) return;
      if (cause instanceof WorkflowLessonConflictError) {
        cache.current.confirm(request);
        guard.current.end();
        setBusy(undefined);
        await load();
        return;
      }
      setError(cause instanceof Error ? cause.message : "Pilot could not update the lesson.");
    } finally {
      if (generation.current === requestGeneration) {
        guard.current.end();
        setBusy(undefined);
      }
    }
  };

  if (disabled) return null;
  const records = view?.records.filter((record) =>
    record.status === "proposed" || record.status === "accepted") ?? [];

  return (
    <section className="rounded-2xl border border-white/8 bg-card/72 p-4" aria-labelledby="workflow-lessons-title">
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary">
          <GraduationCap className="h-4 w-4" />
        </span>
        <div>
          <h2 id="workflow-lessons-title" className="text-sm font-semibold">Workflow lessons</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Lessons require your explicit review. Trade-linked lessons also require a validated record, which says nothing about performance. Lessons affect explanations, research ordering, and layout only—never signing, spending, routing, or policy.
          </p>
        </div>
      </div>

      {!view && !error ? (
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />Loading lessons…
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-blocked" role="alert">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}
        </p>
      ) : null}
      {view && records.length === 0 ? (
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          No workflow lessons are active or waiting for review.
        </p>
      ) : null}

      <div className="mt-4 space-y-3">
        {records.map((record) => (
          <article key={record.id} className="rounded-xl border border-white/8 bg-background/25 p-3 overflow-hidden">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-primary">
                  {title(record.target.category)}
                </p>
                <p className="mt-1 text-xs font-semibold">{title(record.target.value)}</p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  v{record.version} · {record.evidenceCount} evidence {record.evidenceCount === 1 ? "reference" : "references"}
                </p>
              </div>
              <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-muted-foreground">
                {record.status === "proposed" ? "needs review" : "accepted"}
              </span>
            </div>

            {record.status === "proposed" ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={Boolean(busy)} onClick={() => void mutate(record, "accept")} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-semibold text-primary-foreground disabled:opacity-50"><Check className="h-3 w-3" />Accept lesson</button>
                <button type="button" disabled={Boolean(busy)} onClick={() => void mutate(record, "reject")} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground disabled:opacity-50"><X className="h-3 w-3" />Reject</button>
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                <label className="block text-xs font-semibold text-muted-foreground" htmlFor={`lesson-correction-${record.id}`}>Correct this lesson</label>
                <select id={`lesson-correction-${record.id}`} value={corrections[record.id] ?? ""} onChange={(event) => setCorrections((current) => ({ ...current, [record.id]: event.target.value }))} className="w-full rounded-lg border border-white/10 bg-background/40 px-3 py-2 text-xs outline-none focus:border-primary/50">
                  <option value="">Choose a replacement</option>
                  {WORKFLOW_LESSON_OPTIONS[record.target.category]
                    .filter((value) => value !== record.target.value)
                    .map((value) => <option key={value} value={value}>{title(value)}</option>)}
                </select>
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
