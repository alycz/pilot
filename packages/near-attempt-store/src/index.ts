import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  NearApprovalBindingSchema,
  NearBudgetReservationSchema,
  NearBudgetReservationTransitionSchema,
  NearExecutionAttemptSchema,
  NearExecutionReplayDecisionSchema,
  NearIdempotencyBindingSchema,
  NearPrincipalAuthorizationSchema,
  NearReconciliationEvidenceSchema,
  NEAR_APPROVAL_DIGEST_DOMAIN,
  canonicalNearApprovalJson,
  computeNearApprovalDigest,
  type NearApprovalBinding,
  type NearBudgetReservation,
  type NearExecutionAttempt,
  type NearExecutionReplayDecision,
  type NearIdempotencyBinding,
  type NearPrincipalAuthorization,
  type NearReconciliationEvidence,
} from "@pilot/contracts/near";

export const NEAR_ATTEMPT_STORE_SCHEMA_VERSION = 1 as const;

export type NearAttemptArtifactKind =
  | "provider_verified_executable_quote"
  | "dry_quote"
  | "fixture";

export type NearAttemptRequestPayload = Readonly<{
  artifact_kind: NearAttemptArtifactKind;
  authorization: unknown;
  approval: unknown;
  approval_digest: string;
  attempt_id: string;
  reservation_id: string;
  asset_id: string;
  amount_atomic: string;
  budget_limit_atomic: string;
}>;

export type NearReserveAttemptInput = NearAttemptRequestPayload & Readonly<{
  idempotency: unknown;
}>;

export type NearEvidenceEvent = Readonly<{
  transition_id: string;
  evidence: NearReconciliationEvidence;
}>;

export type NearAttemptEntry = Readonly<{
  version: "pilot-near-attempt-entry-v1";
  entry_revision: number;
  artifact_kind: "provider_verified_executable_quote";
  request_fingerprint: string;
  authorization: NearPrincipalAuthorization;
  idempotency: NearIdempotencyBinding;
  approval: NearApprovalBinding;
  budget_limit_atomic: string;
  attempt: NearExecutionAttempt;
  reservation: NearBudgetReservation;
  evidence_log: readonly NearEvidenceEvent[];
}>;

export type NearAttemptSnapshot = Readonly<{
  schema_version: typeof NEAR_ATTEMPT_STORE_SCHEMA_VERSION;
  revision: number;
  entries: readonly NearAttemptEntry[];
}>;

export type NearReserveAttemptResult = Readonly<{
  replay: boolean;
  entry: NearAttemptEntry;
}>;

export type NearEvidenceTransitionInput = Readonly<{
  principal_id: string;
  idempotency_key: string;
  transition_id: string;
  expected_entry_revision: number;
  evidence: unknown;
}>;

export type NearEvidenceTransitionResult = Readonly<{
  replay: boolean;
  entry: NearAttemptEntry;
}>;

export type NearBudgetSummary = Readonly<{
  principal_id: string;
  asset_id: string;
  reserved_atomic: string;
  unknown_atomic: string;
  committed_atomic: string;
  consumed_atomic: string;
}>;

export type NearAttemptStoreErrorCode =
  | "INVALID_INPUT"
  | "NOT_EXECUTABLE"
  | "AUTHORIZATION_INVALID"
  | "APPROVAL_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "VERSION_CONFLICT"
  | "BUDGET_EXCEEDED"
  | "ATTEMPT_NOT_FOUND"
  | "INVALID_TRANSITION"
  | "PERSISTENCE_CORRUPT";

export class NearAttemptStoreError extends Error {
  constructor(readonly code: NearAttemptStoreErrorCode, message: string) {
    super(message);
    this.name = "NearAttemptStoreError";
  }
}

type PersistenceMutation<T> =
  | Readonly<{ commit: false; value: T }>
  | Readonly<{ commit: true; next: NearAttemptSnapshot; value: T }>;

