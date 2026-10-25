import {
  ledgerRuntimeProvenance,
  validateExactLedgerAction,
  type ExactLedgerActionReview,
  type LedgerRuntime,
} from "@pilot/wallet";

import type { ApprovalRequest } from "../approval/approval-modal";
import {
  X402_APPROVED_RECEIVER,
  X402_MAX_PRICE_DROPS,
  X402_RESOURCE,
} from "./x402-operation-state";

const HASH_256 = /^[A-F0-9]{64}$/;
const APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const MAX_FEE_DROPS = "100";
const MAX_LEDGER_WINDOW = 20;

/**
 * Public approval returned by the separate owner-reviewed Harbor lane. The
 * merchant URL and request headers are deliberately absent: the browser and
 * model cannot turn this into an arbitrary proxy.
 */
export type OwnerReviewedX402Approval = Readonly<{
  approvalId: string;
  approvalDigest: string;
  owner: string;
  network: "testnet";
  resource: typeof X402_RESOURCE;
  asset: "XRP";
  amountDrops: typeof X402_MAX_PRICE_DROPS;
  payTo: typeof X402_APPROVED_RECEIVER;
  quoteExpiresAt: string;
  txJson: Readonly<Record<string, unknown>>;
}>;

export type BoundOwnerReviewedX402Approval = Readonly<{
  request: ApprovalRequest;
  review: ExactLedgerActionReview;
  approvalDigest: string;
  provenanceNotice: string;
}>;

function xrpLabel(drops: string): string {
  const padded = drops.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "") || "0";
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} XRP`;
}

export async function bindOwnerReviewedX402Approval(input: Readonly<{
  approval: OwnerReviewedX402Approval;
  connectedAccount: string;
  validatedLedgerIndex: number;
  validatedAccountSequence: number;
  expectedSourceTag: number;
  runtime: LedgerRuntime;
  now?: number;
}>): Promise<BoundOwnerReviewedX402Approval> {
  const { approval } = input;
  const expiry = Date.parse(approval.quoteExpiresAt);
  const now = input.now ?? Date.now();
  if (
    !APPROVAL_ID.test(approval.approvalId) ||
    !HASH_256.test(approval.approvalDigest) ||
    approval.owner !== input.connectedAccount ||
    approval.network !== "testnet" ||
    approval.resource !== X402_RESOURCE ||
    approval.asset !== "XRP" ||
    approval.amountDrops !== X402_MAX_PRICE_DROPS ||
    approval.payTo !== X402_APPROVED_RECEIVER ||
    !Number.isFinite(expiry) || expiry <= now
  ) {
    throw new Error("The owner-reviewed x402 offer is stale or outside the trusted native-XRP scope.");
  }
  const invoiceId = approval.txJson.InvoiceID;
  if (typeof invoiceId !== "string" || !HASH_256.test(invoiceId)) {
    throw new Error("The owner-reviewed x402 Payment is missing its exact invoice binding.");
  }
  const review = await validateExactLedgerAction({
    transaction: approval.txJson,
    expectation: {
      kind: "payment",
      network: "testnet",
      account: approval.owner,
      sequence: input.validatedAccountSequence,
      validatedLedgerIndex: input.validatedLedgerIndex,
      maxLedgerWindow: MAX_LEDGER_WINDOW,
      maxFeeDrops: MAX_FEE_DROPS,
      approvalExpiresAtMs: expiry,
      quoteExpiresAtMs: expiry,
      sourceTag: input.expectedSourceTag,
      destination: X402_APPROVED_RECEIVER,
      amountDrops: X402_MAX_PRICE_DROPS,
      invoiceId,
    },
    provenance: ledgerRuntimeProvenance(input.runtime),
    now,
  });
  if (review.signingMode !== "clear") {
    throw new Error("This x402 Payment is not clear-signable and has no blind-sign fallback.");
  }
  const request: ApprovalRequest = {
    approvalId: approval.approvalId,
    expiresAt: approval.quoteExpiresAt,
    txJson: { ...approval.txJson },
    summary: {
      action: "Pay the reviewed local comparison merchant",
      amounts: [xrpLabel(X402_MAX_PRICE_DROPS)],
      destination: X402_APPROVED_RECEIVER,
      feeDrops: String(approval.txJson.Fee),
      network: "testnet",
    },
  };
  return Object.freeze({
    approvalDigest: approval.approvalDigest,
    review,
    request,
    provenanceNotice: input.runtime === "speculos"
      ? "Speculos simulation with its public default test seed; no physical Ledger is claimed."
      : "WebHID is the selected transport. The signature proves account-key control, not physical-device attestation.",
  });
}
