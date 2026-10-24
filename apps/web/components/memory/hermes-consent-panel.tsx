"use client";

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  LoaderCircle,
  ShieldOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type HermesConsentDisclosureView = Readonly<{
  provider: string;
  model: string;
  dataPolicy: "bounded-redacted-proposals";
  retentionDays: number;
  termsVersion: string;
}>;

export type HermesRetentionView = Readonly<{
  state: "no-sessions" | "database-absence-verified" | "unverified";
  attempted: number;
  databaseAbsent: number;
  remaining: number | null;
}>;

export type HermesConsentView = Readonly<{
  configured: true;
  activationReady: boolean;
  activationBlock?: string;
  authenticated: true;
  disclosure: HermesConsentDisclosureView;
  consented: boolean;
  expiresAt?: number;
  retention?: HermesRetentionView;
}>;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ConsentAction = "read" | "accept" | "revoke";

export class HermesConsentUnavailableError extends Error {}
export const HERMES_PROVIDER_RETENTION_NOTICE =
  "The disclosed external model provider may independently retain requests under its own policy; that retention is not governed by the Hermes session deletion deadline.";

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const permitted = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  return required.every((key) => key in record) && keys.every((key) => permitted.has(key));
}

export function parseHermesConsentView(value: unknown): HermesConsentView {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pilot returned an invalid Hermes consent state.");
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(
    record,
    ["configured", "activationReady", "authenticated", "disclosure", "consented"],
    ["activationBlock", "expiresAt", "retention"],
  ) || record.configured !== true || record.authenticated !== true ||
      typeof record.activationReady !== "boolean" || typeof record.consented !== "boolean" ||
      (!record.activationReady &&
        (typeof record.activationBlock !== "string" || !record.activationBlock.trim())) ||
      (record.activationReady && record.activationBlock !== undefined) ||
      (record.expiresAt !== undefined &&
        (!Number.isSafeInteger(record.expiresAt) || Number(record.expiresAt) < 0))) {
    throw new Error("Pilot returned an invalid Hermes consent state.");
  }
  const disclosure = record.disclosure;
  if (!disclosure || typeof disclosure !== "object" || Array.isArray(disclosure)) {
    throw new Error("Pilot returned an invalid Hermes disclosure.");
  }
  const detail = disclosure as Record<string, unknown>;
  if (!exactKeys(detail, ["provider", "model", "dataPolicy", "retentionDays", "termsVersion"], []) ||
      typeof detail.provider !== "string" || !detail.provider || detail.provider.length > 64 ||
      typeof detail.model !== "string" || !detail.model || detail.model.length > 128 ||
      detail.dataPolicy !== "bounded-redacted-proposals" ||
      !Number.isSafeInteger(detail.retentionDays) || Number(detail.retentionDays) < 1 ||
      Number(detail.retentionDays) > 30 || typeof detail.termsVersion !== "string" ||
      !detail.termsVersion || detail.termsVersion.length > 64) {
    throw new Error("Pilot returned an invalid Hermes disclosure.");
  }
  if (record.retention !== undefined) {
    if (!record.retention || typeof record.retention !== "object" || Array.isArray(record.retention)) {
      throw new Error("Pilot returned an invalid Hermes retention status.");
    }
    const retention = record.retention as Record<string, unknown>;
    if (!exactKeys(retention, ["state", "attempted", "databaseAbsent", "remaining"], []) ||
        !["no-sessions", "database-absence-verified", "unverified"].includes(String(retention.state)) ||
        ![retention.attempted, retention.databaseAbsent].every(
          (item) => Number.isSafeInteger(item) && Number(item) >= 0 && Number(item) <= 128,
        ) || (retention.remaining !== null &&
          (!Number.isSafeInteger(retention.remaining) || Number(retention.remaining) < 0 ||
            Number(retention.remaining) > 128)) ||
        (retention.remaining === null && retention.state !== "unverified")) {
      throw new Error("Pilot returned an invalid Hermes retention status.");
    }
  }
  return value as HermesConsentView;
}

export async function requestHermesConsent(
  action: ConsentAction,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<HermesConsentView> {
  const response = await fetcher("/api/hermes/consent", action === "read"
    ? { method: "GET", signal }
    : action === "accept"
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "accept" }),
          signal,
        }
      : { method: "DELETE", signal });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Pilot returned an invalid Hermes consent response.");
  }
  if (response.status === 404) {
    throw new HermesConsentUnavailableError("Hermes advisory is disabled");
  }
  if (!response.ok) {
    throw new Error("Pilot could not update Hermes consent. Nothing was activated.");
  }
  return parseHermesConsentView(payload);
}

function retentionMessage(retention: HermesRetentionView | undefined): string | undefined {
  if (!retention) return undefined;
  if (retention.state === "no-sessions") {
    return "Consent was revoked. No Hermes sessions were registered for this scope.";
  }
  if (retention.state === "database-absence-verified") {
    return "Session deletion was requested and Hermes database-row absence was verified. This does not prove every file, compressed ancestor, or other history artifact was erased.";
  }
  return "Consent was revoked, but Hermes database-row absence could not be verified. Retention cleanup remains blocked for operator review.";
}

