import type { Metadata } from "next";

import {
  NearIntentsFixtureDemo,
  NearIntentsLivePreview,
  NearNativeLiveOwnerFlow,
  NearNativeOwnerApprovalWorkspace,
} from "@/components/near";
import { LandingBrand, LandingNav } from "@/components/landing/landing-nav";
import { createNearNativeOwnerApprovalFixture } from "@/lib/near-native-owner-approval";
import { resolveNearConnectAdapterStatus } from "@/lib/near-connect-adapter";

export const metadata: Metadata = {
  title: "NEAR Intents fixture | Pilot",
  description: "Review Pilot's NEAR Intents discovery, executable-review, and local evidence boundaries.",
};

export default async function NearIntentsDemoPage() {
  const walletAdapterEnabled =
    process.env.PILOT_NEAR_BROWSER_WALLET_ADAPTER_ENABLED === "true";
  const executableReviewEnabled =
    process.env.PILOT_NEAR_INTENTS_EXECUTABLE_REVIEW_ENABLED === "true";
  const principalBootstrapEnabled =
    process.env.PILOT_NEAR_PRINCIPAL_BOOTSTRAP_ENABLED === "true";
  const ownerApprovalEnabled =
    process.env.PILOT_NEAR_OWNER_FUNDED_APPROVAL_ENABLED === "true";
  const nativeOwnerApprovalReview = await createNearNativeOwnerApprovalFixture();
  const walletAdapterStatus = resolveNearConnectAdapterStatus(walletAdapterEnabled);
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <LandingNav current="near-intents" />
      <main>
        <section className="border-b border-border">
          <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
            <p className="label-mono">Integration fixture / NEAR Intents</p>
            <h1 className="mt-4 max-w-3xl text-balance text-3xl font-semibold tracking-[-0.03em] font-display sm:text-4xl">Trace the boundary before any value moves.</h1>
            <p className="mt-4 max-w-2xl text-[15px] leading-7 text-muted-foreground">This walkthrough separates user-triggered live provider calls from deterministic local evidence. Pilot transaction signing and broadcast remain disabled; external owner manual funding is exposed only after a durable reservation.</p>
            <div className="mt-8 space-y-8">
              <NearIntentsLivePreview
                executableReviewEnabled={executableReviewEnabled}
              />
              <div>
                <p className="label-mono">Live owner-control and economic approval</p>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">The live route below requires the default-off browser-wallet, executable-review, principal-bootstrap, and owner-approval gates plus an active Pilot wallet session. Every server gate remains independently authoritative.</p>
                <div className="mt-4">
                  <NearNativeLiveOwnerFlow
                    gates={{
                      browserWallet: walletAdapterEnabled,
                      executableReview: executableReviewEnabled,
                      principalBootstrap: principalBootstrapEnabled,
                      ownerApproval: ownerApprovalEnabled,
                    }}
                  />
                </div>
              </div>
              <div>
                <p className="label-mono">Separate local owner-control fixture</p>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">The review below models the chosen native-NEAR funding route without opening a wallet or requesting a live executable quote.</p>
                <div className="mt-4">
                  <NearNativeOwnerApprovalWorkspace
                    review={nativeOwnerApprovalReview}
                    adapterStatus={walletAdapterStatus}
                  />
                </div>
              </div>
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
        <p className="label-mono">Pilot signing/broadcast disabled · owner manual funding only after reservation</p>
      </footer>
    </div>
  );
}
