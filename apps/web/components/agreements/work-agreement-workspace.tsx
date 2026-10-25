"use client";

import {
  createWallet,
  ledgerRuntimeProvenance,
  validateExactLedgerAction,
  verifyExactLedgerSignedBlob,
  type ExactLedgerActionExpectation,
  type ExactLedgerActionReview,
  type LedgerDeviceState,
  type LedgerRuntime,
  type PilotWallet,
} from "@pilot/wallet";
import React, { useEffect, useRef, useState } from "react";

import {
  loadPublicPilotConfig,
  loadWalletSessionStatus,
  WALLET_SESSION_CHANGED_EVENT,
  type PublicPilotConfig,
  type WalletSessionStatus,
} from "../../lib/harbor-browser";
import {
  ApprovalModal,
  type ApprovalRequest,
  type ApprovalSubmission,
} from "../approval/approval-modal";
import {
  configuredWalletMetadata,
  configuredWalletOptions,
  isConfiguredLedgerFacade,
} from "../chat/configured-wallet";
import {
  clearWorkAgreementRecovery,
  inspectWorkAgreementRecovery,
  isWorkAgreementSubmissionRecovery,
  requestWorkAgreement,
  saveWorkAgreementRecovery,
  type WorkAgreementPublicState,
  type WorkAgreementRecovery,
  type WorkAgreementTermsRequest,
} from "./work-agreement-runtime-client";
import { WorkAgreementView, type WorkAgreementDraft } from "./work-agreement-view";

const IDLE_DEVICE: LedgerDeviceState = Object.freeze({ interaction: "none", busy: false });
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const UINT32_MAX = 0xffff_ffff;
const MAX_LEDGER_WINDOW = 50;
const RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TERMINAL = new Set(["released", "cancelled", "rejected", "expired"]);

type BoundAgreementApproval = Readonly<{
  expectation: ExactLedgerActionExpectation;
  request: ApprovalRequest;
  review: ExactLedgerActionReview;
  revision: number;
  runtime: LedgerRuntime;
}>;

export type WorkAgreementOperationContext = Readonly<{
  generation: number;
  owner: string;
}>;

export class StaleWorkAgreementOperationError extends Error {
  constructor() {
    super("The wallet session changed while the work-agreement operation was running.");
    this.name = "StaleWorkAgreementOperationError";
  }
}

export function assertWorkAgreementOperationContext(
  context: WorkAgreementOperationContext,
  currentGeneration: number,
  currentSession: WalletSessionStatus | null | undefined,
): void {
  if (context.generation !== currentGeneration || !currentSession?.authenticated ||
      currentSession.network !== "testnet" || currentSession.account !== context.owner) {
    throw new StaleWorkAgreementOperationError();
  }
}

export class WorkAgreementAttemptGate {
  private active = false;

  async run<T>(attempt: () => Promise<T>): Promise<T | undefined> {
    if (this.active) return undefined;
    this.active = true;
    try {
      return await attempt();
    } finally {
      this.active = false;
    }
  }
}

export function workAgreementMatchesSession(
  record: WorkAgreementPublicState,
  session: WalletSessionStatus | null | undefined,
): boolean {
  return !!session?.authenticated && session.network === "testnet" &&
    record.network === "testnet" && record.owner === session.account;
}

export function canRecoverWorkAgreement(
  record: WorkAgreementPublicState | undefined,
  recovery: WorkAgreementRecovery | null | undefined,
  session: WalletSessionStatus | null | undefined,
): boolean {
  if (!record || !recovery || !isWorkAgreementSubmissionRecovery(recovery) ||
      !workAgreementMatchesSession(record, session)) return false;
  const exactAttempt = record.attempt_id === undefined || record.attempt_id === recovery.attempt_id;
  const exactIdentity = recovery.owner === record.owner && recovery.network === record.network &&
    recovery.agreement_id === record.agreement_id && exactAttempt;
  if (!exactIdentity) return false;
  if (record.status === "submitting") {
    return (record.approval === undefined || (
      record.approval.approval_id === recovery.approval_id &&
      record.approval.idempotency_key === recovery.idempotency_key
    )) && (record.action === undefined || record.action === recovery.action);
  }
  return (record.status === "awaiting_approval" || record.status === "unknown") &&
    record.approval?.approval_id === recovery.approval_id &&
    record.approval.idempotency_key === recovery.idempotency_key &&
    record.action === recovery.action;
}

