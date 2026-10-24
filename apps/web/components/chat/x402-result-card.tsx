"use client";

import type { X402PaymentEvent } from "@pilot/agent";
import { AlertTriangle, CheckCircle2, RotateCcw } from "lucide-react";
import React from "react";
import { xrplTestnetTransactionUrl } from "../../lib/xrpl-explorer";

function short(value: string, leading = 8, trailing = 6): string {
  return value.length <= leading + trailing + 1
    ? value
    : `${value.slice(0, leading)}…${value.slice(-trailing)}`;
}

export function X402ResultCard({
  event,
  onRetry,
}: {
  event: X402PaymentEvent;
  onRetry?: () => void;
}) {
  if (event.result.status === "settlement_unknown") {
    return (
      <section
        data-x402-status="settlement_unknown"
        className="mt-3 rounded-2xl border border-approval/30 bg-card/88 p-4"
        aria-label="x402 settlement status unknown"
      >
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-approval/12 text-approval">
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">Settlement status unknown</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Harbor returned a transaction reference but no validated settlement or merchant response. No journal entry was written.
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <div><dt className="text-muted-foreground">Transaction</dt><dd className="mt-1 font-mono">{short(event.result.tx_hash)}</dd></div>
              <div><dt className="text-muted-foreground">Last ledger</dt><dd className="mt-1">{event.result.last_ledger_sequence.toLocaleString()}</dd></div>
              <div><dt className="text-muted-foreground">Retry after</dt><dd className="mt-1">{event.result.retry_after_seconds} seconds</dd></div>
              <div><dt className="text-muted-foreground">Payment reference</dt><dd className="mt-1 font-mono">{short(event.result.payment_id)}</dd></div>
            </dl>
            {onRetry ? (
              <button type="button" onClick={onRetry} className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-approval/25 px-3 py-2 text-xs font-semibold text-approval">
                <RotateCcw className="h-3.5 w-3.5" />Retry same operation
              </button>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  const fixture = event.mode === "fixture";
  const explorerUrl = fixture ? undefined : xrplTestnetTransactionUrl(event.result.tx_hash);
  const merchantJson = JSON.stringify(event.result.merchant.body, null, 2);
  return (
    <section
      data-x402-status="delivered"
      data-x402-mode={event.mode}
      className="mt-3 rounded-2xl border border-primary/25 bg-card/88 p-4"
      aria-label={fixture ? "x402 fixture comparison" : "x402 premium comparison delivered"}
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
          <CheckCircle2 className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{fixture ? "Fixture comparison result" : "Premium comparison delivered"}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {fixture
              ? "Explicit local fixture only. No payment, settlement, or ledger validation occurred."
              : `Validated on Testnet ledger ${event.result.validated_ledger_index.toLocaleString()}.`}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <div><dt className="text-muted-foreground">Amount</dt><dd className="mt-1">{event.result.amount_drops} drops</dd></div>
            <div><dt className="text-muted-foreground">Fee</dt><dd className="mt-1">{event.result.fee_drops} drops</dd></div>
            <div><dt className="text-muted-foreground">Transaction</dt><dd className="mt-1 font-mono">{short(event.result.tx_hash)}</dd></div>
            <div><dt className="text-muted-foreground">Journal</dt><dd className="mt-1">{event.journal_status === "recorded" ? "Recorded" : event.journal_status === "failed" ? "Write failed" : "Fixture only"}</dd></div>
          </dl>
          {explorerUrl ? <a href={explorerUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 items-center text-primary underline underline-offset-4">Open validated transaction in XRPL Testnet Explorer</a> : null}
          {event.journal_error ? <p className="mt-3 text-xs text-blocked">{event.journal_error}</p> : null}
          {!fixture && event.journal_status === "failed" ? (
            <p className="mt-3 text-xs leading-5 text-approval">
              Payment settlement is validated. Only the durable journal receipt is pending; retrying reuses this payment operation and must not create another payment.
            </p>
          ) : null}
          {!fixture && event.journal_status === "failed" && onRetry ? (
            <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-approval/25 px-3 py-2 text-xs font-semibold text-approval">
              <RotateCcw className="h-3.5 w-3.5" />Retry journal with same operation
            </button>
          ) : null}
          <div className="mt-4 rounded-xl border border-white/8 bg-black/15 p-3">
            <p className="text-xs font-bold text-muted-foreground">Merchant JSON data</p>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-foreground/85">{merchantJson}</pre>
          </div>
        </div>
      </div>
    </section>
  );
}
