const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ACCOUNT_ID = /^[a-z0-9._-]{2,64}$/;
const DIGEST = /^[A-F0-9]{64}$/;
const QUOTE_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,45}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*:\S{1,319}$/;
const ATOMIC = /^(?:0|[1-9][0-9]*)$/;
const MAX_ATOMIC_DIGITS = 128;
const MAX_CONTENTION_RETRIES = 8;

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

function canonicalJson(value: Record<string, unknown>): string {
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(",")}}`;
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
        ]);
        if (changes(results[1]) !== 1) continue;
        const stored = await this.#readAttempt(input.idempotencyKey);
        if (!stored || !sameRequest(stored, input)) fail("UNAVAILABLE", "Hosted reservation did not round-trip exactly");
        return { replay: false, attempt: toAttempt(stored) };
      } catch (error) {
        if (error instanceof NearHostedStoreError) throw error;
        const replay = await this.#readAttempt(input.idempotencyKey).catch(() => undefined);
        if (replay) {
          if (!sameRequest(replay, input)) fail("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different request");
          return { replay: true, attempt: toAttempt(replay) };
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
    // A forward schema must add those immutable bindings before hosted
    // owner-funded attempts may finalize.
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
