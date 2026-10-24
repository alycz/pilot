import {
  verifyExactLedgerSignedBlob,
  type ExactLedgerActionExpectation,
} from "@pilot/wallet";

export const WORK_AGREEMENT_PROVENANCE = "fixture-simulation-only" as const;

export type WorkAgreementNetwork = "testnet" | "devnet";
export type WorkAgreementAction = "create" | "release" | "cancel";

export type WorkAgreementTerms = Readonly<{
  agreementId: string;
  owner: string;
  counterparty: string;
  network: WorkAgreementNetwork;
  amountDrops: string;
  finishAfter?: number;
  cancelAfter?: number;
  condition?: string;
}>;

export type OwnerApprovalExecutionRequest = Readonly<{
  build_id: string;
  idempotency_key: string;
  require_owner_approval: true;
}>;

export type WorkAgreementApproval = Readonly<{
  action: WorkAgreementAction;
  approvalId: string;
  expiresAt: string;
  execution: OwnerApprovalExecutionRequest;
  network: WorkAgreementNetwork;
  validatedLedgerIndex: number;
  validatedAccountSequence: number;
  maxFeeDrops: string;
  sourceTag?: number;
  memos?: readonly unknown[];
  txJson: Readonly<Record<string, unknown>>;
}>;

export type ValidatedWorkAgreementSubmission = Readonly<{
  approvalId: string;
  hash: string;
  ledgerIndex: number;
  validated: true;
  engineResult: "tesSUCCESS";
  txJson: Readonly<Record<string, unknown>>;
}>;

export type CompleteNonInclusionProof = Readonly<{
  approvalId: string;
  outcome: "not_included";
  searchedAll: true;
  validatedLedgerIndex: number;
  checkedThroughLedger: number;
}>;

type History = Readonly<{
  approvalIds: readonly string[];
  idempotencyKeys: readonly string[];
  attemptIds: readonly string[];
}>;

type CommonState = Readonly<{
  provenance: typeof WORK_AGREEMENT_PROVENANCE;
  simulation: true;
  speculosConformanceClaimed: false;
  terms: WorkAgreementTerms;
  revision: number;
  history: History;
}>;

export type DraftWorkAgreementState = CommonState & Readonly<{
  status: "draft";
}>;

export type AwaitingWorkAgreementState = CommonState & Readonly<{
  status: "awaiting_create" | "awaiting_release" | "awaiting_cancel";
  approval: WorkAgreementApproval;
  offerSequence?: number;
  createEvidence?: ValidatedWorkAgreementSubmission;
}>;

export type SubmittingWorkAgreementState = CommonState & Readonly<{
  status: "submitting";
  action: WorkAgreementAction;
  approval: WorkAgreementApproval;
  attemptId: string;
  expectedHash: string;
  offerSequence?: number;
  createEvidence?: ValidatedWorkAgreementSubmission;
}>;

export type UnknownWorkAgreementState = CommonState & Readonly<{
  status: "unknown";
  action: WorkAgreementAction;
  approval: WorkAgreementApproval;
  attemptId: string;
  expectedHash: string;
  reason: "timeout" | "transport_error" | "response_lost";
  offerSequence?: number;
  createEvidence?: ValidatedWorkAgreementSubmission;
}>;

export type ActiveWorkAgreementState = CommonState & Readonly<{
  status: "active";
  offerSequence: number;
  createEvidence: ValidatedWorkAgreementSubmission;
}>;

export type TerminalWorkAgreementState = CommonState & Readonly<{
  status: "released" | "cancelled";
  offerSequence: number;
  createEvidence: ValidatedWorkAgreementSubmission;
  terminalEvidence: ValidatedWorkAgreementSubmission;
}>;

export type WorkAgreementState =
  | DraftWorkAgreementState
  | AwaitingWorkAgreementState
  | SubmittingWorkAgreementState
  | UnknownWorkAgreementState
  | ActiveWorkAgreementState
  | TerminalWorkAgreementState;

const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const POSITIVE_DROPS = /^[1-9]\d*$/;
const HEX = /^(?:[A-F0-9]{2})+$/;
const HASH = /^[A-F0-9]{64}$/;
const UINT32_MAX = 0xffff_ffff;
const MAX_LEDGER_WINDOW = 50;
const ABSOLUTE_MAX_FEE_DROPS = 1_000n;
const BASE_TRANSACTION_FIELDS = [
  "TransactionType",
  "Account",
  "Fee",
  "Sequence",
  "LastLedgerSequence",
  "SourceTag",
  "Memos",
] as const;

