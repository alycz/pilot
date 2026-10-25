"use client";

import React, { useState } from "react";

import type {
  WorkAgreementFixtureRequest,
  WorkAgreementFixtureView,
} from "./work-agreement-fixture";

async function fixtureRequest(
  body: WorkAgreementFixtureRequest,
): Promise<WorkAgreementFixtureView> {
  const response = await fetch("/api/agreements/fixture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as WorkAgreementFixtureView | { error?: string };
  if (!response.ok) {
    throw new Error("error" in payload && payload.error
      ? payload.error
      : "The work-agreement fixture is unavailable.");
  }
  return payload as WorkAgreementFixtureView;
}

export function WorkAgreementFixtureViewComponent() {
  const [view, setView] = useState<WorkAgreementFixtureView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (request: WorkAgreementFixtureRequest) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setView(await fixtureRequest(request));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The fixture failed.");
    } finally {
      setBusy(false);
    }
  };

  const approval = view?.approval;
  return (
    <div className="mx-auto min-h-[calc(100dvh-4rem)] max-w-4xl space-y-6 px-4 py-10 sm:px-6">
      <header className="space-y-3">
        <p className="label-mono">Ledger work agreement · offline fixture</p>
        <h1 className="text-3xl font-semibold tracking-tight">Escrow approval lifecycle</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Exercise exact EscrowCreate, EscrowFinish, and EscrowCancel review states without a device,
          credential, network request, or ledger transaction.
        </p>
      </header>

      <section className="rounded-xl border border-blocked/35 bg-blocked/10 p-4 text-sm leading-6" role="note">
        Recorded fixture only. No Ledger or Speculos signed these blobs, the signatures are not valid,
        and nothing is submitted to XRPL. The fixture route is disabled unless a local opt-in flag is set.
      </section>

      {!view ? (
        <button
          className="bg-approval px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-approval-foreground disabled:opacity-45"
          disabled={busy}
          onClick={() => void run({ action: "start" })}
          type="button"
        >
          {busy ? "Starting fixture" : "Start offline fixture"}
        </button>
      ) : (
        <section className="space-y-5 border border-border bg-card p-5" aria-label="Work agreement fixture state">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-medium">{view.status.replaceAll("_", " ")}</h2>
            <span className="border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-wide">
              {view.provenance}
            </span>
          </div>
          <dl className="grid gap-px border border-border bg-border text-xs sm:grid-cols-2">
            <FixtureTerm label="Owner" value={view.terms.owner} />
            <FixtureTerm label="Counterparty" value={view.terms.counterparty} />
            <FixtureTerm label="Native XRP amount" value={`${view.terms.amountDrops} drops`} />
            <FixtureTerm label="Network" value={view.terms.network} />
            <FixtureTerm label="FinishAfter" value={String(view.terms.finishAfter ?? "Condition only")} />
            <FixtureTerm label="CancelAfter" value={String(view.terms.cancelAfter ?? "None")} />
            <FixtureTerm label="Condition" value={view.terms.condition ?? "None"} />
            <FixtureTerm label="Network requests" value={String(view.networkRequestsMade)} />
          </dl>

          {approval ? (
            <div className="space-y-3 border border-approval/35 bg-approval/[0.06] p-4">
              <p className="font-mono text-xs uppercase tracking-wide">
                Exact {approval.action} approval · owner required
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-background p-3 text-[11px] leading-5">
                {JSON.stringify(approval.txJson, null, 2)}
              </pre>
              <button
                className="bg-approval px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-approval-foreground disabled:opacity-45"
                disabled={busy}
                onClick={() => void run({
                  action: "submit_recorded_blob",
                  phase: approval.action,
                  signed_blob: approval.recordedFixtureBlob,
                })}
                type="button"
              >
                {busy ? "Applying fixture" : `Apply recorded ${approval.action} blob`}
              </button>
            </div>
          ) : null}

          {view.status === "active" ? (
            <div className="flex flex-wrap gap-2">
              <button
                className="border border-executed/40 px-4 py-2 font-mono text-xs uppercase tracking-wide"
                disabled={busy}
                onClick={() => void run({ action: "prepare", phase: "release" })}
                type="button"
              >
                Prepare owner release
              </button>
              <button
                className="border border-blocked/40 px-4 py-2 font-mono text-xs uppercase tracking-wide"
                disabled={busy}
                onClick={() => void run({ action: "prepare", phase: "cancel" })}
                type="button"
              >
                Prepare owner cancel
              </button>
            </div>
          ) : null}

          {view.validation ? (
            <p className="border border-executed/30 bg-executed/10 p-3 text-xs leading-5">
              Deterministic fixture marked {view.validation.action} validated at fixture ledger {view.validation.ledgerIndex}.
              This is not public-ledger evidence.
            </p>
          ) : null}
        </section>
      )}

      {error ? <p className="text-sm text-blocked" role="alert">{error}</p> : null}
    </div>
  );
}

function FixtureTerm({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-card p-3">
      <dt className="label-mono">{label}</dt>
      <dd className="mt-1 break-all font-mono text-[11px]">{value}</dd>
    </div>
  );
}
