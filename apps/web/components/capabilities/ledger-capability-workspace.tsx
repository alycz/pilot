"use client";

import { createWallet, type LedgerDeviceState, type PilotWallet } from "@pilot/wallet";
import React from "react";
import { useEffect, useRef, useState } from "react";

import {
  loadPublicPilotConfig,
  loadWalletSessionStatus,
  WALLET_SESSION_CHANGED_EVENT,
  type PublicPilotConfig,
  type WalletSessionStatus,
} from "../../lib/harbor-browser";
import { configuredWalletMetadata, configuredWalletOptions } from "../chat/configured-wallet";
import { LedgerCapabilityApprovalModal } from "./ledger-capability-approval-modal";
import {
  CapabilityRequestError,
  activateCapability,
  invokeCapability,
  prepareCapability,
  prepareCapabilityRevocation,
  readCapability,
  revokeCapability,
  type CapabilityGrant,
  type CapabilityInvocation,
  type CapabilityOwnerProof,
  type CapabilityOwnerReview,
} from "./ledger-capability-client";
import {
  capabilityRecoveryKey,
  parseCapabilityRecovery,
  recoverableInvocation,
  recoverableRevocationPreparation,
  serializeCapabilityRecovery,
  trackedCapabilityReference,
  type CapabilityRecovery,
} from "./ledger-capability-recovery";
import {
  bindCapabilityOwnerReview,
  type BoundCapabilityOwnerReview,
} from "./ledger-capability-review";
import { LedgerCapabilityView } from "./ledger-capability-view";

const IDLE_DEVICE: LedgerDeviceState = Object.freeze({ interaction: "none", busy: false });

export function capabilityRemainingUses(grant: CapabilityGrant): number {
  return Math.max(0, grant.maxUses - grant.uses);
}

export function effectiveCapabilityState(grant: CapabilityGrant, now = Date.now()): CapabilityGrant["state"] {
  return grant.state !== "revoked" && Date.parse(grant.expiresAt) <= now
    ? "expired"
    : grant.state;
}

export function capabilityMatchesSession(
  grant: CapabilityGrant,
  session: WalletSessionStatus | null | undefined,
): boolean {
  return !!session?.authenticated && session.network === "testnet" &&
    grant.network === "testnet" && session.account === grant.account;
}

export function capabilityRejectionNotice(action: CapabilityOwnerReview["action"]): string {
  return action === "activate"
    ? "Owner rejected activation. The prepared grant remains inactive and cannot invoke the service."
    : "Owner rejected revocation. The existing capability remains unchanged.";
}

