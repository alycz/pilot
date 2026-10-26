"use client";

import { LoaderCircle, Radio, RefreshCw } from "lucide-react";
import React, { useMemo, useState } from "react";

import { createBrowserHarborClient } from "../../lib/harbor-browser";
import {
  loadLiveNearIntentsDryQuote,
  loadLiveNearIntentsTokens,
} from "../../lib/near-live-preview";

import { NearOwnerFundedLiveReview } from "./near-owner-funded-live-review";

type TokenInventory = Awaited<ReturnType<typeof loadLiveNearIntentsTokens>>;
type DryQuote = Awaited<ReturnType<typeof loadLiveNearIntentsDryQuote>>;

export function NearIntentsLivePreview({
  executableReviewEnabled = false,
}: Readonly<{ executableReviewEnabled?: boolean }>) {
  const harbor = useMemo(() => createBrowserHarborClient(), []);
  const [inventory, setInventory] = useState<TokenInventory>();
  const [quote, setQuote] = useState<DryQuote>();
  const [originAsset, setOriginAsset] = useState("");
  const [destinationAsset, setDestinationAsset] = useState("");
  const [amount, setAmount] = useState("1000000");
  const [recipient, setRecipient] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [busy, setBusy] = useState<"tokens" | "quote">();
  const [error, setError] = useState<string>();

  const discover = async () => {
    setBusy("tokens");
    setError(undefined);
    setQuote(undefined);
    try {
      const result = await loadLiveNearIntentsTokens(harbor);
      setInventory(result);
      const first = result.tokens[0]?.assetId ?? "";
      const second = result.tokens.find((token) => token.assetId !== first)?.assetId ?? "";
      setOriginAsset(first);
      setDestinationAsset(second);
    } catch (cause) {
      setInventory(undefined);
      setError(cause instanceof Error ? cause.message : "NEAR Intents token discovery is unavailable.");
    } finally {
      setBusy(undefined);
    }
  };

  const requestQuote = async () => {
    setBusy("quote");
    setError(undefined);
    setQuote(undefined);
    try {
      const result = await loadLiveNearIntentsDryQuote(harbor, {
        dry: true,
        origin_asset_id: originAsset,
        destination_asset_id: destinationAsset,
        amount,
        slippage_bps: 100,
        deposit_type: "ORIGIN_CHAIN",
        recipient,
        recipient_type: "DESTINATION_CHAIN",
        refund_to: refundTo,
        refund_type: "ORIGIN_CHAIN",
        refund_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        quote_waiting_time_ms: 0,
      });
      setQuote(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The NEAR Intents dry quote is unavailable.");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section aria-labelledby="near-live-title" className="overflow-hidden border border-border bg-card rounded-xl">
      <header className="flex flex-col gap-4 border-b border-border px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center border border-primary/30 bg-primary-soft text-primary rounded-md"><Radio className="size-4" aria-hidden="true" /></span>
          <div>
            <p className="label-mono">Provider-connected · read only</p>
            <h2 id="near-live-title" className="mt-1 text-sm font-medium tracking-tight">Live 1Click token and dry-quote preview</h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">Pilot calls the same-origin Harbor proxy. Credentials remain server-side; execution, deposits, and signing remain unavailable.</p>
          </div>
        </div>
        <button type="button" disabled={Boolean(busy)} onClick={() => void discover()} className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 border border-border-strong px-3.5 text-[13px] transition hover:bg-white/[0.05] disabled:opacity-45 pointer-coarse:h-11 rounded-md">
          {busy === "tokens" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
          Check live inventory
        </button>
      </header>

      {error ? <p role="alert" className="border-b border-blocked/35 bg-blocked/[0.06] px-4 py-3 text-xs leading-5 text-blocked sm:px-5">Unavailable: {error} No fixture data was substituted.</p> : null}

      <div className="p-4 sm:p-5">
        {!inventory ? <p className="text-sm leading-6 text-muted-foreground">Not checked. Configure the live Harbor service and, when required, its server-side 1Click partner key; then use the button above.</p> : (
          <div className="space-y-4">
            <p role="status" className="border border-executed/30 bg-executed/[0.06] px-3 py-2 text-xs text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))] rounded-xl">Live inventory returned {inventory.count} exact provider asset IDs. Execution remains disabled.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Input asset"><select value={originAsset} onChange={(event) => setOriginAsset(event.target.value)} className="mt-1.5 h-11 w-full border border-input bg-background px-3 font-mono text-xs rounded-md">{inventory.tokens.map((token) => <option key={token.assetId} value={token.assetId}>{token.symbol} · {token.blockchain} · {token.assetId}</option>)}</select></Field>
              <Field label="Output asset"><select value={destinationAsset} onChange={(event) => setDestinationAsset(event.target.value)} className="mt-1.5 h-11 w-full border border-input bg-background px-3 font-mono text-xs rounded-md">{inventory.tokens.map((token) => <option key={token.assetId} value={token.assetId}>{token.symbol} · {token.blockchain} · {token.assetId}</option>)}</select></Field>
              <Field label="Input amount · atomic units"><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" className="mt-1.5 h-11 w-full border border-input bg-background px-3 font-mono text-xs rounded-md" /></Field>
              <Field label="Destination recipient"><input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="Exact destination-chain address" className="mt-1.5 h-11 w-full border border-input bg-background px-3 font-mono text-xs rounded-md" /></Field>
              <Field label="Origin-chain refund address"><input value={refundTo} onChange={(event) => setRefundTo(event.target.value)} placeholder="Exact origin-chain address" className="mt-1.5 h-11 w-full border border-input bg-background px-3 font-mono text-xs rounded-md" /></Field>
            </div>
            <button type="button" disabled={Boolean(busy) || !originAsset || !destinationAsset || originAsset === destinationAsset || !/^[1-9]\d*$/.test(amount) || !recipient.trim() || !refundTo.trim()} onClick={() => void requestQuote()} className="inline-flex h-9 items-center gap-1.5 bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md">
              {busy === "quote" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
              Request verified dry quote
            </button>
          </div>
        )}

        {quote ? <dl className="mt-4 grid gap-px border border-border bg-border sm:grid-cols-3 rounded-xl overflow-hidden">
          <Result label="Provider source" value="Live · signature verified" />
          <Result label="Quoted input" value={quote.quote.quote.amountIn} />
          <Result label="Minimum output" value={quote.quote.quote.minAmountOut} />
          <Result label="Quote hash" value={quote.quote_hash} />
          <Result label="Deposit address" value="Not issued for dry quote" />
          <Result label="Execution" value="Disabled" />
        </dl> : null}

        <NearOwnerFundedLiveReview client={harbor} enabled={executableReviewEnabled} />
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="min-w-0"><span className="label-mono block">{label}</span>{children}</label>; }
function Result({ label, value }: { label: string; value: string }) { return <div className="min-w-0 bg-card px-3.5 py-3"><dt className="label-mono">{label}</dt><dd className="mt-1 break-all font-mono text-xs text-foreground">{value}</dd></div>; }