export interface NearAttemptPersistence {
  read(): Promise<NearAttemptSnapshot>;
  transact<T>(mutate: (
    current: NearAttemptSnapshot,
  ) => PersistenceMutation<T> | Promise<PersistenceMutation<T>>): Promise<T>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DIGEST = /^[A-F0-9]{64}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*:\S{1,319}$/;
const ATOMIC = /^(?:0|[1-9][0-9]*)$/;
const MAX_STATE_BYTES = 8 * 1024 * 1024;

function emptySnapshot(): NearAttemptSnapshot {
  return { schema_version: NEAR_ATTEMPT_STORE_SCHEMA_VERSION, revision: 0, entries: [] };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fail(code: NearAttemptStoreErrorCode, message: string): never {
  throw new NearAttemptStoreError(code, message);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveAtomic(value: string, label: string): bigint {
  if (!ATOMIC.test(value) || value.length > 128 || BigInt(value) <= 0n) {
    fail("INVALID_INPUT", `${label} must be a positive atomic-unit integer string`);
  }
  return BigInt(value);
}

function safeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) fail("INVALID_INPUT", `${label} is invalid`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_INPUT", "Canonical request rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("INVALID_INPUT", "Canonical request contains an unsupported value");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").toUpperCase();
}

type NormalizedPayload = Readonly<{
  artifact_kind: "provider_verified_executable_quote";
  authorization: NearPrincipalAuthorization;
  approval: NearApprovalBinding;
  approval_digest: string;
  attempt_id: string;
  reservation_id: string;
  asset_id: string;
  amount_atomic: string;
  budget_limit_atomic: string;
}>;

async function normalizePayload(
  input: NearAttemptRequestPayload,
  createdAt?: string,
): Promise<NormalizedPayload> {
  if (input.artifact_kind !== "provider_verified_executable_quote") {
    fail("NOT_EXECUTABLE", "Dry quotes and fixtures can never reserve executable budget");
  }
  safeId(input.attempt_id, "attempt_id");
  safeId(input.reservation_id, "reservation_id");
  if (!DIGEST.test(input.approval_digest) || !ASSET_ID.test(input.asset_id)) {
    fail("INVALID_INPUT", "Approval digest or asset ID is invalid");
  }
  const amount = positiveAtomic(input.amount_atomic, "amount_atomic");
  const budget = positiveAtomic(input.budget_limit_atomic, "budget_limit_atomic");
  if (amount > budget) fail("BUDGET_EXCEEDED", "Attempt amount exceeds its approved budget limit");

  const authorizationResult = NearPrincipalAuthorizationSchema.safeParse(input.authorization);
  if (!authorizationResult.success) fail("AUTHORIZATION_INVALID", "Principal authorization is invalid");
  const approvalResult = NearApprovalBindingSchema.safeParse(input.approval);
  if (!approvalResult.success) fail("APPROVAL_MISMATCH", "Executable approval binding is invalid");
  const authorization = authorizationResult.data;
  const approval = approvalResult.data;
  if (
    authorization.principal_id !== approval.principal_id
    || authorization.account_id !== approval.account_id
    || authorization.network !== approval.network
    || !authorization.operations.includes("near.intents.approval.review")
  ) fail("AUTHORIZATION_INVALID", "Principal authorization does not cover the exact approval identity");
  if (createdAt !== undefined && (
    Date.parse(authorization.issued_at) > Date.parse(createdAt)
    || Date.parse(authorization.expires_at) <= Date.parse(createdAt)
  )) fail("AUTHORIZATION_INVALID", "Principal authorization is not active at attempt creation");
  if (approval.origin_asset !== input.asset_id || approval.amount_in !== input.amount_atomic) {
    fail("APPROVAL_MISMATCH", "Budget reservation does not match the approved input asset and amount");
  }
  if (await computeNearApprovalDigest(approval) !== input.approval_digest) {
    fail("APPROVAL_MISMATCH", "Approval digest does not bind the executable quote");
  }
  return {
    artifact_kind: input.artifact_kind,
    authorization,
    approval,
    approval_digest: input.approval_digest,
    attempt_id: input.attempt_id,
    reservation_id: input.reservation_id,
    asset_id: input.asset_id,
    amount_atomic: input.amount_atomic,
    budget_limit_atomic: input.budget_limit_atomic,
  };
}

function requestFingerprint(payload: NormalizedPayload): string {
  return sha256(payload);
}

export async function computeNearAttemptRequestDigest(
  input: NearAttemptRequestPayload,
): Promise<string> {
  return requestFingerprint(await normalizePayload(input));
}

function validateEntry(value: unknown): asserts value is NearAttemptEntry {
  if (!object(value) || !exactKeys(value, [
    "version", "entry_revision", "artifact_kind", "request_fingerprint", "authorization",
    "idempotency", "approval", "budget_limit_atomic", "attempt", "reservation", "evidence_log",
  ])) fail("PERSISTENCE_CORRUPT", "NEAR attempt entry shape is invalid");
  if (value.version !== "pilot-near-attempt-entry-v1" ||
      !Number.isSafeInteger(value.entry_revision) || Number(value.entry_revision) < 1 ||
      value.artifact_kind !== "provider_verified_executable_quote" ||
      typeof value.request_fingerprint !== "string" || !DIGEST.test(value.request_fingerprint) ||
      typeof value.budget_limit_atomic !== "string" || !ATOMIC.test(value.budget_limit_atomic) ||
      !Array.isArray(value.evidence_log)) fail("PERSISTENCE_CORRUPT", "NEAR attempt entry metadata is invalid");
  const authorization = NearPrincipalAuthorizationSchema.safeParse(value.authorization);
  const idempotency = NearIdempotencyBindingSchema.safeParse(value.idempotency);
  const approval = NearApprovalBindingSchema.safeParse(value.approval);
  const attempt = NearExecutionAttemptSchema.safeParse(value.attempt);
  const reservation = NearBudgetReservationSchema.safeParse(value.reservation);
  if (!authorization.success || !idempotency.success || !approval.success || !attempt.success || !reservation.success) {
    fail("PERSISTENCE_CORRUPT", "NEAR attempt entry violates shared contracts");
  }
  const identity = [
    authorization.data.principal_id, authorization.data.account_id, authorization.data.network,
    idempotency.data.principal_id, idempotency.data.account_id, idempotency.data.network,
    approval.data.principal_id, approval.data.account_id, approval.data.network,
    attempt.data.principal_id, attempt.data.account_id, attempt.data.network,
    reservation.data.principal_id, reservation.data.account_id, reservation.data.network,
  ];
  if (new Set([identity[0], identity[3], identity[6], identity[9], identity[12]]).size !== 1 ||
      new Set([identity[1], identity[4], identity[7], identity[10], identity[13]]).size !== 1 ||
      new Set([identity[2], identity[5], identity[8], identity[11], identity[14]]).size !== 1 ||
      attempt.data.idempotency_key !== idempotency.data.idempotency_key ||
      reservation.data.idempotency_key !== idempotency.data.idempotency_key ||
      idempotency.data.request_digest !== value.request_fingerprint ||
      attempt.data.idempotency_request_digest !== idempotency.data.request_digest ||
      reservation.data.request_digest !== idempotency.data.request_digest ||
      attempt.data.reservation_id !== reservation.data.reservation_id ||
      reservation.data.policy_digest !== approval.data.policy_digest ||
      reservation.data.asset_id !== approval.data.origin_asset ||
      reservation.data.amount_atomic !== approval.data.amount_in) {
    fail("PERSISTENCE_CORRUPT", "NEAR attempt entry identities do not match");
  }
  const persistedApprovalDigest = createHash("sha256")
    .update(`${NEAR_APPROVAL_DIGEST_DOMAIN}\0${canonicalNearApprovalJson(approval.data)}`)
    .digest("hex")
    .toUpperCase();
  if (persistedApprovalDigest !== attempt.data.approval_digest ||
      !ATOMIC.test(value.budget_limit_atomic) ||
      BigInt(value.budget_limit_atomic) < BigInt(reservation.data.amount_atomic)) {
    fail("PERSISTENCE_CORRUPT", "NEAR attempt approval or budget integrity check failed");
  }
  const expectedReservationState = attempt.data.state === "approved"
    ? "reserved"
    : attempt.data.state === "unknown" || attempt.data.state === "pending"
      ? "outcome_unknown"
      : attempt.data.state === "settled"
        ? "committed"
        : attempt.data.state === "refunded" || attempt.data.state === "failed"
          ? "released"
          : undefined;
  if (expectedReservationState === undefined || reservation.data.state !== expectedReservationState ||
      (attempt.data.state === "refunded" && reservation.data.state === "released"
        && reservation.data.release_reason !== "provider_refunded") ||
      (attempt.data.state === "failed" && reservation.data.state === "released"
        && reservation.data.release_reason !== "provider_failed_after_reconciliation")) {
    fail("PERSISTENCE_CORRUPT", "NEAR attempt and reservation states do not match");
  }
  const reconstructed: NormalizedPayload = {
    artifact_kind: "provider_verified_executable_quote",
    authorization: authorization.data,
    approval: approval.data,
    approval_digest: attempt.data.approval_digest,
    attempt_id: attempt.data.attempt_id,
    reservation_id: reservation.data.reservation_id,
    asset_id: reservation.data.asset_id,
    amount_atomic: reservation.data.amount_atomic,
    budget_limit_atomic: value.budget_limit_atomic,
  };
  if (requestFingerprint(reconstructed) !== value.request_fingerprint) {
    fail("PERSISTENCE_CORRUPT", "NEAR attempt request fingerprint is invalid");
  }
  const transitionIds = new Set<string>();
  for (const event of value.evidence_log) {
    if (!object(event) || !exactKeys(event, ["transition_id", "evidence"]) ||
        typeof event.transition_id !== "string" || !SAFE_ID.test(event.transition_id) ||
        !NearReconciliationEvidenceSchema.safeParse(event.evidence).success || transitionIds.has(event.transition_id)) {
      fail("PERSISTENCE_CORRUPT", "NEAR evidence log is invalid");
    }
    const evidence = NearReconciliationEvidenceSchema.parse(event.evidence);
    if (evidence.attempt_id !== attempt.data.attempt_id ||
        evidence.principal_id !== attempt.data.principal_id ||
        evidence.account_id !== attempt.data.account_id ||
        evidence.network !== attempt.data.network ||
        evidence.deposit_address !== approval.data.deposit_address ||
        evidence.deposit_memo !== approval.data.deposit_memo) {
      fail("PERSISTENCE_CORRUPT", "NEAR evidence log identity is invalid");
    }
    transitionIds.add(event.transition_id);
  }
  if (value.entry_revision !== value.evidence_log.length + 1) {
    fail("PERSISTENCE_CORRUPT", "NEAR entry revision does not match evidence history");
  }
  const latestEvidence = value.evidence_log.at(-1)?.evidence;
  if ((attempt.data.reconciliation === undefined) !== (latestEvidence === undefined) ||
      (latestEvidence !== undefined && canonicalJson(latestEvidence) !== canonicalJson(attempt.data.reconciliation))) {
    fail("PERSISTENCE_CORRUPT", "NEAR attempt does not match its latest reconciliation evidence");
  }
}

function validateSnapshot(value: unknown): asserts value is NearAttemptSnapshot {
  if (!object(value) || !exactKeys(value, ["schema_version", "revision", "entries"]) ||
      value.schema_version !== NEAR_ATTEMPT_STORE_SCHEMA_VERSION ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.entries)) {
    fail("PERSISTENCE_CORRUPT", "NEAR attempt snapshot requires a reviewed schema migration");
  }
  value.entries.forEach(validateEntry);
  const keys = new Set<string>();
  const attempts = new Set<string>();
  const reservations = new Set<string>();
  for (const entry of value.entries) {
    const key = `${entry.idempotency.principal_id}\u0000${entry.idempotency.idempotency_key}`;
    if (keys.has(key) || attempts.has(entry.attempt.attempt_id) || reservations.has(entry.reservation.reservation_id)) {
      fail("PERSISTENCE_CORRUPT", "NEAR attempt identities must be unique");
    }
    keys.add(key);
    attempts.add(entry.attempt.attempt_id);
    reservations.add(entry.reservation.reservation_id);
  }
}

function findEntry(snapshot: NearAttemptSnapshot, principalId: string, idempotencyKey: string): NearAttemptEntry | undefined {
  return snapshot.entries.find((entry) =>
    entry.idempotency.principal_id === principalId && entry.idempotency.idempotency_key === idempotencyKey);
}

function replaceEntry(snapshot: NearAttemptSnapshot, replacement: NearAttemptEntry): NearAttemptSnapshot {
  return {
    schema_version: NEAR_ATTEMPT_STORE_SCHEMA_VERSION,
    revision: snapshot.revision + 1,
    entries: snapshot.entries.map((entry) =>
      entry.attempt.attempt_id === replacement.attempt.attempt_id ? replacement : entry),
  };
}

function validateEvidence(entry: NearAttemptEntry, raw: unknown): NearReconciliationEvidence {
  const parsed = NearReconciliationEvidenceSchema.safeParse(raw);
  if (!parsed.success) fail("INVALID_INPUT", "Reconciliation evidence is invalid");
  const evidence = parsed.data;
  if (
    evidence.attempt_id !== entry.attempt.attempt_id
    || evidence.principal_id !== entry.attempt.principal_id
    || evidence.account_id !== entry.attempt.account_id
    || evidence.network !== entry.attempt.network
    || evidence.deposit_address !== entry.approval.deposit_address
    || evidence.deposit_memo !== entry.approval.deposit_memo
  ) fail("INVALID_INPUT", "Reconciliation evidence does not match the exact attempt and deposit route");
  if (Date.parse(evidence.checked_at) < Date.parse(entry.attempt.updated_at)) {
    fail("INVALID_INPUT", "Reconciliation evidence cannot move attempt time backwards");
  }
  if (evidence.outcome === "terminal" && evidence.evidence_digest === undefined) {
    fail("INVALID_INPUT", "Terminal reconciliation requires durable evidence digest");
  }
  return evidence;
}

function previousEvent(entry: NearAttemptEntry, event: NearEvidenceEvent): boolean | undefined {
  const previous = entry.evidence_log.find((item) => item.transition_id === event.transition_id);
  if (!previous) return undefined;
  if (canonicalJson(previous) !== canonicalJson(event)) {
    fail("IDEMPOTENCY_CONFLICT", "Transition ID was already used for different reconciliation evidence");
  }
  return true;
}

function replaceReservation(
  current: NearBudgetReservation,
  evidence: NearReconciliationEvidence,
): NearBudgetReservation {
  // A pending provider observation advances the attempt but does not mutate or
  // release the existing outcome-unknown reservation.
  if (evidence.outcome === "pending") return current;
  const base = {
    version: current.version,
    reservation_id: current.reservation_id,
    principal_id: current.principal_id,
    account_id: current.account_id,
    network: current.network,
    idempotency_version: current.idempotency_version,
    idempotency_key: current.idempotency_key,
    request_digest: current.request_digest,
    policy_digest: current.policy_digest,
    asset_id: current.asset_id,
    amount_atomic: current.amount_atomic,
    revision: current.revision + 1,
    created_at: current.created_at,
    updated_at: evidence.checked_at,
  } as const;
  const next = evidence.outcome === "terminal" && evidence.provider_status === "SUCCESS"
    ? NearBudgetReservationSchema.parse({
      ...base,
      state: "committed",
      counts_against_budget: true,
      committed_at: evidence.checked_at,
    })
    : evidence.outcome === "terminal"
      ? NearBudgetReservationSchema.parse({
      ...base,
      state: "released",
      counts_against_budget: false,
      released_at: evidence.checked_at,
      release_reason: evidence.provider_status === "REFUNDED"
        ? "provider_refunded"
        : "provider_failed_after_reconciliation",
      })
      : NearBudgetReservationSchema.parse({
        ...base,
        state: "outcome_unknown",
        counts_against_budget: true,
        unknown_since: current.state === "outcome_unknown" ? current.unknown_since : evidence.checked_at,
      });
  NearBudgetReservationTransitionSchema.parse({
    version: "pilot-near-budget-reservation-transition-v1",
    reservation_id: current.reservation_id,
    principal_id: current.principal_id,
    account_id: current.account_id,
    network: current.network,
    expected_state: current.state,
    expected_revision: current.revision,
    next,
    reconciliation: evidence,
  });
  return next;
}

function replaceAttempt(
  current: NearExecutionAttempt,
  evidence: NearReconciliationEvidence,
): NearExecutionAttempt {
  const terminalState = evidence.outcome === "terminal"
    ? evidence.provider_status === "SUCCESS" ? "settled"
      : evidence.provider_status === "REFUNDED" ? "refunded" : "failed"
    : undefined;
  const state = terminalState ?? (evidence.outcome === "pending" ? "pending" : "unknown");
  return NearExecutionAttemptSchema.parse({
    ...current,
    state,
    provider_status: "provider_status" in evidence ? evidence.provider_status : undefined,
    reconciliation: evidence,
    updated_at: evidence.checked_at,
    unknown_since: state === "unknown"
      ? current.unknown_since ?? evidence.checked_at
      : undefined,
  });
}

export class NearAttemptStore {
  constructor(private readonly persistence: NearAttemptPersistence) {}

