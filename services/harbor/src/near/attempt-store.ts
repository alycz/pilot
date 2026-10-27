const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ACCOUNT_ID = /^[a-z0-9._-]{2,64}$/;
const DIGEST = /^[A-F0-9]{64}$/;
const QUOTE_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,45}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*:\S{1,319}$/;
const ATOMIC = /^(?:0|[1-9][0-9]*)$/;
const ARBITRUM_ADDRESS = /^0x[0-9A-Fa-f]{40}$/;
const ARBITRUM_TRANSACTION = /^0x[0-9A-Fa-f]{64}$/;
const NEAR_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,45}$/;
const MAX_ATOMIC_DIGITS = 128;
const MAX_CONTENTION_RETRIES = 8;
const ARBITRUM_USDC_CONTRACT = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const ARBITRUM_USDC_ASSET =
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const WRAPPED_NEAR_ASSET = "nep141:wrap.near";

export type NearHostedAttemptState =
  | "approved"
  | "unknown"
  | "pending"
  | "settled"
  | "refunded"
  | "failed";

export type NearHostedReservationState =
  | "reserved"
  | "outcome_unknown"
  | "committed"
  | "released";

export type NearHostedProviderStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export type NearHostedUnknownReason =
  | "timeout"
  | "transport_error"
  | "not_found"
  | "invalid_response"
  | "unavailable";

export type NearHostedReserveInput = Readonly<{
  accountId: string;
  authorizationId: string;
  authorizationExpiresAt: string;
  idempotencyVersion: "pilot-near-idempotency-v1";
  idempotencyKey: string;
  requestDigest: string;
  requestFingerprint: string;
  attemptId: string;
  reservationId: string;
  approvalDigest: string;
  policyDigest: string;
  quoteId: string;
  quoteHash: string;
  depositAddress: string;
  depositMemo?: string;
  assetId: string;
  amountAtomic: string;
  budgetLimitAtomic: string;
  artifactKind: "provider_verified_executable_quote" | "dry_quote" | "fixture";
  providerSignatureVerified: boolean;
  approvalExpiresAt: string;
  providerDeadlineAt: string;
  createdAt: string;
}>;

export type NearHostedEvidenceInput = Readonly<{
  transitionId: string;
  expectedEntryRevision: number;
  checkedAt: string;
  depositAddress: string;
  depositMemo?: string;
  outcome: "unknown" | "pending" | "terminal";
  providerStatus?: NearHostedProviderStatus;
  unknownReason?: NearHostedUnknownReason;
  evidenceDigest?: string;
  safeToResubmit: false;
}>;

export type NearHostedNativeToArbitrumBinding = Readonly<{
  version: "pilot-near-native-to-arbitrum-usdc-hosted-binding-v1";
  accountId: string;
  approvalDigest: string;
  quoteId: string;
  quoteHash: string;
  correlationId: string;
  originAssetId: typeof WRAPPED_NEAR_ASSET;
  originTokenContract: "wrap.near";
  amountIn: string;
  refundTo: string;
  depositAddress: string;
  destinationAssetId: typeof ARBITRUM_USDC_ASSET;
  destinationTokenContract: typeof ARBITRUM_USDC_CONTRACT;
  destinationRecipient: string;
  minAmountOut: string;
}>;

export type NearHostedNativeSourceFundingEvidence = Readonly<{
  version: "pilot-near-native-near-source-funding-v1";
  provenance: "near-rpc-finalized-native-transfer";
  network: "near:mainnet";
  transaction_hash: string;
  receipt_id: string;
  block_height: number;
  finality: "final";
  execution_status: "SUCCESS";
  source_account_id: string;
  receiver_account_id: string;
  amount_yocto_near: string;
  included_at: string;
  verified_at: string;
}>;

export type NearHostedArbitrumUsdcReceiptEvidence = Readonly<{
  version: "pilot-near-arbitrum-canonical-usdc-receipt-v1";
  provenance: "arbitrum-rpc-finalized-erc20-transfer";
  chain: "arb";
  chain_id: 42161;
  transaction_hash: string;
  block_hash: string;
  block_number: number;
  transaction_index: number;
  log_index: number;
  finality: "final";
  receipt_status: "success";
  event_signature: "Transfer(address,address,uint256)";
  token_contract: typeof ARBITRUM_USDC_CONTRACT;
  token_decimals: 6;
  sender_address: string;
  recipient_address: string;
  amount_received: string;
  verified_at: string;
}>;

export type NearHostedNativeRefundReceiptEvidence = Readonly<{
  version: "pilot-near-native-near-refund-receipt-v1";
  provenance: "near-rpc-finalized-refund";
  network: "near:mainnet";
  transaction_hash: string;
  receipt_id: string;
  block_height: number;
  finality: "final";
  execution_status: "SUCCESS";
  refund_account_id: string;
  amount_refunded_yocto_near: string;
  verified_at: string;
}>;

type NativeReconciliationBase = Readonly<{
  version: "pilot-near-native-near-to-arbitrum-usdc-reconciliation-v1";
  quote_hash: string;
  correlation_id: string;
  deposit_account_id: string;
  deposit_memo_present: false;
  checked_at: string;
  safe_to_resubmit: false;
}>;

export type NearHostedNativeReconciliation = NativeReconciliationBase & (
  | Readonly<{ outcome: "pending"; provider_status: "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" }>
  | Readonly<{ outcome: "unknown"; reason: NearHostedUnknownReason }>
  | Readonly<{
      outcome: "refunded";
      provider_status: "REFUNDED";
      refund_receipt: NearHostedNativeRefundReceiptEvidence;
    }>
  | Readonly<{ outcome: "failed"; provider_status: "FAILED"; independent_terminal_evidence: false }>
  | Readonly<{ outcome: "provider-success-only"; provider_status: "SUCCESS"; independent_destination_receipt: false }>
  | Readonly<{
      outcome: "independently-settled";
      provider_status: NearHostedProviderStatus;
      destination_receipt: NearHostedArbitrumUsdcReceiptEvidence;
    }>
);

export type NearHostedNativeLifecycleEvidence =
  | NearHostedNativeSourceFundingEvidence
  | NearHostedNativeReconciliation;

export type NearHostedNativeTransitionInput = Readonly<{
  accountId: string;
  transitionId: string;
  expectedEntryRevision: number;
  binding: NearHostedNativeToArbitrumBinding;
  evidence: NearHostedNativeLifecycleEvidence;
}>;

export type NearHostedNativeLifecycleState =
  | "reserved"
  | "source_verified"
  | "provider_observed"
  | "destination_verified"
  | "refunded";

export type NearHostedNativeLifecycle = Readonly<{
  tenantId: string;
  principalId: string;
  accountId: string;
  idempotencyKey: string;
  attemptId: string;
  reservationId: string;
  sourceTransactionHash?: string;
  lifecycleState: NearHostedNativeLifecycleState;
  lifecycleRevision: number;
  entryRevision: number;
  lastEvidenceKind?: NativeEvidenceKind;
  lastProviderStatus?: NearHostedProviderStatus;
  updatedAt: string;
}>;

export type NearHostedAttempt = Readonly<{
  tenantId: string;
  principalId: string;
  accountId: string;
  idempotencyKey: string;
  requestDigest: string;
  attemptId: string;
  reservationId: string;
  assetId: string;
  amountAtomic: string;
  budgetLimitAtomic: string;
  state: NearHostedAttemptState;
  reservationState: NearHostedReservationState;
  providerStatus?: NearHostedProviderStatus;
  entryRevision: number;
  reservationRevision: number;
  createdAt: string;
  updatedAt: string;
  unknownSince?: string;
}>;

export type NearHostedStoreErrorCode =
  | "INVALID_INPUT"
  | "NOT_EXECUTABLE"
  | "AUTHORIZATION_EXPIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "BUDGET_EXCEEDED"
  | "VERSION_CONFLICT"
  | "INVALID_TRANSITION"
  | "ATTEMPT_NOT_FOUND"
  | "CONTENTION"
  | "UNAVAILABLE";

