"use client";

import {
  Ap4mReceiptSchema,
  McIntentSchema,
  type Ap4mReceipt,
  type CardTrust,
  type McIntent,
} from "@pilot/contracts";
import { CheckCircle2, Download, ExternalLink, FileCheck2, ShieldCheck } from "lucide-react";
import React from "react";

import { hasVisibleTrustReceipt, TrustReceipt } from "./trust-receipt";

const XRPL_OBJECT_ID = /^[A-Fa-f0-9]{64}$/;
const SHA256_HEX = /^[A-Fa-f0-9]{64}$/;
const PUBLIC_SIGNATURE = /^[A-Za-z0-9_-]{20,2048}$/;

export type Ap4mEvidenceArtifact = {
  kind: "l1" | "l2" | "l3a" | "l3b" | "payment";
  digest: string;
  signature?: string;
  key_id?: string;
};

export type Ap4mDisputeEvidenceInput = {
  receipt: Ap4mReceipt;
  intent: McIntent;
  signed_artifacts: Ap4mEvidenceArtifact[];
  setup_tx_hashes?: string[];
};

export type Ap4mDisputeEvidence = {
  format: "ap4m-dispute-evidence-v1";
  network: "XRPL Testnet";
  receipt: Ap4mReceipt;
  intent: McIntent;
  signed_artifacts: Ap4mEvidenceArtifact[];
  transaction_hashes: string[];
};

export type Ap4mReceiptCardProps = {
  receipt: Ap4mReceipt;
  intent: McIntent;
  signedArtifacts: Ap4mEvidenceArtifact[];
  setupTransactionHashes?: string[];
  trust?: CardTrust;
  onSelectNode?: (node: "mandate" | "intent" | "l3" | "payment" | "ledger") => void;
};

function requireObjectId(value: string, label: string): string {
  if (!XRPL_OBJECT_ID.test(value)) throw new Error(`${label} must be a 64-character XRPL object id`);
  return value.toUpperCase();
}

function requireDigest(value: string, label: string): string {
  if (!SHA256_HEX.test(value)) throw new Error(`${label} must be a 64-character hexadecimal digest`);
  return value.toUpperCase();
}

function requirePublicSignature(value: string): string {
  if (!PUBLIC_SIGNATURE.test(value)) {
    throw new Error("Public evidence signatures must be bounded base64url values");
  }
  return value;
}

function requireKeyId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\s\0]/.test(normalized)) {
    throw new Error("Evidence key ids must be bounded non-whitespace values");
  }
  return normalized;
}

function testnetTransactionUrl(hash: string): string {
  return `https://testnet.xrpl.org/transactions/${requireObjectId(hash, "transaction hash")}`;
}

function testnetChannelUrl(channelId: string): string {
  return `https://test.bithomp.com/explorer/${requireObjectId(channelId, "payment channel id")}`;
}

/**
 * Produce the user-exportable manifest. It includes public signatures and
 * digests, never compact credentials/VI tokens, transaction blobs, private JWK
 * members, Open Finance identifiers, or raw merchant response text.
 */
export function buildAp4mDisputeEvidence(
  input: Ap4mDisputeEvidenceInput,
): Ap4mDisputeEvidence {
  const receipt = Ap4mReceiptSchema.parse(input.receipt);
  const intent = McIntentSchema.parse(input.intent);
  if (receipt.intent_id !== intent.intentId) {
    throw new Error("Receipt and intent ids must match");
  }

  const signedArtifacts = input.signed_artifacts.map((artifact) => ({
    kind: artifact.kind,
    digest: requireDigest(artifact.digest, `${artifact.kind} digest`),
    ...(artifact.signature ? { signature: requirePublicSignature(artifact.signature) } : {}),
    ...(artifact.key_id ? { key_id: requireKeyId(artifact.key_id) } : {}),
  }));
  const requiredKinds = new Set<Ap4mEvidenceArtifact["kind"]>(["l1", "l2", "l3a", "l3b", "payment"]);
  for (const artifact of signedArtifacts) requiredKinds.delete(artifact.kind);
  if (requiredKinds.size > 0) {
    throw new Error(`Dispute evidence is missing ${[...requiredKinds].join(", ")} artifacts`);
  }
  if (new Set(signedArtifacts.map((artifact) => artifact.kind)).size !== signedArtifacts.length) {
    throw new Error("Dispute evidence artifact kinds must be unique");
  }

  const transactionHashes = [
    ...(input.setup_tx_hashes ?? []),
    ...(receipt.proof.tx_hash ? [receipt.proof.tx_hash] : []),
  ].map((hash) => requireObjectId(hash, "evidence transaction hash"));

  return {
    format: "ap4m-dispute-evidence-v1",
    network: "XRPL Testnet",
    receipt,
    intent,
    signed_artifacts: signedArtifacts,
    transaction_hashes: [...new Set(transactionHashes)],
  };
}

export function serializeAp4mDisputeEvidence(input: Ap4mDisputeEvidenceInput): string {
  return `${JSON.stringify(buildAp4mDisputeEvidence(input), null, 2)}\n`;
}