  async reserve(input: NearReserveAttemptInput): Promise<NearReserveAttemptResult> {
    if (input.artifact_kind !== "provider_verified_executable_quote") {
      fail("NOT_EXECUTABLE", "Dry quotes and fixtures can never reserve executable budget");
    }
    const idempotencyResult = NearIdempotencyBindingSchema.safeParse(input.idempotency);
    if (!idempotencyResult.success) fail("INVALID_INPUT", "Versioned idempotency binding is invalid");
    const idempotency = idempotencyResult.data;
    const payload = await normalizePayload(input, idempotency.created_at);
    const fingerprint = requestFingerprint(payload);
    if (
      idempotency.request_digest !== fingerprint
      || idempotency.principal_id !== payload.approval.principal_id
      || idempotency.account_id !== payload.approval.account_id
      || idempotency.network !== payload.approval.network
      || idempotency.version !== payload.approval.idempotency_version
      || idempotency.idempotency_key !== payload.approval.idempotency_key
    ) fail("IDEMPOTENCY_CONFLICT", "Versioned idempotency binding does not match the exact request");

    return this.persistence.transact<NearReserveAttemptResult>((snapshot) => {
      const existing = findEntry(snapshot, idempotency.principal_id, idempotency.idempotency_key);
      if (existing) {
        if (existing.request_fingerprint !== fingerprint || existing.idempotency.request_digest !== idempotency.request_digest) {
          fail("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request or version");
        }
        return { commit: false, value: { replay: true, entry: clone(existing) } };
      }
      const consumed = snapshot.entries
        .filter((entry) => entry.reservation.principal_id === idempotency.principal_id
          && entry.reservation.asset_id === payload.asset_id
          && entry.reservation.counts_against_budget)
        .reduce((total, entry) => total + BigInt(entry.reservation.amount_atomic), 0n);
      if (consumed + BigInt(payload.amount_atomic) > BigInt(payload.budget_limit_atomic)) {
        fail("BUDGET_EXCEEDED", "Atomic budget reservation would exceed the approved limit");
      }
      const reservation = NearBudgetReservationSchema.parse({
        version: "pilot-near-budget-reservation-v1",
        reservation_id: payload.reservation_id,
        principal_id: idempotency.principal_id,
        account_id: idempotency.account_id,
        network: idempotency.network,
        idempotency_version: idempotency.version,
        idempotency_key: idempotency.idempotency_key,
        request_digest: idempotency.request_digest,
        policy_digest: payload.approval.policy_digest,
        asset_id: payload.asset_id,
        amount_atomic: payload.amount_atomic,
        revision: 1,
        created_at: idempotency.created_at,
        updated_at: idempotency.created_at,
        state: "reserved",
        counts_against_budget: true,
      });
      const attempt = NearExecutionAttemptSchema.parse({
        version: "pilot-near-execution-attempt-v1",
        attempt_id: payload.attempt_id,
        principal_id: idempotency.principal_id,
        account_id: idempotency.account_id,
        network: idempotency.network,
        idempotency_version: idempotency.version,
        idempotency_key: idempotency.idempotency_key,
        idempotency_request_digest: idempotency.request_digest,
        reservation_id: reservation.reservation_id,
        approval_digest: payload.approval_digest,
        quote_id: payload.approval.quote_id,
        state: "approved",
        created_at: idempotency.created_at,
        updated_at: idempotency.created_at,
      });
      const entry: NearAttemptEntry = {
        version: "pilot-near-attempt-entry-v1",
        entry_revision: 1,
        artifact_kind: "provider_verified_executable_quote",
        request_fingerprint: fingerprint,
        authorization: payload.authorization,
        idempotency,
        approval: payload.approval,
        budget_limit_atomic: payload.budget_limit_atomic,
        attempt,
        reservation,
        evidence_log: [],
      };
      const next: NearAttemptSnapshot = {
        schema_version: NEAR_ATTEMPT_STORE_SCHEMA_VERSION,
        revision: snapshot.revision + 1,
        entries: [...snapshot.entries, entry],
      };
      return { commit: true, next, value: { replay: false, entry: clone(entry) } };
    });
  }

