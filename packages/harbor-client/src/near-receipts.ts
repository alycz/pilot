/** Pure verification of normalized receipt evidence; this module performs no RPC calls. */

export type ReceiptRejectionCode =
  | "INVALID_EVIDENCE" | "UNTRUSTED_RPC" | "WRONG_CHAIN" | "WRONG_TRANSACTION"
  | "NONFINAL" | "REVERTED" | "WRONG_SENDER" | "WRONG_RECIPIENT"
  | "WRONG_TOKEN" | "WRONG_AMOUNT" | "MEMO_NOT_ALLOWED" | "AMBIGUOUS_TRANSFER";

export type ReceiptVerificationFailure = Readonly<{
  ok: false;
  settlement_eligible: false;
  code: ReceiptRejectionCode;
  message: string;
}>;

export type NearNativeTransferExpectation = Readonly<{
  network: "near:mainnet";
  trusted_rpc_endpoint_id: string;
  owner_account: string;
  deposit_address: string;
  amount_yocto: string;
  wallet_callback_transaction_hash?: string;
}>;

export type NearFinalNativeTransferEvidence = Readonly<{
  version: "pilot-near-final-native-transfer-v1";
  rpc_endpoint_id: string;
  network: "near:mainnet";
  finality: "final";
  execution_status: "success";
  transaction_hash: string;
  receipt_id: string;
  signer_id: string;
  receiver_id: string;
  actions: readonly [Readonly<{ kind: "TRANSFER"; deposit_yocto: string }>];
  memo: null;
  block_height: number;
  block_hash: string;
  included_at: string;
  verified_at: string;
}>;

export type VerifiedNearNativeTransfer = Readonly<{
  ok: true;
  kind: "near-native-transfer";
  settlement_eligible: true;
  evidence: NearFinalNativeTransferEvidence;
  evidence_key: string;
  canonical_binding: string;
}>;

export type ArbitrumUsdcTransferExpectation = Readonly<{
  chain_id: 42161;
  trusted_rpc_endpoint_id: string;
  token_contract: string;
  recipient: string;
  minimum_amount_atomic: string;
  transaction_hash?: string;
}>;

export type ArbitrumTransferLog = Readonly<{
  event: "Transfer";
  token_contract: string;
  from: string;
  to: string;
  value_atomic: string;
  log_index: number;
}>;

export type ArbitrumFinalErc20ReceiptEvidence = Readonly<{
  version: "pilot-arbitrum-final-erc20-transfer-v1";
  rpc_endpoint_id: string;
  chain_id: 42161;
  finality: "final";
  receipt_status: "success";
  transaction_hash: string;
  block_number: number;
  block_hash: string;
  transfers: readonly ArbitrumTransferLog[];
  verified_at: string;
}>;

export type VerifiedArbitrumUsdcTransfer = Readonly<{
  ok: true;
  kind: "arbitrum-usdc-transfer";
  settlement_eligible: true;
  evidence: ArbitrumFinalErc20ReceiptEvidence;
  matched_transfer: ArbitrumTransferLog;
  evidence_key: string;
  canonical_binding: string;
}>;

export type VerifiedChainReceipt = VerifiedNearNativeTransfer | VerifiedArbitrumUsdcTransfer;
export type ReceiptVerificationResult<T extends VerifiedChainReceipt> = T | ReceiptVerificationFailure;

/** Implementations may call RPC; the verifier deliberately accepts only their normalized output. */
export interface NearFinalReceiptEvidencePort {
  readFinalNativeTransfer(transactionHash: string): Promise<unknown>;
}

export interface ArbitrumFinalReceiptEvidencePort {
  readFinalErc20Receipt(transactionHash: string): Promise<unknown>;
}

type UnknownRecord = Record<string, unknown>;
type ParsedNearEvidence = Omit<NearFinalNativeTransferEvidence, "network" | "finality" | "execution_status" | "memo"> & {
  network: "near:mainnet" | "near:testnet";
  finality: "final" | "optimistic";
  execution_status: "success" | "failure" | "unknown";
  memo: string | null;
};
type ParsedArbitrumEvidence = Omit<ArbitrumFinalErc20ReceiptEvidence, "chain_id" | "finality" | "receipt_status"> & {
  chain_id: number;
  finality: "final" | "pending";
  receipt_status: "success" | "reverted" | "unknown";
};

