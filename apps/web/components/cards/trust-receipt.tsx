import type { CardEvent } from "@pilot/contracts";
import { Bot, CheckCircle2, ChevronDown, KeyRound, RadioTower, Router, ShieldCheck } from "lucide-react";
import React, { type ReactNode } from "react";

type CardTrust = NonNullable<CardEvent["trust"]>;

export type TrustReceiptProps = {
  appearance?: "default" | "light";
  presentation?: "default" | "demo";
  trust?: CardEvent["trust"] | null;
};

export function hasVisibleTrustReceipt(trust: TrustReceiptProps["trust"]): boolean {
  if (!trust || typeof trust !== "object") return false;
  return [
    screenChip(trust.screen),
    modelChip(trust.model),
    signerChip(trust.signer),
    rpcChip(trust.rpc),
    confirmationChip(trust.confirmation),
    watchChip(trust.watch),
  ].some(
    (chip) => chip !== null,
  );
}

type ReceiptChip = {
  detail: ReactNode;
  icon: typeof ShieldCheck;
  id: "confirmation" | "model" | "rpc" | "screen" | "signer" | "watch";
  label: string;
};

function countLabel(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function screenChip(screen: CardTrust["screen"], presentation: NonNullable<TrustReceiptProps["presentation"]> = "default"): ReceiptChip | null {
  if (
    !screen ||
    !Number.isInteger(screen.fields_checked) ||
    screen.fields_checked < 0 ||
    !Number.isInteger(screen.fields_blocked) ||
    screen.fields_blocked < 0
  ) {
    return null;
  }

  let label: string;
  let unavailable = false;
  switch (screen.provider) {
    case "aws-bedrock-guardrails":
      label = "Screened by Bedrock Guardrails";
      break;
    case "mock":
      label = presentation === "demo" ? "Bedrock Guardrails" : "Screened by Bedrock Guardrails (mock)";
      break;
    case "unavailable":
      label = "Guardrail screening unavailable";
      unavailable = true;
      break;
    case "off":
    default:
      return null;
  }

  const hasScore = typeof screen.max_score === "number" && Number.isFinite(screen.max_score);
  return {
    id: "screen",
    icon: ShieldCheck,
    label,
    detail: (
      <div className="space-y-1.5">
        <p>
          {countLabel(screen.fields_checked, "field")} checked · {countLabel(screen.fields_blocked, "field")} blocked
        </p>
        {hasScore ? <p>Maximum score: {screen.max_score}</p> : null}
        {unavailable ? <p>Guardrails were unavailable; no screening claim is made.</p> : null}
        {!unavailable && screen.fields_blocked > 0 ? <p>Screened content was redacted before model use.</p> : null}
      </div>
    ),
  };
}

function modelChip(model: CardTrust["model"], presentation: NonNullable<TrustReceiptProps["presentation"]> = "default"): ReceiptChip | null {
  if (!model || typeof model.id !== "string" || model.id.trim() === "") return null;

  let label: string;
  switch (model.provider) {
    case "bedrock":
      label = "Model · Amazon Bedrock";
      break;
    case "bedrock-mock":
      label = presentation === "demo" ? "Amazon Bedrock" : "Model · Amazon Bedrock (mock)";
      break;
    case "openrouter":
      label = "Model · OpenRouter";
      break;
    default:
      return null;
  }

  return {
    id: "model",
    icon: Bot,
    label,
    detail: <p className="break-all font-mono">{model.id}</p>,
  };
}

function signerChip(signer: CardTrust["signer"], presentation: NonNullable<TrustReceiptProps["presentation"]> = "default"): ReceiptChip | null {
  if (!signer) return null;

  let label: string;
  let showKeyReference = false;
  switch (signer.kind) {
    case "aws-kms":
      label = "Signed by AWS KMS";
      showKeyReference = true;
      break;
    case "aws-kms-kek":
      label = presentation === "demo" ? "AWS KMS" : "Key protected by AWS KMS";
      showKeyReference = true;
      break;
    case "local":
      label = "Signed locally";
      break;
    default:
      return null;
  }

  const keyReference =
    showKeyReference && typeof signer.key_ref === "string" && signer.key_ref.startsWith("alias/")
      ? signer.key_ref
      : null;
  return {
    id: "signer",
    icon: KeyRound,
    label,
    detail: keyReference ? (
      <p className="break-all font-mono">{keyReference}</p>
    ) : (
      <p>{signer.kind === "local" ? "The receipt explicitly identifies a local signer." : "No key alias was provided."}</p>
    ),
  };
}

function rpcChip(route: CardTrust["rpc"], presentation: NonNullable<TrustReceiptProps["presentation"]> = "default"): ReceiptChip | null {
  switch (route) {
    case "quicknode":
      return {
        id: "rpc",
        icon: Router,
        label: "RPC · QuickNode",
        detail: <p>This XRPL request was served by QuickNode.</p>,
      };
    case "quicknode-mock":
      return {
        id: "rpc",
        icon: Router,
        label: presentation === "demo" ? "QuickNode RPC" : "RPC · QuickNode (mock)",
        detail: <p>This is local stand-in evidence, not a live QuickNode request.</p>,
      };
    case "fallback":
      return {
        id: "rpc",
        icon: Router,
        label: "Fallback node",
        detail: <p>This XRPL request used the configured fallback node.</p>,
      };
    default:
      return null;
  }
}

function confirmationChip(confirmation: CardTrust["confirmation"], presentation: NonNullable<TrustReceiptProps["presentation"]> = "default"): ReceiptChip | null {
  if (
    !confirmation ||
    !Number.isInteger(confirmation.latency_ms) ||
    confirmation.latency_ms < 0
  ) {
    return null;
  }

  if (confirmation.provider === "poll") {
    return {
      id: "confirmation",
      icon: CheckCircle2,
      label: "Confirmed · polling",
      detail: <p>Ledger confirmation was observed by polling.</p>,
    };
  }

  const latency = `${(confirmation.latency_ms / 1_000).toFixed(1)} s`;
  const mock = confirmation.provider === "quicknode-mock";
  return {
    id: "confirmation",
    icon: CheckCircle2,
    label: presentation === "demo" && mock
      ? "QuickNode webhook"
      : `Confirmed · QuickNode webhook${mock ? " (mock)" : ""} · ${latency}`,
    detail: mock ? (
      <p>This is local stand-in evidence, not a live QuickNode webhook.</p>
    ) : (
      <p>QuickNode delivered the ledger confirmation webhook.</p>
    ),
  };
}

function watchChip(watch: CardTrust["watch"], presentation: NonNullable<TrustReceiptProps["presentation"]> = "default"): ReceiptChip | null {
  if (!watch || watch.provider === "off") return null;

  const mock = watch.provider === "quicknode-mock";
  return {
    id: "watch",
    icon: RadioTower,
    label: presentation === "demo" && mock
      ? "QuickNode Streams"
      : `Watched · QuickNode Streams${mock ? " (mock)" : ""}`,
    detail: (
      <p>
        {mock ? "Local stand-in monitoring" : "QuickNode Streams monitoring"} is {watch.status}.
      </p>
    ),
  };
}

function TrustChip({
  appearance,
  chip,
}: {
  appearance: NonNullable<TrustReceiptProps["appearance"]>;
  chip: ReceiptChip;
}) {
  const Icon = chip.icon;
  const summaryClass = appearance === "light"
    ? "inline-flex max-w-full cursor-pointer list-none items-center gap-1.5 rounded-full border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-800 transition hover:border-cyan-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-600/50 [&::-webkit-details-marker]:hidden"
    : "inline-flex max-w-full cursor-pointer list-none items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2.5 py-1.5 text-[11px] font-semibold text-secondary-foreground transition hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 [&::-webkit-details-marker]:hidden";
  const detailClass = appearance === "light"
    ? "mt-2 max-w-sm rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-slate-600"
    : "mt-2 max-w-sm rounded-xl border border-border bg-background px-3 py-2 text-[11px] leading-relaxed text-muted-foreground";
  return (
    <li className="min-w-0">
      <details className="group min-w-0">
        <summary className={summaryClass}>
          <Icon aria-hidden="true" className={appearance === "light" ? "size-3.5 shrink-0 text-cyan-700" : "size-3.5 shrink-0 text-primary"} />
          <span className="truncate">{chip.label}</span>
          <ChevronDown aria-hidden="true" className={appearance === "light" ? "size-3 shrink-0 text-slate-500 transition group-open:rotate-180" : "size-3 shrink-0 text-muted-foreground transition group-open:rotate-180"} />
        </summary>
        <div className={detailClass}>
          {chip.detail}
        </div>
      </details>
    </li>
  );
}

/**
 * Render only structured trust metadata. Tool output and screened field values
 * are deliberately not accepted by this component.
 */
export function TrustReceipt({ appearance = "default", presentation = "default", trust }: TrustReceiptProps) {
  if (!trust || typeof trust !== "object") return null;

  const awsChips = [screenChip(trust.screen, presentation), modelChip(trust.model, presentation), signerChip(trust.signer, presentation)];
  const quickNodeChips = [rpcChip(trust.rpc, presentation), confirmationChip(trust.confirmation, presentation), watchChip(trust.watch, presentation)];
  const chips = [...awsChips, ...quickNodeChips].filter(
    (chip): chip is ReceiptChip => chip !== null,
  );
  if (chips.length === 0) return null;

  const hasAws = awsChips.some((chip) => chip !== null);
  const hasQuickNode = quickNodeChips.some((chip) => chip !== null);
  const receiptLabel = presentation === "demo"
    ? "Demo capability preview"
    : hasAws && hasQuickNode
    ? "AWS and QuickNode trust receipt"
    : hasQuickNode
      ? "QuickNode trust receipt"
      : "AWS trust receipt";

  return (
    <section aria-label={receiptLabel} className="min-w-0">
      {presentation === "demo" ? (
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">Demo</p>
      ) : null}
      <ul className="flex min-w-0 flex-wrap items-start gap-2" role="list">
        {chips.map((chip) => <TrustChip appearance={appearance} chip={chip} key={chip.id} />)}
      </ul>
    </section>
  );
}
