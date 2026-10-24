"use client";

import { createWallet, type LedgerDeviceState, type PilotWallet } from "@pilot/wallet";
import { useEffect, useRef, useState } from "react";

import {
  loadPublicPilotConfig,
  loadWalletSessionStatus,
  WALLET_SESSION_CHANGED_EVENT,
  type PublicPilotConfig,
  type WalletSessionStatus,
} from "../../lib/harbor-browser";
import { configuredWalletMetadata, configuredWalletOptions } from "./configured-wallet";
import { OwnerReviewedX402ApprovalModal } from "./x402-ledger-approval-modal";
import {
  bindOwnerReviewedX402Approval,
  type BoundOwnerReviewedX402Approval,
  type OwnerReviewedX402Approval,
} from "./x402-ledger-approval";
import {
  isMissingOwnerReviewApproval,
  OwnerReviewPublicStateSchema,
  requestOwnerReviewedX402,
  type OwnerReviewPublicState,
} from "./x402-owner-review-client";
import { X402_MAX_PRICE_DROPS, X402_RESOURCE } from "./x402-operation-state";
import { X402OwnerReviewView } from "./x402-owner-review-view";

const IDLE_DEVICE: LedgerDeviceState = Object.freeze({ interaction: "none", busy: false });

export type OwnerReviewOperationContext = Readonly<{
  generation: number;
  owner: string;
}>;

export class StaleOwnerReviewOperationError extends Error {
  constructor() {
    super("The wallet session changed while the owner-reviewed payment was running.");
    this.name = "StaleOwnerReviewOperationError";
  }
}

export function assertOwnerReviewOperationContext(
  context: OwnerReviewOperationContext,
  currentGeneration: number,
  currentSession: WalletSessionStatus | null | undefined,
): void {
  if (context.generation !== currentGeneration || !currentSession?.authenticated ||
      currentSession.network !== "testnet" || currentSession.account !== context.owner) {
    throw new StaleOwnerReviewOperationError();
  }
}

export class OwnerReviewAttemptGate {
  private activeToken: number | undefined;
  private nextToken = 0;

  acquire(): number | undefined {
    if (this.activeToken !== undefined) return undefined;
    const token = ++this.nextToken;
    this.activeToken = token;
    return token;
  }

  invalidate(): void {
    this.activeToken = undefined;
  }

  release(token: number): boolean {
    if (this.activeToken !== token) return false;
    this.activeToken = undefined;
    return true;
  }
}

export function ownerReviewRecoveryKey(owner: string, network = "testnet"): string {
  return `pilot:ledger-x402-owner-review:v2:${network}:${owner}`;
}

export type OwnerReviewPrepareRecovery = Readonly<{
  idempotency_key: string;
  network: "testnet";
  owner: string;
  phase: "prepare_pending" | "prepare_unknown";
  version: 1;
}>;

export function restoreOwnerReviewPrepareRecovery(
  value: string | null,
  owner: string,
  network = "testnet",
): OwnerReviewPrepareRecovery | undefined {
  if (value === null || network !== "testnet") return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort().join(",");
    if (keys !== "idempotency_key,network,owner,phase,version" || parsed.version !== 1 ||
        parsed.owner !== owner || parsed.network !== network ||
        (parsed.phase !== "prepare_pending" && parsed.phase !== "prepare_unknown") ||
        typeof parsed.idempotency_key !== "string" ||
        !/^owner-review-[0-9a-f-]{36}$/.test(parsed.idempotency_key)) return undefined;
    return parsed as OwnerReviewPrepareRecovery;
  } catch {
    return undefined;
  }
}

export function persistOwnerReviewPrepareFailure(
  storage: Pick<Storage, "setItem">,
  recovery: OwnerReviewPrepareRecovery,
  prepared: OwnerReviewPublicState | undefined,
): OwnerReviewPrepareRecovery | undefined {
  const key = ownerReviewRecoveryKey(recovery.owner, recovery.network);
  if (prepared) {
    storage.setItem(key, JSON.stringify(prepared));
    return undefined;
  }
  const locked: OwnerReviewPrepareRecovery = { ...recovery, phase: "prepare_unknown" };
  storage.setItem(key, JSON.stringify(locked));
  return locked;
}

