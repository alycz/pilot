"use client";

import type { HarborClient } from "@pilot/harbor-client";
import { BadgeCheck, LoaderCircle, RefreshCw, ShieldAlert } from "lucide-react";
import React, { useState } from "react";

import {
  loadLiveNearOwnerFundedReview,
  loadLiveNearOwnerFundedStatus,
  type LiveNearOwnerFundedReview,
  type LiveNearOwnerFundedStatus,
} from "../../lib/near-owner-funded-preview";

import { DetailGrid } from "../cards/card-frame";

const ARBITRUM_USDC_CONTRACT = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const FIXED_ROUTE = "arbitrum-usdc-to-near-wnear-v1" as const;

export function NearOwnerFundedLiveReview({
  client,
  enabled,
}: Readonly<{
  client: Pick<HarborClient, "op">;
  enabled: boolean;
}>) {
  const [amountAtomic, setAmountAtomic] = useState("25000000");
  const [recipient, setRecipient] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [busy, setBusy] = useState<"review" | "status">();
  const [review, setReview] = useState<LiveNearOwnerFundedReview>();
  const [status, setStatus] = useState<LiveNearOwnerFundedStatus>();
  const [error, setError] = useState<string>();

  const validInput =
    /^[1-9]\d*$/.test(amountAtomic) &&
    /^[a-z0-9._-]{2,64}$/.test(recipient.trim()) &&
    /^0x[0-9a-fA-F]{40}$/.test(refundTo.trim());

  const requestReview = async () => {
    if (!enabled || !validInput) return;
    setBusy("review");
    setError(undefined);
    setReview(undefined);
    setStatus(undefined);
    try {
      const result = await loadLiveNearOwnerFundedReview(client, {
        route: FIXED_ROUTE,
        amount_atomic: amountAtomic,
        slippage_bps: 100,
        recipient: recipient.trim(),
        refund_to: refundTo.trim(),
        refund_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        quote_waiting_time_ms: 0,
      });
      setReview(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The executable review is unavailable.");
    } finally {
      setBusy(undefined);
    }
  };

  const refreshStatus = async () => {
    if (!enabled || !review) return;
    setBusy("status");
    setError(undefined);
    setStatus(undefined);
    try {
      setStatus(await loadLiveNearOwnerFundedStatus(client, review));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The bound provider status is unavailable.");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="border-t border-border pt-5" data-near-live-executable-review={enabled ? "enabled" : "disabled"}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center border border-approval/35 bg-approval/[0.06] text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] rounded-md">
          <ShieldAlert className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="label-mono">Live executable review · manual owner funding only</p>
          <h3 className="mt-1 text-sm font-medium tracking-tight">Arbitrum USDC → wNEAR on NEAR</h3>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            This fixed route can request a provider-verified review through Harbor. Pilot never builds, signs, broadcasts, or funds the owner transfer.
          </p>
        </div>
      </div>

      {!enabled ? (
        <div className="mt-4 border border-border bg-white/[0.015] px-3 py-3 rounded-xl">
          <p className="text-xs font-medium text-foreground">Executable review disabled</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            The public UI capability is off. No executable quote or status request can be made from this panel.
          </p>
          <button type="button" disabled aria-disabled="true" className="mt-3 inline-flex h-9 items-center border border-border-strong px-3.5 text-[13px] font-semibold text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md">
            Request executable review
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <p role="note" className="border border-approval/30 bg-approval/[0.06] px-3 py-2 text-xs leading-5 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] rounded-xl">
            UI preview enabled. Harbor still enforces its independent local provider and executable-review flags and fails closed when they are unavailable.
          </p>

          <DetailGrid items={[
            { label: "Origin network", value: "Arbitrum One · chain 42161" },
            { label: "Origin token contract", value: ARBITRUM_USDC_CONTRACT, mono: true },
            { label: "Destination asset", value: "nep141:wrap.near", mono: true },
            { label: "Funding actor", value: "Owner wallet only" },
          ]} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Input amount · USDC atomic units">
              <input value={amountAtomic} onChange={(event) => setAmountAtomic(event.target.value)} inputMode="numeric" className="mt-1.5 h-11 w-full border border-input bg-background px-3 font-mono text-xs rounded-md" />
            </Field>
            <Field label="NEAR recipient · exact account ID">
              <input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="owner.near" autoComplete="off" className="mt-1.5 h-11 w-full border border-input bg-background px-3 font-mono text-xs rounded-md" />
            </Field>
            <Field label="Arbitrum refund address">
              <input value={refundTo} onChange={(event) => setRefundTo(event.target.value)} placeholder="0x…" autoComplete="off" className="mt-1.5 h-11 w-full border border-input bg-background px-3 font-mono text-xs rounded-md" />
            </Field>
          </div>

          <p role="status" className="border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs leading-5 text-muted-foreground rounded-xl">
            wNEAR token-storage registration: <strong className="text-foreground">NOT VERIFIED · funding blocked</strong>. A named NEAR account does not prove it can receive this token.
          </p>

          <button type="button" disabled={Boolean(busy) || !validInput} onClick={() => void requestReview()} className="inline-flex h-9 items-center gap-1.5 bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md">
            {busy === "review" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            Request executable review
          </button>
        </div>
      )}

      {error ? <p role="alert" className="mt-4 border border-blocked/35 bg-blocked/[0.06] px-3 py-2 text-xs leading-5 text-blocked rounded-xl">Unavailable: {error} No fixture data was substituted.</p> : null}

      {review ? (
        <section aria-labelledby="near-live-review-result" className="mt-4 min-w-0 overflow-hidden border border-approval/35 bg-card rounded-xl">
          <div className="flex min-w-0 items-start gap-3 p-4">
            <span className="grid size-8 shrink-0 place-items-center border border-executed/30 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))] rounded-md">
              <BadgeCheck className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="label-mono">Live provider response · signature verified</p>
              <h4 id="near-live-review-result" className="mt-1 text-sm font-medium tracking-tight">Exact owner-funding review</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Review evidence only. Provider verification is distinct from owner approval, funding, settlement, and independent destination evidence.</p>
            </div>
          </div>
          <div className="border-t border-border px-4 py-3.5">
            <DetailGrid items={reviewRows(review)} />
            <ol className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
              <Instruction number="1">Confirm Arbitrum One, chain ID 42161, and the exact native USDC contract shown above.</Instruction>
              <Instruction number="2">Separately verify wNEAR token-storage registration for the exact NEAR recipient. Funding remains blocked until that evidence exists.</Instruction>
              <Instruction number="3">If separately authorized outside this panel, the owner wallet—not Pilot—must send the exact atomic amount to the exact deposit address with no memo.</Instruction>
            </ol>
            <p role="note" className="mt-3 text-xs leading-5 text-muted-foreground">
              Pilot budgets cannot stop an owner from transferring outside the app. This panel offers no wallet connection, QR code, deep link, transaction builder, signature, broadcast, approval, or reservation action.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled aria-disabled="true" className="inline-flex h-9 items-center border border-border-strong px-3.5 text-[13px] font-semibold text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md">
                Manual funding blocked · storage not verified
              </button>
              <button type="button" disabled={Boolean(busy)} onClick={() => void refreshStatus()} className="inline-flex h-9 items-center gap-1.5 border border-border-strong px-3.5 text-[13px] transition hover:bg-white/[0.05] disabled:opacity-45 pointer-coarse:h-11 rounded-md">
                {busy === "status" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
                Refresh bound status
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {review && status ? (
        <section aria-labelledby="near-live-status-result" className="mt-4 min-w-0 overflow-hidden border border-border bg-card rounded-xl">
          <div className="p-4">
            <p className="label-mono">Live provider status · signature verified</p>
            <h4 id="near-live-status-result" className="mt-1 text-sm font-medium tracking-tight">Bound settlement status</h4>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">This read is bound to the exact deposit address, correlation ID, and verified quote hash below.</p>
          </div>
          <div className="border-t border-border px-4 py-3.5">
            <DetailGrid items={statusRows(review, status)} />
            <p role="note" className="mt-3 border border-info/30 bg-info/[0.06] px-3 py-2 text-xs leading-5 text-muted-foreground rounded-xl">
              Provider status is not independent NEAR delivery evidence. Confirm the exact destination transaction, recipient, asset, token storage, and balance delta separately before concluding receipt.
            </p>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function reviewRows(review: LiveNearOwnerFundedReview) {
  return [
    { label: "Provider verification", value: "Live · signature verified" },
    { label: "Quote hash", value: review.quote_hash, mono: true },
    { label: "Correlation ID", value: review.quote_binding.correlation_id, mono: true },
    { label: "Input amount · atomic", value: review.owner_review.amount_atomic, mono: true },
    { label: "Minimum output · atomic", value: review.owner_review.minimum_amount_out, mono: true },
    { label: "Destination recipient", value: review.owner_review.destination_recipient, mono: true },
    { label: "Refund address", value: review.quote_binding.refund_to, mono: true },
    { label: "Deposit address", value: review.owner_review.deposit_address, mono: true },
    { label: "Deposit memo", value: "None · unsupported for this route" },
    { label: "Approval freshness ends", value: review.quote_binding.approval_expires_at, mono: true },
    { label: "Provider refund-start deadline", value: review.owner_review.provider_deadline, mono: true },
    { label: "Execution", value: "Disabled · manual owner funding only" },
  ];
}

function statusRows(review: LiveNearOwnerFundedReview, result: LiveNearOwnerFundedStatus) {
  const originHashes = result.status.swapDetails.originChainTxHashes.map(({ hash }) => hash);
  const destinationHashes = result.status.swapDetails.destinationChainTxHashes.map(({ hash }) => hash);
  return [
    { label: "Provider status", value: result.status.status, mono: true },
    { label: "Correlation ID", value: result.status.correlationId, mono: true },
    { label: "Updated at", value: result.status.updatedAt, mono: true },
    { label: "Bound quote hash", value: review.owner_review.status_lookup.expected_quote_hash, mono: true },
    { label: "Bound deposit address", value: review.owner_review.status_lookup.deposit_address, mono: true },
    { label: "Origin transaction hashes", value: originHashes.length ? originHashes.join(", ") : "None reported", mono: true },
    { label: "Destination transaction hashes", value: destinationHashes.length ? destinationHashes.join(", ") : "None reported", mono: true },
    { label: "Independent destination evidence", value: "Not collected by this status read" },
  ];
}

function Field({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return <label className="min-w-0"><span className="label-mono block">{label}</span>{children}</label>;
}

function Instruction({ number, children }: Readonly<{ number: string; children: React.ReactNode }>) {
  return (
    <li className="flex min-w-0 items-start gap-2">
      <span className="grid size-5 shrink-0 place-items-center border border-border font-mono text-[10px] text-foreground rounded-full">{number}</span>
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}
