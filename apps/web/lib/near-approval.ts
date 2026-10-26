import {
  NearApprovalBindingSchema,
  computeNearApprovalDigest,
  type NearApprovalBinding,
} from "@pilot/contracts";

export type NearApprovalReadiness =
  | "ready"
  | "invalid"
  | "digest-mismatch"
  | "approval-expired"
  | "provider-refund-window-started"
  | "signing-disabled";

export type NearApprovalReviewRow = Readonly<{
  label: string;
  value: string;
  exact?: boolean;
}>;

export type NearApprovalReview = Readonly<{
  binding?: NearApprovalBinding;
  approvalDigest?: string;
  readiness: NearApprovalReadiness;
  canSign: boolean;
  notice: string;
  rows: readonly NearApprovalReviewRow[];
}>;

function rows(binding: NearApprovalBinding): readonly NearApprovalReviewRow[] {
  return Object.freeze([
    { label: "Principal", value: binding.principal_id, exact: true },
    { label: "Wallet account", value: binding.account_id, exact: true },
    { label: "Network", value: binding.network, exact: true },
    { label: "Input asset ID", value: binding.origin_asset, exact: true },
    { label: "Input atomic amount", value: binding.amount_in, exact: true },
    { label: "Output asset ID", value: binding.destination_asset, exact: true },
    { label: "Minimum output atomic amount", value: binding.min_amount_out, exact: true },
    { label: "Recipient", value: binding.recipient, exact: true },
    { label: "Refund address", value: binding.refund_to, exact: true },
    { label: "Provider deposit address", value: binding.deposit_address, exact: true },
    {
      label: "Provider deposit memo (routing metadata; not a destination tag)",
      value: binding.deposit_memo ?? "Not supplied",
      exact: binding.deposit_memo !== undefined,
    },
    { label: "Pilot approval expires", value: binding.approval_expires_at, exact: true },
    {
      label: "Provider refund processing begins after",
      value: binding.provider_deadline_at,
      exact: true,
    },
    { label: "Verified quote ID", value: binding.quote_id, exact: true },
    { label: "Verified quote hash", value: binding.quote_hash, exact: true },
    { label: "Policy digest", value: binding.policy_digest, exact: true },
    { label: "Idempotency version", value: binding.idempotency_version, exact: true },
    { label: "Idempotency key", value: binding.idempotency_key, exact: true },
  ]);
}

/**
 * Builds a UI-only review model. This does not connect a wallet, sign, submit,
 * or treat a dry quote as executable approval evidence.
 */
export async function reviewNearIntentsApproval(input: Readonly<{
  binding: unknown;
  approvalDigest: unknown;
  signingEnabled?: boolean;
  now?: number;
}>): Promise<NearApprovalReview> {
  const parsed = NearApprovalBindingSchema.safeParse(input.binding);
  if (!parsed.success || typeof input.approvalDigest !== "string") {
    return Object.freeze({
      readiness: "invalid",
      canSign: false,
      notice: "This is not a complete, verified executable NEAR Intents quote.",
      rows: Object.freeze([]),
    });
  }
  const binding = parsed.data;
  const approvalDigest = input.approvalDigest;
  const exactRows = rows(binding);
  if (approvalDigest !== await computeNearApprovalDigest(binding)) {
    return Object.freeze({
      binding,
      approvalDigest,
      readiness: "digest-mismatch",
      canSign: false,
      notice: "The approval digest does not match the exact quote being reviewed.",
      rows: exactRows,
    });
  }
  const now = input.now ?? Date.now();
  if (Date.parse(binding.provider_deadline_at) <= now) {
    return Object.freeze({
      binding,
      approvalDigest,
      readiness: "provider-refund-window-started",
      canSign: false,
      notice: "The provider deadline was reached; refund processing may begin. Do not send a new deposit until status is reconciled.",
      rows: exactRows,
    });
  }
  if (Date.parse(binding.approval_expires_at) <= now) {
    return Object.freeze({
      binding,
      approvalDigest,
      readiness: "approval-expired",
      canSign: false,
      notice: "Pilot's approval window expired. Request and review a fresh quote.",
      rows: exactRows,
    });
  }
  if (input.signingEnabled !== true) {
    return Object.freeze({
      binding,
      approvalDigest,
      readiness: "signing-disabled",
      canSign: false,
      notice: "NEAR execution signing is disabled. This exact quote is review-only.",
      rows: exactRows,
    });
  }
  return Object.freeze({
    binding,
    approvalDigest,
    readiness: "ready",
    canSign: true,
    notice: "Review every exact field before opening the configured NEAR wallet.",
    rows: exactRows,
  });
}