export class NearHostedStoreError extends Error {
  constructor(readonly code: NearHostedStoreErrorCode, message: string) {
    super(message);
    this.name = "NearHostedStoreError";
  }
}

type AttemptRow = Readonly<{
  tenant_id: string;
  principal_id: string;
  account_id: string;
  authorization_id: string;
  idempotency_version: "pilot-near-idempotency-v1";
  idempotency_key: string;
  request_digest: string;
  request_fingerprint: string;
  attempt_id: string;
  reservation_id: string;
  approval_digest: string;
  policy_digest: string;
  quote_id: string;
  quote_hash: string;
  deposit_address: string;
  deposit_memo: string | null;
  asset_id: string;
  amount_atomic: string;
  budget_limit_atomic: string;
  artifact_kind: "provider_verified_executable_quote";
  state: NearHostedAttemptState;
  reservation_state: NearHostedReservationState;
  provider_status: NearHostedProviderStatus | null;
  entry_revision: number;
  reservation_revision: number;
  authorization_expires_at: string;
  approval_expires_at: string;
  provider_deadline_at: string;
  created_at: string;
  updated_at: string;
  unknown_since: string | null;
}>;

type CounterRow = Readonly<{
  consumed_atomic: string;
  revision: number;
}>;

type EvidenceRow = Readonly<{
  evidence_json: string;
}>;

type CollisionRow = Readonly<{
  idempotency_key: string;
}>;

type NativeLifecycleRow = Readonly<{
  tenant_id: string;
  principal_id: string;
  account_id: string;
  network: "near:mainnet";
  idempotency_key: string;
  attempt_id: string;
  reservation_id: string;
  approval_digest: string;
  quote_id: string;
  quote_hash: string;
  correlation_id: string;
  origin_token_contract: string;
  origin_asset_id: string;
  amount_yocto_near: string;
  source_account_id: string;
  refund_account_id: string;
  deposit_account_id: string;
  deposit_memo: null;
  source_transaction_hash: string | null;
  source_receipt_id: string | null;
  source_block_height: number | null;
  source_included_at: string | null;
  source_verified_at: string | null;
  destination_token_contract: string;
  destination_asset_id: string;
  destination_recipient: string;
  min_amount_out: string;
  destination_transaction_hash: string | null;
  destination_log_index: number | null;
  refund_transaction_hash: string | null;
  lifecycle_state: NearHostedNativeLifecycleState;
  lifecycle_revision: number;
  entry_revision: number;
  last_transition_id: string | null;
  last_evidence_kind: NativeEvidenceKind | null;
  last_provider_status: NearHostedProviderStatus | null;
  last_evidence_digest: string | null;
  last_evidence_json: string | null;
  updated_at: string;
}>;

export type NativeEvidenceKind =
  | "source_funding"
  | "provider_observation"
  | "destination_receipt"
  | "refund_receipt";

type StoreDependencies = Readonly<{
  /** Trusted Worker clock; injected only for deterministic tests. */
  now?: () => number;
  /** Test-only barrier for forcing distinct Worker instances onto one stale read. */
  afterReservationRead?: () => void | Promise<void>;
  afterReconciliationRead?: () => void | Promise<void>;
}>;

function fail(code: NearHostedStoreErrorCode, message: string): never {
  throw new NearHostedStoreError(code, message);
}

function changes(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta.changes ?? 0);
}

function first<T>(result: D1Result<unknown> | undefined): T | undefined {
  return (result?.results?.[0] as T | undefined);
}

function iso(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("INVALID_INPUT", `${label} must be an ISO timestamp`);
  return parsed;
}

function identifier(value: string, label: string): void {
  if (!SAFE_ID.test(value)) fail("INVALID_INPUT", `${label} is invalid`);
}

function exactAtomic(value: string, label: string, allowZero = false): bigint {
  if (!ATOMIC.test(value) || value.length > MAX_ATOMIC_DIGITS || (!allowZero && value === "0")) {
    fail("INVALID_INPUT", `${label} must be a canonical positive atomic string of at most 128 digits`);
  }
  return BigInt(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_INPUT", "Canonical evidence rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  fail("INVALID_INPUT", "Canonical evidence contains an unsupported value");
}

async function evidenceDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pilot.near-native-to-arbitrum-usdc.evidence.v1\0${canonicalJson(value)}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function arbitrumAddress(value: string, label: string): string {
  if (!ARBITRUM_ADDRESS.test(value)) fail("INVALID_INPUT", `${label} must be an Arbitrum address`);
  return value.toLowerCase();
}

function arbitrumTransaction(value: string, label: string): string {
  if (!ARBITRUM_TRANSACTION.test(value)) fail("INVALID_INPUT", `${label} must be an Arbitrum transaction hash`);
  return value.toLowerCase();
}

function nearAccount(value: string, label: string): void {
  if (!ACCOUNT_ID.test(value)) fail("INVALID_INPUT", `${label} must be a NEAR account`);
}

function assertExactKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("INVALID_INPUT", `${label} contains unknown or missing fields`);
  }
}

function assertScope(tenantId: string, principalId: string): void {
  identifier(tenantId, "tenantId");
  identifier(principalId, "principalId");
}

function validateReserve(input: NearHostedReserveInput): void {
  if (input.artifactKind !== "provider_verified_executable_quote" || input.providerSignatureVerified !== true) {
    fail("NOT_EXECUTABLE", "Dry, fixture, and unverified quotes cannot reserve hosted budget");
  }
  if (!ACCOUNT_ID.test(input.accountId) || input.idempotencyVersion !== "pilot-near-idempotency-v1") {
    fail("INVALID_INPUT", "NEAR account or idempotency version is invalid");
  }
  for (const [label, value] of [
    ["authorizationId", input.authorizationId], ["idempotencyKey", input.idempotencyKey],
    ["attemptId", input.attemptId], ["reservationId", input.reservationId], ["quoteId", input.quoteId],
  ] as const) identifier(value, label);
  for (const [label, value] of [
    ["requestDigest", input.requestDigest], ["requestFingerprint", input.requestFingerprint],
    ["approvalDigest", input.approvalDigest], ["policyDigest", input.policyDigest],
  ] as const) {
    if (!DIGEST.test(value)) fail("INVALID_INPUT", `${label} is invalid`);
  }
  if (input.requestDigest !== input.requestFingerprint) {
    fail("IDEMPOTENCY_CONFLICT", "Idempotency digest does not match the exact request fingerprint");
  }
  if (!QUOTE_HASH.test(input.quoteHash) || !ASSET_ID.test(input.assetId) ||
      input.depositAddress.length < 1 || input.depositAddress.length > 512 ||
      (input.depositMemo !== undefined && (input.depositMemo.length < 1 || input.depositMemo.length > 512))) {
    fail("INVALID_INPUT", "Quote or deposit route is invalid");
  }
  const amount = exactAtomic(input.amountAtomic, "amountAtomic");
  const limit = exactAtomic(input.budgetLimitAtomic, "budgetLimitAtomic");
  if (amount > limit) fail("BUDGET_EXCEEDED", "Attempt amount exceeds the approved budget limit");
  const createdAt = iso(input.createdAt, "createdAt");
  if (iso(input.authorizationExpiresAt, "authorizationExpiresAt") <= createdAt ||
      iso(input.approvalExpiresAt, "approvalExpiresAt") <= createdAt ||
      iso(input.providerDeadlineAt, "providerDeadlineAt") <= createdAt) {
    fail("AUTHORIZATION_EXPIRED", "Authorization, approval, or provider deadline is not active");
  }
}

type NativeBindingReservation = Readonly<{
  account_id: string;
  approval_digest: string;
  quote_id: string;
  quote_hash: string;
  asset_id: string;
  amount_atomic: string;
  deposit_address: string;
  deposit_memo: string | null;
}>;