function fail(message: string): never {
  throw new Error(message);
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    fail(`${label} must be a non-empty exact string.`);
  }
}

function uint32(value: unknown, label: string, positive = false): asserts value is number {
  if (
    !Number.isSafeInteger(value) || Number(value) < (positive ? 1 : 0) ||
    Number(value) > UINT32_MAX
  ) {
    fail(`${label} must be a${positive ? " positive" : ""} UInt32.`);
  }
}

function hex(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HEX.test(value)) {
    fail(`${label} must be non-empty uppercase hexadecimal bytes.`);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactObject(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function immutableCopy(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy));
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, immutableCopy(child)]),
    ));
  }
  return value;
}

function snapshotApproval(approval: WorkAgreementApproval): WorkAgreementApproval {
  return Object.freeze({
    ...approval,
    execution: Object.freeze({ ...approval.execution }),
    ...(approval.memos === undefined
      ? {}
      : { memos: immutableCopy(approval.memos) as readonly unknown[] }),
    txJson: immutableCopy(approval.txJson) as Readonly<Record<string, unknown>>,
  });
}

function snapshotEvidence(
  evidence: ValidatedWorkAgreementSubmission,
): ValidatedWorkAgreementSubmission {
  return Object.freeze({
    ...evidence,
    txJson: immutableCopy(evidence.txJson) as Readonly<Record<string, unknown>>,
  });
}

function validateTerms(input: WorkAgreementTerms): WorkAgreementTerms {
  nonEmpty(input.agreementId, "Agreement id");
  if (!CLASSIC_ADDRESS.test(input.owner)) fail("Owner must be an XRPL classic address.");
  if (!CLASSIC_ADDRESS.test(input.counterparty)) fail("Counterparty must be an XRPL classic address.");
  if (input.owner === input.counterparty) fail("Owner and counterparty must be different accounts.");
  if (input.network !== "testnet" && input.network !== "devnet") {
    fail("Work agreements are limited to XRPL testnet and devnet.");
  }
  if (!POSITIVE_DROPS.test(input.amountDrops)) fail("Amount must be positive native XRP drops.");
  if (input.finishAfter !== undefined) uint32(input.finishAfter, "FinishAfter", true);
  if (input.cancelAfter !== undefined) uint32(input.cancelAfter, "CancelAfter", true);
  if (input.condition !== undefined) hex(input.condition, "Condition");
  if (input.finishAfter === undefined && input.condition === undefined) {
    fail("An agreement requires FinishAfter or a cryptographic condition.");
  }
  if (input.condition !== undefined && input.cancelAfter === undefined) {
    fail("A conditioned agreement requires CancelAfter so funds cannot remain locked forever.");
  }
  if (
    input.finishAfter !== undefined && input.cancelAfter !== undefined &&
    input.cancelAfter <= input.finishAfter
  ) {
    fail("CancelAfter must be later than FinishAfter.");
  }
  return Object.freeze({ ...input });
}

function emptyHistory(): History {
  return Object.freeze({
    approvalIds: Object.freeze([]),
    idempotencyKeys: Object.freeze([]),
    attemptIds: Object.freeze([]),
  });
}

function common(
  terms: WorkAgreementTerms,
  revision: number,
  history: History,
): CommonState {
  return {
    provenance: WORK_AGREEMENT_PROVENANCE,
    simulation: true,
    speculosConformanceClaimed: false,
    terms,
    revision,
    history,
  };
}

export function createWorkAgreementDraft(terms: WorkAgreementTerms): DraftWorkAgreementState {
  return {
    ...common(validateTerms(terms), 0, emptyHistory()),
    status: "draft",
  };
}

export function ownerApprovalExecutionRequest(
  buildId: string,
  idempotencyKey: string,
): OwnerApprovalExecutionRequest {
  nonEmpty(buildId, "Build id");
  nonEmpty(idempotencyKey, "Idempotency key");
  return Object.freeze({
    build_id: buildId,
    idempotency_key: idempotencyKey,
    require_owner_approval: true,
  });
}

function expectedStatus(action: WorkAgreementAction): AwaitingWorkAgreementState["status"] {
  if (action === "create") return "awaiting_create";
  return action === "release" ? "awaiting_release" : "awaiting_cancel";
}