function xrpLabel(drops: string): string {
  const padded = drops.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "") || "0";
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} XRP`;
}

function expectationFor(record: WorkAgreementPublicState): ExactLedgerActionExpectation {
  const approval = record.approval;
  if (record.status !== "awaiting_approval" || !approval || record.action !== approval.action) {
    throw new Error("The agreement no longer has the exact approval that was selected for review.");
  }
  const expires = Date.parse(approval.expires_at);
  if (!Number.isFinite(expires)) throw new Error("The work-agreement approval expiry is invalid.");
  const sourceTag = approval.tx_json.SourceTag;
  const memos = approval.tx_json.Memos;
  const common = {
    network: "testnet" as const,
    account: record.owner,
    sequence: approval.validated_account_sequence,
    validatedLedgerIndex: approval.validated_ledger_index,
    maxLedgerWindow: MAX_LEDGER_WINDOW,
    maxFeeDrops: approval.max_fee_drops,
    approvalExpiresAtMs: expires,
    ...(typeof sourceTag === "number" ? { sourceTag } : {}),
    ...(Array.isArray(memos) ? { memos } : {}),
  };
  if (approval.action === "create") {
    return {
      ...common,
      kind: "escrow-create",
      destination: record.terms.counterparty,
      amountDrops: record.terms.amount_drops,
      ...(record.terms.finish_after === undefined ? {} : { finishAfter: record.terms.finish_after }),
      ...(record.terms.cancel_after === undefined ? {} : { cancelAfter: record.terms.cancel_after }),
      ...(record.terms.condition === undefined ? {} : { condition: record.terms.condition }),
    };
  }
  if (record.offer_sequence === undefined) {
    throw new Error("The validated escrow sequence is missing.");
  }
  if (approval.action === "release") {
    return {
      ...common,
      kind: "escrow-finish",
      escrowId: { owner: record.owner, offerSequence: record.offer_sequence },
      ...(record.terms.condition === undefined ? {} : { condition: record.terms.condition }),
      ...(typeof approval.tx_json.Fulfillment === "string"
        ? { fulfillment: approval.tx_json.Fulfillment }
        : {}),
    };
  }
  return {
    ...common,
    kind: "escrow-cancel",
    escrowId: { owner: record.owner, offerSequence: record.offer_sequence },
  };
}

export async function bindWorkAgreementApproval(
  record: WorkAgreementPublicState,
  runtime: LedgerRuntime,
  now = Date.now(),
): Promise<BoundAgreementApproval> {
  const approval = record.approval;
  if (!approval || !workAgreementMatchesSession(record, {
    authenticated: true,
    account: record.owner,
    network: "testnet",
  })) throw new Error("The work-agreement approval is incomplete.");
  const expectation = expectationFor(record);
  const review = await validateExactLedgerAction({
    transaction: approval.tx_json,
    expectation,
    provenance: ledgerRuntimeProvenance(runtime),
    now,
  });
  if (review.signingMode !== "clear") {
    throw new Error("This escrow transaction is not clear-signable and has no blind-sign fallback.");
  }
  return Object.freeze({
    expectation,
    review,
    revision: record.revision,
    runtime,
    request: {
      approvalId: approval.approval_id,
      expiresAt: approval.expires_at,
      txJson: { ...approval.tx_json },
      summary: {
        action: approval.action === "create"
          ? "Create the reviewed escrow"
          : approval.action === "release"
            ? "Release the reviewed escrow"
            : "Cancel the reviewed escrow",
        amounts: [xrpLabel(record.terms.amount_drops)],
        destination: approval.action === "create"
          ? record.terms.counterparty
          : `Escrow ${record.owner}:${record.offer_sequence ?? "unknown"}`,
        feeDrops: String(approval.tx_json.Fee),
        network: "testnet" as const,
      },
    },
  });
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

function assertSignedTransactionMatchesReview(
  signedTransaction: Readonly<Record<string, unknown>>,
  reviewedTransaction: Readonly<Record<string, unknown>>,
): void {
  const unsigned = { ...signedTransaction };
  delete unsigned.SigningPubKey;
  delete unsigned.TxnSignature;
  if (canonical(unsigned) !== canonical(reviewedTransaction)) {
    throw new Error("The signed transaction differs from the exact owner-reviewed approval.");
  }
}

function rippleEpochNow(offsetSeconds = 0): number {
  return Math.floor(Date.now() / 1_000) - 946_684_800 + offsetSeconds;
}

function initialDraft(): WorkAgreementDraft {
  return {
    counterparty: "",
    amountDrops: "1000000",
    finishAfter: String(rippleEpochNow(3_600)),
    cancelAfter: String(rippleEpochNow(7_200)),
  };
}

function parseTerms(draft: WorkAgreementDraft, owner: string): WorkAgreementTermsRequest {
  const finishAfter = Number(draft.finishAfter);
  const cancelAfter = Number(draft.cancelAfter);
  if (!CLASSIC_ADDRESS.test(draft.counterparty) || draft.counterparty === owner) {
    throw new Error("Enter a different valid XRPL classic address for the counterparty.");
  }
  if (!/^[1-9][0-9]{0,15}$/.test(draft.amountDrops)) {
    throw new Error("Amount must be positive native XRP drops.");
  }
  if (!Number.isSafeInteger(finishAfter) || finishAfter < 1 || finishAfter > UINT32_MAX ||
      !Number.isSafeInteger(cancelAfter) || cancelAfter < 1 || cancelAfter > UINT32_MAX ||
      finishAfter >= cancelAfter) {
    throw new Error("FinishAfter and CancelAfter must be ordered positive UInt32 Ripple times.");
  }
  return {
    counterparty: draft.counterparty,
    amount_drops: draft.amountDrops,
    finish_after: finishAfter,
    cancel_after: cancelAfter,
  };
}

function trackingRecovery(
  owner: string,
  agreementId: string,
  idempotencyKey: string,
  phase: "prepare_pending" | "prepare_unknown" | "tracking",
): WorkAgreementRecovery {
  return {
    version: 1,
    owner,
    network: "testnet",
    agreement_id: agreementId,
    idempotency_key: idempotencyKey,
    phase,
    retain_until: new Date(Date.now() + RECOVERY_RETENTION_MS).toISOString(),
  };
}

export function WorkAgreementWorkspace() {
  const [config, setConfig] = useState<PublicPilotConfig | null>();
  const [session, setSession] = useState<WalletSessionStatus | null>();
  const [wallet, setWallet] = useState<PilotWallet>();
  const [accountIndex, setAccountIndex] = useState(0);
  const [ledgerTransport, setLedgerTransport] = useState<"webhid" | "virtual">();
  const [deviceState, setDeviceState] = useState<LedgerDeviceState>(IDLE_DEVICE);
  const [deviceReady, setDeviceReady] = useState(false);
  const [draft, setDraft] = useState<WorkAgreementDraft>(() => initialDraft());
  const [record, setRecord] = useState<WorkAgreementPublicState>();
  const [recovery, setRecovery] = useState<WorkAgreementRecovery>();
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [bound, setBound] = useState<BoundAgreementApproval>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const actionGateRef = useRef(new WorkAgreementAttemptGate());
  const submissionGateRef = useRef(new WorkAgreementAttemptGate());
  const disconnectRef = useRef<(() => void) | undefined>(undefined);
  const sessionGenerationRef = useRef(0);
  const sessionLoadRef = useRef(0);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const requestId = ++sessionLoadRef.current;
      try {
        const [nextConfig, nextSession] = await Promise.all([
          loadPublicPilotConfig(),
          loadWalletSessionStatus(),
        ]);
        if (!active || requestId !== sessionLoadRef.current) return;
        setConfig(nextConfig);
        setSession(nextSession);
      } catch {
        if (!active || requestId !== sessionLoadRef.current) return;
        setConfig(null);
        setSession(null);
      }
    };
    void load();
    const onSessionChanged = () => {
      sessionGenerationRef.current += 1;
      const requestId = ++sessionLoadRef.current;
      void loadWalletSessionStatus()
        .then((next) => { if (active && requestId === sessionLoadRef.current) setSession(next); })
        .catch(() => { if (active && requestId === sessionLoadRef.current) setSession(null); });
    };
    globalThis.addEventListener?.(WALLET_SESSION_CHANGED_EVENT, onSessionChanged);
    return () => {
      active = false;
      globalThis.removeEventListener?.(WALLET_SESSION_CHANGED_EVENT, onSessionChanged);
      disconnectRef.current?.();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const generation = ++sessionGenerationRef.current;
    disconnectRef.current?.();
    disconnectRef.current = undefined;
    setWallet(undefined);
    setLedgerTransport(undefined);
    setDeviceReady(false);
    setDeviceState(IDLE_DEVICE);
    setBound(undefined);
    setRecord(undefined);
    setRecovery(undefined);
    setRecoveryBlocked(false);
    setError(undefined);
    setNotice(undefined);
    if (!session?.authenticated || session.network !== "testnet") return () => { active = false; };
    const inspected = inspectWorkAgreementRecovery(localStorage, session.account, "testnet");
    if (inspected.status === "invalid") {
      setRecoveryBlocked(true);
      setError("The account's saved recovery reference is invalid. Preparing a replacement is blocked to avoid duplicating an unknown operation.");
      return () => { active = false; };
    }
    if (inspected.status === "expired") {
      clearWorkAgreementRecovery(localStorage, session.account, "testnet");
      return () => { active = false; };
    }
    if (inspected.status !== "valid") return () => { active = false; };
    const saved = inspected.value;
    setRecovery(saved);
    void requestWorkAgreement({
      action: "status",
      args: {
        owner: session.account,
        network: "testnet",
        agreement_id: saved.agreement_id,
      },
    }).then((recovered) => {
      if (!active || generation !== sessionGenerationRef.current ||
          !workAgreementMatchesSession(recovered, session)) return;
      setRecord(recovered);
      if (TERMINAL.has(recovered.status)) {
        clearWorkAgreementRecovery(localStorage, session.account, "testnet");
        setRecovery(undefined);
        setNotice(`Recovered the terminal ${recovered.status} agreement state.`);
      } else if (recovered.status === "active") {
        const tracked = trackingRecovery(
          session.account,
          recovered.agreement_id,
          recovered.last_resolution?.idempotency_key ?? saved.idempotency_key,
          "tracking",
        );
        saveWorkAgreementRecovery(localStorage, tracked);
        setRecovery(tracked);
        setNotice("Recovered the active account-bound agreement from its durable reference.");
      } else {
        if ((saved.phase === "prepare_pending" || saved.phase === "prepare_unknown") &&
            recovered.status === "awaiting_approval" &&
            recovered.approval?.idempotency_key === saved.idempotency_key) {
          const tracked = trackingRecovery(
            session.account,
            recovered.agreement_id,
            saved.idempotency_key,
            "tracking",
          );
          saveWorkAgreementRecovery(localStorage, tracked);
          setRecovery(tracked);
        }
        setNotice(isWorkAgreementSubmissionRecovery(saved)
          ? "Recovered the exact pending submission tuple. Reconcile it without signing or submitting again."
          : "Recovered the account-bound agreement from its durable reference.");
      }
    }).catch((cause) => {
      if (!active || generation !== sessionGenerationRef.current) return;
      setError(cause instanceof Error
        ? cause.message
        : "Agreement recovery failed. Retry the stored reference before preparing a replacement.");
    });
    return () => { active = false; };
  }, [session]);

  const owner = session?.authenticated && session.network === "testnet"
    ? session.account
    : undefined;

  const saveRecovery = (next: WorkAgreementRecovery) => {
    saveWorkAgreementRecovery(localStorage, next);
    setRecovery(next);
  };

  const operationContext = (expectedOwner: string): WorkAgreementOperationContext => ({
    generation: sessionGenerationRef.current,
    owner: expectedOwner,
  });

  const requireCurrentSession = async (context: WorkAgreementOperationContext) => {
    assertWorkAgreementOperationContext(context, sessionGenerationRef.current, session);
    const current = await loadWalletSessionStatus();
    try {
      assertWorkAgreementOperationContext(context, sessionGenerationRef.current, current);
    } catch (cause) {
      sessionGenerationRef.current += 1;
      setSession(current);
      setBound(undefined);
      throw cause;
    }
    return current;
  };

  const connectLedger = async (): Promise<PilotWallet> => {
    if (wallet && owner && wallet.network === "testnet" && wallet.address() === owner) return wallet;
    if (!config || config.network !== "testnet" || !config.mockMode || !owner) {
      throw new Error("A wallet-bound local Testnet mock session is required.");
    }
    const configured = configuredWalletMetadata(sessionStorage.getItem("pilot:wallet"), config);
    if (configured.provider !== "ledger" || !configured.ledger) {
      throw new Error("Reconnect the configured Ledger wallet before reviewing this agreement.");
    }
    const candidate = createWallet(configuredWalletOptions(configured, "testnet"));
    if (!isConfiguredLedgerFacade(configured, candidate)) {
      throw new Error("The created wallet does not match the configured Ledger transport and custody.");
    }
    const connected = await candidate.connect();
    if (connected !== owner || candidate.address() !== owner || !isConfiguredLedgerFacade(configured, candidate)) {
      await candidate.disconnect().catch(() => undefined);
      throw new Error("The connected Ledger account or transport changed.");
    }
    if (!candidate.verifyAddressOnDevice) {
      await candidate.disconnect().catch(() => undefined);
      throw new Error("This Ledger transport cannot verify the owner address.");
    }
    try {
      await candidate.verifyAddressOnDevice();
    } catch (cause) {
      await candidate.disconnect().catch(() => undefined);
      throw cause;
    }
    disconnectRef.current?.();
    const unsubscribe = candidate.onDeviceState?.(setDeviceState);
    disconnectRef.current = () => {
      unsubscribe?.();
      void candidate.disconnect().catch(() => undefined);
    };
    setWallet(candidate);
    setAccountIndex(configured.ledger.accountIndex);
    setLedgerTransport(configured.ledger.transport);
    setDeviceReady(true);
    return candidate;
  };

  const run = async (operation: () => Promise<void>) => {
    await actionGateRef.current.run(async () => {
      setBusy(true);
      setError(undefined);
      try {
        await operation();
      } catch (cause) {
        if (cause instanceof StaleWorkAgreementOperationError) return;
        setError(cause instanceof Error ? cause.message : "The work-agreement operation failed.");
      } finally {
        setBusy(false);
      }
    });
  };

  const applyResponse = (
    next: WorkAgreementPublicState,
    context: WorkAgreementOperationContext,
  ) => {
    assertWorkAgreementOperationContext(context, sessionGenerationRef.current, session);
    if (!owner || next.owner !== owner || next.network !== "testnet") {
      throw new Error("The work-agreement response belongs to another account or network.");
    }
    setRecord(next);
    if (TERMINAL.has(next.status)) {
      clearWorkAgreementRecovery(localStorage, owner, "testnet");
      setRecovery(undefined);
      setNotice(`Agreement reached the terminal ${next.status} state.`);
      return;
    }
    if (next.status === "active") {
      const approvalKey = next.last_resolution?.idempotency_key ?? recovery?.idempotency_key ??
        `agreement-track-${next.agreement_id}`;
      saveRecovery(trackingRecovery(owner, next.agreement_id, approvalKey, "tracking"));
      return;
    }
    if (next.status === "awaiting_approval" &&
        (recovery?.phase === "prepare_pending" || recovery?.phase === "prepare_unknown") &&
        next.approval?.idempotency_key === recovery.idempotency_key) {
      saveRecovery(trackingRecovery(owner, next.agreement_id, recovery.idempotency_key, "tracking"));
    }
  };

  const create = () => run(async () => {
    if (!owner) throw new Error("A wallet-bound local Testnet session is required.");
    if (recoveryBlocked || recovery || record) {
      throw new Error("Resolve the saved agreement before preparing another one.");
    }
    const context = operationContext(owner);
    await requireCurrentSession(context);
    const terms = parseTerms(draft, owner);
    const agreementId = `agreement-${crypto.randomUUID()}`;
    const idempotencyKey = `agreement-idempotency-${crypto.randomUUID()}`;
    assertWorkAgreementOperationContext(context, sessionGenerationRef.current, session);
    saveRecovery(trackingRecovery(owner, agreementId, idempotencyKey, "prepare_pending"));
    let prepared: WorkAgreementPublicState;
    try {
      prepared = await requestWorkAgreement({
        action: "prepare",
        args: {
          owner,
          network: "testnet",
          agreement_id: agreementId,
          action: "create",
          idempotency_key: idempotencyKey,
          approval_expires_at: new Date(Date.now() + 4 * 60_000).toISOString(),
          terms,
        },
      });
    } catch (cause) {
      await requireCurrentSession(context);
      saveRecovery(trackingRecovery(owner, agreementId, idempotencyKey, "prepare_unknown"));
      throw cause;
    }
    await requireCurrentSession(context);
    saveRecovery(trackingRecovery(owner, agreementId, idempotencyKey, "tracking"));
    applyResponse(prepared, context);
    setNotice("Prepared one exact escrow transaction. Connect the saved Ledger account to review it.");
  });

  const prepareTerminal = (action: "release" | "cancel") => run(async () => {
    if (!owner || !record || record.status !== "active" || !workAgreementMatchesSession(record, session)) {
      throw new Error("Only the authenticated owner can prepare an action for an active agreement.");
    }
    if (recovery?.phase !== "tracking" || recovery.agreement_id !== record.agreement_id) {
      throw new Error("Resolve the saved preparation outcome before preparing another agreement action.");
    }
    const context = operationContext(owner);
    await requireCurrentSession(context);
    const idempotencyKey = `agreement-idempotency-${crypto.randomUUID()}`;
    assertWorkAgreementOperationContext(context, sessionGenerationRef.current, session);
    saveRecovery(trackingRecovery(owner, record.agreement_id, idempotencyKey, "prepare_pending"));
    let prepared: WorkAgreementPublicState;
    try {
      prepared = await requestWorkAgreement({
        action: "prepare",
        args: {
          owner,
          network: "testnet",
          agreement_id: record.agreement_id,
          action,
          idempotency_key: idempotencyKey,
          approval_expires_at: new Date(Date.now() + 4 * 60_000).toISOString(),
          terms: record.terms,
        },
      });
    } catch (cause) {
      await requireCurrentSession(context);
      saveRecovery(trackingRecovery(owner, record.agreement_id, idempotencyKey, "prepare_unknown"));
      throw cause;
    }
    await requireCurrentSession(context);
    saveRecovery(trackingRecovery(owner, record.agreement_id, idempotencyKey, "tracking"));
    applyResponse(prepared, context);
    setNotice(`Prepared an exact owner-reviewed escrow ${action} transaction.`);
  });

  const refresh = () => run(async () => {
    const agreementId = record?.agreement_id ?? recovery?.agreement_id;
    if (!owner || !agreementId) throw new Error("No recoverable agreement reference is available.");
    const context = operationContext(owner);
    await requireCurrentSession(context);
    const refreshed = await requestWorkAgreement({
      action: "status",
      args: { owner, network: "testnet", agreement_id: agreementId },
    });
    await requireCurrentSession(context);
    applyResponse(refreshed, context);
  });

  const recover = () => run(async () => {
    if (!owner || !canRecoverWorkAgreement(record, recovery, session) ||
        !isWorkAgreementSubmissionRecovery(recovery)) {
      throw new Error("No exact account-bound submission tuple is available for recovery.");
    }
    const context = operationContext(owner);
    await requireCurrentSession(context);
    const latest = await requestWorkAgreement({
      action: "status",
      args: {
        owner,
        network: "testnet",
        agreement_id: recovery.agreement_id,
      },
    });
    await requireCurrentSession(context);
    if (latest.status === "awaiting_approval" && latest.approval?.approval_id === recovery.approval_id &&
        latest.approval.idempotency_key === recovery.idempotency_key && latest.action === recovery.action) {
      const tracked = trackingRecovery(owner, latest.agreement_id, recovery.idempotency_key, "tracking");
      saveRecovery(tracked);
      setRecord(latest);
      setNotice("Harbor confirms the prior submission never claimed this approval. Review it again only after checking the unchanged exact transaction.");
      return;
    }
    if (latest.status === "active" || TERMINAL.has(latest.status)) {
      applyResponse(latest, context);
      setNotice(`Harbor status resolved the saved submission as ${latest.status}; no new signature or submission was sent.`);
      return;
    }
    if (latest.status !== "submitting" && latest.status !== "unknown") {
      throw new Error("The exact submission is no longer awaiting reconciliation.");
    }
    setRecord(latest);
    const recovered = await requestWorkAgreement({
      action: "recover",
      args: {
        owner,
        network: "testnet",
        agreement_id: recovery.agreement_id,
        approval_id: recovery.approval_id,
        idempotency_key: recovery.idempotency_key,
      },
    });
    await requireCurrentSession(context);
    applyResponse(recovered, context);
    setNotice("Reconciled the exact submission tuple without signing or submitting again.");
  });

  const reject = () => run(async () => {
    const approval = record?.approval;
    if (!owner || !record || !approval || record.status !== "awaiting_approval" ||
        !workAgreementMatchesSession(record, session)) {
      throw new Error("No account-bound approval is available to reject.");
    }
    if (isWorkAgreementSubmissionRecovery(recovery)) {
      throw new Error("Recover the exact pending submission before rejecting this approval.");
    }
    const context = operationContext(owner);
    await requireCurrentSession(context);
    setBound(undefined);
    const rejected = await requestWorkAgreement({
      action: "reject",
      args: {
        owner,
        network: "testnet",
        agreement_id: record.agreement_id,
        approval_id: approval.approval_id,
        idempotency_key: approval.idempotency_key,
      },
    });
    await requireCurrentSession(context);
    applyResponse(rejected, context);
  });

  const review = () => run(async () => {
    if (!owner || !record || !workAgreementMatchesSession(record, session)) {
      throw new Error("The agreement does not match the authenticated Testnet owner.");
    }
    if (isWorkAgreementSubmissionRecovery(recovery)) {
      throw new Error("Recover the exact pending submission before signing anything again.");
    }
    const context = operationContext(owner);
    await requireCurrentSession(context);
    const connectedWallet = await connectLedger();
    await requireCurrentSession(context);
    const runtime: LedgerRuntime = connectedWallet.ledgerTransport === "virtual"
      ? "speculos"
      : "ledger-webhid";
    const preparedReview = await bindWorkAgreementApproval(record, runtime);
    assertWorkAgreementOperationContext(context, sessionGenerationRef.current, session);
    setBound(preparedReview);
  });

  const beforeSign = async () => {
    if (!owner || !record || !bound || record.revision !== bound.revision ||
        !workAgreementMatchesSession(record, session)) {
      setBound(undefined);
      throw new Error("The account, network, or reviewed agreement changed before signing.");
    }
    await requireCurrentSession(operationContext(owner));
  };

  const submit = async (signedBlob: string, approvalId?: string): Promise<ApprovalSubmission> => {
    const result = await submissionGateRef.current.run(async () => {
      if (!owner || !record || !bound || !record.approval ||
          record.revision !== bound.revision || approvalId !== record.approval.approval_id ||
          !workAgreementMatchesSession(record, session)) {
        throw new Error("The exact reviewed approval is no longer current.");
      }
      const context = operationContext(owner);
      await requireCurrentSession(context);
      const verified = verifyExactLedgerSignedBlob({
        signedBlob,
        expectation: bound.expectation,
      });
      assertSignedTransactionMatchesReview(verified.transaction, record.approval.tx_json);
      const attemptId = `agreement-attempt-${crypto.randomUUID()}`;
      const submissionRecovery: WorkAgreementRecovery = {
        version: 1,
        owner,
        network: "testnet",
        agreement_id: record.agreement_id,
        phase: "submission_pending",
        approval_id: record.approval.approval_id,
        idempotency_key: record.approval.idempotency_key,
        attempt_id: attemptId,
        action: record.approval.action,
        expires_at: record.approval.expires_at,
        retain_until: new Date(Date.parse(record.approval.expires_at) + RECOVERY_RETENTION_MS).toISOString(),
      };
      saveRecovery(submissionRecovery);
      setBound(undefined);
      let submitted: WorkAgreementPublicState;
      try {
        submitted = await requestWorkAgreement({
          action: "submit",
          args: {
            owner,
            network: "testnet",
            agreement_id: record.agreement_id,
            approval_id: record.approval.approval_id,
            idempotency_key: record.approval.idempotency_key,
            attempt_id: attemptId,
            signed_blob: signedBlob,
          },
        });
      } catch (cause) {
        await requireCurrentSession(context);
        saveRecovery({ ...submissionRecovery, phase: "submission_unknown" });
        setNotice("Submission outcome is unknown. Recover this exact attempt; do not sign or submit again.");
        throw cause;
      }
      await requireCurrentSession(context);
      if (submitted.tx_hash && submitted.tx_hash !== verified.hash) {
        saveRecovery({ ...submissionRecovery, phase: "submission_unknown" });
        throw new Error("The returned transaction hash does not match the exact signed transaction. Recover this attempt.");
      }
      if (submitted.status === "submitting" || submitted.status === "unknown") {
        saveRecovery({ ...submissionRecovery, phase: "submission_unknown" });
      }
      applyResponse(submitted, context);
      return {
        hash: submitted.tx_hash,
        status: submitted.status === "active" || TERMINAL.has(submitted.status)
          ? "validated" as const
          : "pending" as const,
      };
    });
    if (!result) throw new Error("This approval is already being submitted.");
    return result;
  };

  const clearTerminal = () => {
    if (record && TERMINAL.has(record.status)) {
      clearWorkAgreementRecovery(localStorage, record.owner, "testnet");
      setRecovery(undefined);
      setRecord(undefined);
      setNotice(undefined);
      setError(undefined);
    }
  };

  return (
    <>
      <WorkAgreementView
        busy={busy}
        draft={draft}
        error={error}
        notice={notice}
        owner={owner}
        record={record}
        recovery={recovery}
        recoveryBlocked={recoveryBlocked}
        onChange={(field, value) => setDraft((current) => ({ ...current, [field]: value }))}
        onClear={clearTerminal}
        onCreate={create}
        onPrepareCancel={() => prepareTerminal("cancel")}
        onPrepareRelease={() => prepareTerminal("release")}
        onRecover={recover}
        onRefresh={refresh}
        onReject={reject}
        onReview={review}
      />
      {bound && wallet ? (
        <ApprovalModal
          beforeSign={beforeSign}
          ledger={{
            accountIndex,
            deviceReady,
            deviceState,
            signingMode: bound.review.signingMode,
            transport: ledgerTransport,
          }}
          onClose={() => setBound(undefined)}
          onSubmit={submit}
          open
          request={bound.request}
          wallet={wallet}
        />
      ) : null}
    </>
  );
}

export default WorkAgreementWorkspace;