  async recordOutcomeUnknown(input: NearEvidenceTransitionInput): Promise<NearEvidenceTransitionResult> {
    return this.transition(input, "unknown");
  }

  async reconcile(input: NearEvidenceTransitionInput): Promise<NearEvidenceTransitionResult> {
    return this.transition(input, "reconcile");
  }

  private async transition(
    input: NearEvidenceTransitionInput,
    mode: "unknown" | "reconcile",
  ): Promise<NearEvidenceTransitionResult> {
    safeId(input.principal_id, "principal_id");
    safeId(input.idempotency_key, "idempotency_key");
    safeId(input.transition_id, "transition_id");
    if (!Number.isSafeInteger(input.expected_entry_revision) || input.expected_entry_revision < 1) {
      fail("INVALID_INPUT", "Expected entry revision is invalid");
    }
    return this.persistence.transact<NearEvidenceTransitionResult>((snapshot) => {
      const entry = findEntry(snapshot, input.principal_id, input.idempotency_key);
      if (!entry) fail("ATTEMPT_NOT_FOUND", "NEAR attempt was not found");
      const evidence = validateEvidence(entry, input.evidence);
      if (mode === "unknown" && evidence.outcome !== "unknown") fail("INVALID_TRANSITION", "Initial unknown outcome requires unknown evidence");
      const event: NearEvidenceEvent = { transition_id: input.transition_id, evidence };
      if (previousEvent(entry, event)) return { commit: false, value: { replay: true, entry: clone(entry) } };
      if (mode === "reconcile" && entry.attempt.state !== "unknown" && entry.attempt.state !== "pending") {
        fail("INVALID_TRANSITION", "Only an unknown or pending attempt may be reconciled");
      }
      if (entry.entry_revision !== input.expected_entry_revision) fail("VERSION_CONFLICT", "Attempt changed before reconciliation was recorded");
      if (mode === "unknown" && entry.attempt.state !== "approved") fail("INVALID_TRANSITION", "Only an approved reserved attempt may enter unknown outcome");
      const replacement: NearAttemptEntry = {
        ...entry,
        entry_revision: entry.entry_revision + 1,
        attempt: replaceAttempt(entry.attempt, evidence),
        reservation: replaceReservation(entry.reservation, evidence),
        evidence_log: [...entry.evidence_log, event],
      };
      return {
        commit: true,
        next: replaceEntry(snapshot, replacement),
        value: { replay: false, entry: clone(replacement) },
      };
    });
  }

