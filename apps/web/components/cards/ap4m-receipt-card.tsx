"use client";

import {
  Ap4mPublicEvidenceSchema,
  Ap4mReceiptSchema,
  type Ap4mPublicEvidence,
  type Ap4mPublicEvidenceArtifact,
  type Ap4mReceipt,
  type CardTrust,
} from "@pilot/contracts";
import { CheckCircle2, Download, ExternalLink, FileCheck2, ShieldCheck } from "lucide-react";
import React from "react";

import { hasVisibleTrustReceipt, TrustReceipt } from "./trust-receipt";

export type Ap4mEvidenceArtifact = Ap4mPublicEvidenceArtifact;
export type Ap4mDisputeEvidenceInput = { receipt: Ap4mReceipt; evidence: Ap4mPublicEvidence };
export type Ap4mDisputeEvidence = {
  format: "ap4m-dispute-evidence-v1";
  network: "XRPL Testnet";
  receipt: Ap4mReceipt;
  intent: Ap4mPublicEvidence["intent"];
  artifact_references: Ap4mPublicEvidence["artifacts"];
  transaction_hashes: string[];
};
export type Ap4mReceiptCardProps = Ap4mDisputeEvidenceInput & {
  trust?: CardTrust;
  onSelectNode?: (node: "mandate" | "intent" | "l3" | "payment" | "ledger") => void;
};

const XRPL_OBJECT_ID = /^[A-F0-9]{64}$/;

function requireValidatedExactEvidence(input: Ap4mDisputeEvidenceInput): Ap4mDisputeEvidenceInput {
  const receipt = Ap4mReceiptSchema.parse(input.receipt);
  const evidence = Ap4mPublicEvidenceSchema.parse(input.evidence);
  const txHash = receipt.proof.tx_hash?.toUpperCase();
  if (receipt.scheme !== "exact" || receipt.settlement !== "validated" || !txHash || !XRPL_OBJECT_ID.test(txHash)) {
    throw new Error("AP4M public evidence requires a validated exact Testnet transaction");
  }
  const validation = receipt.merchant_validation;
  if (
    !validation.validated ||
    validation.intentId !== receipt.intent_id ||
    Object.values(validation.checks).some((check) => check !== "pass") ||
    validation.validation_errors.length !== 0
  ) {
    throw new Error("AP4M public evidence requires fully passed merchant validation");
  }
  if (
    evidence.intent.intentId !== receipt.intent_id ||
    evidence.artifacts[2].digest !== receipt.l3a_digest.toUpperCase() ||
    evidence.artifacts[3].digest !== receipt.l3b_digest.toUpperCase() ||
    evidence.artifacts[4].digest !== txHash
  ) {
    throw new Error("AP4M evidence references do not match the validated receipt");
  }
  return { receipt, evidence };
}

export function buildAp4mDisputeEvidence(input: Ap4mDisputeEvidenceInput): Ap4mDisputeEvidence {
  const { receipt, evidence } = requireValidatedExactEvidence(input);
  return {
    format: "ap4m-dispute-evidence-v1",
    network: "XRPL Testnet",
    receipt,
    intent: evidence.intent,
    artifact_references: evidence.artifacts,
    transaction_hashes: [receipt.proof.tx_hash!.toUpperCase()],
  };
}

export function serializeAp4mDisputeEvidence(input: Ap4mDisputeEvidenceInput): string {
  return `${JSON.stringify(buildAp4mDisputeEvidence(input), null, 2)}\n`;
}

