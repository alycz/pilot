import {
  bindCancelApproval,
  bindCreateApproval,
  bindReleaseApproval,
  createWorkAgreementDraft,
  ownerApprovalExecutionRequest,
  type ActiveWorkAgreementState,
  type AwaitingWorkAgreementState,
  type TerminalWorkAgreementState,
  type WorkAgreementAction,
  type WorkAgreementState,
} from "./work-agreement-state";

export const WORK_AGREEMENT_FIXTURE_ID = "work-agreement-fixture-v1";
export const WORK_AGREEMENT_FIXTURE_WARNING =
  "Recorded fixture only: no Ledger or Speculos signed this blob, no signature is valid, and no XRPL request is sent.";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const COUNTERPARTY = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const SIGNED_BLOBS: Readonly<Record<WorkAgreementAction, string>> = Object.freeze({
  create: "5245434F524445445F464958545552455F435245415445",
  release: "5245434F524445445F464958545552455F52454C45415345",
  cancel: "5245434F524445445F464958545552455F43414E43454C",
});
const HASHES: Readonly<Record<WorkAgreementAction, string>> = Object.freeze({
  create: "A".repeat(64),
  release: "B".repeat(64),
  cancel: "C".repeat(64),
});

export type WorkAgreementFixtureRequest =
  | Readonly<{ action: "start" }>
  | Readonly<{ action: "prepare"; phase: "release" | "cancel" }>
  | Readonly<{
      action: "submit_recorded_blob";
      phase: WorkAgreementAction;
      signed_blob: string;
    }>;

export type WorkAgreementFixtureView = Readonly<{
  fixtureId: typeof WORK_AGREEMENT_FIXTURE_ID;
  provenance: "fixture-simulation-only";
  simulation: true;
  ledgerSignatureValid: false;
  speculosConformanceClaimed: false;
  networkRequestsMade: 0;
  warning: typeof WORK_AGREEMENT_FIXTURE_WARNING;
  status: WorkAgreementState["status"];
  terms: WorkAgreementState["terms"];
  offerSequence?: number;
  approval?: Readonly<{
    action: WorkAgreementAction;
    approvalId: string;
    expiresAt: string;
    txJson: Readonly<Record<string, unknown>>;
    requireOwnerApproval: true;
    recordedFixtureBlob: string;
  }>;
  validation?: Readonly<{
    action: WorkAgreementAction;
    hash: string;
    ledgerIndex: number;
    source: "deterministic-fixture";
  }>;
}>;

export class WorkAgreementFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkAgreementFixtureError";
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key);
}

export function parseWorkAgreementFixtureRequest(value: unknown): WorkAgreementFixtureRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkAgreementFixtureError("Fixture request must be an object.");
  }
  const request = value as Record<string, unknown>;
  if (request.action === "start" && exactKeys(request, ["action"])) {
    return { action: "start" };
  }
  if (
    request.action === "prepare" &&
    (request.phase === "release" || request.phase === "cancel") &&
    exactKeys(request, ["action", "phase"])
  ) {
    return { action: "prepare", phase: request.phase };
  }
  if (
    request.action === "submit_recorded_blob" &&
    (request.phase === "create" || request.phase === "release" || request.phase === "cancel") &&
    typeof request.signed_blob === "string" &&
    exactKeys(request, ["action", "phase", "signed_blob"])
  ) {
    return {
      action: "submit_recorded_blob",
      phase: request.phase,
      signed_blob: request.signed_blob,
    };
  }
  throw new WorkAgreementFixtureError("Fixture request action or fields are invalid.");
}

function createTransaction() {
  return {
    TransactionType: "EscrowCreate",
    Account: OWNER,
    Destination: COUNTERPARTY,
    Amount: "2500000",
    FinishAfter: 900_000_000,
    CancelAfter: 900_000_600,
    Fee: "12",
    Sequence: 42,
    LastLedgerSequence: 1_050,
    SourceTag: 20261017,
  } as const;
}

function terminalTransaction(action: "release" | "cancel") {
  return action === "release"
    ? {
        TransactionType: "EscrowFinish",
        Account: OWNER,
        Owner: OWNER,
        OfferSequence: 42,
        Fee: "12",
        Sequence: 43,
        LastLedgerSequence: 1_060,
        SourceTag: 20261017,
      } as const
    : {
        TransactionType: "EscrowCancel",
        Account: OWNER,
        Owner: OWNER,
        OfferSequence: 42,
        Fee: "12",
        Sequence: 43,
        LastLedgerSequence: 1_060,
        SourceTag: 20261017,
      } as const;
}

function approval(
  action: WorkAgreementAction,
  txJson: Readonly<Record<string, unknown>>,
  now: number,
) {
  return {
    action,
    approvalId: `fixture-approval-${action}`,
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    execution: ownerApprovalExecutionRequest(
      `fixture-build-${action}`,
      `fixture-idempotency-${action}`,
    ),
    network: "testnet" as const,
    validatedLedgerIndex: action === "create" ? 1_000 : 1_020,
    validatedAccountSequence: action === "create" ? 42 : 43,
    maxFeeDrops: "100",
    sourceTag: 20261017,
    txJson,
  };
}

function validation(
  action: WorkAgreementAction,
  approvalId: string,
  txJson: Readonly<Record<string, unknown>>,
) {
  return {
    approvalId,
    hash: HASHES[action],
    ledgerIndex: action === "create" ? 1_048 : 1_059,
    validated: true as const,
    engineResult: "tesSUCCESS" as const,
    txJson,
  };
}

