"use client";

import { ExternalLink, MonitorSmartphone, ShieldCheck, WalletCards } from "lucide-react";
import * as React from "react";

export const GEMWALLET_SETUP_URL = "https://gemwallet.app/docs/user-guide/getting-started";
export const CROSSMARK_SETUP_URL =
  "https://support.crossmark.io/getting-started/get-started-with-crossmark";

export function DesktopWalletGuide() {
  return (
    <section aria-labelledby="desktop-wallet-guide-title" className="space-y-4">
      <div>
        <p className="label-mono">Desktop wallet setup</p>
        <h3 className="mt-2 text-base font-medium" id="desktop-wallet-guide-title">
          Choose how you want to start
        </h3>
      </div>

      <div className="grid gap-px border border-border bg-border md:grid-cols-2">
        <article className="bg-card p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <WalletCards aria-hidden="true" className="size-4 text-primary" />
            I already have a wallet
          </p>
          <ol className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
            <li><span className="font-mono text-foreground">1.</span> Open and unlock GemWallet (recommended) or Crossmark in a supported desktop browser.</li>
            <li><span className="font-mono text-foreground">2.</span> Switch the wallet to XRPL Testnet and select the account you want to use as Pilot's budget account.</li>
            <li><span className="font-mono text-foreground">3.</span> Return here, choose that provider, and authenticate the selected account.</li>
          </ol>
        </article>

        <article className="bg-card p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <ExternalLink aria-hidden="true" className="size-4 text-primary" />
            I need a wallet
          </p>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Follow the wallet provider's official setup guide. Create or import the account inside the wallet extension, then switch it to XRPL Testnet before returning to Pilot.
          </p>
          <div className="mt-3 grid gap-2">
            <a
              className="inline-flex min-h-10 items-center justify-between gap-2 border border-border-strong px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-wide transition hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              href={GEMWALLET_SETUP_URL}
              rel="noreferrer"
              target="_blank"
            >
              GemWallet setup · recommended <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
            </a>
            <a
              className="inline-flex min-h-10 items-center justify-between gap-2 border border-border-strong px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-wide transition hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              href={CROSSMARK_SETUP_URL}
              rel="noreferrer"
              target="_blank"
            >
              Crossmark setup · alternative <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
            </a>
          </div>
        </article>
      </div>

      <div className="flex items-start gap-3 border border-executed/30 bg-executed/10 p-4" role="note">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" />
        <div>
          <p className="text-sm font-medium">Keep wallet recovery material private</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Pilot never asks for a seed phrase, recovery phrase, mnemonic, or private key. Account creation, import, and recovery stay inside the wallet extension.
          </p>
        </div>
      </div>

      <aside aria-label="Mobile wallet availability" className="flex items-start gap-3 border border-approval/35 bg-approval/[0.06] p-4">
        <MonitorSmartphone aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-approval" />
        <div>
          <p className="text-sm font-medium">Wallet connection currently requires a desktop extension</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            GemWallet and Crossmark are desktop-browser paths. Mobile wallet actions are not available yet, and Xaman remains unavailable because Pilot cannot safely use it for the non-broadcast wallet-auth proof.
          </p>
          <a className="mt-2 inline-flex font-mono text-[11px] font-medium uppercase tracking-wide text-foreground underline underline-offset-4" href="/chat">
            Continue to read-only Pilot
          </a>
        </div>
      </aside>
    </section>
  );
}
