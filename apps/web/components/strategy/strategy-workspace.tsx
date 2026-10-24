"use client";

import { createWallet } from "@pilot/wallet";
import type { Strategy, StrategyAuditEvent, StrategyKillSwitch } from "@pilot/contracts";
import { createStrategyClient, StrategyMutationUnknownError, type ScopedStrategyKillSwitch, type StrategyProofInput } from "@/lib/strategy-client";
import { loadPublicPilotConfig, loadWalletSessionStatus, WALLET_SESSION_CHANGED_EVENT } from "@/lib/harbor-browser";
import { configuredWalletMetadata, configuredWalletOptions } from "@/components/chat/configured-wallet";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { StrategyDraftForm } from "./strategy-draft-form";
import { StrategySignedOutDemo } from "./strategy-demo";
import { AuditTrail, DecisionList, GlobalKillControl, InflightWarning, MandateReview, StrategyControls, StrategyStatus } from "./strategy-panels";
import { defaultStrategyDraft, mutationOutcomeProven, parsePendingMutation, pendingMutationStorageKey, strategyAuditView, strategyCreateInput, unresolvedSubmission, type PendingStrategyMutation, type StrategyDraft, type StrategyView } from "./types";

type Client = ReturnType<typeof createStrategyClient>;
type Screen = "draft" | "review" | "status";
type StrategyContext =
  | { mode: "demo"; realModeStatus: string }
  | { mode: "real"; account: string };
type PendingGlobalKillMutation = {
  version: 1;
  account: string;
  requestId: string;
  desiredEnabled: boolean;
  startedAt: string;
};

