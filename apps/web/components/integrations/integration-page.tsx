import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";

import { LandingBrand, LaunchButton } from "@/components/landing/landing-nav";

import { IntegrationJourney } from "./integration-journey";
import { IntegrationsMenu } from "./integrations-menu";
import type { IntegrationExplainer } from "./types";

const accentBorder: Record<IntegrationExplainer["accent"], string> = {
  coral: "border-primary/50 text-primary",
  orange: "border-approval/50 text-approval",
  blue: "border-info/50 text-info",
  graphite: "border-foreground/40 text-foreground",
};

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
        <p className="label-mono">{eyebrow}</p>
        <h2 className="mt-3 max-w-3xl text-balance text-2xl font-normal tracking-[-0.02em] text-foreground sm:text-[1.75rem]">
          {title}
        </h2>
        <div className="mt-9">{children}</div>
      </div>
    </section>
  );
}

export function IntegrationPage({ explainer }: { explainer: IntegrationExplainer }) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[60] -translate-y-24 bg-primary px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-primary-foreground transition focus:translate-y-0"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-background/92 backdrop-blur-md">
        <div className="mx-auto flex min-h-14 max-w-6xl items-center gap-3 px-4 sm:px-6 lg:min-h-16 lg:px-8">
          <LandingBrand />
          <div className="ml-auto flex items-center gap-1 sm:gap-3">
            <Link
              href="/"
              className="hidden min-h-11 items-center gap-1.5 px-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground sm:inline-flex"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Home
            </Link>
            <IntegrationsMenu current={explainer.slug} />
            <LaunchButton className="hidden sm:inline-flex" />
          </div>
        </div>
      </header>

      <main id="main-content">
        <section className="relative overflow-hidden border-b border-border">
          <div aria-hidden="true" className="bg-rules pointer-events-none absolute inset-0" />
          <div className="relative mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8 lg:py-24">
            <div className="grid items-end gap-10 lg:grid-cols-[1.25fr_0.75fr]">
              <div>
                <div className="flex flex-wrap gap-2">
                  <span className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-wide ${accentBorder[explainer.accent]}`}>
                    {explainer.name}
                  </span>
                  <span className="border border-border-strong bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                    Public read-only explainer
                  </span>
                </div>
                <p className="label-mono mt-7">{explainer.eyebrow}</p>
                <h1 className="mt-4 max-w-4xl text-balance text-[2.25rem] font-normal leading-[1.06] tracking-[-0.035em] text-foreground sm:text-5xl lg:text-[3.5rem]">
                  {explainer.headline}
                </h1>
                <p className="mt-6 max-w-3xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
                  {explainer.summary}
                </p>
              </div>
              <aside className="bracket bracket-accent border border-border-strong bg-card p-5 sm:p-6" aria-label="Implementation status">
                <div className="flex items-center gap-2 text-foreground">
                  <Eye className="h-4 w-4 text-primary" aria-hidden="true" />
                  <h2 className="font-mono text-[11px] uppercase tracking-wide">Truthful status</h2>
                </div>
                <p className="mt-4 text-sm leading-6 text-muted-foreground">{explainer.status}</p>
                <p className="mt-4 border-t border-border pt-4 font-mono text-[10px] uppercase leading-5 tracking-wide text-foreground">
                  {explainer.truthLabel}
                </p>
              </aside>
            </div>
          </div>
        </section>

        <Section eyebrow="Purpose" title={`What ${explainer.name} does inside Pilot`}>
          <div className="grid gap-px border border-border bg-border md:grid-cols-2">
            <article className="bg-card p-5 sm:p-7">
              <p className="label-mono">What we use it for</p>
              <p className="mt-4 text-sm leading-7 text-foreground">{explainer.what}</p>
            </article>
            <article className="bg-card p-5 sm:p-7">
              <p className="label-mono">Why it matters</p>
              <p className="mt-4 text-sm leading-7 text-foreground">{explainer.why}</p>
            </article>
          </div>
        </Section>

        <Section eyebrow="Walkthrough" title="Follow the backend path, one boundary at a time">
          <IntegrationJourney explainer={explainer} />
        </Section>

        <Section eyebrow="Product impact" title={`How ${explainer.name} makes Pilot stronger`}>
          <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {explainer.enhancements.map((enhancement) => (
              <div key={enhancement} className="flex gap-3 bg-card p-5">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-executed" aria-hidden="true" />
                <p className="text-sm leading-6 text-foreground">{enhancement}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section eyebrow="Boundaries" title="What the integration can—and cannot—claim">
          <div className="grid gap-5 lg:grid-cols-2">
            <article className="border border-executed/35 bg-executed/[0.04] p-5 sm:p-7">
              <div className="flex items-center gap-2 text-executed">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                <h3 className="font-mono text-[11px] uppercase tracking-wide">This demonstrates</h3>
              </div>
              <ul className="mt-5 space-y-3">
                {explainer.demonstrates.map((item) => (
                  <li key={item} className="flex gap-3 text-sm leading-6 text-foreground">
                    <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-executed" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
            <article className="border border-blocked/30 bg-blocked/[0.035] p-5 sm:p-7">
              <div className="flex items-center gap-2 text-blocked">
                <X className="h-4 w-4" aria-hidden="true" />
                <h3 className="font-mono text-[11px] uppercase tracking-wide">This does not demonstrate</h3>
              </div>
              <ul className="mt-5 space-y-3">
                {explainer.doesNotDemonstrate.map((item) => (
                  <li key={item} className="flex gap-3 text-sm leading-6 text-foreground">
                    <X className="mt-1 h-3.5 w-3.5 shrink-0 text-blocked" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          </div>

          <div className="mt-8 grid gap-px border border-border bg-border md:grid-cols-2">
            {explainer.boundaries.map((boundary) => (
              <article key={boundary.title} className="bg-card p-5">
                <h3 className="text-sm font-medium text-foreground">{boundary.title}</h3>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{boundary.body}</p>
              </article>
            ))}
          </div>
        </Section>

        <Section eyebrow="Provenance" title="Grounded in the implementation, not a concept slide">
          <div className="border border-border bg-card">
            {explainer.sources.map((source) => (
              <div key={`${source.label}-${source.path}`} className="grid gap-2 border-b border-border px-4 py-4 last:border-b-0 sm:grid-cols-[1fr_1.3fr] sm:px-5">
                <p className="text-sm text-foreground">{source.label}</p>
                <code className="[overflow-wrap:anywhere] font-mono text-[11px] leading-5 text-muted-foreground">{source.path}</code>
              </div>
            ))}
          </div>
        </Section>

        <section className="border-b border-border">
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-5 px-4 py-12 sm:px-6 md:flex-row md:items-center lg:px-8">
            <div>
              <p className="label-mono">Keep exploring</p>
              <p className="mt-2 text-lg text-foreground">Compare this boundary with the other Pilot integrations.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <IntegrationsMenu current={explainer.slug} align="start" />
              <Link href="/chat" className="bracket bracket-light inline-flex h-11 items-center gap-2 bg-foreground px-4 font-mono text-[11px] uppercase tracking-wide text-background">
                Launch workspace <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 font-mono text-[10px] uppercase tracking-wide text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <span>Pilot integration explainer</span>
        <span>Read-only · no provider calls · no transaction actions</span>
      </footer>
    </div>
  );
}
