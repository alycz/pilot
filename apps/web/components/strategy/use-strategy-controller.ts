"use client";

import { createWallet } from "@pilot/wallet";
import type { Strategy, StrategyAuditEvent, StrategyKillSwitch } from "@pilot/contracts";
import { createStrategyClient, StrategyMutationUnknownError, type ScopedStrategyKillSwitch, type StrategyProofInput } from "@/lib/strategy-client";
import { loadPublicPilotConfig, loadWalletSessionStatus, WALLET_SESSION_CHANGED_EVENT } from "@/lib/harbor-browser";
import { configuredWalletMetadata, configuredWalletOptions } from "@/components/chat/configured-wallet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { defaultStrategyDraft, mutationOutcomeProven, parsePendingMutation, pendingMutationStorageKey, strategyAuditView, strategyCreateInput, unresolvedSubmission, type PendingStrategyMutation, type StrategyDraft, type StrategyView } from "./types";

/**
 * Owner-scoped strategy state and actions, shared by the strategy manager
 * panel, the chat strategy cards and the sidebar. Moved unchanged from the
 * former Strategy page so every surface uses one controller instance and the
 * exact same wallet-proof, pending-mutation and global-kill handling.
 */
export type StrategyClient = ReturnType<typeof createStrategyClient>;
export type StrategyScreen = "draft" | "review" | "status";
export type StrategyContext =
  | { mode: "demo"; realModeStatus: string }
  | { mode: "real"; account: string };
type PendingGlobalKillMutation = {
  version: 1;
  account: string;
  requestId: string;
  desiredEnabled: boolean;
  startedAt: string;
};

export function useStrategyController(injectedClient?: StrategyClient) {
  const client = useMemo(() => injectedClient ?? createStrategyClient(), [injectedClient]);
  const [draft, setDraft] = useState(() => defaultStrategyDraft());
  const [screen, setScreen] = useState<StrategyScreen>("draft");
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

  /** Same create path as the form; resolves to the created draft so a chat card can bind to it exactly. */
  const createFromProposal = async (input: Record<string, unknown> & { expires_at: string }): Promise<Strategy | undefined> => {
    if (context?.mode !== "real") return undefined;
    let created: Strategy | undefined;
    const capture = (strategy: Strategy) => { created = strategy; return strategy; };
    await run("create", () => client.create(input).then(capture), { action: "create", account: context.account, expectedLifecycle: "draft", expectedExpiresAt: input.expires_at, startedAt: new Date().toISOString() }, (requestId) => client.create(input, requestId).then(capture));
    return created;
  };
  const approve = () => {
    if (!strategy) return Promise.resolve();
    return run("activate", async () => client.activate(await authorizeProof("activate")), mutationDescriptor("activate", strategy), (requestId) => { const retained = proofRef.current; if (!retained || retained.action !== "activate" || retained.proof.request_id !== requestId) throw new Error("The byte-identical activation proof is no longer in memory; check durable evidence instead."); return client.activate(retained.proof); });
  };
  const reject = () => {
    if (!strategy) return Promise.resolve();
    return run("stop", () => client.stop(strategy.strategy_id, "Draft rejected by owner"), mutationDescriptor("stop", strategy), (requestId) => client.stop(strategy.strategy_id, "Draft rejected by owner", requestId));
  };
  const pause = () => {
    if (!strategy) return Promise.resolve();
    return run("pause", () => client.pause(strategy.strategy_id), mutationDescriptor("pause", strategy), (requestId) => client.pause(strategy.strategy_id, "Paused by owner", requestId));
  };
  const resume = () => {
    if (!strategy) return Promise.resolve();
    return run("resume", async () => client.resume(await authorizeProof("resume")), mutationDescriptor("resume", strategy), (requestId) => { const retained = proofRef.current; if (!retained || retained.action !== "resume" || retained.proof.request_id !== requestId) throw new Error("The byte-identical resume proof is no longer in memory; check durable evidence instead."); return client.resume(retained.proof); });
  };
  const stop = () => {
    if (!strategy) return Promise.resolve();
    return run("stop", () => client.stop(strategy.strategy_id), mutationDescriptor("stop", strategy), (requestId) => client.stop(strategy.strategy_id, "Stopped by owner", requestId));
  };
  const kill = () => {
    if (!strategy) return Promise.resolve();
    return run("kill", () => client.kill(strategy.strategy_id), mutationDescriptor("kill", strategy), (requestId) => client.kill(strategy.strategy_id, "Killed by owner", requestId));
  };
  const enableGlobalKill = () => runGlobalKill("global-kill-enable", true, () => client.globalKillEnable(), (requestId) => client.globalKillEnable("Enabled by owner", requestId));
  const clearGlobalKill = () => runGlobalKill("global-kill-clear", false, async () => client.globalKillClear(await authorizeProof("clear_global_kill")), (requestId) => { const retained = proofRef.current; if (!retained || retained.action !== "clear_global_kill" || retained.proof.request_id !== requestId) throw new Error("The byte-identical global kill proof is no longer in memory; check durable status instead."); return client.globalKillClear(retained.proof); });

  const authorizationBlocked = globalKillError ? "Pilot cannot verify the account-wide global kill switch. Activation fails closed." : !globalKill ? "Pilot is verifying the account-wide global kill switch. Activation remains blocked." : globalKill.enabled ? "Account-wide global kill is enabled. Use the owner control to authorize submissions before activating this mandate." : undefined;
  const view = strategy ? toView(strategy, audit) : undefined;
  const resumeBlockedReason = view?.lifecycle === "paused" ? pendingGlobalKill ? "A global-kill mutation has an unknown outcome. New authorization stays blocked; pause, stop, and emergency kill remain available." : globalKillError || !globalKill ? "Resume is blocked until Pilot can verify the account-wide global kill switch." : globalKill.enabled ? "Clear account-wide global kill with a fresh wallet proof before resuming." : undefined : undefined;
  const blocked = Boolean(pendingMutation || pendingGlobalKill);

  return {
    client, context, draft, setDraft, screen, setScreen, strategy, audit, view, busy, error,
    pendingMutation, pendingGlobalKill, globalKill, globalKillError, blocked,
    authorizationBlocked, resumeBlockedReason,
    canReplayPending: Boolean(pendingMutation && recoveryRef.current),
    canReplayPendingGlobalKill: Boolean(pendingGlobalKill && globalRecoveryRef.current),
    refresh, createDraft, createFromProposal, approve, reject, pause, resume, stop, kill,
    enableGlobalKill, clearGlobalKill, replayPending, replayPendingGlobalKill,
  };
}

