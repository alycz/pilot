"use client";

import * as React from "react";

import delegateSetBlind from "./transcripts/delegate-set-blind.json";
import offerCreate from "./transcripts/offer-create.json";
import reject from "./transcripts/reject.json";
import signIn from "./transcripts/sign-in.json";
import trustSet from "./transcripts/trust-set.json";
import verifyAddress from "./transcripts/verify-address.json";
import { SimulatedDevice } from "./simulated-device";

const FLOWS = [
  {
    id: "verify-address",
    label: "Verify address",
    eyebrow: "Connect your budget wallet",
    copy: "Use a test-network-only budget account. Your main holdings stay separate and are never linked.",
    transcript: verifyAddress,
  },
  {
    id: "sign-in",
    label: "Sign in",
    eyebrow: "Wallet proof",
    copy: "Pilot verifies the signature locally. This proof is not a transaction and is never submitted to the XRP Ledger.",
    transcript: signIn,
  },
  {
    id: "trust-set",
    label: "Trust line",
    eyebrow: "Prepare the budget account",
    copy: "Harbor builds and simulates the TrustSet; your wallet signs that exact transaction, then Pilot relays it through its fixed test-network provider.",
    transcript: trustSet,
  },
  {
    id: "delegate-set-blind",
    label: "Permissions",
    eyebrow: "Approve seven narrow permissions",
    copy: "None can send value to another account. Your wallet signs DelegateSet; Harbor's delegate pays network fees for permitted actions.",
    transcript: delegateSetBlind,
  },
  {
    id: "offer-create",
    label: "Owner approval",
    eyebrow: "Review what your wallet would show",
    copy: "Your wallet only signs; it never broadcasts. Pilot checks the signature comes from your wallet, then sends the signed blob to Harbor's REST API. Harbor matches it to this exact approval before submitting it to the XRP Ledger.",
    transcript: offerCreate,
  },
  {
    id: "reject",
    label: "Reject",
    eyebrow: "Decline on the device",
    copy: "Rejecting this recorded prompt creates no signature and submits nothing.",
    transcript: reject,
  },
] as const;

export function SimulatedDeviceDemo() {
  const [selectedId, setSelectedId] = React.useState("offer-create");
  const selected = FLOWS.find((flow) => flow.id === selectedId) ?? FLOWS[0];

  return (
    <main className="min-h-dvh bg-[#f5f3ec] px-5 py-8 text-[#171814] sm:px-8 lg:px-12">
      <div className="mx-auto w-full max-w-6xl">
        <header className="border-b border-[#171814]/20 pb-6">
          <p className="text-xs font-semibold text-[#235a52]">
            Ledger · logged-out demo
          </p>
          <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <h1 className="text-3xl font-semibold tracking-[-0.035em] sm:text-5xl font-display">
                See every screen before you sign.
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[#4c5048] sm:text-base">
                Recorded screens from Ledger&apos;s XRP app 2.8.2 replay locally. This page has no device, wallet, DMK, network, or signing capability.
              </p>
            </div>
            <span className="w-fit border border-[#235a52]/30 bg-[#fbfaf6] px-3 py-1.5 text-[13px] font-semibold text-[#235a52] rounded-xl">
              Simulated only
            </span>
          </div>
        </header>

        <div className="mt-7 grid gap-px border border-[#171814]/20 bg-[#171814]/20 lg:grid-cols-[0.72fr_1.28fr] rounded-xl">
          <section className="bg-[#fbfaf6] p-5 sm:p-7" aria-labelledby="ledger-demo-flow-title">
            <p className="text-[13px] font-semibold text-[#6a6e65]">
              Recorded flow
            </p>
            <h2 id="ledger-demo-flow-title" className="mt-2 text-xl font-semibold">
              Choose a device prompt
            </h2>
            <div className="mt-5 grid gap-2" role="group" aria-label="Ledger transcript">
              {FLOWS.map((flow) => (
                <button
                  aria-pressed={flow.id === selected.id}
                  className={`border px-3 py-3 text-left text-xs font-semibold transition rounded-md ${
                    flow.id === selected.id
                      ? "border-[#235a52] bg-[#235a52] text-[#fff]"
                      : "border-[#171814]/20 bg-[#fbfaf6] text-[#30332e] hover:border-[#235a52]/60"
                  }`}
                  key={flow.id}
                  onClick={() => setSelectedId(flow.id)}
                  type="button"
                >
                  {flow.label}
                </button>
              ))}
            </div>
          </section>

          <section className="bg-[#f0eee6] p-5 sm:p-7" aria-label="Simulated Ledger replay">
            <div className="mb-5 border-l-2 border-[#235a52] pl-4">
              <p className="text-[13px] font-semibold text-[#235a52]">
                {selected.eyebrow}
              </p>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[#4c5048]">
                {selected.copy}
              </p>
            </div>
            <SimulatedDevice key={selected.id} transcript={selected.transcript} />
          </section>
        </div>

        <p className="mt-4 text-xs text-[#6a6e65]">
          Recorded from Speculos with its public default test seed · no Testnet submission
        </p>
      </div>
    </main>
  );
}
