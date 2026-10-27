"use client";

import { Ban, FileKey2, ShieldCheck, WalletCards } from "lucide-react";
import React, { useState } from "react";

import type { NearNativeOwnerApprovalReview } from "../../lib/near-native-owner-approval";
import type { NearConnectAdapterStatus } from "../../lib/near-connect-adapter";
import { DetailGrid } from "../cards/card-frame";

export function NearNativeOwnerApprovalWorkspace({
  review,
  adapterStatus,
  onRequestWalletControl,
  onConfirmEconomicApproval,
}: Readonly<{
  review: NearNativeOwnerApprovalReview;
  adapterStatus: NearConnectAdapterStatus;
  onRequestWalletControl?: () => void;
  onConfirmEconomicApproval?: () => void;
}>) {
  const [cancelled, setCancelled] = useState(false);
  const walletControlEnabled = !cancelled
    && adapterStatus.canPrompt
    && review.canRequestWalletControl
    && Boolean(onRequestWalletControl);
  const economicApprovalEnabled = !cancelled
    && adapterStatus.canPrompt
    && review.canConfirmEconomicApproval
    && Boolean(onConfirmEconomicApproval);

  return (
    <section aria-labelledby="near-native-owner-approval-title" className="min-w-0 overflow-hidden border border-border bg-card rounded-xl">
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center border border-approval/35 bg-approval/[0.06] text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] rounded-md">
            <WalletCards className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="label-mono">Owner-controlled route · default off</p>
            <h2 id="near-native-owner-approval-title" className="mt-1 text-sm font-medium tracking-tight">Native NEAR → canonical Arbitrum USDC</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              Review the source-account proof and the separate quote-bound economic approval before any manual native-NEAR transfer. This local demo does not request a quote or open a wallet.
            </p>
          </div>
        </div>
      </header>

      <div className="space-y-4 p-4 sm:p-5">
        <p role="status" className={`border px-3 py-2 text-xs leading-5 rounded-xl ${adapterStatus.state === "disabled" ? "border-border bg-white/[0.015] text-muted-foreground" : "border-destructive/30 bg-destructive/[0.06] text-muted-foreground"}`}>
          <strong className="text-foreground">Browser wallet adapter: {adapterStatus.state}.</strong> {adapterStatus.notice}
        </p>

        <p role="note" className="border border-approval/30 bg-approval/[0.06] px-3 py-2 text-xs leading-5 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] rounded-xl">
          Fixture provenance: the exact digest and bindings below use deterministic local data. No provider signature, NEP-413 wallet proof, owner confirmation, reservation, or transfer occurred on this page.
        </p>

        <article className="min-w-0 overflow-hidden border border-border bg-card rounded-xl">
          <div className="flex min-w-0 items-start gap-3 p-4">
            <span className="grid size-8 shrink-0 place-items-center border border-info/30 text-[color-mix(in_oklab,var(--info)_80%,var(--foreground))] rounded-md">
              <ShieldCheck className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="label-mono">Step 01 · source-account control</p>
              <h3 className="mt-1 text-sm font-medium tracking-tight">Fresh NEP-413 proof</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">The nonce, recipient, expiry, principal, account, and network are one proof scope. This signature proves source-account control only; it does not approve or transfer NEAR.</p>
            </div>
          </div>
          <div className="border-t border-border px-4 py-3.5">
            <DetailGrid items={review.approvalRows.slice(0, 6)} />
            <button type="button" disabled={!walletControlEnabled} onClick={onRequestWalletControl} className="mt-3 inline-flex h-9 items-center gap-1.5 border border-primary bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md">
              <FileKey2 className="size-3.5" aria-hidden="true" />
              Prove source-account control
            </button>
          </div>
        </article>

        <article className="min-w-0 overflow-hidden border border-approval/35 bg-card rounded-xl">
          <div className="flex min-w-0 items-start gap-3 p-4">
            <span className="grid size-8 shrink-0 place-items-center border border-approval/35 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] rounded-md">
              <FileKey2 className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="label-mono">Step 02 · distinct economic approval</p>
              <h3 className="mt-1 text-sm font-medium tracking-tight">Confirm the exact quote-bound digest</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">A fresh wallet-control proof is necessary but insufficient. Owner confirmation must separately bind every economic field and expire before the provider refund-start deadline.</p>
            </div>
          </div>
          <div className="border-t border-border px-4 py-3.5">
            <DetailGrid items={review.approvalRows.slice(6)} />
            <p className="mt-3 break-all border border-approval/30 bg-approval/[0.06] px-3 py-2 font-mono text-[11px] leading-4 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] rounded-xl">
              {review.envelope?.approval_digest ?? "No valid approval digest"}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={!economicApprovalEnabled} onClick={onConfirmEconomicApproval} className="inline-flex h-9 items-center gap-1.5 border border-primary bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md">
                Confirm exact economic approval
              </button>
              <button type="button" disabled={cancelled} onClick={() => setCancelled(true)} className="inline-flex h-9 items-center gap-1.5 border border-border-strong px-3.5 text-[13px] font-semibold text-foreground transition hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md">
                <Ban className="size-3.5" aria-hidden="true" />
                {cancelled ? "Review cancelled" : "Cancel local review"}
              </button>
            </div>
            {cancelled ? <p role="status" className="mt-3 text-xs leading-5 text-muted-foreground">This local review was cancelled. No wallet prompt, approval, reservation, or transfer was created.</p> : null}
          </div>
        </article>

        <article className="min-w-0 overflow-hidden border border-border bg-card rounded-xl">
          <div className="flex min-w-0 items-start gap-3 p-4">
            <span className="grid size-8 shrink-0 place-items-center border border-border text-muted-foreground rounded-md">
              <WalletCards className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="label-mono">Step 03 · manual owner funding</p>
              <h3 className="mt-1 text-sm font-medium tracking-tight">Native NEAR transfer instructions</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Only after separate acceptance gates pass, the owner wallet—not Pilot—would manually send native NEAR to the exact provider deposit account.</p>
            </div>
          </div>
          <div className="border-t border-border px-4 py-3.5">
            <DetailGrid items={[...review.fundingRows]} />
            <ol className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
              <Instruction number="1">Confirm NEAR mainnet and the exact owner account bound above.</Instruction>
              <Instruction number="2">Transfer native NEAR—not a wNEAR token—using the exact yoctoNEAR amount and deposit account.</Instruction>
              <Instruction number="3">Do not add a memo. This provisional route accepts SIMPLE deposits only.</Instruction>
              <Instruction number="4">Treat provider status and independent Arbitrum delivery evidence as separate checks.</Instruction>
            </ol>
            <p role="note" className="mt-3 border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs leading-5 text-muted-foreground rounded-xl">
              Funding remains blocked until independent source and destination receipt verification is accepted. The signed NEP-413 message does not transfer funds, and Pilot budgets cannot stop an owner from sending outside the app.
            </p>
            <button type="button" disabled aria-disabled="true" className="mt-3 inline-flex h-9 items-center border border-border-strong px-3.5 text-[13px] font-semibold text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md">
              Manual native-NEAR funding blocked
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}

function Instruction({ number, children }: Readonly<{ number: string; children: React.ReactNode }>) {
  return (
    <li className="flex min-w-0 items-start gap-2">
      <span className="grid size-5 shrink-0 place-items-center border border-border font-mono text-[10px] text-foreground rounded-full">{number}</span>
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