  async replayDecision(principalId: string, idempotencyKey: string): Promise<NearExecutionReplayDecision> {
    safeId(principalId, "principal_id");
    safeId(idempotencyKey, "idempotency_key");
    const entry = findEntry(await this.persistence.read(), principalId, idempotencyKey);
    if (!entry) fail("ATTEMPT_NOT_FOUND", "NEAR attempt was not found");
    const decision = entry.attempt.state === "unknown"
      ? { action: "blocked_unknown", safe_to_resubmit: false, attempt: entry.attempt }
      : entry.attempt.state === "pending"
        ? { action: "poll_existing", attempt: entry.attempt }
        : ["settled", "refunded", "failed"].includes(entry.attempt.state)
          ? { action: "terminal", attempt: entry.attempt }
          : { action: "return_existing", attempt: entry.attempt };
    return NearExecutionReplayDecisionSchema.parse(decision);
  }

  async budgetSummary(principalId: string, assetId: string): Promise<NearBudgetSummary> {
    safeId(principalId, "principal_id");
    if (!ASSET_ID.test(assetId)) fail("INVALID_INPUT", "Asset ID is invalid");
    const reservations = (await this.persistence.read()).entries
      .map((entry) => entry.reservation)
      .filter((reservation) => reservation.principal_id === principalId && reservation.asset_id === assetId);
    const sum = (state: NearBudgetReservation["state"]) => reservations
      .filter((reservation) => reservation.state === state)
      .reduce((total, reservation) => total + BigInt(reservation.amount_atomic), 0n);
    const reserved = sum("reserved");
    const unknown = sum("outcome_unknown");
    const committed = sum("committed");
    return {
      principal_id: principalId,
      asset_id: assetId,
      reserved_atomic: reserved.toString(),
      unknown_atomic: unknown.toString(),
      committed_atomic: committed.toString(),
      consumed_atomic: (reserved + unknown + committed).toString(),
    };
  }

