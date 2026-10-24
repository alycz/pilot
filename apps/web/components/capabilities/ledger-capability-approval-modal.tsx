"use client";

import type { LedgerDeviceState, PilotWallet } from "@pilot/wallet";
import { LoaderCircle, ShieldCheck, X } from "lucide-react";
import React from "react";
import { useEffect, useRef, useState } from "react";

import { DeviceStatus } from "../ledger/device-status";
import type {
  CapabilityOwnerProof,
  CapabilityOwnerReview,
} from "./ledger-capability-client";
import type { BoundCapabilityOwnerReview } from "./ledger-capability-review";

export function isCapabilityReviewExpired(review: CapabilityOwnerReview, now = Date.now()): boolean {
  const expiry = Date.parse(review.expires_at);
  return !Number.isFinite(expiry) || expiry <= now;
}

export type CapabilityProofSubmit = (
  proof: CapabilityOwnerProof,
  review: CapabilityOwnerReview,
) => Promise<void>;

export class CapabilityProofAttempt {
  #signedBlob?: string;

  get hasSignedBlob(): boolean {
    return this.#signedBlob !== undefined;
  }

  async run(input: Readonly<{
    review: CapabilityOwnerReview;
    wallet: Pick<PilotWallet, "signOnly">;
    beforeSign?(): Promise<void>;
    submit: CapabilityProofSubmit;
  }>): Promise<void> {
    await input.beforeSign?.();
    if (isCapabilityReviewExpired(input.review)) {
      throw new Error("This capability proof expired before signing. Prepare a fresh review.");
    }
    this.#signedBlob ??= await input.wallet.signOnly(input.review.tx_json);
    if (isCapabilityReviewExpired(input.review)) {
      throw new Error("This capability proof expired before submission. Prepare a fresh review.");
    }
    await input.submit({
      nonce: input.review.nonce,
      approved_at: input.review.approved_at,
      expires_at: input.review.expires_at,
      tx_blob: this.#signedBlob,
    }, input.review);
  }
}

/**
 * A non-broadcast AccountSet proof review. A retry reuses the same in-memory
 * signed blob and never opens a second device prompt after an uncertain submit.
 */
