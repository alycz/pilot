import {
  NEAR_CHAIN_SIGNATURES_TESTNET,
  type ReviewBoundXrpPayment,
  type RsvSignature,
  type XrpPaymentReview,
} from "./types.js";

const CLASSIC_XRP_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const COMPRESSED_SECP256K1_PUBLIC_KEY = /^(?:02|03)[0-9A-Fa-f]{64}$/;
const DERIVATION_PATH = /^pilot:xrp:testnet:v1:[A-Za-z0-9._-]{1,64}$/;
const NAMED_NEAR_TESTNET_ACCOUNT =
  /^(?=.{2,64}$)(?:[a-z0-9]+[-_]?)*[a-z0-9](?:\.(?:[a-z0-9]+[-_]?)*[a-z0-9])*\.testnet$/;
const IMPLICIT_NEAR_ACCOUNT = /^[0-9a-f]{64}$/;
const POSITIVE_DROPS = /^[1-9][0-9]*$/;
const HEX_32_BYTES = /^[0-9a-f]{64}$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function assertNearTestnetAccount(accountId: string): void {
  if (
    !NAMED_NEAR_TESTNET_ACCOUNT.test(accountId) &&
    !IMPLICIT_NEAR_ACCOUNT.test(accountId)
  ) {
    throw new Error("nearAccountId must be a named or implicit NEAR testnet account");
  }
}

export function assertDerivationPath(path: string): void {
  if (!DERIVATION_PATH.test(path)) {
    throw new Error(
      "derivationPath must use the network-separated pilot:xrp:testnet:v1:<label> form",
    );
  }
}

export function assertClassicXrpAddress(value: string, field: string): void {
  if (!CLASSIC_XRP_ADDRESS.test(value)) {
    throw new Error(`${field} must be a classic XRP address`);
  }
}

export function assertPublicKey(value: string): void {
  if (!COMPRESSED_SECP256K1_PUBLIC_KEY.test(value)) {
    throw new Error("derived public key must be compressed secp256k1");
  }
}

export function assertAmountDrops(value: string): void {
  if (!POSITIVE_DROPS.test(value)) {
    throw new Error("amountDrops must be a positive integer string");
  }
}

