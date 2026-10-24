"use client";

import { ArrowRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import React from "react";

import {
  formatMetric,
  type AnalyticsSnapshot,
} from "./analytics-panels";

const label = "font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground";

function usableEstimate(
  quote: AnalyticsSnapshot["liquidity"][number],
): boolean {
  return quote.available &&
    typeof quote.estimatedOutput === "number" &&
    Number.isFinite(quote.estimatedOutput) &&
    typeof quote.averagePrice === "number" &&
    Number.isFinite(quote.averagePrice);
}

/**
 * Compact, read-only handoff from Markets into Pilot's existing conversation.
 *
 * This component never builds, signs, or submits a transaction. The `/chat`
 * route is owned by the persistent harness host; after harness integration it
 * expands the same mounted ChatView and therefore reuses its policy and owner-
 * approval path instead of creating a second execution surface.
 */
export function TerminalTradePreview({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const availableEstimateCount = snapshot.liquidity.filter(usableEstimate).length;
  const approvalEligible = snapshot.provenance.mode === "live" &&
    snapshot.provenance.network !== "mainnet" && availableEstimateCount > 0;

  return (
    <section className="border border-border bg-card" aria-labelledby="terminal-trade-preview-title">
      <header className="border-b border-border bg-sidebar/40 px-4 py-3">
        <p className={label}>Bounded preview</p>
        <h2 id="terminal-trade-preview-title" className="mt-1 text-sm font-semibold text-foreground">
          Trade preview
        </h2>
      </header>

      <div className="space-y-4 px-4 py-4">
        {snapshot.liquidity.length ? (
          <dl className="divide-y divide-border" aria-label="Read-only executable estimates">
            {snapshot.liquidity.map((quote) => {
              const available = usableEstimate(quote);
              return (
                <div key={quote.id} className="grid grid-cols-[1fr_auto] gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <dt className={label}>Sell base</dt>
                    <dd className="mt-1 truncate font-mono text-xs tabular-nums text-foreground">
                      {formatMetric(quote.inputAmount, 4)} {snapshot.base.symbol}
                    </dd>
                  </div>
                  <div className="min-w-0 text-right">
                    <dt className={label}>Estimated output</dt>
                    <dd className="mt-1 truncate font-mono text-xs tabular-nums text-foreground">
                      {available ? `${formatMetric(quote.estimatedOutput, 4)} ${snapshot.quote.symbol}` : "Unavailable"}
                    </dd>
                  </div>
                  <p className="col-span-2 font-mono text-[10px] leading-5 text-muted-foreground">
                    {available
                      ? <>{formatMetric(quote.averagePrice, 6)} {snapshot.priceUnit}{typeof quote.priceImpactBps === "number" && Number.isFinite(quote.priceImpactBps) ? ` · ${formatMetric(quote.priceImpactBps, 1)} bps observed impact` : " · impact unavailable"}</>
                      : quote.reason ?? "The bounded depth read did not cover this size."}
                  </p>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className="text-sm leading-6 text-muted-foreground">
            No quote sizes requested or no bounded executable estimate is available from the current depth read.
          </p>
        )}

        <div className="border-t border-border pt-4">
          <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
            Estimates are observations, not reserved quotes. Pilot rebuilds and policy-checks any requested action before its existing approval flow.
          </p>
          {approvalEligible ? (
            <Link
              href="/chat"
              className="bracket bracket-light mt-4 inline-flex h-10 w-full items-center justify-center gap-2 border border-border bg-foreground px-4 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-background transition hover:bg-foreground/90"
            >
              Review in workspace chat
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ) : (
            <p className="mt-4 border border-border bg-sidebar/30 px-3 py-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              {snapshot.provenance.mode === "demo"
                ? "Illustrative fixture · no approval path"
                : snapshot.provenance.network === "mainnet"
                  ? "Mainnet observation · signing disabled"
                  : "No executable estimate · approval entry unavailable"}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