function validateBaseTransaction(
  tx: Readonly<Record<string, unknown>>,
  approval: WorkAgreementApproval,
): void {
  if (tx.TxnSignature !== undefined || tx.Signers !== undefined || tx.Delegate !== undefined) {
    fail("Approval transaction must be unsigned and owner-bound.");
  }
  if (tx.SigningPubKey !== undefined && tx.SigningPubKey !== "") {
    fail("Approval transaction must not contain a signing public key.");
  }
  if (typeof tx.Fee !== "string" || !POSITIVE_DROPS.test(tx.Fee) ||
      !POSITIVE_DROPS.test(approval.maxFeeDrops) ||
      BigInt(tx.Fee) > BigInt(approval.maxFeeDrops) ||
      BigInt(approval.maxFeeDrops) > ABSOLUTE_MAX_FEE_DROPS) {
    fail("Approval transaction Fee must be positive drops.");
  }
  uint32(approval.validatedLedgerIndex, "Validated ledger index", true);
  uint32(approval.validatedAccountSequence, "Validated account sequence", true);
  if (tx.Sequence !== approval.validatedAccountSequence) {
    fail("Approval transaction Sequence does not match validated account state.");
  }
  uint32(tx.LastLedgerSequence, "LastLedgerSequence", true);
  if (Number(tx.LastLedgerSequence) <= approval.validatedLedgerIndex ||
      Number(tx.LastLedgerSequence) > approval.validatedLedgerIndex + MAX_LEDGER_WINDOW) {
    fail("Approval transaction ledger window is stale or too broad.");
  }
  if (approval.sourceTag === undefined ? tx.SourceTag !== undefined : tx.SourceTag !== approval.sourceTag) {
    fail("Approval transaction SourceTag changed.");
  }
  if (approval.sourceTag !== undefined) uint32(approval.sourceTag, "SourceTag");
  if (approval.memos === undefined ? tx.Memos !== undefined : !exactObject(tx.Memos, approval.memos)) {
    fail("Approval transaction Memos changed.");
  }
}

function allowedFields(
  tx: Readonly<Record<string, unknown>>,
  actionFields: readonly string[],
): void {
  const allowed = new Set<string>([...BASE_TRANSACTION_FIELDS, ...actionFields]);
  const unexpected = Object.keys(tx).find((field) => !allowed.has(field));
  if (unexpected !== undefined) fail(`Approval transaction contains unsupported field ${unexpected}.`);
}

function sameOptionalField(
  tx: Readonly<Record<string, unknown>>,
  field: string,
  expected: unknown,
): void {
  if (expected === undefined) {
    if (tx[field] !== undefined) fail(`${field} was not authorized by the agreement terms.`);
  } else if (tx[field] !== expected) {
    fail(`${field} does not match the immutable agreement terms.`);
  }
}

function validateCreateTransaction(
  terms: WorkAgreementTerms,
  approval: WorkAgreementApproval,
  tx: Readonly<Record<string, unknown>>,
): void {
  allowedFields(tx, ["Destination", "Amount", "FinishAfter", "CancelAfter", "Condition"]);
  validateBaseTransaction(tx, approval);
  if (
    tx.TransactionType !== "EscrowCreate" || tx.Account !== terms.owner ||
    tx.Destination !== terms.counterparty || tx.Amount !== terms.amountDrops
  ) {
    fail("EscrowCreate account, counterparty, or native XRP amount changed.");
  }
  sameOptionalField(tx, "FinishAfter", terms.finishAfter);
  sameOptionalField(tx, "CancelAfter", terms.cancelAfter);
  sameOptionalField(tx, "Condition", terms.condition);
}

function validateReleaseTransaction(
  terms: WorkAgreementTerms,
  offerSequence: number,
  approval: WorkAgreementApproval,
  tx: Readonly<Record<string, unknown>>,
): void {
  allowedFields(tx, ["Owner", "OfferSequence", "Condition", "Fulfillment"]);
  validateBaseTransaction(tx, approval);
  if (
    tx.TransactionType !== "EscrowFinish" || tx.Account !== terms.owner ||
    tx.Owner !== terms.owner || tx.OfferSequence !== offerSequence
  ) {
    fail("EscrowFinish owner or validated create sequence changed.");
  }
  sameOptionalField(tx, "Condition", terms.condition);
  if (terms.condition === undefined) {
    if (tx.Fulfillment !== undefined) fail("Time-based release must not add a fulfillment.");
  } else {
    hex(tx.Fulfillment, "Fulfillment");
  }
}