export function StrategyWorkspace({ client: injectedClient }: { client?: Client }) {
  const client = useMemo(() => injectedClient ?? createStrategyClient(), [injectedClient]);
  const [draft, setDraft] = useState(() => defaultStrategyDraft());
  const [screen, setScreen] = useState<Screen>("draft");
  const [strategy, setStrategy] = useState<Strategy>();
  const [audit, setAudit] = useState<StrategyAuditEvent[]>([]);
  const [context, setContext] = useState<StrategyContext>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [pendingMutation, setPendingMutation] = useState<PendingStrategyMutation>();
  const [globalKill, setGlobalKill] = useState<StrategyKillSwitch>();
  const [globalKillError, setGlobalKillError] = useState<string>();
  const [pendingGlobalKill, setPendingGlobalKill] = useState<PendingGlobalKillMutation>();
  const pendingRef = useRef<PendingStrategyMutation | undefined>(undefined);
  const pendingGlobalKillRef = useRef<PendingGlobalKillMutation | undefined>(undefined);
  const recoveryRef = useRef<(() => Promise<Strategy>) | undefined>(undefined);
  const globalRecoveryRef = useRef<(() => Promise<ScopedStrategyKillSwitch>) | undefined>(undefined);
  const proofRef = useRef<{ action: "activate" | "resume" | "clear_global_kill"; proof: StrategyProofInput } | undefined>(undefined);
  const refreshGenerationRef = useRef(0);
  const refreshControllerRef = useRef<AbortController | undefined>(undefined);
  const activeAccountRef = useRef<string | undefined>(undefined);

  const retainPending = useCallback((next: PendingStrategyMutation | undefined) => {
    const previous = pendingRef.current;
    pendingRef.current = next;
    setPendingMutation(next);
    if (previous && (!next || previous.account !== next.account)) sessionStorage.removeItem(pendingMutationStorageKey(previous.account));
    if (next) sessionStorage.setItem(pendingMutationStorageKey(next.account), JSON.stringify(next));
  }, []);

  const retainPendingGlobalKill = useCallback((next: PendingGlobalKillMutation | undefined) => {
    const previous = pendingGlobalKillRef.current;
    pendingGlobalKillRef.current = next;
    setPendingGlobalKill(next);
    if (previous && (!next || previous.account !== next.account)) sessionStorage.removeItem(globalKillPendingStorageKey(previous.account));
    if (next) sessionStorage.setItem(globalKillPendingStorageKey(next.account), JSON.stringify(next));
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    setError(undefined);
    const enterDemo = (realModeStatus: string) => {
      if (generation !== refreshGenerationRef.current) return;
      activeAccountRef.current = undefined;
      setContext({ mode: "demo", realModeStatus });
      setStrategy(undefined);
      setAudit([]);
      setGlobalKill(undefined);
      setGlobalKillError(undefined);
      setScreen("draft");
      pendingRef.current = undefined;
      setPendingMutation(undefined);
      recoveryRef.current = undefined;
      pendingGlobalKillRef.current = undefined;
      setPendingGlobalKill(undefined);
      globalRecoveryRef.current = undefined;
      proofRef.current = undefined;
    };
    try {
      const session = await loadWalletSessionStatus(undefined, controller.signal);
      if (generation !== refreshGenerationRef.current) return;
      if (!session.authenticated) {
        enterDemo("Signed out · connect a Testnet budget account when you are ready for actual setup.");
        return;
      }
      if (session.network !== "testnet") {
        enterDemo("Actual strategy setup is Testnet-only; the connected wallet is on a different network.");
        return;
      }
      let config: Awaited<ReturnType<typeof loadPublicPilotConfig>>;
      try {
        config = await loadPublicPilotConfig(undefined, controller.signal);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        enterDemo("Actual Testnet setup is temporarily unavailable because public configuration could not be verified.");
        return;
      }
      if (generation !== refreshGenerationRef.current) return;
      if (config.network !== "testnet") {
        enterDemo("Actual strategy setup is unavailable because this Pilot session is not configured for Testnet.");
        return;
      }
      activeAccountRef.current = session.account;
      setContext({ mode: "real", account: session.account });
      setStrategy(undefined);
      setAudit([]);
      setGlobalKill(undefined);
      setGlobalKillError(undefined);
      setScreen("draft");
      setDraft((current) => current.account === session.account ? current : defaultStrategyDraft(session.account));
      const strategies = await client.list();
      if (generation !== refreshGenerationRef.current || activeAccountRef.current !== session.account) return;
      const current = strategies.find((candidate) => candidate.mandate.account === session.account);
      setStrategy(current);
      let currentAudit: StrategyAuditEvent[] = [];
      if (current) {
        currentAudit = await client.audit(current.strategy_id);
        if (generation !== refreshGenerationRef.current || activeAccountRef.current !== session.account) return;
        setAudit(currentAudit);
        setScreen(current.lifecycle === "draft" ? "review" : "status");
      }
      let scopedKill: ScopedStrategyKillSwitch | undefined;
      try {
        scopedKill = await client.globalKillGet();
        if (generation !== refreshGenerationRef.current || activeAccountRef.current !== session.account) return;
        if (scopedKill.owner !== session.account || scopedKill.network !== "testnet") throw new Error("Global kill status was not scoped to the current owner.");
        setGlobalKill(scopedKill.kill_switch);
      } catch (cause) {
        if (generation !== refreshGenerationRef.current || activeAccountRef.current !== session.account) return;
        setGlobalKill(undefined);
        setGlobalKillError(cause instanceof Error ? cause.message : "Pilot could not verify the account-wide global kill switch.");
      }
      const retained = pendingRef.current?.account === session.account ? pendingRef.current : parsePendingMutation(sessionStorage.getItem(pendingMutationStorageKey(session.account)), session.account);
      if (retained && mutationOutcomeProven(retained, current, currentAudit)) {
        sessionStorage.removeItem(pendingMutationStorageKey(retained.account));
        pendingRef.current = undefined;
        setPendingMutation(undefined);
        recoveryRef.current = undefined;
      } else if (retained) {
        pendingRef.current = retained;
        setPendingMutation(retained);
        setError(`Mutation outcome remains unknown. Request ID ${retained.requestId} is retained; conflicting mutations remain disabled.`);
      } else {
        // A pending mutation belongs to one exact owner account. Switching
        // accounts must clear only the in-memory control lock; retain the
        // original account's sessionStorage receipt for recovery when that
        // owner returns.
        pendingRef.current = undefined;
        setPendingMutation(undefined);
        recoveryRef.current = undefined;
        proofRef.current = undefined;
      }
      const retainedGlobal = pendingGlobalKillRef.current?.account === session.account
        ? pendingGlobalKillRef.current
        : parsePendingGlobalKill(sessionStorage.getItem(globalKillPendingStorageKey(session.account)), session.account);
      if (scopedKill) {
        if (retainedGlobal) sessionStorage.removeItem(globalKillPendingStorageKey(retainedGlobal.account));
        pendingGlobalKillRef.current = undefined;
        setPendingGlobalKill(undefined);
        globalRecoveryRef.current = undefined;
      } else if (retainedGlobal) {
        pendingGlobalKillRef.current = retainedGlobal;
        setPendingGlobalKill(retainedGlobal);
        setError(`Global kill outcome remains unknown. Request ID ${retainedGlobal.requestId} is retained; conflicting mutations remain disabled.`);
      } else {
        pendingGlobalKillRef.current = undefined;
        setPendingGlobalKill(undefined);
        globalRecoveryRef.current = undefined;
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      enterDemo("Actual strategy setup is temporarily unavailable because the wallet session could not be verified.");
    }
  }, [client, retainPending]);

  useEffect(() => {
    const onWalletSessionChanged = () => { void refresh(); };
    void refresh();
    globalThis.addEventListener(WALLET_SESSION_CHANGED_EVENT, onWalletSessionChanged);
    return () => {
      refreshGenerationRef.current += 1;
      refreshControllerRef.current?.abort();
      globalThis.removeEventListener(WALLET_SESSION_CHANGED_EVENT, onWalletSessionChanged);
    };
  }, [refresh]);

  const run = async (name: string, action: () => Promise<Strategy>, descriptor: Omit<PendingStrategyMutation, "requestId">, recovery?: (requestId: string) => Promise<Strategy>) => {
    const riskReducing = descriptor.action === "pause" || descriptor.action === "stop" || descriptor.action === "kill";
    if (busy || pendingRef.current || (pendingGlobalKillRef.current && !riskReducing)) return;
    const operationGeneration = refreshGenerationRef.current;
    const ownerIsCurrent = () => operationGeneration === refreshGenerationRef.current && activeAccountRef.current === descriptor.account;
    setBusy(name);
    setError(undefined);
    try {
      const next = await action();
      if (next.mandate.account !== descriptor.account || !ownerIsCurrent()) return;
      const nextAudit = await client.audit(next.strategy_id);
      if (!ownerIsCurrent()) return;
      setStrategy(next);
      setAudit(nextAudit);
      setScreen(next.lifecycle === "draft" ? "review" : "status");
      recoveryRef.current = undefined;
      proofRef.current = undefined;
    } catch (cause) {
      if (cause instanceof StrategyMutationUnknownError) {
        const retained = { ...descriptor, requestId: cause.requestId };
        if (!ownerIsCurrent()) {
          sessionStorage.setItem(pendingMutationStorageKey(retained.account), JSON.stringify(retained));
          return;
        }
        retainPending(retained);
        recoveryRef.current = recovery ? () => recovery(cause.requestId) : undefined;
        setError(`Mutation outcome unknown. Request ID ${cause.requestId} is retained; refresh and reconcile before any new mutation.`);
      } else {
        if (!ownerIsCurrent()) return;
        setError(cause instanceof Error ? cause.message : "The strategy request failed.");
        recoveryRef.current = undefined;
        proofRef.current = undefined;
      }
    } finally {
      setBusy(undefined);
    }
  };

  const createDraft = async (candidate: StrategyDraft) => {
    if (context?.mode !== "real") return;
    const input = strategyCreateInput(candidate);
    await run("create", () => client.create(input), { action: "create", account: context.account, expectedLifecycle: "draft", expectedExpiresAt: input.expires_at, startedAt: new Date().toISOString() }, (requestId) => client.create(input, requestId));
  };

  const authorizeProof = async (action: "activate" | "resume" | "clear_global_kill"): Promise<StrategyProofInput> => {
    if (!strategy || context?.mode !== "real") throw new Error("A current Testnet mandate is required.");
    if (action !== "clear_global_kill" && (globalKillError || !globalKill || globalKill.enabled)) throw new Error("The owner-scoped global kill switch must be verified and cleared before autonomous authorization.");
    const config = await loadPublicPilotConfig();
    const requestId = crypto.randomUUID();
    const configured = configuredWalletMetadata(sessionStorage.getItem("pilot:wallet"), config);
    if (configured.account !== strategy.mandate.account) throw new Error("Reconnect the exact wallet that owns this mandate.");
    const challengeResponse = await fetch("/api/auth/wallet/strategy-challenge", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, strategy_id: strategy.strategy_id, mandate_version: strategy.mandate.version, mandate_digest: strategy.mandate.digest, mandate_expires_at: strategy.mandate.expires_at, request_id: requestId }),
    });
    const challenge = await challengeResponse.json().catch(() => null) as { account?: string; network?: string; mandate_version?: number; mandate_digest?: string; mandate_expires_at?: string; request_id?: string; challenge_token?: string; tx_json?: Record<string, unknown>; error?: string } | null;
    if (!challengeResponse.ok || challenge?.account !== strategy.mandate.account || challenge.network !== "testnet" || challenge.mandate_version !== strategy.mandate.version || challenge.mandate_digest !== strategy.mandate.digest || challenge.mandate_expires_at !== strategy.mandate.expires_at || challenge.request_id !== requestId || !challenge.challenge_token || !challenge.tx_json) throw new Error(challenge?.error ?? "Pilot could not create a fresh strategy proof.");
    const wallet = createWallet(configuredWalletOptions(configured, "testnet"));
    try {
      const connected = await wallet.connect();
      if (connected !== strategy.mandate.account) throw new Error("The connected wallet does not own this mandate.");
      const proof: StrategyProofInput = {
        strategy_id: strategy.strategy_id, mandate_version: strategy.mandate.version,
        mandate_digest: strategy.mandate.digest, mandate_expires_at: strategy.mandate.expires_at,
        request_id: requestId, challenge_token: challenge.challenge_token,
        tx_blob: await wallet.signOnly(challenge.tx_json),
      };
      proofRef.current = { action, proof };
      return proof;
    } finally {
      await wallet.disconnect().catch(() => undefined);
    }
  };

  const runGlobalKill = async (name: string, desiredEnabled: boolean, action: () => Promise<ScopedStrategyKillSwitch>, recovery?: (requestId: string) => Promise<ScopedStrategyKillSwitch>) => {
    if (context?.mode !== "real" || busy || pendingRef.current || pendingGlobalKillRef.current) return;
    const account = context.account;
    const operationGeneration = refreshGenerationRef.current;
    const ownerIsCurrent = () => operationGeneration === refreshGenerationRef.current && activeAccountRef.current === account;
    setBusy(name);
    setError(undefined);
    try {
      const next = await action();
      if (!ownerIsCurrent() || next.owner !== account || next.network !== "testnet" || next.kill_switch.enabled !== desiredEnabled) throw new Error("Global kill response did not match the current owner and requested state.");
      setGlobalKill(next.kill_switch);
      setGlobalKillError(undefined);
      retainPendingGlobalKill(undefined);
      globalRecoveryRef.current = undefined;
      proofRef.current = undefined;
    } catch (cause) {
      if (cause instanceof StrategyMutationUnknownError) {
        const retained: PendingGlobalKillMutation = { version: 1, account, requestId: cause.requestId, desiredEnabled, startedAt: new Date().toISOString() };
        if (!ownerIsCurrent()) {
          sessionStorage.setItem(globalKillPendingStorageKey(account), JSON.stringify(retained));
          return;
        }
        retainPendingGlobalKill(retained);
        globalRecoveryRef.current = recovery ? () => recovery(cause.requestId) : undefined;
        setError(`Global kill outcome unknown. Request ID ${cause.requestId} is retained; refresh durable status before any new mutation.`);
      } else if (ownerIsCurrent()) {
        setError(cause instanceof Error ? cause.message : "The global kill request failed.");
        globalRecoveryRef.current = undefined;
        proofRef.current = undefined;
      }
    } finally {
      setBusy(undefined);
    }
  };

  const replayPending = async () => {
    if (!pendingMutation || !recoveryRef.current || busy) return;
    const retained = pendingMutation;
    const recovery = recoveryRef.current;
    const operationGeneration = refreshGenerationRef.current;
    const ownerIsCurrent = () => operationGeneration === refreshGenerationRef.current && activeAccountRef.current === retained.account;
    setBusy("replay"); setError(undefined);
    try {
      const next = await recovery();
      if (next.mandate.account !== retained.account || !ownerIsCurrent()) return;
      const nextAudit = await client.audit(next.strategy_id);
      if (!ownerIsCurrent()) return;
      setStrategy(next); setAudit(nextAudit); setScreen(next.lifecycle === "draft" ? "review" : "status");
      retainPending(undefined); recoveryRef.current = undefined; proofRef.current = undefined;
    } catch (cause) {
      if (!ownerIsCurrent()) return;
      setError(cause instanceof StrategyMutationUnknownError ? `Mutation outcome remains unknown. The same request ID ${cause.requestId} is still retained.` : cause instanceof Error ? cause.message : "Exact request replay failed; no different request was sent.");
    } finally { setBusy(undefined); }
  };

  const replayPendingGlobalKill = async () => {
    if (!pendingGlobalKill || !globalRecoveryRef.current || busy) return;
    const retained = pendingGlobalKill;
    const recovery = globalRecoveryRef.current;
    const operationGeneration = refreshGenerationRef.current;
    const ownerIsCurrent = () => operationGeneration === refreshGenerationRef.current && activeAccountRef.current === retained.account;
    setBusy("replay-global-kill"); setError(undefined);
    try {
      const next = await recovery();
      if (!ownerIsCurrent() || next.owner !== retained.account || next.network !== "testnet" || next.kill_switch.enabled !== retained.desiredEnabled) throw new Error("Global kill replay did not match the retained owner and state.");
      setGlobalKill(next.kill_switch); setGlobalKillError(undefined);
      retainPendingGlobalKill(undefined); globalRecoveryRef.current = undefined; proofRef.current = undefined;
    } catch (cause) {
      if (!ownerIsCurrent()) return;
      setError(cause instanceof StrategyMutationUnknownError ? `Global kill outcome remains unknown. The same request ID ${cause.requestId} is still retained.` : cause instanceof Error ? cause.message : "Exact global kill request replay failed; no different request was sent.");
    } finally { setBusy(undefined); }
  };

  if (context === undefined) return <Loading />;
  if (context.mode === "demo") return <StrategySignedOutDemo realModeStatus={context.realModeStatus} onCheckRealMode={() => void refresh()} />;
  const view = strategy ? toView(strategy, audit) : undefined;

  return <div className="min-w-0">
    <div className="border-b border-primary/25 bg-primary/[0.055] px-4 py-2.5 text-center font-mono text-[10px] font-medium uppercase tracking-wide text-foreground sm:px-6">XRPL Testnet · test funds only · deterministic rules · no expected-return claim</div>
    {view && screen === "status" ? <StrategyStatus strategy={view} /> : null}
    <div className="grid min-w-0 gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-5">
        {error ? <div role="alert" className="border border-blocked/35 bg-blocked/[0.06] px-4 py-3 text-sm text-blocked"><p>{error}</p>{pendingMutation || pendingGlobalKill ? <><p className="mt-2 break-all font-mono text-xs">Retained {pendingMutation?.action ?? "global kill"} request ID: {pendingMutation?.requestId ?? pendingGlobalKill?.requestId}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void refresh()} className="min-h-11 border border-blocked/40 px-3 text-sm">Check durable evidence</button>{pendingMutation && recoveryRef.current ? <button type="button" onClick={() => void replayPending()} className="min-h-11 border border-blocked/40 px-3 text-sm">Replay exact request ID</button> : null}{pendingGlobalKill && globalRecoveryRef.current ? <button type="button" onClick={() => void replayPendingGlobalKill()} className="min-h-11 border border-blocked/40 px-3 text-sm">Replay exact request ID</button> : null}</div></> : null}</div> : null}
        {screen === "draft" ? <StrategyDraftForm draft={draft} disabled={Boolean(busy || pendingMutation || pendingGlobalKill)} onChange={setDraft} onReview={(candidate) => void createDraft(candidate)} /> : null}
        {screen === "review" && strategy ? <MandateReview draft={fromMandate(strategy, draft)} digest={strategy.mandate.digest} version={strategy.mandate.version} busy={Boolean(busy)} blocked={Boolean(pendingMutation || pendingGlobalKill)} authorizationBlocked={globalKillError ? "Pilot cannot verify the account-wide global kill switch. Activation fails closed." : !globalKill ? "Pilot is verifying the account-wide global kill switch. Activation remains blocked." : globalKill.enabled ? "Account-wide global kill is enabled. Use the owner control to authorize submissions before activating this mandate." : undefined} onBack={() => setScreen("draft")} onApprove={() => void run("activate", async () => client.activate(await authorizeProof("activate")), mutationDescriptor("activate", strategy), (requestId) => { const retained = proofRef.current; if (!retained || retained.action !== "activate" || retained.proof.request_id !== requestId) throw new Error("The byte-identical activation proof is no longer in memory; check durable evidence instead."); return client.activate(retained.proof); })} /> : null}
        {view && screen === "status" ? <>{view.unresolvedTransaction ? <InflightWarning transaction={view.unresolvedTransaction} onRefresh={() => void refresh()} /> : null}<DecisionList decisions={view.decisions} /><AuditTrail events={view.audit} /></> : null}
      </div>
      <aside className="min-w-0 space-y-5">
        <GlobalKillControl account={context.account} killSwitch={globalKill} unavailableReason={globalKillError} hasMandate={Boolean(strategy)} busy={Boolean(busy)} blocked={Boolean(pendingMutation || pendingGlobalKill)} onEnable={() => void runGlobalKill("global-kill-enable", true, () => client.globalKillEnable(), (requestId) => client.globalKillEnable("Enabled by owner", requestId))} onClear={() => void runGlobalKill("global-kill-clear", false, async () => client.globalKillClear(await authorizeProof("clear_global_kill")), (requestId) => { const retained = proofRef.current; if (!retained || retained.action !== "clear_global_kill" || retained.proof.request_id !== requestId) throw new Error("The byte-identical global kill proof is no longer in memory; check durable status instead."); return client.globalKillClear(retained.proof); })} />
        {view && strategy && screen === "status" ? <StrategyControls strategy={view} busyAction={busy ?? (pendingMutation ? "outcome-unknown" : undefined)} resumeBlockedReason={view.lifecycle === "paused" ? pendingGlobalKill ? "A global-kill mutation has an unknown outcome. New authorization stays blocked; pause, stop, and emergency kill remain available." : globalKillError || !globalKill ? "Resume is blocked until Pilot can verify the account-wide global kill switch." : globalKill.enabled ? "Clear account-wide global kill with a fresh wallet proof before resuming." : undefined : undefined} onPause={() => void run("pause", () => client.pause(view.id), mutationDescriptor("pause", strategy), (requestId) => client.pause(view.id, "Paused by owner", requestId))} onResume={() => void run("resume", async () => client.resume(await authorizeProof("resume")), mutationDescriptor("resume", strategy), (requestId) => { const retained = proofRef.current; if (!retained || retained.action !== "resume" || retained.proof.request_id !== requestId) throw new Error("The byte-identical resume proof is no longer in memory; check durable evidence instead."); return client.resume(retained.proof); })} onStop={() => void run("stop", () => client.stop(view.id), mutationDescriptor("stop", strategy), (requestId) => client.stop(view.id, "Stopped by owner", requestId))} onKill={() => void run("kill", () => client.kill(view.id), mutationDescriptor("kill", strategy), (requestId) => client.kill(view.id, "Killed by owner", requestId))} /> : <SafetySummary />}
      </aside>
    </div>
  </div>;
}

