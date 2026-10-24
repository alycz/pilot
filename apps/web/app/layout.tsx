import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import { DelegationLifecycleGuard } from "@/components/shell/delegation-lifecycle-guard";

import "./globals.css";

const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export const runtime = "nodejs";
export const maxDuration = 300;

export const metadata: Metadata = {
  title: {
    default: "Workspace",
    template: "%s | Workspace",
  },
  description: "A keyless XRPL workspace for planning, approvals, and execution.",
  applicationName: "Workspace",
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f4f3ef",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        {children}
        <DelegationLifecycleGuard />
      </body>
    </html>
  );
}
