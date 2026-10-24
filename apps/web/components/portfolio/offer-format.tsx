import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import React from "react";

/** Drops the "(rIssuer…)" suffix from an amount or price for display. */
export function withoutIssuer(value: string): string {
  return value.replace(/\s*\(r[1-9A-HJ-NP-Za-km-z.…]+\)/g, "");
}

export function sideTone(side: string): string {
  return side === "Buy" ? "text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" : "text-approval";
}

export function SideIcon({ side }: { side: string }) {
  return side === "Buy" ? <ArrowDownLeft className="h-3.5 w-3.5" aria-hidden="true" /> : <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />;
}

export type ParsedOffer = {
  amount: number;
  /** Currency the offer gives up. */
  give: string;
  /** Price as quote per base, e.g. 0.512 for "0.512 RLUSD/XRP". */
  price: number;
  base: string;
  quote: string;
};

/** Reads "10 XRP" and "0.512000 RLUSD/XRP" into numbers; undefined when the shape is unfamiliar. */
export function parseOffer(quantity: string, price: string): ParsedOffer | undefined {
  const q = /^([\d,.]+)\s+(\S+)$/.exec(withoutIssuer(quantity).trim());
  const p = /^([\d,.]+)\s+(\S+)\/(\S+)$/.exec(withoutIssuer(price).trim());
  if (!q || !p) return undefined;
  const amount = Number(q[1]!.replace(/,/g, ""));
  const value = Number(p[1]!.replace(/,/g, ""));
  const give = q[2]!;
  const quote = p[2]!;
  const base = p[3]!;
  if (!(amount > 0) || !(value > 0) || (give !== base && give !== quote)) return undefined;
  return { amount, give, price: value, base, quote };
}

function trim(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

/** What the offer receives if it fills completely. */
export function receiveFor(offer: ParsedOffer): string {
  return offer.give === offer.base
    ? `${trim(offer.amount * offer.price, 2)} ${offer.quote}`
    : `${trim(offer.amount / offer.price, 2)} ${offer.base}`;
}

export function formatQuantity(offer: ParsedOffer): string {
  return `${trim(offer.amount, 6)} ${offer.give}`;
}

export function formatPrice(offer: ParsedOffer): string {
  return `${offer.price.toFixed(6)} ${offer.quote}/${offer.base}`;
}
