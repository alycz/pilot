import type {
  NearSignatureBoundaryStatus,
  NearSignatureObservation,
} from "./types.js";

export function classifyNearSignatureStatus(
  observation: NearSignatureObservation,
  expectedReviewBinding: string,
): NearSignatureBoundaryStatus {
  const base = {
    xrpSubmissionStatus: "not-submitted" as const,
    externalStateStatus: "not-validated" as const,
  };

  if (expectedReviewBinding.length === 0) {
    throw new Error("expectedReviewBinding is required");
  }
  if (
    "reviewBinding" in observation &&
    observation.reviewBinding !== expectedReviewBinding
  ) {
    return {
      ...base,
      stage: "unknown",
      nearTransactionStatus: "unknown",
      signatureStatus: "unknown",
    };
  }

  switch (observation.kind) {
    case "not-requested":
      return {
        ...base,
        stage: "approval-required",
        nearTransactionStatus: "not-submitted",
        signatureStatus: "not-requested",
      };
    case "wallet-pending":
      return {
        ...base,
        stage: "wallet-pending",
        nearTransactionStatus: "not-submitted",
        signatureStatus: "pending",
      };
    case "near-transaction-submitted":
      if (observation.nearTransactionHash.trim().length === 0) {
        return unknownStatus(base);
      }
      return {
        ...base,
        stage: "near-pending",
        nearTransactionStatus: "pending",
        signatureStatus: "pending",
        nearTransactionHash: observation.nearTransactionHash,
      };
    case "near-final-success-no-signature":
      if (observation.nearTransactionHash.trim().length === 0) {
        return unknownStatus(base);
      }
      return {
        ...base,
        stage: "unknown",
        nearTransactionStatus: "final-success",
        signatureStatus: "unknown",
        nearTransactionHash: observation.nearTransactionHash,
      };
    case "signature-returned":
      if (
        observation.signatureCount !== 1 ||
        observation.nearTransactionHash.trim().length === 0
      ) {
        return unknownStatus(base);
      }
      return {
        ...base,
        stage: "signature-ready",
        nearTransactionStatus: "final-success",
        signatureStatus: "ready",
        nearTransactionHash: observation.nearTransactionHash,
      };
    case "near-final-failure":
      if (
        observation.errorCode.trim().length === 0 ||
        observation.nearTransactionHash?.trim().length === 0
      ) {
        return unknownStatus(base);
      }
      return {
        ...base,
        stage: "failed",
        nearTransactionStatus: "final-failure",
        signatureStatus: "failed",
        ...(observation.nearTransactionHash
          ? { nearTransactionHash: observation.nearTransactionHash }
          : {}),
        errorCode: observation.errorCode,
      };
    case "outcome-unknown":
      return {
        ...base,
        stage: "unknown",
        nearTransactionStatus: "unknown",
        signatureStatus: "unknown",
      };
  }
}

function unknownStatus(base: {
  xrpSubmissionStatus: "not-submitted";
  externalStateStatus: "not-validated";
}): NearSignatureBoundaryStatus {
  return {
    ...base,
    stage: "unknown",
    nearTransactionStatus: "unknown",
    signatureStatus: "unknown",
  };
}