  async snapshot(): Promise<NearAttemptSnapshot> {
    return clone(await this.persistence.read());
  }
}

export class MemoryNearAttemptPersistence implements NearAttemptPersistence {
  #snapshot: NearAttemptSnapshot;
  #tail: Promise<void> = Promise.resolve();

  constructor(initial: NearAttemptSnapshot = emptySnapshot()) {
    validateSnapshot(initial);
    this.#snapshot = clone(initial);
  }

  async read(): Promise<NearAttemptSnapshot> {
    await this.#tail;
    return clone(this.#snapshot);
  }

  async transact<T>(mutate: (
    current: NearAttemptSnapshot,
  ) => PersistenceMutation<T> | Promise<PersistenceMutation<T>>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      const mutation = await mutate(clone(this.#snapshot));
      if (mutation.commit) {
        validateSnapshot(mutation.next);
        if (mutation.next.revision !== this.#snapshot.revision + 1) {
          fail("PERSISTENCE_CORRUPT", "Snapshot revision must advance exactly once");
        }
        this.#snapshot = clone(mutation.next);
      }
      return clone(mutation.value);
    } finally {
      release();
    }
  }
}

export type LocalFileFaultPhase = "before_rename" | "after_rename";
export type LocalFileNearAttemptPersistenceOptions = Readonly<{
  faultInjector?: (phase: LocalFileFaultPhase) => void | Promise<void>;
}>;

const fileQueues = new Map<string, Promise<void>>();

async function withFileQueue<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const current = previous.then(() => gate);
  fileQueues.set(path, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (fileQueues.get(path) === current) fileQueues.delete(path);
  }
}

/** Single-process, local-only persistence. It is not a hosted DB adapter. */
export class LocalFileNearAttemptPersistence implements NearAttemptPersistence {
  readonly #stateFile: string;
  readonly #faultInjector?: (phase: LocalFileFaultPhase) => void | Promise<void>;

