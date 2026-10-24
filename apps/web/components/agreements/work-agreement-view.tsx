"use client";

import Link from "next/link";
import React from "react";

import type {
  WorkAgreementPublicState,
  WorkAgreementRecovery,
} from "./work-agreement-runtime-client";

export type WorkAgreementDraft = Readonly<{
  amountDrops: string;
  cancelAfter: string;
  counterparty: string;
  finishAfter: string;
}>;

type WorkAgreementViewProps = Readonly<{
  busy: boolean;
  draft: WorkAgreementDraft;
  error?: string;
  notice?: string;
  owner?: string;
  record?: WorkAgreementPublicState;
  recovery?: WorkAgreementRecovery;
  recoveryBlocked?: boolean;
  onChange: (field: keyof WorkAgreementDraft, value: string) => void;
  onClear: () => void;
  onCreate: () => void;
  onPrepareCancel: () => void;
  onPrepareRelease: () => void;
  onRecover: () => void;
  onRefresh: () => void;
  onReject: () => void;
  onReview: () => void;
}>;

const TERMINAL = new Set(["released", "cancelled", "rejected", "expired"]);

function Field({
  label,
  name,
  value,
  onChange,
}: Readonly<{
  label: string;
  name: keyof WorkAgreementDraft;
  value: string;
  onChange: WorkAgreementViewProps["onChange"];
}>) {
  return (
    <label className="space-y-2 text-sm">
      <span className="label-mono block">{label}</span>
      <input
        className="h-11 w-full rounded-lg border border-border bg-background px-3 font-mono text-xs text-foreground outline-none transition focus:border-approval focus:ring-2 focus:ring-approval/20"
        name={name}
        onChange={(event) => onChange(name, event.currentTarget.value)}
        spellCheck={false}
        value={value}
      />
    </label>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
  primary = false,
}: React.PropsWithChildren<Readonly<{
  disabled: boolean;
  onClick: () => void;
  primary?: boolean;
}>>) {
  return (
    <button
      className={primary
        ? "min-h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-45"
        : "min-h-11 rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-45"}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export function WorkAgreementView({
  busy,
  draft,
  error,
  notice,
  owner,
  record,
  recovery,
  recoveryBlocked = false,
  onChange,
  onClear,
  onCreate,
  onPrepareCancel,
  onPrepareRelease,
  onRecover,
  onRefresh,
  onReject,
  onReview,
}: WorkAgreementViewProps) {
  const hasTrackingLock = recovery !== undefined || recoveryBlocked;
  const preparationUncertain = recovery?.phase === "prepare_pending" ||
    recovery?.phase === "prepare_unknown";
  const canCreate = owner !== undefined && record === undefined && !hasTrackingLock;
  const recoverableSubmission = recovery?.phase === "submission_pending" ||
    recovery?.phase === "submission_unknown";

  return (
    <main className="mx-auto min-h-[calc(100dvh-4rem)] max-w-5xl space-y-8 px-4 py-10 sm:px-6">
      <header className="grid gap-5 border-b border-border pb-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div className="space-y-3">
          <p className="label-mono">Ledger work agreements · Testnet</p>
          <h1 className="font-serif text-4xl font-medium tracking-tight sm:text-5xl">
            Owner-reviewed escrow workspace
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Prepare one bounded XRP Testnet escrow, review the exact transaction, and sign only
            with the Ledger account already bound to this Pilot session. The server relays the
            signed blob; the wallet never submits it directly.
          </p>
        </div>
        <Link
          className="text-sm text-muted-foreground underline decoration-border underline-offset-4 transition hover:text-foreground"
          href="/agreements?demo=recorded"
        >
          Open recorded offline demo
        </Link>
      </header>

      <section className="rounded-xl border border-approval/30 bg-approval/[0.05] p-4 text-sm leading-6" role="note">
        <strong>Local mock settlement only.</strong> This route is Testnet-only and default-off.
        A valid Ledger signature proves control of the selected signing key; it does not attest a
        physical device or create public-ledger evidence.
      </section>

      {!owner ? (
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-serif text-2xl font-medium">Connect the owner account first</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Use Pilot onboarding to establish an authenticated XRPL Testnet session, then return
            here. No agreement or recovery state is loaded for signed-out sessions.
          </p>
        </section>
      ) : (
        <section className="rounded-xl border border-border bg-card p-5 sm:p-6" aria-label="Work agreement workspace">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
            <div>
              <p className="label-mono">Authenticated owner</p>
              <p className="mt-2 break-all font-mono text-xs">{owner}</p>
            </div>
            <span className="rounded-md border border-executed/35 bg-executed/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wide">
              XRPL Testnet
            </span>
          </div>

          {!record ? (
            <div className="mt-6 space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Counterparty classic address" name="counterparty" onChange={onChange} value={draft.counterparty} />
                <Field label="Native XRP amount · drops" name="amountDrops" onChange={onChange} value={draft.amountDrops} />
                <Field label="FinishAfter · Ripple epoch seconds" name="finishAfter" onChange={onChange} value={draft.finishAfter} />
                <Field label="CancelAfter · Ripple epoch seconds" name="cancelAfter" onChange={onChange} value={draft.cancelAfter} />
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                Preparing creates a durable reference before any request. If the outcome is
                unknown, refresh that exact reference instead of preparing a replacement.
              </p>
              <ActionButton disabled={busy || !canCreate} onClick={onCreate} primary>
                {busy ? "Preparing" : hasTrackingLock ? "Resolve saved agreement first" : "Prepare escrow agreement"}
              </ActionButton>
              {recovery !== undefined ? (
                <ActionButton disabled={busy} onClick={onRefresh}>Refresh durable status</ActionButton>
              ) : null}
            </div>
          ) : (
            <div className="mt-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="label-mono">Durable agreement</p>
                  <p className="mt-2 break-all font-mono text-xs">{record.agreement_id}</p>
                </div>
                <span className="rounded-md border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-wide">
                  {record.status.replaceAll("_", " ")} · revision {record.revision}
                </span>
              </div>

              <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border text-xs sm:grid-cols-2">
                <AgreementTerm label="Counterparty" value={record.terms.counterparty} />
                <AgreementTerm label="Amount" value={`${record.terms.amount_drops} drops`} />
                <AgreementTerm label="FinishAfter" value={String(record.terms.finish_after ?? "Not set")} />
                <AgreementTerm label="CancelAfter" value={String(record.terms.cancel_after ?? "Not set")} />
                <AgreementTerm label="Action" value={record.action ?? "Tracking"} />
                <AgreementTerm label="Network requests" value={String(record.network_requests_made)} />
              </dl>

              {record.approval ? (
                <section className="space-y-3 rounded-xl border border-approval/35 bg-approval/[0.05] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-mono text-xs uppercase tracking-wide">
                      Exact {record.approval.action} approval
                    </p>
                    <span className="text-xs text-muted-foreground">
                      Expires {new Date(record.approval.expires_at).toLocaleString()}
                    </span>
                  </div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background p-3 text-[11px] leading-5">
                    {JSON.stringify(record.approval.tx_json, null, 2)}
                  </pre>
                </section>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {record.status === "awaiting_approval" ? (
                  <>
                    {!recoverableSubmission ? (
                      <>
                        <ActionButton disabled={busy} onClick={onReview} primary>Review exact transaction</ActionButton>
                        <ActionButton disabled={busy} onClick={onReject}>Reject prepared approval</ActionButton>
                      </>
                    ) : null}
                  </>
                ) : null}
                {record.status === "active" ? (
                  <>
                    {record.terms.condition === undefined ? (
                      <ActionButton disabled={busy || preparationUncertain} onClick={onPrepareRelease} primary>Prepare owner release</ActionButton>
                    ) : (
                      <p className="w-full text-xs leading-5 text-muted-foreground">
                        Conditioned release requires an exact fulfillment and is unavailable in this bounded workspace.
                      </p>
                    )}
                    <ActionButton disabled={busy || preparationUncertain} onClick={onPrepareCancel}>Prepare owner cancellation</ActionButton>
                  </>
                ) : null}
                {recoverableSubmission ? (
                  <ActionButton disabled={busy} onClick={onRecover} primary>Recover exact submission</ActionButton>
                ) : null}
                {!TERMINAL.has(record.status) || hasTrackingLock ? (
                  <ActionButton disabled={busy} onClick={onRefresh}>Refresh durable status</ActionButton>
                ) : null}
                {TERMINAL.has(record.status) ? (
                  <ActionButton disabled={busy} onClick={onClear}>Clear terminal view</ActionButton>
                ) : null}
              </div>
            </div>
          )}
        </section>
      )}

      {notice ? <p className="rounded-xl border border-executed/30 bg-executed/10 p-4 text-sm" role="status">{notice}</p> : null}
      {error ? <p className="rounded-xl border border-blocked/35 bg-blocked/10 p-4 text-sm text-blocked" role="alert">{error}</p> : null}
    </main>
  );
}

function AgreementTerm({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="min-w-0 bg-card p-3">
      <dt className="label-mono">{label}</dt>
      <dd className="mt-1 break-all font-mono text-[11px]">{value}</dd>
    </div>
  );
}