export function clearMissingOwnerReviewRecovery(
  storage: Pick<Storage, "removeItem">,
  error: unknown,
  state: Readonly<{ status: string; owner: string; network: string }>,
): boolean {
  if (!isMissingOwnerReviewApproval(error) || state.status !== "awaiting_approval") return false;
  storage.removeItem(ownerReviewRecoveryKey(state.owner, state.network));
  return true;
}

export function restoreOwnerReviewRecovery(
  value: string | null,
  owner: string,
  network = "testnet",
): OwnerReviewPublicState | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    const state = OwnerReviewPublicStateSchema.safeParse(parsed);
    return state.success && state.data.owner === owner && state.data.network === network
      ? state.data
      : undefined;
  } catch {
    return undefined;
  }
}

export function ownerReviewApprovalFromState(
  state: OwnerReviewPublicState,
): OwnerReviewedX402Approval {
  if (state.status !== "awaiting_approval") {
    throw new Error("The owner-reviewed x402 state is not awaiting approval.");
  }
  if (!state.tx_json) {
    throw new Error("The owner-reviewed x402 state has no exact Payment transaction.");
  }
  return {
    approvalId: state.approval_id,
    approvalDigest: state.approval_digest,
    owner: state.owner,
    network: state.network,
    resource: X402_RESOURCE,
    asset: state.asset,
    amountDrops: state.amount_drops,
    payTo: state.pay_to,
    quoteExpiresAt: state.quote_expires_at,
    txJson: state.tx_json,
  };
}