function downloadEvidence(input: Ap4mDisputeEvidenceInput): void {
  const blobUrl = URL.createObjectURL(new Blob([serializeAp4mDisputeEvidence(input)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = `${input.receipt.receipt_id.replace(/[^A-Za-z0-9._-]/g, "_")}-evidence.json`;
  anchor.rel = "noopener noreferrer";
  anchor.click();
  URL.revokeObjectURL(blobUrl);
}

function short(value: string, head = 9, tail = 7): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function ChainNode({ label, value, detail, href, onClick }: {
  label: string; value: string; detail: string; href?: string; onClick?: () => void;
}) {
  const content = <><span className="block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</span><span className="mt-1 block break-all font-mono text-xs font-semibold text-slate-950">{value}</span><span className="mt-1 block text-[11px] leading-4 text-slate-600">{detail}</span></>;
  const className = "group min-w-0 border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
  return href ? <a className={className} href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>{content}<ExternalLink aria-hidden="true" className="mt-2 h-3.5 w-3.5 text-slate-400 group-hover:text-slate-700" /></a> : <button type="button" className={className} onClick={onClick}>{content}</button>;
}

export function Ap4mReceiptCard({ receipt: receiptInput, evidence: evidenceInput, trust, onSelectNode }: Ap4mReceiptCardProps) {
  const { receipt, evidence } = requireValidatedExactEvidence({ receipt: receiptInput, evidence: evidenceInput });
  const txHash = receipt.proof.tx_hash!.toUpperCase();
  const paymentHref = `https://testnet.xrpl.org/transactions/${encodeURIComponent(txHash)}`;
  const exportInput = { receipt, evidence };
  return <article aria-label={`AP4M receipt ${receipt.receipt_id}`} className="min-w-0 border border-slate-300 bg-slate-50 text-slate-950 shadow-[0_18px_50px_rgba(15,23,42,0.12)]">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-white p-4"><div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-sky-700">XRPL Testnet · live validated evidence</p><h3 className="mt-1 text-base font-semibold">AP4M validated receipt</h3><p className="mt-1 break-all font-mono text-[11px] text-slate-500">{receipt.receipt_id}</p></div><span className="inline-flex items-center gap-1.5 border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800"><CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />Validated</span></header>
    <div className="p-4"><div className="grid gap-2 sm:grid-cols-5" aria-label="Receipt evidence references">
      <ChainNode label="Mandate" value={short(receipt.mandate_id)} detail="Owner-approved authority reference" onClick={() => onSelectNode?.("mandate")} />
      <ChainNode label="Intent" value={short(receipt.intent_id)} detail="Server-bound McIntent" onClick={() => onSelectNode?.("intent")} />
      <ChainNode label="L3" value={short(receipt.l3b_digest)} detail="Agent-to-merchant digest reference" onClick={() => onSelectNode?.("l3")} />
      <ChainNode label="Payment" value="XRPL exact" detail={`${receipt.amount.value} ${receipt.amount.asset.kind === "xrp" ? "XRP" : receipt.amount.asset.currency}`} href={paymentHref} onClick={() => onSelectNode?.("payment")} />
      <ChainNode label="Ledger" value={short(txHash)} detail="Validated transaction" href={paymentHref} onClick={() => onSelectNode?.("ledger")} />
    </div><div className="mt-4 grid gap-2 text-[11px] leading-4 text-slate-600 sm:grid-cols-2"><p className="flex items-start gap-2 border border-slate-200 bg-white p-3"><FileCheck2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />Server-owned McIntent and five bounded digest references</p><p className="flex items-start gap-2 border border-slate-200 bg-white p-3"><ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />Exact-rail receipt with fully passed merchant validation</p></div></div>
    {hasVisibleTrustReceipt(trust) ? <div className="border-t border-slate-200 bg-slate-50 px-4 py-3"><TrustReceipt appearance="light" trust={trust} /></div> : null}
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white p-4"><p className="text-[11px] text-slate-500">Export contains digest references, validation outcomes, and the validated transaction hash—never tokens, keys, credentials, or transaction blobs.</p><button type="button" onClick={() => downloadEvidence(exportInput)} className="inline-flex items-center gap-2 border border-slate-900 bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"><Download aria-hidden="true" className="h-3.5 w-3.5" />Export evidence</button></footer>
  </article>;
}