export function LedgerCapabilityApprovalModal(props: Readonly<{
  open: boolean;
  bound: BoundCapabilityOwnerReview;
  wallet: Pick<PilotWallet, "signOnly">;
  accountIndex: number;
  deviceReady: boolean;
  deviceState: LedgerDeviceState;
  beforeSign?(): Promise<void>;
  onClose(rejected: boolean): void;
  onSubmit: CapabilityProofSubmit;
}>) {
  const [state, setState] = useState<"review" | "signing" | "submitting" | "complete" | "error">("review");
  const [error, setError] = useState<string>();
  const [signedBlob, setSignedBlob] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const activeRef = useRef(false);
  const attemptRef = useRef(new CapabilityProofAttempt());

  useEffect(() => {
    if (!props.open) return;
    setState("review");
    setError(undefined);
    setSignedBlob(undefined);
    attemptRef.current = new CapabilityProofAttempt();
    setNow(Date.now());
  }, [props.open, props.bound]);

  useEffect(() => {
    if (!props.open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [props.open]);

  if (!props.open) return null;
  const { grant, review } = props.bound;
  const expired = isCapabilityReviewExpired(review, now);
  const busy = state === "signing" || state === "submitting";
  const verb = review.action === "activate" ? "Activate capability" : "Revoke capability";

  const submit = async () => {
    if (activeRef.current || expired) return;
    activeRef.current = true;
    setError(undefined);
    try {
      setState(attemptRef.current.hasSignedBlob ? "submitting" : "signing");
      await attemptRef.current.run({
        review,
        wallet: props.wallet,
        beforeSign: props.beforeSign,
        submit: async (proof, review) => {
          setSignedBlob(proof.tx_blob);
          setState("submitting");
          await props.onSubmit(proof, review);
        },
      });
      setState("complete");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The capability proof could not be completed.");
      setState("error");
    } finally {
      activeRef.current = false;
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/45 sm:place-items-center sm:p-6" role="presentation">
      <section aria-modal="true" className="max-h-[94dvh] w-full overflow-y-auto border border-border-strong bg-card sm:max-w-lg" role="dialog">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-5">
          <div>
            <p className="label-mono text-approval">Ledger capability proof</p>
            <h2 className="mt-2 text-lg font-medium">{verb}</h2>
          </div>
          <button aria-label="Reject capability review" disabled={busy} onClick={() => props.onClose(state !== "complete")} type="button">
            <X className="size-4" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-5">
          <dl className="grid gap-px border border-border bg-border text-sm sm:grid-cols-2">
            <div className="bg-card p-3"><dt className="label-mono">Service / operation</dt><dd className="mt-1 font-mono text-xs">mock.catalog / read</dd></div>
            <div className="bg-card p-3"><dt className="label-mono">Exact amount</dt><dd className="mt-1 font-mono text-xs">1 request</dd></div>
            <div className="bg-card p-3"><dt className="label-mono">Destination</dt><dd className="mt-1 font-mono text-xs">local-fixture-catalog</dd></div>
            <div className="bg-card p-3"><dt className="label-mono">Network</dt><dd className="mt-1 font-mono text-xs">TESTNET</dd></div>
            <div className="bg-card p-3"><dt className="label-mono">Maximum uses</dt><dd className="mt-1 font-mono text-xs">{grant.maxUses}</dd></div>
            <div className="bg-card p-3"><dt className="label-mono">Rate limit</dt><dd className="mt-1 font-mono text-xs">{grant.rateLimit.maxCalls} / {grant.rateLimit.windowSeconds}s</dd></div>
            <div className="bg-card p-3"><dt className="label-mono">Not before</dt><dd className="mt-1 break-all font-mono text-[10px]">{grant.notBefore}</dd></div>
            <div className="bg-card p-3"><dt className="label-mono">Grant expires</dt><dd className="mt-1 break-all font-mono text-[10px]">{grant.expiresAt}</dd></div>
            <div className="bg-card p-3"><dt className="label-mono">Generation</dt><dd className="mt-1 font-mono text-xs">{review.generation}</dd></div>
            <div className="bg-card p-3"><dt className="label-mono">Review expires</dt><dd className="mt-1 break-all font-mono text-[10px]">{review.expires_at}</dd></div>
          </dl>

          <dl className="space-y-2 border border-slate-300 bg-white p-3 text-slate-900">
            <div><dt className="label-mono">Capability reference</dt><dd className="mt-1 break-all font-mono text-[10px]">{review.capability_ref}</dd></div>
            <div><dt className="label-mono">Approval digest</dt><dd className="mt-1 break-all font-mono text-[10px]">{review.approval_digest}</dd></div>
            <div><dt className="label-mono">Nonce</dt><dd className="mt-1 break-all font-mono text-[10px]">{review.nonce}</dd></div>
          </dl>

          <p className="border border-amber-500/40 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
            Ledger signs a zero-fee, sequence-zero AccountSet proof containing the exact scope digest. It is never broadcast. The signature proves control of the account key only; it does not prove a physical Ledger, and Speculos remains simulation. If the device requests blind signing, reject it—there is no fallback.
          </p>

          <DeviceStatus state={props.deviceState} signed={state === "complete" || signedBlob !== undefined} />
          <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Ledger account {props.accountIndex} · clear-sign AccountSet expected</p>

          {expired ? <p className="border border-blocked/35 bg-blocked/10 p-3 text-sm text-blocked" role="alert">This proof expired. Close it and prepare a fresh review.</p> : null}
          {error ? <p className="border border-blocked/35 bg-blocked/10 p-3 text-sm text-blocked" role="alert">{error}</p> : null}
          {state === "complete" ? <p className="border border-executed/35 bg-executed/10 p-3 text-sm" role="status">Owner-key proof verified. No transaction was broadcast.</p> : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <button className="border border-border px-4 py-2 text-xs" disabled={busy} onClick={() => props.onClose(state !== "complete")} type="button">
            {state === "complete" ? "Done" : "Reject"}
          </button>
          {state !== "complete" ? (
            <button className="inline-flex items-center gap-2 bg-approval px-4 py-2 text-xs font-semibold text-approval-foreground disabled:opacity-45" disabled={busy || expired || !props.deviceReady} onClick={() => void submit()} type="button">
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
              {state === "error" && signedBlob ? "Retry exact proof" : verb}
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
