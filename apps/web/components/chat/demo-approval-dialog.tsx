"use client";

import type { CardEvent } from "@pilot/contracts";
import { Check, LoaderCircle, ShieldCheck, X } from "lucide-react";
import React, { useEffect, useId, useRef, useState } from "react";

import { shorten } from "../cards/card-frame";
import { SimulatedDevice } from "../ledger/simulated-device";
import offerCreateTranscript from "../ledger/transcripts/offer-create.json";

import { DEMO_SIGNING_MS } from "./demo-script";

type Step = "review" | "signing" | "submitting" | "complete";

const RECORDED_OFFER = Object.freeze({
  TransactionType: "OfferCreate",
  Account: "ra7Zr8ddy9tB88RaXL8B87YkqhEJG2vkAJ",
  Flags: 0x0004_0000,
  TakerPays: Object.freeze({
    currency: "RLUSD",
    issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
    value: "100",
  }),
  TakerGets: "75000000",
  Fee: "12",
});

export function matchesRecordedOfferCreate(txJson: unknown): boolean {
  if (typeof txJson !== "object" || txJson === null || Array.isArray(txJson)) return false;
  const candidate = txJson as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 6 ||
    candidate.TransactionType !== RECORDED_OFFER.TransactionType ||
    candidate.Account !== RECORDED_OFFER.Account ||
    candidate.Flags !== RECORDED_OFFER.Flags ||
    candidate.TakerGets !== RECORDED_OFFER.TakerGets ||
    candidate.Fee !== RECORDED_OFFER.Fee
  ) return false;
  const pays = candidate.TakerPays;
  return typeof pays === "object" && pays !== null && !Array.isArray(pays) &&
    Object.keys(pays).length === 3 &&
    (pays as Record<string, unknown>).currency === RECORDED_OFFER.TakerPays.currency &&
    (pays as Record<string, unknown>).issuer === RECORDED_OFFER.TakerPays.issuer &&
    (pays as Record<string, unknown>).value === RECORDED_OFFER.TakerPays.value;
}

const STEP_COPY: { key: Exclude<Step, "review">; label: string }[] = [
  { key: "signing", label: "Signing in wallet (simulated)" },
  { key: "submitting", label: "Submitting through Harbor (simulated)" },
  { key: "complete", label: "Validated on the ledger (simulated)" },
];

/**
 * Demo-only approval: mirrors the real owner-approval modal but never opens a
 * wallet, builds a blob or calls Harbor. Each step is a local timer.
 */