export function LedgerCapabilityWorkspace() {
  const [config, setConfig] = useState<PublicPilotConfig | null>();
  const [session, setSession] = useState<WalletSessionStatus | null>();
  const [wallet, setWallet] = useState<PilotWallet>();
  const [accountIndex, setAccountIndex] = useState(0);
  const [deviceState, setDeviceState] = useState<LedgerDeviceState>(IDLE_DEVICE);
  const [deviceReady, setDeviceReady] = useState(false);
  const [grant, setGrant] = useState<CapabilityGrant>();
  const [boundReview, setBoundReview] = useState<BoundCapabilityOwnerReview>();
  const [recovery, setRecovery] = useState<CapabilityRecovery>();
  const [lastInvocation, setLastInvocation] = useState<CapabilityInvocation>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const busyRef = useRef(false);
  const disconnectRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const [nextConfig, nextSession] = await Promise.all([
        loadPublicPilotConfig(),
        loadWalletSessionStatus(),
      ]);
      if (!active) return;
      setConfig(nextConfig);
      setSession(nextSession);
    };
    void load().catch(() => {
      if (!active) return;
      setConfig(null);
      setSession(null);
    });
    const onSessionChanged = () => {
      void loadWalletSessionStatus()
        .then((next) => { if (active) setSession(next); })
        .catch(() => { if (active) setSession(null); });
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
    disconnectRef.current?.();
    disconnectRef.current = undefined;
    setWallet(undefined);
    setDeviceReady(false);
    setDeviceState(IDLE_DEVICE);
    setBoundReview(undefined);
    setGrant(undefined);
    setLastInvocation(undefined);
    setRecovery(undefined);
    setError(undefined);
    setNotice(undefined);
    if (!session?.authenticated || session.network !== "testnet") return () => { active = false; };
    const saved = parseCapabilityRecovery(
      localStorage.getItem(capabilityRecoveryKey(session.account)),
      session.account,
    );
    setRecovery(saved);
    const reference = trackedCapabilityReference(saved);
    if (!reference) {
      if (saved?.phase === "prepare_pending" || saved?.phase === "prepare_unknown") {
        setNotice("Capability preparation has an unknown outcome. Do not prepare a replacement; Harbor has no safe lookup for the lost reference.");
      }
      return () => { active = false; };
    }
    void readCapability(session.account, reference)
      .then((recovered) => {
        if (!active) return;
        setGrant(recovered);
        setNotice(saved?.phase === "invoke_pending" || saved?.phase === "invoke_unknown"
          ? "Recovered a pending invocation tuple. Reconcile only that exact request id."
          : saved?.phase === "revoke_prepare_pending"
            ? "Recovered a pending revocation-review request. Retry only that exact request id."
            : "Recovered the account-bound capability from Harbor.");
      })
      .catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Capability recovery failed. Retry the stored reference before preparing another grant.");
      });
    return () => { active = false; };
  }, [session]);

  useEffect(() => {
    if (!grant) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [grant]);

  const owner = session?.authenticated && session.network === "testnet"
    ? session.account
    : undefined;
  const bound = grant ? capabilityMatchesSession(grant, session) : false;
  const state = grant ? effectiveCapabilityState(grant, now) : undefined;
  const invocationRecovery = recoverableInvocation(recovery);
  const revocationRecovery = recoverableRevocationPreparation(recovery);

  const saveRecovery = (next: CapabilityRecovery) => {
    localStorage.setItem(capabilityRecoveryKey(next.owner), serializeCapabilityRecovery(next));
    setRecovery(next);
  };

  const requireCurrentSession = async (expectedOwner: string) => {
    const current = await loadWalletSessionStatus();
    if (!current.authenticated || current.network !== "testnet" || current.account !== expectedOwner) {
      throw new Error("The wallet session account or network changed. Reconnect the reviewed Testnet account.");
    }
    setSession(current);
  };

  const connectLedger = async (): Promise<PilotWallet> => {
    if (wallet) {
      if (owner && wallet.network === "testnet" && wallet.address() === owner) return wallet;
      await wallet.disconnect().catch(() => undefined);
      setWallet(undefined);
      setDeviceReady(false);
    }
    if (!config || config.network !== "testnet" || !owner) {
      throw new Error("A wallet-bound local Testnet session is required.");
    }
    const configured = configuredWalletMetadata(sessionStorage.getItem("pilot:wallet"), config);
    if (configured.provider !== "ledger" || !configured.ledger) {
      throw new Error("Reconnect a configured Ledger wallet before managing capabilities.");
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

  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The capability operation failed.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const prepare = () => run(async () => {
    if (!owner) throw new Error("A wallet-bound local Testnet session is required.");
    if (recovery !== undefined) throw new Error("Resolve the saved capability state before preparing another grant.");
    await requireCurrentSession(owner);
    await connectLedger();
    await requireCurrentSession(owner);
    const startedAt = new Date().toISOString();
    saveRecovery({ version: 1, owner, network: "testnet", phase: "prepare_pending", started_at: startedAt });
    let prepared: Awaited<ReturnType<typeof prepareCapability>>;
    try {
      prepared = await prepareCapability(owner);
    } catch (cause) {
      saveRecovery({ version: 1, owner, network: "testnet", phase: "prepare_unknown", started_at: startedAt });
      throw cause;
    }
    saveRecovery({
      version: 1,
      owner,
      network: "testnet",
      phase: "tracking",
      capability_ref: prepared.grant.capabilityRef,
    });
    setGrant(prepared.grant);
    setBoundReview(await bindCapabilityOwnerReview(prepared.owner_review, prepared.grant));
    setLastInvocation(undefined);
    setNotice("Prepared an inactive, bounded grant. It cannot be used until the exact owner proof is signed.");
  });

  const refresh = () => run(async () => {
    const reference = grant?.capabilityRef ?? trackedCapabilityReference(recovery);
    if (!owner || !reference) throw new Error("No recoverable capability reference is available.");
    await requireCurrentSession(owner);
    const refreshed = await readCapability(owner, reference);
    setGrant(refreshed);
    if (!invocationRecovery && !revocationRecovery) {
      saveRecovery({ version: 1, owner, network: "testnet", phase: "tracking", capability_ref: reference });
      setNotice("Capability status refreshed from Harbor.");
    } else {
      setNotice("Capability status refreshed. The pending operation remains locked to its exact request id until reconciled.");
    }
  });

  const invoke = (requestId?: string) => run(async () => {
    const exactRecovery = requestId !== undefined && invocationRecovery?.requestId === requestId;
    if (!owner || !grant || !bound || (!exactRecovery && effectiveCapabilityState(grant) !== "active")) {
      throw new Error("Only the bound active capability can invoke the fixed mock service.");
    }
    await requireCurrentSession(owner);
    const id = requestId ?? invocationRecovery?.requestId ?? `capability-invoke-${crypto.randomUUID()}`;
    const invocationGeneration = invocationRecovery?.requestId === id
      ? invocationRecovery.generation
      : grant.generation;
    const invocationRef = invocationRecovery?.requestId === id
      ? invocationRecovery.capabilityRef
      : grant.capabilityRef;
    saveRecovery({
      version: 1,
      owner,
      network: "testnet",
      phase: "invoke_pending",
      capability_ref: invocationRef,
      generation: invocationGeneration,
      request_id: id,
      resource: "ledger-docs",
    });
    const result = await invokeCapability(owner, invocationRef, invocationGeneration, id);
    setLastInvocation(result);
    if (result.status === "unknown") {
      saveRecovery({
        version: 1,
        owner,
        network: "testnet",
        phase: "invoke_unknown",
        capability_ref: invocationRef,
        generation: invocationGeneration,
        request_id: id,
        resource: "ledger-docs",
      });
    } else {
      saveRecovery({ version: 1, owner, network: "testnet", phase: "tracking", capability_ref: invocationRef });
    }
    setGrant(await readCapability(owner, invocationRef));
    setNotice(result.replayed
      ? "Recovered the exact prior invocation; Harbor did not dispatch it again."
      : result.status === "completed"
        ? "The fixed local mock service completed one bounded invocation."
        : "Invocation outcome is unknown. Recover only with the same request id.");
  });

  const prepareRevoke = (recoveryRequestId?: string) => run(async () => {
    if (!owner || !grant || !bound || effectiveCapabilityState(grant) !== "active") {
      throw new Error("Only the bound active capability can be revoked.");
    }
    if (recoveryRequestId && (
      revocationRecovery?.capabilityRef !== grant.capabilityRef ||
      revocationRecovery.generation !== grant.generation ||
      revocationRecovery.requestId !== recoveryRequestId
    )) throw new Error("The saved revocation recovery tuple no longer matches this capability.");
    await requireCurrentSession(owner);
    await connectLedger();
    await requireCurrentSession(owner);
    const requestId = recoveryRequestId ?? `capability-revoke-${crypto.randomUUID()}`;
    saveRecovery({
      version: 1,
      owner,
      network: "testnet",
      phase: "revoke_prepare_pending",
      capability_ref: grant.capabilityRef,
      generation: grant.generation,
      request_id: requestId,
    });
    const prepared = await prepareCapabilityRevocation(
      owner,
      grant.capabilityRef,
      requestId,
    );
    setBoundReview(await bindCapabilityOwnerReview(prepared.owner_review, grant));
    saveRecovery({ version: 1, owner, network: "testnet", phase: "tracking", capability_ref: grant.capabilityRef });
    setNotice("Prepared an exact revocation proof. The capability remains active until that proof is verified.");
  });

  const submitProof = async (proof: CapabilityOwnerProof, currentReview: CapabilityOwnerReview) => {
    if (!owner || !grant || !bound) throw new Error("The capability is not bound to the current wallet session.");
    await requireCurrentSession(owner);
    if (currentReview.action === "activate") {
      const activated = await activateCapability(owner, currentReview, proof);
      setGrant(activated);
      saveRecovery({ version: 1, owner, network: "testnet", phase: "tracking", capability_ref: activated.capabilityRef });
      setBoundReview(undefined);
      setNotice("Capability activated. The signature proved owner-key control; it did not prove a physical Ledger.");
      return;
    }
    const revoked = await revokeCapability(owner, currentReview, proof);
    let denied = false;
    try {
      await invokeCapability(
        owner,
        revoked.capabilityRef,
        revoked.generation,
        `capability-post-revoke-${crypto.randomUUID()}`,
      );
    } catch (cause) {
      denied = cause instanceof CapabilityRequestError;
      if (!denied) throw cause;
    }
    const confirmed = await readCapability(owner, revoked.capabilityRef);
    if (!denied || confirmed.state !== "revoked") {
      throw new Error("Capability revocation could not be confirmed.");
    }
    setGrant(confirmed);
    saveRecovery({ version: 1, owner, network: "testnet", phase: "tracking", capability_ref: confirmed.capabilityRef });
    setBoundReview(undefined);
    setNotice("Revocation confirmed. A new post-revoke invocation was denied by Harbor.");
  };

  const discardPrepared = () => {
    if (!owner || !grant || grant.state !== "prepared") return;
    localStorage.removeItem(capabilityRecoveryKey(owner));
    setRecovery(undefined);
    setGrant(undefined);
    setBoundReview(undefined);
    setNotice("Discarded the local reference to the inactive prepared grant. No capability was activated.");
  };

  const clearFinished = () => {
    if (!owner || !grant || !["revoked", "expired"].includes(effectiveCapabilityState(grant))) return;
    localStorage.removeItem(capabilityRecoveryKey(owner));
    setRecovery(undefined);
    setGrant(undefined);
    setLastInvocation(undefined);
    setNotice("Cleared the terminal local capability record.");
  };

  return (
    <>
      <LedgerCapabilityView
        bound={bound}
        busy={busy}
        error={error}
        grant={grant}
        hasTrackedReference={trackedCapabilityReference(recovery) !== undefined}
        invocationRecoveryId={invocationRecovery?.requestId}
        lastInvocation={lastInvocation}
        notice={notice}
        onClearFinished={clearFinished}
        onDiscardPrepared={discardPrepared}
        onInvoke={() => void invoke()}
        onPrepare={prepare}
        onPrepareRevocation={() => void prepareRevoke()}
        onRecoverInvocation={() => invocationRecovery && void invoke(invocationRecovery.requestId)}
        onRecoverRevocation={() => revocationRecovery && void prepareRevoke(revocationRecovery.requestId)}
        onRefresh={refresh}
        onReplayInvocation={() => lastInvocation && void invoke(lastInvocation.requestId)}
        owner={owner}
        recoveryPhase={recovery?.phase}
        remainingUses={grant ? capabilityRemainingUses(grant) : undefined}
        reviewOpen={boundReview !== undefined}
        revocationRecoveryId={revocationRecovery?.requestId}
        state={state}
      />

      {boundReview && wallet ? (
        <LedgerCapabilityApprovalModal
          accountIndex={accountIndex}
          beforeSign={() => requireCurrentSession(boundReview.grant.account)}
          bound={boundReview}
          deviceReady={deviceReady && !deviceState.busy}
          deviceState={deviceState}
          onClose={(rejected) => {
            setBoundReview(undefined);
            if (rejected) setNotice(capabilityRejectionNotice(boundReview.review.action));
          }}
          onSubmit={submitProof}
          open
          wallet={wallet}
        />
      ) : null}
    </>
  );
}