function validateCancelTransaction(
  terms: WorkAgreementTerms,
  offerSequence: number,
  approval: WorkAgreementApproval,
  tx: Readonly<Record<string, unknown>>,
): void {
  allowedFields(tx, ["Owner", "OfferSequence"]);
  validateBaseTransaction(tx, approval);
  if (
    tx.TransactionType !== "EscrowCancel" || tx.Account !== terms.owner ||
    tx.Owner !== terms.owner || tx.OfferSequence !== offerSequence
  ) {
    fail("EscrowCancel owner or validated create sequence changed.");
  }
}

function validateApprovalEnvelope(
  state: DraftWorkAgreementState | ActiveWorkAgreementState,
  approval: WorkAgreementApproval,
  now: number,
  action: WorkAgreementAction,
): void {
  if (approval.action !== action) fail(`Expected ${action} approval.`);
  nonEmpty(approval.approvalId, "Approval id");
  if (approval.network !== state.terms.network) fail("Approval network changed.");
  const expiry = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) fail("Approval is stale or expired.");
  const execution = approval.execution as unknown;
  if (
    execution === null || typeof execution !== "object" || Array.isArray(execution) ||
    Object.keys(execution).length !== 3 ||
    (execution as Record<string, unknown>).build_id === undefined ||
    (execution as Record<string, unknown>).idempotency_key === undefined ||
    (execution as Record<string, unknown>).require_owner_approval !== true
  ) {
    fail("Every work-agreement phase requires an exact forced-owner execution request.");
  }
  const exactExecution = execution as Record<string, unknown>;
  nonEmpty(exactExecution.build_id, "Build id");
  nonEmpty(exactExecution.idempotency_key, "Idempotency key");
  if (state.history.approvalIds.includes(approval.approvalId)) fail("Approval replay was rejected.");
  if (state.history.idempotencyKeys.includes(exactExecution.idempotency_key)) {
    fail("Idempotency-key replay was rejected.");
  }
}

function appendApproval(history: History, approval: WorkAgreementApproval): History {
  return Object.freeze({
    ...history,
    approvalIds: Object.freeze([...history.approvalIds, approval.approvalId]),
    idempotencyKeys: Object.freeze([
      ...history.idempotencyKeys,
      approval.execution.idempotency_key,
    ]),
  });
}

export function bindCreateApproval(
  state: DraftWorkAgreementState,
  approval: WorkAgreementApproval,
  now = Date.now(),
): AwaitingWorkAgreementState {
  if (state.status !== "draft") fail("Create approval requires a draft agreement.");
  validateApprovalEnvelope(state, approval, now, "create");
  validateCreateTransaction(state.terms, approval, approval.txJson);
  const bound = snapshotApproval(approval);
  return {
    ...common(state.terms, state.revision + 1, appendApproval(state.history, bound)),
    status: "awaiting_create",
    approval: bound,
  };
}

export function bindReleaseApproval(
  state: ActiveWorkAgreementState,
  approval: WorkAgreementApproval,
  now = Date.now(),
): AwaitingWorkAgreementState {
  if (state.status !== "active") fail("Release approval requires an active agreement.");
  validateApprovalEnvelope(state, approval, now, "release");
  validateReleaseTransaction(state.terms, state.offerSequence, approval, approval.txJson);
  const bound = snapshotApproval(approval);
  return {
    ...common(state.terms, state.revision + 1, appendApproval(state.history, bound)),
    status: "awaiting_release",
    approval: bound,
    offerSequence: state.offerSequence,
    createEvidence: state.createEvidence,
  };
}

export function bindCancelApproval(
  state: ActiveWorkAgreementState,
  approval: WorkAgreementApproval,
  now = Date.now(),
): AwaitingWorkAgreementState {
  if (state.status !== "active") fail("Cancel approval requires an active agreement.");
  validateApprovalEnvelope(state, approval, now, "cancel");
  validateCancelTransaction(state.terms, state.offerSequence, approval, approval.txJson);
  const bound = snapshotApproval(approval);
  return {
    ...common(state.terms, state.revision + 1, appendApproval(state.history, bound)),
    status: "awaiting_cancel",
    approval: bound,
    offerSequence: state.offerSequence,
    createEvidence: state.createEvidence,
  };
}