function fromMandate(strategy: Strategy, fallback: StrategyDraft): StrategyDraft { return { ...fallback, account: strategy.mandate.account, issuedAsset: { label: "test-RLUSD", currency: strategy.mandate.issued_asset.currency, issuer: strategy.mandate.issued_asset.issuer }, targetXrpBps: String(strategy.mandate.allocation.target_xrp_bps), lowerXrpBps: String(strategy.mandate.allocation.lower_xrp_bps), upperXrpBps: String(strategy.mandate.allocation.upper_xrp_bps), maxOrderValue: strategy.mandate.limits.max_order_value, maxDailyValue: strategy.mandate.limits.max_daily_value, minOrderValue: strategy.mandate.limits.min_order_value, maxFeeDrops: strategy.mandate.limits.max_fee_drops, maxSlippageBps: String(strategy.mandate.limits.max_slippage_bps), maxPriceImpactBps: String(strategy.mandate.limits.max_price_impact_bps), minimumXrpReserveDrops: strategy.mandate.limits.min_xrp_reserve_drops, feeBufferDrops: strategy.mandate.limits.fee_buffer_drops, maxXrpExposureDrops: strategy.mandate.limits.max_xrp_exposure_drops, maxIssuedExposure: strategy.mandate.limits.max_issued_exposure, minimumLiquidityValue: strategy.mandate.limits.min_liquidity_value, cooldownSeconds: String(strategy.mandate.limits.cooldown_seconds), maxQuoteAgeSeconds: String(strategy.mandate.limits.max_quote_age_seconds), mandateExpiresAt: strategy.mandate.expires_at.slice(0, 16) }; }

