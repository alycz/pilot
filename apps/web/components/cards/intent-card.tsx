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

export type IntentCardProps = StateCardProps & {
  /** Bounded, client-known evidence set only after the Ledger facade signs. */
  ownerSigner?: LedgerOwnerSigner | null;
};

export function IntentCard({ ownerSigner, ...props }: IntentCardProps) {
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
  if (!hasTrust && !hasOwnerSigner) return <Component {...props} />;
  return (
    <div className="min-w-0 space-y-3" data-intent-card>
      <Component {...props} />
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {hasTrust ? <TrustReceipt trust={props.event.trust} /> : null}
        {hasOwnerSigner ? <OwnerSignerChip signer={ownerSigner} /> : null}
      </div>
    </div>
  );
}
