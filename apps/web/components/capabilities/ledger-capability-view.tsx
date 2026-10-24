import React from "react";

import {
  CAPABILITY_SCOPE,
  type CapabilityGrant,
  type CapabilityInvocation,
} from "./ledger-capability-client";

export type LedgerCapabilityViewProps = Readonly<{
  owner?: string;
  grant?: CapabilityGrant;
  state?: CapabilityGrant["state"];
  remainingUses?: number;
  bound: boolean;
  busy: boolean;
  hasTrackedReference: boolean;
  recoveryPhase?: string;
  invocationRecoveryId?: string;
  revocationRecoveryId?: string;
  reviewOpen: boolean;
  lastInvocation?: CapabilityInvocation;
  notice?: string;
  error?: string;
  onPrepare(): void;
  onRefresh(): void;
  onInvoke(): void;
  onRecoverInvocation(): void;
  onReplayInvocation(): void;
  onPrepareRevocation(): void;
  onRecoverRevocation(): void;
  onDiscardPrepared(): void;
  onClearFinished(): void;
}>;

/** Presentation-only shell. Session, recovery, proof, and invocation state stay in the controller. */
export function LedgerCapabilityView(props: LedgerCapabilityViewProps) {
  const { grant, state } = props;
  const preparationUnknown = props.recoveryPhase === "prepare_pending" ||
    props.recoveryPhase === "prepare_unknown";
  return (
    <main className="min-h-[800px] bg-background px-4 py-8 text-foreground">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <header className="border-b border-border pb-4">
          <p className="label-mono text-primary">Ledger capability broker</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold tracking-[-0.04em]">Grant a scope, never an API key.</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Prepare, owner-sign, invoke, replay safely, and revoke one fixed local mock capability. The agent sees only an opaque reference.</p>
        </header>

        <p className="rounded-xl border border-warning/35 bg-warning/[0.06] px-4 py-3 text-xs font-semibold text-warning" role="note">
          Default off · local Testnet mock only · no production credential is created · a valid signature proves account-key control, not a physical Ledger.
        </p>

        <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border text-sm sm:grid-cols-3">
          <div className="bg-card p-3"><dt className="label-mono text-muted-foreground">Wallet account</dt><dd className="mt-1 break-all font-mono text-xs">{props.owner ?? "Testnet wallet session required"}</dd></div>
          <div className="bg-card p-3"><dt className="label-mono text-muted-foreground">Service scope</dt><dd className="mt-1 font-mono text-xs">{CAPABILITY_SCOPE.service} / {CAPABILITY_SCOPE.operation}</dd></div>
          <div className="bg-card p-3"><dt className="label-mono text-muted-foreground">State</dt><dd className="mt-1 font-mono text-xs uppercase">{state ?? "not prepared"}</dd></div>
          <div className="bg-card p-3"><dt className="label-mono text-muted-foreground">Remaining quota</dt><dd className="mt-1 font-mono text-xs">{grant ? `${props.remainingUses} / ${grant.maxUses}` : "—"}</dd></div>
          <div className="bg-card p-3"><dt className="label-mono text-muted-foreground">Expires</dt><dd className="mt-1 break-all font-mono text-xs">{grant?.expiresAt ?? "—"}</dd></div>
          <div className="bg-card p-3"><dt className="label-mono text-muted-foreground">Capability reference</dt><dd className="mt-1 break-all font-mono text-[10px]">{grant?.capabilityRef ?? "opaque reference not issued"}</dd></div>
        </dl>

        {grant && !props.bound ? <p className="rounded-xl border border-blocked/35 bg-blocked/10 px-4 py-3 text-sm text-blocked" role="alert">The wallet account or network changed. This capability remains locked to {grant.account} on Testnet.</p> : null}
        {preparationUnknown ? <p className="rounded-xl border border-blocked/35 bg-blocked/10 px-4 py-3 text-sm text-blocked" role="alert">Preparation may have committed but returned no capability reference. This account is locked against replacement preparation because Harbor cannot safely look up the missing reference.</p> : null}

        <div className="flex flex-wrap gap-2">
          <button className="min-h-11 rounded-md border border-primary bg-primary px-4 text-xs font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-45" disabled={props.busy || !props.owner || grant !== undefined || props.recoveryPhase !== undefined} onClick={props.onPrepare} type="button">Prepare bounded grant</button>
          {grant || props.hasTrackedReference ? <button className="min-h-11 rounded-md border border-border bg-card px-4 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-45" disabled={props.busy || !props.owner || (grant !== undefined && !props.bound)} onClick={props.onRefresh} type="button">Retry exact status</button> : null}
          {grant && state === "active" ? <button className="min-h-11 rounded-md border border-primary bg-card px-4 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-45" disabled={props.busy || !props.bound || props.invocationRecoveryId !== undefined || props.revocationRecoveryId !== undefined} onClick={props.onInvoke} type="button">Invoke fixed mock service</button> : null}
          {props.invocationRecoveryId && grant ? <button className="min-h-11 rounded-md border border-warning/45 bg-warning/[0.06] px-4 text-xs font-semibold text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-45" disabled={props.busy || !props.bound} onClick={props.onRecoverInvocation} type="button">Recover same invocation</button> : null}
          {props.lastInvocation && grant && state === "active" && !props.invocationRecoveryId ? <button className="min-h-11 rounded-md border border-border bg-card px-4 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-45" disabled={props.busy || !props.bound} onClick={props.onReplayInvocation} type="button">Replay same request id</button> : null}
          {grant && state === "active" && !props.reviewOpen && !props.revocationRecoveryId ? <button className="min-h-11 rounded-md border border-blocked/45 bg-card px-4 text-xs font-semibold text-blocked focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-45" disabled={props.busy || !props.bound || props.invocationRecoveryId !== undefined} onClick={props.onPrepareRevocation} type="button">Prepare revocation</button> : null}
          {grant && state === "active" && props.revocationRecoveryId ? <button className="min-h-11 rounded-md border border-warning/45 bg-warning/[0.06] px-4 text-xs font-semibold text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-45" disabled={props.busy || !props.bound} onClick={props.onRecoverRevocation} type="button">Recover same revocation review</button> : null}
          {grant?.state === "prepared" && !props.reviewOpen ? <button className="min-h-11 rounded-md border border-border bg-card px-4 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" onClick={props.onDiscardPrepared} type="button">Discard inactive draft</button> : null}
          {grant && ["revoked", "expired"].includes(state ?? "") ? <button className="min-h-11 rounded-md border border-border bg-card px-4 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" onClick={props.onClearFinished} type="button">Clear terminal record</button> : null}
        </div>

        {props.notice ? <p className="rounded-xl border border-executed/35 bg-executed/10 px-4 py-3 text-sm text-executed" role="status">{props.notice}</p> : null}
        {props.error ? <p className="rounded-xl border border-blocked/35 bg-blocked/10 px-4 py-3 text-sm text-blocked" role="alert">{props.error}</p> : null}
        {props.lastInvocation ? <section className="rounded-xl border border-border bg-card p-4" aria-label="Last capability invocation"><h2 className="font-serif text-sm font-semibold">Last fixed mock invocation</h2><p className="mt-2 font-mono text-xs">{props.lastInvocation.requestId} · {props.lastInvocation.status} · replayed {String(props.lastInvocation.replayed)}</p><pre className="mt-3 overflow-x-auto rounded-md border border-border bg-background p-3 text-xs text-foreground">{JSON.stringify(props.lastInvocation.data ?? null, null, 2)}</pre></section> : null}
      </div>
    </main>
  );
}