function downloadEvidence(input: Ap4mDisputeEvidenceInput): void {
  const evidence = serializeAp4mDisputeEvidence(input);
  const blobUrl = URL.createObjectURL(new Blob([evidence], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = `${input.receipt.receipt_id.replace(/[^A-Za-z0-9._-]/g, "_")}-dispute-evidence.json`;
  anchor.rel = "noopener noreferrer";
  anchor.click();
  URL.revokeObjectURL(blobUrl);
}

function short(value: string, head = 9, tail = 7): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function ChainNode({
  label,
  value,
  detail,
  href,
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  href?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</span>
      <span className="mt-1 block break-all font-mono text-xs font-semibold text-slate-950">{value}</span>
      <span className="mt-1 block text-[11px] leading-4 text-slate-600">{detail}</span>
    </>
  );
  const className =
    "group min-w-0 border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500";

  return href ? (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
      {content}
      <ExternalLink aria-hidden="true" className="mt-2 h-3.5 w-3.5 text-slate-400 group-hover:text-slate-700" />
    </a>
  ) : (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

export function Ap4mReceiptCard({
  receipt: receiptInput,
  intent: intentInput,
  signedArtifacts,
  setupTransactionHashes = [],
  trust,
  onSelectNode,
}: Ap4mReceiptCardProps) {
  const receipt = Ap4mReceiptSchema.parse(receiptInput);
  const intent = McIntentSchema.parse(intentInput);
  if (receipt.intent_id !== intent.intentId) throw new Error("Receipt and intent ids must match");

  const paymentHref = receipt.proof.tx_hash
    ? testnetTransactionUrl(receipt.proof.tx_hash)
    : receipt.proof.channel_id
      ? testnetChannelUrl(receipt.proof.channel_id)
      : undefined;
  const setupHref = setupTransactionHashes[0]
    ? testnetTransactionUrl(setupTransactionHashes[0])
    : receipt.proof.channel_id
      ? testnetChannelUrl(receipt.proof.channel_id)
      : undefined;
  const settlementLabel = receipt.settlement.replaceAll("_", " ");
  const evidenceInput = {
    receipt,
    intent,
    signed_artifacts: signedArtifacts,
    setup_tx_hashes: setupTransactionHashes,
  } satisfies Ap4mDisputeEvidenceInput;

  return (
    <article
      aria-label={`AP4M receipt ${receipt.receipt_id}`}
      className="min-w-0 border border-slate-300 bg-slate-50 text-slate-950 shadow-[0_18px_50px_rgba(15,23,42,0.12)]"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-white p-4">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-sky-700">XRPL Testnet</p>
          <h3 className="mt-1 text-base font-semibold">AP4M dispute-ready receipt</h3>
          <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{receipt.receipt_id}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold capitalize text-emerald-800">
          <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
          {settlementLabel}
        </span>
      </header>

      <div className="p-4">
        <div className="grid gap-2 sm:grid-cols-5" aria-label="Receipt evidence chain">
          <ChainNode
            label="Mandate"
            value={short(receipt.mandate_id)}
            detail="Human authority and limits"
            href={setupHref}
            onClick={() => onSelectNode?.("mandate")}
          />
          <ChainNode
            label="Intent"
            value={short(receipt.intent_id)}
            detail="ACTIVE · DEFERRED"
            onClick={() => onSelectNode?.("intent")}
          />
          <ChainNode
            label="L3"
            value={short(receipt.l3b_digest)}
            detail="Agent-to-merchant binding"
            onClick={() => onSelectNode?.("l3")}
          />
          <ChainNode
            label="Payment"
            value={receipt.scheme === "exact" ? "XRPL exact" : "XRPL pay channel"}
            detail={`${receipt.amount.value} ${receipt.amount.asset.kind === "xrp" ? "XRP" : receipt.amount.asset.currency}`}
            href={paymentHref}
            onClick={() => onSelectNode?.("payment")}
          />
          <ChainNode
            label="Ledger"
            value={receipt.proof.tx_hash ? short(receipt.proof.tx_hash) : short(receipt.proof.channel_id ?? "pending")}
            detail={settlementLabel}
            href={paymentHref}
            onClick={() => onSelectNode?.("ledger")}
          />
        </div>

        <div className="mt-4 grid gap-2 text-[11px] leading-4 text-slate-600 sm:grid-cols-2">
          <p className="flex items-start gap-2 border border-slate-200 bg-white p-3">
            <FileCheck2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
            Verifiable Intent v0.1 · verified with Mastercard&apos;s reference implementation
          </p>
          <p className="flex items-start gap-2 border border-slate-200 bg-white p-3">
            <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
            Validation flow from Mastercard&apos;s Level 3 Agentic Commerce guide · payment object: XRPL
          </p>
        </div>
        <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
          Demo Network — Mastercard&apos;s role in production
        </p>
      </div>

      {hasVisibleTrustReceipt(trust) ? (
        <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
          <TrustReceipt appearance="light" trust={trust} />
        </div>
      ) : null}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white p-4">
        <p className="text-[11px] text-slate-500">
          Export contains public signatures, digests, validation outcomes, and transaction hashes—never keys or raw credentials.
        </p>
        <button
          type="button"
          onClick={() => downloadEvidence(evidenceInput)}
          className="inline-flex items-center gap-2 border border-slate-900 bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <Download aria-hidden="true" className="h-3.5 w-3.5" />
          Dispute evidence
        </button>
      </footer>
    </article>
  );
}
