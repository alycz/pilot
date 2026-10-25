import type { CardEvent } from "@pilot/contracts";
import React from "react";

import {
  AwaitingApprovalCard,
  BlockedCard,
  DraftingCard,
  ExecutingCard,
  FailedCard,
  PlannedCard,
  PolicyCheckedCard,
  SimulatedCard,
  SubmittedCard,
  ValidatedCard,
  type StateCardProps,
} from "./state-cards";
import { OwnerSignerChip } from "./owner-signer-chip";
import { isLedgerOwnerSigner, type LedgerOwnerSigner } from "./owner-signer";
import { hasVisibleTrustReceipt, TrustReceipt } from "./trust-receipt";
import { xrplTestnetTransactionUrl } from "../../lib/xrpl-explorer";

export type IntentCardProps = StateCardProps & {
  /** Presentation-only marker for the provider-independent signed-out demo. */
  demoPresentation?: boolean;
  /** Bounded, client-known evidence set only after the Ledger facade signs. */
  ownerSigner?: LedgerOwnerSigner | null;
  /** True only for API events from a non-mock runtime, never demo/fixture/paper data. */
  realLedgerReceipt?: boolean;
};

export function testnetTransactionExplorerUrl(
  event: CardEvent,
  realLedgerReceipt: boolean,
): string | undefined {
  if (!realLedgerReceipt || event.state !== "validated" || event.intent.network !== "testnet") return undefined;
  return xrplTestnetTransactionUrl(event.hash);
}

export function IntentCard({ demoPresentation = false, ownerSigner, realLedgerReceipt = false, ...props }: IntentCardProps) {
  const components: Record<CardEvent["state"], (properties: StateCardProps) => React.JSX.Element> = {
    drafting: DraftingCard,
    planned: PlannedCard,
    simulated: SimulatedCard,
    policy_checked: PolicyCheckedCard,
    executing: ExecutingCard,
    awaiting_approval: AwaitingApprovalCard,
    blocked: BlockedCard,
    submitted: SubmittedCard,
    validated: ValidatedCard,
    failed: FailedCard,
  };
  const Component = components[props.event.state];
  const hasTrust = hasVisibleTrustReceipt(props.event.trust);
  const hasOwnerSigner = isLedgerOwnerSigner(ownerSigner);
  const explorerUrl = testnetTransactionExplorerUrl(props.event, realLedgerReceipt);
  if (!hasTrust && !hasOwnerSigner && !explorerUrl) return <Component {...props} />;
  return (
    <div className="min-w-0 space-y-3" data-intent-card>
      <Component {...props} />
      {explorerUrl ? <section aria-label="Validated XRPL Testnet receipt" className="border border-executed/35 bg-executed/[0.06] px-3 py-2 text-xs rounded-xl overflow-hidden">
        <p className="font-medium text-executed">Validated ledger transaction · XRPL Testnet</p>
        <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{props.event.hash!.toUpperCase()}</p>
        <a href={explorerUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center text-primary underline underline-offset-4">Open validated transaction in XRPL Testnet Explorer</a>
      </section> : null}
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {hasTrust ? <TrustReceipt presentation={demoPresentation ? "demo" : "default"} trust={props.event.trust} /> : null}
        {hasOwnerSigner ? <OwnerSignerChip signer={ownerSigner} /> : null}
      </div>
    </div>
  );
}
