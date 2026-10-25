import { ArrowUpRight, BookOpenText } from "lucide-react";
import type { Metadata } from "next";

import { LandingNav } from "@/components/landing/landing-nav";

export const metadata: Metadata = {
  title: "Docs — Pilot",
  description: "Documentation for the Pilot MCP and API, trading harness and integrations.",
};

const SOURCE_URL = "https://github.com/alycz/pilot/tree/main/docs-site";

/**
 * Shown only when PILOT_DOCS_ORIGIN is unset. When it is set, next.config.ts
 * rewrites /docs to the deployed docs site before this page is matched.
 */
export default function DocsFallbackPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <LandingNav />
      <main id="main-content" className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <p className="label-mono">Docs</p>
        <h1 className="mt-4 text-balance text-[2.125rem] font-semibold leading-[1.08] tracking-[-0.035em] sm:text-[2.75rem] font-display">
          Pilot documentation
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
          The docs cover what the Pilot MCP and API are, how to connect an AI client, the trading harness, and every
          integration. They are not connected to this deployment yet.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a
            href={SOURCE_URL}
            className="bracket bracket-light inline-flex h-10 items-center gap-2 border border-border-strong px-4 text-[13px] text-foreground transition hover:bg-white/[0.08] rounded-md"
          >
            <BookOpenText className="h-4 w-4" aria-hidden="true" />
            Read the source on GitHub
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
        <p className="mt-10 border-t border-border pt-6 text-[13px] leading-6 text-muted-foreground">
          Operators: deploy <code>docs-site/</code> and set <code>PILOT_DOCS_ORIGIN</code> to its HTTPS origin. Pilot
          then serves the docs at <code>/docs</code>.
        </p>
      </main>
    </div>
  );
}
