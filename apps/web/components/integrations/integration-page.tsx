import { ArrowRight, ArrowUpRight, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { LandingBrand, LandingNav } from "@/components/landing/landing-nav";

import { integrationStories } from "./content/stories";
import { IntegrationFlow } from "./integration-flow";
import { integrationLinks } from "./integration-links";
import type { IntegrationExplainer } from "./types";

function Section({ id, eyebrow, title, lede, children }: { id: string; eyebrow: string; title: string; lede?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="border-b border-border">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <p className="label-mono">{eyebrow}</p>
        <h2 id={`${id}-title`} className="mt-3 max-w-3xl text-balance text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-[2rem] font-display">
          {title}
        </h2>
        {lede ? <p className="mt-3 max-w-2xl text-[15px] leading-7 text-muted-foreground">{lede}</p> : null}
        <div className="mt-8">{children}</div>
      </div>
    </section>
  );
}

export function IntegrationPage({ explainer }: { explainer: IntegrationExplainer }) {
  const story = integrationStories[explainer.slug];
  const others = integrationLinks.filter((link) => link.slug !== explainer.slug);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[60] -translate-y-24 bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition focus:translate-y-0"
      >
        Skip to content
      </a>
      <LandingNav current={explainer.slug} />

      <main id="main-content">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-border">
          <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.85fr)] lg:items-end lg:px-8 lg:py-20">
            <div>
              <p className="label-mono">
                Integrations
                <span aria-hidden="true"> / </span>
                <span className="text-foreground">{explainer.name}</span>
              </p>
              <h1 className="mt-5 max-w-3xl text-balance text-[2.125rem] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground sm:text-[2.75rem] lg:text-[3.25rem] font-display">
                {story.title}
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-7 text-muted-foreground sm:text-[17px] sm:leading-8">{story.lede}</p>
            </div>

            <aside aria-label="At a glance" className="bracket border border-border-strong bg-card rounded-xl">
              <p className="label-mono border-b border-border px-5 py-3">At a glance</p>
              <dl className="divide-y divide-border">
                {[
                  { term: "What it adds", value: story.glance.adds },
                  { term: "Who stays in control", value: story.glance.control },
                  { term: "Status today", value: story.glance.status },
                ].map((row) => (
                  <div key={row.term} className="px-5 py-4">
                    <dt className="label-mono">{row.term}</dt>
                    <dd className="mt-1.5 text-sm leading-6 text-foreground">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </aside>
          </div>
        </section>

        {/* How it works */}
        <Section
          id="how"
          eyebrow="How it works"
          title="Watch a request go through it."
          lede="The square is the request. Follow it from part to part, read what happens below, and pick an outcome to see what happens when things pass, need you, or stop."
        >
          <IntegrationFlow story={story} name={explainer.name} />
        </Section>

        {/* The idea */}
        <Section id="idea" eyebrow="Why it matters" title="What changes with it, and what never does.">
          <div className="grid gap-px border border-border bg-border md:grid-cols-3 rounded-xl overflow-hidden">
            {[
              { label: "Without it", text: story.idea.without, icon: TriangleAlert, tone: "text-approval" },
              { label: "With it", text: story.idea.with, icon: Sparkles, tone: "text-primary" },
              { label: "What never changes", text: story.idea.never, icon: ShieldCheck, tone: "text-executed" },
            ].map(({ label, text, icon: Icon, tone }) => (
              <article key={label} className="bg-card p-5 sm:p-6">
                <p className="flex items-center gap-2 text-[13px] text-foreground">
                  <Icon className={`size-4 ${tone}`} aria-hidden="true" />
                  {label}
                </p>
                <p className="mt-3 text-[15px] leading-7 text-muted-foreground">{text}</p>
              </article>
            ))}
          </div>
        </Section>

        {/* Other integrations */}
        <section aria-labelledby="more-title" className="border-b border-border">
          <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="label-mono">Keep exploring</p>
                <h2 id="more-title" className="mt-2 text-xl font-normal tracking-[-0.01em] text-foreground">Other integrations</h2>
              </div>
              <Link href="/chat" className="bracket bracket-light inline-flex h-11 items-center gap-2 bg-primary px-4 text-[13px] text-primary-foreground rounded-md">
                Launch Pilot <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
            <ul className="mt-6 grid gap-px border border-border bg-border sm:grid-cols-3 rounded-xl overflow-hidden">
              {others.map((link) => (
                <li key={link.slug}>
                  <Link href={link.href} className="group flex h-full items-start justify-between gap-3 bg-card p-5 transition hover:bg-primary-soft">
                    <span>
                      <span className="block text-[15px] text-foreground">{link.label}</span>
                      <span className="label-mono mt-1 block">{link.detail}</span>
                    </span>
                    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition group-hover:text-foreground" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8">
        <LandingBrand />
        <p className="label-mono">Explainer only · no provider calls · no transactions</p>
      </footer>
    </div>
  );
}