function validateNativeBinding(
  binding: NearHostedNativeToArbitrumBinding,
  row: NativeBindingReservation,
  accountId: string,
): NearHostedNativeToArbitrumBinding {
  assertExactKeys(binding, [
    "version", "accountId", "approvalDigest", "quoteId", "quoteHash", "correlationId",
    "originAssetId", "originTokenContract", "amountIn", "refundTo", "depositAddress",
    "destinationAssetId", "destinationTokenContract", "destinationRecipient", "minAmountOut",
  ], "native-to-Arbitrum binding");
  if (binding.version !== "pilot-near-native-to-arbitrum-usdc-hosted-binding-v1" ||
      binding.accountId !== accountId || binding.accountId !== row.account_id ||
      binding.approvalDigest !== row.approval_digest || binding.quoteId !== row.quote_id ||
      binding.quoteHash !== row.quote_hash || !SAFE_ID.test(binding.correlationId) ||
      binding.originAssetId !== WRAPPED_NEAR_ASSET || row.asset_id !== WRAPPED_NEAR_ASSET ||
      binding.originTokenContract !== "wrap.near" ||
      binding.destinationAssetId !== ARBITRUM_USDC_ASSET ||
      binding.destinationTokenContract.toLowerCase() !== ARBITRUM_USDC_CONTRACT ||
      binding.amountIn !== row.amount_atomic || binding.depositAddress !== row.deposit_address ||
      row.deposit_memo !== null) {
    fail("INVALID_TRANSITION", "Native NEAR route does not match the reserved approval and quote");
  }
  if (!DIGEST.test(binding.approvalDigest) || !QUOTE_HASH.test(binding.quoteHash)) {
    fail("INVALID_INPUT", "Native-route approval or quote digest is invalid");
  }
  nearAccount(binding.refundTo, "refundTo");
  nearAccount(binding.depositAddress, "depositAddress");
  exactAtomic(binding.amountIn, "amountIn");
  exactAtomic(binding.minAmountOut, "minAmountOut");
  const destinationRecipient = arbitrumAddress(binding.destinationRecipient, "destinationRecipient");
  return { ...binding, destinationRecipient };
}

function nativeBindingReservation(input: NearHostedReserveInput): NativeBindingReservation {
  return {
    account_id: input.accountId,
    approval_digest: input.approvalDigest,
    quote_id: input.quoteId,
    quote_hash: input.quoteHash,
    asset_id: input.assetId,
    amount_atomic: input.amountAtomic,
    deposit_address: input.depositAddress,
    deposit_memo: input.depositMemo ?? null,
  };
}

function sameNativeBinding(row: NativeLifecycleRow, binding: NearHostedNativeToArbitrumBinding): boolean {
  return row.account_id === binding.accountId
    && row.approval_digest === binding.approvalDigest
    && row.quote_id === binding.quoteId
    && row.quote_hash === binding.quoteHash
    && row.correlation_id === binding.correlationId
    && row.origin_asset_id === binding.originAssetId
    && row.origin_token_contract === binding.originTokenContract
    && row.amount_yocto_near === binding.amountIn
    && row.refund_account_id === binding.refundTo
    && row.deposit_account_id === binding.depositAddress
    && row.destination_asset_id === binding.destinationAssetId
    && row.destination_token_contract === binding.destinationTokenContract
    && row.destination_recipient === binding.destinationRecipient.toLowerCase()
    && row.min_amount_out === binding.minAmountOut;
}

function toNativeLifecycle(row: NativeLifecycleRow): NearHostedNativeLifecycle {
  return {
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    accountId: row.account_id,
    idempotencyKey: row.idempotency_key,
    attemptId: row.attempt_id,
    reservationId: row.reservation_id,
    ...(row.source_transaction_hash === null ? {} : { sourceTransactionHash: row.source_transaction_hash }),
    lifecycleState: row.lifecycle_state,
    lifecycleRevision: row.lifecycle_revision,
    entryRevision: row.entry_revision,
    ...(row.last_evidence_kind === null ? {} : { lastEvidenceKind: row.last_evidence_kind }),
    ...(row.last_provider_status === null ? {} : { lastProviderStatus: row.last_provider_status }),
    updatedAt: row.updated_at,
  };
}

type NativeEvidencePlan = Readonly<{
  evidence: NearHostedNativeLifecycleEvidence;
  evidenceJson: string;
  kind: NativeEvidenceKind;
  state: NearHostedNativeLifecycleState;
  checkedAt: string;
  providerStatus: NearHostedProviderStatus | null;
  destinationTransactionHash: string | null;
  destinationLogIndex: number | null;
  refundTransactionHash: string | null;
}>;

