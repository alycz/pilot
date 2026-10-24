"use client";

import { AlertTriangle, Check, LoaderCircle, ShieldCheck, X } from "lucide-react";
import type { LedgerDeviceState } from "@pilot/wallet";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { DeviceStatus } from "../ledger/device-status";
import { ledgerSignedCopy, type LedgerTransportProvenance } from "../ledger/provenance";

export type ApprovalSummary = {
  action: string;
  amounts: string[];
  destination?: string;
  feeDrops: string;
  network: "testnet" | "devnet" | "lending-devnet";
};

export type ApprovalRequest = {
  approvalId?: string;
  expiresAt?: string;
  txJson: Record<string, unknown>;
  summary: ApprovalSummary;
};

export type SignOnlyWallet = {
  signOnly(txJson: Record<string, unknown>): Promise<string>;
};

export type ApprovalSubmission = {
  hash?: string;
  status: "validated" | "pending";
};

export type LedgerApprovalState = {
  accountIndex: number;
  transport?: LedgerTransportProvenance;
  deviceReady: boolean;
  deviceState: LedgerDeviceState;
  signingMode: "clear" | "blind";
  blindLegend?: ReactNode;
  /** Rebuilds, signs, and submits a fresh tuple. It must never reuse `request`. */
  onRebuildAndApprove?: () => Promise<ApprovalSubmission>;
};

type ApprovalModalProps = {
  open: boolean;
  request: ApprovalRequest;
  wallet: SignOnlyWallet;
  beforeSign?: () => Promise<void>;
  onSignComplete?: () => void;
  onClose: () => void;
  onSubmit: (txBlob: string, approvalId?: string) => Promise<ApprovalSubmission>;
  onComplete?: (submission: ApprovalSubmission) => void;
  ledger?: LedgerApprovalState;
};

type ModalState = "review" | "signing" | "submitting" | "complete" | "error";

