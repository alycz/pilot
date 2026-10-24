"use client";

import type { GuardrailNotice } from "@pilot/agent/guardrail-notice";
import type { CardEvent } from "@pilot/contracts";
import type { X402PaymentEvent } from "@pilot/agent";
import { toBuild } from "@pilot/intents";
import {
  createWallet,
  ledgerSigningMode,
  type LedgerDeviceState,
  type PilotWallet,
} from "@pilot/wallet";
import { ArrowLeftRight, ArrowUp, BarChart3, Bot, FlaskConical, Info, Landmark, type LucideIcon, RotateCcw, Scale, ShieldAlert, Square, UserRound, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  ApprovalModal,
  isApprovalExpired,
  signOnlyAfterPreflight,
  type ApprovalRequest,
  type ApprovalSubmission,
} from "@/components/approval/approval-modal";
import { normalizeIssuedCurrencyCodes } from "@/components/approval/normalize-transaction";
import { IntentCard, type LedgerOwnerSigner } from "@/components/cards";
import { DeviceStatus } from "@/components/ledger/device-status";
import { SHELL_SIDEBAR_FOOTER_SLOT_ID } from "@/components/shell";
import {
  createChatWalletActionProof,
  createBrowserHarborClient,
  loadPublicPilotConfig,
  loadWalletSessionStatus,
  type PublicPilotConfig,
  type WalletSessionStatus,
} from "@/lib/harbor-browser";
import { DemoApprovalDialog } from "./demo-approval-dialog";
import { DemoBlocks } from "./demo-blocks";
import {
  DEMO_SUGGESTIONS,
  buildDemoTimeline,
  playDemoTimeline,
  routeDemoPrompt,
  simulatedOwnerSignature,
  type DemoBlock,
  type DemoScenarioId,
} from "./demo-script";
import { CardStatesDialog } from "./card-states-dialog";
import { DemoBanner } from "./chat-notice";
import {
  configuredWalletMetadata,
  configuredWalletOptions,
  ledgerDeviceReady,
  ledgerRebuildIdempotencyKey,
  type ConfiguredWalletMetadata,
} from "./configured-wallet";
import { PreferenceCard, preferenceProposalRenderKey } from "./preference-card";
import { chatSessionUi, chatWalletActionProofRequired } from "./session-state";
import { GuardrailBanner } from "./guardrail-banner";
import { executeFreshLedgerBuild } from "./ledger-approval";
import { QuickNodeFreezeBanner } from "./quicknode-freeze-banner";
import {
  consumePilotStream,
  quickNodeTestnetAccount,
  type PreferenceProposalEvent,
  type QuickNodeFreezeNotice,
} from "./stream-parts";
import { fixtureQuickNodeFreezeNotice } from "../../app/chat/fixtures";
import { bindApprovalTransaction } from "./approval-binding";
import { X402ResultCard } from "./x402-result-card";
import {
  X402_APPROVED_RECEIVER,
  X402_MAX_PRICE_DROPS,
  completeX402Operation,
  loadPendingX402Operation,
  markX402OperationJournalPending,
  markX402OperationRecovering,
  withLockedX402OperationDispatch,
  type PendingX402Operation,
  type PublicOperationLockManager,
  type X402OperationScope,
} from "./x402-operation-state";

const MOCK_X402_OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const X402_RECOVERY_PROMPT = "Retry the pending local Testnet premium comparison operation.";
const LEDGER_IDLE_STATE: LedgerDeviceState = Object.freeze({ interaction: "none", busy: false });

type ChatTurn = {
  id: string;
  prompt: string;
  response: string;
  event?: CardEvent;
  events?: CardEvent[];
  guardrailNotices?: GuardrailNotice[];
  quickNodeFreezeNotice?: QuickNodeFreezeNotice;
  preferences?: PreferenceProposalEvent[];
  operationId?: string;
  x402?: X402PaymentEvent;
  streaming?: boolean;
  source?: "api" | "fixture" | "demo";
  /** Demo-only structured reply parts (tables, stats, links). */
  blocks?: DemoBlock[];
  /** Demo-only "what the agent is doing" line while it thinks. */
  status?: string;
  /** Demo-only closing line shown after the card sequence. */
  followUp?: string;
};

const suggestions = [
  "Swap 80 RLUSD for XRP, max 1% slippage",
  "Deposit 100 XRP into the vault",
  "Why would FREEMONEY be blocked?",
];

const suggestionIcons = [
  { icon: ArrowLeftRight, tone: "text-executed" },
  { icon: Landmark, tone: "text-info" },
  { icon: ShieldAlert, tone: "text-approval" },
] as const;

const demoSuggestionIcons: Record<DemoScenarioId, { icon: LucideIcon; tone: string }> = {
  swap: { icon: ArrowLeftRight, tone: "text-executed" },
  vault: { icon: Landmark, tone: "text-info" },
  blocked: { icon: ShieldAlert, tone: "text-approval" },
  compare: { icon: Scale, tone: "text-chart-4" },
  limits: { icon: BarChart3, tone: "text-muted-foreground" },
  portfolio: { icon: Wallet, tone: "text-muted-foreground" },
  fallback: { icon: Bot, tone: "text-muted-foreground" },
};

const demoOpeningResponse =
  "This is a simulated demo. Pick a prompt below or type your own and I’ll walk through the same plan → simulate → policy → approve flow Pilot runs on Testnet. Nothing here touches a wallet or the ledger.";

const openingTurn: ChatTurn = {
  id: "opening",
  prompt: "What can Pilot do?",
  response: "Ask for an XRPL action and I’ll stream the live Harbor build, policy, execution, and validation states here.",
  source: "api",
};

