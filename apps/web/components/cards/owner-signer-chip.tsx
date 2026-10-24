"use client";

import { KeyRound } from "lucide-react";
import React from "react";

import { ledgerSignedCopy } from "../ledger/provenance";
import { isLedgerOwnerSigner, type LedgerOwnerSigner } from "./owner-signer";

export { isLedgerOwnerSigner } from "./owner-signer";
export type { LedgerOwnerSigner } from "./owner-signer";

export type OwnerSignerChipProps = {
  signer?: LedgerOwnerSigner | null;
};

/**
 * Client-known owner-signing evidence only. This deliberately accepts neither
 * transaction data nor server/tool output, so it cannot become a contract or
 * untrusted-text surface.
 */
export function OwnerSignerChip({ signer }: OwnerSignerChipProps) {
  if (!isLedgerOwnerSigner(signer)) return null;
  const signedCopy = ledgerSignedCopy(signer.transport);

  return (
    <span
      aria-label={`Owner approval ${signedCopy.toLowerCase()} account ${signer.accountIndex}`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2.5 py-1.5 text-[11px] font-semibold text-secondary-foreground"
    >
      <KeyRound aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
      <span className="truncate">{signedCopy}</span>
      <span aria-hidden="true" className="text-muted-foreground">·</span>
      <span className="whitespace-nowrap font-mono text-[10px] text-muted-foreground">account {signer.accountIndex}</span>
    </span>
  );
}
