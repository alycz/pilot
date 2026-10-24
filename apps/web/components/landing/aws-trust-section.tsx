import { ArrowRight, Bot, KeyRound, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
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
    description: "Protects the engine's signing key material and records the signer mode without exposing credentials or key ARNs.",
    icon: KeyRound,
  },
];

const architectureStages = ["Untrusted data", "Guardrails", "Bedrock", "Harbor policy", "XRPL Testnet"] as const;

export function AwsTrustSection() {
  return (
    <section aria-labelledby="aws-trust-heading" className="border-b border-border bg-background">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-6" data-reveal>
          <div className="max-w-3xl">
            <p className="label-mono">Built on AWS</p>
            <h2 id="aws-trust-heading" className="mt-3 text-balance text-[1.5rem] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[1.75rem] font-display">
              Trust you can inspect, not just assume.
            </h2>
            <p className="mt-4 max-w-2xl text-[15px] leading-7 text-muted-foreground">
              Pilot carries structured screening, model, and signer provenance from the engine into each action receipt.
            </p>
          </div>
          <Link href="/integrations/aws" className="link-dashed inline-flex items-center gap-1.5 text-[13px] text-foreground pointer-coarse:min-h-11">
            See how it works <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>

        <ul className="mt-10 grid gap-px border border-border bg-border md:grid-cols-3 rounded-xl overflow-hidden" aria-label="AWS trust protections" data-reveal-stagger>
          {protections.map(({ description, icon: Icon, title }) => (
            <li className="bg-card p-5 sm:p-6" data-protection="aws" key={title}>
              <span className="grid h-9 w-9 place-items-center border border-border-strong text-foreground rounded-md">
                <Icon aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
              </span>
              <h3 className="mt-4 text-[15px] font-medium text-foreground">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
            </li>
          ))}
        </ul>

        <figure aria-labelledby="aws-architecture-title" className="mt-6 overflow-hidden border border-border bg-card rounded-xl">
          <figcaption id="aws-architecture-title" className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-5 py-4">
            <span className="text-[15px] font-medium text-foreground">How a request travels</span>
            <span className="text-[13px] text-muted-foreground">From untrusted text to an approved action on the ledger</span>
          </figcaption>
          <p className="sr-only">
            Untrusted data passes through Bedrock Guardrails and a selected Bedrock model, then Harbor policy, before
            an approved action reaches XRPL Testnet.
          </p>
          <ol className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-5" aria-label="AWS trust path">
            {architectureStages.map((stage, index) => (
              <li className="flex items-baseline justify-between gap-2 bg-card px-5 py-4" key={stage}>
                <span className="flex items-baseline gap-2.5 whitespace-nowrap">
                  <span className="font-mono text-[15px] leading-none tabular-nums text-muted-foreground">0{index + 1}</span>
                  <span className="text-[15px] leading-none text-foreground">{stage}</span>
                </span>
                {index < architectureStages.length - 1 ? (
                  <ArrowRight aria-hidden="true" className="hidden h-3.5 w-3.5 shrink-0 self-center text-muted-foreground lg:block" />
                ) : null}
              </li>
            ))}
          </ol>
        </figure>
      </div>
    </section>
  );
}