export type StrategyController = ReturnType<typeof useStrategyController>;

type WireRule = { rule_id: string; all: Array<Record<string, unknown>>; action: Record<string, unknown> };
type WireMandate = {
  kind: "xrp_issued_rebalancer_v1" | "declarative_strategy_v1";
  account: string;
  issued_asset: { currency: string; issuer: string };
  version: number;
  digest: string;
  expires_at: string;
  allocation?: { target_xrp_bps: number; lower_xrp_bps: number; upper_xrp_bps: number };
  plan?: { trigger: { interval_seconds: number }; rules: WireRule[] };
  limits: Strategy["mandate"]["limits"] & {
    max_cumulative_value?: string; max_daily_fee_drops?: string; max_cumulative_fee_drops?: string;
    max_daily_trades?: number; max_total_trades?: number; max_mandate_occurrences?: number;
  };
};

export function fromMandate(strategy: Strategy, fallback: StrategyDraft): StrategyDraft {
  const mandate = strategy.mandate as WireMandate;
  const declarativeRules = mandate.plan?.rules.map((rule) => {
    const condition = rule.all[0] ?? {};
    const action = rule.action;
    const actionKind = action.kind;
    const direction = action.direction;
    const kind = actionKind === "target_allocation" ? "rebalance" : condition.kind === "price_threshold"
      ? direction === "sell_xrp" ? "price_sell" : "price_buy" : "scheduled_buy";
    return {
      id: rule.rule_id,
      kind,
      price: typeof condition.price === "string" ? condition.price : "1",
      fixedValue: typeof action.order_value === "string" ? action.order_value : "10",
      lowerXrpBps: String(action.lower_xrp_bps ?? condition.lower_xrp_bps ?? 4500),
      targetXrpBps: String(action.target_xrp_bps ?? 5000),
      upperXrpBps: String(action.upper_xrp_bps ?? condition.upper_xrp_bps ?? 5500),
    } as const;
  });
  return {
    ...fallback,
    strategyMode: mandate.kind === "declarative_strategy_v1" ? "declarative" : "legacy_rebalancer",
    account: mandate.account,
    issuedAsset: { label: "test-RLUSD", currency: mandate.issued_asset.currency, issuer: mandate.issued_asset.issuer },
    targetXrpBps: String(mandate.allocation?.target_xrp_bps ?? 5000),
    lowerXrpBps: String(mandate.allocation?.lower_xrp_bps ?? 4500),
    upperXrpBps: String(mandate.allocation?.upper_xrp_bps ?? 5500),
    maxOrderValue: mandate.limits.max_order_value,
    maxDailyValue: mandate.limits.max_daily_value,
    minOrderValue: mandate.limits.min_order_value,
    maxFeeDrops: mandate.limits.max_fee_drops,
    maxSlippageBps: String(mandate.limits.max_slippage_bps),
    maxPriceImpactBps: String(mandate.limits.max_price_impact_bps),
    minimumXrpReserveDrops: mandate.limits.min_xrp_reserve_drops,
    feeBufferDrops: mandate.limits.fee_buffer_drops,
    maxXrpExposureDrops: mandate.limits.max_xrp_exposure_drops,
    maxIssuedExposure: mandate.limits.max_issued_exposure,
    minimumLiquidityValue: mandate.limits.min_liquidity_value,
    cooldownSeconds: String(mandate.limits.cooldown_seconds),
    maxQuoteAgeSeconds: String(mandate.limits.max_quote_age_seconds),
    mandateExpiresAt: mandate.expires_at.slice(0, 16),
    declarative: {
      ...fallback.declarative,
      intervalSeconds: String(mandate.plan?.trigger.interval_seconds ?? fallback.declarative.intervalSeconds),
      rules: declarativeRules?.length ? declarativeRules : fallback.declarative.rules,
      maxDailyTrades: String(mandate.limits.max_daily_trades ?? fallback.declarative.maxDailyTrades),
      maxTotalTrades: String(mandate.limits.max_total_trades ?? fallback.declarative.maxTotalTrades),
      maxMandateOccurrences: String(mandate.limits.max_mandate_occurrences ?? fallback.declarative.maxMandateOccurrences),
      maxCumulativeValue: mandate.limits.max_cumulative_value ?? fallback.declarative.maxCumulativeValue,
      maxDailyFeeDrops: mandate.limits.max_daily_fee_drops ?? fallback.declarative.maxDailyFeeDrops,
      maxCumulativeFeeDrops: mandate.limits.max_cumulative_fee_drops ?? fallback.declarative.maxCumulativeFeeDrops,
    },
  };
}

