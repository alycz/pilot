import {
  BadgeCheck,
  CircleDollarSign,
  FileKey2,
  Link2,
  RadioTower,
  ScanSearch,
  TriangleAlert,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import React, { type ReactNode } from "react";

import { DetailGrid } from "../cards/card-frame";

const ARBITRUM_CHAIN_ID = "42161";
const ARBITRUM_USDC_CONTRACT = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const INPUT_AMOUNT_ATOMIC = "25000000";
const DESTINATION_ASSET = "nep141:wrap.near";
const MINIMUM_OUTPUT_ATOMIC = "412345678901234567890123";
const DEPOSIT_ADDRESS = "0x1111111111111111111111111111111111110042";
const OWNER_REPORTED_TX_HASH = `0x${"a".repeat(64)}`;
const APPROVAL_DIGEST = "C14D5BF4E7398DB86A29B3D03BDA06A71295558284445B8698814B2C441A19AE";

const stages = [
  "Executable quote",
  "Fresh approval",
  "Owner funding",
  "Origin tx binding",
  "Provider status",
  "Unknown / refund",
  "Destination evidence",
] as const;

type Tone = "neutral" | "active" | "success" | "approval" | "danger";

const toneStyles: Record<Tone, { border: string; icon: string; badge: string }> = {
  neutral: {
    border: "border-border",
    icon: "border-border text-muted-foreground",
    badge: "border-border-strong bg-white/[0.03] text-muted-foreground",
  },
  active: {
    border: "border-border",
    icon: "border-info/30 text-[color-mix(in_oklab,var(--info)_80%,var(--foreground))]",
    badge: "border-info/35 bg-info/10 text-[color-mix(in_oklab,var(--info)_80%,var(--foreground))]",
  },
  success: {
    border: "border-border",
    icon: "border-executed/30 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]",
    badge: "border-executed/35 bg-executed/10 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]",
  },
  approval: {
    border: "border-approval/35",
    icon: "border-approval/35 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]",
    badge: "border-approval/40 bg-approval/10 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]",
  },
  danger: {
    border: "border-destructive/35",
    icon: "border-destructive/35 text-[color-mix(in_oklab,var(--destructive)_80%,var(--foreground))]",
    badge: "border-destructive/40 bg-destructive/10 text-[color-mix(in_oklab,var(--destructive)_80%,var(--foreground))]",
  },
};

export function NearIntentsFixtureDemo() {
  return (
    <section
      aria-labelledby="near-owner-funded-title"
      className="min-w-0 overflow-hidden border border-border bg-card rounded-xl"
      data-near-owner-funded-fixture="review-only"
    >
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center border border-primary/30 bg-primary-soft text-primary rounded-md">
            <CircleDollarSign className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="label-mono">Local fixture · no provider or wallet calls</p>
            <h2 id="near-owner-funded-title" className="mt-1 text-sm font-medium tracking-tight">
              Arbitrum USDC → wNEAR manual owner-funding review
            </h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              Inspect the only executable-shaped route in this fixture. Every value is deterministic local data; nothing below is a current quote, wallet instruction, transaction, or settlement claim.
            </p>
          </div>
        </div>
      </header>

      <ol
        aria-label="Owner-funded fixture stages"
        className="grid min-w-0 grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-4 lg:grid-cols-7"
      >
        {stages.map((label, index) => (
          <li key={label} className="min-w-0 bg-card px-3 py-3 text-xs text-muted-foreground">
            <span className="font-mono text-[10px]">{String(index + 1).padStart(2, "0")}</span>
            <span className="mt-0.5 block break-words">{label}</span>
          </li>
        ))}
      </ol>

      <div className="space-y-4 p-4 sm:p-5">
        <p role="note" className="border border-approval/30 bg-approval/[0.06] px-3 py-2 text-xs leading-5 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] rounded-xl">
          Fixture provenance: this walkthrough models a provider-signature-verified executable quote, but this page did not request or verify one. Real funding requires a fresh provider response and a fresh owner review.
        </p>

        <ol className="space-y-4" aria-label="Detailed owner-funded walkthrough">
          <li>
            <WalkthroughStage
              number="01"
              icon={BadgeCheck}
              tone="active"
              title="Verified executable quote review pattern"
              subtitle="Fixture transcript only. It demonstrates the fields Pilot must obtain from a provider-signature-verified executable response."
              badge="Fixture provenance"
              rows={[
                { label: "Route", value: "Arbitrum USDC → wNEAR on NEAR" },
                { label: "Origin chain ID", value: ARBITRUM_CHAIN_ID, mono: true },
                { label: "Origin token contract", value: ARBITRUM_USDC_CONTRACT, mono: true },
                { label: "Input amount · atomic", value: INPUT_AMOUNT_ATOMIC, mono: true },
                { label: "Destination asset ID", value: DESTINATION_ASSET, mono: true },
                { label: "Minimum output · atomic", value: MINIMUM_OUTPUT_ATOMIC, mono: true },
                { label: "Deposit address · fixture", value: DEPOSIT_ADDRESS, mono: true },
                { label: "Deposit memo", value: "None · unsupported for this route" },
                { label: "Quote ID · fixture", value: "fixture-arb-usdc-to-wnear-001", mono: true },
                { label: "Provider signature", value: "Fixture assertion only · not verified on this page" },
              ]}
            />
          </li>

          <li>
            <WalkthroughStage
              number="02"
              icon={FileKey2}
              tone="approval"
              title="Fresh principal-bound owner approval"
              subtitle="A dry quote is preview evidence only. It cannot be upgraded, reused, or treated as approval for this executable-shaped fixture."
              badge="Fresh approval required"
              rows={[
                { label: "Principal", value: "fixture-principal", mono: true },
                { label: "Owner account", value: "owner-demo.near", mono: true },
                { label: "Approval digest · fixture", value: APPROVAL_DIGEST, mono: true },
                { label: "Approval freshness", value: "Five-minute local fixture window" },
                { label: "Dry quote relationship", value: "Distinct · never executable" },
                { label: "Runtime execution", value: "Disabled" },
              ]}
            >
              <DisabledAction label="Owner approval unavailable in fixture" />
            </WalkthroughStage>
          </li>

          <li>
            <WalkthroughStage
              number="03"
              icon={WalletCards}
              tone="approval"
              title="Manual owner funding instructions"
              subtitle="The owner—not Pilot—is the transaction actor. These exact fixture fields are shown for review and are not a request to transfer funds."
              badge="Owner action · disabled"
              rows={[
                { label: "Wallet network", value: "Arbitrum One · chain 42161" },
                { label: "Token", value: `USDC · ${ARBITRUM_USDC_CONTRACT}`, mono: true },
                { label: "Exact atomic amount", value: INPUT_AMOUNT_ATOMIC, mono: true },
                { label: "Exact deposit address", value: DEPOSIT_ADDRESS, mono: true },
                { label: "Deposit memo", value: "None · unsupported" },
                { label: "Transaction actor", value: "Owner wallet only" },
                { label: "wNEAR storage registration", value: "NOT VERIFIED · funding blocked" },
                { label: "Funding readiness", value: "Not ready" },
              ]}
            >
              <ol className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
                <Instruction number="1">Confirm Arbitrum One and chain ID 42161 in the owner wallet.</Instruction>
                <Instruction number="2">Confirm native USDC at the exact contract shown above.</Instruction>
                <Instruction number="3">Separately confirm that the NEAR recipient is registered to receive wNEAR. A named account alone does not prove token-storage readiness.</Instruction>
                <Instruction number="4">Independently enter the exact atomic amount and deposit address.</Instruction>
                <Instruction number="5">Do not add a memo; this fixture route marks memo support as none.</Instruction>
              </ol>
              <p role="note" className="mt-3 border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs leading-5 text-muted-foreground rounded-xl">
                Pilot does not build, sign, or send this transfer. Pilot budgets can block Pilot-mediated actions, but cannot stop an owner from transferring outside the app. Manual funding remains blocked until recipient wNEAR token-storage registration is independently confirmed.
              </p>
              <DisabledAction label="Manual funding unavailable in fixture" />
            </WalkthroughStage>
          </li>

          <li>
            <WalkthroughStage
              number="04"
              icon={Link2}
              tone="neutral"
              title="Owner-reported origin transaction binding"
              subtitle="An owner-reported hash is bound to this principal, quote, deposit address, and amount before status tracking. Reporting is not chain confirmation."
              badge="Local owner report"
              rows={[
                { label: "Origin transaction hash · fixture", value: OWNER_REPORTED_TX_HASH, mono: true },
                { label: "Origin chain ID", value: ARBITRUM_CHAIN_ID, mono: true },
                { label: "Bound amount · atomic", value: INPUT_AMOUNT_ATOMIC, mono: true },
                { label: "Bound deposit address", value: DEPOSIT_ADDRESS, mono: true },
                { label: "Origin receipt evidence", value: "Not fetched · fixture" },
                { label: "Resubmission", value: "Blocked until reconciliation" },
              ]}
            >
              <DisabledAction label="Record transaction unavailable in fixture" />
            </WalkthroughStage>
          </li>

          <li>
            <WalkthroughStage
              number="05"
              icon={RadioTower}
              tone="active"
              title="Provider status progression"
              subtitle="Status must be queried against the exact provider tracking identity. This sequence is illustrative and was not observed live."
              badge="Illustrative progression"
              rows={[
                { label: "1 · Deposit reported", value: "KNOWN_DEPOSIT_TX", mono: true },
                { label: "2 · Provider processing", value: "PROCESSING", mono: true },
                { label: "3 · Provider terminal", value: "SUCCESS", mono: true },
                { label: "Current live status", value: "Not queried" },
              ]}
            />
          </li>

          <li>
            <WalkthroughStage
              number="06"
              icon={TriangleAlert}
              tone="danger"
              title="UNKNOWN outcome and refund branch"
              subtitle="Missing or contradictory evidence becomes UNKNOWN, not failed and not safe to retry. Funding again remains blocked while reconciliation is incomplete."
              badge="Reconciliation required"
              rows={[
                { label: "Pilot outcome", value: "UNKNOWN", mono: true },
                { label: "Safe to resubmit", value: "False" },
                { label: "Provider refund status", value: "REFUNDED only when returned by provider" },
                { label: "Refund evidence", value: "Independent Arbitrum receipt required" },
                { label: "Automatic refund promise", value: "None" },
                { label: "Execution", value: "Disabled" },
              ]}
            />
          </li>

          <li>
            <WalkthroughStage
              number="07"
              icon={ScanSearch}
              tone="success"
              title="Independent destination evidence"
              subtitle="Provider SUCCESS is a provider claim. Destination delivery requires separate NEAR-chain evidence for the exact recipient, token storage, and asset."
              badge="Evidence not collected"
              rows={[
                { label: "Provider terminal status", value: "SUCCESS · illustrative only", mono: true },
                { label: "Destination network", value: "NEAR mainnet" },
                { label: "Destination asset", value: DESTINATION_ASSET, mono: true },
                { label: "Destination recipient", value: "owner-demo.near", mono: true },
                { label: "wNEAR storage registration", value: "Not independently verified" },
                { label: "Destination transaction", value: "None · fixture" },
                { label: "Recipient balance delta", value: "Not independently verified" },
                { label: "Delivery conclusion", value: "Cannot conclude receipt" },
              ]}
            >
              <DisabledAction label="Destination validation unavailable in fixture" />
            </WalkthroughStage>
          </li>
        </ol>
      </div>

      <footer className="border-t border-border bg-white/[0.015] px-4 py-3 sm:px-5">
        <p className="text-xs leading-5 text-muted-foreground">
          Review-only fixture. No provider request, wallet connection, QR code, deep link, signature, transaction submission, or chain lookup is available here.
        </p>
      </footer>
    </section>
  );
}

function WalkthroughStage({
  number,
  icon: Icon,
  tone,
  title,
  subtitle,
  badge,
  rows,
  children,
}: Readonly<{
  number: string;
  icon: LucideIcon;
  tone: Tone;
  title: string;
  subtitle: string;
  badge: string;
  rows: { label: string; value: string; mono?: boolean }[];
  children?: ReactNode;
}>) {
  const style = toneStyles[tone];
  return (
    <article
      aria-label={`Stage ${number}: ${title}`}
      className={`min-w-0 overflow-hidden border bg-card rounded-xl ${style.border}`}
    >
      <div className="flex min-w-0 items-start gap-3 p-4">
        <span className={`grid h-8 w-8 shrink-0 place-items-center border bg-white/[0.02] rounded-md ${style.icon}`}>
          <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="label-mono">Stage {number}</p>
          <h3 className="mt-1 text-sm font-medium tracking-tight">{title}</h3>
          <p className="mt-0.5 text-balance break-words text-xs leading-relaxed text-muted-foreground">{subtitle}</p>
          <span className={`mt-2 inline-block border px-1.5 py-0.5 text-xs font-medium rounded ${style.badge}`}>
            {badge}
          </span>
        </div>
      </div>
      <div className="border-t border-border px-4 py-3.5">
        <DetailGrid items={rows} />
        {children}
      </div>
    </article>
  );
}

function Instruction({ number, children }: Readonly<{ number: string; children: ReactNode }>) {
  return (
    <li className="flex min-w-0 items-start gap-2">
      <span className="grid size-5 shrink-0 place-items-center border border-border font-mono text-[10px] text-foreground rounded-full">
        {number}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

function DisabledAction({ label }: Readonly<{ label: string }>) {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      className="mt-3 inline-flex h-9 items-center gap-1.5 border border-border-strong px-3.5 text-[13px] font-semibold text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md"
    >
      {label}
    </button>
  );
}