export function X402OwnerReviewWorkspace() {
  const [config, setConfig] = useState<PublicPilotConfig | null>();
  const [session, setSession] = useState<WalletSessionStatus | null>();
  const [wallet, setWallet] = useState<PilotWallet>();
  const [accountIndex, setAccountIndex] = useState(0);
  const [deviceState, setDeviceState] = useState<LedgerDeviceState>(IDLE_DEVICE);
  const [deviceReady, setDeviceReady] = useState(false);
  const [bound, setBound] = useState<BoundOwnerReviewedX402Approval>();
  const [record, setRecord] = useState<OwnerReviewPublicState>();
  const [prepareRecovery, setPrepareRecovery] = useState<OwnerReviewPrepareRecovery>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const attemptGateRef = useRef(new OwnerReviewAttemptGate());
  const disconnectRef = useRef<(() => void) | undefined>(undefined);
  const sessionGenerationRef = useRef(0);
  const sessionLoadRef = useRef(0);
  const verifiedWalletRef = useRef<Readonly<{
    generation: number;
    owner: string;
    wallet: PilotWallet;
  }> | undefined>(undefined);

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
        .then((next) => {
          if (active && requestId === sessionLoadRef.current) setSession(next);
        })
        .catch(() => {
          if (active && requestId === sessionLoadRef.current) setSession(null);
        });
    };
    globalThis.addEventListener?.(WALLET_SESSION_CHANGED_EVENT, onSessionChanged);
    return () => {
      active = false;
      globalThis.removeEventListener?.(WALLET_SESSION_CHANGED_EVENT, onSessionChanged);
      disconnectRef.current?.();
    };
  }, []);

  useEffect(() => {
    sessionGenerationRef.current += 1;
    disconnectRef.current?.();
    disconnectRef.current = undefined;
    verifiedWalletRef.current = undefined;
    setWallet(undefined);
    setDeviceReady(false);
    setDeviceState(IDLE_DEVICE);
    setBound(undefined);
    setRecord(undefined);
    setPrepareRecovery(undefined);
    setNotice(undefined);
    setError(undefined);
    attemptGateRef.current.invalidate();
    setBusy(false);
    if (!session?.authenticated || session.network !== "testnet") return;
    const savedValue = localStorage.getItem(ownerReviewRecoveryKey(session.account, session.network));
    const pending = restoreOwnerReviewPrepareRecovery(
      savedValue,
      session.account,
      session.network,
    );
    const restored = restoreOwnerReviewRecovery(
      savedValue,
      session.account,
      session.network,
    );
    if (pending) {
      setPrepareRecovery(pending);
      setNotice(pending.phase === "prepare_unknown"
        ? "Payment preparation has an unknown outcome. Retry only the saved idempotency key; do not prepare a replacement."
        : "Recovered an interrupted payment preparation. Retry only the saved idempotency key.");
    } else if (restored) {
      setRecord(restored);
      setNotice("Recovered the saved payment approval. Reconcile it before preparing another payment.");
    }
  }, [session]);

  useEffect(() => {
    if (!record || !session?.authenticated || session.network !== "testnet" ||
        record.owner !== session.account || record.network !== session.network) return;
    const key = ownerReviewRecoveryKey(record.owner, record.network);
    if (record.status === "rejected" || record.status === "expired") {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(record));
  }, [record, session]);

  const owner = session?.authenticated && session.network === "testnet"
    ? session.account
    : undefined;

  const operationContext = (expectedOwner: string): OwnerReviewOperationContext => ({
    generation: sessionGenerationRef.current,
    owner: expectedOwner,
  });

  const requireCurrentSession = async (context: OwnerReviewOperationContext) => {
    assertOwnerReviewOperationContext(context, sessionGenerationRef.current, session);
    const current = await loadWalletSessionStatus();
    try {
      assertOwnerReviewOperationContext(context, sessionGenerationRef.current, current);
    } catch (cause) {
      sessionGenerationRef.current += 1;
      verifiedWalletRef.current = undefined;
      setSession(current);
      throw cause;
    }
    return current;
  };

  const connectLedger = async (context: OwnerReviewOperationContext): Promise<PilotWallet> => {
    await requireCurrentSession(context);
    const verified = verifiedWalletRef.current;
    if (wallet && verified?.wallet === wallet && verified.owner === context.owner &&
        verified.generation === context.generation && wallet.network === "testnet" &&
        wallet.address() === context.owner) {
      return wallet;
    }
    if (wallet) {
      await wallet.disconnect().catch(() => undefined);
      verifiedWalletRef.current = undefined;
      setWallet(undefined);
      setDeviceReady(false);
    }
    if (!config || config.network !== "testnet") {
      throw new Error("A wallet-bound local Testnet session is required.");
    }
    const configured = configuredWalletMetadata(sessionStorage.getItem("pilot:wallet"), config);
    if (configured.provider !== "ledger" || !configured.ledger) {
      throw new Error("Reconnect a configured Ledger wallet before owner-reviewed x402.");
    }
    const candidate = createWallet(configuredWalletOptions(configured, "testnet"));
    const connected = await candidate.connect();
    if (connected !== context.owner || candidate.address() !== context.owner) {
      await candidate.disconnect().catch(() => undefined);
      throw new Error("The connected Ledger account changed.");
    }
    if (!candidate.verifyAddressOnDevice) {
      await candidate.disconnect().catch(() => undefined);
      throw new Error("This Ledger transport cannot verify the owner address.");
    }
    try {
      await candidate.verifyAddressOnDevice();
      await requireCurrentSession(context);
    } catch (cause) {
      await candidate.disconnect().catch(() => undefined);
      throw cause;
    }
    disconnectRef.current?.();
    const unsubscribe = candidate.onDeviceState?.(setDeviceState);
    disconnectRef.current = () => {
      unsubscribe?.();
      void candidate.disconnect();
    };
    setAccountIndex(configured.ledger.accountIndex);
    verifiedWalletRef.current = { generation: context.generation, owner: context.owner, wallet: candidate };
    setWallet(candidate);
    setDeviceReady(true);
    return candidate;
  };

  const bindPrepared = async (
    prepared: OwnerReviewPublicState,
    context: OwnerReviewOperationContext,
  ) => {
    if (!config || prepared.owner !== context.owner || prepared.network !== "testnet") {
      throw new StaleOwnerReviewOperationError();
    }
    await connectLedger(context);
    const configured = configuredWalletMetadata(sessionStorage.getItem("pilot:wallet"), config);
    const approval = await bindOwnerReviewedX402Approval({
      approval: ownerReviewApprovalFromState(prepared),
      connectedAccount: context.owner,
      validatedLedgerIndex: prepared.validated_ledger_index,
      validatedAccountSequence: prepared.validated_account_sequence,
      expectedSourceTag: prepared.expected_source_tag,
      runtime: configured.ledger?.transport === "virtual" ? "speculos" : "ledger-webhid",
    });
    await requireCurrentSession(context);
    setBound(approval);
  };

  const prepare = async () => {
    if (!owner || !config || record) return;
    const attemptToken = attemptGateRef.current.acquire();
    if (attemptToken === undefined) return;
    const context = operationContext(owner);
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    let preparedResponse: OwnerReviewPublicState | undefined;
    try {
      await connectLedger(context);
      const idempotencyKey = prepareRecovery?.idempotency_key ?? `owner-review-${crypto.randomUUID()}`;
      const pending: OwnerReviewPrepareRecovery = {
        version: 1,
        owner: context.owner,
        network: "testnet",
        phase: "prepare_pending",
        idempotency_key: idempotencyKey,
      };
      localStorage.setItem(ownerReviewRecoveryKey(context.owner, "testnet"), JSON.stringify(pending));
      setPrepareRecovery(pending);
      const prepared = await requestOwnerReviewedX402({
        action: "prepare",
        args: {
          owner: context.owner,
          network: "testnet",
          max_price_drops: X402_MAX_PRICE_DROPS,
          idempotency_key: idempotencyKey,
        },
      });
      await requireCurrentSession(context);
      if (prepared.owner !== context.owner || prepared.network !== "testnet") {
        throw new StaleOwnerReviewOperationError();
      }
      preparedResponse = prepared;
      localStorage.setItem(ownerReviewRecoveryKey(context.owner, "testnet"), JSON.stringify(prepared));
      setPrepareRecovery(undefined);
      setRecord(prepared);
      await bindPrepared(prepared, context);
    } catch (cause) {
      try {
        await requireCurrentSession(context);
      } catch (sessionCause) {
        if (context.generation === sessionGenerationRef.current) {
          setError(sessionCause instanceof Error ? sessionCause.message : "The wallet session could not be revalidated.");
        }
        return;
      }
      const unknown = prepareRecovery ?? restoreOwnerReviewPrepareRecovery(
        localStorage.getItem(ownerReviewRecoveryKey(context.owner, "testnet")),
        context.owner,
      );
      if (unknown) {
        const locked = persistOwnerReviewPrepareFailure(localStorage, unknown, preparedResponse);
        setPrepareRecovery(locked);
        if (preparedResponse) setRecord(preparedResponse);
      }
      if (context.generation === sessionGenerationRef.current) {
        setError(cause instanceof Error ? cause.message : "The owner-reviewed offer could not be prepared.");
      }
    } finally {
      if (attemptGateRef.current.release(attemptToken)) setBusy(false);
    }
  };

  const resumeReview = async () => {
    if (!owner || !record || record.owner !== owner || record.network !== "testnet" ||
        record.status !== "awaiting_approval") return;
    const attemptToken = attemptGateRef.current.acquire();
    if (attemptToken === undefined) return;
    const context = operationContext(owner);
    setBusy(true);
    setError(undefined);
    try {
      await bindPrepared(record, context);
    } catch (cause) {
      try {
        await requireCurrentSession(context);
      } catch (sessionCause) {
        if (context.generation === sessionGenerationRef.current) {
          setError(sessionCause instanceof Error ? sessionCause.message : "The wallet session could not be revalidated.");
        }
        return;
      }
      if (context.generation === sessionGenerationRef.current) {
        setError(cause instanceof Error ? cause.message : "The saved payment review could not be resumed.");
      }
    } finally {
      if (attemptGateRef.current.release(attemptToken)) setBusy(false);
    }
  };

  const transition = async (action: "reject" | "recover") => {
    if (!owner || !record || record.owner !== owner || record.network !== "testnet") return;
    const attemptToken = attemptGateRef.current.acquire();
    if (attemptToken === undefined) return;
    const context = operationContext(owner);
    setBusy(true);
    setError(undefined);
    try {
      await requireCurrentSession(context);
      const next = await requestOwnerReviewedX402({
        action,
        args: {
          owner: record.owner,
          network: "testnet",
          idempotency_key: record.idempotency_key,
          approval_id: record.approval_id,
        },
      });
      await requireCurrentSession(context);
      if (next.owner !== context.owner || next.network !== "testnet") {
        throw new StaleOwnerReviewOperationError();
      }
      setRecord(next);
      if (action === "reject") {
        setBound(undefined);
        setNotice("The reviewed offer was rejected. No payment was relayed.");
      } else if (next.status === "delivered") {
        setNotice("Validated local simulation confirmed; the fixture resource was delivered.");
      } else {
        setNotice("Settlement is still unknown. Pilot did not relay another payment.");
      }
    } catch (cause) {
      try {
        await requireCurrentSession(context);
      } catch (sessionCause) {
        if (context.generation === sessionGenerationRef.current) {
          setError(sessionCause instanceof Error ? sessionCause.message : "The wallet session could not be revalidated.");
        }
        return;
      }
      if (clearMissingOwnerReviewRecovery(localStorage, cause, record)) {
        setRecord(undefined);
        setBound(undefined);
        setNotice("The saved approval no longer exists in Harbor. Local recovery was cleared; no payment was resubmitted.");
        return;
      }
      if (isMissingOwnerReviewApproval(cause)) {
        setError("Harbor no longer has this approval after it may have been signed or relayed. Recovery remains locked; do not prepare or pay again.");
        return;
      }
      setError(cause instanceof Error ? cause.message : "The owner-reviewed transition failed.");
    } finally {
      if (attemptGateRef.current.release(attemptToken)) setBusy(false);
    }
  };

  const openPayment = record !== undefined && !["delivered", "rejected", "expired"].includes(record.status);
  const reviewContext = owner && record?.owner === owner && record.network === "testnet"
    ? operationContext(owner)
    : undefined;

  return (
    <>
      <X402OwnerReviewView
        busy={busy}
        error={error}
        notice={notice}
        onPrepare={() => void prepare()}
        onRecover={() => void transition("recover")}
        onReject={() => void transition("reject")}
        onResumeReview={() => void resumeReview()}
        openPayment={openPayment}
        owner={owner}
        record={record}
        reviewReady={bound !== undefined}
      />

      {bound && wallet && record?.status === "awaiting_approval" ? (
        <OwnerReviewedX402ApprovalModal
          accountIndex={accountIndex}
          bound={bound}
          deviceReady={deviceReady && !deviceState.busy}
          deviceState={deviceState}
          onClose={() => {
            if (!reviewContext) return;
            try {
              assertOwnerReviewOperationContext(reviewContext, sessionGenerationRef.current, session);
              setBound(undefined);
            } catch {
              // A session change already invalidated the review.
            }
          }}
          onComplete={(submission) => {
            if (!reviewContext) return;
            try {
              assertOwnerReviewOperationContext(reviewContext, sessionGenerationRef.current, session);
              setNotice(submission.status === "validated" ? "The exact Payment completed the local settlement simulation and the fixture resource was delivered." : "The signed Payment has an uncertain local simulation outcome. Reconcile by the same hash; do not pay again.");
            } catch {
              // Never carry a completion notice into another wallet session.
            }
          }}
          onSubmit={async ({ approvalId, approvalDigest, signedBlob }) => {
            if (!reviewContext) throw new StaleOwnerReviewOperationError();
            const attemptToken = attemptGateRef.current.acquire();
            if (attemptToken === undefined) throw new Error("Another owner-reviewed payment operation is still running.");
            setBusy(true);
            try {
              await requireCurrentSession(reviewContext);
              const next = await requestOwnerReviewedX402({
                action: "submit",
                args: {
                  owner: record.owner,
                  network: "testnet",
                  idempotency_key: record.idempotency_key,
                  approval_id: approvalId,
                  approval_digest: approvalDigest,
                  signed_blob: signedBlob,
                },
              });
              await requireCurrentSession(reviewContext);
              if (next.owner !== reviewContext.owner || next.network !== "testnet") {
                throw new StaleOwnerReviewOperationError();
              }
              setRecord(next);
              return { status: next.status === "delivered" ? "validated" : "pending", ...(next.tx_hash === undefined ? {} : { hash: next.tx_hash }) };
            } catch (cause) {
              await requireCurrentSession(reviewContext);
              if (clearMissingOwnerReviewRecovery(localStorage, cause, record)) {
                setRecord(undefined);
                setBound(undefined);
                setNotice("The saved approval no longer exists in Harbor. Local recovery was cleared; no payment was resubmitted.");
              }
              throw cause;
            } finally {
              if (attemptGateRef.current.release(attemptToken)) setBusy(false);
            }
          }}
          open
          wallet={wallet}
        />
      ) : null}
    </>
  );
}