function fail(code: ReceiptRejectionCode, message: string): ReceiptVerificationFailure {
  return { ok: false, settlement_eligible: false, code, message };
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isNearAccount(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9._-]{2,64}$/.test(value);
}

function isAtomicAmount(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,127}$/.test(value);
}

function isNearHash(value: unknown): value is string {
  return typeof value === "string" && value.length >= 43 && value.length <= 45 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9A-Fa-f]{40}$/.test(value);
}

function isEvmHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9A-Fa-f]{64}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const components = [year, month, day, hour, minute, second].map(Number);
  const [y, m, d, h, min, s] = components;
  if (h > 23 || min > 59 || s > 59) return false;
  const normalized = new Date(Date.UTC(y, m - 1, d, h, min, s));
  return Number.isFinite(Date.parse(value)) && normalized.getUTCFullYear() === y &&
    normalized.getUTCMonth() === m - 1 && normalized.getUTCDate() === d;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function parseNearEvidence(value: unknown): ParsedNearEvidence | ReceiptVerificationFailure {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "rpc_endpoint_id", "network", "finality", "execution_status",
    "transaction_hash", "receipt_id", "signer_id", "receiver_id", "actions", "memo",
    "block_height", "block_hash", "included_at", "verified_at",
  ])) return fail("INVALID_EVIDENCE", "NEAR receipt evidence must use the exact normalized shape");
  if (
    value.version !== "pilot-near-final-native-transfer-v1" || !isSafeId(value.rpc_endpoint_id) ||
    (value.network !== "near:mainnet" && value.network !== "near:testnet") ||
    (value.finality !== "final" && value.finality !== "optimistic") ||
    (value.execution_status !== "success" && value.execution_status !== "failure" && value.execution_status !== "unknown") ||
    !isNearHash(value.transaction_hash) || !isNearHash(value.receipt_id) ||
    !isNearAccount(value.signer_id) || !isNearAccount(value.receiver_id) ||
    !Array.isArray(value.actions) || value.actions.length !== 1 ||
    (value.memo !== null && (typeof value.memo !== "string" || value.memo.length === 0 || value.memo.length > 512)) ||
    !isPositiveInteger(value.block_height) || !isNearHash(value.block_hash) ||
    !isIsoDate(value.included_at) || !isIsoDate(value.verified_at) ||
    Date.parse(value.included_at) > Date.parse(value.verified_at)
  ) return fail("INVALID_EVIDENCE", "NEAR receipt evidence contains invalid normalized fields");
  const action = value.actions[0];
  if (!isRecord(action) || !exactKeys(action, ["kind", "deposit_yocto"]) || action.kind !== "TRANSFER" || !isAtomicAmount(action.deposit_yocto)) {
    return fail("INVALID_EVIDENCE", "NEAR receipt must contain exactly one normalized native transfer action");
  }
  return value as unknown as ParsedNearEvidence;
}