function toView(strategy: Strategy, events: StrategyAuditEvent[]): StrategyView {
  const last = unresolvedSubmission(events);
  const heldDecisions = events.filter((event) => event.kind === "held").map((event) => { const codes = Array.isArray(event.detail.hold_codes) && event.detail.hold_codes.every((value) => typeof value === "string") ? event.detail.hold_codes.join(", ") : "unspecified"; return { id: event.decision_id ?? event.event_id, triggerId: event.trigger_id ?? "unknown", at: event.at, outcome: "hold" as const, explanation: `${typeof event.detail.explanation === "string" ? event.detail.explanation : "Strategy held without submitting."} Hold codes: ${codes}.` }; });
  const approvalDecisions = events.filter((event) => event.kind === "needs_approval").map((event) => ({ id: event.decision_id ?? event.event_id, triggerId: event.trigger_id ?? "unknown", at: event.at, outcome: "needs_approval" as const, explanation: typeof event.detail.next_action === "string" ? event.detail.next_action : "Complete the existing Harbor owner-approval workflow; Pilot will not sign for the owner.", ...(typeof event.detail.approval_id === "string" ? { approvalId: event.detail.approval_id } : {}) }));
  return { id: strategy.strategy_id, lifecycle: strategy.lifecycle, mandateVersion: strategy.mandate.version, mandateDigest: strategy.mandate.digest, account: strategy.mandate.account, issuedCurrency: strategy.mandate.issued_asset.currency, issuedIssuer: strategy.mandate.issued_asset.issuer, targetXrpBps: strategy.mandate.allocation.target_xrp_bps, lowerXrpBps: strategy.mandate.allocation.lower_xrp_bps, upperXrpBps: strategy.mandate.allocation.upper_xrp_bps, maxOrderValue: strategy.mandate.limits.max_order_value, maxDailyValue: strategy.mandate.limits.max_daily_value, maxFeeDrops: strategy.mandate.limits.max_fee_drops, maxSlippageBps: strategy.mandate.limits.max_slippage_bps, minimumXrpReserveDrops: strategy.mandate.limits.min_xrp_reserve_drops, feeBufferDrops: strategy.mandate.limits.fee_buffer_drops, cooldownSeconds: strategy.mandate.limits.cooldown_seconds, expiresAt: strategy.mandate.expires_at, lastEvaluationAt: strategy.last_evaluation_at, nextEvaluationAt: strategy.next_evaluation_at, schedulerEnabled: strategy.lifecycle === "active", unresolvedTransaction: last ? { state: last.kind === "needs_approval" ? "needs_approval" : last.kind === "submission_unknown" ? "unknown" : "submitted", hash: typeof last.detail.tx_hash === "string" ? last.detail.tx_hash : typeof last.detail.hash === "string" ? last.detail.hash : undefined, approvalId: typeof last.detail.approval_id === "string" ? last.detail.approval_id : undefined } : undefined, decisions: [...(strategy.hold_reason && heldDecisions.length === 0 ? [{ id: "latest", triggerId: "latest", at: strategy.last_evaluation_at ?? strategy.updated_at, outcome: "hold" as const, explanation: strategy.hold_reason }] : []), ...heldDecisions, ...approvalDecisions], audit: events.map(strategyAuditView) };
}
function mutationDescriptor(action: Exclude<PendingStrategyMutation["action"], "create">, strategy: Strategy): Omit<PendingStrategyMutation, "requestId"> { return { action, account: strategy.mandate.account, strategyId: strategy.strategy_id, expectedLifecycle: action === "pause" ? "paused" : action === "stop" || action === "kill" ? "stopped" : "active", baselineGeneration: strategy.generation, mandateVersion: strategy.mandate.version, mandateDigest: strategy.mandate.digest, startedAt: new Date().toISOString() }; }
function globalKillPendingStorageKey(account: string): string { return `pilot:strategy:global-kill-pending:${account}`; }
function parsePendingGlobalKill(raw: string | null, account: string): PendingGlobalKillMutation | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<PendingGlobalKillMutation>;
    if (value.version !== 1 || value.account !== account || typeof value.requestId !== "string" || value.requestId.length < 8 || typeof value.desiredEnabled !== "boolean" || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) return undefined;
    return value as PendingGlobalKillMutation;
  } catch { return undefined; }
}
function Loading() { return <div role="status" className="flex min-h-[20rem] items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />Loading owner-scoped Testnet strategy…</div>; }
function SafetySummary() { return <section className="border border-border bg-card p-4"><p className="label-mono flex items-center gap-2"><ShieldCheck className="size-3.5 text-executed" aria-hidden="true" />Activation boundary</p><ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground"><li>• Exact Testnet account, currency and issuer.</li><li>• Immutable, expiring, versioned wallet proof.</li><li>• No model-controlled permissions or limits.</li><li>• Fill-or-kill execution; uncertainty blocks follow-up orders.</li></ul></section>; }
