import type {
  NearXrpSignatureRequest,
  OwnerReviewApproval,
  PreparedXrpPayment,
  ReviewBoundXrpPayment,
} from "./types.js";
import { NEAR_CHAIN_SIGNATURES_TESTNET } from "./types.js";
import {
  assertPreparedPaymentCapability,
  assertReviewBoundPaymentCapability,
  registerReviewBoundPayment,
} from "./capability.js";
import {
  assertApprovalTime,
  assertReview,
  assertReviewBoundPayment,
  canonicalReviewBinding,
} from "./validation.js";

export function bindReviewedXrpPayment(
  prepared: PreparedXrpPayment,
  approval: OwnerReviewApproval,
): ReviewBoundXrpPayment {
  assertPreparedPaymentCapability(prepared);
  if (prepared.kind !== "near-chain-signatures/xrp-payment-prepared-v1") {
    throw new Error("invalid prepared XRP payment kind");
  }
  assertReview(prepared.review);
  const expectedBinding = canonicalReviewBinding(prepared.review);
  if (prepared.reviewBinding !== expectedBinding) {
    throw new Error("prepared XRP payment review binding is invalid");
  }
  if (approval.approvedReviewBinding !== expectedBinding) {
    throw new Error("owner approval does not match the exact reviewed XRP payment");
  }
  if (approval.nearAccountId !== prepared.review.nearAccountId) {
    throw new Error("owner approval NEAR account does not match the signer");
  }
  assertApprovalTime(approval.approvedAt);
  if (approval.approvalReference.trim().length === 0) {
    throw new Error("approvalReference is required");
  }

  return registerReviewBoundPayment(Object.freeze({
    ...prepared,
    kind: "near-chain-signatures/xrp-payment-review-bound-v1",
    approval: Object.freeze({ ...approval }),
    authorizationBoundary: "exact-review-bound; wallet-signature-still-required",
  }));
}

export function formatXrpSignatureRequest(
  payment: ReviewBoundXrpPayment,
): NearXrpSignatureRequest {
  assertReviewBoundPaymentCapability(payment);
  assertReviewBoundPayment(payment);
  const expectedBinding = canonicalReviewBinding(payment.review);

  return Object.freeze({
    kind: "near-wallet-function-call/xrp-payment-v1",
    signerId: payment.review.nearAccountId,
    receiverId: NEAR_CHAIN_SIGNATURES_TESTNET.contractId,
    actions: Object.freeze([
      Object.freeze({
        type: "FunctionCall" as const,
        params: Object.freeze({
          methodName: "sign" as const,
          args: Object.freeze({
            request: Object.freeze({
              payload_v2: Object.freeze({
                Ecdsa: payment.review.payloadHex,
              }),
              path: payment.review.derivationPath,
              domain_id: NEAR_CHAIN_SIGNATURES_TESTNET.domainId,
            }),
          }),
          gas: NEAR_CHAIN_SIGNATURES_TESTNET.gas,
          depositYoctoNear: NEAR_CHAIN_SIGNATURES_TESTNET.depositYoctoNear,
        }),
      }),
    ]) as NearXrpSignatureRequest["actions"],
    reviewBinding: expectedBinding,
  });
}