function awaitingAction(state: AwaitingWorkAgreementState): WorkAgreementAction {
  if (state.status === "awaiting_create") return "create";
  return state.status === "awaiting_release" ? "release" : "cancel";
}

function exactSigningExpectation(
  state: AwaitingWorkAgreementState,
): ExactLedgerActionExpectation {
  const approval = state.approval;
  const common = {
    network: state.terms.network,
    account: state.terms.owner,
    sequence: approval.validatedAccountSequence,
    validatedLedgerIndex: approval.validatedLedgerIndex,
    maxLedgerWindow: MAX_LEDGER_WINDOW,
    maxFeeDrops: approval.maxFeeDrops,
    approvalExpiresAtMs: Date.parse(approval.expiresAt),
    ...(approval.sourceTag === undefined ? {} : { sourceTag: approval.sourceTag }),
    ...(approval.memos === undefined ? {} : { memos: approval.memos }),
  } as const;
  if (approval.action === "create") {
    return {
      ...common,
      kind: "escrow-create",
      destination: state.terms.counterparty,
      amountDrops: state.terms.amountDrops,
      ...(state.terms.finishAfter === undefined ? {} : { finishAfter: state.terms.finishAfter }),
      ...(state.terms.cancelAfter === undefined ? {} : { cancelAfter: state.terms.cancelAfter }),
      ...(state.terms.condition === undefined ? {} : { condition: state.terms.condition }),
    };
  }
  if (state.offerSequence === undefined) fail("Validated escrow sequence is missing.");
  if (approval.action === "release") {
    return {
      ...common,
      kind: "escrow-finish",
      escrowId: { owner: state.terms.owner, offerSequence: state.offerSequence },
      ...(state.terms.condition === undefined ? {} : { condition: state.terms.condition }),
      ...(typeof approval.txJson.Fulfillment === "string"
        ? { fulfillment: approval.txJson.Fulfillment }
        : {}),
    };
  }
  return {
    ...common,
    kind: "escrow-cancel",
    escrowId: { owner: state.terms.owner, offerSequence: state.offerSequence },
  };
}

export function startWorkAgreementSubmission(
  state: AwaitingWorkAgreementState,
  input: Readonly<{
    account: string;
    network: WorkAgreementNetwork;
    signedBlob: string;
    attemptId: string;
    now?: number;
  }>,
): SubmittingWorkAgreementState {
  if (state.status !== expectedStatus(state.approval.action)) fail("Approval state and action disagree.");
  if (input.account !== state.terms.owner) fail("Connected owner account changed before signing.");
  if (input.network !== state.terms.network) fail("Connected network changed before signing.");
  if ((input.now ?? Date.now()) >= Date.parse(state.approval.expiresAt)) {
    fail("Approval expired before signing.");
  }
  const verified = verifyExactLedgerSignedBlob({
    signedBlob: input.signedBlob,
    expectation: exactSigningExpectation(state),
    now: input.now ?? Date.now(),
  });
  const unsigned = { ...verified.transaction };
  delete unsigned.SigningPubKey;
  delete unsigned.TxnSignature;
  if (!exactObject(unsigned, state.approval.txJson)) {
    fail("Reviewed transaction changed before signing.");
  }
  nonEmpty(input.attemptId, "Submission attempt id");
  if (state.history.attemptIds.includes(input.attemptId)) fail("Submission attempt replay was rejected.");
  return {
    ...common(state.terms, state.revision + 1, {
      ...state.history,
      attemptIds: Object.freeze([...state.history.attemptIds, input.attemptId]),
    }),
    status: "submitting",
    action: awaitingAction(state),
    approval: state.approval,
    attemptId: input.attemptId,
    expectedHash: verified.hash,
    ...(state.offerSequence === undefined ? {} : { offerSequence: state.offerSequence }),
    ...(state.createEvidence === undefined ? {} : { createEvidence: state.createEvidence }),
  };
}

export function markWorkAgreementSubmissionUnknown(
  state: SubmittingWorkAgreementState,
  reason: UnknownWorkAgreementState["reason"],
): UnknownWorkAgreementState {
  if (state.status !== "submitting") fail("Only an in-flight submission can become unknown.");
  return { ...state, status: "unknown", reason, revision: state.revision + 1 };
}

