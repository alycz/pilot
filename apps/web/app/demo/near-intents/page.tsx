import type { Metadata } from "next";
import { createHash } from "node:crypto";

import { NearIntentsFixtureDemo, NearIntentsLivePreview } from "@/components/near";
import { LandingBrand, LandingNav } from "@/components/landing/landing-nav";
import type { NearApprovalReview } from "@/lib/near-approval";

export const metadata: Metadata = {
  title: "NEAR Intents fixture | Pilot",
  description: "Review Pilot's fixture-only NEAR Intents discovery and approval path.",
};

const fixtureRows = Object.freeze([
  { label: "Principal", value: "fixture-principal", exact: true },
  { label: "Wallet account", value: "fixture-recipient.near", exact: true },
  { label: "Network", value: "near:mainnet", exact: true },
  { label: "Input asset ID", value: "nep141:wrap.near", exact: true },
  { label: "Input atomic amount", value: "1000000000000000000000000", exact: true },
  { label: "Output asset ID", value: "nep141:usdt.tether-token.near", exact: true },
  { label: "Minimum output atomic amount", value: "990000", exact: true },
  { label: "Recipient", value: "fixture-recipient.near", exact: true },
  { label: "Refund address", value: "fixture-refund.near", exact: true },
  { label: "Fixture quote ID", value: "local_fixture_near_intents_demo", exact: true },
] as const);

const fixtureReview: NearApprovalReview = Object.freeze({
  readiness: "signing-disabled",
  canSign: false,
  notice: "NEAR execution signing is disabled. This preview is local fixture data, not a verified executable quote.",
  rows: fixtureRows,
  approvalDigest: createHash("sha256")
    .update("pilot.near-intents.fixture-preview.v1\0")
    .update(JSON.stringify(fixtureRows))
    .digest("hex")
    .toUpperCase(),
});

export default async function NearIntentsDemoPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <LandingNav current="near-intents" />
      <main>
        <section className="border-b border-border">
          <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
            <p className="label-mono">Integration fixture / NEAR Intents</p>
            <h1 className="mt-4 max-w-3xl text-balance text-3xl font-semibold tracking-[-0.03em] font-display sm:text-4xl">Trace the boundary before any value moves.</h1>
            <p className="mt-4 max-w-2xl text-[15px] leading-7 text-muted-foreground">This local walkthrough shows discovery, a dry quote, an exact approval preview, and pending status. It makes no 1Click request and cannot sign, deposit, or settle.</p>
            <div className="mt-8 space-y-8">
              <NearIntentsLivePreview />
              <div>
                <p className="label-mono">Separate local evidence</p>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">The walkthrough below never replaces the provider-connected result above. Use it only to inspect Pilot&apos;s disabled approval and status states.</p>
                <div className="mt-4"><NearIntentsFixtureDemo review={fixtureReview} /></div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8">
        <LandingBrand />
        <p className="label-mono">Fixture only · execution disabled</p>
      </footer>
    </div>
  );
}
