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
    <section
      aria-labelledby="ledger-approval-heading"
      className="border-t border-slate-200 bg-slate-50 px-4 py-14 text-slate-950 [--color-white:#fff] sm:px-6 lg:px-8 lg:py-20"
    >
      <div className="mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-sky-700">
            Approve on Ledger
          </p>
          <h2
            id="ledger-approval-heading"
            className="mt-3 text-balance text-3xl font-bold tracking-tight sm:text-4xl"
          >
            Bounded automation. Owner control beyond the boundary.
          </h2>
          <p className="mt-4 max-w-2xl text-pretty text-sm leading-6 text-slate-600 sm:text-base">
            This mirrors Ledger Agent Intent's human-in-the-loop model for XRPL.
            Ledger Agent Intent does not support XRPL yet. Pilot uses Ledger's
            Device Management Kit (DMK), not legacy LedgerJS.
          </p>
        </div>

        <ol
          aria-label="Ledger approval path"
          className="mt-9 grid gap-px border border-slate-300 bg-slate-300 lg:grid-cols-3"
        >
          {approvalSteps.map((step) => (
            <li className="bg-white p-5" data-ledger-step="" key={step.title}>
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-sky-700">
                {step.eyebrow}
              </p>
              <h3 className="mt-3 text-base font-bold tracking-tight">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{step.body}</p>
            </li>
          ))}
        </ol>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <figure
            aria-labelledby="ledger-trustset-caption"
            className="border border-slate-300 bg-white p-5"
          >
            <div
              aria-label="Simulated Ledger clear-signing a TrustSet"
              className="grid min-h-64 place-items-center border border-slate-200 bg-slate-100 p-4"
            >
              {trustSetDevicePreview}
            </div>
            <figcaption
              id="ledger-trustset-caption"
              className="mt-4 text-sm leading-6 text-slate-600"
            >
              Clear-signed <span className="font-mono text-slate-900">TrustSet</span>
              {" "}screen from the deterministic local simulated-device replay.
            </figcaption>
            <p className="mt-2 border-l-2 border-amber-500 pl-3 text-xs leading-5 text-slate-600">
              Simulated evidence only. Physical-Ledger and live-Testnet checks are
              still pending and are not claimed here.
            </p>
          </figure>

          <section
            aria-labelledby="ledger-delegateset-heading"
            className="border border-amber-300 bg-amber-50 p-5"
          >
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-amber-900">
              Blind-signing legend
            </p>
            <h3 id="ledger-delegateset-heading" className="mt-3 text-lg font-bold tracking-tight">
              DelegateSet is blind-signed
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-700">
              Ledger's XRP app 2.8.2 labels these fields as unknown. During
              onboarding, Pilot shows the full Harbor delegate address beside the
              device; this preview preserves every fixed permission instead of
              pretending the transaction is clear-signed.
            </p>
            <dl className="mt-5 grid gap-px border border-amber-200 bg-amber-200 sm:grid-cols-2">
              {delegatePermissions.map(([value, name, meaning], index) => (
                <div className="bg-white p-3" key={value}>
                  <dt className="font-mono text-[11px] text-amber-950">
                    Unknown [{index + 1}] | {value}
                  </dt>
                  <dd className="mt-1 text-sm font-bold text-slate-950">{name}</dd>
                  <dd className="mt-1 text-xs leading-5 text-slate-600">{meaning}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 border border-amber-300 bg-white p-3 text-xs font-semibold leading-5 text-amber-950">
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