export function bytesToPayloadHex(
  payload: Uint8Array | ReadonlyArray<number>,
): string {
  const values = Array.from(payload);
  if (
    values.length !== 32 ||
    values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    throw new Error("chainsig.js must return exactly one 32-byte XRP signing payload");
  }
  return values.map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function canonicalReviewBinding(review: XrpPaymentReview): string {
  return JSON.stringify([
    "pilot.near-chain-signatures.xrp-payment.v1",
    review.nearNetwork,
    review.xrpNetwork,
    review.nearAccountId,
    review.contractId,
    review.derivationPath,
    review.from,
    review.to,
    review.amountDrops,
    review.feeDrops,
    review.maxFeeDrops,
    review.sequence,
    review.lastLedgerSequence,
    review.signingPublicKey,
    review.payloadHex,
    review.serializedUnsignedTransaction,
  ]);
}

export function assertReview(review: XrpPaymentReview): void {
  assertNearTestnetAccount(review.nearAccountId);
  assertDerivationPath(review.derivationPath);
  assertClassicXrpAddress(review.from, "from");
  assertClassicXrpAddress(review.to, "to");
  assertAmountDrops(review.amountDrops);
  assertAmountDrops(review.feeDrops);
  assertAmountDrops(review.maxFeeDrops);
  if (BigInt(review.feeDrops) > BigInt(review.maxFeeDrops)) {
    throw new Error("prepared XRP fee exceeds the reviewed maximum");
  }
  if (!Number.isInteger(review.sequence) || review.sequence < 0) {
    throw new Error("review sequence must be a non-negative integer");
  }
  if (!Number.isInteger(review.lastLedgerSequence) || review.lastLedgerSequence <= 0) {
    throw new Error("review lastLedgerSequence must be a positive integer");
  }
  assertPublicKey(review.signingPublicKey);
  if (!HEX_32_BYTES.test(review.payloadHex)) {
    throw new Error("payloadHex must contain exactly 32 bytes");
  }
  if (review.nearNetwork !== "testnet" || review.xrpNetwork !== "testnet") {
    throw new Error("only NEAR testnet and XRP testnet are supported");
  }
  if (review.contractId !== NEAR_CHAIN_SIGNATURES_TESTNET.contractId) {
    throw new Error("unsupported Chain Signatures contract");
  }
}

export function assertApprovalTime(value: string): void {
  if (!ISO_WITH_OFFSET.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error("approvedAt must be an ISO-8601 timestamp with an offset");
  }
}

export function assertReviewBoundPayment(value: ReviewBoundXrpPayment): void {
  if (value.kind !== "near-chain-signatures/xrp-payment-review-bound-v1") {
    throw new Error("invalid review-bound XRP payment kind");
  }
  if (
    value.authorizationBoundary !==
    "exact-review-bound; wallet-signature-still-required"
  ) {
    throw new Error("invalid XRP payment authorization boundary");
  }
  assertReview(value.review);
  const expectedBinding = canonicalReviewBinding(value.review);
  if (
    value.reviewBinding !== expectedBinding ||
    value.approval.approvedReviewBinding !== expectedBinding
  ) {
    throw new Error("review binding no longer matches the prepared XRP payment");
  }
  if (value.approval.nearAccountId !== value.review.nearAccountId) {
    throw new Error("owner approval NEAR account does not match the signer");
  }
  assertApprovalTime(value.approval.approvedAt);
  if (value.approval.approvalReference.trim().length === 0) {
    throw new Error("approvalReference is required");
  }
}

export function assertRsvSignature(signature: RsvSignature): void {
  if (!/^[0-9A-Fa-f]{64}$/.test(signature.r)) {
    throw new Error("MPC signature r must be 32-byte hex");
  }
  if (!/^[0-9A-Fa-f]{64}$/.test(signature.s)) {
    throw new Error("MPC signature s must be 32-byte hex");
  }
  if (!Number.isInteger(signature.v) || signature.v < 0 || signature.v > 255) {
    throw new Error("MPC signature v must be a byte integer");
  }
}

export function assertPreparedTransaction(
  serialized: string,
  expected: {
    from: string;
    to: string;
    amount: string;
    maxFeeDrops: string;
    publicKey: string;
  },
): { feeDrops: string; sequence: number; lastLedgerSequence: number } {
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(serialized);
  } catch {
    throw new Error("chainsig.js returned a non-JSON unsigned XRP transaction");
  }
  if (!isRecord(wrapper) || !isRecord(wrapper.transaction)) {
    throw new Error("chainsig.js returned an invalid unsigned XRP transaction");
  }
  const transaction = wrapper.transaction;
  const exactFields = {
    TransactionType: "Payment",
    Account: expected.from,
    Destination: expected.to,
    Amount: expected.amount,
    SigningPubKey: expected.publicKey.toUpperCase(),
  } as const;
  for (const [field, value] of Object.entries(exactFields)) {
    if (transaction[field] !== value) {
      throw new Error(`prepared XRP transaction changed reviewed field: ${field}`);
    }
  }
  if (wrapper.signingPubKey !== expected.publicKey) {
    throw new Error("prepared XRP transaction changed the signing public key");
  }
  if ("TxnSignature" in transaction) {
    throw new Error("prepared XRP transaction must be unsigned");
  }
  const allowedFields = new Set([
    "TransactionType",
    "Account",
    "Destination",
    "Amount",
    "SigningPubKey",
    "Fee",
    "Sequence",
    "LastLedgerSequence",
  ]);
  for (const field of Object.keys(transaction)) {
    if (!allowedFields.has(field)) {
      throw new Error(`prepared XRP transaction added an unreviewed field: ${field}`);
    }
  }
  if (!/^[1-9][0-9]*$/.test(String(transaction.Fee ?? ""))) {
    throw new Error("prepared XRP transaction must include a positive integer Fee");
  }
  if (
    !Number.isInteger(transaction.Sequence) ||
    Number(transaction.Sequence) < 0
  ) {
    throw new Error("prepared XRP transaction must include a valid Sequence");
  }
  if (
    !Number.isInteger(transaction.LastLedgerSequence) ||
    Number(transaction.LastLedgerSequence) <= 0
  ) {
    throw new Error(
      "prepared XRP transaction must include a positive LastLedgerSequence",
    );
  }
  const feeDrops = String(transaction.Fee);
  if (BigInt(feeDrops) > BigInt(expected.maxFeeDrops)) {
    throw new Error("prepared XRP fee exceeds the reviewed maximum");
  }
  return {
    feeDrops,
    sequence: Number(transaction.Sequence),
    lastLedgerSequence: Number(transaction.LastLedgerSequence),
  };
}

export function assertSignedTransactionPreservesUnsigned(
  serializedUnsigned: string,
  serializedSigned: string,
): void {
  let unsignedWrapper: unknown;
  let signed: unknown;
  try {
    unsignedWrapper = JSON.parse(serializedUnsigned);
    signed = JSON.parse(serializedSigned);
  } catch {
    throw new Error("chainsig.js returned a non-JSON signed XRP transaction");
  }
  if (
    !isRecord(unsignedWrapper) ||
    !isRecord(unsignedWrapper.transaction) ||
    !isRecord(signed)
  ) {
    throw new Error("chainsig.js returned an invalid signed XRP transaction");
  }
  const unsigned = unsignedWrapper.transaction;
  for (const [field, value] of Object.entries(unsigned)) {
    if (JSON.stringify(signed[field]) !== JSON.stringify(value)) {
      throw new Error(`signed XRP transaction changed reviewed field: ${field}`);
    }
  }
  const allowedFields = new Set([...Object.keys(unsigned), "TxnSignature"]);
  for (const field of Object.keys(signed)) {
    if (!allowedFields.has(field)) {
      throw new Error(`signed XRP transaction added an unreviewed field: ${field}`);
    }
  }
  if (
    typeof signed.TxnSignature !== "string" ||
    !/^30(?:[0-9A-F]{2})+$/.test(signed.TxnSignature)
  ) {
    throw new Error("signed XRP transaction is missing an uppercase hex TxnSignature");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