function validateNativeEvidence(
  evidence: NearHostedNativeLifecycleEvidence,
  binding: NearHostedNativeToArbitrumBinding,
  lifecycle?: NativeLifecycleRow,
): NativeEvidencePlan {
  if (evidence.version === "pilot-near-native-near-source-funding-v1") {
    assertExactKeys(evidence, [
      "version", "provenance", "network", "transaction_hash", "receipt_id", "block_height",
      "finality", "execution_status", "source_account_id", "receiver_account_id",
      "amount_yocto_near", "included_at", "verified_at",
    ], "native NEAR source funding evidence");
    if (evidence.provenance !== "near-rpc-finalized-native-transfer" ||
        evidence.network !== "near:mainnet" || evidence.finality !== "final" ||
        evidence.execution_status !== "SUCCESS" || !NEAR_HASH.test(evidence.transaction_hash) ||
        !NEAR_HASH.test(evidence.receipt_id) || !Number.isSafeInteger(evidence.block_height) ||
        evidence.block_height < 1 || evidence.source_account_id !== binding.accountId ||
        evidence.receiver_account_id !== binding.depositAddress ||
        evidence.amount_yocto_near !== binding.amountIn) {
      fail("INVALID_TRANSITION", "Finalized native NEAR funding does not match the approved route");
    }
    if (lifecycle && lifecycle.lifecycle_state !== "reserved" && (
      evidence.transaction_hash !== lifecycle.source_transaction_hash ||
      evidence.receipt_id !== lifecycle.source_receipt_id ||
      evidence.block_height !== lifecycle.source_block_height ||
      evidence.source_account_id !== lifecycle.source_account_id ||
      evidence.receiver_account_id !== lifecycle.deposit_account_id ||
      evidence.amount_yocto_near !== lifecycle.amount_yocto_near
    )) {
      fail("IDEMPOTENCY_CONFLICT", "Native funding replay does not match the durable source receipt");
    }
    exactAtomic(evidence.amount_yocto_near, "amount_yocto_near");
    const includedAt = iso(evidence.included_at, "included_at");
    if (iso(evidence.verified_at, "verified_at") < includedAt) {
      fail("INVALID_TRANSITION", "Native funding verification cannot predate inclusion");
    }
    return {
      evidence,
      evidenceJson: canonicalJson(evidence),
      kind: "source_funding",
      state: "source_verified",
      checkedAt: evidence.verified_at,
      providerStatus: null,
      destinationTransactionHash: null,
      destinationLogIndex: null,
      refundTransactionHash: null,
    };
  }

  if (!lifecycle) {
    fail("INVALID_TRANSITION", "Finalized native NEAR funding must precede reconciliation");
  }
  if (lifecycle.lifecycle_state === "reserved") {
    fail("INVALID_TRANSITION", "Finalized native NEAR funding must precede provider reconciliation");
  }
  const baseKeys = [
    "version", "quote_hash", "correlation_id", "deposit_account_id",
    "deposit_memo_present", "checked_at", "safe_to_resubmit", "outcome",
  ];
  const variantKeys = evidence.outcome === "pending" ? ["provider_status"]
    : evidence.outcome === "unknown" ? ["reason"]
    : evidence.outcome === "refunded" ? ["provider_status", "refund_receipt"]
    : evidence.outcome === "failed" ? ["provider_status", "independent_terminal_evidence"]
    : evidence.outcome === "provider-success-only"
      ? ["provider_status", "independent_destination_receipt"]
      : ["provider_status", "destination_receipt"];
  assertExactKeys(evidence, [...baseKeys, ...variantKeys], "native-to-Arbitrum reconciliation");
  if (evidence.quote_hash !== lifecycle.quote_hash ||
      evidence.correlation_id !== lifecycle.correlation_id ||
      evidence.deposit_account_id !== lifecycle.deposit_account_id ||
      evidence.deposit_memo_present !== false || evidence.safe_to_resubmit !== false) {
    fail("INVALID_TRANSITION", "Reconciliation does not match the approved native deposit route");
  }
  const checkedAt = iso(evidence.checked_at, "checked_at");

  if (evidence.outcome === "refunded") {
    const receipt = evidence.refund_receipt;
    assertExactKeys(receipt, [
      "version", "provenance", "network", "transaction_hash", "receipt_id", "block_height",
      "finality", "execution_status", "refund_account_id", "amount_refunded_yocto_near", "verified_at",
    ], "native NEAR refund receipt");
    if (evidence.provider_status !== "REFUNDED" ||
        receipt.version !== "pilot-near-native-near-refund-receipt-v1" ||
        receipt.provenance !== "near-rpc-finalized-refund" || receipt.network !== "near:mainnet" ||
        !NEAR_HASH.test(receipt.transaction_hash) || !NEAR_HASH.test(receipt.receipt_id) ||
        !Number.isSafeInteger(receipt.block_height) || receipt.block_height < 1 ||
        receipt.finality !== "final" || receipt.execution_status !== "SUCCESS" ||
        receipt.refund_account_id !== lifecycle.refund_account_id ||
        receipt.amount_refunded_yocto_near !== lifecycle.amount_yocto_near ||
        iso(receipt.verified_at, "refund verified_at") > checkedAt) {
      fail("INVALID_TRANSITION", "Finalized refund does not match the exact NEAR refund route and amount");
    }
    return {
      evidence, evidenceJson: canonicalJson(evidence), kind: "refund_receipt",
      state: "refunded", checkedAt: evidence.checked_at, providerStatus: "REFUNDED",
      destinationTransactionHash: null,
      destinationLogIndex: null,
      refundTransactionHash: receipt.transaction_hash,
    };
  }

  if (evidence.outcome === "independently-settled") {
    const receipt = evidence.destination_receipt;
    assertExactKeys(receipt, [
      "version", "provenance", "chain", "chain_id", "transaction_hash", "block_hash",
      "block_number", "transaction_index", "log_index", "finality", "receipt_status",
      "event_signature", "token_contract", "token_decimals", "sender_address",
      "recipient_address", "amount_received", "verified_at",
    ], "Arbitrum USDC destination receipt");
    if (evidence.provider_status !== "SUCCESS" || lifecycle.last_provider_status !== "SUCCESS" ||
        receipt.version !== "pilot-near-arbitrum-canonical-usdc-receipt-v1" ||
        receipt.provenance !== "arbitrum-rpc-finalized-erc20-transfer" ||
        receipt.chain !== "arb" || receipt.chain_id !== 42161 ||
        !ARBITRUM_TRANSACTION.test(receipt.transaction_hash) ||
        !ARBITRUM_TRANSACTION.test(receipt.block_hash) ||
        !Number.isSafeInteger(receipt.block_number) || receipt.block_number < 0 ||
        !Number.isSafeInteger(receipt.transaction_index) || receipt.transaction_index < 0 ||
        !Number.isSafeInteger(receipt.log_index) || receipt.log_index < 0 ||
        receipt.finality !== "final" || receipt.receipt_status !== "success" ||
        receipt.event_signature !== "Transfer(address,address,uint256)" ||
        receipt.token_contract.toLowerCase() !== ARBITRUM_USDC_CONTRACT ||
        receipt.token_decimals !== 6 ||
        arbitrumAddress(receipt.recipient_address, "recipient_address") !== lifecycle.destination_recipient ||
        BigInt(exactAtomic(receipt.amount_received, "amount_received")) < BigInt(lifecycle.min_amount_out) ||
        iso(receipt.verified_at, "destination verified_at") > checkedAt) {
      fail("INVALID_TRANSITION", "Finalized Arbitrum USDC receipt does not settle the approved route");
    }
    arbitrumAddress(receipt.sender_address, "sender_address");
    return {
      evidence, evidenceJson: canonicalJson(evidence), kind: "destination_receipt",
      state: "destination_verified", checkedAt: evidence.checked_at,
      providerStatus: evidence.provider_status,
      destinationTransactionHash: receipt.transaction_hash.toLowerCase(),
      destinationLogIndex: receipt.log_index,
      refundTransactionHash: null,
    };
  }

  let providerStatus: NearHostedProviderStatus | null;
  if (evidence.outcome === "pending") {
    providerStatus = evidence.provider_status;
  } else if (evidence.outcome === "provider-success-only") {
    if (evidence.provider_status !== "SUCCESS" || evidence.independent_destination_receipt !== false) {
      fail("INVALID_TRANSITION", "Provider success is observation-only without a destination receipt");
    }
    providerStatus = "SUCCESS";
  } else if (evidence.outcome === "failed") {
    if (evidence.provider_status !== "FAILED" || evidence.independent_terminal_evidence !== false) {
      fail("INVALID_TRANSITION", "Provider failure has no independent release evidence");
    }
    providerStatus = "FAILED";
  } else {
    providerStatus = null;
  }
  return {
    evidence, evidenceJson: canonicalJson(evidence), kind: "provider_observation",
    state: "provider_observed", checkedAt: evidence.checked_at, providerStatus,
    destinationTransactionHash: null,
    destinationLogIndex: null,
    refundTransactionHash: null,
  };
}
function validateCounter(row: CounterRow | undefined): CounterRow {
  if (!row) return { consumed_atomic: "0", revision: 0 };
  exactAtomic(row.consumed_atomic, "stored consumed amount", true);
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) fail("UNAVAILABLE", "Stored budget revision is invalid");
  return row;
}

function toAttempt(row: AttemptRow): NearHostedAttempt {
  return {
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    accountId: row.account_id,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    attemptId: row.attempt_id,
    reservationId: row.reservation_id,
    assetId: row.asset_id,
    amountAtomic: row.amount_atomic,
    budgetLimitAtomic: row.budget_limit_atomic,
    state: row.state,
    reservationState: row.reservation_state,
    ...(row.provider_status === null ? {} : { providerStatus: row.provider_status }),
    entryRevision: row.entry_revision,
    reservationRevision: row.reservation_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.unknown_since === null ? {} : { unknownSince: row.unknown_since }),
  };
}

function sameRequest(row: AttemptRow, input: NearHostedReserveInput): boolean {
  return row.account_id === input.accountId
    && row.idempotency_version === input.idempotencyVersion
    && row.request_digest === input.requestDigest
    && row.request_fingerprint === input.requestFingerprint
    && row.attempt_id === input.attemptId
    && row.reservation_id === input.reservationId
    && row.approval_digest === input.approvalDigest
    && row.policy_digest === input.policyDigest
    && row.quote_id === input.quoteId
    && row.quote_hash === input.quoteHash
    && row.deposit_address === input.depositAddress
    && row.deposit_memo === (input.depositMemo ?? null)
    && row.asset_id === input.assetId
    && row.amount_atomic === input.amountAtomic
    && row.budget_limit_atomic === input.budgetLimitAtomic
    && row.authorization_id === input.authorizationId
    && row.artifact_kind === input.artifactKind
    && row.authorization_expires_at === input.authorizationExpiresAt
    && row.approval_expires_at === input.approvalExpiresAt
    && row.provider_deadline_at === input.providerDeadlineAt
    && row.created_at === input.createdAt;
}

const ATTEMPT_COLUMNS = `
  tenant_id, principal_id, account_id, authorization_id, idempotency_version,
  idempotency_key, request_digest, request_fingerprint,
  attempt_id, reservation_id, approval_digest, policy_digest, quote_id, quote_hash,
  deposit_address, deposit_memo, asset_id, amount_atomic, budget_limit_atomic, artifact_kind,
  state, reservation_state, provider_status, entry_revision, reservation_revision,
  authorization_expires_at, approval_expires_at, provider_deadline_at,
  created_at, updated_at, unknown_since
`;