export function DemoApprovalDialog({
  event,
  reducedMotion,
  onClose,
  onSubmitted,
  onValidated,
}: {
  event: CardEvent;
  reducedMotion: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  onValidated: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const timersRef = useRef<number[]>([]);
  const [step, setStep] = useState<Step>("review");
  const busy = step === "signing" || step === "submitting";

  const summary = event.build?.summary;
  const txJson = event.exec?.status === "needs_approval" ? event.exec.tx_json : event.build?.tx_json;
  const supportsRecordedTranscript = matchesRecordedOfferCreate(txJson);
  const destination =
    typeof txJson?.VaultID === "string"
      ? `Vault ${shorten(txJson.VaultID, 6, 6)}`
      : event.intent.kind === "swap" || event.intent.kind === "limit"
        ? "XRPL DEX"
        : "XRPL protocol";

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timers = timersRef.current;
    return () => {
      window.cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape" && !busy) onClose();
      if (keyEvent.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])") ?? [],
      );
      if (focusable.length === 0) {
        keyEvent.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (keyEvent.shiftKey && document.activeElement === first) {
        keyEvent.preventDefault();
        last.focus();
      } else if (!keyEvent.shiftKey && document.activeElement === last) {
        keyEvent.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const sign = () => {
    if (step !== "review") return;
    const signing = reducedMotion ? 150 : DEMO_SIGNING_MS.signing;
    const submitting = reducedMotion ? 150 : DEMO_SIGNING_MS.submitting;
    setStep("signing");
    timersRef.current.push(
      window.setTimeout(() => {
        setStep("submitting");
        onSubmitted();
      }, signing),
      window.setTimeout(() => {
        setStep("complete");
        onValidated();
        window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("[data-done]")?.focus());
      }, signing + submitting),
    );
  };

  const stepIndex = step === "review" ? -1 : STEP_COPY.findIndex((entry) => entry.key === step);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-end bg-black/45 p-0 sm:place-items-center sm:p-6"
      role="presentation"
      onMouseDown={(mouseEvent) => {
        if (mouseEvent.currentTarget === mouseEvent.target && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-xl border border-border-strong bg-card shadow-2xl shadow-black/[0.14] sm:max-w-lg"
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-5 sm:px-6 [@media(max-height:520px)]:py-3">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <p className="inline-flex items-center gap-1.5 border border-approval/40 bg-approval/[0.07] px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground">
                <ShieldCheck className="size-3 text-approval" aria-hidden="true" /> Owner approval
              </p>
            </div>
            <h2 className="text-lg font-medium tracking-tight" id={titleId}>
              Review what your wallet would show
            </h2>
          </div>
          <button
            aria-label="Close approval"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:w-11"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-6 [@media(max-height:520px)]:py-3" tabIndex={0} role="region" aria-label="Transaction details">
          <div className="rounded-xl border border-border bg-background/50 p-4">
            <p className="label-mono">Action</p>
            <p className="mt-2 text-base font-medium tracking-tight">{summary?.action ?? "XRPL transaction"}</p>
          </div>

          <dl className="grid min-w-0 gap-px overflow-hidden rounded-xl border border-border bg-border text-sm sm:grid-cols-2">
            <div className="min-w-0 bg-card px-3.5 py-3">
              <dt className="label-mono">Amount</dt>
              <dd className="mt-1 break-words font-mono text-xs text-foreground">{summary?.amounts.join(" · ") ?? "—"}</dd>
            </div>
            <div className="min-w-0 bg-card px-3.5 py-3">
              <dt className="label-mono">Destination</dt>
              <dd className="mt-1 break-all font-mono text-xs text-foreground">{destination}</dd>
            </div>
            <div className="bg-card px-3.5 py-3">
              <dt className="label-mono">Maximum fee</dt>
              <dd className="mt-1 font-mono text-xs">{summary?.fee_drops ?? "12"} drops</dd>
            </div>
            <div className="bg-card px-3.5 py-3">
              <dt className="label-mono">Network</dt>
              <dd className="mt-1 font-mono text-xs uppercase">{event.intent.network.replace("-", " ")}</dd>
            </div>
          </dl>

          {step === "review" ? (
            <div className="space-y-3" data-autofocus tabIndex={-1}>
              <p className="border-l-2 border-primary/60 bg-primary/[0.05] px-4 py-3 text-[13px] leading-6 text-muted-foreground">
                This is a demo. No wallet opens and nothing reaches the ledger. With an account, your own wallet signs this exact transaction and Pilot sends the signed blob to Harbor&apos;s REST API, which checks it against this approval before submitting it to the XRP Ledger.
              </p>
              {supportsRecordedTranscript ? (
                <>
                  <p className="text-xs leading-5 text-muted-foreground">
                    Use the recorded device controls to review every screen, then confirm on the final screen.
                  </p>
                  <SimulatedDevice transcript={offerCreateTranscript} onConfirm={sign} />
                </>
              ) : (
                <p className="border border-blocked/35 bg-blocked/10 px-4 py-3 text-sm text-blocked" role="status">
                  A recorded device replay is not available for this transaction type. Nothing can be confirmed or submitted in this demo.
                </p>
              )}
            </div>
          ) : (
            <ol className="border border-border" aria-label="Simulated approval progress">
              {STEP_COPY.map((entry, index) => {
                const done = index < stepIndex || step === "complete";
                const active = index === stepIndex && step !== "complete";
                return (
                  <li key={entry.key} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                    <span className={`grid h-5 w-5 shrink-0 place-items-center border ${done ? "border-executed/40 bg-executed/10 text-executed" : active ? "border-primary/40 text-primary" : "border-border text-muted-foreground"}`} aria-hidden="true">
                      {done ? <Check className="size-3" /> : active ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" /> : null}
                    </span>
                    <span className={`font-mono text-[11px] uppercase tracking-wide ${done || active ? "text-foreground" : "text-muted-foreground"}`}>
                      {entry.label}
                      <span className="sr-only">{done ? " — done" : active ? " — in progress" : " — pending"}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          {step === "complete" ? (
            <p className="flex gap-2 border border-executed/35 bg-executed/10 px-4 py-3 text-sm text-executed" role="status">
              <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> Simulated signature accepted. No real transaction was made.
            </p>
          ) : null}
        </div>

        <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-border bg-white/[0.015] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 [@media(max-height:520px)]:flex-row [@media(max-height:520px)]:items-center [@media(max-height:520px)]:justify-between [@media(max-height:520px)]:py-2.5">
          <a className="link-dashed text-center font-mono text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground sm:max-w-[10rem] sm:text-left" href="/onboarding">
            Create account to sign for real
          </a>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <button
              className="bracket bracket-light h-10 pointer-coarse:h-11 border border-border bg-white/[0.03] px-4 font-mono text-[11px] uppercase tracking-wide transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
              data-done={step === "complete" ? "" : undefined}
              data-autofocus={step === "review" ? undefined : ""}
              disabled={busy}
              onClick={onClose}
              type="button"
            >
              {step === "complete" ? "Done" : "Cancel"}
            </button>
            {step !== "complete" && step !== "review" ? (
              <button
                className="inline-flex h-10 pointer-coarse:h-11 items-center justify-center gap-2 whitespace-nowrap bg-approval px-4 font-mono text-[11px] font-semibold uppercase tracking-wide text-approval-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={busy}
                onClick={sign}
                type="button"
              >
                {busy ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ShieldCheck className="size-4" aria-hidden="true" />}
                {step === "signing" ? "Signing (simulated)" : step === "submitting" ? "Submitting (simulated)" : "Sign (simulated)"}
              </button>
            ) : null}
          </div>
        </footer>
      </section>
    </div>
  );
}