export function HermesConsentPanel({ scopeKey }: { scopeKey: string }) {
  const [view, setView] = useState<HermesConsentView>();
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState<"accept" | "revoke">();
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const mutationController = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    setError(undefined);
    try {
      const next = await requestHermesConsent("read", fetch, signal);
      if (generation.current === current) setView(next);
    } catch (cause) {
      if (generation.current !== current) return;
      if (cause instanceof HermesConsentUnavailableError) setDisabled(true);
      else setError(cause instanceof Error ? cause.message : "Hermes consent is unavailable.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setView(undefined);
    setDisabled(false);
    setBusy(undefined);
    setError(undefined);
    void load(controller.signal);
    return () => {
      controller.abort();
      mutationController.current?.abort();
      generation.current += 1;
    };
  }, [load, scopeKey]);

  const mutate = async (action: "accept" | "revoke") => {
    if (busy) return;
    const current = generation.current;
    const controller = new AbortController();
    mutationController.current = controller;
    setBusy(action);
    setError(undefined);
    try {
      const next = await requestHermesConsent(action, fetch, controller.signal);
      if (generation.current === current) setView(next);
    } catch (cause) {
      if (generation.current === current) {
        setError(cause instanceof Error ? cause.message : "Pilot could not update Hermes consent.");
      }
    } finally {
      if (mutationController.current === controller) mutationController.current = undefined;
      if (generation.current === current) setBusy(undefined);
    }
  };

  if (disabled) return null;
  const disclosure = view?.disclosure;
  const cleanup = retentionMessage(view?.retention);
  return (
    <section className="rounded-2xl border border-white/8 bg-card/72 p-4" aria-labelledby="hermes-consent-title">
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </span>
        <div>
          <h2 id="hermes-consent-title" className="text-sm font-semibold">Hermes workflow advisor</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Optional external model review for redacted, advisory-only workflow proposals. It cannot sign, spend, route, execute, or change policy.
          </p>
        </div>
      </div>

      {!view && !error ? (
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />Loading disclosure…
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-blocked" role="alert">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}
        </p>
      ) : null}

      {disclosure ? (
        <dl className="mt-4 grid gap-2 rounded-xl border border-white/8 bg-background/25 p-3 text-xs">
          <div><dt className="text-muted-foreground">Provider / model</dt><dd className="break-words font-semibold">{disclosure.provider} / {disclosure.model}</dd></div>
          <div><dt className="text-muted-foreground">Data sent</dt><dd>Bounded, explicitly redacted proposal context only</dd></div>
          <div><dt className="text-muted-foreground">Retention deadline</dt><dd>Sessions are registered for deletion after at most {disclosure.retentionDays} days. Activation requires the durable deletion sweep to be attested. Only Hermes DB-row absence can be verified; complete artifact erasure is not claimed. {HERMES_PROVIDER_RETENTION_NOTICE}</dd></div>
          <div><dt className="text-muted-foreground">Terms version</dt><dd>{disclosure.termsVersion}</dd></div>
        </dl>
      ) : null}

      {view && !view.activationReady ? (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-2.5 text-xs leading-5 text-muted-foreground" role="status">
          <ShieldOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
          Hermes activation is blocked ({view.activationBlock}). Saving consent does not enable model calls. The dedicated profile must keep tools and compression disabled.
        </p>
      ) : null}
      {view?.activationReady ? (
        <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-muted-foreground" role="status">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          The server reports the reviewed activation gates ready. Consent still controls use for this wallet scope.
        </p>
      ) : null}
      {cleanup ? (
        <p className={`mt-3 text-xs leading-5 ${view?.retention?.state === "unverified" ? "text-blocked" : "text-muted-foreground"}`} role={view?.retention?.state === "unverified" ? "alert" : "status"}>
          {cleanup}
        </p>
      ) : null}

      {view ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {view.consented ? (
            <button type="button" disabled={Boolean(busy)} onClick={() => void mutate("revoke")} className="rounded-lg border border-blocked/30 px-3 py-1.5 text-[11px] font-semibold text-blocked disabled:opacity-50">
              {busy === "revoke" ? "Revoking…" : "Revoke consent"}
            </button>
          ) : (
            <button type="button" disabled={Boolean(busy)} onClick={() => void mutate("accept")} className="rounded-lg bg-primary px-3 py-1.5 text-[11px] font-semibold text-primary-foreground disabled:opacity-50">
              {busy === "accept" ? "Saving…" : "Accept disclosure"}
            </button>
          )}
          <span className="text-[10px] text-muted-foreground">
            {view.consented ? `Consented${view.expiresAt ? ` until ${new Date(view.expiresAt).toLocaleDateString()}` : ""}` : "Not consented"}
          </span>
        </div>
      ) : null}
    </section>
  );
}
