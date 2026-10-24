"use client";

import type { CardEvent } from "@pilot/contracts";
import {
  AlertOctagon,
  Ban,
  Check,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileCheck2,
  LoaderCircle,
  Radio,
  Send,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  XCircle,
} from "lucide-react";

import { CardFrame, DetailGrid, intentLabel, shorten } from "./card-frame";

const RULE_LABELS: Record<string, string> = {
  max_per_tx_usd: "Per-trade limit",
  daily_cap_usd: "Daily cap",
  execute_under_usd: "Auto-execute limit",
  max_slippage_bps: "Slippage",
  issuer_allowlist: "Issuer allowlist",
  block_requireauth_issuers: "RequireAuth issuers",
  networks: "Network",
  allowed_tx_types: "Transaction type",
};

/** Policy rule keys read as plain words on the cards. */
function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? rule.replaceAll("_", " ");
}

export type StateCardProps = {
  event: CardEvent;
  onApprove?: (event: CardEvent) => void;
  onCancel?: (event: CardEvent) => void;
  /** Hide the wallet-signing explainer (the landing preview has no room for it). */
  hideSigningNote?: boolean;
};

export function DraftingCard({ event, onCancel }: StateCardProps) {
  return (
    <CardFrame
      event={event}
      title="Drafting intent"
      subtitle="Translating your request into a typed XRPL action."
      icon={Sparkles}
      tone="active"
      footer={onCancel ? <CancelButton event={event} onCancel={onCancel} /> : undefined}
    >
      <div className="space-y-2" role="status" aria-label="Drafting in progress">
        <div className="h-2 w-11/12 animate-pulse bg-white/[0.07]" />
        <div className="h-2 w-7/12 animate-pulse bg-white/[0.07]" />
      </div>
    </CardFrame>
  );
}
export function PlannedCard({ event, onCancel }: StateCardProps) {
  return (
    <CardFrame event={event} title="Plan ready" subtitle="The action is typed and ready for Harbor to build." icon={FileCheck2} footer={onCancel ? <CancelButton event={event} onCancel={onCancel} /> : undefined}>
      <DetailGrid items={[
        { label: "Network", value: event.intent.network },
        { label: "Intent", value: event.intent.kind.replaceAll("_", " ") },
      ]} />
    </CardFrame>
  );
}

export function SimulatedCard({ event, onCancel }: StateCardProps) {
  const engine = event.build?.simulate.engine_result ?? "tesSUCCESS";
  return (
    <CardFrame event={event} title="Simulation passed" subtitle="Ledger simulation completed without applying the transaction." icon={CircleDashed} tone="active" footer={onCancel ? <CancelButton event={event} onCancel={onCancel} /> : undefined}>
      <DetailGrid items={[
        { label: "Engine result", value: engine, mono: true },
        { label: "Est. slippage", value: event.build?.summary.est_slippage_bps != null ? `${event.build.summary.est_slippage_bps} bps` : "—" },
        { label: "Network fee", value: `${event.build?.summary.fee_drops ?? "12"} drops` },
        { label: "Applied", value: "No · simulation only" },
      ]} />
    </CardFrame>
  );
}

export function PolicyCheckedCard({ event, onCancel }: StateCardProps) {
  const reasons = event.policy?.reasons ?? [
    { rule: "transaction limit", pass: true, detail: "Within $2,000 per-transaction limit" },
    { rule: "issuer allowlist", pass: true, detail: "RLUSD is approved" },
  ];
  return (
    <CardFrame event={event} title="Policy cleared" subtitle="Pilot checked every rule before execution." icon={ShieldCheck} tone="success" footer={onCancel ? <CancelButton event={event} onCancel={onCancel} /> : undefined}>
      <ul className="space-y-2">
        {reasons.slice(0, 3).map((reason) => (
          <li key={reason.rule} className="flex items-start gap-2 text-xs leading-5">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" aria-hidden="true" />
            <span><span className="text-[13px]">{ruleLabel(reason.rule)}</span><span className="text-muted-foreground"> · {reason.detail}</span></span>
          </li>
        ))}
      </ul>
    </CardFrame>
  );
}

export function ExecutingCard({ event, onCancel }: StateCardProps) {
  return (
    <CardFrame
      event={event}
      title="Executing through Harbor"
      subtitle="The delegated signer is preparing and submitting the transaction."
      icon={LoaderCircle}
      tone="active"
      footer={onCancel ? <CancelButton event={event} onCancel={onCancel} label="Stop updates" /> : undefined}
    >
      <div className="h-1 overflow-hidden bg-white/[0.07]">
        <span className="block h-full w-2/3 animate-pulse bg-info" />
      </div>
      <p className="mt-2 text-[13px] text-muted-foreground">Signing with the delegate · your owner key never leaves your wallet</p>
    </CardFrame>
  );
}

