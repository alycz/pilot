/** The only reviewed Chain Signatures deployment supported by this package. */
export const NEAR_CHAIN_SIGNATURES_TESTNET = Object.freeze({
  library: "chainsig.js",
  libraryVersion: "1.1.16",
  nearNetwork: "testnet",
  contractId: "v1.signer-prod.testnet",
  xrpNetwork: "testnet",
  xrpRpcUrl: "https://s.altnet.rippletest.net:51234",
  keyType: "Ecdsa",
  domainId: 0,
  gas: "300000000000000",
  depositYoctoNear: "1",
} as const);

export type NearChainSignaturesTestnetCompatibility =
  typeof NEAR_CHAIN_SIGNATURES_TESTNET;

export interface XrpUnsignedTransaction {
  transaction: Record<string, unknown>;
  signingPubKey: string;
}

export interface RsvSignature {
  r: string;
  s: string;
  v: number;
}

/**
 * The deliberately small structural surface used from the official chainsig.js
 * XRP adapter. In particular, broadcastTx and the generic MPC sign method are
 * not reachable through this port.
 */
export interface OfficialChainsigXrpPort {
  deriveAddressAndPublicKey(
    predecessor: string,
    path: string,
  ): Promise<{ address: string; publicKey: string }>;
  prepareTransactionForSigning(request: {
    from: string;
    to: string;
    amount: string;
    publicKey: string;
  }): Promise<{
    transaction: XrpUnsignedTransaction;
    hashesToSign: ReadonlyArray<Uint8Array | ReadonlyArray<number>>;
  }>;
  serializeTransaction(transaction: XrpUnsignedTransaction): string;
  deserializeTransaction(serialized: string): XrpUnsignedTransaction;
  finalizeTransactionSigning(input: {
    transaction: XrpUnsignedTransaction;
    rsvSignatures: RsvSignature[];
  }): string;
}

export interface NearXrpTestnetAdapterOptions {
  /** Trusted integration factory; Pilot always supplies the pinned config. */
  createOfficialXrp: (
    compatibility: NearChainSignaturesTestnetCompatibility,
  ) => OfficialChainsigXrpPort;
}

export interface PrepareXrpPaymentInput {
  nearAccountId: string;
  derivationPath: string;
  destinationXrpAddress: string;
  amountDrops: string;
  maxFeeDrops: string;
}

export interface XrpPaymentReview {
  action: "xrp-payment";
  nearNetwork: "testnet";
  xrpNetwork: "testnet";
  nearAccountId: string;
  contractId: "v1.signer-prod.testnet";
  derivationPath: string;
  from: string;
  to: string;
  amountDrops: string;
  feeDrops: string;
  maxFeeDrops: string;
  sequence: number;
  lastLedgerSequence: number;
  signingPublicKey: string;
  payloadHex: string;
  serializedUnsignedTransaction: string;
}

export interface PreparedXrpPayment {
  kind: "near-chain-signatures/xrp-payment-prepared-v1";
  review: Readonly<XrpPaymentReview>;
  /** Exact canonical review bytes, not a lossy summary or display-only hash. */
  reviewBinding: string;
}

export interface OwnerReviewApproval {
  nearAccountId: string;
  approvedReviewBinding: string;
  approvedAt: string;
  /** Opaque reference from the owner-review boundary; not validated here. */
  approvalReference: string;
}

export interface ReviewBoundXrpPayment
  extends Omit<PreparedXrpPayment, "kind"> {
  kind: "near-chain-signatures/xrp-payment-review-bound-v1";
  approval: Readonly<OwnerReviewApproval>;
  authorizationBoundary: "exact-review-bound; wallet-signature-still-required";
}

export interface NearXrpSignatureRequest {
  kind: "near-wallet-function-call/xrp-payment-v1";
  signerId: string;
  receiverId: "v1.signer-prod.testnet";
  actions: readonly [
    {
      type: "FunctionCall";
      params: {
        methodName: "sign";
        args: {
          request: {
            payload_v2: { Ecdsa: string };
            path: string;
            domain_id: 0;
          };
        };
        /** NEAR function-call gas. This is never an XRP/trade budget. */
        gas: "300000000000000";
        depositYoctoNear: "1";
      };
    },
  ];
  reviewBinding: string;
}

export interface SignedXrpPayment {
  kind: "near-chain-signatures/xrp-payment-signed-v1";
  reviewBinding: string;
  signedTransaction: string;
  xrpSubmissionStatus: "not-submitted";
  externalStateStatus: "not-validated";
}

export type NearSignatureObservation =
  | { kind: "not-requested" }
  | { kind: "wallet-pending"; reviewBinding: string }
  | {
      kind: "near-transaction-submitted";
      reviewBinding: string;
      nearTransactionHash: string;
    }
  | {
      kind: "near-final-success-no-signature";
      reviewBinding: string;
      nearTransactionHash: string;
    }
  | {
      kind: "signature-returned";
      reviewBinding: string;
      nearTransactionHash: string;
      signatureCount: number;
    }
  | {
      kind: "near-final-failure";
      reviewBinding: string;
      nearTransactionHash?: string;
      errorCode: string;
    }
  | { kind: "outcome-unknown"; reviewBinding?: string; reason: string };

export interface NearSignatureBoundaryStatus {
  stage:
    | "approval-required"
    | "wallet-pending"
    | "near-pending"
    | "signature-ready"
    | "failed"
    | "unknown";
  nearTransactionStatus:
    | "not-submitted"
    | "pending"
    | "final-success"
    | "final-failure"
    | "unknown";
  signatureStatus: "not-requested" | "pending" | "ready" | "failed" | "unknown";
  xrpSubmissionStatus: "not-submitted";
  externalStateStatus: "not-validated";
  nearTransactionHash?: string;
  errorCode?: string;
}

export interface NearXrpTestnetChainSignaturesAdapter {
  prepareXrpPayment(input: PrepareXrpPaymentInput): Promise<PreparedXrpPayment>;
  applyXrpMpcSignature(
    payment: ReviewBoundXrpPayment,
    signatures: readonly RsvSignature[],
  ): SignedXrpPayment;
}
