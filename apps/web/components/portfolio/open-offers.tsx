"use client";

import { Activity, Check, PencilLine, X } from "lucide-react";
import Link from "next/link";
import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { PortfolioOffer, PortfolioSnapshot } from "./portfolio-data";
import {
  formatPrice,
  formatQuantity,
  parseOffer,
  receiveFor,
  SideIcon,
  sideTone,
  withoutIssuer,
} from "./offer-format";

const chip = "inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-[13px] font-medium rounded capitalize";
const openChip = `${chip} border-info/30 bg-info/10 text-info`;

/**
 * Open offers with a details pop-up. In the demo, edits and cancels apply to
 * the page right away; signed in, they continue in chat, where Pilot prepares
 * the transaction for your wallet to sign.
 */
export function OpenOffersSection({
  offers: initial,
  coverage,
  demo,
}: {
  offers: PortfolioOffer[];
  coverage: PortfolioSnapshot["coverage"];
  demo: boolean;
}) {
  const [offers, setOffers] = useState(initial);
  const [openId, setOpenId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // Re-sync only when the ledger read actually changes, so a routine refresh doesn't undo demo edits.
  const initialKey = initial.map((offer) => `${offer.id}:${offer.quantity}:${offer.price}`).join("|");
  useEffect(() => setOffers(initial), [initialKey]);
  const selected = offers.find((offer) => offer.id === openId);

  const update = (next: PortfolioOffer) => {
    setOffers((current) => current.map((offer) => offer.id === next.id ? next : offer));
    setNotice(`Offer #${next.sequence} updated.`);
  };
  const cancel = (target: PortfolioOffer) => {
    setOffers((current) => current.filter((offer) => offer.id !== target.id));
    setOpenId(undefined);
    setNotice(`Offer #${target.sequence} cancelled.`);
  };

  return (
    <section aria-labelledby="offers-title" className="bracket flex flex-1 flex-col border border-border bg-card rounded-xl overflow-hidden">
      <div className="flex h-12 min-w-0 items-center gap-2.5 border-b border-border px-4 sm:px-5">
        <span className="shrink-0 text-muted-foreground" aria-hidden="true"><Activity className="h-4 w-4" /></span>
        <h2 id="offers-title" className="text-sm font-medium tracking-tight">Open offers</h2>
        <span className="label-mono ml-auto truncate">
          {coverage.offers === "partial" ? `${offers.length} loaded · partial` : `${offers.length} on ledger`}
        </span>
      </div>
      {notice ? (
        <p className="pilot-card-enter flex items-center gap-2 border-b border-border bg-executed/[0.06] px-4 py-2 text-xs text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))] sm:px-5" role="status">
          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {notice}
        </p>
      ) : null}
      {offers.length ? (
        <>
          <ul className="divide-y divide-border sm:hidden" aria-label="Open offers">
            {offers.map((offer) => (
              <li key={offer.id}>
                <button type="button" onClick={() => setOpenId(offer.id)} aria-label={`Offer #${offer.sequence}: ${offer.side} ${withoutIssuer(offer.quantity)}. Open details`} className="block w-full px-4 py-4 text-left transition hover:bg-foreground/[0.03]">
                  <span className="flex items-center justify-between gap-3">
                    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${sideTone(offer.side)}`}><SideIcon side={offer.side} />{offer.side} <span className="text-foreground">{withoutIssuer(offer.quantity)}</span></span>
                    <span className={openChip}>{offer.status}</span>
                  </span>
                  <span className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
                    <span className="label-mono">Receive</span>
                    <span className="min-w-0 break-words text-right font-mono text-xs">{withoutIssuer(offer.receive)}</span>
                    <span className="label-mono">Limit price</span>
                    <span className="min-w-0 break-words text-right font-mono text-xs">{withoutIssuer(offer.price)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block" role="region" aria-label="Open offers table" tabIndex={0}>
            <table className="w-full min-w-[38rem] text-left">
              <thead className="border-b border-border bg-surface">
                <tr>
                  <th className="label-mono px-5 py-2.5 font-medium">Side</th>
                  <th className="label-mono px-5 py-2.5 font-medium">Quantity</th>
                  <th className="label-mono px-5 py-2.5 font-medium">Receive</th>
                  <th className="label-mono px-5 py-2.5 font-medium">Limit price</th>
                  <th className="label-mono px-5 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs">
                {offers.map((offer) => (
                  <tr key={offer.id} onClick={() => setOpenId(offer.id)} className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-foreground/[0.03]">
                    <td className="px-5 py-3.5">
                      {/* The row is clickable; this button is the keyboard and screen-reader way in. */}
                      <button type="button" onClick={(event) => { event.stopPropagation(); setOpenId(offer.id); }} aria-label={`Offer #${offer.sequence}: ${offer.side} ${withoutIssuer(offer.quantity)}. Open details`} className={`inline-flex items-center gap-1.5 font-medium ${sideTone(offer.side)}`}>
                        <SideIcon side={offer.side} />{offer.side}
                      </button>
                    </td>
                    <td className="px-5 py-3.5 text-foreground">{withoutIssuer(offer.quantity)}</td>
                    <td className="px-5 py-3.5 text-muted-foreground" title={offer.receive}>{withoutIssuer(offer.receive)}</td>
                    <td className="px-5 py-3.5 text-foreground" title={offer.price}>{withoutIssuer(offer.price)}</td>
                    <td className="px-5 py-3.5"><span className={openChip}>{offer.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="px-5 py-6 text-sm text-muted-foreground">
          {coverage.offers === "partial" ? "No supported offers were loaded from the incomplete ledger read." : "No resting offers."}
        </p>
      )}
      {coverage.reasons.length > 0 ? (
        <ul className="mt-auto space-y-1 border-t border-approval/25 bg-approval/[0.06] px-5 py-3 text-xs leading-relaxed text-approval" aria-label="Portfolio read limitations">
          {coverage.reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      ) : null}
      {selected ? (
        <OfferDialog
          key={selected.id}
          offer={selected}
          demo={demo}
          onClose={() => setOpenId(undefined)}
          onSave={update}
          onCancelOffer={cancel}
        />
      ) : null}
    </section>
  );
}

const field = "h-10 w-full min-w-0 border border-input bg-background/60 px-3 font-mono text-sm outline-none transition focus:border-border-strong rounded-md";
const quietButton = "bracket bracket-light inline-flex h-10 items-center justify-center gap-2 border border-border bg-white/[0.03] px-4 text-[13px] transition hover:bg-white/[0.06] pointer-coarse:h-11 rounded-md";
const solidButton = "inline-flex h-10 items-center justify-center gap-2 bg-primary px-4 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md";
const dangerButton = "inline-flex h-10 items-center justify-center gap-2 border border-destructive/40 bg-destructive/10 px-4 text-[13px] font-medium text-destructive transition hover:bg-destructive/15 pointer-coarse:h-11 rounded-md";

function chatHref(prompt: string) {
  return `/chat?draft=${encodeURIComponent(prompt)}`;
}

function OfferDialog({
  offer,
  demo,
  onClose,
  onSave,
  onCancelOffer,
}: {
  offer: PortfolioOffer;
  demo: boolean;
  onClose: () => void;
  onSave: (offer: PortfolioOffer) => void;
  onCancelOffer: (offer: PortfolioOffer) => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const parsed = parseOffer(offer.quantity, offer.price);
  const [mode, setMode] = useState<"view" | "edit" | "confirm-cancel">("view");
  const [amount, setAmount] = useState(parsed ? String(parsed.amount) : "");
  const [price, setPrice] = useState(parsed ? String(parsed.price) : "");

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  const nextAmount = Number(amount);
  const nextPrice = Number(price);
  const draft = parsed && nextAmount > 0 && nextPrice > 0 ? { ...parsed, amount: nextAmount, price: nextPrice } : undefined;
  const changed = draft && parsed ? draft.amount !== parsed.amount || draft.price !== parsed.price : false;
  const label = `${offer.side} ${withoutIssuer(offer.quantity)}`;

  const save = () => {
    if (!draft) return;
    onSave({ ...offer, quantity: formatQuantity(draft), price: formatPrice(draft), receive: receiveFor(draft) });
    setMode("view");
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-end bg-black/40 sm:place-items-center sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="pilot-card-enter flex max-h-[92dvh] w-full flex-col overflow-hidden border border-border-strong bg-card shadow-2xl shadow-black/[0.14] outline-none sm:max-w-md rounded-xl">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="label-mono">Offer #{offer.sequence}</p>
            <h2 id={titleId} className={`mt-1.5 inline-flex items-center gap-2 text-base font-medium ${sideTone(offer.side)}`}>
              <SideIcon side={offer.side} /> {offer.side} <span className="text-foreground">{withoutIssuer(offer.quantity)}</span>
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close offer details" className="grid h-8 w-8 shrink-0 place-items-center border border-border text-muted-foreground transition hover:bg-secondary hover:text-foreground pointer-coarse:h-11 pointer-coarse:w-11 rounded-md">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {mode === "edit" && parsed ? (
            <div className="space-y-4">
              <label className="block">
                <span className="label-mono">Quantity ({parsed.give})</span>
                <input className={`${field} mt-1.5`} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} />
              </label>
              <label className="block">
                <span className="label-mono">Limit price ({parsed.quote}/{parsed.base})</span>
                <input className={`${field} mt-1.5`} inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value.replace(/[^\d.]/g, ""))} />
              </label>
              <p className="flex items-center justify-between gap-3 border border-border bg-background/50 px-3 py-2.5 text-xs rounded-xl">
                <span className="label-mono">You&apos;d receive</span>
                <span className="font-mono text-foreground">{draft ? receiveFor(draft) : "—"}</span>
              </p>
            </div>
          ) : (
            <dl className="grid grid-cols-2 gap-px border border-border bg-border rounded-xl overflow-hidden">
              {[
                ["Side", offer.side],
                ["Status", offer.status],
                ["Quantity", withoutIssuer(offer.quantity)],
                ["Receive", withoutIssuer(offer.receive)],
                ["Limit price", withoutIssuer(offer.price)],
                ["Offer number", `#${offer.sequence}`],
              ].map(([term, value]) => (
                <div key={term} className="min-w-0 bg-card px-3.5 py-3">
                  <dt className="label-mono">{term}</dt>
                  <dd className="mt-1 break-words font-mono text-xs text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {mode === "confirm-cancel" ? (
            <p className="mt-4 border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5 text-sm text-foreground rounded-xl" role="alert">
              Cancel this offer? Anything still unfilled comes back to your balance.
            </p>
          ) : null}
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-border bg-white/[0.015] px-5 py-4 sm:flex-row sm:items-center sm:justify-end">
          {mode === "view" ? (
            <>
              {demo ? (
                <button type="button" className={dangerButton} onClick={() => setMode("confirm-cancel")}>Cancel offer</button>
              ) : (
                <Link className={dangerButton} href={chatHref(`Cancel my open offer #${offer.sequence} (${label} at ${withoutIssuer(offer.price)}).`)}>Cancel offer</Link>
              )}
              {parsed ? <button type="button" className={solidButton} onClick={() => setMode("edit")}><PencilLine className="h-3.5 w-3.5" aria-hidden="true" /> Edit</button> : null}
            </>
          ) : mode === "edit" ? (
            <>
              <button type="button" className={quietButton} onClick={() => setMode("view")}>Back</button>
              {demo ? (
                <button type="button" className={solidButton} disabled={!draft || !changed} onClick={save}>Save changes</button>
              ) : draft && changed ? (
                <Link className={solidButton} href={chatHref(`Change my open offer #${offer.sequence} to ${offer.side.toLowerCase()} ${formatQuantity(draft)} at ${formatPrice(draft)}.`)}>Save changes</Link>
              ) : (
                <button type="button" className={solidButton} disabled>Save changes</button>
              )}
            </>
          ) : (
            <>
              <button type="button" className={quietButton} onClick={() => setMode("view")}>Keep it</button>
              <button type="button" className={dangerButton} onClick={() => onCancelOffer(offer)}>Yes, cancel offer</button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
