import { RadioTower } from "lucide-react";
import React from "react";

import type { QuickNodeStatus } from "./portfolio-data";

export function QuickNodePanel({
  status,
}: {
  status: QuickNodeStatus | null | undefined;
}) {
  const state = status === undefined
    ? "Loading"
    : status === null
      ? "Unavailable"
      : status.mode === "mock"
        ? "Mock"
        : status.mode === "live"
          ? "Live"
          : "Off";
  const rows = status
    ? [
        ["XRPL calls via QuickNode", `${Math.round(status.rpc.share * 100)}%`],
        ["Webhook confirmations", status.webhook.confirmations.toLocaleString("en-US")],
        ["Ledgers watched", status.watchdog.ledgers_seen.toLocaleString("en-US")],
        [
          "Last watchdog event",
          status.watchdog.events > 0 && status.watchdog.last_ledger !== null
            ? `Ledger ${status.watchdog.last_ledger.toLocaleString("en-US")}`
            : "None observed",
        ],
        [
          "Frozen",
          status.watchdog.frozen_count > 0
            ? `${status.watchdog.frozen_count.toLocaleString("en-US")} agent${status.watchdog.frozen_count === 1 ? "" : "s"}`
            : "No frozen agents",
        ],
      ]
    : [];

  return (
    <section aria-labelledby="quicknode-status-title" className="border border-border bg-card">
      <div className="flex h-12 items-center gap-2.5 border-b border-border px-4 sm:px-5">
        <RadioTower aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        <h2 id="quicknode-status-title" className="text-sm font-medium tracking-tight">QuickNode</h2>
        <span className="ml-auto border border-info/30 bg-info/10 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-info">
          {state}
        </span>
      </div>
      {status ? (
        <dl className="divide-y divide-border">
          {rows.map(([label, value]) => (
            <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5" key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-right font-mono text-xs tabular-nums text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="px-4 py-5 text-xs leading-5 text-muted-foreground sm:px-5">
          QuickNode status is not available from Harbor yet.
        </p>
      )}
    </section>
  );
}