export function verifyFinalizedNearNativeTransfer(
  expected: NearNativeTransferExpectation,
  rawEvidence: unknown,
): ReceiptVerificationResult<VerifiedNearNativeTransfer> {
  if (
    expected.network !== "near:mainnet" || !isSafeId(expected.trusted_rpc_endpoint_id) ||
    !isNearAccount(expected.owner_account) || !isNearAccount(expected.deposit_address) ||
    !isAtomicAmount(expected.amount_yocto) ||
    (expected.wallet_callback_transaction_hash !== undefined && !isNearHash(expected.wallet_callback_transaction_hash))
  ) return fail("INVALID_EVIDENCE", "NEAR verification expectation is invalid");
  const evidence = parseNearEvidence(rawEvidence);
  if ("ok" in evidence) return evidence;
  if (evidence.rpc_endpoint_id !== expected.trusted_rpc_endpoint_id) return fail("UNTRUSTED_RPC", "NEAR evidence did not come from the configured trusted RPC");
  if (evidence.network !== expected.network) return fail("WRONG_CHAIN", "NEAR evidence is for the wrong network");
  if (evidence.finality !== "final") return fail("NONFINAL", "NEAR evidence is not final");
  if (evidence.execution_status !== "success") return fail("REVERTED", "NEAR execution did not succeed");
  if (expected.wallet_callback_transaction_hash !== undefined && evidence.transaction_hash !== expected.wallet_callback_transaction_hash) return fail("WRONG_TRANSACTION", "Final NEAR evidence does not match the wallet callback transaction hash");
  if (evidence.signer_id !== expected.owner_account) return fail("WRONG_SENDER", "NEAR transfer signer does not match the owner account");
  if (evidence.receiver_id !== expected.deposit_address) return fail("WRONG_RECIPIENT", "NEAR transfer receiver does not match the deposit address");
  if (evidence.memo !== null) return fail("MEMO_NOT_ALLOWED", "NEAR native transfer must not contain memo routing");
  if (evidence.actions[0].deposit_yocto !== expected.amount_yocto) return fail("WRONG_AMOUNT", "NEAR transfer amount does not match the reviewed amount");
  const finalEvidence = evidence as NearFinalNativeTransferEvidence;
  const canonicalBinding = JSON.stringify({
    network: evidence.network, transaction_hash: evidence.transaction_hash, receipt_id: evidence.receipt_id,
    signer_id: evidence.signer_id,
    receiver_id: evidence.receiver_id, amount_yocto: evidence.actions[0].deposit_yocto,
    block_height: evidence.block_height, block_hash: evidence.block_hash, included_at: evidence.included_at,
  });
  return {
    ok: true, kind: "near-native-transfer", settlement_eligible: true, evidence: finalEvidence,
    evidence_key: `${evidence.network}:${evidence.transaction_hash}`, canonical_binding: canonicalBinding,
  };
}

function parseArbitrumEvidence(value: unknown): ParsedArbitrumEvidence | ReceiptVerificationFailure {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "rpc_endpoint_id", "chain_id", "finality", "receipt_status",
    "transaction_hash", "block_number", "block_hash", "transfers", "verified_at",
  ])) return fail("INVALID_EVIDENCE", "Arbitrum receipt evidence must use the exact normalized shape");
  if (
    value.version !== "pilot-arbitrum-final-erc20-transfer-v1" || !isSafeId(value.rpc_endpoint_id) ||
    !Number.isSafeInteger(value.chain_id) || (value.finality !== "final" && value.finality !== "pending") ||
    (value.receipt_status !== "success" && value.receipt_status !== "reverted" && value.receipt_status !== "unknown") ||
    !isEvmHash(value.transaction_hash) || !isPositiveInteger(value.block_number) || !isEvmHash(value.block_hash) ||
    !Array.isArray(value.transfers) || value.transfers.length > 256 || !isIsoDate(value.verified_at)
  ) return fail("INVALID_EVIDENCE", "Arbitrum receipt evidence contains invalid normalized fields");
  for (const transfer of value.transfers) {
    if (!isRecord(transfer) || !exactKeys(transfer, ["event", "token_contract", "from", "to", "value_atomic", "log_index"]) ||
      transfer.event !== "Transfer" || !isEvmAddress(transfer.token_contract) || !isEvmAddress(transfer.from) ||
      !isEvmAddress(transfer.to) || !isAtomicAmount(transfer.value_atomic) ||
      typeof transfer.log_index !== "number" || !Number.isSafeInteger(transfer.log_index) || transfer.log_index < 0) {
      return fail("INVALID_EVIDENCE", "Arbitrum receipt contains an invalid normalized Transfer log");
    }
  }
  return value as unknown as ParsedArbitrumEvidence;
}

