"use client";

import { createWallet, type LedgerDeviceState, type PilotWallet } from "@pilot/wallet";
import { useEffect, useRef, useState } from "react";

import {
  loadPublicPilotConfig,
  loadWalletSessionStatus,
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
const RECOVERY_STORAGE_KEY = "pilot:ledger-x402-owner-review:v1";

export function clearMissingOwnerReviewRecovery(
  storage: Pick<Storage, "removeItem">,
  error: unknown,
  state: Readonly<{ status: string }>,
): boolean {
  if (!isMissingOwnerReviewApproval(error) || state.status !== "awaiting_approval") return false;
  storage.removeItem(RECOVERY_STORAGE_KEY);
  return true;
}

export function restoreOwnerReviewRecovery(
  value: string | null,
  owner: string,
): OwnerReviewPublicState | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    const state = OwnerReviewPublicStateSchema.safeParse(parsed);
    return state.success && state.data.owner === owner ? state.data : undefined;
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const busyRef = useRef(false);
  const disconnectRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void Promise.all([loadPublicPilotConfig(), loadWalletSessionStatus()])
      .then(([nextConfig, nextSession]) => {
        if (!active) return;
        setConfig(nextConfig);
        setSession(nextSession);
        if (nextSession.authenticated && nextSession.network === "testnet") {
          const restored = restoreOwnerReviewRecovery(
            localStorage.getItem(RECOVERY_STORAGE_KEY),
            nextSession.account,
          );
          if (restored) {
            setRecord(restored);
            setNotice("Recovered the saved payment approval. Reconcile it before preparing another payment.");
          }
        }
      })
      .catch(() => {
        if (!active) return;
        setConfig(null);
        setSession(null);
      });
    return () => {
      active = false;
      disconnectRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (!record) return;
    if (record.status === "rejected" || record.status === "expired") {
      localStorage.removeItem(RECOVERY_STORAGE_KEY);
      return;
    }
    localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(record));
  }, [record]);

  const owner = session?.authenticated && session.network === "testnet"
    ? session.account
    : undefined;

  const connectLedger = async (): Promise<PilotWallet> => {
    if (wallet) return wallet;
    if (!config || config.network !== "testnet" || !owner) {
      throw new Error("A wallet-bound local Testnet session is required.");
    }
    const configured = configuredWalletMetadata(sessionStorage.getItem("pilot:wallet"), config);
    if (configured.provider !== "ledger" || !configured.ledger) {
      throw new Error("Reconnect a configured Ledger wallet before owner-reviewed x402.");
    }
    const candidate = createWallet(configuredWalletOptions(configured, "testnet"));
    const connected = await candidate.connect();
    if (connected !== owner || candidate.address() !== owner) {
      await candidate.disconnect().catch(() => undefined);
      throw new Error("The connected Ledger account changed.");
    }
    if (!candidate.verifyAddressOnDevice) {
      await candidate.disconnect().catch(() => undefined);
      throw new Error("This Ledger transport cannot verify the owner address.");
    }
    await candidate.verifyAddressOnDevice();
    disconnectRef.current?.();
    const unsubscribe = candidate.onDeviceState?.(setDeviceState);
    disconnectRef.current = () => {
      unsubscribe?.();
      void candidate.disconnect();
    };
    setAccountIndex(configured.ledger.accountIndex);
    setWallet(candidate);
    setDeviceReady(true);
    return candidate;
  };

  const bindPrepared = async (prepared: OwnerReviewPublicState) => {
    if (!owner || !config) throw new Error("A wallet-bound local Testnet session is required.");
    await connectLedger();
    const configured = configuredWalletMetadata(sessionStorage.getItem("pilot:wallet"), config);
    const approval = await bindOwnerReviewedX402Approval({
      approval: ownerReviewApprovalFromState(prepared),
      connectedAccount: owner,
      validatedLedgerIndex: prepared.validated_ledger_index,
      validatedAccountSequence: prepared.validated_account_sequence,
      expectedSourceTag: prepared.expected_source_tag,
      runtime: configured.ledger?.transport === "virtual" ? "speculos" : "ledger-webhid",
    });
    setBound(approval);
  };

  const prepare = async () => {
    if (!owner || !config || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await connectLedger();
      const prepared = await requestOwnerReviewedX402({
        action: "prepare",
        args: {
          owner,
          network: "testnet",
          max_price_drops: X402_MAX_PRICE_DROPS,
          idempotency_key: `owner-review-${crypto.randomUUID()}`,
        },
      });
      setRecord(prepared);
      await bindPrepared(prepared);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The owner-reviewed offer could not be prepared.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const resumeReview = async () => {
    if (!record || record.status !== "awaiting_approval" || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await bindPrepared(record);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The saved payment review could not be resumed.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const transition = async (action: "reject" | "recover") => {
    if (!record || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const next = await requestOwnerReviewedX402({
        action,
        args: {
          owner: record.owner,
          network: "testnet",
          idempotency_key: record.idempotency_key,
          approval_id: record.approval_id,
        },
      });
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
      busyRef.current = false;
      setBusy(false);
    }
  };

  const openPayment = record !== undefined && !["delivered", "rejected", "expired"].includes(record.status);

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
          onClose={() => setBound(undefined)}
          onComplete={(submission) => setNotice(submission.status === "validated" ? "The exact Payment completed the local settlement simulation and the fixture resource was delivered." : "The signed Payment has an uncertain local simulation outcome. Reconcile by the same hash; do not pay again.")}
          onSubmit={async ({ approvalId, approvalDigest, signedBlob }) => {
            try {
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
              setRecord(next);
              return { status: next.status === "delivered" ? "validated" : "pending", ...(next.tx_hash === undefined ? {} : { hash: next.tx_hash }) };
            } catch (cause) {
              if (clearMissingOwnerReviewRecovery(localStorage, cause, record)) {
                setRecord(undefined);
                setBound(undefined);
                setNotice("The saved approval no longer exists in Harbor. Local recovery was cleared; no payment was resubmitted.");
              }
              throw cause;
            }
          }}
          open
          wallet={wallet}
        />
      ) : null}
    </>
  );
}
