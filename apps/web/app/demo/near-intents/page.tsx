import type { Metadata } from "next";

import { NearIntentsFixtureDemo, NearIntentsLivePreview } from "@/components/near";
import { LandingBrand, LandingNav } from "@/components/landing/landing-nav";

export const metadata: Metadata = {
  title: "NEAR Intents fixture | Pilot",
  description: "Review Pilot's NEAR Intents discovery, executable-review, and local evidence boundaries.",
};

export default async function NearIntentsDemoPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <LandingNav current="near-intents" />
      <main>
        <section className="border-b border-border">
          <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
            <p className="label-mono">Integration fixture / NEAR Intents</p>
            <h1 className="mt-4 max-w-3xl text-balance text-3xl font-semibold tracking-[-0.03em] font-display sm:text-4xl">Trace the boundary before any value moves.</h1>
            <p className="mt-4 max-w-2xl text-[15px] leading-7 text-muted-foreground">This walkthrough separates user-triggered live provider calls from deterministic local evidence. Execution, funding, signing, and settlement remain disabled.</p>
            <div className="mt-8 space-y-8">
              <NearIntentsLivePreview
                executableReviewEnabled={
                  process.env.PILOT_NEAR_INTENTS_EXECUTABLE_REVIEW_ENABLED === "true"
                }
              />
              <div>
                <p className="label-mono">Separate local evidence</p>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">The walkthrough below never replaces the provider-connected result above. Use it only to inspect Pilot&apos;s disabled executable-review, manual owner-funding, reconciliation, and evidence boundaries.</p>
                <div className="mt-4"><NearIntentsFixtureDemo /></div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8">
        <LandingBrand />
        <p className="label-mono">Execution disabled · manual funding blocked</p>
      </footer>
    </div>
  );
}