const NATIVE_LIFECYCLE_COLUMNS = `
  tenant_id, principal_id, account_id, network, idempotency_key, attempt_id, reservation_id,
  approval_digest, quote_id, quote_hash, correlation_id, origin_token_contract, origin_asset_id,
  amount_yocto_near, source_account_id, refund_account_id, deposit_account_id, deposit_memo,
  source_transaction_hash, source_receipt_id, source_block_height, source_included_at, source_verified_at,
  destination_token_contract, destination_asset_id, destination_recipient, min_amount_out,
  destination_transaction_hash, destination_log_index, refund_transaction_hash,
  lifecycle_state, lifecycle_revision, entry_revision, last_transition_id, last_evidence_kind,
  last_provider_status, last_evidence_digest, last_evidence_json, updated_at
`;

export class D1NearAttemptStore {
  constructor(
    readonly database: D1Database,
    readonly tenantId: string,
    readonly principalId: string,
    readonly dependencies: StoreDependencies = {},
  ) {
    assertScope(tenantId, principalId);
  }

  async reserve(input: NearHostedReserveInput): Promise<{ replay: boolean; attempt: NearHostedAttempt }> {
    return this.#reserve(input);
  }

  async reserveNativeNearToArbitrum(
    input: NearHostedReserveInput,
    binding: NearHostedNativeToArbitrumBinding,
  ): Promise<{
    replay: boolean;
    attempt: NearHostedAttempt;
    lifecycle: NearHostedNativeLifecycle;
  }> {
    const normalizedBinding = validateNativeBinding(
      binding,
      nativeBindingReservation(input),
      input.accountId,
    );
    const result = await this.#reserve(input, normalizedBinding);
    const lifecycle = await this.#readNativeLifecycle(input.idempotencyKey).catch(() => undefined);
    if (!lifecycle || !sameNativeBinding(lifecycle, normalizedBinding)) {
      fail("UNAVAILABLE", "Atomic native route reservation did not retain its immutable binding");
    }
    return { ...result, lifecycle: toNativeLifecycle(lifecycle) };
  }

