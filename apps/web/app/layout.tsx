import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

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
  colorScheme: "dark",
  themeColor: "#090d12",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