export function verifyFinalizedArbitrumErc20Transfer(
  expected: ArbitrumUsdcTransferExpectation,
  rawEvidence: unknown,
): ReceiptVerificationResult<VerifiedArbitrumUsdcTransfer> {
  if (
    expected.chain_id !== 42161 || !isSafeId(expected.trusted_rpc_endpoint_id) ||
    !isEvmAddress(expected.token_contract) || !isEvmAddress(expected.recipient) ||
    !isAtomicAmount(expected.minimum_amount_atomic) ||
    (expected.transaction_hash !== undefined && !isEvmHash(expected.transaction_hash))
  ) return fail("INVALID_EVIDENCE", "Arbitrum verification expectation is invalid");
  const evidence = parseArbitrumEvidence(rawEvidence);
  if ("ok" in evidence) return evidence;
  if (evidence.rpc_endpoint_id !== expected.trusted_rpc_endpoint_id) return fail("UNTRUSTED_RPC", "Arbitrum evidence did not come from the configured trusted RPC");
  if (evidence.chain_id !== expected.chain_id) return fail("WRONG_CHAIN", "Arbitrum evidence is for the wrong chain id");
  if (evidence.finality !== "final") return fail("NONFINAL", "Arbitrum receipt is not final");
  if (evidence.receipt_status !== "success") return fail("REVERTED", "Arbitrum receipt did not succeed");
  if (expected.transaction_hash !== undefined && lower(evidence.transaction_hash) !== lower(expected.transaction_hash)) return fail("WRONG_TRANSACTION", "Arbitrum receipt does not match the expected transaction hash");
  const tokenLogs = evidence.transfers.filter((transfer) => lower(transfer.token_contract) === lower(expected.token_contract));
  if (tokenLogs.length === 0) return fail("WRONG_TOKEN", "Arbitrum receipt has no Transfer for the reviewed token contract");
  const recipientLogs = tokenLogs.filter((transfer) => lower(transfer.to) === lower(expected.recipient));
  if (recipientLogs.length === 0) return fail("WRONG_RECIPIENT", "Arbitrum token transfer recipient does not match the reviewed recipient");
  const sufficientLogs = recipientLogs.filter((transfer) => BigInt(transfer.value_atomic) >= BigInt(expected.minimum_amount_atomic));
  if (sufficientLogs.length === 0) return fail("WRONG_AMOUNT", "Arbitrum token transfer is below the reviewed minimum output");
  if (sufficientLogs.length !== 1) return fail("AMBIGUOUS_TRANSFER", "Arbitrum receipt has multiple matching token transfers");
  const matchedTransfer = sufficientLogs[0];
  const finalEvidence = evidence as ArbitrumFinalErc20ReceiptEvidence;
  const canonicalBinding = JSON.stringify({
    chain_id: evidence.chain_id, transaction_hash: lower(evidence.transaction_hash),
    token_contract: lower(matchedTransfer.token_contract), sender: lower(matchedTransfer.from),
    recipient: lower(matchedTransfer.to), value_atomic: matchedTransfer.value_atomic,
    log_index: matchedTransfer.log_index, block_number: evidence.block_number, block_hash: lower(evidence.block_hash),
  });
  return {
    ok: true, kind: "arbitrum-usdc-transfer", settlement_eligible: true, evidence: finalEvidence, matched_transfer: matchedTransfer,
    evidence_key: `eip155:${evidence.chain_id}:${lower(evidence.transaction_hash)}`, canonical_binding: canonicalBinding,
  };
}

export type ReceiptReplayDecision =
  | Readonly<{ decision: "new"; evidence: VerifiedChainReceipt }>
  | Readonly<{ decision: "duplicate"; settlement_eligible: false; evidence_key: string }>
  | Readonly<{ decision: "conflict"; settlement_eligible: false; evidence_key: string }>;

export function classifyReceiptReplay(
  existing: readonly VerifiedChainReceipt[],
  candidate: VerifiedChainReceipt,
): ReceiptReplayDecision {
  const sameKey = existing.filter((entry) => entry.evidence_key === candidate.evidence_key);
  if (sameKey.length === 0) return { decision: "new", evidence: candidate };
  return sameKey.every((entry) => entry.canonical_binding === candidate.canonical_binding)
    ? { decision: "duplicate", settlement_eligible: false, evidence_key: candidate.evidence_key }
    : { decision: "conflict", settlement_eligible: false, evidence_key: candidate.evidence_key };
}
