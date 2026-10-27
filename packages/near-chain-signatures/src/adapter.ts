import type {
  NearXrpTestnetAdapterOptions,
  NearXrpTestnetChainSignaturesAdapter,
  PrepareXrpPaymentInput,
  PreparedXrpPayment,
  ReviewBoundXrpPayment,
  RsvSignature,
  SignedXrpPayment,
  XrpPaymentReview,
} from "./types.js";
import {
  assertReviewBoundPaymentCapability,
  registerPreparedPayment,
} from "./capability.js";
import { NEAR_CHAIN_SIGNATURES_TESTNET } from "./types.js";
import {
  assertAmountDrops,
  assertClassicXrpAddress,
  assertDerivationPath,
  assertNearTestnetAccount,
  assertPreparedTransaction,
  assertPublicKey,
  assertReview,
  assertReviewBoundPayment,
  assertRsvSignature,
  assertSignedTransactionPreservesUnsigned,
  bytesToPayloadHex,
  canonicalReviewBinding,
} from "./validation.js";

export function createNearXrpChainSignaturesAdapter(
  options: NearXrpTestnetAdapterOptions,
): NearXrpTestnetChainSignaturesAdapter {
  const xrp = options.createOfficialXrp(NEAR_CHAIN_SIGNATURES_TESTNET);

  return Object.freeze({
    prepareXrpPayment: async (
      input: PrepareXrpPaymentInput,
    ): Promise<PreparedXrpPayment> => {
      assertNearTestnetAccount(input.nearAccountId);
      assertDerivationPath(input.derivationPath);
      assertClassicXrpAddress(input.destinationXrpAddress, "destinationXrpAddress");
      assertAmountDrops(input.amountDrops);
      assertAmountDrops(input.maxFeeDrops);

      const owner = await xrp.deriveAddressAndPublicKey(
        input.nearAccountId,
        input.derivationPath,
      );
      assertClassicXrpAddress(owner.address, "derived owner XRP address");
      assertPublicKey(owner.publicKey);
      if (owner.address === input.destinationXrpAddress) {
        throw new Error("self-payments are outside the reviewed adapter boundary");
      }

      const prepared = await xrp.prepareTransactionForSigning({
        from: owner.address,
        to: input.destinationXrpAddress,
        amount: input.amountDrops,
        publicKey: owner.publicKey,
      });
      if (prepared.hashesToSign.length !== 1) {
        throw new Error("chainsig.js must return exactly one XRP signing payload");
      }

      const serializedUnsignedTransaction =
        xrp.serializeTransaction(prepared.transaction);
      const preparedFields = assertPreparedTransaction(serializedUnsignedTransaction, {
        from: owner.address,
        to: input.destinationXrpAddress,
        amount: input.amountDrops,
        maxFeeDrops: input.maxFeeDrops,
        publicKey: owner.publicKey,
      });

      const review: XrpPaymentReview = Object.freeze({
        action: "xrp-payment",
        nearNetwork: "testnet",
        xrpNetwork: "testnet",
        nearAccountId: input.nearAccountId,
        contractId: NEAR_CHAIN_SIGNATURES_TESTNET.contractId,
        derivationPath: input.derivationPath,
        from: owner.address,
        to: input.destinationXrpAddress,
        amountDrops: input.amountDrops,
        feeDrops: preparedFields.feeDrops,
        maxFeeDrops: input.maxFeeDrops,
        sequence: preparedFields.sequence,
        lastLedgerSequence: preparedFields.lastLedgerSequence,
        signingPublicKey: owner.publicKey,
        payloadHex: bytesToPayloadHex(prepared.hashesToSign[0]!),
        serializedUnsignedTransaction,
      });
      assertReview(review);

      return registerPreparedPayment(Object.freeze({
        kind: "near-chain-signatures/xrp-payment-prepared-v1",
        review,
        reviewBinding: canonicalReviewBinding(review),
      }));
    },

    applyXrpMpcSignature: (
      payment: ReviewBoundXrpPayment,
      signatures: readonly RsvSignature[],
    ): SignedXrpPayment => {
      assertReviewBoundPaymentCapability(payment);
      assertReviewBoundPayment(payment);
      const expectedBinding = canonicalReviewBinding(payment.review);
      if (signatures.length !== 1) {
        throw new Error("exactly one MPC signature is required for an XRP payment");
      }
      assertRsvSignature(signatures[0]!);

      const transaction = xrp.deserializeTransaction(
        payment.review.serializedUnsignedTransaction,
      );
      const signedTransaction = xrp.finalizeTransactionSigning({
        transaction,
        rsvSignatures: [{ ...signatures[0]! }],
      });
      assertSignedTransactionPreservesUnsigned(
        payment.review.serializedUnsignedTransaction,
        signedTransaction,
      );

      return Object.freeze({
        kind: "near-chain-signatures/xrp-payment-signed-v1",
        reviewBinding: expectedBinding,
        signedTransaction,
        xrpSubmissionStatus: "not-submitted",
        externalStateStatus: "not-validated",
      });
    },
  });
}