export function AwaitingApprovalCard({ event, onApprove, onCancel, hideSigningNote = false }: StateCardProps) {
  const summary = event.build?.summary;
  return (
    <CardFrame
      event={event}
      title="Owner approval required"
      subtitle="Review this exact summary before opening your wallet."
      icon={Clock3}
      tone="approval"
      footer={
        onApprove || onCancel ? (
          <div className="flex flex-wrap gap-2">
            {onApprove ? <button type="button" onClick={() => onApprove(event)} className="h-9 bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90 rounded-md">Review & sign</button> : null}
            {onCancel ? <CancelButton event={event} onCancel={onCancel} /> : null}
          </div>
        ) : undefined
      }
    >
      <DetailGrid items={[
        { label: "Action", value: summary?.action ?? event.intent.kind.replaceAll("_", " ") },
        { label: "Amount", value: summary?.amounts.join(event.intent.kind === "swap" ? " → " : " + ") ?? "Shown in wallet" },
        { label: "Destination", value: destinationFor(event) },
        { label: "Max fee", value: `${summary?.fee_drops ?? "12"} drops` },
      ]} />
      {hideSigningNote ? null : <p className="mt-3 border border-approval/30 bg-approval/[0.06] px-3 py-2 text-[11px] leading-4 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] rounded-xl">Your wallet only signs; it never broadcasts. Pilot checks the signature comes from your wallet, then sends the signed blob to Harbor&apos;s REST API (<span className="font-mono">tx.submit</span>). Harbor matches it to this exact approval before submitting it to the XRP Ledger.</p>}
    </CardFrame>
  );
}

export function BlockedCard({ event }: StateCardProps) {
  const reasons = event.policy?.reasons.filter((reason) => !reason.pass) ?? [
    { rule: "issuer allowlist", pass: false, detail: "Issuer is not approved" },
  ];
  return (
    <CardFrame event={event} title="Blocked by policy" subtitle="Nothing was signed or submitted." icon={Ban} tone="danger">
      <ul className="space-y-2">
        {reasons.map((reason) => (
          <li key={`${reason.rule}-${reason.detail}`} className="flex items-start gap-2 text-xs leading-5">
            <AlertOctagon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
            <span><span className="text-[13px]">{ruleLabel(reason.rule)}</span><span className="text-muted-foreground"> · {reason.detail}</span></span>
          </li>
        ))}
      </ul>
    </CardFrame>
  );
}

export function SubmittedCard({ event }: StateCardProps) {
  return (
    <CardFrame event={event} title="Submitted to XRPL" subtitle="The transaction is waiting for a validated ledger." icon={Send} tone="active">
      <div className="flex min-w-0 items-center gap-2 border border-border bg-white/[0.02] px-3 py-2 font-mono text-[11px] text-muted-foreground rounded-xl">
        <Radio className="h-3.5 w-3.5 shrink-0 animate-pulse text-info" aria-hidden="true" />
        <span className="min-w-0 truncate">{event.hash ?? "A19F…80C2"}</span>
      </div>
    </CardFrame>
  );
}

export function ValidatedCard({ event }: StateCardProps) {
  const result = event.exec?.status === "executed" ? event.exec.result : "success";
  const hash = event.hash ?? (event.exec?.status === "executed" ? event.exec.hash : undefined) ?? "A19F…80C2";
  return (
    <CardFrame event={event} title="Validated" subtitle="The XRPL ledger confirmed this action." icon={CheckCircle2} tone="success">
      <DetailGrid items={[
        { label: "Result", value: result },
        { label: "Signed by", value: event.exec?.status === "executed" ? event.exec.signed_by : "owner" },
        { label: "Transaction", value: shorten(hash, 8, 6), mono: true },
        { label: "Ledger", value: event.exec?.status === "executed" ? event.exec.ledger_index.toLocaleString() : "Validated" },
      ]} />
    </CardFrame>
  );
}

/** A trade the owner turned down at the approval step. Nothing was signed. */
export function DeclinedCard({ event }: StateCardProps) {
  return (
    <CardFrame event={event} badge="declined" title="Declined" subtitle="You turned this trade down. Nothing was signed or sent." icon={XCircle} tone="neutral">
      <DetailGrid items={[
        { label: "Action", value: event.build?.summary.action ?? intentLabel(event.intent) },
        { label: "Amount", value: event.build?.summary.amounts.join(event.intent.kind === "swap" ? " → " : " + ") ?? intentLabel(event.intent) },
      ]} />
    </CardFrame>
  );
}

export function FailedCard({ event }: StateCardProps) {
  const detail = event.error ?? (event.exec?.status === "failed" ? event.exec.detail : "The ledger rejected the transaction.");
  const code = event.exec?.status === "failed" ? event.exec.engine_result : "tecFAILED_PROCESSING";
  return (
    <CardFrame event={event} title="Execution failed" subtitle="No automatic retry was attempted." icon={TriangleAlert} tone="danger">
      <p className="break-words text-xs leading-5 text-muted-foreground">{detail}</p>
      <p className="mt-2 font-mono text-[11px] text-destructive">{code}</p>
    </CardFrame>
  );
}

function CancelButton({ event, onCancel, label = "Cancel" }: { event: CardEvent; onCancel: (event: CardEvent) => void; label?: string }) {
  return <button type="button" onClick={() => onCancel(event)} className="bracket bracket-light h-9 border border-border bg-white/[0.03] px-3.5 text-[13px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground rounded-md">{label}</button>;
}

function destinationFor(event: CardEvent) {
  if (event.intent.kind === "pay") return shorten(event.intent.to);
  if (event.intent.kind === "vault_deposit") return event.intent.vault_id;
  if (event.intent.kind === "swap" || event.intent.kind === "limit") return "XRPL DEX";
  return "XRPL protocol";
}