export function ChatView() {
  const harbor = useMemo(() => createBrowserHarborClient(), []);
  const [publicConfig, setPublicConfig] = useState<PublicPilotConfig | null>();
  const [walletSession, setWalletSession] = useState<WalletSessionStatus | null>();
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([openingTurn]);
  const [running, setRunning] = useState(false);
  const [lastPrompt, setLastPrompt] = useState(openingTurn.prompt);
  const [approvalEvent, setApprovalEvent] = useState<CardEvent>();
  const [approvalWallet, setApprovalWallet] = useState<PilotWallet>();
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest>();
  const [approvalError, setApprovalError] = useState<string>();
  const [configuredWallet, setConfiguredWallet] = useState<ConfiguredWalletMetadata>();
  const [ledgerPreparedIntents, setLedgerPreparedIntents] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [ledgerDeviceState, setLedgerDeviceState] = useState<LedgerDeviceState>(LEDGER_IDLE_STATE);
  const [ownerSigners, setOwnerSigners] = useState<ReadonlyMap<string, LedgerOwnerSigner>>(
    () => new Map(),
  );
  const [copied, setCopied] = useState(false);
  const [pendingX402, setPendingX402] = useState<PendingX402Operation>();
  const [x402RecoveryError, setX402RecoveryError] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const pendingX402Ref = useRef<PendingX402Operation | undefined>(undefined);
  const x402ScopeRef = useRef<X402OperationScope | undefined>(undefined);
  const x402DispatchedRef = useRef(false);
  const preparedWalletsRef = useRef(new Map<string, PilotWallet>());
  const ledgerDeviceUnsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const runRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void loadPublicPilotConfig(globalThis.fetch, controller.signal)
      .then((config) => { if (active) setPublicConfig(config); })
      .catch(() => { if (active) setPublicConfig(null); });
    void loadWalletSessionStatus(globalThis.fetch, controller.signal)
      .then((session) => { if (active) setWalletSession(session); })
      .catch(() => { if (active) setWalletSession(null); });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!publicConfig) {
      setConfiguredWallet(undefined);
      return;
    }
    try {
      const configured = configuredWalletMetadata(
        sessionStorage.getItem("pilot:wallet"),
        publicConfig,
      );
      setConfiguredWallet(configured);
    } catch {
      setConfiguredWallet(undefined);
    }
  }, [publicConfig, walletSession]);

  useEffect(() => () => ledgerDeviceUnsubscribeRef.current?.(), []);

  const [sidebarSlot, setSidebarSlot] = useState<HTMLElement | null>(null);
  const [cardStatesOpen, setCardStatesOpen] = useState(false);
  const closeCardStates = useCallback(() => setCardStatesOpen(false), []);
  useEffect(() => {
    setSidebarSlot(document.getElementById(SHELL_SIDEBAR_FOOTER_SLOT_ID));
  }, []);
  const sessionUi = chatSessionUi(publicConfig, walletSession);
  const walletReady = sessionUi.ready;
  const x402Scope = useMemo<X402OperationScope | undefined>(() => {
    if (publicConfig?.network !== "testnet") return undefined;
    const owner = publicConfig.mockMode
      ? MOCK_X402_OWNER
      : walletSession?.authenticated && walletSession.network === "testnet"
        ? walletSession.account
        : undefined;
    return owner ? {
      owner,
      network: "testnet",
      resource: "compare",
      max_price_drops: X402_MAX_PRICE_DROPS,
      receiver: X402_APPROVED_RECEIVER,
    } : undefined;
  }, [publicConfig, walletSession]);

  useEffect(() => {
    x402ScopeRef.current = x402Scope;
    if (!x402Scope) {
      pendingX402Ref.current = undefined;
      setPendingX402(undefined);
      return;
    }
    try {
      const restored = loadPendingX402Operation(localStorage, x402Scope);
      pendingX402Ref.current = restored;
      setPendingX402(restored);
      setX402RecoveryError(undefined);
    } catch (cause) {
      pendingX402Ref.current = undefined;
      setPendingX402(undefined);
      setX402RecoveryError(cause instanceof Error ? cause.message : "The x402 recovery record is invalid.");
    }
  }, [x402Scope]);
  // Visitors without a usable wallet session get a fully local, scripted demo.
  // The live path below is unchanged and only runs when `walletReady`.
  const demoMode = !walletReady && sessionUi.notice !== null;
  const [reducedMotion, setReducedMotion] = useState(false);
  const [demoApproval, setDemoApproval] = useState<{ event: CardEvent; seed: number }>();
  const demoSeqRef = useRef(0);
  const demoTimersRef = useRef<number[]>([]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const interrupt = useCallback((announce = true) => {
    runRef.current += 1;
    demoTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    demoTimersRef.current = [];
    abortRef.current?.abort();
    abortRef.current = undefined;
    setRunning(false);
    const pending = pendingX402Ref.current;
    const scope = x402ScopeRef.current;
    const dispatched = x402DispatchedRef.current;
    if (pending && scope && dispatched) {
      try {
        const recovering = markX402OperationRecovering(localStorage, scope, pending.operation_id);
        pendingX402Ref.current = recovering;
        if (announce) setPendingX402(recovering);
      } catch {
        // Preserve the existing durable record and fail closed on the next retry.
      }
    }
    if (announce) {
      setTurns((current) => current.map((turn) => turn.streaming ? {
        ...turn,
        streaming: false,
        response: turn.operationId && pending?.operation_id === turn.operationId
          ? dispatched
            ? "The stream stopped after x402 dispatch. Settlement may still complete; recovery will reuse the same operation identity."
            : "The x402 request stopped before dispatch. Its reserved operation identity will be reused."
          : turn.response || "Stopped before any transaction tool completed.",
      } : turn));
    }
  }, []);

  useEffect(() => {
    const onPopState = () => interrupt(false);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      interrupt(false);
    };
  }, [interrupt]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: running ? "smooth" : "auto", block: "nearest" });
  }, [running, turns]);

  // Demo turns grow in small steps; keep the newest content above the fixed composer.
  useEffect(() => {
    if (!demoMode || turns.length <= 1) return;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: running && !reducedMotion ? "smooth" : "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [demoMode, reducedMotion, running, turns]);

  const updateTurn = useCallback((id: string, patch: Partial<ChatTurn>) => {
    setTurns((current) => current.map((turn) => turn.id === id ? { ...turn, ...patch } : turn));
  }, []);

  const closeApproval = useCallback(() => {
    if (approvalEvent) {
      preparedWalletsRef.current.delete(approvalEvent.intent_id);
      setLedgerPreparedIntents((current) => {
        const next = new Set(current);
        next.delete(approvalEvent.intent_id);
        return next;
      });
    }
    ledgerDeviceUnsubscribeRef.current?.();
    ledgerDeviceUnsubscribeRef.current = undefined;
    setLedgerDeviceState(LEDGER_IDLE_STATE);
    setApprovalEvent(undefined);
    setApprovalRequest(undefined);
    if (approvalWallet) void approvalWallet.disconnect();
    setApprovalWallet(undefined);
  }, [approvalEvent, approvalWallet]);

  const connectConfiguredWallet = useCallback(async (
    network: CardEvent["intent"]["network"],
    observeLedger = false,
  ) => {
    if (network === "mainnet") throw new Error("Mainnet signing is disabled in this sprint.");
    if (!publicConfig || publicConfig.network !== network) {
      throw new Error("Wait for the public test-network configuration before connecting.");
    }
    const configured = configuredWalletMetadata(sessionStorage.getItem("pilot:wallet"), publicConfig);
    const provider = configured.provider;
    const expectedAccount = configured.account;
    const nextWallet = createWallet(configuredWalletOptions(configured, network));
    if (observeLedger && provider === "ledger") {
      ledgerDeviceUnsubscribeRef.current?.();
      setLedgerDeviceState(LEDGER_IDLE_STATE);
      ledgerDeviceUnsubscribeRef.current = nextWallet.onDeviceState?.(setLedgerDeviceState);
    }
    let account: string;
    try {
      account = await nextWallet.connect();
    } catch (cause) {
      await nextWallet.disconnect().catch(() => undefined);
      if (observeLedger) {
        ledgerDeviceUnsubscribeRef.current?.();
        ledgerDeviceUnsubscribeRef.current = undefined;
        setLedgerDeviceState(LEDGER_IDLE_STATE);
      }
      throw cause;
    }
    if (expectedAccount && account !== expectedAccount) {
      await nextWallet.disconnect();
      if (observeLedger) {
        ledgerDeviceUnsubscribeRef.current?.();
        ledgerDeviceUnsubscribeRef.current = undefined;
        setLedgerDeviceState(LEDGER_IDLE_STATE);
      }
      throw new Error("The connected wallet account changed. Reconnect it before approving this transaction.");
    }
    setConfiguredWallet(configured);
    return { wallet: nextWallet, account, configured };
  }, [publicConfig]);

  const prepareFreshApproval = useCallback(async (
    event: CardEvent,
    nextWallet: PilotWallet,
    account: string,
  ) => {
    if (event.state !== "awaiting_approval") return event;
    const common = { account, network: event.intent.network, intent_id: event.intent_id };
    let build;
    switch (event.intent.kind) {
        case "swap":
          build = await harbor.op("tx.swap", { ...common, sell: event.intent.sell, buy: event.intent.buy, amount: event.intent.amount, side: event.intent.side, max_slippage_bps: event.intent.max_slippage_bps });
          break;
        case "limit":
          build = await harbor.op("tx.offer", { ...common, sell: event.intent.sell, buy: event.intent.buy, sell_amount: event.intent.sell_amount, buy_amount: event.intent.buy_amount, ...(event.intent.expires_at ? { expires_at: event.intent.expires_at } : {}) });
          break;
        case "cancel":
          build = await harbor.op("tx.offerCancel", { ...common, offer_sequence: event.intent.offer_sequence });
          break;
        case "lp_deposit":
          {
            const request = toBuild(event.intent, {
              main_account: account,
              budget_account: account,
            });
            if (request.op !== "tx.ammDeposit") throw new Error("Pilot produced the wrong LP deposit builder.");
            build = await harbor.op(request.op, request.args);
          }
          break;
        case "lp_withdraw":
          {
            const request = toBuild(event.intent, {
              main_account: account,
              budget_account: account,
            });
            if (request.op !== "tx.ammWithdraw") throw new Error("Pilot produced the wrong LP withdrawal builder.");
            build = await harbor.op(request.op, request.args);
          }
          break;
        case "vault_deposit":
          {
            const request = toBuild(event.intent, {
              main_account: account,
              budget_account: account,
            });
            if (request.op !== "tx.vaultDeposit") throw new Error("Pilot produced the wrong vault deposit builder.");
            build = await harbor.op(request.op, request.args);
          }
          break;
        case "pay":
          build = await harbor.op("tx.payment", { ...common, to: event.intent.to, asset: event.intent.asset, amount: event.intent.amount, ...(event.intent.memo ? { memo: event.intent.memo } : {}) });
          break;
        case "fund_budget":
          throw new Error("Budget funding requires the separate main-account payment flow.");
        case "x402_call":
          throw new Error("x402 calls do not produce an owner-signable XRPL transaction.");
        case "ap4m_purchase":
          throw new Error(
            "AP4M purchases become available after the dedicated agent-tool integration is installed.",
          );
    }
    if (!build.ok) throw new Error(build.error.message);
    const execute = await executeFreshLedgerBuild({
        deviceReady: ledgerDeviceReady(
          ledgerPreparedIntents.has(event.intent_id),
          ledgerDeviceState,
        ),
        priorBuildId: event.build?.build_id,
        freshBuildId: build.data.build_id,
        createIdempotencyKey: ledgerRebuildIdempotencyKey,
        execute: (buildId, idempotencyKey) => harbor.op("tx.execute", {
          build_id: buildId,
          idempotency_key: idempotencyKey,
        }),
    });
    if (!execute.ok) throw new Error(execute.error.message);
    if (execute.data.status !== "needs_approval") {
      throw new Error(execute.data.status === "blocked" ? "Policy blocked this action before signing." : "This action does not require owner approval.");
    }
    const normalizedBuild = { ...build.data, tx_json: normalizeIssuedCurrencyCodes(build.data.tx_json) };
    const normalizedExec = { ...execute.data, tx_json: normalizeIssuedCurrencyCodes(execute.data.tx_json) };
    preparedWalletsRef.current.set(event.intent_id, nextWallet);
    return { ...event, build: normalizedBuild, exec: normalizedExec, policy: normalizedExec.policy };
  }, [harbor, ledgerDeviceState, ledgerPreparedIntents]);

  const openApproval = useCallback(async (event: CardEvent, preparedWallet?: PilotWallet) => {
    setApprovalError(undefined);
    if (event.intent.network === "mainnet") {
      setApprovalError("Mainnet signing is disabled in this sprint. Choose testnet or devnet and build a fresh transaction.");
      return;
    }
    let nextWallet = preparedWallet ?? preparedWalletsRef.current.get(event.intent_id);
    try {
      if (approvalWallet && approvalWallet !== nextWallet) await approvalWallet.disconnect();
      if (!nextWallet) ({ wallet: nextWallet } = await connectConfiguredWallet(event.intent.network));
      const approval = event.exec?.status === "needs_approval" ? event.exec : undefined;
      if (!approval) throw new Error("This card does not contain a signable Harbor approval.");
      const account = approval.tx_json.Account;
      if (typeof account !== "string" || account !== nextWallet.address()) {
        throw new Error("This approval belongs to a different wallet account. Build a fresh transaction after reconnecting.");
      }
      const ledger = await harbor.op("ledger.account.info", {
        account,
        network: event.intent.network,
        ledger_index: "validated",
      });
      const sequence = ledger.ok ? ledger.data.account_data.Sequence : undefined;
      if (!ledger.ok || ledger.data.validated !== true || !Number.isSafeInteger(ledger.data.ledger_index) ||
          !Number.isSafeInteger(sequence)) {
        throw new Error(ledger.ok ? "Harbor did not return a validated ledger for approval checks." : ledger.error.message);
      }
      const boundRequest = bindApprovalTransaction(event, account, ledger.data.ledger_index!, Number(sequence));
      ledgerDeviceUnsubscribeRef.current?.();
      ledgerDeviceUnsubscribeRef.current = nextWallet.onDeviceState?.(setLedgerDeviceState);
      setApprovalWallet(nextWallet);
      setApprovalRequest(boundRequest);
      setApprovalEvent(event);
    } catch (cause) {
      if (nextWallet) {
        preparedWalletsRef.current.delete(event.intent_id);
        setLedgerPreparedIntents((current) => {
          const next = new Set(current);
          next.delete(event.intent_id);
          return next;
        });
        await nextWallet.disconnect();
      }
      setApprovalError(cause instanceof Error ? cause.message : "The approval could not be prepared.");
    }
  }, [approvalWallet, connectConfiguredWallet, harbor]);

  const prepareLedger = useCallback(async (event: CardEvent) => {
    setApprovalError(undefined);
    let nextWallet = preparedWalletsRef.current.get(event.intent_id);
    try {
      if (!nextWallet) {
        const connected = await connectConfiguredWallet(event.intent.network, true);
        if (connected.configured.provider !== "ledger" || connected.wallet.custody !== "hardware") {
          await connected.wallet.disconnect();
          throw new Error("Reconnect the Ledger configured for this Pilot session.");
        }
        nextWallet = connected.wallet;
      }
      preparedWalletsRef.current.set(event.intent_id, nextWallet);
      setLedgerPreparedIntents((current) => new Set(current).add(event.intent_id));
    } catch (cause) {
      if (nextWallet) await nextWallet.disconnect();
      preparedWalletsRef.current.delete(event.intent_id);
      setApprovalError(cause instanceof Error ? cause.message : "The Ledger could not be prepared.");
    }
  }, [connectConfiguredWallet]);

  const openLedgerApproval = useCallback(async (event: CardEvent) => {
    const nextWallet = preparedWalletsRef.current.get(event.intent_id);
    if (!nextWallet || !ledgerPreparedIntents.has(event.intent_id)) {
      await prepareLedger(event);
      return;
    }
    try {
      if (!ledgerDeviceReady(true, ledgerDeviceState)) {
        throw new Error("Open the XRP app and wait until the Ledger is ready before building the approval.");
      }
      const approval = await prepareFreshApproval(event, nextWallet, nextWallet.address());
      setTurns((current) => current.map((turn) => ({
        ...turn,
        event: turn.event?.intent_id === event.intent_id ? approval : turn.event,
        events: turn.events?.map((candidate) => candidate.intent_id === event.intent_id ? approval : candidate),
      })));
      await openApproval(approval, nextWallet);
    } catch (cause) {
      setApprovalError(cause instanceof Error ? cause.message : "A fresh Ledger approval could not be prepared.");
    }
  }, [ledgerDeviceState, ledgerPreparedIntents, openApproval, prepareFreshApproval, prepareLedger]);

  const submitApprovalBlob = useCallback(async (
    event: CardEvent,
    txBlob: string,
    approvalId?: string,
  ): Promise<ApprovalSubmission> => {
    const network = event.intent.network;
    if (network !== "testnet" && network !== "devnet") {
      throw new Error("Owner submission is limited to Testnet and Devnet.");
    }
    const result = await harbor.op("tx.submit", {
      tx_blob: txBlob,
      network,
      ...(approvalId ? { approval_id: approvalId } : {}),
    });
    if (!result.ok) throw new Error(result.error.message);
    if ("status" in result.data) throw new Error(result.data.detail);
    if (result.data.engine_result !== "tesSUCCESS") {
      throw new Error(`The transaction validated with ${result.data.engine_result}, not tesSUCCESS.`);
    }
    return { status: "validated", hash: result.data.hash };
  }, [harbor]);

  const rebuildAndApproveOnLedger = useCallback(async (
    event: CardEvent,
    wallet: PilotWallet,
  ): Promise<ApprovalSubmission> => {
    const account = wallet.address();
    const freshEvent = await prepareFreshApproval(event, wallet, account);
    const approval = freshEvent.exec?.status === "needs_approval" ? freshEvent.exec : undefined;
    if (!approval || freshEvent.build?.build_id === event.build?.build_id) {
      throw new Error("Harbor did not return a fresh owner approval. The prior tuple was not submitted.");
    }
    const ledger = await harbor.op("ledger.account.info", {
      account,
      network: freshEvent.intent.network,
      ledger_index: "validated",
    });
    const sequence = ledger.ok ? ledger.data.account_data.Sequence : undefined;
    if (!ledger.ok || ledger.data.validated !== true || !Number.isSafeInteger(ledger.data.ledger_index) ||
        !Number.isSafeInteger(sequence)) {
      throw new Error(ledger.ok ? "Harbor did not return a validated ledger for the rebuilt approval." : ledger.error.message);
    }
    const request = bindApprovalTransaction(
      freshEvent,
      account,
      ledger.data.ledger_index!,
      Number(sequence),
    );
    const txBlob = await signOnlyAfterPreflight(request, wallet);
    if (isApprovalExpired(request.expiresAt)) {
      throw new Error("The rebuilt approval expired while the Ledger was open. Nothing was submitted.");
    }
    return submitApprovalBlob(freshEvent, txBlob, request.approvalId);
  }, [harbor, prepareFreshApproval, submitApprovalBlob]);

  const submit = useCallback(async (
    promptInput: string,
    options: { x402?: boolean; expectedOperationId?: string } = {},
  ) => {
    const prompt = promptInput.trim();
    if (!prompt || !walletReady || running) return;
    if (options.x402 && !x402Scope) {
      setX402RecoveryError("x402 requires an authenticated Testnet owner or explicit fixture mode.");
      return;
    }
    const execute = async (lockedOperation?: PendingX402Operation) => {
    interrupt(false);
    const controller = new AbortController();
    abortRef.current = controller;
    const runId = ++runRef.current;
    let operationId: string | undefined;
    if (options.x402) {
      if (!lockedOperation || !x402Scope) throw new Error("The x402 cross-tab dispatch lock was not confirmed.");
      operationId = lockedOperation.operation_id;
      pendingX402Ref.current = lockedOperation;
      setPendingX402(lockedOperation);
      x402DispatchedRef.current = false;
      setX402RecoveryError(undefined);
    }
    const id = `turn-${Date.now()}-${runId}`;
    setDraft("");
    setLastPrompt(prompt);
    setRunning(true);
    setTurns((current) => [...current, { id, prompt, response: "", operationId, streaming: true, source: "api" }]);

    try {
      let selectedModel: string | undefined;
      try {
        const sessionResponse = await fetch("/api/auth/openrouter/session", {
          signal: controller.signal,
        });
        if (sessionResponse.ok) {
          const session = (await sessionResponse.json()) as { model?: unknown };
          if (typeof session.model === "string") selectedModel = session.model;
        }
      } catch (cause) {
        if (controller.signal.aborted) throw cause;
        // The chat route still resolves the encrypted/default server session.
      }
      const requestBody = JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        ...(operationId ? { operation: "x402_compare", operation_id: operationId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
      });
      let proofHeaders: Record<string, string> = {};
      if (chatWalletActionProofRequired(publicConfig)) {
        if (!walletSession?.authenticated) {
          throw new Error("Reconnect the original browser wallet before using local chat.");
        }
        const { wallet, account } = await connectConfiguredWallet(walletSession.network);
        try {
          if (account !== walletSession.account) {
            throw new Error("The browser wallet does not match the authorized chat session.");
          }
          proofHeaders = await createChatWalletActionProof(
            wallet,
            account,
            walletSession.network,
            requestBody,
          );
        } finally {
          await wallet.disconnect();
        }
      }
      if (operationId && x402Scope) {
        x402DispatchedRef.current = true;
        const recovering = markX402OperationRecovering(localStorage, x402Scope, operationId);
        pendingX402Ref.current = recovering;
        setPendingX402(recovering);
      }
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...proofHeaders },
        body: requestBody,
        signal: controller.signal,
      });

      if (response.ok && response.body) {
        let receivedCard = false;
        let receivedX402 = false;
        let streamedText = "";
        await consumePilotStream(response, {
          signal: controller.signal,
          quickNodeAccount: quickNodeTestnetAccount(
            walletSession?.authenticated ? walletSession.account : undefined,
            walletSession?.authenticated ? walletSession.network : undefined,
            publicConfig?.network,
          ),
          onText: (delta) => {
            if (runRef.current !== runId) return;
            streamedText += delta;
            updateTurn(id, { response: streamedText, source: "api" });
          },
          onCard: (event) => {
            if (runRef.current !== runId) return;
            receivedCard = true;
            setTurns((current) => current.map((turn) => {
              if (turn.id !== id) return turn;
              const events = [...(turn.events ?? [])];
              const existing = events.findIndex((candidate) => candidate.intent_id === event.intent_id);
              if (existing === -1) events.push(event);
              else events[existing] = event;
              return { ...turn, event, events, source: "api" };
            }));
          },
          onGuardrailNotice: (notice) => {
            if (runRef.current !== runId) return;
            setTurns((current) => current.map((turn) => {
              if (turn.id !== id) return turn;
              return {
                ...turn,
                source: "api",
                guardrailNotices: [...(turn.guardrailNotices ?? []), notice],
              };
            }));
          },
          onQuickNodeFreeze: (notice) => {
            if (runRef.current !== runId) return;
            setTurns((current) => current.map((turn) => {
              if (turn.id !== id) return turn;
              return {
                ...turn,
                source: "api",
                quickNodeFreezeNotice: notice,
              };
            }));
          },
          onPreference: (preference) => {
            if (runRef.current !== runId) return;
            receivedCard = true;
            setTurns((current) => current.map((turn) => {
              if (turn.id !== id) return turn;
              const preferences = turn.preferences ?? [];
              const existingIndex = preferences.findIndex((candidate) => candidate.id === preference.id);
              return {
                ...turn,
                source: "api",
                preferences: existingIndex === -1
                  ? [...preferences, preference]
                  : preferences.map((candidate, index) => index === existingIndex ? preference : candidate),
              };
            }));
          },
          onX402: (event) => {
            if (runRef.current !== runId || event.operation_id !== operationId) return;
            receivedCard = true;
            receivedX402 = true;
            if (x402Scope) {
              try {
                if (
                  event.result.status === "delivered" &&
                  (event.mode !== "live-local" || event.journal_status === "recorded")
                ) {
                  completeX402Operation(localStorage, x402Scope, event.operation_id, {
                    result_status: "delivered",
                    mode: event.mode,
                    journal_status: event.mode === "fixture" ? "fixture" : "recorded",
                  });
                  pendingX402Ref.current = undefined;
                  setPendingX402(undefined);
                  x402DispatchedRef.current = false;
                } else if (event.result.status === "delivered") {
                  const journalPending = markX402OperationJournalPending(localStorage, x402Scope, event.operation_id);
                  pendingX402Ref.current = journalPending;
                  setPendingX402(journalPending);
                } else {
                  const recovering = markX402OperationRecovering(localStorage, x402Scope, event.operation_id);
                  pendingX402Ref.current = recovering;
                  setPendingX402(recovering);
                }
              } catch (cause) {
                setX402RecoveryError(cause instanceof Error ? cause.message : "The x402 recovery state could not be updated.");
              }
            }
            updateTurn(id, { x402: event, source: "api" });
          },
        });
        if (runRef.current !== runId) return;
        if (operationId && !receivedX402 && x402Scope) {
          try {
            const recovering = markX402OperationRecovering(localStorage, x402Scope, operationId);
            pendingX402Ref.current = recovering;
            setPendingX402(recovering);
          } catch (cause) {
            setX402RecoveryError(cause instanceof Error ? cause.message : "The x402 recovery state could not be updated.");
          }
        }
        updateTurn(id, {
          response: streamedText || (receivedCard ? "Harbor returned the transaction update below." : "Pilot finished the request."),
          streaming: false,
          source: "api",
        });
        return;
      }

      const failure = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
      throw new Error(typeof failure?.error === "string" ? failure.error : `Pilot chat failed with HTTP ${response.status}.`);
    } catch (cause) {
      if (controller.signal.aborted || runRef.current !== runId) return;
      if (operationId && x402DispatchedRef.current && x402Scope) {
        try {
          const recovering = markX402OperationRecovering(localStorage, x402Scope, operationId);
          pendingX402Ref.current = recovering;
          setPendingX402(recovering);
        } catch {
          // Keep the durable record untouched and require manual recovery.
        }
      }
      updateTurn(id, { response: cause instanceof Error ? cause.message : "The request stopped unexpectedly.", streaming: false });
    } finally {
      if (runRef.current === runId) {
        setRunning(false);
        abortRef.current = undefined;
        if (operationId) x402DispatchedRef.current = false;
      }
    }
    };
    if (!options.x402) {
      await execute();
      return;
    }
    try {
      const locks = "locks" in navigator
        ? navigator.locks as unknown as PublicOperationLockManager
        : undefined;
      const outcome = await withLockedX402OperationDispatch(
        locks,
        localStorage,
        x402Scope!,
        {
          createOperationId: () => `x402-${x402Scope!.owner}-${crypto.randomUUID()}`,
          expectedOperationId: options.expectedOperationId,
        },
        execute,
      );
      if (outcome.kind === "contended") {
        pendingX402Ref.current = outcome.operation;
        setPendingX402(outcome.operation);
        setX402RecoveryError("Another tab is handling this x402 operation. Its durable identity was adopted; resume only with the same operation.");
      } else if (outcome.kind === "completed") {
        pendingX402Ref.current = undefined;
        setPendingX402(undefined);
        setX402RecoveryError(
          outcome.operation.terminal.mode === "fixture"
            ? "This fixture operation already completed. No payment was made."
            : "This x402 operation already completed with validated payment and a durable journal receipt. No recovery dispatch was sent.",
        );
      }
    } catch (cause) {
      setX402RecoveryError(cause instanceof Error ? cause.message : "The x402 operation could not be locked safely.");
    }
  }, [connectConfiguredWallet, interrupt, publicConfig, running, updateTurn, walletReady, walletSession, x402Scope]);
  /** Scripted demo turn: local timers only, no fetch, wallet or Harbor call. */
  const runDemo = useCallback(async (promptInput: string) => {
    const prompt = promptInput.trim();
    if (!prompt) return;
    // A new prompt cleanly stops any run still in progress.
    interrupt(true);
    const runId = ++runRef.current;
    const seq = ++demoSeqRef.current;
    const id = `demo-${seq}`;
    const plan = routeDemoPrompt(prompt, seq);
    const steps = buildDemoTimeline(plan, { reducedMotion });
    setDraft("");
    setLastPrompt(prompt);
    setRunning(true);
    const quickNodeFreeze = fixtureQuickNodeFreezeNotice(prompt);
    setTurns((current) => [...current, {
      id,
      prompt,
      response: "",
      streaming: true,
      source: "demo",
      ...(quickNodeFreeze
        ? { quickNodeFreezeNotice: quickNodeFreeze }
        : {}),
    }]);

    const finished = await playDemoTimeline(steps, {
      sleep: (milliseconds) => new Promise<void>((resolve) => {
        demoTimersRef.current.push(window.setTimeout(resolve, milliseconds));
      }),
      isAlive: () => runRef.current === runId,
      onStep: (step) => {
        switch (step.kind) {
          case "thinking":
            updateTurn(id, { status: step.status });
            break;
          case "text":
            updateTurn(id, { response: step.text, status: undefined });
            break;
          case "blocks":
            updateTurn(id, { blocks: plan.blocks });
            break;
          case "event": {
            const event = plan.events[step.index];
            updateTurn(id, { event, events: [event] });
            break;
          }
          case "followUp":
            updateTurn(id, { followUp: plan.followUp });
            break;
          case "done":
            updateTurn(id, { streaming: false });
            break;
        }
      },
    });
    if (finished && runRef.current === runId) setRunning(false);
  }, [interrupt, reducedMotion, updateTurn]);

  const send = useCallback((prompt: string) => {
    if (demoMode) void runDemo(prompt);
    else void submit(prompt);
  }, [demoMode, runDemo, submit]);

  const fillComposer = useCallback((prompt: string) => {
    setDraft(prompt);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(prompt.length, prompt.length);
    });
  }, []);

  const replaceDemoEvent = useCallback((next: CardEvent, followUp?: string) => {
    setTurns((current) => current.map((turn) => {
      if (!turn.events?.some((event) => event.intent_id === next.intent_id)) return turn;
      return {
        ...turn,
        event: next,
        events: turn.events.map((event) => event.intent_id === next.intent_id ? next : event),
        ...(followUp ? { followUp } : {}),
      };
    }));
  }, []);

  const completeApproval = useCallback((submission: ApprovalSubmission) => {
    if (!approvalEvent) return;
    const ledgerMetadata = configuredWallet?.ledger;
    if (approvalWallet?.provider === "ledger" && ledgerMetadata) {
      setOwnerSigners((current) => new Map(current).set(approvalEvent.intent_id, {
        kind: "ledger",
        accountIndex: ledgerMetadata.accountIndex,
      }));
    }
    const approved: CardEvent = {
      ...approvalEvent,
      state: submission.status === "validated" ? "validated" : "submitted",
      at: new Date().toISOString(),
      hash: submission.hash,
      exec: undefined,
    };
    const resultText = submission.status === "validated"
      ? "Approved, owner-signed, and validated on XRPL."
      : "Approved and owner-signed. Harbor submitted it and validation is pending.";
    setTurns((current) => current.map((turn) => {
      const events = turn.events?.map((event) => event.intent_id === approvalEvent.intent_id ? approved : event);
      return turn.event?.intent_id === approvalEvent.intent_id
        ? { ...turn, event: approved, events, response: resultText }
        : { ...turn, events };
    }));
  }, [approvalEvent, approvalWallet?.provider, configuredWallet?.ledger]);

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] min-w-0 lg:min-h-[calc(100dvh-4rem)]">
      <section className="flex min-w-0 flex-col">
        <div className="flex min-h-11 min-w-0 items-center justify-between gap-3 border-b border-border px-4 py-1.5 sm:px-6 lg:px-8">
          {demoMode && sessionUi.notice ? (
            <DemoBanner reason={sessionUi.notice} />
          ) : (
            <>
              <p className={`inline-flex items-center gap-2 border px-2 py-1 font-mono text-[11px] uppercase tracking-wide ${walletReady ? "border-executed/30 bg-executed/10 text-executed" : "border-border text-muted-foreground"}`}>
                <span aria-hidden="true" className={`h-1.5 w-1.5 ${walletReady ? "bg-executed" : "bg-muted-foreground"}`} />
                {walletReady ? "Harbor is ready" : "Preview · live chat locked"}
              </p>
              <p className="label-mono ml-auto hidden truncate lg:block">Simulate · check policy · owner signs</p>
            </>
          )}
          <button
            type="button"
            onClick={() => setCardStatesOpen(true)}
            aria-haspopup="dialog"
            className="bracket bracket-light inline-flex h-8 pointer-coarse:h-11 pointer-coarse:min-w-11 shrink-0 items-center justify-center gap-1.5 border border-border bg-white/[0.03] px-2.5 font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Card states</span>
          </button>
        </div>

        <div className={`mx-auto w-full min-w-0 max-w-4xl flex-1 px-4 pt-8 sm:px-6 lg:px-8 ${demoMode ? "pb-56" : "pb-60"}`}>
          <h2 className="sr-only">Conversation</h2>
          <div className="space-y-9" aria-live="polite">
            {turns.map((turn) => (
              <article key={turn.id} className="min-w-0 space-y-5">
                <MessageBubble role="user">{turn.prompt}</MessageBubble>
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center border border-border bg-card text-foreground" role="img" aria-label="Pilot"><Bot className="h-[18px] w-[18px]" strokeWidth={1.75} /></span>
                  <div className="min-w-0 flex-1">
                    <div
                      className={
                        !turn.response && (turn.status || turn.streaming)
                          ? "flex min-h-6 min-w-0 items-center gap-2 text-sm leading-6 text-foreground/90"
                          : // Pilot's reply sits in a box like the user's message (cards stay outside it).
                            "flex w-fit max-w-full min-w-0 items-center gap-2 border border-border bg-white/[0.05] px-4 py-3 text-sm leading-6 text-foreground"
                      }
                    >
                      {!turn.response && turn.status ? (
                        <span className="min-w-0 font-mono text-[11px] uppercase tracking-wide text-muted-foreground [overflow-wrap:anywhere]">{turn.status}</span>
                      ) : (
                        <span className="min-w-0 [overflow-wrap:anywhere]">{turn.id === "opening" && demoMode ? demoOpeningResponse : turn.response || "Thinking through the safest path"}</span>
                      )}
                      {turn.streaming && !turn.response ? <span className="inline-flex gap-1" aria-label="Streaming"><i className="h-1 w-1 animate-pulse bg-primary" /><i className="h-1 w-1 animate-pulse bg-primary [animation-delay:120ms]" /><i className="h-1 w-1 animate-pulse bg-primary [animation-delay:240ms]" /></span> : null}
                    </div>
                    {turn.blocks ? <DemoBlocks blocks={turn.blocks} /> : null}
                    {(turn.events ?? (turn.event ? [turn.event] : [])).map((event) => {
                      const ledgerConfigured = configuredWallet?.provider === "ledger";
                      const ledgerPrepared = ledgerPreparedIntents.has(event.intent_id);
                      const ledgerReady = ledgerDeviceReady(ledgerPrepared, ledgerDeviceState);
                      return (
                        <div key={event.intent_id} className="mt-3">
                          {turn.source === "demo" ? (
                            <>
                              <IntentCard
                                event={event}
                                onApprove={(candidate) => setDemoApproval({ event: candidate, seed: demoSeqRef.current * 97 + candidate.intent_id.length })}
                                onCancel={() => interrupt(true)}
                              />
                              <p className="flex items-center gap-1.5 border border-t-0 border-border bg-white/[0.02] px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                                <FlaskConical className="h-3 w-3 text-primary" aria-hidden="true" />
                                Simulated · no wallet or ledger transaction
                              </p>
                            </>
                          ) : (
                            <>
                              <IntentCard
                                event={event}
                                ownerSigner={ownerSigners.get(event.intent_id)}
                                onApprove={ledgerConfigured ? undefined : (candidate) => void openApproval(candidate)}
                                onCancel={() => interrupt(true)}
                              />
                              {ledgerConfigured && event.state === "awaiting_approval" ? (
                                <div className="flex flex-wrap items-center gap-2 border border-t-0 border-border bg-white/[0.02] px-3 py-2">
                                  <button
                                    type="button"
                                    disabled={running || (ledgerPrepared && !ledgerReady)}
                                    onClick={() => void (ledgerPrepared
                                      ? openLedgerApproval(event)
                                      : prepareLedger(event))}
                                    className="h-9 bg-approval px-3.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-approval-foreground transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
                                  >
                                    {ledgerPrepared
                                      ? "Build and approve"
                                      : "Prepare Ledger"}
                                  </button>
                                  {ledgerPrepared ? <DeviceStatus state={ledgerDeviceState} /> : (
                                    <p className="text-xs text-muted-foreground">Connect and open the XRP app before the approval window is used.</p>
                                  )}
                                </div>
                              ) : null}
                            </>
                          )}
                        </div>
                      );
                    })}
                    {turn.followUp ? <p className="mt-3 text-sm leading-6 text-muted-foreground">{turn.followUp}</p> : null}
                    {turn.guardrailNotices?.length ? (
                      <div className="mt-3">
                        <GuardrailBanner notices={turn.guardrailNotices} />
                      </div>
                    ) : null}
                    {turn.quickNodeFreezeNotice ? (
                      <div className="mt-3">
                        <QuickNodeFreezeBanner notices={[turn.quickNodeFreezeNotice]} />
                      </div>
                    ) : null}
                    {turn.preferences?.map((preference) => (
                      <PreferenceCard key={preferenceProposalRenderKey(preference)} proposal={preference} />
                    ))}
                    {turn.x402 ? <X402ResultCard event={turn.x402} onRetry={turn.operationId && pendingX402?.operation_id === turn.operationId && (turn.x402.result.status === "settlement_unknown" || turn.x402.journal_status === "failed") ? () => void submit(X402_RECOVERY_PROMPT, { x402: true, expectedOperationId: turn.operationId }) : undefined} /> : null}
                    {turn.source === "fixture" && turn.id !== "opening" ? <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Local mock stream</p> : null}
                  </div>
                </div>
              </article>
            ))}
            {demoMode && !running ? (
              <div className="sm:pl-10">
                <p className="label-mono mb-3 text-[10px]">{turns.length <= 1 ? "Try asking" : "Try another"}</p>
                <div className="flex min-w-0 flex-wrap gap-2.5">
                  {DEMO_SUGGESTIONS.map(({ prompt, scenario }, index) => {
                    const { icon: Icon, tone } = demoSuggestionIcons[scenario];
                    // After the first reply, phones show three suggestions instead of all seven.
                    const compact = turns.length > 1 && index >= 3 ? "max-sm:hidden " : "";
                    return (
                      <button key={prompt} type="button" onClick={() => fillComposer(prompt)} className={compact + "inline-flex bracket bracket-light max-w-full items-center gap-2 border border-border bg-card px-3 py-2 text-left font-mono text-[11px] uppercase tracking-wide text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground pointer-coarse:min-h-11"}>
                        <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} aria-hidden="true" />
                        <span className="min-w-0 sm:truncate">{prompt}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {!demoMode && turns.length <= 1 ? (
              <div className="pl-10">
                <p className="label-mono mb-3 text-[10px]">Try asking</p>
                <div className="flex min-w-0 flex-wrap gap-2.5">
              {suggestions.map((suggestion, index) => {
                const { icon: Icon, tone } = suggestionIcons[index] ?? suggestionIcons[0];
                return (
                  <button key={suggestion} type="button" disabled={running || !walletReady} onClick={() => void submit(suggestion)} className={`inline-flex bracket bracket-light max-w-full items-center gap-2 border border-border bg-background/70 px-3 py-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background/70 disabled:hover:text-muted-foreground`}>
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} aria-hidden="true" />
                    <span className="truncate">{suggestion}</span>
                  </button>
                );
              })}
            </div>
              </div>
            ) : null}
            <div ref={endRef} className={demoMode ? "scroll-mb-56" : "scroll-mb-64"} />
          </div>

        </div>

        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 px-3 pb-3 pt-3 backdrop-blur-md sm:px-4 sm:pb-4 lg:left-64 [@media(max-height:520px)]:pb-2 [@media(max-height:520px)]:pt-2">
          <div className="mx-auto max-w-4xl">
            {!demoMode && pendingX402 ? <div className="mb-2 flex items-center justify-between gap-3 border border-approval/25 bg-approval/8 px-3 py-2 text-xs text-approval"><span>{pendingX402.phase === "paid_journal_pending" ? "Payment is validated; durable journal recovery is pending." : pendingX402.phase === "recovering" ? "x402 settlement recovery is pending." : "An x402 recovery identity is reserved."}</span><button type="button" disabled={running || !walletReady} onClick={() => void submit(X402_RECOVERY_PROMPT, { x402: true, expectedOperationId: pendingX402.operation_id })} className="font-semibold underline disabled:opacity-40">Resume same operation</button></div> : null}
            {!demoMode && x402RecoveryError ? <p className="mb-2 px-1 text-xs text-blocked">{x402RecoveryError}</p> : null}
            {!demoMode && sessionUi.notice === "onboarding" ? <p className="mb-2 px-1 text-xs text-muted-foreground">Live chat is locked until a wallet proves control through <a className="font-semibold text-primary hover:underline" href="/onboarding">onboarding</a>.</p> : null}
            {!demoMode && sessionUi.notice === "unavailable" ? <p className="mb-2 px-1 text-xs text-blocked">Wallet session status is unavailable. Reload the page to retry.</p> : null}
            {!demoMode && sessionUi.notice === "proof" ? <p className="mb-2 px-1 text-xs text-blocked">Local wallet proof prerequisites are not configured. Set the server-only session secret and replay-state directory, then reload.</p> : null}
            {!demoMode && sessionUi.notice === "configuration" ? <p className="mb-2 px-1 text-xs text-blocked">Pilot configuration is unavailable. Reload the page to retry.</p> : null}
            {!demoMode ? <div className="mb-2 flex min-w-0 flex-wrap gap-2 pb-1"><button type="button" disabled={running || !walletReady || !x402Scope} onClick={() => void submit("Purchase the approved local Testnet premium venue comparison.", { x402: true })} className="bracket bracket-light inline-flex max-w-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-[11px] text-primary hover:border-primary/40 disabled:opacity-40">Premium comparison · x402</button></div> : null}
            <form onSubmit={(event) => { event.preventDefault(); send(draft); }} className="bracket bracket-focus min-w-0 border border-border-strong bg-card">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(draft); } }}
                rows={2}
                aria-label="Message Pilot"
                disabled={!walletReady && !demoMode}
                placeholder={demoMode ? "Ask Pilot anything" : sessionUi.placeholder}
                className="block max-h-40 min-h-16 w-full min-w-0 resize-none bg-transparent px-4 py-3 text-sm leading-6 pointer-coarse:text-base outline-none placeholder:text-muted-foreground/80 disabled:cursor-not-allowed sm:min-h-[4.5rem] [@media(max-height:520px)]:max-h-20 [@media(max-height:520px)]:min-h-10 [@media(max-height:520px)]:py-2"
              />
              <div className="flex min-w-0 items-center gap-2 border-t border-border bg-white/[0.015] px-2.5 py-2 [@media(max-height:520px)]:py-1">
                <span className="hidden items-center gap-1.5 border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground sm:inline-flex">
                  <span aria-hidden="true" className={`h-1.5 w-1.5 ${publicConfig ? "bg-executed" : "bg-muted-foreground"}`} />
                  {publicConfig === undefined ? "Checking…" : publicConfig?.network ?? "Unavailable"}
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <button type="button" onClick={() => send(lastPrompt)} disabled={running || (!walletReady && !demoMode)} className="inline-flex h-8 items-center gap-1.5 px-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition hover:text-foreground pointer-coarse:h-11 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-muted-foreground"><RotateCcw className="h-3 w-3" aria-hidden="true" />Repeat</button>
                  {running ? (
                    <button type="button" onClick={() => interrupt(true)} className="bracket bracket-light grid h-8 w-8 shrink-0 place-items-center border border-border bg-white/[0.04] text-foreground hover:bg-white/[0.08] pointer-coarse:h-11 pointer-coarse:w-11" aria-label="Stop streaming"><Square className="h-3 w-3 fill-current" /></button>
                  ) : (
                    <button type="submit" disabled={!draft.trim() || (!walletReady && !demoMode)} className="bracket bracket-light grid h-8 w-8 shrink-0 place-items-center border border-border-strong bg-foreground text-background pointer-coarse:h-11 pointer-coarse:w-11 transition hover:bg-foreground/90 disabled:cursor-not-allowed disabled:border-border disabled:bg-white/[0.04] disabled:text-muted-foreground" aria-label="Send message"><ArrowUp className="h-3.5 w-3.5" /></button>
                  )}
                </div>
              </div>
            </form>
            {demoMode ? null : <p className="label-mono mt-3 text-center text-[10px]">Pilot never holds your owner key.</p>}
          </div>
        </div>
      </section>

      {sidebarSlot ? createPortal(
      <section aria-label="Session context" className="space-y-3">
          <div className="space-y-3">
            <div className="border border-border">
              <p className="label-mono border-b border-border px-3 py-2.5">Live context</p>
              <dl className="divide-y divide-border text-xs">
                <ContextRow label="Network" value={publicConfig === undefined ? "Checking…" : publicConfig?.network ?? "Unavailable"} status={Boolean(publicConfig)} />
                <ContextRow label="Wallet" value={demoMode ? "Not connected" : sessionUi.label} status={walletReady} />
                <ContextRow label="Daily budget" value={demoMode ? "Policy" : "Live policy"} />
              </dl>
            </div>
          </div>
        </section>,
        sidebarSlot,
      ) : null}

      {cardStatesOpen ? <CardStatesDialog onClose={closeCardStates} /> : null}

      {approvalError ? <p className="fixed bottom-48 left-1/2 z-30 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 border border-blocked/40 bg-card px-4 py-3 text-sm text-blocked shadow-xl shadow-black/[0.1]" role="alert">{approvalError}</p> : null}

      {demoApproval ? (
        <DemoApprovalDialog
          event={demoApproval.event}
          reducedMotion={reducedMotion}
          onClose={() => {
            setDemoApproval(undefined);
            // After signing, the "Review & sign" button is gone; land focus on the composer instead of the page body.
            window.setTimeout(() => {
              if (!document.activeElement || document.activeElement === document.body) textareaRef.current?.focus();
            }, 0);
          }}
          onSubmitted={() => replaceDemoEvent(simulatedOwnerSignature(demoApproval.event, demoApproval.seed).submitted)}
          onValidated={() => replaceDemoEvent(
            simulatedOwnerSignature(demoApproval.event, demoApproval.seed).validated,
            "Signed (simulated) and validated. In the live app your wallet signs this exact transaction and Harbor confirms it on the ledger.",
          )}
        />
      ) : null}

      {approvalEvent && approvalRequest && approvalWallet ? (
        <ApprovalModal
          open
          request={approvalRequest}
          wallet={approvalWallet}
          ledger={approvalWallet.provider === "ledger" && configuredWallet?.ledger ? {
            accountIndex: configuredWallet.ledger.accountIndex,
            deviceReady: ledgerDeviceReady(
              ledgerPreparedIntents.has(approvalEvent.intent_id),
              ledgerDeviceState,
            ),
            deviceState: ledgerDeviceState,
            signingMode: ledgerSigningMode(approvalRequest.txJson),
            ...(ledgerSigningMode(approvalRequest.txJson) === "blind"
              ? { blindLegend: <LedgerBlindApprovalLegend request={approvalRequest} /> }
              : {}),
            onRebuildAndApprove: () => rebuildAndApproveOnLedger(approvalEvent, approvalWallet),
          } : undefined}
          onClose={closeApproval}
          onSubmit={(txBlob, approvalId) => submitApprovalBlob(approvalEvent, txBlob, approvalId)}
          onComplete={completeApproval}
        />
      ) : null}
    </div>
  );
}
function MessageBubble({ role, children }: { role: "user"; children: string }) {
  return (
    <div className="ml-auto flex min-w-0 max-w-[88%] items-start justify-end gap-2 sm:max-w-[78%]">
      <p className="min-w-0 whitespace-pre-wrap border border-border bg-white/[0.05] px-4 py-3 text-sm leading-6 [overflow-wrap:anywhere]">{children}</p>
      <span className="grid h-9 w-9 shrink-0 place-items-center border border-border text-muted-foreground" role="img" aria-label={role === "user" ? "You" : role}><UserRound className="h-[18px] w-[18px]" /></span>
    </div>
  );
}

