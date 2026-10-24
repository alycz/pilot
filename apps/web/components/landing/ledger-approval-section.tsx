import { ArrowRight } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import type { ReactElement } from "react";

const approvalSteps = [
  {
    eyebrow: "01 · Propose",
    title: "The agent proposes",
    body: "Pilot turns the request into a typed intent and an exact XRPL transaction. The agent never holds the owner key.",
  },
  {
    eyebrow: "02 · Execute",
    title: "Harbor's bounded delegate executes",
    body: "Within the permissions granted on-ledger and the limits checked by Harbor, the delegate can execute without another owner signature.",
  },
  {
    eyebrow: "03 · Approve",
    title: "The Ledger approves anything beyond it",
    body: "When an action exceeds that bounded authority, the owner reviews and signs the exact transaction on the Ledger.",
  },
] as const;

const delegatePermissions = [
  ["8", "OfferCreate", "Place DEX offers (swaps) within policy"],
  ["9", "OfferCancel", "Cancel its own offers"],
  ["21", "TrustSet", "Add or adjust trust lines"],
  ["37", "AMMDeposit", "Add liquidity to AMM pools"],
  ["38", "AMMWithdraw", "Remove liquidity"],
  ["3", "EscrowFinish", "Finish escrows"],
  ["18", "CheckCash", "Cash checks"],
] as const;

export type LedgerApprovalSectionProps = Readonly<{
  /**
   * A deterministic LG-5 replay of the clear-signed TrustSet screen. Keeping
   * the preview injected prevents this landing package from copying transcript
   * fixtures or creating another source of simulated-device truth.
   */
  trustSetDevicePreview: ReactElement;
}>;

export function LedgerApprovalSection({
  trustSetDevicePreview,
}: LedgerApprovalSectionProps) {
  return (
    <section aria-labelledby="ledger-approval-heading" className="border-b border-border bg-background">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-6" data-reveal>
          <div className="max-w-3xl">
            <p className="label-mono">Approve on Ledger</p>
            <h2
              id="ledger-approval-heading"
              className="mt-3 text-balance text-[1.5rem] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[1.75rem] font-display"
            >
              Bounded automation. Owner control beyond the boundary.
            </h2>
            <p className="mt-4 max-w-2xl text-[15px] leading-7 text-muted-foreground">
              This mirrors Ledger Agent Intent's human-in-the-loop model for XRPL.
              Ledger Agent Intent does not support XRPL yet. Pilot uses Ledger's
              Device Management Kit (DMK), not legacy LedgerJS.
            </p>
            <p className="mt-3 max-w-2xl text-xs leading-5 text-muted-foreground" role="note">
              Simulated evidence only. Physical-Ledger and live-Testnet checks are still pending and are not claimed here.
            </p>
          </div>
          <Link href="/integrations/ledger" className="link-dashed inline-flex items-center gap-1.5 text-[13px] text-foreground pointer-coarse:min-h-11">
            See how it works <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>

        <ol
          aria-label="Ledger approval path"
          className="mt-10 grid gap-px border border-border bg-border lg:grid-cols-3 rounded-xl overflow-hidden"
          data-reveal-stagger
        >
          {approvalSteps.map((step, index) => (
            <li className="bg-card p-5 sm:p-6" data-ledger-step="" key={step.title}>
              <p className="flex items-baseline gap-2.5">
                <span className="font-mono text-[15px] leading-none tabular-nums text-muted-foreground">0{index + 1}</span>
                <span className="text-[15px] leading-none text-foreground">{step.eyebrow.split(" · ")[1]}</span>
              </p>
              <h3 className="mt-4 text-[15px] font-medium text-foreground">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <figure
            aria-labelledby="ledger-trustset-caption"
            className="border border-border bg-card p-5 sm:p-6 rounded-xl"
          >
            <div
              aria-label="Simulated Ledger clear-signing a TrustSet"
              className="grid min-h-64 place-items-center border border-border bg-background p-4 rounded-xl"
            >
              {trustSetDevicePreview}
            </div>
            <figcaption
              id="ledger-trustset-caption"
              className="mt-4 text-sm leading-6 text-muted-foreground"
            >
              Clear-signed <span className="font-mono text-foreground">TrustSet</span>
              {" "}screen from the deterministic local simulated-device replay.
            </figcaption>
          </figure>

          <section
            aria-labelledby="ledger-delegateset-heading"
            className="border border-border bg-card p-5 sm:p-6 rounded-xl overflow-hidden"
          >
            <p className="label-mono">Blind-signing legend</p>
            <h3 id="ledger-delegateset-heading" className="mt-3 text-[15px] font-medium text-foreground">
              DelegateSet is blind-signed
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Ledger's XRP app 2.8.2 labels these fields as unknown. During
              onboarding, Pilot shows the full Harbor delegate address beside the
              device; this preview preserves every fixed permission instead of
              pretending the transaction is clear-signed.
            </p>
            <dl className="mt-5 grid gap-px border border-border bg-border sm:grid-cols-2 rounded-xl overflow-hidden">
              {delegatePermissions.map(([value, name, meaning], index) => (
                <div className={`bg-card p-3 ${index === delegatePermissions.length - 1 ? "sm:col-span-2" : ""}`} key={value}>
                  <dt className="font-mono text-[11px] text-muted-foreground">
                    Unknown [{index + 1}] | {value}
                  </dt>
                  <dd className="mt-1 text-sm font-medium text-foreground">{name}</dd>
                  <dd className="mt-1 text-xs leading-5 text-muted-foreground">{meaning}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 border border-approval/40 bg-approval/[0.06] p-3 text-xs font-medium leading-5 text-foreground rounded-xl">
              When approving in onboarding, match the full delegate address shown
              there and all seven values, then disable blind signing after the
              delegation validates.
            </p>
          </section>
        </div>
      </div>
    </section>
  );
}
