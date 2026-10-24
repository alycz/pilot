import type { Metadata } from "next";
import React from "react";

import { Ap4mDemoWorkspace } from "../../../components/demo";
import { resolveMerchantEventsUrl } from "./merchant-events";

export const metadata: Metadata = {
  title: "AP4M demo",
  description: "Mock-first Mastercard AP4M demo surface on XRPL Testnet.",
};

const labels = [
  "Mastercard Open Finance · mock",
  "Verifiable Intent v0.1 · Mastercard reference",
  "Testnet",
] as const;

export default function Ap4mDemoPage() {
  const merchantEventsUrl = resolveMerchantEventsUrl(process.env.AP4M_MERCHANT_EVENTS_URL);

  return (
    <main className="min-h-[800px] bg-[#f3f1ea] px-4 py-4 text-[#171814] sm:px-5">
      <div className="mx-auto flex min-h-[768px] w-full max-w-[1248px] flex-col gap-3">
        <header className="flex flex-col justify-between gap-3 border-b border-slate-400 pb-3 lg:flex-row lg:items-end">
          <div>
            <p className="text-xs font-bold text-[#235a52]">
              Mastercard AP4M on XRPL
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl font-display">
              Authorize once. Transact many times.
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-600">
              Local projector view with injected merchant events and public Testnet-shaped fixtures.
              Buttons are fail-closed previews; no wallet, sponsor credential, or network action runs by default.
            </p>
          </div>
          <div className="flex max-w-xl flex-wrap gap-1.5" aria-label="Demo environment">
            {labels.map((label) => (
              <span
                key={label}
                className="border border-[#235a52]/40 bg-white px-2.5 py-1 text-xs font-bold text-[#235a52] rounded-xl"
              >
                {label}
              </span>
            ))}
          </div>
        </header>

        <div
          className="border border-approval/40 bg-approval/10 px-3 py-2 text-[11px] font-semibold text-approval rounded-xl"
          role="status"
        >
          Mock-only stand-in evidence · LIVE Mastercard and XRPL Testnet checks remain pending
        </div>

        <Ap4mDemoWorkspace merchantEventsUrl={merchantEventsUrl} />
      </div>
    </main>
  );
}