function ContextRow({ label, value, status }: { label: string; value: string; status?: boolean }) {
  return <div className="flex items-center justify-between gap-3 px-3 py-2"><dt className="label-mono text-[10px]">{label}</dt><dd className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[10px] uppercase text-foreground">{status ? <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 bg-executed" /> : null}<span className="truncate">{value}</span></dd></div>;
}

function LedgerBlindApprovalLegend({ request }: { request: ApprovalRequest }) {
  return (
    <section aria-label="Ledger blind approval guide" className="border border-amber-300 bg-amber-50 p-3 text-slate-950">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-amber-900">Expected blind-sign screens</p>
      <p className="mt-2 text-xs leading-5">
        The XRP app may show this transaction type as Unknown. Approve only when the validated Pilot summary matches every value below.
      </p>
      <dl className="mt-3 grid gap-px border border-amber-200 bg-amber-200 text-xs sm:grid-cols-2">
        <div className="bg-white p-2"><dt className="font-semibold">Action</dt><dd className="mt-1 font-mono">{request.summary.action}</dd></div>
        <div className="bg-white p-2"><dt className="font-semibold">Amount</dt><dd className="mt-1 font-mono">{request.summary.amounts.join(" · ") || "No asset movement"}</dd></div>
        <div className="bg-white p-2"><dt className="font-semibold">Destination</dt><dd className="mt-1 break-all font-mono">{request.summary.destination ?? "XRPL protocol"}</dd></div>
        <div className="bg-white p-2"><dt className="font-semibold">Fee</dt><dd className="mt-1 font-mono">{request.summary.feeDrops} drops</dd></div>
      </dl>
    </section>
  );
}