function actionForState(state: AwaitingWorkAgreementState): WorkAgreementAction {
  if (state.status === "awaiting_create") return "create";
  return state.status === "awaiting_release" ? "release" : "cancel";
}

function fixtureView(state: WorkAgreementState): WorkAgreementFixtureView {
  const awaiting = state.status.startsWith("awaiting_")
    ? state as AwaitingWorkAgreementState
    : undefined;
  const terminal = state.status === "released" || state.status === "cancelled"
    ? state as TerminalWorkAgreementState
    : undefined;
  const active = state.status === "active" ? state as ActiveWorkAgreementState : undefined;
  const validatedAction = terminal
    ? terminal.status === "released" ? "release" : "cancel"
    : active ? "create" : undefined;
  const validatedEvidence = terminal?.terminalEvidence ?? active?.createEvidence;
  return {
    fixtureId: WORK_AGREEMENT_FIXTURE_ID,
    provenance: "fixture-simulation-only",
    simulation: true,
    ledgerSignatureValid: false,
    speculosConformanceClaimed: false,
    networkRequestsMade: 0,
    warning: WORK_AGREEMENT_FIXTURE_WARNING,
    status: state.status,
    terms: state.terms,
    ...("offerSequence" in state && state.offerSequence !== undefined
      ? { offerSequence: state.offerSequence }
      : {}),
    ...(awaiting
      ? {
          approval: {
            action: actionForState(awaiting),
            approvalId: awaiting.approval.approvalId,
            expiresAt: awaiting.approval.expiresAt,
            txJson: awaiting.approval.txJson,
            requireOwnerApproval: true as const,
            recordedFixtureBlob: SIGNED_BLOBS[actionForState(awaiting)],
          },
        }
      : {}),
    ...(validatedAction && validatedEvidence
      ? {
          validation: {
            action: validatedAction,
            hash: validatedEvidence.hash,
            ledgerIndex: validatedEvidence.ledgerIndex,
            source: "deterministic-fixture" as const,
          },
        }
      : {}),
  };
}

export class WorkAgreementFixtureService {
  private state: WorkAgreementState | undefined;

  handle(request: WorkAgreementFixtureRequest, now = Date.now()): WorkAgreementFixtureView {
    if (request.action === "start") {
      const draft = createWorkAgreementDraft({
        agreementId: WORK_AGREEMENT_FIXTURE_ID,
        owner: OWNER,
        counterparty: COUNTERPARTY,
        network: "testnet",
        amountDrops: "2500000",
        finishAfter: 900_000_000,
        cancelAfter: 900_000_600,
      });
      this.state = bindCreateApproval(draft, approval("create", createTransaction(), now), now);
      return fixtureView(this.state);
    }

    if (this.state === undefined) {
      throw new WorkAgreementFixtureError("Start the fixture before continuing.");
    }

    if (request.action === "prepare") {
      if (this.state.status !== "active") {
        throw new WorkAgreementFixtureError("Release or cancel requires a validated create fixture.");
      }
      const nextApproval = approval(request.phase, terminalTransaction(request.phase), now);
      this.state = request.phase === "release"
        ? bindReleaseApproval(this.state, nextApproval, now)
        : bindCancelApproval(this.state, nextApproval, now);
      return fixtureView(this.state);
    }

    if (!this.state.status.startsWith("awaiting_")) {
      throw new WorkAgreementFixtureError("No recorded owner approval is awaiting submission.");
    }
    const awaiting = this.state as AwaitingWorkAgreementState;
    const expectedAction = actionForState(awaiting);
    if (request.phase !== expectedAction || request.signed_blob !== SIGNED_BLOBS[expectedAction]) {
      throw new WorkAgreementFixtureError("Recorded fixture blob or phase does not match the exact approval.");
    }
    // Deliberately do not call startWorkAgreementSubmission here. That trusted
    // boundary requires a cryptographically valid exact Ledger signature, and
    // repository policy forbids committing a signed blob or private key. This
    // route is a visibly simulated UI fixture, so it advances only a synthetic
    // state carrying deterministic, explicitly non-ledger evidence.
    const evidence = validation(
      expectedAction,
      awaiting.approval.approvalId,
      awaiting.approval.txJson,
    );
    if (expectedAction === "create") {
      this.state = {
        provenance: "fixture-simulation-only",
        simulation: true,
        speculosConformanceClaimed: false,
        terms: awaiting.terms,
        revision: awaiting.revision + 1,
        history: awaiting.history,
        status: "active",
        offerSequence: 42,
        createEvidence: evidence,
      };
    } else {
      if (awaiting.offerSequence === undefined || awaiting.createEvidence === undefined) {
        throw new WorkAgreementFixtureError("Validated create fixture binding is missing.");
      }
      this.state = {
        provenance: "fixture-simulation-only",
        simulation: true,
        speculosConformanceClaimed: false,
        terms: awaiting.terms,
        revision: awaiting.revision + 1,
        history: awaiting.history,
        status: expectedAction === "release" ? "released" : "cancelled",
        offerSequence: awaiting.offerSequence,
        createEvidence: awaiting.createEvidence,
        terminalEvidence: evidence,
      };
    }
    return fixtureView(this.state);
  }
}