export function isApprovalExpired(expiresAt: string | undefined, now = Date.now()) {
  if (expiresAt === undefined) return false;
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

const LEDGER_REBUILD_THRESHOLD_MS = 30_000;

export function ledgerApprovalNeedsRebuild(
  expiresAt: string | undefined,
  now = Date.now(),
): boolean {
  if (expiresAt === undefined) return false;
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry - now < LEDGER_REBUILD_THRESHOLD_MS;
}

export function ledgerApprovalActionLabel(input: {
  expiresAt?: string;
  now?: number;
  ledger: boolean;
}): "Sign only" | "Approve on Ledger" | "Rebuild and approve" {
  if (!input.ledger) return "Sign only";
  return ledgerApprovalNeedsRebuild(input.expiresAt, input.now)
    ? "Rebuild and approve"
    : "Approve on Ledger";
}

export function ledgerApprovalSignerLabel(
  ledger: Pick<LedgerApprovalState, "accountIndex" | "transport">,
): string {
  return `${ledgerSignedCopy(ledger.transport)} · account ${ledger.accountIndex}`;
}

export function canAttemptLedgerApproval(input: {
  busy: boolean;
  deviceReady: boolean;
  needsRebuild: boolean;
  hasRebuildHandler: boolean;
}): boolean {
  return !input.busy && input.deviceReady && (!input.needsRebuild || input.hasRebuildHandler);
}

export function ledgerExpectedScreens(request: ApprovalRequest): readonly string[] {
  const transactionType = request.txJson.TransactionType;
  const screens = [
    ...(typeof transactionType === "string" ? [`Type ${transactionType}`] : []),
    request.summary.action,
    ...request.summary.amounts,
  ];
  if (typeof request.txJson.Flags === "number") {
    screens.push(`Flags ${request.txJson.Flags}`);
  }
  screens.push(`Fee ${request.summary.feeDrops} drops`);
  return screens;
}

export async function signOnlyAfterPreflight(
  request: ApprovalRequest,
  wallet: SignOnlyWallet,
  beforeSign?: () => Promise<void>,
  onSignComplete?: () => void,
): Promise<string> {
  await beforeSign?.();
  if (isApprovalExpired(request.expiresAt)) {
    throw new Error("This approval expired before the wallet opened. Build and review a fresh transaction.");
  }
  const txBlob = await wallet.signOnly(request.txJson);
  try {
    onSignComplete?.();
  } catch {
    // Observability is best-effort and cannot strand an already-created signature.
  }
  return txBlob;
}

export class ApprovalAttemptGate {
  private active = false;

  async run<T>(attempt: () => Promise<T>): Promise<T | undefined> {
    if (this.active) return undefined;
    this.active = true;
    try {
      return await attempt();
    } finally {
      this.active = false;
    }
  }
}

export function ApprovalModal({
  open,
  request,
  wallet,
  beforeSign,
  onSignComplete,
  onClose,
  onSubmit,
  onComplete,
  ledger,
}: ApprovalModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const attemptGateRef = useRef(new ApprovalAttemptGate());
  const [state, setState] = useState<ModalState>("review");
  const [error, setError] = useState<string>();
  const [ledgerSigned, setLedgerSigned] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const expired = isApprovalExpired(request.expiresAt, now);
  const ledgerNeedsRebuild = ledger !== undefined && ledgerApprovalNeedsRebuild(request.expiresAt, now);

  useEffect(() => {
    if (!open) return;
    setState("review");
    setError(undefined);
    setLedgerSigned(false);
    setNow(Date.now());
  }, [open, request]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>("button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")
        ?.focus();
    });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state === "review") onClose();
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open, state]);

  if (!open) return null;

  const approve = async () => {
    await attemptGateRef.current.run(async () => {
      if (isApprovalExpired(request.expiresAt) || state === "signing" || state === "submitting") {
        if (isApprovalExpired(request.expiresAt)) {
          setNow(Date.now());
          setError("This approval expired. Build a fresh transaction before signing.");
        }
        return;
      }
      setError(undefined);
      try {
        setState("signing");
        const txBlob = await signOnlyAfterPreflight(request, wallet, beforeSign, () => {
          if (ledger !== undefined) setLedgerSigned(true);
          onSignComplete?.();
        });
        if (isApprovalExpired(request.expiresAt)) {
          setNow(Date.now());
          setError("This approval expired while the wallet was open. Build a fresh transaction before submitting.");
          setState("error");
          return;
        }
        setState("submitting");
        const submission = await onSubmit(txBlob, request.approvalId);
        setState("complete");
        onComplete?.(submission);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The approval could not be completed.");
        setState("error");
      }
    });
  };

  const rebuildAndApprove = async () => {
    await attemptGateRef.current.run(async () => {
      if (state === "signing" || state === "submitting") return;
      setError(undefined);
      try {
        if (ledger?.onRebuildAndApprove === undefined) {
          throw new Error("A fresh approval could not be built. Return to chat and try again.");
        }
        setState("signing");
        const submission = await ledger.onRebuildAndApprove();
        setLedgerSigned(true);
        setState("complete");
        onComplete?.(submission);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The approval could not be rebuilt.");
        setState("error");
      }
    });
  };

  const busy = state === "signing" || state === "submitting";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-end bg-black/45 p-0 sm:place-items-center sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="max-h-[94dvh] w-full overflow-y-auto border border-border-strong bg-card shadow-2xl shadow-black/[0.14] sm:max-w-lg"
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-5 sm:px-6">
          <div>
            <p className="mb-3 inline-flex items-center gap-1.5 border border-approval/40 bg-approval/10 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-[color-mix(in_srgb,var(--approval)_72%,var(--foreground))]">
              <ShieldCheck className="size-3" aria-hidden="true" /> Owner approval
            </p>
            <h2 className="text-lg font-medium tracking-tight" id={titleId}>
              Review what your wallet will show
            </h2>
          </div>
          <button
            aria-label="Close approval"
            className="grid h-8 w-8 place-items-center border border-border text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-5 sm:px-6">
          <div className="border border-border bg-background/50 p-4">
            <p className="label-mono">Action</p>
            <p className="mt-2 text-base font-medium tracking-tight">{request.summary.action}</p>
          </div>

          <dl className="grid min-w-0 gap-px border border-border bg-border text-sm sm:grid-cols-2">
            <div className="min-w-0 bg-card px-3.5 py-3">
              <dt className="label-mono">Amount</dt>
              <dd className="mt-1 break-words font-mono text-xs text-foreground">
                {request.summary.amounts.length > 0 ? request.summary.amounts.join(" · ") : "No asset movement"}
              </dd>
            </div>
            <div className="min-w-0 bg-card px-3.5 py-3">
              <dt className="label-mono">Destination</dt>
              <dd className="mt-1 break-all font-mono text-xs text-foreground">
                {request.summary.destination ?? "Protocol transaction"}
              </dd>
            </div>
            <div className="bg-card px-3.5 py-3">
              <dt className="label-mono">Maximum fee</dt>
              <dd className="mt-1 font-mono text-xs">{request.summary.feeDrops} drops</dd>
            </div>
            <div className="bg-card px-3.5 py-3">
              <dt className="label-mono">Network</dt>
              <dd className="mt-1 font-mono text-xs uppercase">{request.summary.network.replace("-", " ")}</dd>
            </div>
          </dl>

          <p className="border-l-2 border-approval/60 bg-approval/[0.05] px-4 py-3 text-[13px] leading-6 text-muted-foreground">
            Pilot asks the wallet to sign only. Your wallet does not submit this transaction; Pilot relays the exact signed blob through its authorized server route.
          </p>

          {ledger ? (
            <div className="space-y-3 border border-border bg-background/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="label-mono">Ledger review</p>
                {ledgerSigned ? (
                  <span className="border border-executed/35 bg-executed/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">
                    {ledgerApprovalSignerLabel(ledger)}
                  </span>
                ) : null}
              </div>
              <DeviceStatus state={ledger.deviceState} signed={ledgerSigned} transport={ledger.transport} />
              {ledger.signingMode === "blind" ? (
                ledger.blindLegend ?? (
                  <p className="border border-amber-300 bg-amber-50 p-3 text-xs font-medium text-amber-950">
                    This transaction requires blind signing. Match every field in Pilot&apos;s transaction-specific legend before approving it.
                  </p>
                )
              ) : (
                <div className="border border-slate-300 bg-white p-3 text-slate-900">
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-slate-600">
                    Expected Ledger screens
                  </p>
                  <ul className="mt-2 space-y-1 text-xs">
                    {ledgerExpectedScreens(request).map((screen) => (
                      <li key={screen} className="font-mono">{screen}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : null}

          {expired && ledger === undefined ? (
            <p className="flex gap-2 border border-blocked/35 bg-blocked/10 px-4 py-3 text-sm text-blocked">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> This approval expired. Return to chat and build a fresh transaction.
            </p>
          ) : null}

          {error ? (
            <p className="flex gap-2 border border-blocked/35 bg-blocked/10 px-4 py-3 text-sm text-blocked" role="alert">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {error}
            </p>
          ) : null}

          {state === "complete" ? (
            <p className="flex gap-2 border border-executed/35 bg-executed/10 px-4 py-3 text-sm text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" role="status">
              <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> Signed by the owner and accepted for submission.
            </p>
          ) : null}
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-border bg-white/[0.015] px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <button
            className="bracket bracket-light h-10 border border-border bg-white/[0.03] px-4 font-mono text-[11px] uppercase tracking-wide transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
            disabled={busy}
            onClick={state === "complete" ? onClose : () => {
              setState("review");
              setError(undefined);
              onClose();
            }}
            type="button"
          >
            {state === "complete" ? "Done" : "Cancel"}
          </button>
          {state !== "complete" ? (
            <button
              className="inline-flex h-10 items-center justify-center gap-2 bg-approval px-4 font-mono text-[11px] font-semibold uppercase tracking-wide text-approval-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
              disabled={ledger !== undefined
                ? !canAttemptLedgerApproval({
                    busy,
                    deviceReady: ledger.deviceReady,
                    needsRebuild: ledgerNeedsRebuild,
                    hasRebuildHandler: ledger.onRebuildAndApprove !== undefined,
                  })
                : busy || expired}
              onClick={ledgerNeedsRebuild ? rebuildAndApprove : approve}
              type="button"
            >
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
              {state === "signing"
                ? ledgerNeedsRebuild ? "Rebuilding approval" : "Waiting for wallet"
                : state === "submitting"
                  ? "Submitting"
                  : state === "error"
                    ? ledgerApprovalActionLabel({ expiresAt: request.expiresAt, now, ledger: ledger !== undefined })
                    : ledgerApprovalActionLabel({ expiresAt: request.expiresAt, now, ledger: ledger !== undefined })}
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