  constructor(stateFile: string, options: LocalFileNearAttemptPersistenceOptions = {}) {
    if (!isAbsolute(stateFile)) throw new TypeError("NEAR local state path must be absolute");
    this.#stateFile = resolve(stateFile);
    this.#faultInjector = options.faultInjector;
  }

  async #readUnlocked(): Promise<NearAttemptSnapshot> {
    try {
      const metadata = await stat(this.#stateFile);
      if (!metadata.isFile() || metadata.size > MAX_STATE_BYTES) fail("PERSISTENCE_CORRUPT", "Local state is invalid or too large");
      const parsed: unknown = JSON.parse(await readFile(this.#stateFile, "utf8"));
      validateSnapshot(parsed);
      return clone(parsed);
    } catch (error) {
      if (object(error) && error.code === "ENOENT") return emptySnapshot();
      if (error instanceof NearAttemptStoreError) throw error;
      fail("PERSISTENCE_CORRUPT", "Local state could not be parsed");
    }
  }

  async read(): Promise<NearAttemptSnapshot> {
    return this.#readUnlocked();
  }

  async #writeAtomic(next: NearAttemptSnapshot): Promise<void> {
    const directory = dirname(this.#stateFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#stateFile}.${process.pid}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#faultInjector?.("before_rename");
      await rename(temporary, this.#stateFile);
      renamed = true;
      try {
        const directoryHandle = await open(directory, "r");
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch {
        // Some local filesystems cannot fsync directories; the file was synced.
      }
      await this.#faultInjector?.("after_rename");
    } finally {
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }

  async transact<T>(mutate: (
    current: NearAttemptSnapshot,
  ) => PersistenceMutation<T> | Promise<PersistenceMutation<T>>): Promise<T> {
    return withFileQueue(this.#stateFile, async () => {
      const current = await this.#readUnlocked();
      const mutation = await mutate(clone(current));
      if (mutation.commit) {
        validateSnapshot(mutation.next);
        if (mutation.next.revision !== current.revision + 1) {
          fail("PERSISTENCE_CORRUPT", "Snapshot revision must advance exactly once");
        }
        await this.#writeAtomic(mutation.next);
      }
      return clone(mutation.value);
    });
  }
}
