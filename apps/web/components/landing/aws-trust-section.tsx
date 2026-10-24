import { Bot, KeyRound, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import React from "react";

const protections: ReadonlyArray<{
  description: string;
  icon: LucideIcon;
  title: string;
}> = [
  {
    title: "Bedrock Guardrails",
    description: "Screens untrusted ledger and tool text before it reaches the model, with fail-closed redaction.",
    icon: ShieldCheck,
  },
  {
    title: "Amazon Bedrock models",
    description: "Keeps model provenance visible on every supported intent receipt, including explicit mock labels.",
    icon: Bot,
  },
  {
    title: "AWS KMS",
    description: "Protects Harbor-held key material and records the signer mode without exposing credentials or key ARNs.",
    icon: KeyRound,
  },
];

const architectureStages = ["Untrusted data", "Guardrails", "Bedrock", "Harbor policy", "XRPL Testnet"] as const;

export function AwsTrustSection() {
  return (
    <section
      aria-labelledby="aws-trust-heading"
      className="border-t border-slate-200 bg-slate-50 px-4 py-14 text-slate-950 sm:px-6 lg:px-8 lg:py-20"
    >
      <div className="mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-700">Built on AWS</p>
          <h2 id="aws-trust-heading" className="mt-3 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
            Trust you can inspect, not just assume.
          </h2>
          <p className="mt-4 max-w-2xl text-pretty text-sm leading-6 text-slate-600 sm:text-base">
            Pilot carries structured screening, model, and signer provenance from Harbor into each action receipt.
          </p>
        </div>

        <ul className="mt-9 grid gap-4 md:grid-cols-3" aria-label="AWS trust protections">
          {protections.map(({ description, icon: Icon, title }) => (
            <li
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              data-protection="aws"
              key={title}
            >
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-50 text-cyan-700">
                <Icon aria-hidden="true" className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-bold tracking-tight">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
            </li>
          ))}
        </ul>

        <figure
          aria-labelledby="aws-architecture-title"
          className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 p-5 text-white shadow-sm sm:p-7"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <figcaption id="aws-architecture-title" className="text-sm font-bold">
              Trust path architecture
            </figcaption>
            <span className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-cyan-200">
              Mock-first · event-ready
            </span>
          </div>
          <p className="sr-only">
            Untrusted data passes through Bedrock Guardrails and a selected Bedrock model, then Harbor policy, before
            an approved action reaches XRPL Testnet.
          </p>
          <ol className="mt-5 grid gap-2 sm:grid-cols-5" aria-label="AWS trust path">
            {architectureStages.map((stage, index) => (
              <li className="relative min-w-0" key={stage}>
                <div className="flex h-full min-h-16 items-center gap-3 rounded-xl border border-white/10 bg-white/[0.045] px-3 py-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-cyan-300/12 font-mono text-[10px] font-bold text-cyan-200">
                    {index + 1}
                  </span>
                  <span className="text-xs font-semibold leading-5 text-slate-100">{stage}</span>
                </div>
                {index < architectureStages.length - 1 ? (
                  <span aria-hidden="true" className="absolute -bottom-2 left-1/2 text-xs text-cyan-300 sm:-right-2.5 sm:bottom-auto sm:left-auto sm:top-1/2 sm:-translate-y-1/2">
                    →
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </figure>
      </div>
    </section>
  );
}
