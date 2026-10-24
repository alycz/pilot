"use client";

import type { LedgerDeviceState, PilotWallet } from "@pilot/wallet";
import React from "react";

import {
  ApprovalModal,
  type ApprovalSubmission,
} from "../approval/approval-modal";
import type { BoundOwnerReviewedX402Approval } from "./x402-ledger-approval";

export type OwnerReviewedX402Submit = (input: Readonly<{
  approvalId: string;
  approvalDigest: string;
  signedBlob: string;
}>) => Promise<ApprovalSubmission>;

/**
 * Actual owner-Payment review UI. The submission callback receives only the
 * bound approval identifiers and signed blob; it has no merchant URL, headers,
 * amount, asset, or network knobs.
 */
export function OwnerReviewedX402ApprovalModal(props: Readonly<{
  open: boolean;
  bound: BoundOwnerReviewedX402Approval;
  wallet: Pick<PilotWallet, "signOnly">;
  accountIndex: number;
  deviceReady: boolean;
  deviceState: LedgerDeviceState;
  onClose(): void;
  onSubmit: OwnerReviewedX402Submit;
  onComplete?(submission: ApprovalSubmission): void;
}>) {
  if (!props.open) return null;
  const boundApprovalId = props.bound.request.approvalId;
  if (boundApprovalId === undefined) {
    throw new Error("The x402 approval identity is unavailable.");
  }
  return (
    <>
      <p className="sr-only" role="note">{props.bound.provenanceNotice}</p>
      <ApprovalModal
        open
        request={props.bound.request}
        wallet={props.wallet}
        onClose={props.onClose}
        onSubmit={(signedBlob, approvalId) => {
          if (approvalId !== boundApprovalId) {
            throw new Error("The x402 approval identity changed before relay.");
          }
          return props.onSubmit({
            approvalId: boundApprovalId,
            approvalDigest: props.bound.approvalDigest,
            signedBlob,
          });
        }}
        onComplete={props.onComplete}
        ledger={{
          accountIndex: props.accountIndex,
          deviceReady: props.deviceReady,
          deviceState: props.deviceState,
          signingMode: props.bound.review.signingMode,
        }}
      />
    </>
  );
}