export function toView(strategy: Strategy, events: StrategyAuditEvent[]): StrategyView {
  const mandate = strategy.mandate as WireMandate;
  const allocation = mandate.allocation ?? (mandate.plan?.rules.map((rule) => rule.action).find((action) => action.kind === "target_allocation") as { target_xrp_bps?: number; lower_xrp_bps?: number; upper_xrp_bps?: number } | undefined);
  const declarativeSummary = mandate.kind === "declarative_strategy_v1" && mandate.plan
    ? `${mandate.plan.rules.length} ordered rule${mandate.plan.rules.length === 1 ? "" : "s"}; first match may plan one order per evaluation.` : undefined;
  const last = unresolvedSubmission(events);
  const heldDecisions = events.filter((event) => event.kind === "held").map((event) => { const codes = Array.isArray(event.detail.hold_codes) && event.detail.hold_codes.every((value) => typeof value === "string") ? event.detail.hold_codes.join(", ") : "unspecified"; return { id: event.decision_id ?? event.event_id, triggerId: event.trigger_id ?? "unknown", at: event.at, outcome: "hold" as const, explanation: `${typeof event.detail.explanation === "string" ? event.detail.explanation : "Strategy held without submitting."} Hold codes: ${codes}.` }; });
  const approvalDecisions = events.filter((event) => event.kind === "needs_approval").map((event) => ({ id: event.decision_id ?? event.event_id, triggerId: event.trigger_id ?? "unknown", at: event.at, outcome: "needs_approval" as const, explanation: typeof event.detail.next_action === "string" ? event.detail.next_action : "Complete the existing Harbor owner-approval workflow; Pilot will not sign for the owner.", ...(typeof event.detail.approval_id === "string" ? { approvalId: event.detail.approval_id } : {}) }));
  return { id: strategy.strategy_id, strategyKind: mandate.kind, strategyLabel: mandate.kind === "declarative_strategy_v1" ? "Bounded declarative strategy" : undefined, strategySummary: declarativeSummary, evaluationIntervalSeconds: mandate.plan?.trigger.interval_seconds ?? 300, maxMandateOccurrences: mandate.limits.max_mandate_occurrences, lifecycle: strategy.lifecycle, mandateVersion: mandate.version, mandateDigest: mandate.digest, account: mandate.account, issuedCurrency: mandate.issued_asset.currency, issuedIssuer: mandate.issued_asset.issuer, targetXrpBps: allocation?.target_xrp_bps ?? 5000, lowerXrpBps: allocation?.lower_xrp_bps ?? 4500, upperXrpBps: allocation?.upper_xrp_bps ?? 5500, maxOrderValue: mandate.limits.max_order_value, maxDailyValue: mandate.limits.max_daily_value, maxFeeDrops: mandate.limits.max_fee_drops, maxSlippageBps: mandate.limits.max_slippage_bps, minimumXrpReserveDrops: mandate.limits.min_xrp_reserve_drops, feeBufferDrops: mandate.limits.fee_buffer_drops, cooldownSeconds: mandate.limits.cooldown_seconds, expiresAt: mandate.expires_at, lastEvaluationAt: strategy.last_evaluation_at, nextEvaluationAt: strategy.next_evaluation_at, schedulerEnabled: strategy.lifecycle === "active", unresolvedTransaction: last ? { state: last.kind === "needs_approval" ? "needs_approval" : last.kind === "submission_unknown" ? "unknown" : "submitted", hash: typeof last.detail.tx_hash === "string" ? last.detail.tx_hash : typeof last.detail.hash === "string" ? last.detail.hash : undefined, approvalId: typeof last.detail.approval_id === "string" ? last.detail.approval_id : undefined } : undefined, decisions: [...(strategy.hold_reason && heldDecisions.length === 0 ? [{ id: "latest", triggerId: "latest", at: strategy.last_evaluation_at ?? strategy.updated_at, outcome: "hold" as const, explanation: strategy.hold_reason }] : []), ...heldDecisions, ...approvalDecisions], audit: events.map(strategyAuditView) };
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
