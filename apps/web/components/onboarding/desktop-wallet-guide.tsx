"use client";

import { ExternalLink, MonitorSmartphone, ShieldCheck } from "lucide-react";
import * as React from "react";

export const GEMWALLET_SETUP_URL = "https://gemwallet.app/docs/user-guide/getting-started";
export const CROSSMARK_SETUP_URL =
  "https://support.crossmark.io/getting-started/get-started-with-crossmark";

const linkClass =
  "inline-flex h-9 items-center gap-2 border border-border-strong bg-card px-3 text-[13px] font-medium transition hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md";

export function DesktopWalletGuide({ smallScreen = false }: { smallScreen?: boolean }) {
  return (
    <section aria-labelledby="desktop-wallet-guide-title" className="space-y-3">
      {smallScreen ? (
        <aside aria-label="Wallets on phones" className="flex items-start gap-3 border border-approval/35 bg-approval/[0.06] p-4 rounded-xl">
          <MonitorSmartphone aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-approval" />
          <div>
            <p className="text-sm font-medium">Connect your wallet from a computer</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Wallet extensions run in a desktop browser. On your phone you can still look around Pilot.
            </p>
            <a className="mt-2 inline-flex text-[13px] font-medium text-foreground underline underline-offset-4" href="/chat">
              Look around Pilot
            </a>
          </div>
        </aside>
      ) : null}

      <div className="flex flex-col gap-3 border border-border bg-background/60 p-4 sm:flex-row sm:items-center sm:justify-between rounded-xl">
        <div className="min-w-0">
          <h3 className="text-sm font-medium" id="desktop-wallet-guide-title">Don’t have a wallet yet?</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">I already have a wallet, or I need a wallet: use GemWallet (recommended) or Crossmark. Account creation, import, and recovery stay inside the wallet extension. Switch the wallet to XRPL Testnet before connecting.</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <a className={linkClass} href={GEMWALLET_SETUP_URL} rel="noreferrer" target="_blank">
            GemWallet setup · recommended <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
          </a>
          <a className={linkClass} href={CROSSMARK_SETUP_URL} rel="noreferrer" target="_blank">
            Crossmark setup · alternative <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
          </a>
        </div>
      </div>

      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground" role="note">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" />
        Pilot never asks for a seed phrase, recovery phrase, mnemonic, or private key. Those stay in your wallet.
      </p>
      <aside aria-label="Mobile wallet availability" className="border border-border bg-surface p-3 text-xs leading-5 text-muted-foreground rounded-xl">
        Mobile wallet actions are not available yet, and Xaman remains unavailable for this non-broadcast wallet-auth proof. You can still <a className="underline underline-offset-4" href="/chat">Continue to read-only Pilot</a>.
      </aside>
    </section>
  );
}
