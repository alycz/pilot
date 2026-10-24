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
    <main className="min-h-[800px] bg-[#f3f1ea] px-4 py-8 text-[#171814]">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <header className="border-b border-slate-400 pb-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#235a52]">Ledger capability broker</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">Grant a scope, never an API key.</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">Prepare, owner-sign, invoke, replay safely, and revoke one fixed local mock capability. The agent sees only an opaque reference.</p>
        </header>

        <p className="border border-amber-700/40 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-950" role="note">
          Default off · local Testnet mock only · no production credential is created · a valid signature proves account-key control, not a physical Ledger.
        </p>

        <dl className="grid gap-px border border-slate-300 bg-slate-300 text-sm sm:grid-cols-3">
          <div className="bg-white p-3"><dt className="text-xs font-semibold text-slate-600">Wallet account</dt><dd className="mt-1 break-all font-mono text-xs">{props.owner ?? "Testnet wallet session required"}</dd></div>
          <div className="bg-white p-3"><dt className="text-xs font-semibold text-slate-600">Service scope</dt><dd className="mt-1 font-mono text-xs">{CAPABILITY_SCOPE.service} / {CAPABILITY_SCOPE.operation}</dd></div>
          <div className="bg-white p-3"><dt className="text-xs font-semibold text-slate-600">State</dt><dd className="mt-1 font-mono text-xs uppercase">{state ?? "not prepared"}</dd></div>
          <div className="bg-white p-3"><dt className="text-xs font-semibold text-slate-600">Remaining quota</dt><dd className="mt-1 font-mono text-xs">{grant ? `${props.remainingUses} / ${grant.maxUses}` : "—"}</dd></div>
          <div className="bg-white p-3"><dt className="text-xs font-semibold text-slate-600">Expires</dt><dd className="mt-1 break-all font-mono text-xs">{grant?.expiresAt ?? "—"}</dd></div>
          <div className="bg-white p-3"><dt className="text-xs font-semibold text-slate-600">Capability reference</dt><dd className="mt-1 break-all font-mono text-[10px]">{grant?.capabilityRef ?? "opaque reference not issued"}</dd></div>
        </dl>

        {grant && !props.bound ? <p className="border border-red-700/30 bg-red-50 px-4 py-3 text-sm text-red-950" role="alert">The wallet account or network changed. This capability remains locked to {grant.account} on Testnet.</p> : null}
        {preparationUnknown ? <p className="border border-red-700/30 bg-red-50 px-4 py-3 text-sm text-red-950" role="alert">Preparation may have committed but returned no capability reference. This account is locked against replacement preparation because Harbor cannot safely look up the missing reference.</p> : null}

        <div className="flex flex-wrap gap-2">
          <button className="border border-[#235a52] bg-[#235a52] px-4 py-2 text-xs font-semibold text-white disabled:opacity-45" disabled={props.busy || !props.owner || grant !== undefined || props.recoveryPhase !== undefined} onClick={props.onPrepare} type="button">Prepare bounded grant</button>
          {grant || props.hasTrackedReference ? <button className="border border-slate-500 bg-white px-4 py-2 text-xs font-semibold disabled:opacity-45" disabled={props.busy || !props.owner || (grant !== undefined && !props.bound)} onClick={props.onRefresh} type="button">Retry exact status</button> : null}
          {grant && state === "active" ? <button className="border border-[#235a52] bg-white px-4 py-2 text-xs font-semibold disabled:opacity-45" disabled={props.busy || !props.bound || props.invocationRecoveryId !== undefined || props.revocationRecoveryId !== undefined} onClick={props.onInvoke} type="button">Invoke fixed mock service</button> : null}
          {props.invocationRecoveryId && grant ? <button className="border border-amber-700 bg-amber-50 px-4 py-2 text-xs font-semibold disabled:opacity-45" disabled={props.busy || !props.bound} onClick={props.onRecoverInvocation} type="button">Recover same invocation</button> : null}
          {props.lastInvocation && grant && state === "active" && !props.invocationRecoveryId ? <button className="border border-slate-500 bg-white px-4 py-2 text-xs font-semibold disabled:opacity-45" disabled={props.busy || !props.bound} onClick={props.onReplayInvocation} type="button">Replay same request id</button> : null}
          {grant && state === "active" && !props.reviewOpen && !props.revocationRecoveryId ? <button className="border border-red-700 bg-white px-4 py-2 text-xs font-semibold text-red-800 disabled:opacity-45" disabled={props.busy || !props.bound || props.invocationRecoveryId !== undefined} onClick={props.onPrepareRevocation} type="button">Prepare revocation</button> : null}
          {grant && state === "active" && props.revocationRecoveryId ? <button className="border border-amber-700 bg-amber-50 px-4 py-2 text-xs font-semibold disabled:opacity-45" disabled={props.busy || !props.bound} onClick={props.onRecoverRevocation} type="button">Recover same revocation review</button> : null}
          {grant?.state === "prepared" && !props.reviewOpen ? <button className="border border-slate-500 bg-white px-4 py-2 text-xs font-semibold" onClick={props.onDiscardPrepared} type="button">Discard inactive draft</button> : null}
          {grant && ["revoked", "expired"].includes(state ?? "") ? <button className="border border-slate-500 bg-white px-4 py-2 text-xs font-semibold" onClick={props.onClearFinished} type="button">Clear terminal record</button> : null}
        </div>

        {props.notice ? <p className="border border-emerald-700/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-950" role="status">{props.notice}</p> : null}
        {props.error ? <p className="border border-red-700/30 bg-red-50 px-4 py-3 text-sm text-red-950" role="alert">{props.error}</p> : null}
        {props.lastInvocation ? <section className="border border-slate-300 bg-white p-4" aria-label="Last capability invocation"><h2 className="text-sm font-semibold">Last fixed mock invocation</h2><p className="mt-2 font-mono text-xs">{props.lastInvocation.requestId} · {props.lastInvocation.status} · replayed {String(props.lastInvocation.replayed)}</p><pre className="mt-3 overflow-x-auto bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(props.lastInvocation.data ?? null, null, 2)}</pre></section> : null}
      </div>
    </main>
  );
}