function validateSubmission(
  state: SubmittingWorkAgreementState | UnknownWorkAgreementState,
  evidence: ValidatedWorkAgreementSubmission,
): void {
  if (evidence.approvalId !== state.approval.approvalId) fail("Validated evidence belongs to another approval.");
  if (!HASH.test(evidence.hash) || evidence.hash !== state.expectedHash) {
    fail("Validated evidence does not match the locally signed transaction hash.");
  }
  if (evidence.validated !== true || evidence.engineResult !== "tesSUCCESS") {
    fail("Validated evidence must prove tesSUCCESS on a validated ledger.");
  }
  if (!Number.isSafeInteger(evidence.ledgerIndex) || evidence.ledgerIndex < 1) {
    fail("Validated evidence requires a positive ledger index.");
  }
  if (evidence.ledgerIndex <= state.approval.validatedLedgerIndex ||
      evidence.ledgerIndex > Number(state.approval.txJson.LastLedgerSequence)) {
    fail("Validated evidence ledger index is outside the approved inclusion window.");
  }
  if (!exactObject(evidence.txJson, state.approval.txJson)) {
    fail("Validated transaction differs from the owner-reviewed approval.");
  }
}

export function applyValidatedWorkAgreementSubmission(
  state: SubmittingWorkAgreementState | UnknownWorkAgreementState,
  evidence: ValidatedWorkAgreementSubmission,
): ActiveWorkAgreementState | TerminalWorkAgreementState {
  validateSubmission(state, evidence);
  const terminalEvidence = snapshotEvidence(evidence);
  if (state.action === "create") {
    uint32(terminalEvidence.txJson.Sequence, "Validated EscrowCreate Sequence", true);
    const offerSequence = Number(terminalEvidence.txJson.Sequence);
    return {
      ...common(state.terms, state.revision + 1, state.history),
      status: "active",
      offerSequence,
      createEvidence: terminalEvidence,
    };
  }
  if (state.offerSequence === undefined || state.createEvidence === undefined) {
    fail("Terminal evidence is missing the validated create binding.");
  }
  return {
    ...common(state.terms, state.revision + 1, state.history),
    status: state.action === "release" ? "released" : "cancelled",
    offerSequence: state.offerSequence,
    createEvidence: state.createEvidence,
    terminalEvidence,
  };
}

function baseAfterAbandonedApproval(
  state: AwaitingWorkAgreementState | UnknownWorkAgreementState,
): DraftWorkAgreementState | ActiveWorkAgreementState {
  if (state.approval.action === "create") {
    return { ...common(state.terms, state.revision + 1, state.history), status: "draft" };
  }
  if (state.offerSequence === undefined || state.createEvidence === undefined) {
    fail("Active agreement binding is missing.");
  }
  return {
    ...common(state.terms, state.revision + 1, state.history),
    status: "active",
    offerSequence: state.offerSequence,
    createEvidence: state.createEvidence,
  };
}

export function rejectWorkAgreementApproval(
  state: AwaitingWorkAgreementState,
): DraftWorkAgreementState | ActiveWorkAgreementState {
  return baseAfterAbandonedApproval(state);
}

export function expireWorkAgreementApproval(
  state: AwaitingWorkAgreementState,
  now = Date.now(),
): DraftWorkAgreementState | ActiveWorkAgreementState {
  if (now < Date.parse(state.approval.expiresAt)) fail("Approval has not expired.");
  return baseAfterAbandonedApproval(state);
}

export function reconcileUnknownWorkAgreementSubmission(
  state: UnknownWorkAgreementState,
  proof: CompleteNonInclusionProof | ValidatedWorkAgreementSubmission,
): UnknownWorkAgreementState | DraftWorkAgreementState | ActiveWorkAgreementState | TerminalWorkAgreementState {
  if ("validated" in proof) return applyValidatedWorkAgreementSubmission(state, proof);
  if (proof.approvalId !== state.approval.approvalId) fail("Reconciliation proof belongs to another approval.");
  const lastLedgerSequence = state.approval.txJson.LastLedgerSequence;
  uint32(lastLedgerSequence, "Approval LastLedgerSequence", true);
  if (
    proof.searchedAll !== true || !Number.isSafeInteger(proof.validatedLedgerIndex) ||
    !Number.isSafeInteger(proof.checkedThroughLedger) ||
    proof.checkedThroughLedger !== lastLedgerSequence ||
    proof.validatedLedgerIndex <= lastLedgerSequence
  ) {
    fail("Complete post-expiry non-inclusion proof is required before replacement.");
  }
  return baseAfterAbandonedApproval(state);
}
