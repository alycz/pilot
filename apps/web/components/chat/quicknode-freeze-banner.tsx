import { ExternalLink, ShieldAlert } from "lucide-react";
import Link from "next/link";
import React from "react";

import type { QuickNodeFreezeNotice } from "./stream-parts";
import { xrplTestnetTransactionUrl } from "../../lib/xrpl-explorer";

export function QuickNodeFreezeBanner({
  notices,
  realLedgerReceipt = false,
}: {
  notices: readonly QuickNodeFreezeNotice[];
  realLedgerReceipt?: boolean;
}) {
  const notice = notices.at(-1);
  if (!notice) return null;

  const explorerUrl = realLedgerReceipt ? xrplTestnetTransactionUrl(notice.tx_hash) : undefined;
  return (
    <section
      aria-label="QuickNode Streams freeze notice"
      className="border border-destructive/30 bg-destructive/[0.06] px-4 py-3 text-foreground"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center border border-destructive/30 bg-destructive/10 text-destructive">
          <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-5">
            QuickNode Streams detected a transaction signed with your agent&apos;s key outside Harbor (ledger {notice.ledger_index.toLocaleString("en-US")}). Harbor froze the agent.
          </p>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            The Harbor freeze prevents further agent execution. Revoke the delegation on-ledger to stop the key everywhere.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              className="inline-flex h-9 items-center justify-center border border-destructive/40 px-3 font-mono text-[11px] font-medium uppercase tracking-wide text-destructive transition hover:bg-destructive/10 pointer-coarse:h-11 pointer-coarse:min-w-11"
              href="/onboarding?action=revoke"
            >
              Revoke on-ledger
            </Link>
            {explorerUrl ? <a
              className="inline-flex h-9 items-center justify-center gap-1.5 border border-border-strong px-3 font-mono text-[11px] font-medium uppercase tracking-wide text-foreground transition hover:bg-surface pointer-coarse:h-11 pointer-coarse:min-w-11"
              href={explorerUrl}
              rel="noreferrer"
              target="_blank"
            >
              View transaction <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
