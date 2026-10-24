"use client";

import { ClipboardCheck } from "lucide-react";

import {
  evaluateCopilotActionAvailability,
  type CopilotActionContext,
  type ValidatedQuoteBinding,
} from "../copilot/action-context";
import { DetailGrid } from "./card-frame";

export function actionPreparationDetails(
  context: CopilotActionContext,
  runtimeNetwork: CopilotActionContext["network"],
  now: number,
  validatedQuoteBinding?: ValidatedQuoteBinding,
) {
  const availability = evaluateCopilotActionAvailability(context, {
    runtimeNetwork,
    now,
    validatedQuoteBinding,
  });
  const quote = context.quoteEvidence;
  const ageSeconds = Math.max(0, Math.floor((now - Date.parse(quote.observedAt)) / 1_000));
  const costs = [
    quote.networkFeeDrops ? `${quote.networkFeeDrops} drops network` : undefined,
    quote.tradingFeeBps === undefined ? undefined : `${quote.tradingFeeBps} bps trading`,
  ].filter(Boolean).join(" + ") || "Not supplied";
  const movement = [
    quote.slippageBps === undefined ? undefined : `${quote.slippageBps} bps slippage`,
    quote.priceImpactBps === undefined ? undefined : `${quote.priceImpactBps} bps impact`,
  ].filter(Boolean).join(" · ") || "Not supplied";
  const nextApproval = availability.mode === "executable"
    ? "Fresh builder + simulation, then explicit wallet approval"
    : availability.mode === "prepare-only"
      ? "Builder available; exact wallet approval binding pending"
      : availability.mode === "research-only"
        ? "Research only · cannot submit"
        : availability.reasons[0]?.detail ?? "Refresh the market context";
  return {
    availability,
    items: [
      { label: "Asset / amount", value: `${context.amount} ${context.base.currency} → ${context.quote.currency}` },
      { label: "Route", value: context.route.replace("-", " ") },
      { label: "Quote age", value: `${ageSeconds}s · ${quote.status === "demo" ? "demo fixture" : quote.source}` },
      { label: "Fees", value: costs },
      { label: "Slippage / impact", value: movement },
      { label: "Liquidity", value: quote.liquidity.available
        ? quote.liquidity.inputCapacity ? `Up to ${quote.liquidity.inputCapacity} ${context.base.currency}` : "Available"
        : quote.liquidity.detail ?? "Unavailable" },
      { label: "Network", value: context.network },
      { label: "Next approval", value: nextApproval },
    ],
  };
}

export function ActionPreparationCard({
  context,
  runtimeNetwork,
  now = Date.now(),
  validatedQuoteBinding,
}: {
  context: CopilotActionContext;
  runtimeNetwork: CopilotActionContext["network"];
  now?: number;
  validatedQuoteBinding?: ValidatedQuoteBinding;
}) {
  const { availability, items } = actionPreparationDetails(
    context,
    runtimeNetwork,
    now,
    validatedQuoteBinding,
  );
  return (
    <article aria-labelledby="action-preparation-title" className="min-w-0 overflow-hidden border border-border bg-card">
      <div className="flex min-w-0 items-start gap-3 p-4">
        <span className="grid size-8 shrink-0 place-items-center border border-info/30 text-info">
          <ClipboardCheck className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="action-preparation-title" className="text-sm font-medium">
            {availability.mode === "executable" || availability.mode === "prepare-only"
              ? "Action preparation"
              : "Action context review"}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Market context is review input, not permission. Pilot must rebuild against current data before any approval.</p>
          <span className="mt-2 inline-block border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {availability.mode.replace("-", " ")}
          </span>
        </div>
      </div>
      <div className="border-t border-border p-4">
        <DetailGrid items={items} />
        {availability.reasons.length ? (
          <ul className="mt-3 space-y-1 text-[11px] leading-4 text-muted-foreground">
            {availability.reasons.map((reason) => <li key={reason.code}>{reason.detail}</li>)}
          </ul>
        ) : null}
      </div>
    </article>
  );
}
