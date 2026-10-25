import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import { BacktestSessionLifecycleGuard } from "@/components/backtests/integration/client/session-lifecycle-guard";
import { HarnessChatHost } from "@/components/harness-chat";
import { DelegationLifecycleGuard } from "@/components/shell/delegation-lifecycle-guard";

import "./globals.css";
import "../components/harness-chat/harness-chat.css";

const inter = localFont({
  src: "./fonts/Inter-Variable.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

const newsreader = localFont({
  src: "./fonts/Newsreader-Variable.woff2",
  variable: "--font-newsreader",
  weight: "400 600",
  display: "swap",
});

const fragmentMono = localFont({
  src: "./fonts/FragmentMono-400.woff2",
  variable: "--font-fragment-mono",
  weight: "400",
  display: "swap",
});

export const runtime = "nodejs";
export const maxDuration = 300;

export const metadata: Metadata = {
  title: {
    default: "Pilot",
    template: "%s | Pilot",
  },
  description: "A keyless XRPL copilot for planning, approvals, and execution.",
  applicationName: "Pilot",
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f3f1eb",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${newsreader.variable} ${fragmentMono.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <HarnessChatHost>{children}</HarnessChatHost>
        <BacktestSessionLifecycleGuard />
        <DelegationLifecycleGuard />
      </body>
    </html>
  );
}
