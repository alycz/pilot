import type { Metadata } from "next";

import { NearIntentsFixtureDemo, NearIntentsLivePreview } from "@/components/near";
import { LandingBrand, LandingNav } from "@/components/landing/landing-nav";
import { computeNearApprovalDigest, type NearApprovalBinding } from "@pilot/contracts";
import { reviewNearIntentsApproval } from "@/lib/near-approval";

export const metadata: Metadata = {
  title: "NEAR Intents fixture | Pilot",
  description: "Review Pilot's fixture-only NEAR Intents discovery and approval path.",
};

const fixtureBinding: NearApprovalBinding = {
  version: "pilot-near-1click-approval-v2",
  principal_id: "fixture-principal",
  account_id: "fixture-recipient.near",
  network: "near:mainnet",
  idempotency_version: "pilot-near-idempotency-v1",
  idempotency_key: "fixture-near-intents-review",
  policy_digest: "A".repeat(64),
  quote_id: "local_fixture_near_intents_demo",
  quote_hash: "B".repeat(44),
  provider_signature_verified: true,
  origin_asset: "nep141:wrap.near",
  destination_asset: "nep141:usdt.tether-token.near",
  amount_in: "1000000000000000000000000",
  min_amount_out: "990000",
  recipient: "fixture-recipient.near",
  refund_to: "fixture-refund.near",
  deposit_address: "fixture-provider-deposit-address",
  deposit_memo: "fixture-routing-memo",
  approval_expires_at: "2099-01-02T00:00:00.000Z",
  provider_deadline_at: "2099-01-03T00:00:00.000Z",
};

export default async function NearIntentsDemoPage() {
  const review = await reviewNearIntentsApproval({
    binding: fixtureBinding,
    approvalDigest: await computeNearApprovalDigest(fixtureBinding),
    signingEnabled: false,
    now: Date.parse("2098-01-01T00:00:00.000Z"),
  });

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
                <div className="mt-4"><NearIntentsFixtureDemo review={review} /></div>
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