  async #reserve(
    input: NearHostedReserveInput,
    nativeBinding?: NearHostedNativeToArbitrumBinding,
  ): Promise<{ replay: boolean; attempt: NearHostedAttempt }> {
    validateReserve(input);
    for (let retry = 0; retry < MAX_CONTENTION_RETRIES; retry += 1) {
      const [existingResult, counterResult, collisionResult] = await this.database.batch([
        this.database.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM near_hosted_attempts
          WHERE tenant_id = ? AND principal_id = ? AND idempotency_key = ?`)
          .bind(this.tenantId, this.principalId, input.idempotencyKey),
        this.database.prepare(`SELECT consumed_atomic, revision FROM near_attempt_budget_counters
          WHERE tenant_id = ? AND principal_id = ?
            AND network = 'near:mainnet' AND asset_id = ?`)
          .bind(this.tenantId, this.principalId, input.assetId),
        this.database.prepare(`SELECT idempotency_key FROM near_hosted_attempts
          WHERE tenant_id = ? AND (attempt_id = ? OR reservation_id = ?) LIMIT 1`)
          .bind(this.tenantId, input.attemptId, input.reservationId),
      ]);
      const existing = first<AttemptRow>(existingResult);
      if (existing) {
        if (!sameRequest(existing, input)) fail("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different request");
        if (nativeBinding) {
          const lifecycle = await this.#readNativeLifecycle(input.idempotencyKey).catch(() => undefined);
          if (!lifecycle || !sameNativeBinding(lifecycle, nativeBinding)) {
            fail("IDEMPOTENCY_CONFLICT", "Native route reservation replay is missing its exact immutable binding");
          }
        }
        return { replay: true, attempt: toAttempt(existing) };
      }
      const now = this.#trustedNow();
      if (iso(input.authorizationExpiresAt, "authorizationExpiresAt") <= now ||
          iso(input.approvalExpiresAt, "approvalExpiresAt") <= now ||
          iso(input.providerDeadlineAt, "providerDeadlineAt") <= now) {
        fail("AUTHORIZATION_EXPIRED", "Authorization, approval, or provider deadline expired before reservation");
      }
      if (first<CollisionRow>(collisionResult)) {
        fail("IDEMPOTENCY_CONFLICT", "Attempt or reservation identity was reused in this tenant");
      }
      const counter = validateCounter(first<CounterRow>(counterResult));
      const nextAtomic = (BigInt(counter.consumed_atomic) + BigInt(input.amountAtomic)).toString();
      if (BigInt(nextAtomic) > BigInt(input.budgetLimitAtomic)) {
        fail("BUDGET_EXCEEDED", "Atomic hosted budget reservation would exceed the approved limit");
      }
      await this.dependencies.afterReservationRead?.();
      try {
        const results = await this.database.batch([
          this.database.prepare(`INSERT OR IGNORE INTO near_attempt_budget_counters (
            tenant_id, principal_id, network, asset_id, consumed_atomic,
            revision, last_mutation_token, updated_at
          ) VALUES (?, ?, 'near:mainnet', ?, '0', 0, NULL, ?)`)
            .bind(this.tenantId, this.principalId, input.assetId, input.createdAt),
          this.database.prepare(`INSERT INTO near_hosted_attempts (
            tenant_id, principal_id, account_id, network, authorization_id,
            idempotency_version, idempotency_key, request_digest, request_fingerprint,
            attempt_id, reservation_id, approval_digest, policy_digest, quote_id, quote_hash,
            deposit_address, deposit_memo, asset_id, amount_atomic, budget_limit_atomic,
            artifact_kind, state, reservation_state, provider_status,
            entry_revision, reservation_revision, authorization_expires_at,
            approval_expires_at, provider_deadline_at, created_at, updated_at, unknown_since,
            last_transition_id, last_evidence_outcome, last_provider_status,
            last_unknown_reason, last_evidence_digest, last_safe_to_resubmit, last_evidence_json,
            counter_expected_atomic, counter_expected_revision, counter_next_atomic
          ) VALUES (
            ?, ?, ?, 'near:mainnet', ?, 'pilot-near-idempotency-v1', ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'provider_verified_executable_quote', 'approved', 'reserved', NULL,
            1, 1, ?, ?, ?, ?, ?, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?
          )`)
            .bind(
              this.tenantId, this.principalId, input.accountId, input.authorizationId,
              input.idempotencyKey, input.requestDigest, input.requestFingerprint,
              input.attemptId, input.reservationId, input.approvalDigest, input.policyDigest,
              input.quoteId, input.quoteHash, input.depositAddress, input.depositMemo ?? null,
              input.assetId, input.amountAtomic, input.budgetLimitAtomic,
              input.authorizationExpiresAt, input.approvalExpiresAt, input.providerDeadlineAt,
              input.createdAt, input.createdAt,
              counter.consumed_atomic, counter.revision, nextAtomic,
            ),
          ...(nativeBinding ? [this.database.prepare(`INSERT INTO near_native_to_arbitrum_usdc_lifecycles (
            tenant_id, principal_id, account_id, network, idempotency_key, attempt_id, reservation_id,
            approval_digest, quote_id, quote_hash, correlation_id,
            origin_chain, origin_network, origin_asset_id, origin_token_contract, origin_token_decimals,
            source_transfer_asset, amount_yocto_near, source_account_id, refund_account_id,
            deposit_account_id, deposit_memo,
            source_transaction_hash, source_receipt_id, source_block_height, source_included_at, source_verified_at,
            destination_chain, destination_chain_id, destination_asset_id, destination_token_contract,
            destination_token_decimals, destination_recipient, min_amount_out,
            destination_transaction_hash, destination_log_index, refund_transaction_hash,
            lifecycle_state, lifecycle_revision, entry_revision, last_transition_id, last_evidence_kind,
            last_provider_status, last_evidence_digest, last_evidence_json, updated_at,
            counter_expected_atomic, counter_expected_revision, counter_next_atomic
          ) VALUES (
            ?, ?, ?, 'near:mainnet', ?, ?, ?, ?, ?, ?, ?,
            'near', 'near:mainnet', ?, 'wrap.near', 24,
            'native-near', ?, ?, ?, ?, NULL,
            NULL, NULL, NULL, NULL, NULL,
            'arb', 42161, ?, ?, 6, ?, ?,
            NULL, NULL, NULL,
            'reserved', 0, 1, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?
          )`).bind(
            this.tenantId, this.principalId, input.accountId, input.idempotencyKey,
            input.attemptId, input.reservationId, nativeBinding.approvalDigest,
            nativeBinding.quoteId, nativeBinding.quoteHash, nativeBinding.correlationId,
            nativeBinding.originAssetId, nativeBinding.amountIn, input.accountId,
            nativeBinding.refundTo, nativeBinding.depositAddress,
            nativeBinding.destinationAssetId, nativeBinding.destinationTokenContract,
            nativeBinding.destinationRecipient, nativeBinding.minAmountOut,
            input.createdAt, counter.consumed_atomic, counter.revision, nextAtomic,
          )] : []),
        ]);
        if (changes(results[1]) !== 1 || (nativeBinding && changes(results[2]) !== 1)) continue;
        const stored = await this.#readAttempt(input.idempotencyKey);
        if (!stored || !sameRequest(stored, input)) fail("UNAVAILABLE", "Hosted reservation did not round-trip exactly");
        return { replay: false, attempt: toAttempt(stored) };
      } catch (error) {
        if (error instanceof NearHostedStoreError) throw error;
        const replay = await this.#readAttempt(input.idempotencyKey).catch(() => undefined);
        if (replay) {
          if (!sameRequest(replay, input)) fail("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different request");
          if (nativeBinding) {
            const lifecycle = await this.#readNativeLifecycle(input.idempotencyKey).catch(() => undefined);
            if (!lifecycle || !sameNativeBinding(lifecycle, nativeBinding)) {
              fail("IDEMPOTENCY_CONFLICT", "Native route reservation replay lost its immutable binding");
            }
          }
          return { replay: true, attempt: toAttempt(replay) };
        }
        if (nativeBinding) {
          fail("UNAVAILABLE", "Native route reservation requires reviewed schema 0020");
        }
      }
    }
    fail("CONTENTION", "Hosted NEAR budget contention did not converge safely");
  }

  async reconcile(
    idempotencyKey: string,
    input: NearHostedEvidenceInput,
  ): Promise<{ replay: boolean; attempt: NearHostedAttempt }> {
    identifier(idempotencyKey, "idempotencyKey");
    identifier(input.transitionId, "transitionId");
    if (!Number.isSafeInteger(input.expectedEntryRevision) || input.expectedEntryRevision < 1 ||
        input.safeToResubmit !== false) fail("INVALID_INPUT", "Reconciliation revision or replay safety is invalid");
    iso(input.checkedAt, "checkedAt");
    if (input.evidenceDigest !== undefined && !DIGEST.test(input.evidenceDigest)) fail("INVALID_INPUT", "Evidence digest is invalid");
    if (await this.#readNativeLifecycleIfAvailable(idempotencyKey)) {
      fail("INVALID_TRANSITION", "Native-to-Arbitrum attempts require exact lifecycle reconciliation");
    }

    for (let retry = 0; retry < MAX_CONTENTION_RETRIES; retry += 1) {
      const [attemptResult, evidenceResult] = await this.database.batch([
        this.database.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM near_hosted_attempts
          WHERE tenant_id = ? AND principal_id = ? AND idempotency_key = ?`)
          .bind(this.tenantId, this.principalId, idempotencyKey),
        this.database.prepare(`SELECT evidence_json FROM near_attempt_reconciliation_evidence
          WHERE tenant_id = ? AND principal_id = ? AND idempotency_key = ? AND transition_id = ?`)
          .bind(this.tenantId, this.principalId, idempotencyKey, input.transitionId),
      ]);
      const row = first<AttemptRow>(attemptResult);
      if (!row) fail("ATTEMPT_NOT_FOUND", "Hosted NEAR attempt was not found");
      const evidenceJson = this.#evidenceJson(row, input);
      const priorEvidence = first<EvidenceRow>(evidenceResult);
      if (priorEvidence) {
        if (priorEvidence.evidence_json !== evidenceJson) {
          fail("IDEMPOTENCY_CONFLICT", "Transition ID was reused for different reconciliation evidence");
        }
        return { replay: true, attempt: toAttempt(row) };
      }
      const checkedAt = iso(input.checkedAt, "checkedAt");
      if (checkedAt < iso(row.updated_at, "stored updatedAt") || checkedAt > this.#trustedNow()) {
        fail("INVALID_INPUT", "Reconciliation time must be monotonic and no later than the trusted Worker clock");
      }
      if (row.entry_revision !== input.expectedEntryRevision) {
        fail("VERSION_CONFLICT", "Hosted attempt changed before reconciliation");
      }
      const transition = this.#nextTransition(row, input);
      let counter = { consumed_atomic: row.amount_atomic, revision: 0 };
      let counterNext = row.amount_atomic;
      if (transition.reservationState === "released") {
        const counterRow = await this.database.prepare(`SELECT consumed_atomic, revision
          FROM near_attempt_budget_counters WHERE tenant_id = ? AND principal_id = ?
            AND network = 'near:mainnet' AND asset_id = ?`)
          .bind(this.tenantId, this.principalId, row.asset_id)
          .first<CounterRow>();
        counter = validateCounter(counterRow ?? undefined);
        if (BigInt(counter.consumed_atomic) < BigInt(row.amount_atomic)) {
          fail("UNAVAILABLE", "Hosted NEAR budget counter is smaller than the releasing reservation");
        }
        counterNext = (BigInt(counter.consumed_atomic) - BigInt(row.amount_atomic)).toString();
      }
      await this.dependencies.afterReconciliationRead?.();
      try {
        const result = await this.database.prepare(`UPDATE near_hosted_attempts SET
          state = ?, reservation_state = ?, provider_status = ?,
          entry_revision = entry_revision + 1, reservation_revision = reservation_revision + ?,
          updated_at = ?, unknown_since = ?, last_transition_id = ?,
          last_evidence_outcome = ?, last_provider_status = ?, last_unknown_reason = ?,
          last_evidence_digest = ?, last_safe_to_resubmit = 0, last_evidence_json = ?,
          counter_expected_atomic = ?, counter_expected_revision = ?, counter_next_atomic = ?
        WHERE tenant_id = ? AND principal_id = ? AND idempotency_key = ?
          AND request_digest = ? AND entry_revision = ? AND state = ?`)
          .bind(
            transition.state, transition.reservationState, transition.providerStatus,
            transition.reservationRevisionIncrement,
            input.checkedAt, transition.unknownSince, input.transitionId,
            transition.recordedOutcome, transition.recordedProviderStatus,
            transition.recordedUnknownReason, transition.recordedEvidenceDigest, evidenceJson,
            counter.consumed_atomic, counter.revision, counterNext,
            this.tenantId, this.principalId, idempotencyKey,
            row.request_digest, input.expectedEntryRevision, row.state,
          ).run();
        if (changes(result) === 1) {
          const stored = await this.#readAttempt(idempotencyKey);
          if (!stored) fail("UNAVAILABLE", "Hosted reconciliation did not round-trip");
          return { replay: false, attempt: toAttempt(stored) };
        }
      } catch (error) {
        if (error instanceof NearHostedStoreError) throw error;
        const prior = await this.#readEvidence(idempotencyKey, input.transitionId).catch(() => undefined);
        if (prior) {
          if (prior.evidence_json !== evidenceJson) fail("IDEMPOTENCY_CONFLICT", "Transition ID was reused for different evidence");
          const stored = await this.#readAttempt(idempotencyKey);
          if (!stored) fail("UNAVAILABLE", "Hosted reconciliation replay lost its attempt");
          return { replay: true, attempt: toAttempt(stored) };
        }
        if (transition.reservationState === "released") continue;
      }
      const latest = await this.#readAttempt(idempotencyKey);
      if (!latest) fail("ATTEMPT_NOT_FOUND", "Hosted NEAR attempt was not found");
      if (latest.entry_revision !== input.expectedEntryRevision) {
        fail("VERSION_CONFLICT", "Hosted attempt changed before reconciliation");
      }
    }
    fail("CONTENTION", "Hosted NEAR reconciliation contention did not converge safely");
  }

  async recordNativeNearToArbitrumEvidence(
    idempotencyKey: string,
    input: NearHostedNativeTransitionInput,
  ): Promise<{
    replay: boolean;
    attempt: NearHostedAttempt;
    lifecycle: NearHostedNativeLifecycle;
  }> {
    identifier(idempotencyKey, "idempotencyKey");
    identifier(input.transitionId, "transitionId");
    nearAccount(input.accountId, "accountId");
    if (!Number.isSafeInteger(input.expectedEntryRevision) || input.expectedEntryRevision < 1) {
      fail("INVALID_INPUT", "Native-route expected entry revision is invalid");
    }

    let attempt: AttemptRow;
    let lifecycle: NativeLifecycleRow | undefined;
    let priorEvidence: EvidenceRow | undefined;
    let counter: CounterRow;
    try {
      const [attemptResult, lifecycleResult, evidenceResult, counterResult] = await this.database.batch([
        this.database.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM near_hosted_attempts
          WHERE tenant_id = ? AND principal_id = ? AND idempotency_key = ?`)
          .bind(this.tenantId, this.principalId, idempotencyKey),
        this.database.prepare(`SELECT ${NATIVE_LIFECYCLE_COLUMNS}
          FROM near_native_to_arbitrum_usdc_lifecycles
          WHERE tenant_id = ? AND principal_id = ? AND idempotency_key = ?`)
          .bind(this.tenantId, this.principalId, idempotencyKey),
        this.database.prepare(`SELECT evidence_json FROM near_attempt_reconciliation_evidence
          WHERE tenant_id = ? AND principal_id = ? AND idempotency_key = ? AND transition_id = ?`)
          .bind(this.tenantId, this.principalId, idempotencyKey, input.transitionId),
        this.database.prepare(`SELECT consumed_atomic, revision FROM near_attempt_budget_counters
          WHERE tenant_id = ? AND principal_id = ? AND network = 'near:mainnet'
            AND asset_id = ?`).bind(this.tenantId, this.principalId, WRAPPED_NEAR_ASSET),
      ]);
      const found = first<AttemptRow>(attemptResult);
      if (!found) fail("ATTEMPT_NOT_FOUND", "Hosted NEAR attempt was not found");
      attempt = found;
      lifecycle = first<NativeLifecycleRow>(lifecycleResult);
      priorEvidence = first<EvidenceRow>(evidenceResult);
      counter = validateCounter(first<CounterRow>(counterResult));
    } catch (error) {
      if (error instanceof NearHostedStoreError) throw error;
      fail("UNAVAILABLE", "Native-to-Arbitrum schema 0020 is unavailable; lifecycle remains fail-closed");
    }

    await this.dependencies.afterReconciliationRead?.();

    if (attempt.account_id !== input.accountId) {
      fail("INVALID_TRANSITION", "Native funding account does not match the reserved principal account");
    }
    if (!lifecycle) {
      fail("INVALID_TRANSITION", "Native funding requires an atomically reserved immutable route binding");
    }
    const binding = validateNativeBinding(input.binding, attempt, input.accountId);
    if (!sameNativeBinding(lifecycle, binding)) {
      fail("IDEMPOTENCY_CONFLICT", "Native-to-Arbitrum binding changed after durable admission");
    }
    const plan = validateNativeEvidence(input.evidence, binding, lifecycle);
    const digest = await evidenceDigest(plan.evidence);
    if (priorEvidence) {
      if (priorEvidence.evidence_json !== plan.evidenceJson || !lifecycle) {
        fail("IDEMPOTENCY_CONFLICT", "Native-route transition ID was reused for different evidence");
      }
      return {
        replay: true,
        attempt: toAttempt(attempt),
        lifecycle: toNativeLifecycle(lifecycle),
      };
    }
    const checkedAt = iso(plan.checkedAt, "native-route evidence time");
    if (checkedAt > this.#trustedNow() || checkedAt < iso(attempt.updated_at, "stored updatedAt")) {
      fail("INVALID_INPUT", "Native-route evidence time must be monotonic and no later than the trusted Worker clock");
    }
    if (plan.evidence.version === "pilot-near-native-near-source-funding-v1") {
      const includedAt = iso(plan.evidence.included_at, "included_at");
      if (includedAt < iso(attempt.created_at, "createdAt") ||
          includedAt > iso(attempt.approval_expires_at, "approvalExpiresAt")) {
        fail("INVALID_TRANSITION", "Native funding must be finalized inside the approved quote window");
      }
    }
    if (attempt.entry_revision !== input.expectedEntryRevision ||
        lifecycle.entry_revision !== input.expectedEntryRevision) {
      fail("VERSION_CONFLICT", "Hosted native-route attempt changed before evidence admission");
    }

    let counterNext = counter.consumed_atomic;
    if (plan.state === "refunded") {
      if (BigInt(counter.consumed_atomic) < BigInt(attempt.amount_atomic)) {
        fail("UNAVAILABLE", "Hosted NEAR budget counter is smaller than the refunded reservation");
      }
      counterNext = (BigInt(counter.consumed_atomic) - BigInt(attempt.amount_atomic)).toString();
    }
    try {
      const sourceEvidence = plan.evidence.version === "pilot-near-native-near-source-funding-v1"
        ? plan.evidence
        : undefined;
      const result = await this.database.prepare(`UPDATE near_native_to_arbitrum_usdc_lifecycles SET
        lifecycle_state = ?, lifecycle_revision = lifecycle_revision + 1,
        entry_revision = entry_revision + 1, last_transition_id = ?, last_evidence_kind = ?,
        last_provider_status = ?, last_evidence_digest = ?, last_evidence_json = ?, updated_at = ?,
        source_transaction_hash = COALESCE(?, source_transaction_hash),
        source_receipt_id = COALESCE(?, source_receipt_id),
        source_block_height = COALESCE(?, source_block_height),
        source_included_at = COALESCE(?, source_included_at),
        source_verified_at = COALESCE(?, source_verified_at),
        destination_transaction_hash = ?, destination_log_index = ?, refund_transaction_hash = ?,
        counter_expected_atomic = ?, counter_expected_revision = ?, counter_next_atomic = ?
      WHERE tenant_id = ? AND principal_id = ? AND account_id = ? AND idempotency_key = ?
        AND lifecycle_revision = ? AND entry_revision = ?
        AND lifecycle_state NOT IN ('destination_verified','refunded')`)
        .bind(
          plan.state, input.transitionId, plan.kind, plan.providerStatus, digest,
          plan.evidenceJson, plan.checkedAt,
          sourceEvidence?.transaction_hash ?? null, sourceEvidence?.receipt_id ?? null,
          sourceEvidence?.block_height ?? null, sourceEvidence?.included_at ?? null,
          sourceEvidence?.verified_at ?? null,
          plan.destinationTransactionHash, plan.destinationLogIndex, plan.refundTransactionHash,
          counter.consumed_atomic, counter.revision, counterNext,
          this.tenantId, this.principalId, input.accountId, idempotencyKey,
          lifecycle.lifecycle_revision, input.expectedEntryRevision,
        ).run();
      if (changes(result) !== 1) {
        const replay = await this.#readEvidence(idempotencyKey, input.transitionId);
        const latestLifecycle = await this.#readNativeLifecycle(idempotencyKey);
        const latestAttempt = await this.#readAttempt(idempotencyKey);
        if (replay?.evidence_json === plan.evidenceJson && latestLifecycle && latestAttempt) {
          return {
            replay: true,
            attempt: toAttempt(latestAttempt),
            lifecycle: toNativeLifecycle(latestLifecycle),
          };
        }
        fail("VERSION_CONFLICT", "Hosted native-route attempt changed before evidence admission");
      }
    } catch (error) {
      if (error instanceof NearHostedStoreError) throw error;
      const replay = await this.#readEvidence(idempotencyKey, input.transitionId).catch(() => undefined);
      const latestLifecycle = await this.#readNativeLifecycle(idempotencyKey).catch(() => undefined);
      const latestAttempt = await this.#readAttempt(idempotencyKey).catch(() => undefined);
      if (replay?.evidence_json === plan.evidenceJson && latestLifecycle && latestAttempt &&
          sameNativeBinding(latestLifecycle, binding)) {
        return {
          replay: true,
          attempt: toAttempt(latestAttempt),
          lifecycle: toNativeLifecycle(latestLifecycle),
        };
      }
      if (latestLifecycle && latestLifecycle.entry_revision !== input.expectedEntryRevision) {
        fail("VERSION_CONFLICT", "Hosted native-route attempt changed before evidence admission");
      }
      fail("INVALID_TRANSITION", "Hosted native-route evidence failed durable database guards");
    }

    const [storedAttempt, storedLifecycle] = await Promise.all([
      this.#readAttempt(idempotencyKey),
      this.#readNativeLifecycle(idempotencyKey),
    ]);
    if (!storedAttempt || !storedLifecycle) {
      fail("UNAVAILABLE", "Hosted native-route evidence did not round-trip durably");
    }
    return {
      replay: false,
      attempt: toAttempt(storedAttempt),
      lifecycle: toNativeLifecycle(storedLifecycle),
    };
  }
  async budgetConsumed(assetId: string): Promise<string> {
    if (!ASSET_ID.test(assetId)) fail("INVALID_INPUT", "Budget scope is invalid");
    const row = await this.database.prepare(`SELECT consumed_atomic, revision
      FROM near_attempt_budget_counters WHERE tenant_id = ? AND principal_id = ?
        AND network = 'near:mainnet' AND asset_id = ?`)
      .bind(this.tenantId, this.principalId, assetId).first<CounterRow>();
    return validateCounter(row ?? undefined).consumed_atomic;
  }

  async #readAttempt(idempotencyKey: string): Promise<AttemptRow | undefined> {
    return (await this.database.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM near_hosted_attempts
      WHERE tenant_id = ? AND principal_id = ? AND idempotency_key = ?`)
      .bind(this.tenantId, this.principalId, idempotencyKey).first<AttemptRow>()) ?? undefined;
  }

  async #readNativeLifecycle(idempotencyKey: string): Promise<NativeLifecycleRow | undefined> {
    return (await this.database.prepare(`SELECT ${NATIVE_LIFECYCLE_COLUMNS}
      FROM near_native_to_arbitrum_usdc_lifecycles
      WHERE tenant_id = ? AND principal_id = ? AND idempotency_key = ?`)
      .bind(this.tenantId, this.principalId, idempotencyKey).first<NativeLifecycleRow>()) ?? undefined;
  }

  async #readNativeLifecycleIfAvailable(idempotencyKey: string): Promise<NativeLifecycleRow | undefined> {
    try {
      return await this.#readNativeLifecycle(idempotencyKey);
    } catch {
      // Schema 0018 remains safe: generic provider terminal observations are
      // nonterminal, while native-route finalization is unavailable until the
      // reviewed forward migration is applied.
      return undefined;
    }
  }

  #trustedNow(): number {
    const value = this.dependencies.now?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("UNAVAILABLE", "Trusted Worker clock is unavailable");
    }
    return value;
  }

  async #readEvidence(idempotencyKey: string, transitionId: string): Promise<EvidenceRow | undefined> {
    return (await this.database.prepare(`SELECT evidence_json FROM near_attempt_reconciliation_evidence
      WHERE tenant_id = ? AND principal_id = ? AND idempotency_key = ? AND transition_id = ?`)
      .bind(this.tenantId, this.principalId, idempotencyKey, transitionId).first<EvidenceRow>()) ?? undefined;
  }

  #evidenceJson(row: AttemptRow, input: NearHostedEvidenceInput): string {
    if (input.depositAddress !== row.deposit_address || input.depositMemo !== (row.deposit_memo ?? undefined)) {
      fail("INVALID_INPUT", "Reconciliation deposit route does not match the approved attempt");
    }
    return canonicalJson({
      version: "pilot-near-reconciliation-v1",
      outcome: input.outcome,
      attempt_id: row.attempt_id,
      principal_id: row.principal_id,
      account_id: row.account_id,
      network: "near:mainnet",
      checked_at: input.checkedAt,
      deposit_address: input.depositAddress,
      deposit_memo: input.depositMemo,
      provider_status: input.providerStatus,
      reason: input.unknownReason,
      evidence_digest: input.evidenceDigest,
      safe_to_resubmit: false,
    });
  }

  #nextTransition(row: AttemptRow, input: NearHostedEvidenceInput): Readonly<{
    state: NearHostedAttemptState;
    reservationState: NearHostedReservationState;
    providerStatus: NearHostedProviderStatus | null;
    unknownSince: string | null;
    reservationRevisionIncrement: 0 | 1;
    recordedOutcome: "unknown" | "pending" | "terminal";
    recordedProviderStatus: NearHostedProviderStatus | null;
    recordedUnknownReason: NearHostedUnknownReason | null;
    recordedEvidenceDigest: string | null;
  }> {
    if (input.outcome === "unknown") {
      if (!input.unknownReason || input.providerStatus !== undefined || input.evidenceDigest !== undefined ||
          !["approved", "unknown", "pending"].includes(row.state)) {
        fail("INVALID_TRANSITION", "Unknown reconciliation evidence is invalid for the current attempt");
      }
      return {
        state: "unknown", reservationState: "outcome_unknown", providerStatus: null,
        unknownSince: row.unknown_since ?? input.checkedAt, reservationRevisionIncrement: 1,
        recordedOutcome: "unknown", recordedProviderStatus: null,
        recordedUnknownReason: input.unknownReason, recordedEvidenceDigest: null,
      };
    }
    if (input.outcome === "pending") {
      if (!input.providerStatus || ![
        "KNOWN_DEPOSIT_TX", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING",
      ].includes(input.providerStatus) || input.unknownReason !== undefined || input.evidenceDigest !== undefined ||
          !["unknown", "pending"].includes(row.state)) {
        fail("INVALID_TRANSITION", "Pending reconciliation evidence is invalid for the current attempt");
      }
      return {
        state: "pending", reservationState: "outcome_unknown", providerStatus: input.providerStatus,
        unknownSince: null, reservationRevisionIncrement: 0,
        recordedOutcome: "pending", recordedProviderStatus: input.providerStatus,
        recordedUnknownReason: null, recordedEvidenceDigest: null,
      };
    }
    if (!input.providerStatus || !["SUCCESS", "REFUNDED", "FAILED"].includes(input.providerStatus) ||
        !input.evidenceDigest || input.unknownReason !== undefined || !["unknown", "pending"].includes(row.state)) {
      fail("INVALID_TRANSITION", "Terminal reconciliation evidence is invalid for the current attempt");
    }
    // A 1Click provider terminal status is an observation, not independent
    // settlement evidence. The v1 hosted schema does not retain the exact
    // approved destination asset/recipient/minimum-output or origin refund
    // route needed to verify a terminal transition. Preserve the provider
    // observation in last_evidence_json, but deliberately persist a generic
    // UNKNOWN transition so the reservation cannot be released or committed.
    // Only the route-specific native-to-Arbitrum lifecycle carries the
    // immutable receipt bindings required to finalize.
    return {
      state: "unknown",
      reservationState: "outcome_unknown",
      providerStatus: null,
      unknownSince: row.unknown_since ?? input.checkedAt,
      reservationRevisionIncrement: 1,
      recordedOutcome: "unknown",
      recordedProviderStatus: null,
      recordedUnknownReason: "unavailable",
      recordedEvidenceDigest: null,
    };
  }
}
