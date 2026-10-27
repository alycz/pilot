"use client";

import {
  DEFAULT_POLICY,
  type AccountLink,
  type Envelope,
  type Mandate,
  type Merchant,
  type Network,
  type Policy,
  type TxBuild,
} from "@pilot/contracts";
import type { HarborClient, TxSubmitResult } from "@pilot/harbor-client";
import {
  createWallet as createPilotWallet,
  type LedgerDeviceState,
} from "@pilot/wallet";
import { hashes } from "xrpl";
import {
  Compass,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ExternalLink,
  LoaderCircle,
  Network as NetworkIcon,
  ShieldCheck,
  Navigation,
  WalletCards,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ApprovalModal,
  type ApprovalRequest,
  type ApprovalSubmission,
  type SignOnlyWallet,
} from "../approval/approval-modal";
import { normalizeIssuedCurrencyCodes } from "../approval/normalize-transaction";
import { describeDemoSessionFailure, OnboardingStepError } from "./demo-session-error";
import { DesktopWalletGuide } from "./desktop-wallet-guide";
import { ModelPicker, type ModelChoice } from "./model-picker";
import {
  MandateApprovalCard,
  MandateBuilder,
  MandateSummary,
  validateMandateDraft,
  type MandateDraft as MandateForm,
  type MandatePayeeOption,
} from "../mandate";
import {
  OpenFinanceStep,
  type VerificationSummary,
} from "./open-finance-index";
import {
  OnboardingSteps,
  type OnboardingStepId,
} from "./onboarding-steps";
import {
  bindWalletSession,
  clearWalletSession,
  createBrowserHarborClient,
  loadPublicPilotConfig,
  loadWalletSessionStatus,
  WALLET_SESSION_CHANGED_EVENT,
  type PublicPilotConfig,
  type WalletSessionStatus,
} from "../../lib/harbor-browser";
import { signOutPilotWallet } from "../../lib/wallet-sign-out";
import {
  OFFICIAL_TESTNET_RLUSD_CURRENCY,
  OFFICIAL_TESTNET_RLUSD_ISSUER,
  RLUSD_ACQUISITION_EXACT_OUTPUT,
} from "../../lib/rlusd-acquisition";
import {
  approveAndRegisterMandate,
  mandateChannelPreviews,
  prepareMandateDraft,
  walletBatchCapability,
  type MandateDraft as PreparedMandateDraft,
} from "../../app/onboarding/mandate-flow";
import {
  LedgerSigningGuide,
  LedgerWalletStep,
  LEDGER_ONBOARDING_ACCOUNT_INDEXES,
  defaultLedgerAccountIndex,
  defaultLedgerTransport,
  hasExactLedgerPermissionSet,
  isLedgerBlindSigningDisabled,
  ledgerSessionMatches,
  ledgerTransportAvailable,
  validStoredLedgerConfig,
  type LedgerOnboardingAccountIndex,
  type LedgerOnboardingTransport,
  type StoredLedgerOnboardingConfig,
} from "./ledger-wallet-step";
import { SimulatedDevice } from "../ledger/simulated-device";
import verifyAddressTranscript from "../ledger/transcripts/verify-address.json";
import {
  configuredWalletMetadata,
  configuredWalletOptions,
  type ConfiguredWalletMetadata,
} from "../chat/configured-wallet";

const DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free";
export const DEFAULT_PERMISSIONS = [
  "OfferCreate",
  "OfferCancel",
  "TrustSet",
  "AMMDeposit",
  "AMMWithdraw",
  "EscrowFinish",
  "CheckCash",
] as const;

export type WalletProvider = "ledger" | "gemwallet" | "crossmark" | "xaman" | "dev";
type ExtensionWalletProvider = Extract<WalletProvider, "gemwallet" | "crossmark">;

export function isExtensionWalletProvider(
  provider: WalletProvider,
): provider is ExtensionWalletProvider {
  return provider === "gemwallet" || provider === "crossmark";
}

type DemoCatalogState =
  | { status: "idle" | "loading" | "available" }
  | { status: "unavailable"; message: string };

export const XAMAN_UNAVAILABLE_REASON =
  "Unavailable: Xaman needs an app API key, and the current adapter cannot sign Pilot's non-broadcast wallet-auth proof safely.";

const WALLET_NAMES: Record<string, string> = {
  gemwallet: "GemWallet",
  crossmark: "Crossmark",
  ledger: "Ledger",
  dev: "Testnet dev signer",
  xaman: "Xaman",
};

export function walletProviderUnavailableReason(
  provider: WalletProvider,
): string | undefined {
  return provider === "xaman" ? XAMAN_UNAVAILABLE_REASON : undefined;
}

export type WalletViewportState = "checking" | "desktop" | "small-screen";

export function walletViewportUnavailableReason(
  state: WalletViewportState,
): string | undefined {
  if (state === "desktop") return undefined;
  return state === "checking"
    ? "Checking desktop wallet availability."
    : "Unavailable in this small-screen browser context. Use a supported desktop browser extension.";
}

export function walletFirstSessionMetadata(
  session: WalletSessionStatus,
  storedWallet: string | null,
  publicConfig: PublicPilotConfig,
  now = Date.now(),
): ConfiguredWalletMetadata {
  if (
    !session.authenticated ||
    (session.expiresAt !== undefined && session.expiresAt <= now)
  ) {
    throw new Error("Reconnect the exact wallet used for this Pilot session before choosing a model.");
  }
  if (session.network !== publicConfig.network) {
    throw new Error("Reconnect the exact wallet used for this Pilot session before choosing a model.");
  }
  const configured = configuredWalletMetadata(storedWallet, publicConfig);
  if (configured.account !== session.account) {
    throw new Error("Reconnect the exact wallet used for this Pilot session before choosing a model.");
  }
  return configured;
}

export function shouldLoadOnboardingModels(
  step: OnboardingStepId,
  walletSessionReady: boolean,
): boolean {
  return step === "ai" && walletSessionReady;
}

export function nextStepAfterWalletAuthentication(): OnboardingStepId {
  return "ai";
}

export function nextStepAfterModelAccess(): OnboardingStepId {
  return "access";
}

export function shouldSuppressOnboardingRestoration(search: string): boolean {
  return new URLSearchParams(search).get("wallet") === "signed-out";
}

export function shouldShowSimulatedLedgerReplay(
  aiMode: "demo" | "openrouter" | "near-ai",
  accounts: Partial<Record<LedgerOnboardingAccountIndex, string>>,
) {
  return (
    aiMode === "demo" &&
    LEDGER_ONBOARDING_ACCOUNT_INDEXES.every((index) => !accounts[index])
  );
}

export type OnboardingWallet = SignOnlyWallet & {
  checkAvailability?(): Promise<void>;
  connect(): Promise<string | void>;
  address(): Promise<string> | string;
  disconnect?(): Promise<void> | void;
  verifyAddressOnDevice?(): Promise<void>;
  onDeviceState?(listener: (state: LedgerDeviceState) => void): () => void;
  markRevocationVerified?(): Promise<void> | void;
  forget?(): Promise<void> | void;
};

type PendingAction =
  | {
    kind: "trust";
    build: TxBuild;
    approvalId?: string;
    expiresAt?: string;
    expectedDelegate?: string;
  }
  | { kind: "delegate"; link: AccountLink }
  | { kind: "revoke"; link: AccountLink }
  | { kind: "acquire"; state: PreparedAcquisitionState };

type ResumablePendingAction = Exclude<PendingAction, { kind: "acquire" }>;

type StoredPendingSubmission = {
  version: 1;
  kind: ResumablePendingAction["kind"];
  hash: string;
  account: string;
  network: TestNetwork;
  expectedDelegate?: string;
  submissionRoute?: "direct" | "harbor";
  lastLedgerSequence: number;
  expectedTx: Record<string, unknown>;
};

export type OnboardingTrustExecution =
  | { status: "executed"; hash: string }
  | {
    status: "needs_approval";
    action: Extract<PendingAction, { kind: "trust" }> & {
      approvalId: string;
      expiresAt: string;
      expectedDelegate: string;
    };
  };

export type PreparedLiveOnboardingTrust = {
  status: "prepared";
  action: {
    kind: "trust";
    build: TxBuild;
    intentId: string;
    expectedDelegate: string;
  };
};

export type PolicyConfirmedLiveOnboardingTrust = {
  status: "policy_confirmed";
  action: PreparedLiveOnboardingTrust["action"];
};

type TestNetwork = Extract<Network, "testnet" | "devnet">;
export type AcquisitionStatus =
  | "initializing"
  | "prepared"
  | "signed_pending"
  | "validated"
  | "expired_unsubmitted"
  | "expired_unincluded"
  | "failed";

export type RlusdAcquisitionRouteState = {
  operation_id: string;
  owner: string;
  network: "testnet";
  status: AcquisitionStatus;
  execution_contract?: "xrpl_execution_v2";
  build_revision?: number;
  tx_json?: Record<string, unknown>;
  approval_expires_at?: string;
  approval_binding?: string;
  hash?: string;
  ledger_index?: number;
  engine_result?: string;
  balance_before?: string;
  balance_before_ledger_index?: number;
  balance_after?: string;
  balance_after_ledger_index?: number;
};

type PreparedAcquisitionState = RlusdAcquisitionRouteState & {
  status: "prepared";
  tx_json: Record<string, unknown>;
  approval_expires_at: string;
  approval_binding: string;
};

type AcquisitionRecoveryHint = {
  operation_id: string;
  account: string;
  network: "testnet";
};

export type StoredActiveOnboardingRecord = {
  version: 1;
  provider: WalletProvider;
  account: string;
  main_account: string;
  budget_account: string;
  network: TestNetwork;
  delegate: string;
  permissions: string[];
  model: string;
  aiMode: "demo" | "openrouter" | "near-ai";
  status: "active";
  txHash: string;
  ledger?: StoredLedgerOnboardingConfig;
};

const ACQUISITION_RECOVERY_KEY = "pilot:rlusd-acquisition";
const ACQUISITION_FAUCET_RECOVERY_KEY = "pilot:rlusd-acquisition-faucet";
const ONBOARDING_READINESS_KEY = "pilot:onboarding-readiness";
const ONBOARDING_TRUST_APPROVAL_KEY = "pilot:onboarding-trust-approval";
const ONBOARDING_TRUST_INTENT_KEY = "pilot:onboarding-trust-intent";
const VERIFIED_REVOCATION_CLEANUP_KEYS = [
  "pilot:wallet",
  "pilot:onboarding",
  "pilot:onboarding-pending",
  ACQUISITION_RECOVERY_KEY,
  ACQUISITION_FAUCET_RECOVERY_KEY,
  ONBOARDING_READINESS_KEY,
  ONBOARDING_TRUST_APPROVAL_KEY,
  ONBOARDING_TRUST_INTENT_KEY,
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[A-F0-9]{64}$/;
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const ACQUISITION_FILL_OR_KILL = 0x0004_0000;
const ACQUISITION_CAP_DROPS = 275_000_000n;
type OnboardingReadinessHint = {
  version: 1;
  account: string;
  network: "testnet";
  trust_set_hash: string;
};
type OnboardingTrustIntent = {
  version: 1;
  account: string;
  intent_id: string;
};
type StoredOnboardingTrustApproval = {
  version: 1;
  account: string;
  network: "testnet";
  delegate: string;
  approval_id: string;
  expires_at: string;
  build: TxBuild;
};
type PollOptions = {
  attempts?: number;
  delayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

export class TerminalOnboardingSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalOnboardingSubmissionError";
  }
}

export class AmbiguousOnboardingSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousOnboardingSubmissionError";
  }
}

export function parseOnboardingReadinessHint(
  raw: string | null,
  account: string,
): OnboardingReadinessHint | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      Object.keys(value).length !== 4 || value.version !== 1 ||
      value.account !== account || value.network !== "testnet" ||
      typeof value.trust_set_hash !== "string" || !HASH.test(value.trust_set_hash)
    ) return undefined;
    return value as OnboardingReadinessHint;
  } catch {
    return undefined;
  }
}

function onboardingReadinessHint(
  account: string,
  trustSetHash: string,
): OnboardingReadinessHint {
  if (!CLASSIC_ADDRESS.test(account) || !HASH.test(trustSetHash)) {
    throw new Error("The onboarding readiness evidence is invalid.");
  }
  return { version: 1, account, network: "testnet", trust_set_hash: trustSetHash };
}

function clearOnboardingTrustCheckpoints(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(ONBOARDING_READINESS_KEY);
  storage.removeItem(ONBOARDING_TRUST_APPROVAL_KEY);
  storage.removeItem(ONBOARDING_TRUST_INTENT_KEY);
}

function parseOnboardingTrustIntent(
  raw: string | null,
  account: string,
): OnboardingTrustIntent | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      Object.keys(value).length !== 3 || value.version !== 1 || value.account !== account ||
      typeof value.intent_id !== "string" ||
      !/^onboarding-trust-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.intent_id)
    ) return undefined;
    return value as OnboardingTrustIntent;
  } catch {
    return undefined;
  }
}

export function parseStoredOnboardingTrustApproval(
  raw: string | null,
  account: string,
): StoredOnboardingTrustApproval | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      Object.keys(value).length !== 7 || value.version !== 1 || value.account !== account ||
      value.network !== "testnet" || typeof value.delegate !== "string" ||
      !CLASSIC_ADDRESS.test(value.delegate) || typeof value.approval_id !== "string" ||
      value.approval_id.length === 0 || value.approval_id.length > 256 ||
      typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at)) ||
      !value.build || typeof value.build !== "object" || Array.isArray(value.build)
    ) return undefined;
    return value as StoredOnboardingTrustApproval;
  } catch {
    return undefined;
  }
}

export function clearTerminalPendingSubmission(
  cause: unknown,
  kind: ResumablePendingAction["kind"],
  storage: Pick<Storage, "removeItem">,
): OnboardingStepId | undefined {
  if (!(cause instanceof TerminalOnboardingSubmissionError)) return undefined;
  storage.removeItem("pilot:onboarding-pending");
  return kind === "trust" ? "fund" : kind === "revoke" ? "ready" : "delegate";
}

export function shouldUseLiveDevAcquisition(
  provider: WalletProvider,
  network: TestNetwork,
  mockMode: boolean,
): boolean {
  return provider === "dev" && network === "testnet" && !mockMode;
}

export function assertOfficialLiveDevRlusdConfig(
  config: PublicPilotConfig,
  provider: WalletProvider,
): void {
  if (!shouldUseLiveDevAcquisition(provider, config.network, config.mockMode)) return;
  if (
    harborIssuedCurrency(config.stableAsset.currency).toUpperCase() !== OFFICIAL_TESTNET_RLUSD_CURRENCY ||
    config.stableAsset.issuer !== OFFICIAL_TESTNET_RLUSD_ISSUER
  ) {
    throw new Error(
      "Live development-signer onboarding requires the exact official Testnet RLUSD currency and issuer.",
    );
  }
}

export function storedActiveOnboardingRecord(
  link: AccountLink,
  provider: WalletProvider,
  model: string,
  aiMode: "demo" | "openrouter" | "near-ai",
  txHash: string,
  ledger?: StoredLedgerOnboardingConfig,
): StoredActiveOnboardingRecord {
  if (
    !hasExactOnboardingPermissions(link) ||
    (link.network !== "testnet" && link.network !== "devnet") ||
    !CLASSIC_ADDRESS.test(link.owner) || !CLASSIC_ADDRESS.test(link.delegate) || !HASH.test(txHash) ||
    (provider === "ledger" ? !validStoredLedgerConfig(ledger) : ledger !== undefined)
  ) {
    throw new Error("Only an exact active onboarding delegation can be stored.");
  }
  return {
    version: 1,
    provider,
    account: link.owner,
    main_account: link.owner,
    budget_account: link.owner,
    network: link.network as TestNetwork,
    delegate: link.delegate,
    permissions: [...link.permissions],
    model,
    aiMode,
    status: "active",
    txHash,
    ...(provider === "ledger" ? { ledger } : {}),
  };
}

export function parseStoredActiveOnboardingRecord(
  raw: string | null,
): StoredActiveOnboardingRecord | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const allowed = new Set([
      "version", "provider", "account", "main_account", "budget_account", "network",
      "delegate", "permissions", "model", "aiMode", "status", "txHash", "ledger",
    ]);
    const providers = new Set<WalletProvider>(["ledger", "dev", "gemwallet", "crossmark", "xaman"]);
    const permissions = Array.isArray(value.permissions)
      ? value.permissions.filter((permission): permission is string => typeof permission === "string")
      : [];
    if (
      Object.keys(value).some((key) => !allowed.has(key)) || value.version !== 1 ||
      typeof value.provider !== "string" ||
      !providers.has(value.provider as WalletProvider) || typeof value.account !== "string" ||
      !CLASSIC_ADDRESS.test(value.account) ||
      value.main_account !== value.account || value.budget_account !== value.account ||
      (value.network !== "testnet" && value.network !== "devnet") ||
      typeof value.delegate !== "string" || !CLASSIC_ADDRESS.test(value.delegate) ||
      value.status !== "active" || typeof value.model !== "string" || value.model.length === 0 ||
      (value.aiMode !== "demo" && value.aiMode !== "openrouter" && value.aiMode !== "near-ai") ||
      typeof value.txHash !== "string" || !HASH.test(value.txHash) ||
      (value.provider === "ledger"
        ? !validStoredLedgerConfig(value.ledger)
        : value.ledger !== undefined) ||
      permissions.length !== DEFAULT_PERMISSIONS.length ||
      new Set(permissions).size !== DEFAULT_PERMISSIONS.length ||
      !DEFAULT_PERMISSIONS.every((permission) => permissions.includes(permission))
    ) return undefined;
    return { ...value, permissions } as StoredActiveOnboardingRecord;
  } catch {
    return undefined;
  }
}

export function defaultOnboardingWalletProvider(
  _config: Pick<PublicPilotConfig, "devSignerEnabled" | "ledger">,
): WalletProvider {
  return "gemwallet";
}

export function storedOnboardingWalletSession(
  provider: WalletProvider,
  network: TestNetwork,
  account: string,
  ledger?: StoredLedgerOnboardingConfig,
) {
  if (
    !CLASSIC_ADDRESS.test(account) ||
    (provider === "ledger" ? !validStoredLedgerConfig(ledger) : ledger !== undefined)
  ) {
    throw new Error("The wallet session record is invalid.");
  }
  return {
    provider,
    network,
    account,
    ...(provider === "ledger" ? { ledger } : {}),
  };
}

export async function restoreLedgerOnboardingWithoutDevice(
  session: WalletSessionStatus,
  record: StoredActiveOnboardingRecord,
  dependencies: {
    restoreLink: () => Promise<AccountLink>;
    /** Injected so tests can observe and prevent any mount-time device regression. */
    createWallet: () => OnboardingWallet;
    connectWallet: (wallet: OnboardingWallet) => Promise<void>;
    bindSession: (wallet: OnboardingWallet, account: string, network: TestNetwork) => Promise<void>;
  },
): Promise<
  | { status: "ready-without-device"; link: AccountLink }
  | { status: "explicit-reconnect-required" }
> {
  if (record.provider !== "ledger" || !ledgerSessionMatches(session, record)) {
    return { status: "explicit-reconnect-required" };
  }
  return { status: "ready-without-device", link: await dependencies.restoreLink() };
}

export function consumeExactOnboardingRevokeAction(
  location: Pick<Location, "pathname" | "search" | "hash">,
  replace: (path: string) => void,
): boolean {
  if (
    location.pathname !== "/onboarding" ||
    location.search !== "?action=revoke" ||
    location.hash !== ""
  ) return false;
  replace("/onboarding");
  return true;
}

type RequestedOnboardingRevocationContext = {
  provider: WalletProvider;
  walletConnected: boolean;
  sessionAuthenticated: boolean;
  account: string | undefined;
  network: TestNetwork | undefined;
  link: AccountLink | undefined;
  step: OnboardingStepId;
  busy: boolean;
  error: string | undefined;
  pendingKind: PendingAction["kind"] | undefined;
  persistedPendingSubmission: boolean;
};

export function supportsOnboardingRevocation(provider: WalletProvider): boolean {
  return provider === "dev" || provider === "ledger" ||
    provider === "gemwallet" || provider === "crossmark";
}

export async function dispatchRequestedOnboardingRevocation(
  request: { current: StoredActiveOnboardingRecord | undefined },
  context: RequestedOnboardingRevocationContext,
  prepare: () => Promise<void>,
): Promise<boolean> {
  const record = request.current;
  request.current = undefined;
  if (
    !record || record.aiMode !== "openrouter" ||
    context.busy || context.error !== undefined || context.step !== "ready" ||
    context.pendingKind !== undefined || context.persistedPendingSubmission ||
    record.provider !== context.provider || record.account !== context.account ||
    record.network !== context.network || record.delegate !== context.link?.delegate ||
    (context.link?.status !== "active" && context.link?.status !== "suspended") ||
    !hasVerifiedRevocationContext(context)
  ) return false;
  await prepare();
  return true;
}

export async function restoreActiveOnboardingLink(
  harbor: HarborClient,
  record: StoredActiveOnboardingRecord,
): Promise<AccountLink> {
  const response = await harbor.op("account.status", {
    owner: record.account,
    network: record.network,
  });
  if (!response.ok) throw new Error(response.error.message);
  const link = response.data;
  const cleanupOnlySuspended = supportsOnboardingRevocation(record.provider) &&
    record.network === "testnet" && link.status === "suspended";
  if (
    link.owner !== record.account || link.network !== record.network ||
    link.delegate !== record.delegate ||
    (link.status !== "active" && !cleanupOnlySuspended) ||
    !hasExactOnboardingPermissionList(link)
  ) {
    throw new Error(
      "The stored onboarding delegation no longer matches Harbor's exact active or cleanup-only owner, network, delegate, and permissions.",
    );
  }
  return link;
}

export function requiresDevRevocationBeforeExit(
  provider: WalletProvider,
  link: AccountLink | undefined,
): boolean {
  return provider === "dev" &&
    (link?.status === "active" || link?.status === "suspended") &&
    hasExactOnboardingPermissionList(link);
}

type RevocationRecoveryContext = {
  provider: WalletProvider;
  walletConnected: boolean;
  sessionAuthenticated: boolean;
  account: string | undefined;
  network: TestNetwork | undefined;
  link: AccountLink | undefined;
  step: OnboardingStepId;
  acquisitionStatus: AcquisitionStatus | undefined;
  blocked: boolean;
  pendingKind: PendingAction["kind"] | undefined;
  persistedPendingSubmission: boolean;
};

export function hasVerifiedRevocationContext(
  context: Pick<
    RevocationRecoveryContext,
    "provider" | "walletConnected" | "sessionAuthenticated" | "account" | "network" | "link"
  >,
): boolean {
  const { provider, walletConnected, sessionAuthenticated, account, network, link } = context;
  return supportsOnboardingRevocation(provider) && walletConnected && sessionAuthenticated &&
    network === "testnet" &&
    typeof account === "string" && account.length > 0 &&
    link?.owner === account && link.network === "testnet" &&
    typeof link.delegate === "string" && link.delegate.length > 0 &&
    (link.status === "active" || link.status === "suspended") &&
    hasExactOnboardingPermissionList(link);
}

export function shouldOfferRevocationRecovery(
  context: RevocationRecoveryContext,
): boolean {
  if (!hasVerifiedRevocationContext(context) || context.step === "ready") return false;
  if (
    context.pendingKind !== undefined || context.persistedPendingSubmission ||
    context.acquisitionStatus === "signed_pending"
  ) return false;
  const terminalAcquisition = context.acquisitionStatus === "failed" ||
    context.acquisitionStatus === "expired_unsubmitted" ||
    context.acquisitionStatus === "expired_unincluded";
  return terminalAcquisition || context.blocked;
}

export function revocationApprovalAction(provider: WalletProvider): string {
  return provider === "dev"
    ? "Revoke Harbor's delegation before destroying this browser key"
    : "Revoke Harbor's delegation for this exact Testnet account";
}

export function ledgerDelegateSetBlindSigningMessage(
  kind: "delegate" | "revoke",
): string {
  return kind === "revoke"
    ? "Ledger refused DelegateSet because blind signing is off. Enable it, match the Authorize address and the empty permission list, then review the revocation again."
    : "Ledger refused DelegateSet because blind signing is off. Enable it, match the Authorize address and all seven permission values, then review again.";
}

export async function finalizeVerifiedRevocationWallet(
  provider: WalletProvider,
  wallet: OnboardingWallet,
): Promise<void> {
  if (!supportsOnboardingRevocation(provider)) {
    throw new Error("This wallet provider does not support onboarding revocation.");
  }
  if (provider === "dev") {
    if (!wallet.markRevocationVerified || !wallet.forget) {
      throw new Error("This wallet provider cannot destroy the local development key.");
    }
    await wallet.markRevocationVerified();
    await wallet.forget();
    return;
  }
  // External wallets retain their own keys. This only releases Pilot's local
  // facade/session after Harbor and ledger history proved the revocation.
  if (wallet.forget) {
    await wallet.forget();
    return;
  }
  if (wallet.disconnect) {
    await wallet.disconnect();
    return;
  }
  throw new Error("This external wallet cannot safely disconnect after revocation.");
}

export async function finalizeValidatedOnboardingRevocation(
  provider: WalletProvider,
  wallet: OnboardingWallet,
  clearServerSession: () => Promise<void>,
  storage: Pick<Storage, "removeItem">,
): Promise<void> {
  // Do not discard any local recovery authority until the server session is
  // gone and the provider-specific wallet facade has safely finalized.
  await clearServerSession();
  await finalizeVerifiedRevocationWallet(provider, wallet);
  for (const key of VERIFIED_REVOCATION_CLEANUP_KEYS) storage.removeItem(key);
}

export function acquisitionPreflightChanged(
  expectedApprovalBinding: string,
  checked: RlusdAcquisitionRouteState,
): boolean {
  return checked.status !== "prepared" ||
    checked.approval_binding !== expectedApprovalBinding;
}

export function nextStepAfterValidatedTrust(
  provider: WalletProvider,
  network: TestNetwork,
  mockMode: boolean,
): OnboardingStepId {
  return shouldUseLiveDevAcquisition(provider, network, mockMode) ? "acquire" : "delegate";
}

export function acquisitionFaucetRequestBody(address: string, operationId: string) {
  if (!UUID.test(operationId)) throw new Error("The acquisition faucet operation id is invalid.");
  return {
    address,
    network: "testnet" as const,
    purpose: "rlusd-acquisition" as const,
    operation_id: operationId,
  };
}

type AcquisitionRequestBody =
  | { action: "initialize" | "prepare" }
  | {
      action: "preflight";
      operation_id: string;
      approval_binding: string;
    }
  | { action: "refresh" | "status"; operation_id: string }
  | { action: "submit"; operation_id: string; tx_blob: string };

export function rlusdAcquisitionRequestBody(
  action: "initialize" | "prepare",
): { action: "initialize" | "prepare" };
export function rlusdAcquisitionRequestBody(
  action: "refresh" | "status",
  operationId: string,
): { action: "refresh" | "status"; operation_id: string };
export function rlusdAcquisitionRequestBody(
  action: "submit",
  operationId: string,
  txBlob: string,
): { action: "submit"; operation_id: string; tx_blob: string };
export function rlusdAcquisitionRequestBody(
  action: "initialize" | "prepare" | "refresh" | "status" | "submit",
  operationId?: string,
  txBlob?: string,
) {
  if (action === "initialize" || action === "prepare") return { action } as const;
  if (!operationId || !UUID.test(operationId)) {
    throw new Error("The RLUSD acquisition operation id is invalid.");
  }
  if (action === "refresh" || action === "status") {
    return { action, operation_id: operationId } as const;
  }
  if (!txBlob) throw new Error("The signed RLUSD acquisition transaction is missing.");
  return { action, operation_id: operationId, tx_blob: txBlob } as const;
}

export function rlusdAcquisitionPreflightRequestBody(
  state: PreparedAcquisitionState,
): Extract<AcquisitionRequestBody, { action: "preflight" }> {
  if (
    !UUID.test(state.operation_id) || !/^[a-f0-9]{64}$/.test(state.approval_binding)
  ) throw new Error("The RLUSD acquisition approval binding is invalid.");
  return {
    action: "preflight",
    operation_id: state.operation_id,
    approval_binding: state.approval_binding,
  };
}

export function rlusdAcquisitionRecoveryRequestBody(
  hint: AcquisitionRecoveryHint,
  observed?: RlusdAcquisitionRouteState,
): { action: "refresh" | "status"; operation_id: string } {
  const action = observed?.status === "expired_unsubmitted" &&
      observed.operation_id === hint.operation_id && observed.owner === hint.account
    ? "refresh"
    : "status";
  return rlusdAcquisitionRequestBody(action, hint.operation_id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseRlusdAcquisitionRouteState(
  value: unknown,
  account: string,
): RlusdAcquisitionRouteState {
  if (!isRecord(value)) throw new Error("The RLUSD acquisition route returned an invalid response.");
  const allowed = new Set([
    "operation_id", "owner", "network", "status", "tx_json", "approval_expires_at",
    "approval_binding", "execution_contract", "build_revision",
    "hash", "ledger_index", "engine_result", "balance_before", "balance_before_ledger_index",
    "balance_after", "balance_after_ledger_index",
  ]);
  const statuses = new Set<AcquisitionStatus>([
    "initializing", "prepared", "signed_pending", "validated", "expired_unsubmitted",
    "expired_unincluded", "failed",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.operation_id !== "string" || !UUID.test(value.operation_id) ||
    value.owner !== account || value.network !== "testnet" ||
    typeof value.status !== "string" || !statuses.has(value.status as AcquisitionStatus)
  ) {
    throw new Error("The RLUSD acquisition route returned mismatched public state.");
  }
  const isV2 = value.execution_contract === "xrpl_execution_v2";
  if (
    (value.execution_contract !== undefined && !isV2) ||
    (value.build_revision !== undefined && (
      !isV2 || value.build_revision !== 1
    )) ||
    (isV2 && value.status !== "initializing" && value.build_revision === undefined)
  ) {
    throw new Error("The RLUSD acquisition route returned mismatched execution contract state.");
  }
  if (value.status === "prepared" && (
    !isRecord(value.tx_json) || typeof value.approval_expires_at !== "string" ||
    !Number.isFinite(Date.parse(value.approval_expires_at)) ||
    typeof value.approval_binding !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.approval_binding)
  )) {
    throw new Error("The RLUSD acquisition route did not return an exact owner approval.");
  }
  if (value.status === "prepared") {
    const tx = value.tx_json as Record<string, unknown>;
    const pays = tx.TakerPays;
    const allowedFields = new Set([
      "TransactionType", "Account", "TakerGets", "TakerPays", "Fee", "Sequence",
      "LastLedgerSequence", "Flags", "Expiration", "SourceTag", "Memos", "SigningPubKey",
    ]);
    const feeIsCanonical = typeof tx.Fee === "string" && /^(?:0|[1-9]\d*)$/.test(tx.Fee);
    const spendIsCanonical = typeof tx.TakerGets === "string" && /^[1-9]\d*$/.test(tx.TakerGets);
    const fee = feeIsCanonical ? BigInt(tx.Fee as string) : -1n;
    const spend = spendIsCanonical ? BigInt(tx.TakerGets as string) : ACQUISITION_CAP_DROPS + 1n;
    if (
      Object.keys(tx).some((field) => !allowedFields.has(field)) ||
      tx.TransactionType !== "OfferCreate" || tx.Account !== account ||
      tx.Flags !== ACQUISITION_FILL_OR_KILL || !spendIsCanonical ||
      spend > ACQUISITION_CAP_DROPS || !feeIsCanonical || fee > 100n || fee < 10n ||
      !Number.isSafeInteger(tx.Sequence) || Number(tx.Sequence) < 0 ||
      !Number.isSafeInteger(tx.LastLedgerSequence) || Number(tx.LastLedgerSequence) < 1 ||
      (tx.SigningPubKey !== undefined && tx.SigningPubKey !== "") ||
      !isRecord(pays) || pays.currency !== "524C555344000000000000000000000000000000" ||
      pays.issuer !== OFFICIAL_TESTNET_RLUSD_ISSUER ||
      pays.value !== RLUSD_ACQUISITION_EXACT_OUTPUT
    ) {
      throw new Error("The RLUSD acquisition route did not return the exact safe 75 RLUSD approval.");
    }
  }
  if ((value.status === "signed_pending" || value.status === "validated") && (
    typeof value.hash !== "string" || !HASH.test(value.hash)
  )) {
    throw new Error("The RLUSD acquisition route returned an invalid transaction hash.");
  }
  if (
    (value.balance_before !== undefined && (
      typeof value.balance_before !== "string" ||
      !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.balance_before) ||
      !Number.isSafeInteger(value.balance_before_ledger_index)
    )) ||
    (value.balance_after !== undefined && (
      typeof value.balance_after !== "string" ||
      !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.balance_after) ||
      !Number.isSafeInteger(value.balance_after_ledger_index)
    ))
  ) {
    throw new Error("The RLUSD acquisition route returned invalid public balance evidence.");
  }
  if (value.status === "validated" && (
    !Number.isSafeInteger(value.ledger_index) || value.engine_result !== "tesSUCCESS"
  )) {
    throw new Error("The RLUSD acquisition did not validate successfully.");
  }
  return value as RlusdAcquisitionRouteState;
}

export function acquisitionRecoveryHint(
  state: RlusdAcquisitionRouteState,
): AcquisitionRecoveryHint {
  return { operation_id: state.operation_id, account: state.owner, network: state.network };
}

export function parseAcquisitionRecoveryHint(
  raw: string | null,
  account: string,
): AcquisitionRecoveryHint | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      Object.keys(value).length !== 3 || typeof value.operation_id !== "string" ||
      !UUID.test(value.operation_id) || value.account !== account || value.network !== "testnet"
    ) return undefined;
    return value as AcquisitionRecoveryHint;
  } catch {
    return undefined;
  }
}

type AcquisitionTransport = (
  body: AcquisitionRequestBody,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function fetchRlusdAcquisition(
  body: AcquisitionRequestBody,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  return fetch("/api/dev/rlusd-acquisition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function requestRlusdAcquisition(
  body: AcquisitionRequestBody,
  account: string,
  transport: AcquisitionTransport = fetchRlusdAcquisition,
): Promise<RlusdAcquisitionRouteState> {
  const response = await transport(body);
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
      throw new Error(payload.error.message);
    }
    const terminal = parseRlusdAcquisitionRouteState(payload, account);
    throw new Error(`The RLUSD acquisition is ${terminal.status.replaceAll("_", " ")}.`);
  }
  const state = parseRlusdAcquisitionRouteState(payload, account);
  if (body.action === "submit" && !(
    (response.status === 200 && state.status === "validated") ||
    (response.status === 202 && state.status === "signed_pending")
  )) {
    throw new Error("The RLUSD acquisition submit route returned an invalid status transition.");
  }
  return state;
}

export async function recoverRlusdAcquisition(
  hint: AcquisitionRecoveryHint,
  transport: AcquisitionTransport = fetchRlusdAcquisition,
): Promise<RlusdAcquisitionRouteState> {
  return requestRlusdAcquisition(
    rlusdAcquisitionRequestBody("status", hint.operation_id),
    hint.account,
    transport,
  );
}

export async function waitForValidatedRlusdAcquisition(
  hint: AcquisitionRecoveryHint,
  options: PollOptions = {},
  transport: AcquisitionTransport = fetchRlusdAcquisition,
): Promise<RlusdAcquisitionRouteState> {
  const poll = resolvedPollOptions(options);
  let state: RlusdAcquisitionRouteState | undefined;
  for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
    state = await recoverRlusdAcquisition(hint, transport);
    if (state.status === "validated") return state;
    if (state.status !== "signed_pending") {
      throw new Error(`The RLUSD acquisition is ${state.status.replaceAll("_", " ")}.`);
    }
    if (attempt + 1 < poll.attempts) await poll.sleep(poll.delayMs);
  }
  return state!;
}

const DEFAULT_POLL_OPTIONS = {
  attempts: 20,
  delayMs: 1_000,
  sleep: (delayMs: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs)),
} satisfies Required<PollOptions>;

function resolvedPollOptions(options: PollOptions): Required<PollOptions> {
  return { ...DEFAULT_POLL_OPTIONS, ...options };
}

function validatedLedgerIndex(result: {
  ledger_index?: number;
  validated?: boolean;
}): number {
  if (result.validated !== true || !Number.isSafeInteger(result.ledger_index)) {
    throw new Error("Harbor did not return validated-ledger progress.");
  }
  return result.ledger_index!;
}

function hasExactOnboardingPermissionList(link: AccountLink): boolean {
  return link.permissions.length === DEFAULT_PERMISSIONS.length &&
    DEFAULT_PERMISSIONS.every((permission, index) => link.permissions[index] === permission);
}

export function hasExactOnboardingPermissions(link: AccountLink): boolean {
  return link.status === "active" && hasExactOnboardingPermissionList(link);
}

function exactOnboardingPolicy(): Policy {
  return {
    ...DEFAULT_POLICY,
    allowed_tx_types: [...DEFAULT_PERMISSIONS],
    issuer_allowlist: [...DEFAULT_POLICY.issuer_allowlist],
    networks: [...DEFAULT_POLICY.networks],
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function ensureExactOnboardingPolicy(
  harbor: HarborClient,
  owner: string,
  network: TestNetwork,
): Promise<Policy> {
  const expected = exactOnboardingPolicy();
  const set = await harbor.op("policy.set", { owner, network, policy: expected });
  if (!set.ok) throw new Error(set.error.message);
  if (canonicalJson(set.data) !== canonicalJson(expected)) {
    throw new Error("Harbor did not persist the exact approved onboarding policy.");
  }
  const read = await harbor.op("policy.get", { owner, network });
  if (!read.ok) throw new Error(read.error.message);
  if (canonicalJson(read.data) !== canonicalJson(expected)) {
    throw new Error("Harbor policy verification did not match the exact approved onboarding policy.");
  }
  return read.data;
}

export async function requireLiveOnboardingReadiness(
  harbor: HarborClient,
  link: AccountLink,
  trustSetHash: string,
): Promise<void> {
  if (!hasExactOnboardingPermissions(link) || link.network !== "testnet" || !HASH.test(trustSetHash)) {
    throw new Error("Onboarding readiness requires the exact active link and TrustSet hash.");
  }
  const response = await harbor.op("onboarding.readiness", {
    owner: link.owner,
    network: "testnet",
    expected_policy: exactOnboardingPolicy(),
    trust_set_hash: trustSetHash,
  });
  if (!response.ok) throw new Error(response.error.message);
  const result = response.data;
  if (
    !result.ready || result.scope.owner !== link.owner || result.scope.network !== "testnet" ||
    !Object.values(result.checks).every(Boolean) ||
    result.evidence.delegate !== link.delegate ||
    result.evidence.trust_set_hash?.toUpperCase() !== trustSetHash ||
    !Number.isSafeInteger(result.evidence.link_ledger_index) ||
    !Number.isSafeInteger(result.evidence.trust_set_ledger_index) ||
    !result.checks.usable_trust_line ||
    !Number.isSafeInteger(result.evidence.trust_line_ledger_index)
  ) {
    throw new Error("Harbor did not attest the exact local onboarding handoff as ready.");
  }
}

export async function hasExactConfiguredTrustLine(
  harbor: HarborClient,
  account: string,
  network: TestNetwork,
  stableAsset: PublicPilotConfig["stableAsset"],
): Promise<boolean> {
  const lines = await harbor.op("ledger.account.lines", {
    account,
    network,
    ledger_index: "validated",
    peer: stableAsset.issuer,
  });
  return lines.ok && lines.data.account === account && lines.data.validated === true &&
    lines.data.lines.some((line) => isExpectedTrustLine(line, stableAsset));
}

export async function requireExactConfiguredTrustLine(
  harbor: HarborClient,
  account: string,
  network: TestNetwork,
  stableAsset: PublicPilotConfig["stableAsset"],
): Promise<void> {
  if (!await hasExactConfiguredTrustLine(harbor, account, network, stableAsset)) {
    throw new TerminalOnboardingSubmissionError(
      "The validated TrustSet did not create the exact configured trust line.",
    );
  }
}

export async function requireActivatedDelegateAccount(
  harbor: HarborClient,
  link: AccountLink,
): Promise<void> {
  if (
    !hasExactOnboardingPermissionList(link) || link.network !== "testnet" ||
    (link.status !== "pending" && link.status !== "active")
  ) {
    throw new Error("The Harbor delegate is not the exact pending or active Testnet onboarding link.");
  }
  const response = await harbor.op("ledger.account.info", {
    account: link.delegate,
    network: "testnet",
    ledger_index: "validated",
  });
  if (
    !response.ok || response.data.validated !== true ||
    response.data.account_data.Account !== link.delegate
  ) {
    throw new Error(
      `Fund Harbor delegate ${link.delegate} with Testnet XRP outside Harbor, then check again.`,
    );
  }
}

export async function prepareLiveOnboardingTrust(
  harbor: HarborClient,
  link: AccountLink,
  stableAsset: PublicPilotConfig["stableAsset"],
  intentId = `onboarding-trust-${stableAsset.currency.toLowerCase()}`,
): Promise<PreparedLiveOnboardingTrust> {
  if (
    link.network !== "testnet" || !hasExactOnboardingPermissions(link) ||
    !CLASSIC_ADDRESS.test(link.owner) || !CLASSIC_ADDRESS.test(link.delegate)
  ) {
    throw new Error("Live onboarding requires the exact active Testnet delegation before TrustSet execution.");
  }
  const policy = await harbor.op("policy.get", { owner: link.owner, network: "testnet" });
  if (!policy.ok) throw new Error(policy.error.message);
  const build = await harbor.op("tx.trustSet", {
    account: link.owner,
    network: "testnet",
    intent_id: intentId,
    limit_amount: {
      currency: harborIssuedCurrency(stableAsset.currency),
      issuer: stableAsset.issuer!,
      value: "10000",
    },
  });
  if (!build.ok) throw new Error(build.error.message);
  const accountInfo = await harbor.op("ledger.account.info", {
    account: link.owner,
    network: "testnet",
    ledger_index: "validated",
  });
  if (!accountInfo.ok) throw new Error(accountInfo.error.message);
  const accountSequence = accountInfo.data.account_data.Sequence;
  if (!Number.isSafeInteger(accountSequence)) {
    throw new Error("Harbor did not return the validated account sequence.");
  }
  const signable = signableTrustBuild(build.data);
  assertSafeTrustSet(
    signable,
    link.owner,
    "testnet",
    stableAsset,
    validatedLedgerIndex(accountInfo.data),
    Number(accountSequence),
  );
  return {
    status: "prepared",
    action: {
      kind: "trust",
      build: signable,
      intentId,
      expectedDelegate: link.delegate,
    },
  };
}

export async function confirmPreparedLiveOnboardingPolicy(
  harbor: HarborClient,
  link: AccountLink,
  prepared: PreparedLiveOnboardingTrust,
): Promise<PolicyConfirmedLiveOnboardingTrust> {
  if (
    prepared.status !== "prepared" || prepared.action.kind !== "trust" ||
    link.network !== "testnet" || !hasExactOnboardingPermissions(link) ||
    link.delegate !== prepared.action.expectedDelegate ||
    prepared.action.build.network !== "testnet" ||
    prepared.action.build.tx_json.Account !== link.owner
  ) {
    throw new Error("The prepared TrustSet no longer matches the exact active Testnet delegation.");
  }
  await ensureExactOnboardingPolicy(harbor, link.owner, "testnet");
  return { status: "policy_confirmed", action: prepared.action };
}

export async function executePreparedLiveOnboardingTrust(
  harbor: HarborClient,
  link: AccountLink,
  stableAsset: PublicPilotConfig["stableAsset"],
  prepared: PolicyConfirmedLiveOnboardingTrust,
  confirmExecution: () => Promise<void>,
): Promise<OnboardingTrustExecution> {
  if (
    prepared.status !== "policy_confirmed" || prepared.action.kind !== "trust" ||
    link.network !== "testnet" || !hasExactOnboardingPermissions(link) ||
    link.delegate !== prepared.action.expectedDelegate ||
    prepared.action.build.network !== "testnet" ||
    prepared.action.build.tx_json.Account !== link.owner
  ) {
    throw new Error("The prepared TrustSet no longer matches the exact active Testnet delegation.");
  }
  const active = await harbor.op("account.status", { owner: link.owner, network: "testnet" });
  if (
    !active.ok || active.data.status !== "active" ||
    !hasExactOnboardingPermissions(active.data) ||
    active.data.delegate !== link.delegate
  ) {
    throw new Error("Harbor no longer reports the exact active onboarding delegation.");
  }
  const policy = await harbor.op("policy.get", { owner: link.owner, network: "testnet" });
  if (!policy.ok) throw new Error(policy.error.message);
  if (canonicalJson(policy.data) !== canonicalJson(exactOnboardingPolicy())) {
    throw new Error("Harbor policy changed after TrustSet preparation.");
  }
  const accountInfo = await harbor.op("ledger.account.info", {
    account: link.owner,
    network: "testnet",
    ledger_index: "validated",
  });
  if (!accountInfo.ok) throw new Error(accountInfo.error.message);
  const accountSequence = accountInfo.data.account_data.Sequence;
  if (!Number.isSafeInteger(accountSequence)) {
    throw new Error("Harbor did not return the validated account sequence.");
  }
  const signable = signableTrustBuild(prepared.action.build);
  assertSafeTrustSet(
    signable,
    link.owner,
    "testnet",
    stableAsset,
    validatedLedgerIndex(accountInfo.data),
    Number(accountSequence),
  );
  await confirmExecution();
  const execution = await harbor.op("tx.execute", {
    build_id: signable.build_id,
    idempotency_key: prepared.action.intentId,
  });
  if (!execution.ok) throw new Error(execution.error.message);
  if (execution.data.status === "executed") {
    if (!HASH.test(execution.data.hash) || execution.data.signed_by !== "delegate") {
      throw new Error("Harbor returned invalid delegated TrustSet execution evidence.");
    }
    return { status: "executed", hash: execution.data.hash };
  }
  if (execution.data.status !== "needs_approval") {
    throw new Error(
      execution.data.status === "failed"
        ? execution.data.detail
        : "Harbor policy blocked the onboarding TrustSet.",
    );
  }
  if (
    !execution.data.approval_id || execution.data.policy.verdict !== "needs_approval" ||
    !Number.isFinite(Date.parse(execution.data.expires_at)) ||
    Date.parse(execution.data.expires_at) <= Date.now() ||
    canonicalJson(execution.data.tx_json) !== canonicalJson(signable.tx_json)
  ) {
    throw new Error("Harbor returned an invalid or mismatched TrustSet owner approval.");
  }
  const approvedBuild = { ...signable, tx_json: execution.data.tx_json };
  assertSafeTrustSet(
    approvedBuild,
    link.owner,
    "testnet",
    stableAsset,
    validatedLedgerIndex(accountInfo.data),
    Number(accountSequence),
  );
  return {
    status: "needs_approval",
    action: {
      kind: "trust",
      build: approvedBuild,
      approvalId: execution.data.approval_id,
      expiresAt: execution.data.expires_at,
      expectedDelegate: link.delegate,
    },
  };
}

export async function confirmLiveOnboardingTrustExecutionCapability(
  prepared: PolicyConfirmedLiveOnboardingTrust,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl("/api/onboarding/trustset/confirm-execution", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      build_id: prepared.action.build.build_id,
      idempotency_key: prepared.action.intentId,
      tx_json: prepared.action.build.tx_json,
    }),
    cache: "no-store",
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => undefined) as
    | { confirmed?: unknown; build_id?: unknown; idempotency_key?: unknown; error?: { message?: unknown } }
    | undefined;
  if (
    !response.ok || body?.confirmed !== true ||
    body.build_id !== prepared.action.build.build_id ||
    body.idempotency_key !== prepared.action.intentId
  ) {
    throw new Error(
      typeof body?.error?.message === "string"
        ? body.error.message
        : "TrustSet execution confirmation could not be recorded.",
    );
  }
}

export async function waitForValidatedSubmission(
  harbor: HarborClient,
  submission: TxSubmitResult | { hash: string; validated: false },
  account: string,
  network: TestNetwork,
  lastLedgerSequence?: number,
  options: PollOptions = {},
): Promise<ApprovalSubmission> {
  if ("status" in submission) throw new TerminalOnboardingSubmissionError(submission.detail);
  if (submission.validated) {
    if (submission.engine_result !== "tesSUCCESS") {
      throw new TerminalOnboardingSubmissionError(
        `The transaction validated with ${submission.engine_result}, not tesSUCCESS.`,
      );
    }
    return { status: "validated", hash: submission.hash };
  }

  const poll = resolvedPollOptions(options);
  for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
    const response = await harbor.op("tx.status", {
      hash: submission.hash,
      account,
      network,
    });
    if (!response.ok) throw new Error(response.error.message);
    if (
      response.data.hash.toUpperCase() !== submission.hash.toUpperCase() ||
      response.data.network !== network
    ) {
      throw new AmbiguousOnboardingSubmissionError(
        "Harbor returned transaction status for a different hash or network.",
      );
    }
    if (response.data.validated) {
      if (response.data.engine_result !== "tesSUCCESS") {
        throw new TerminalOnboardingSubmissionError(
          `The transaction validated with ${response.data.engine_result}, not tesSUCCESS.`,
        );
      }
      return { status: "validated", hash: response.data.hash };
    }
    if (lastLedgerSequence !== undefined) {
      const accountInfo = await harbor.op("ledger.account.info", {
        account,
        network,
        ledger_index: "validated",
      });
      if (!accountInfo.ok) throw new Error(accountInfo.error.message);
      if (validatedLedgerIndex(accountInfo.data) > lastLedgerSequence) {
        throw new TerminalOnboardingSubmissionError(
          "The signed transaction expired before validation. Build a fresh transaction.",
        );
      }
    }
    if (attempt + 1 < poll.attempts) await poll.sleep(poll.delayMs);
  }
  return { status: "pending", hash: submission.hash };
}

type DirectTrustSetStatus = {
  hash: string;
  network: TestNetwork;
  validated: boolean;
  ledger_index?: number;
  engine_result?: string;
};

function parseDirectTrustSetStatus(value: unknown, accountNetwork: TestNetwork): DirectTrustSetStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The TrustSet relay returned an invalid response.");
  }
  const result = value as Record<string, unknown>;
  const allowed = new Set(["hash", "network", "validated", "ledger_index", "engine_result"]);
  if (
    Object.keys(result).some((key) => !allowed.has(key)) ||
    typeof result.hash !== "string" || !/^[A-Fa-f0-9]{64}$/.test(result.hash) ||
    result.network !== accountNetwork || typeof result.validated !== "boolean" ||
    (result.engine_result !== undefined && typeof result.engine_result !== "string") ||
    (result.ledger_index !== undefined && !Number.isSafeInteger(result.ledger_index)) ||
    (result.validated && (
      typeof result.engine_result !== "string" || !Number.isSafeInteger(result.ledger_index)
    ))
  ) {
    throw new Error("The TrustSet relay returned an invalid response.");
  }
  return result as DirectTrustSetStatus;
}

async function callDirectTrustSet(
  body: { action: "authorize" | "submit"; tx_blob: string } | { action: "status"; hash: string },
  network: TestNetwork,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectTrustSetStatus> {
  const response = await fetchImpl("/api/dev/trustset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => undefined) as
    | { error?: { message?: string } }
    | undefined;
  if (!response.ok) throw new Error(payload?.error?.message || "The TrustSet relay request failed.");
  return parseDirectTrustSetStatus(payload, network);
}

type DirectTrustSetTransport = (
  body: { action: "authorize" | "submit"; tx_blob: string } | { action: "status"; hash: string },
) => Promise<DirectTrustSetStatus>;

export async function authorizePersistAndSubmitDirectTrustSet(
  txBlob: string,
  expectedHash: string,
  action: Extract<PendingAction, { kind: "trust" }>,
  account: string,
  network: TestNetwork,
  storage: Pick<Storage, "setItem">,
  transport: DirectTrustSetTransport = (body) => callDirectTrustSet(body, network),
): Promise<DirectTrustSetStatus> {
  // Status polling is capability-bound by the authorize response cookie. Do not
  // persist a resumable hash until that capability exists: a rejected authorize
  // request must be rebuilt instead of trapping reconnect in an unauthorized poll.
  const authorized = await transport({ action: "authorize", tx_blob: txBlob });
  if (authorized.hash.toUpperCase() !== expectedHash.toUpperCase()) {
    throw new TerminalOnboardingSubmissionError(
      "The TrustSet relay authorized a mismatched transaction hash.",
    );
  }
  storage.setItem(
    "pilot:onboarding-pending",
    JSON.stringify(pendingSubmissionRecord(action, expectedHash, account, network)),
  );
  // Persist immediately before dispatch so a transport failure after the provider
  // receives the request resumes by hash instead of asking the wallet to sign again.
  const submitted = await transport({ action: "submit", tx_blob: txBlob });
  if (submitted.hash.toUpperCase() !== expectedHash.toUpperCase()) {
    throw new TerminalOnboardingSubmissionError(
      "The TrustSet provider returned a mismatched transaction hash.",
    );
  }
  return submitted;
}

function isExpectedTrustLine(
  line: Record<string, unknown>,
  stableAsset: PublicPilotConfig["stableAsset"],
): boolean {
  const expectedCurrencies = new Set([
    stableAsset.currency.toUpperCase(),
    harborIssuedCurrency(stableAsset.currency).toUpperCase(),
  ]);
  return line.account === stableAsset.issuer &&
    typeof line.currency === "string" && expectedCurrencies.has(line.currency.toUpperCase()) &&
    line.limit === "10000";
}

export async function waitForValidatedDirectTrustSet(
  harbor: HarborClient,
  submission: DirectTrustSetStatus,
  account: string,
  network: TestNetwork,
  stableAsset: PublicPilotConfig["stableAsset"],
  lastLedgerSequence: number,
  options: PollOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ApprovalSubmission> {
  const poll = resolvedPollOptions(options);
  for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
    let status: DirectTrustSetStatus;
    try {
      status = submission.validated
        ? submission
        : await callDirectTrustSet({ action: "status", hash: submission.hash }, network, fetchImpl);
    } catch (cause) {
      // A missing/expired status capability must not trap an already expired hash
      // forever. Preserve the original retryable error while the ledger window is
      // live, but make ledger-confirmed expiry terminal so reconnect can rebuild.
      const accountInfo = await harbor.op("ledger.account.info", {
        account,
        network,
        ledger_index: "validated",
      });
      if (!accountInfo.ok) throw cause;
      if (validatedLedgerIndex(accountInfo.data) > lastLedgerSequence) {
        throw new TerminalOnboardingSubmissionError(
          "The signed TrustSet expired before validation. Build a fresh transaction.",
        );
      }
      throw cause;
    }
    if (status.hash.toUpperCase() !== submission.hash.toUpperCase()) {
      throw new Error("The TrustSet relay returned a mismatched transaction hash.");
    }
    if (status.validated) {
      if (status.engine_result !== "tesSUCCESS") {
        throw new TerminalOnboardingSubmissionError(
          `The TrustSet validated with ${status.engine_result}, not tesSUCCESS.`,
        );
      }
      await requireExactConfiguredTrustLine(harbor, account, network, stableAsset);
      return { status: "validated", hash: status.hash };
    }
    const accountInfo = await harbor.op("ledger.account.info", {
      account,
      network,
      ledger_index: "validated",
    });
    if (!accountInfo.ok) throw new Error(accountInfo.error.message);
    if (validatedLedgerIndex(accountInfo.data) > lastLedgerSequence) {
      throw new TerminalOnboardingSubmissionError(
        "The signed TrustSet expired before validation. Build a fresh transaction.",
      );
    }
    if (attempt + 1 < poll.attempts) await poll.sleep(poll.delayMs);
  }
  return { status: "pending", hash: submission.hash };
}

export async function waitForActiveOnboardingLink(
  harbor: HarborClient,
  owner: string,
  network: TestNetwork,
  expectedDelegate: string,
  submissionHash: string,
  options: PollOptions = {},
): Promise<AccountLink> {
  const poll = resolvedPollOptions(options);
  for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
    const response = await harbor.op("account.status", { owner, network });
    if (!response.ok) {
      const retryable =
        response.error.kind === "soft-empty" ||
        response.error.code === "LINK_NOT_FOUND" ||
        response.error.code === "NOT_FOUND";
      if (retryable && attempt + 1 < poll.attempts) {
        await poll.sleep(poll.delayMs);
        continue;
      }
      throw new Error(response.error.message);
    }
    const link = response.data;
    if (link.owner !== owner || link.network !== network) {
      throw new Error("Harbor returned delegation status for a different account or network.");
    }
    if (link.status === "active") {
      if (link.delegate !== expectedDelegate) {
        throw new TerminalOnboardingSubmissionError(
          "A different delegate became active while onboarding was pending.",
        );
      }
      if (!hasExactOnboardingPermissions(link)) {
        throw new TerminalOnboardingSubmissionError(
          "The active delegation does not contain exactly the seven required permissions.",
        );
      }
      const history = await harbor.op("ledger.account.tx", {
        account: owner,
        network,
        ledger_index_min: -1,
        ledger_index_max: -1,
        limit: 100,
      });
      if (!history.ok) throw new Error(history.error.message);
      const matching = history.data.transactions.find((record) => {
        const transaction = record.tx ?? record.tx_json;
        const meta = record.meta && typeof record.meta === "object" ? record.meta : undefined;
        const hash = record.hash ?? (typeof transaction?.hash === "string" ? transaction.hash : undefined);
        return hash === submissionHash && record.validated === true &&
          transaction?.TransactionType === "DelegateSet" &&
          transaction.Account === owner &&
          transaction.Authorize === expectedDelegate &&
          meta?.TransactionResult === "tesSUCCESS";
      });
      if (matching) return link;
    }
    if (link.status === "revoked" || link.status === "suspended") {
      throw new TerminalOnboardingSubmissionError(
        `The delegation is ${link.status}; onboarding cannot mark it ready.`,
      );
    }
    if (attempt + 1 < poll.attempts) await poll.sleep(poll.delayMs);
  }
  throw new Error("The delegation is still pending activation. Check its status before retrying.");
}

export async function waitForRevokedOnboardingLink(
  harbor: HarborClient,
  owner: string,
  network: TestNetwork,
  expectedDelegate: string,
  submissionHash: string,
  options: PollOptions = {},
): Promise<AccountLink> {
  const poll = resolvedPollOptions(options);
  for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
    const response = await harbor.op("account.status", { owner, network });
    if (!response.ok) throw new Error(response.error.message);
    const link = response.data;
    if (
      link.owner !== owner || link.network !== network ||
      link.delegate !== expectedDelegate
    ) {
      throw new AmbiguousOnboardingSubmissionError(
        "Harbor returned revocation status for a different owner, network, or delegate.",
      );
    }
    if (link.status === "revoked") {
      if (
        link.permissions.length !== 0 || link.revoke_tx !== undefined ||
        link.delegate_set_tx !== undefined
      ) {
        throw new AmbiguousOnboardingSubmissionError(
          "Harbor returned an inconsistent revoked delegation state.",
        );
      }
      const history = await harbor.op("ledger.account.tx", {
        account: owner,
        network,
        ledger_index_min: -1,
        ledger_index_max: -1,
        limit: 100,
      });
      if (!history.ok) throw new Error(history.error.message);
      const matching = history.data.transactions.find((record) => {
        const transaction = record.tx ?? record.tx_json;
        const meta = record.meta && typeof record.meta === "object" ? record.meta : undefined;
        const hash = record.hash ?? (typeof transaction?.hash === "string" ? transaction.hash : undefined);
        return hash === submissionHash && record.validated === true &&
          transaction?.TransactionType === "DelegateSet" &&
          transaction.Account === owner && transaction.Authorize === expectedDelegate &&
          Array.isArray(transaction.Permissions) && transaction.Permissions.length === 0 &&
          meta?.TransactionResult === "tesSUCCESS";
      });
      if (matching) return link;
    }
    if (link.status === "active" || link.status === "suspended") {
      if (!hasExactOnboardingPermissionList(link)) {
        throw new AmbiguousOnboardingSubmissionError(
          "Harbor returned inconsistent permissions while revocation was pending.",
        );
      }
    }
    if (attempt + 1 < poll.attempts) await poll.sleep(poll.delayMs);
  }
  throw new Error("The delegation revocation is not yet proven on the validated ledger.");
}

export function devFundRequestBody(address: string, network: TestNetwork) {
  return { address, network };
}

export async function requireActivatedAccount(
  harbor: HarborClient,
  account: string,
  network: TestNetwork,
  _provider: WalletProvider,
  poll: PollOptions = {
    attempts: 12,
    delayMs: 1_000,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  },
): Promise<void> {
  const resolved = resolvedPollOptions(poll);
  let lastMessage = "account activation is not yet validated";
  for (let attempt = 0; attempt < resolved.attempts; attempt += 1) {
    const response = await harbor.op("ledger.account.info", {
      account,
      network,
      ledger_index: "validated",
    });
    if (response.ok && response.data.validated) return;
    lastMessage = response.ok ? "account activation is not yet validated" : response.error.message;
    if (attempt + 1 < resolved.attempts) await resolved.sleep(resolved.delayMs);
  }
  throw new Error(
    `Pilot could not verify that wallet ${account} is activated on ${network} after the public faucet request: ${lastMessage}`,
  );
}

function destinationFrom(txJson: Record<string, unknown>) {
  for (const key of ["Destination", "Delegate", "VaultID"]) {
    if (typeof txJson[key] === "string") return txJson[key];
  }
  return undefined;
}

function signableTrustBuild(build: TxBuild): TxBuild {
  return {
    ...build,
    tx_json: normalizeIssuedCurrencyCodes(build.tx_json),
  };
}

function harborIssuedCurrency(currency: string): string {
  if (currency.length === 3 || /^[A-Fa-f0-9]{40}$/.test(currency)) {
    return currency.toUpperCase();
  }
  const bytes = new TextEncoder().encode(currency);
  if (bytes.length < 4 || bytes.length > 20) {
    throw new Error("The configured stablecoin currency is not XRPL-compatible.");
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .padEnd(40, "0")
    .toUpperCase();
}

function assertSafeFeeAndExpiry(
  tx: Record<string, unknown>,
  validatedLedgerIndex: number,
  validatedAccountSequence: number,
): void {
  const fee = typeof tx.Fee === "string" ? Number(tx.Fee) : Number.NaN;
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > 100) {
    throw new Error("Harbor returned an onboarding transaction with an unsafe fee.");
  }
  if (!Number.isSafeInteger(tx.Sequence) || Number(tx.Sequence) !== validatedAccountSequence) {
    throw new Error("Harbor returned an onboarding transaction with an invalid sequence.");
  }
  if (
    !Number.isSafeInteger(tx.LastLedgerSequence) ||
    Number(tx.LastLedgerSequence) <= validatedLedgerIndex ||
    Number(tx.LastLedgerSequence) > validatedLedgerIndex + 50
  ) {
    throw new Error("Harbor returned an expired or excessively long-lived onboarding transaction.");
  }
}

function assertOnlyFields(tx: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(tx).find((field) => !allowedSet.has(field));
  if (unexpected) {
    throw new Error(`Harbor returned an unexpected onboarding transaction field: ${unexpected}.`);
  }
}

export function assertSafeTrustSet(
  build: TxBuild,
  account: string,
  network: TestNetwork,
  stableAsset: PublicPilotConfig["stableAsset"],
  validatedLedgerIndex: number,
  validatedAccountSequence: number,
): void {
  const tx = build.tx_json;
  assertOnlyFields(tx, [
    "TransactionType", "Account", "LimitAmount", "Fee", "Sequence",
    "LastLedgerSequence", "Flags", "SourceTag", "Memos", "SigningPubKey",
  ]);
  if (build.network !== network || tx.TransactionType !== "TrustSet" || tx.Account !== account) {
    throw new Error("The TrustSet does not match the connected account and network.");
  }
  if (
    build.simulate.applied !== false || build.simulate.engine_result !== "tesSUCCESS" ||
    build.preflight.length === 0 || build.preflight.some((check) => !check.pass)
  ) {
    throw new Error("The TrustSet did not pass Harbor simulation and preflight checks.");
  }
  const limit = tx.LimitAmount;
  if (
    !limit || typeof limit !== "object" || Array.isArray(limit) ||
    (limit as Record<string, unknown>).currency !== harborIssuedCurrency(stableAsset.currency) ||
    (limit as Record<string, unknown>).issuer !== stableAsset.issuer ||
    (limit as Record<string, unknown>).value !== "10000"
  ) {
    throw new Error("The TrustSet limit does not match the displayed stablecoin trust line.");
  }
  if (tx.Flags !== undefined && tx.Flags !== 0) {
    throw new Error("The TrustSet contains unexpected flags.");
  }
  if (tx.SigningPubKey !== undefined && tx.SigningPubKey !== "") {
    throw new Error("The TrustSet is not an unsigned transaction.");
  }
  assertSafeFeeAndExpiry(tx, validatedLedgerIndex, validatedAccountSequence);
}

export function assertSafeDelegateSet(
  link: AccountLink,
  account: string,
  network: TestNetwork,
  validatedLedgerIndex: number,
  validatedAccountSequence: number,
): void {
  const tx = link.delegate_set_tx;
  if (!tx) throw new Error("Harbor did not prepare a DelegateSet transaction.");
  assertOnlyFields(tx, [
    "TransactionType", "Account", "Authorize", "Permissions", "Fee", "Sequence",
    "LastLedgerSequence", "Flags", "SourceTag", "Memos", "SigningPubKey",
  ]);
  const permissions = Array.isArray(tx.Permissions)
    ? tx.Permissions.map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as { Permission?: { PermissionValue?: unknown } }).Permission?.PermissionValue
        : undefined,
    )
    : [];
  if (
    link.owner !== account || link.network !== network ||
    tx.TransactionType !== "DelegateSet" || tx.Account !== account ||
    tx.Authorize !== link.delegate ||
    permissions.length !== DEFAULT_PERMISSIONS.length ||
    !DEFAULT_PERMISSIONS.every((permission, index) => permissions[index] === permission)
  ) {
    throw new Error("The DelegateSet does not match the displayed delegate and seven permissions.");
  }
  if (tx.Flags !== undefined && tx.Flags !== 0) {
    throw new Error("The DelegateSet contains unexpected flags.");
  }
  if (tx.SigningPubKey !== undefined && tx.SigningPubKey !== "") {
    throw new Error("The DelegateSet is not an unsigned transaction.");
  }
  assertSafeFeeAndExpiry(tx, validatedLedgerIndex, validatedAccountSequence);
}

export function assertSafeRevoke(
  result: AccountLink,
  account: string,
  network: TestNetwork,
  currentDelegate: string,
  validatedLedgerIndex: number,
  validatedAccountSequence: number,
): void {
  const tx = result.revoke_tx;
  if (!tx) throw new Error("Harbor did not prepare a delegation revocation transaction.");
  assertOnlyFields(tx, [
    "TransactionType", "Account", "Authorize", "Permissions", "Fee", "Sequence",
    "LastLedgerSequence", "Flags", "SourceTag", "Memos", "SigningPubKey",
  ]);
  if (
    result.owner !== account || result.network !== network ||
    result.delegate !== currentDelegate || result.status !== "suspended" ||
    !hasExactOnboardingPermissionList(result) || result.delegate_set_tx !== undefined ||
    tx.TransactionType !== "DelegateSet" || tx.Account !== account ||
    tx.Authorize !== currentDelegate || !Array.isArray(tx.Permissions) ||
    tx.Permissions.length !== 0
  ) {
    throw new Error("The revocation does not match the current owner, network, and delegate.");
  }
  if (tx.Flags !== undefined && tx.Flags !== 0) {
    throw new Error("The revocation contains unexpected flags.");
  }
  if (tx.SigningPubKey !== undefined && tx.SigningPubKey !== "") {
    throw new Error("The revocation is not an unsigned transaction.");
  }
  assertSafeFeeAndExpiry(tx, validatedLedgerIndex, validatedAccountSequence);
}

export async function prepareOnboardingRevocation(
  harbor: HarborClient,
  account: string,
  network: TestNetwork,
  currentDelegate: string,
): Promise<AccountLink> {
  const response = await harbor.op("account.revoke", { owner: account, network });
  if (!response.ok) throw new Error(response.error.message);
  const accountInfo = await harbor.op("ledger.account.info", {
    account,
    network,
    ledger_index: "validated",
  });
  if (!accountInfo.ok) throw new Error(accountInfo.error.message);
  const sequence = accountInfo.data.account_data.Sequence;
  if (!Number.isSafeInteger(sequence)) {
    throw new Error("Harbor did not return the validated account sequence.");
  }
  assertSafeRevoke(
    response.data,
    account,
    network,
    currentDelegate,
    validatedLedgerIndex(accountInfo.data),
    Number(sequence),
  );
  return response.data;
}

export async function preflightPreparedOnboardingRevocation(
  harbor: HarborClient,
  preparedLink: AccountLink,
  account: string,
  network: TestNetwork,
  currentDelegate: string,
  storage: Pick<Storage, "getItem">,
): Promise<void> {
  if (hasPersistedPendingSubmission(storage.getItem("pilot:onboarding-pending"))) {
    throw new Error(
      "A signed onboarding transaction is already unresolved. Resume status recovery without signing again.",
    );
  }
  const accountInfo = await harbor.op("ledger.account.info", {
    account,
    network,
    ledger_index: "validated",
  });
  if (!accountInfo.ok) throw new Error(accountInfo.error.message);
  const sequence = accountInfo.data.account_data.Sequence;
  if (!Number.isSafeInteger(sequence)) {
    throw new Error("Harbor did not return the validated account sequence.");
  }
  assertSafeRevoke(
    preparedLink,
    account,
    network,
    currentDelegate,
    validatedLedgerIndex(accountInfo.data),
    Number(sequence),
  );
}

export function parseStoredPendingSubmission(
  raw: string | null,
  account: string,
  network: TestNetwork,
): StoredPendingSubmission | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      (value.kind !== "trust" && value.kind !== "delegate" && value.kind !== "revoke") ||
      typeof value.hash !== "string" || !/^[A-Fa-f0-9]{64}$/.test(value.hash) ||
      value.account !== account || value.network !== network ||
      (value.submissionRoute !== undefined &&
        value.submissionRoute !== "direct" && value.submissionRoute !== "harbor") ||
      !Number.isSafeInteger(value.lastLedgerSequence) || Number(value.lastLedgerSequence) < 1 ||
      !value.expectedTx || typeof value.expectedTx !== "object" || Array.isArray(value.expectedTx)
    ) return undefined;
    const expectedTx = value.expectedTx as Record<string, unknown>;
    if (
      expectedTx.Account !== account ||
      expectedTx.LastLedgerSequence !== value.lastLedgerSequence ||
      (value.kind === "trust" && expectedTx.TransactionType !== "TrustSet") ||
      ((value.kind === "delegate" || value.kind === "revoke") && (
        expectedTx.TransactionType !== "DelegateSet" ||
        typeof value.expectedDelegate !== "string" ||
        expectedTx.Authorize !== value.expectedDelegate ||
        (value.kind === "revoke" && (
          !Array.isArray(expectedTx.Permissions) || expectedTx.Permissions.length !== 0
        ))
      ))
    ) return undefined;
    return value as StoredPendingSubmission;
  } catch {
    return undefined;
  }
}

export function hasPersistedPendingDelegate(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.kind !== "delegate" || typeof value.account !== "string" ||
      (value.network !== "testnet" && value.network !== "devnet")
    ) return false;
    return parseStoredPendingSubmission(raw, value.account, value.network)?.kind === "delegate";
  } catch {
    return false;
  }
}

export function hasPersistedPendingSubmission(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.account !== "string" ||
      (value.network !== "testnet" && value.network !== "devnet")
    ) return false;
    return parseStoredPendingSubmission(raw, value.account, value.network) !== undefined;
  } catch {
    return false;
  }
}

export function clearPersistedOnboardingPending(
  storage: Pick<Storage, "removeItem">,
  setGuard: (value: false) => void,
): void {
  storage.removeItem("pilot:onboarding-pending");
  setGuard(false);
}

export function hasUnresolvedDelegateApproval(
  pendingKind: PendingAction["kind"] | undefined,
  persistedDelegate: boolean,
): boolean {
  return pendingKind === "delegate" || persistedDelegate;
}

export function pendingSubmissionRecord(
  action: ResumablePendingAction,
  hash: string,
  account: string,
  network: TestNetwork,
): StoredPendingSubmission {
  const expectedTx = action.kind === "trust"
    ? action.build.tx_json
    : action.kind === "revoke"
      ? action.link.revoke_tx
      : action.link.delegate_set_tx;
  const lastLedgerSequence = Number(expectedTx?.LastLedgerSequence);
  if (!expectedTx || !/^[A-Fa-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(lastLedgerSequence)) {
    throw new Error("The submitted onboarding transaction cannot be resumed safely.");
  }
  return {
    version: 1,
    kind: action.kind,
    hash: hash.toUpperCase(),
    account,
    network,
    expectedDelegate: action.kind === "trust"
      ? action.expectedDelegate
      : action.link.delegate,
    submissionRoute: action.kind === "trust"
      ? action.approvalId === undefined ? "direct" : "harbor"
      : undefined,
    lastLedgerSequence,
    expectedTx,
  };
}

export async function submitPreparedOnboardingRevocation(
  harbor: HarborClient,
  preparedLink: AccountLink,
  txBlob: string,
  account: string,
  network: TestNetwork,
  storage: Pick<Storage, "getItem" | "setItem">,
  options: PollOptions = {},
): Promise<ApprovalSubmission> {
  if (hasPersistedPendingSubmission(storage.getItem("pilot:onboarding-pending"))) {
    throw new Error(
      "A signed onboarding transaction is already unresolved. Resume status recovery without submitting again.",
    );
  }
  const expectedHash = hashes.hashSignedTx(txBlob).toUpperCase();
  const action = { kind: "revoke" as const, link: preparedLink };
  const pendingRecord = pendingSubmissionRecord(
    action,
    expectedHash,
    account,
    network,
  );
  storage.setItem("pilot:onboarding-pending", JSON.stringify(pendingRecord));

  const recoverByExpectedHash = () => waitForValidatedSubmission(
    harbor,
    { hash: expectedHash, validated: false },
    account,
    network,
    pendingRecord.lastLedgerSequence,
    options,
  );

  let response: Envelope<TxSubmitResult>;
  try {
    response = await harbor.op("tx.submit", { tx_blob: txBlob, network });
  } catch {
    return recoverByExpectedHash();
  }
  if (!response.ok) return recoverByExpectedHash();
  if (
    "hash" in response.data &&
    response.data.hash.toUpperCase() !== expectedHash
  ) {
    throw new AmbiguousOnboardingSubmissionError(
      "Harbor returned a submission hash that did not match the signed revocation.",
    );
  }
  return waitForValidatedSubmission(
    harbor,
    response.data,
    account,
    network,
    pendingRecord.lastLedgerSequence,
    options,
  );
}

type OnboardingFlowProps = {
  bedrockMode: "off" | "mock" | "aws";
  bedrockModels: readonly string[];
  harborAudience: string;
};

type VerifiedOpenFinance = VerificationSummary & {
  mandate_budget_usd: number;
};

type ActiveMandate = {
  form: MandateForm;
  mandate: Mandate;
  setupTransactionHashes: string[];
};

function datetimeLocal(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function OnboardingFlow({
  bedrockMode,
  bedrockModels,
  harborAudience,
}: OnboardingFlowProps) {
  const harbor = useMemo(() => createBrowserHarborClient(), []);
  const [step, setStep] = useState<OnboardingStepId>("wallet");
  // The server catalog is authoritative. Do not present the configured id as
  // available until the wallet-gated demo lookup verifies it.
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [aiMode, setAiMode] = useState<"demo" | "openrouter" | "near-ai">("demo");
  const [modelAccessReady, setModelAccessReady] = useState(false);
  const [oauthConnected, setOauthConnected] = useState(false);
  const [demoCatalog, setDemoCatalog] = useState<DemoCatalogState>({ status: "idle" });
  const [demoLimits, setDemoLimits] = useState<{
    maxInputBytes?: number;
    maxOutputTokens?: number;
    maxSteps?: number;
  }>();
  const [walletSessionReady, setWalletSessionReady] = useState(false);
  const [walletSessionStatusUnavailable, setWalletSessionStatusUnavailable] = useState(false);
  const [modelSessionStatusUnavailable, setModelSessionStatusUnavailable] = useState(false);
  const [walletViewportState, setWalletViewportState] = useState<WalletViewportState>("checking");
  const [provider, setProvider] = useState<WalletProvider>("gemwallet");
  const [availableExtension, setAvailableExtension] = useState<ExtensionWalletProvider>();
  const [connectedExtension, setConnectedExtension] = useState<ExtensionWalletProvider>();
  const [ledgerTransport, setLedgerTransport] = useState<LedgerOnboardingTransport>("webhid");
  const [ledgerAccountIndex, setLedgerAccountIndex] = useState<LedgerOnboardingAccountIndex>(0);
  const [ledgerAccounts, setLedgerAccounts] = useState<
    Partial<Record<LedgerOnboardingAccountIndex, string>>
  >({});
  const ledgerWalletsRef = useRef(new Map<LedgerOnboardingAccountIndex, OnboardingWallet>());
  const [ledgerBlindSigningConfirmed, setLedgerBlindSigningConfirmed] = useState(false);
  const [ledgerRestoredWithoutDevice, setLedgerRestoredWithoutDevice] = useState(false);
  const [publicConfig, setPublicConfig] = useState<PublicPilotConfig>();
  const [wallet, setWallet] = useState<OnboardingWallet>();
  const [account, setAccount] = useState<string>();
  const [pending, setPending] = useState<PendingAction>();
  const [preparedTrust, setPreparedTrust] = useState<
    PreparedLiveOnboardingTrust | PolicyConfirmedLiveOnboardingTrust
  >();
  const [link, setLink] = useState<AccountLink>();
  const [storedActiveExitGuard, setStoredActiveExitGuard] = useState(false);
  const [persistedPendingExitGuard, setPersistedPendingExitGuard] = useState(() =>
    typeof window !== "undefined" &&
    hasPersistedPendingSubmission(window.sessionStorage.getItem("pilot:onboarding-pending")),
  );
  const [acquisition, setAcquisition] = useState<RlusdAcquisitionRouteState>();
  const [funded, setFunded] = useState(false);
  const [fundingSource, setFundingSource] = useState<"route" | "fixture" | "acquisition">();
  const [openFinance, setOpenFinance] = useState<VerifiedOpenFinance>();
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [mandateForm, setMandateForm] = useState<MandateForm>(() => ({
    perPaymentMaxUsd: "5.00",
    dailyMaxUsd: "10.00",
    totalMaxUsd: "25.00",
    payees: [],
    expiresAt: datetimeLocal(new Date(Date.now() + 24 * 60 * 60 * 1_000)),
  }));
  const [preparedMandate, setPreparedMandate] = useState<PreparedMandateDraft>();
  const [activeMandate, setActiveMandate] = useState<ActiveMandate>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const restorationStartedRef = useRef(false);
  const walletIdentityRestoredRef = useRef(false);
  const requestedRevocationRef = useRef<StoredActiveOnboardingRecord | undefined>(undefined);
  const [restorationSuppressed, setRestorationSuppressed] = useState(false);
  const [walletNotice, setWalletNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [errorCode, setErrorCode] = useState<string>();
  const network = publicConfig?.network;
  const liveDevAcquisition = Boolean(
    network && publicConfig && shouldUseLiveDevAcquisition(provider, network, publicConfig.mockMode),
  );
  const tradingStepLocked = walletSessionStatusUnavailable && [
    "fund",
    "acquire",
    "delegate",
    "verify",
    "mandate",
    "ready",
  ].includes(step);
  const devRevocationRequired = requiresDevRevocationBeforeExit(provider, link);
  const externalRevocationAvailable = provider !== "dev" && pending === undefined &&
    !persistedPendingExitGuard && hasVerifiedRevocationContext({
      provider,
      walletConnected: Boolean(wallet),
      sessionAuthenticated: walletSessionReady,
      account,
      network,
      link,
    });
  const offerRevocationRecovery = shouldOfferRevocationRecovery({
    provider,
    walletConnected: Boolean(wallet),
    sessionAuthenticated: walletSessionReady,
    account,
    network,
    link,
    step,
    acquisitionStatus: acquisition?.status,
    blocked: Boolean(error),
    pendingKind: pending?.kind,
    persistedPendingSubmission: persistedPendingExitGuard,
  });

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 767px)");
    const updateWalletViewportState = () => {
      setWalletViewportState(mobileViewport.matches ? "small-screen" : "desktop");
    };
    updateWalletViewportState();
    mobileViewport.addEventListener("change", updateWalletViewportState);
    return () => mobileViewport.removeEventListener("change", updateWalletViewportState);
  }, []);

  useEffect(() => {
    if (!shouldSuppressOnboardingRestoration(window.location.search)) return;
    setRestorationSuppressed(true);
    setWalletNotice(
      "Signed out of Pilot. Saved recovery metadata remains in this tab, but Pilot will not restore it or request a signature until you explicitly reconnect the exact wallet. Any active autonomous strategy continues until separately paused, stopped, or killed.",
    );
  }, []);

  useEffect(() => {
    setPersistedPendingExitGuard(
      hasPersistedPendingSubmission(sessionStorage.getItem("pilot:onboarding-pending")),
    );
  }, []);

  useEffect(() => {
    const accepted = consumeExactOnboardingRevokeAction(
      window.location,
      (path) => window.history.replaceState(window.history.state, "", path),
    );
    if (!accepted || hasPersistedPendingSubmission(
      sessionStorage.getItem("pilot:onboarding-pending"),
    )) return;
    requestedRevocationRef.current = parseStoredActiveOnboardingRecord(
      sessionStorage.getItem("pilot:onboarding"),
    );
  }, []);

  useEffect(() => {
    const shouldWarn = storedActiveExitGuard ||
      hasUnresolvedDelegateApproval(pending?.kind, persistedPendingExitGuard) ||
      devRevocationRequired ||
      acquisition?.status === "signed_pending";
    if (!shouldWarn) return;
    const warnBeforeClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeClose);
    return () => window.removeEventListener("beforeunload", warnBeforeClose);
  }, [
    acquisition?.status,
    devRevocationRequired,
    pending?.kind,
    persistedPendingExitGuard,
    storedActiveExitGuard,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    loadPublicPilotConfig(fetch, controller.signal)
      .then((config) => {
        setPublicConfig(config);
        if (!walletIdentityRestoredRef.current) {
          setProvider(defaultOnboardingWalletProvider(config));
        }
        setLedgerTransport(defaultLedgerTransport(config.ledger));
        setLedgerAccountIndex(defaultLedgerAccountIndex(config.ledger?.defaultAccountIndex ?? 0));
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Pilot configuration is unavailable.");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!publicConfig || restorationStartedRef.current || restorationSuppressed) return;
    const rawRecord = sessionStorage.getItem("pilot:onboarding");
    if (!rawRecord || sessionStorage.getItem("pilot:onboarding-pending")) return;
    restorationStartedRef.current = true;
    const record = parseStoredActiveOnboardingRecord(rawRecord);
    if (!record) {
      setStep("wallet");
      setError("The saved active delegation record is invalid. Reconnect the wallet to verify it safely.");
      return;
    }
    if (record.provider === "dev") setStoredActiveExitGuard(true);
    let cancelled = false;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    void (async () => {
      if (record.network !== publicConfig.network) {
        throw new Error("The saved active delegation is for a different public network.");
      }
      if (record.provider === "dev" && !publicConfig.devSignerEnabled) {
        throw new Error("The saved development wallet cannot be restored in this build.");
      }
      if (record.provider === "xaman") {
        throw new Error(XAMAN_UNAVAILABLE_REASON);
      }
      if (record.provider === "ledger") {
        const ledger = record.ledger;
        if (
          !ledger || !publicConfig.ledger?.enabled ||
          !publicConfig.ledger.transports.includes(ledger.transport)
        ) {
          throw new Error("The saved Ledger transport is not enabled in this build.");
        }
        setProvider("ledger");
        setLedgerTransport(ledger.transport);
        setLedgerAccountIndex(defaultLedgerAccountIndex(ledger.accountIndex));
        setLedgerAccounts({
          [defaultLedgerAccountIndex(ledger.accountIndex)]: record.account,
        });
        setAccount(record.account);
        setModel(record.model);
        setAiMode(record.aiMode);
        const restoration = await restoreLedgerOnboardingWithoutDevice(
          await loadWalletSessionStatus(),
          record,
          {
            restoreLink: () => restoreActiveOnboardingLink(harbor, record),
            createWallet: () => createPilotWallet({
              provider: "ledger",
              network: record.network,
              ledger,
            }),
            connectWallet: async (restoredWallet) => {
              await restoredWallet.connect();
            },
            bindSession: bindWalletSession,
          },
        );
        if (restoration.status === "explicit-reconnect-required") {
          setWalletSessionReady(false);
          setLedgerRestoredWithoutDevice(true);
          setStep("wallet");
          setError(
            "The saved Ledger delegation is intact, but its 60-minute wallet session expired. Reconnect the Ledger to sign a fresh challenge.",
          );
          return;
        }
        const activeLink = restoration.link;
        if (cancelled) return;
        setWalletSessionReady(true);
        setLink(activeLink);
        setLedgerRestoredWithoutDevice(true);
        setStoredActiveExitGuard(false);
        setFunded(true);
        setFundingSource(publicConfig.mockMode ? "fixture" : "route");
        clearOnboardingTrustCheckpoints(sessionStorage);
        setStep("ready");
        return;
      }
      if (isExtensionWalletProvider(record.provider)) {
        if (cancelled) return;
        setProvider(record.provider);
        setWallet(undefined);
        setAccount(undefined);
        setWalletSessionReady(false);
        setAvailableExtension(undefined);
        setConnectedExtension(undefined);
        setModel(record.model);
        setAiMode(record.aiMode);
        setStep("wallet");
        setWalletNotice(
          `The saved active delegation for ${record.account} remains recovery metadata only. Check ${record.provider === "gemwallet" ? "GemWallet" : "Crossmark"}, reconnect that exact ${record.network} account, then separately sign a fresh Pilot authentication proof. Pilot will not contact the extension or restore trading access until you take those actions.`,
        );
        return;
      }
      const restoredWallet: OnboardingWallet = createPilotWallet({
        provider: record.provider,
        network: record.network,
      });
      await restoredWallet.connect();
      const restoredAccount = await restoredWallet.address();
      if (restoredAccount !== record.account) {
        throw new Error("The restored wallet does not match the active delegation owner.");
      }
      await bindWalletSession(restoredWallet, restoredAccount, record.network);
      const activeLink = await restoreActiveOnboardingLink(harbor, record);
      if (cancelled) return;
      setProvider(record.provider);
      setWallet(restoredWallet);
      setAccount(restoredAccount);
      setWalletSessionReady(true);
      setModel(record.model);
      setAiMode(record.aiMode);
      setLink(activeLink);
      setStoredActiveExitGuard(false);
      setFunded(true);
      setFundingSource(publicConfig.mockMode
        ? "fixture"
        : record.provider === "dev" && record.network === "testnet"
          ? "acquisition"
          : "route");
      clearOnboardingTrustCheckpoints(sessionStorage);
      setStep("ready");
    })().catch((cause: unknown) => {
      if (cancelled) return;
      setStep("wallet");
      setError(cause instanceof Error
        ? cause.message
        : "The saved active delegation could not be verified safely.");
    }).finally(() => {
      if (cancelled) return;
      busyRef.current = false;
      setBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [harbor, publicConfig, restorationSuppressed]);

  useEffect(() => {
    if (!publicConfig || restorationSuppressed) return;
    const search = new URLSearchParams(window.location.search);
    if (search.has("openrouter")) return;
    const storedWallet = sessionStorage.getItem("pilot:wallet");
    if (sessionStorage.getItem("pilot:onboarding")) return;
    const controller = new AbortController();
    loadWalletSessionStatus(fetch, controller.signal)
      .then(async (session) => {
        if (session.authenticated && !storedWallet) {
          setWalletNotice(
            "Pilot found a server session, but this tab has no wallet metadata. Reconnect the exact wallet before choosing a model or enabling trading.",
          );
          return;
        }
        if (storedWallet && session.authenticated) {
          let configured: ReturnType<typeof walletFirstSessionMetadata>;
          try {
            configured = walletFirstSessionMetadata(
              session,
              storedWallet,
              publicConfig,
            );
          } catch {
            setWalletSessionReady(false);
            setWalletNotice(
              "Pilot could not match this tab to the authenticated wallet session. Reconnect the exact wallet to continue.",
            );
            return;
          }
          walletIdentityRestoredRef.current = true;
          setProvider(configured.provider as WalletProvider);
          setAccount(configured.account);
          setWallet(undefined);
          setWalletSessionReady(true);
          setWalletSessionStatusUnavailable(false);
          try {
            const modelResponse = await fetch("/api/auth/openrouter/session", {
              cache: "no-store",
              credentials: "same-origin",
              signal: controller.signal,
            });
            if (!modelResponse.ok) throw new Error("model session unavailable");
            const modelSession = await modelResponse.json() as {
              connected?: boolean;
              mode?: "demo" | "oauth" | "near-ai";
              provider?: "near-ai";
              model?: string;
              selected?: boolean;
            };
            if (modelSession.model) setModel(modelSession.model);
            setOauthConnected(
              modelSession.selected === true &&
              modelSession.mode === "oauth" &&
              modelSession.connected === true,
            );
            if (modelSession.selected === true && modelSession.mode) {
              setAiMode(
                modelSession.mode === "oauth"
                  ? "openrouter"
                  : modelSession.mode === "near-ai"
                    ? "near-ai"
                    : "demo",
              );
            }
            setModelAccessReady(modelSession.selected === true);
            setModelSessionStatusUnavailable(false);
            setWalletNotice(
              "Pilot restored this wallet-authenticated account session. Reconnect the exact wallet only when a later action needs a fresh signature.",
            );
          } catch (cause) {
            if (cause instanceof DOMException && cause.name === "AbortError") return;
            setOauthConnected(false);
            setModelAccessReady(false);
            setModelSessionStatusUnavailable(true);
            setWalletNotice(
              "Pilot restored this wallet-authenticated account, but could not check its model session. Model changes are locked until that session can be checked or cleared.",
            );
          }
          setStep(nextStepAfterWalletAuthentication());
          return;
        }
        if (
          storedWallet &&
          (!session.authenticated ||
            (session.expiresAt !== undefined && session.expiresAt <= Date.now()))
        ) {
          setWalletNotice(
            "The 60-minute Pilot wallet session expired. Reconnect the exact wallet to create a fresh non-broadcast authentication proof.",
          );
        }
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [publicConfig, restorationSuppressed]);

  useEffect(() => {
    if (!walletSessionReady) return;
    let active = true;
    let checking = false;
    const revalidate = async () => {
      if (!active || checking) return;
      checking = true;
      let session: WalletSessionStatus;
      try {
        session = await loadWalletSessionStatus();
      } catch {
        if (!active) return;
        setWalletSessionStatusUnavailable(true);
        setWalletNotice(
          "Pilot could not revalidate this wallet session. The known account remains visible, but wallet-bound model and trading changes are locked until revalidation succeeds.",
        );
        checking = false;
        return;
      }
      try {
        if (!active) return;
        const storedWallet = sessionStorage.getItem("pilot:wallet");
        if (!publicConfig || !storedWallet) throw new Error("wallet metadata unavailable");
        walletFirstSessionMetadata(session, storedWallet, publicConfig);
        setWalletSessionStatusUnavailable(false);
        if (modelSessionStatusUnavailable) {
          try {
            const modelResponse = await fetch("/api/auth/openrouter/session", {
              cache: "no-store",
              credentials: "same-origin",
            });
            if (!modelResponse.ok) throw new Error("model session unavailable");
            const modelSession = await modelResponse.json() as {
              connected?: boolean;
              mode?: "demo" | "oauth" | "near-ai";
              provider?: "near-ai";
              model?: string;
              selected?: boolean;
            };
            if (modelSession.model) setModel(modelSession.model);
            setOauthConnected(
              modelSession.selected === true &&
              modelSession.mode === "oauth" &&
              modelSession.connected === true,
            );
            if (modelSession.selected === true && modelSession.mode) {
              setAiMode(
                modelSession.mode === "oauth"
                  ? "openrouter"
                  : modelSession.mode === "near-ai"
                    ? "near-ai"
                    : "demo",
              );
            }
            setModelAccessReady(modelSession.selected === true);
            setModelSessionStatusUnavailable(false);
            setWalletNotice(
              "Pilot revalidated this wallet and its model session. Reconnect the exact wallet only when a later action needs a fresh signature.",
            );
          } catch {
            setModelSessionStatusUnavailable(true);
            setWalletNotice(
              "Pilot revalidated this wallet account, but could not check its model session. Model changes remain locked until that session can be checked or cleared.",
            );
          }
        }
      } catch {
        if (!active) return;
        setWallet(undefined);
        setAccount(undefined);
        setWalletSessionReady(false);
        setWalletSessionStatusUnavailable(false);
        setModelSessionStatusUnavailable(false);
        setOauthConnected(false);
        setModelAccessReady(false);
        setModels([]);
        setDemoCatalog({ status: "idle" });
        setDemoLimits(undefined);
        setStep("wallet");
        setWalletNotice(
          "The Pilot wallet session is no longer valid. Reconnect the exact wallet and sign a fresh non-broadcast authentication proof.",
        );
      } finally {
        checking = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void revalidate();
    };
    const onFocus = () => void revalidate();
    const interval = window.setInterval(() => void revalidate(), 30_000);
    window.addEventListener("focus", onFocus);
    window.addEventListener(WALLET_SESSION_CHANGED_EVENT, onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(WALLET_SESSION_CHANGED_EVENT, onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [modelSessionStatusUnavailable, publicConfig, walletSessionReady]);

  useEffect(() => {
    if (!shouldLoadOnboardingModels(step, walletSessionReady)) return;
    const controller = new AbortController();
    const mode = oauthConnected ? "oauth" : "demo";
    if (mode === "demo") {
      setDemoCatalog({ status: "loading" });
      setDemoLimits(undefined);
      setModels([]);
    }
    const loadCatalog = async (catalogMode: "demo" | "oauth" | "near-ai") => {
      const response = await fetch(`/api/auth/openrouter/models?mode=${catalogMode}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined) as
          | { error?: unknown }
          | undefined;
        throw new Error(
          typeof payload?.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : catalogMode === "demo"
              ? "The free demo is unavailable right now."
              : catalogMode === "oauth"
                ? "The OpenRouter model list is unavailable right now."
                : "NEAR AI is unavailable right now.",
        );
      }
      return response.json() as Promise<{
        defaultModel?: string;
        models?: ModelChoice[];
        demo?: {
          maxInputBytes?: number;
          maxOutputTokens?: number;
          maxSteps?: number;
        };
      }>;
    };
    void Promise.allSettled([loadCatalog(mode), loadCatalog("near-ai")])
      .then(([primaryResult, nearAiResult]) => {
        if (controller.signal.aborted) return;
        const primary = primaryResult.status === "fulfilled" ? primaryResult.value : undefined;
        const nearAi = nearAiResult.status === "fulfilled" ? nearAiResult.value : undefined;
        const nextModels = [...(primary?.models ?? []), ...(nearAi?.models ?? [])];
        const verifiedDefaultModel = primary?.defaultModel && nextModels.some(
          (choice) => choice.id === primary.defaultModel,
        )
          ? primary.defaultModel
          : undefined;
        setModels(nextModels);
        setModel((current) =>
          nextModels.some((choice) => choice.id === current)
            ? current
            : (verifiedDefaultModel ?? current));
        if (mode === "demo") {
          if (!verifiedDefaultModel) {
            setDemoCatalog({
              status: "unavailable",
              message: primaryResult.status === "rejected" && primaryResult.reason instanceof Error
                ? primaryResult.reason.message
                : "No eligible free demo model is currently available.",
            });
            return;
          }
          setDemoLimits(primary?.demo);
          setDemoCatalog({ status: "available" });
        }
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        if (mode === "demo") {
          setModels([]);
          setDemoCatalog({
            status: "unavailable",
            message: cause instanceof Error
              ? cause.message
              : "The free demo is unavailable right now.",
          });
        }
      });
    return () => controller.abort();
  }, [oauthConnected, step, walletSessionReady]);

  useEffect(() => {
    if (!publicConfig) return;
    if (new URLSearchParams(window.location.search).get("openrouter") !== "connected") return;
    void (async () => {
      let configured: ReturnType<typeof walletFirstSessionMetadata>;
      try {
        const walletSession = await loadWalletSessionStatus();
        configured = walletFirstSessionMetadata(
          walletSession,
          sessionStorage.getItem("pilot:wallet"),
          publicConfig,
        );
        if (configured.provider === "xaman") throw new Error(XAMAN_UNAVAILABLE_REASON);
      } catch (cause) {
        setWalletSessionReady(false);
        setWalletSessionStatusUnavailable(false);
        setModelSessionStatusUnavailable(false);
        setStep("wallet");
        setError(cause instanceof Error
          ? cause.message
          : "OpenRouter connected, but the wallet-bound session could not be verified.");
        return;
      }
      walletIdentityRestoredRef.current = true;
      setProvider(configured.provider as WalletProvider);
      setAccount(configured.account);
      setWalletSessionReady(true);
      setWalletSessionStatusUnavailable(false);
      if (configured.ledger) {
        setLedgerTransport(configured.ledger.transport);
        setLedgerAccountIndex(defaultLedgerAccountIndex(configured.ledger.accountIndex));
        setLedgerAccounts({
          [defaultLedgerAccountIndex(configured.ledger.accountIndex)]: configured.account,
        });
      }
      try {
        const response = await fetch("/api/auth/openrouter/session");
        if (!response.ok) throw new Error("session unavailable");
        const session = await response.json() as {
          connected?: boolean;
          model?: string;
          mode?: "demo" | "openrouter";
        };
        if (!session.connected) throw new Error("OpenRouter did not confirm a connected session.");
        if (session.model) setModel(session.model);
        setAiMode("openrouter");
        setOauthConnected(true);
        setModelAccessReady(true);
        setModelSessionStatusUnavailable(false);
        setStep(nextStepAfterWalletAuthentication());
      } catch {
        setOauthConnected(false);
        setModelAccessReady(false);
        setModelSessionStatusUnavailable(true);
        setStep(nextStepAfterWalletAuthentication());
        setError(
          "Pilot verified the wallet account but could not confirm the OpenRouter callback session. Model changes are locked until that session can be checked or cleared.",
        );
      }
    })();
  }, [publicConfig]);

  useEffect(() => {
    if (!publicConfig) return;
    if (new URLSearchParams(window.location.search).get("openrouter") !== "error") return;
    loadWalletSessionStatus()
      .then((walletSession) => {
        const configured = walletFirstSessionMetadata(
          walletSession,
          sessionStorage.getItem("pilot:wallet"),
          publicConfig,
        );
        if (configured.provider === "xaman") throw new Error(XAMAN_UNAVAILABLE_REASON);
        walletIdentityRestoredRef.current = true;
        setProvider(configured.provider as WalletProvider);
        setAccount(configured.account);
        setWalletSessionReady(true);
        setWalletSessionStatusUnavailable(false);
        setModelSessionStatusUnavailable(false);
        setStep("ai");
        setError("OpenRouter connection was not completed. No provider credential was saved; retry when ready or use the configured free demo.");
      })
      .catch((cause: unknown) => {
        setWalletSessionReady(false);
        setWalletSessionStatusUnavailable(false);
        setModelSessionStatusUnavailable(false);
        setStep("wallet");
        setError(cause instanceof Error
          ? cause.message
          : "OpenRouter connection was not completed. Reauthenticate the same wallet before retrying.");
      });
  }, [publicConfig]);

  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setErrorCode(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That step could not be completed.");
      setErrorCode(cause instanceof OnboardingStepError ? cause.code : undefined);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const prepareLiveTrustForLink = async (activeLink: AccountLink) => {
    if (!publicConfig) throw new Error("The stable asset configuration is unavailable.");
    setPreparedTrust(undefined);
    sessionStorage.removeItem(ONBOARDING_READINESS_KEY);
    let intent = parseOnboardingTrustIntent(
      sessionStorage.getItem(ONBOARDING_TRUST_INTENT_KEY),
      activeLink.owner,
    );
    if (!intent) {
      intent = {
        version: 1,
        account: activeLink.owner,
        intent_id: `onboarding-trust-${crypto.randomUUID()}`,
      };
      sessionStorage.setItem(ONBOARDING_TRUST_INTENT_KEY, JSON.stringify(intent));
    }
    const prepared = await prepareLiveOnboardingTrust(
      harbor,
      activeLink,
      publicConfig.stableAsset,
      intent.intent_id,
    );
    setPending(undefined);
    setPreparedTrust(prepared);
  };

  const confirmLiveTrustPolicy = () =>
    run(async () => {
      if (!link || preparedTrust?.status !== "prepared") {
        throw new Error("Prepare and review the TrustSet before confirming its policy setup.");
      }
      setPreparedTrust(await confirmPreparedLiveOnboardingPolicy(harbor, link, preparedTrust));
    });

  const confirmLiveTrustExecution = () =>
    run(async () => {
      if (!link || !publicConfig || preparedTrust?.status !== "policy_confirmed") {
        throw new Error("Confirm the exact onboarding policy before executing the TrustSet.");
      }
      const execution = await executePreparedLiveOnboardingTrust(
        harbor,
        link,
        publicConfig.stableAsset,
        preparedTrust,
        () => confirmLiveOnboardingTrustExecutionCapability(preparedTrust),
      );
      if (execution.status === "needs_approval") {
        sessionStorage.setItem(ONBOARDING_TRUST_APPROVAL_KEY, JSON.stringify({
          version: 1,
          account: link.owner,
          network: "testnet",
          delegate: link.delegate,
          approval_id: execution.action.approvalId,
          expires_at: execution.action.expiresAt,
          build: execution.action.build,
        } satisfies StoredOnboardingTrustApproval));
        setPreparedTrust(undefined);
        setPending(execution.action);
        return;
      }
      await requireExactConfiguredTrustLine(
        harbor,
        link.owner,
        "testnet",
        publicConfig.stableAsset,
      );
      sessionStorage.setItem(
        ONBOARDING_READINESS_KEY,
        JSON.stringify(onboardingReadinessHint(link.owner, execution.hash)),
      );
      await requireLiveOnboardingReadiness(harbor, link, execution.hash);
      sessionStorage.removeItem(ONBOARDING_TRUST_APPROVAL_KEY);
      sessionStorage.removeItem(ONBOARDING_TRUST_INTENT_KEY);
      setPreparedTrust(undefined);
      setPending(undefined);
      setStep("acquire");
    });

  const restoreWalletFacadeAfterOAuth = async (): Promise<void> => {
    if (wallet) return;
    if (!publicConfig) {
      throw new Error("Pilot wallet configuration is unavailable.");
    }
    const session = await loadWalletSessionStatus();
    const configured = walletFirstSessionMetadata(
      session,
      sessionStorage.getItem("pilot:wallet"),
      publicConfig,
    );
    if (!session.authenticated || (network && session.network !== network)) {
      throw new Error("Reconnect the exact wallet used for this Pilot session before continuing.");
    }
    if (configured.provider === "xaman") {
      throw new Error(XAMAN_UNAVAILABLE_REASON);
    }
    const restoredWallet: OnboardingWallet = createPilotWallet(
      configuredWalletOptions(configured, session.network),
    );
    await restoredWallet.connect();
    const restoredAccount = await restoredWallet.address();
    if (restoredAccount !== configured.account) {
      await restoredWallet.disconnect?.();
      throw new Error("The reconnected wallet does not match the wallet-bound OpenRouter session.");
    }
    if (configured.provider === "ledger") {
      if (!restoredWallet.verifyAddressOnDevice || !configured.ledger) {
        await restoredWallet.disconnect?.();
        throw new Error("Reconnect and verify the exact Ledger account before continuing.");
      }
      await restoredWallet.verifyAddressOnDevice();
      setLedgerTransport(configured.ledger.transport);
      setLedgerAccountIndex(defaultLedgerAccountIndex(configured.ledger.accountIndex));
      setLedgerAccounts({
        [defaultLedgerAccountIndex(configured.ledger.accountIndex)]: configured.account,
      });
    }
    setProvider(configured.provider as WalletProvider);
    setWallet(restoredWallet);
    setAccount(restoredAccount);
    setWalletSessionReady(true);
    setWalletSessionStatusUnavailable(false);
  };

  const startDemo = () =>
    run(async () => {
      if (!walletSessionReady || !account) {
        throw new Error("Connect and authenticate the budget wallet before using the free demo.");
      }
      if (walletSessionStatusUnavailable) {
        throw new Error("Pilot must revalidate this wallet session before changing model access.");
      }
      if (modelSessionStatusUnavailable) {
        throw new Error("Pilot must check or clear the existing model session before changing model access.");
      }
      if (demoCatalog.status !== "available") {
        throw new Error(
          demoCatalog.status === "unavailable"
            ? demoCatalog.message
            : "Wait for Pilot to verify the free demo model catalog.",
        );
      }
      // OAuth returns rebuild identity from the strict wallet session, but React has
      // no live wallet facade after a full-page round trip. Restore and verify that
      // exact facade before allowing either the OAuth-error recovery or demo path
      // to advance into wallet-using setup steps.
      if (!wallet) await restoreWalletFacadeAfterOAuth();
      const response = await fetch("/api/auth/openrouter/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "demo", model }),
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new OnboardingStepError(describeDemoSessionFailure(response.status, bodyText));
      }
      setAiMode("demo");
      setOauthConnected(false);
      setModelAccessReady(true);
      setStep(nextStepAfterModelAccess());
    });

  const continueOpenRouter = () =>
    run(async () => {
      if (!oauthConnected) throw new Error("Sign in with OpenRouter before continuing.");
      if (walletSessionStatusUnavailable) {
        throw new Error("Pilot must revalidate this wallet session before changing model access.");
      }
      if (modelSessionStatusUnavailable) {
        throw new Error("Pilot must check or clear the existing model session before changing model access.");
      }
      const response = await fetch("/api/auth/openrouter/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      });
      if (!response.ok) throw new Error("The selected OpenRouter model could not be saved.");
      await restoreWalletFacadeAfterOAuth();
      setAiMode("openrouter");
      setModelAccessReady(true);
      setStep(nextStepAfterModelAccess());
    });

  const continueNearAi = () =>
    run(async () => {
      if (!walletSessionReady || !account) {
        throw new Error("Connect and authenticate the budget wallet before using NEAR AI.");
      }
      if (walletSessionStatusUnavailable || modelSessionStatusUnavailable) {
        throw new Error("Pilot must revalidate the wallet and model sessions before changing model access.");
      }
      const selected = models.find((choice) => choice.id === model);
      if (selected?.provider !== "near-ai") {
        throw new Error("Choose the verified NEAR AI model before continuing.");
      }
      const response = await fetch("/api/auth/openrouter/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "near-ai", provider: "near-ai", model }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined) as
          | { error?: unknown }
          | undefined;
        throw new Error(
          typeof payload?.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : "The selected NEAR AI provider is unavailable.",
        );
      }
      setAiMode("near-ai");
      setOauthConnected(false);
      setModelAccessReady(true);
      setStep(nextStepAfterModelAccess());
    });

  const skipModelAccess = () =>
    run(async () => {
      const response = await fetch("/api/auth/openrouter/session", {
        method: "DELETE",
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error("Pilot could not clear the existing model session. Model setup was not skipped.");
      }
      setOauthConnected(false);
      setModelAccessReady(false);
      setModelSessionStatusUnavailable(false);
      setModels([]);
      setDemoCatalog({ status: "idle" });
      setDemoLimits(undefined);
      setStep(nextStepAfterModelAccess());
    });

  const resetLedgerDiscovery = async (nextTransport?: LedgerOnboardingTransport) => {
    const candidates = [...ledgerWalletsRef.current.values()];
    ledgerWalletsRef.current.clear();
    setLedgerAccounts({});
    setWallet(undefined);
    setAccount(undefined);
    setLedgerRestoredWithoutDevice(false);
    setLedgerBlindSigningConfirmed(false);
    if (nextTransport) setLedgerTransport(nextTransport);
    const [first, ...remaining] = candidates;
    if (first?.forget) await first.forget();
    await Promise.all(remaining.map(async (candidate) => candidate.disconnect?.()));
  };

  const chooseWalletProvider = (choice: WalletProvider) => {
    if (choice === provider) return;
    const previousWallet = wallet;
    void run(async () => {
      // Identity replacement starts by clearing the old server authority and
      // wallet-bound model cookies. A rejected connection or proof for the new
      // provider must never leave an invisible prior account authenticated.
      if (walletSessionReady || sessionStorage.getItem("pilot:wallet")) {
        await signOutPilotWallet();
      }
      try {
        if (provider === "ledger") {
          await resetLedgerDiscovery();
        } else {
          await previousWallet?.disconnect?.();
        }
      } finally {
        setAvailableExtension(undefined);
        setConnectedExtension(undefined);
        setWallet(undefined);
        setAccount(undefined);
        setWalletSessionReady(false);
        setWalletSessionStatusUnavailable(false);
        setModelSessionStatusUnavailable(false);
        setOauthConnected(false);
        setModelAccessReady(false);
        setModels([]);
        setDemoCatalog({ status: "idle" });
        setDemoLimits(undefined);
        setWalletNotice(undefined);
        setProvider(choice);
      }
    });
  };

  const checkWalletAvailability = () =>
    run(async () => {
      if (!network || !publicConfig) {
        throw new Error("Wait for the public test-network configuration before checking the wallet extension.");
      }
      if (walletViewportState !== "desktop") {
        throw new Error("Use a supported desktop browser to check a wallet extension.");
      }
      if (!isExtensionWalletProvider(provider)) {
        throw new Error("Select GemWallet or Crossmark before checking extension availability.");
      }
      const candidate: OnboardingWallet = createPilotWallet({ provider, network });
      if (!candidate.checkAvailability) {
        throw new Error("The selected wallet cannot perform a prompt-free availability check.");
      }
      await candidate.checkAvailability();
      setAvailableExtension(provider);
      setConnectedExtension(undefined);
      setWallet(candidate);
      setAccount(undefined);
      setWalletSessionReady(false);
      setWalletSessionStatusUnavailable(false);
      setModelSessionStatusUnavailable(false);
      setWalletNotice(
        `${provider === "gemwallet" ? "GemWallet" : "Crossmark"} is available. Connect the Testnet account next; Pilot will ask for the separate non-broadcast authentication signature only after the account and network are shown.`,
      );
    });

  const storedLedgerSelection = (): StoredLedgerOnboardingConfig => ({
    transport: ledgerTransport,
    accountIndex: ledgerAccountIndex,
  });

  const connectWallet = () =>
    run(async () => {
      const reconnectingAfterSignOut = shouldSuppressOnboardingRestoration(
        window.location.search,
      );
      // Consume the automatic-restoration path before awaiting the extension.
      // The signed-out URL marker remains authoritative until exact identity
      // binding succeeds, so a failed/manual reconnect cannot trigger a
      // concurrent background restore.
      if (reconnectingAfterSignOut) restorationStartedRef.current = true;
      if (!network || !publicConfig) {
        throw new Error("Wait for the public test-network configuration before connecting.");
      }
      if (provider === "dev" && !publicConfig.devSignerEnabled) {
        throw new Error("The session-scoped development signer is not enabled in this build.");
      }
      const savedActiveRecordRaw = sessionStorage.getItem("pilot:onboarding");
      const savedActiveRecord = parseStoredActiveOnboardingRecord(savedActiveRecordRaw);
      if (savedActiveRecordRaw && (
        !savedActiveRecord || savedActiveRecord.provider !== provider ||
        savedActiveRecord.network !== network
      )) {
        throw new Error(
          "The saved active delegation requires its exact wallet provider and network before Pilot can connect or request an authentication proof.",
        );
      }
      const restoringActiveDelegation = Boolean(
        savedActiveRecord,
      );
      if (provider === "xaman") {
        throw new Error(XAMAN_UNAVAILABLE_REASON);
      }
      if (!restoringActiveDelegation) assertOfficialLiveDevRlusdConfig(publicConfig, provider);
      let nextWallet: OnboardingWallet;
      let nextAccount: string;
      if (provider === "ledger") {
        const ledgerConfig = publicConfig.ledger;
        if (!ledgerConfig || !ledgerTransportAvailable(ledgerConfig, ledgerTransport)) {
          throw new Error(
            ledgerTransport === "webhid"
              ? "The selected Ledger transport is unavailable. Use desktop Chrome, Edge, or Brave with WebHID, or choose Virtual Ledger."
              : "The selected Ledger transport is not enabled for this local profile.",
          );
        }
        const restoredLedger = restoringActiveDelegation ? savedActiveRecord?.ledger : undefined;
        if (restoredLedger && (
          restoredLedger.transport !== ledgerTransport ||
          restoredLedger.accountIndex !== ledgerAccountIndex
        )) {
          throw new Error("Reconnect the exact Ledger transport and account stored for this delegation.");
        }
        if (!restoringActiveDelegation && LEDGER_ONBOARDING_ACCOUNT_INDEXES.some(
          (index) => ledgerAccounts[index] === undefined,
        )) {
          const discovered: Partial<Record<LedgerOnboardingAccountIndex, string>> = {};
          const facades = new Map<LedgerOnboardingAccountIndex, OnboardingWallet>();
          try {
            for (const index of LEDGER_ONBOARDING_ACCOUNT_INDEXES) {
              const candidate: OnboardingWallet = createPilotWallet({
                provider: "ledger",
                network,
                ledger: { transport: ledgerTransport, accountIndex: index },
              });
              await candidate.connect();
              discovered[index] = await candidate.address();
              facades.set(index, candidate);
            }
          } catch (cause) {
            for (const candidate of facades.values()) await candidate.disconnect?.();
            throw cause;
          }
          ledgerWalletsRef.current = facades;
          setLedgerAccounts(discovered);
          const configuredIndex = defaultLedgerAccountIndex(ledgerConfig.defaultAccountIndex);
          setLedgerAccountIndex(configuredIndex);
          setWallet(facades.get(configuredIndex));
          setAccount(discovered[configuredIndex]);
          return;
        }
        nextWallet = ledgerWalletsRef.current.get(ledgerAccountIndex) ?? createPilotWallet({
          provider: "ledger",
          network,
          ledger: { transport: ledgerTransport, accountIndex: ledgerAccountIndex },
        });
        await nextWallet.connect();
        nextAccount = await nextWallet.address();
        if (restoringActiveDelegation && nextAccount !== savedActiveRecord?.account) {
          throw new Error("The reconnected Ledger account does not match the active delegation owner.");
        }
        if (!nextWallet.verifyAddressOnDevice) {
          throw new Error("The Ledger wallet cannot verify its address on the device.");
        }
        await nextWallet.verifyAddressOnDevice();
        const session = await loadWalletSessionStatus();
        if (!ledgerSessionMatches(session, { account: nextAccount, network })) {
          await bindWalletSession(nextWallet, nextAccount, network);
        }
      } else {
        if (isExtensionWalletProvider(provider) && availableExtension !== provider) {
          throw new Error("Check the selected extension before connecting an account.");
        }
        if (
          isExtensionWalletProvider(provider) &&
          connectedExtension === provider && wallet && account
        ) {
          nextWallet = wallet;
          nextAccount = account;
        } else {
          nextWallet = isExtensionWalletProvider(provider) && wallet
            ? wallet
            : createPilotWallet({ provider, network });
          await nextWallet.connect();
          nextAccount = await nextWallet.address();
          if (isExtensionWalletProvider(provider)) {
            if (restoringActiveDelegation && nextAccount !== savedActiveRecord?.account) {
              await nextWallet.disconnect?.();
              throw new Error(
                "The reconnected extension account does not match the active delegation owner.",
              );
            }
            setWallet(nextWallet);
            setAccount(nextAccount);
            setConnectedExtension(provider);
            setWalletSessionReady(false);
            setWalletSessionStatusUnavailable(false);
            setModelSessionStatusUnavailable(false);
            setWalletNotice(
              `${provider === "gemwallet" ? "GemWallet" : "Crossmark"} account ${nextAccount} is connected on ${network}. Pilot has not issued its wallet challenge or requested the AccountSet authentication proof yet. Account connection may show the extension's own access or SignIn prompt. Review the next action, then sign the separate non-broadcast Pilot authentication proof.`,
            );
            return;
          }
        }
        await bindWalletSession(nextWallet, nextAccount, network);
      }
      if (!nextAccount) throw new Error("The wallet did not return an account address.");
      setWallet(nextWallet);
      setAccount(nextAccount);
      setWalletSessionReady(true);
      setWalletSessionStatusUnavailable(false);
      setModelSessionStatusUnavailable(false);
      if (isExtensionWalletProvider(provider)) setConnectedExtension(provider);
      setLedgerRestoredWithoutDevice(false);
      sessionStorage.setItem("pilot:wallet", JSON.stringify(storedOnboardingWalletSession(
        provider,
        network,
        nextAccount,
        provider === "ledger" ? storedLedgerSelection() : undefined,
      )));
      setWalletNotice(undefined);
      if (reconnectingAfterSignOut) {
        setRestorationSuppressed(false);
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.delete("wallet");
        window.history.replaceState(
          window.history.state,
          "",
          `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
        );
      }
      const stored = parseStoredPendingSubmission(
        sessionStorage.getItem("pilot:onboarding-pending"),
        nextAccount,
        network,
      );
      if (stored) {
        let resumedTrustLink: AccountLink | undefined;
        if (stored.kind === "trust" && stored.submissionRoute === "harbor") {
          const status = await harbor.op("account.status", { owner: nextAccount, network });
          if (
            !status.ok || !hasExactOnboardingPermissions(status.data) ||
            status.data.delegate !== stored.expectedDelegate
          ) {
            throw new Error(
              "The pending Harbor TrustSet no longer has its exact active delegation.",
            );
          }
          resumedTrustLink = status.data;
          setLink(status.data);
        }
        let completed: ApprovalSubmission;
        try {
          completed = stored.kind === "trust" && stored.submissionRoute !== "harbor"
            ? await waitForValidatedDirectTrustSet(
              harbor,
              { hash: stored.hash, network, validated: false },
              nextAccount,
              network,
              publicConfig.stableAsset,
              stored.lastLedgerSequence,
              { attempts: 120 },
            )
            : await waitForValidatedSubmission(
              harbor,
              { hash: stored.hash, validated: false },
              nextAccount,
              network,
              stored.lastLedgerSequence,
              { attempts: 120 },
            );
          if (
            completed.status === "validated" && stored.kind === "trust" &&
            stored.submissionRoute === "harbor"
          ) {
            await requireExactConfiguredTrustLine(
              harbor,
              nextAccount,
              network,
              publicConfig.stableAsset,
            );
            sessionStorage.setItem(
              ONBOARDING_READINESS_KEY,
              JSON.stringify(onboardingReadinessHint(nextAccount, stored.hash)),
            );
            await requireLiveOnboardingReadiness(harbor, resumedTrustLink!, stored.hash);
            sessionStorage.removeItem(ONBOARDING_TRUST_APPROVAL_KEY);
            sessionStorage.removeItem(ONBOARDING_TRUST_INTENT_KEY);
          }
        } catch (cause) {
          const rebuildStep = clearTerminalPendingSubmission(cause, stored.kind, sessionStorage);
          if (rebuildStep) {
            setPersistedPendingExitGuard(false);
            setStep(stored.kind === "trust" && stored.submissionRoute === "harbor"
              ? "delegate"
              : rebuildStep);
          }
          throw cause;
        }
        if (completed.status !== "validated") {
          setStep(stored.kind === "trust" ? "fund" : stored.kind === "revoke" ? "ready" : "delegate");
          throw new Error(`Transaction ${stored.hash} is still pending; resume status polling without signing again.`);
        }
        if (stored.kind === "trust") {
          const nextStep = nextStepAfterValidatedTrust(provider, network, publicConfig.mockMode);
          if (nextStep === "acquire") {
            clearPersistedOnboardingPending(sessionStorage, setPersistedPendingExitGuard);
            setPending(undefined);
            setStep("acquire");
            return;
          }
          if (publicConfig.mockMode) {
            setFundingSource("fixture");
          } else {
            const fundingResponse = await fetch("/api/dev/fund", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(devFundRequestBody(nextAccount, network)),
            });
            if (!fundingResponse.ok) {
              const payload = await fundingResponse.json().catch(() => undefined) as
                | { error?: { message?: string } }
                | undefined;
              throw new Error(payload?.error?.message || "The test-network funding request failed.");
            }
            setFundingSource("route");
          }
          clearPersistedOnboardingPending(sessionStorage, setPersistedPendingExitGuard);
          setFunded(true);
          setStep("delegate");
          return;
        }
        if (stored.kind === "revoke") {
          const revoked = await waitForRevokedOnboardingLink(
            harbor,
            nextAccount,
            network,
            stored.expectedDelegate!,
            stored.hash,
          );
          await finalizeValidatedOnboardingRevocation(
            provider,
            nextWallet,
            clearWalletSession,
            sessionStorage,
          );
          setLink(revoked);
          setWallet(undefined);
          setAccount(undefined);
          setWalletSessionReady(false);
          setWalletSessionStatusUnavailable(false);
          setModelSessionStatusUnavailable(false);
          setConnectedExtension(undefined);
          setAvailableExtension(undefined);
          setLedgerRestoredWithoutDevice(false);
          setStoredActiveExitGuard(false);
          setPersistedPendingExitGuard(false);
          setPending(undefined);
          setStep("wallet");
          return;
        }
        const activeLink = await waitForActiveOnboardingLink(
          harbor,
          nextAccount,
          network,
          stored.expectedDelegate!,
          stored.hash,
        );
        setLink(activeLink);
        sessionStorage.removeItem("pilot:onboarding-pending");
        setPersistedPendingExitGuard(false);
        if (shouldUseLiveDevAcquisition(provider, network, publicConfig.mockMode)) {
          setStep("delegate");
          return;
        }
        setStep("ready");
        sessionStorage.setItem(
          "pilot:onboarding",
          JSON.stringify(storedActiveOnboardingRecord(
            activeLink,
            provider,
            model,
            aiMode,
            stored.hash,
            provider === "ledger" ? storedLedgerSelection() : undefined,
          )),
        );
        return;
      }
      if (savedActiveRecordRaw) {
        const activeRecord = savedActiveRecord;
        if (
          !activeRecord || activeRecord.account !== nextAccount ||
          activeRecord.network !== network || activeRecord.provider !== provider
        ) {
          throw new Error(
            "The saved active delegation does not match this wallet, provider, and network.",
          );
        }
        const activeLink = await restoreActiveOnboardingLink(harbor, activeRecord);
        setLink(activeLink);
        setModel(activeRecord.model);
        setAiMode(activeRecord.aiMode);
        setFunded(true);
        setFundingSource(publicConfig.mockMode
          ? "fixture"
          : provider === "dev" && network === "testnet"
            ? "acquisition"
            : "route");
        setStep("ready");
        return;
      }
      if (shouldUseLiveDevAcquisition(provider, network, publicConfig.mockMode)) {
        let recoveredLink: AccountLink | undefined;
        const linkStatus = await harbor.op("account.status", { owner: nextAccount, network });
        if (
          linkStatus.ok && linkStatus.data.status === "pending" &&
          hasExactOnboardingPermissionList(linkStatus.data)
        ) {
          setFunded(true);
          setFundingSource("route");
          setStep("delegate");
          return;
        }
        if (linkStatus.ok && linkStatus.data.status === "active") {
          if (!hasExactOnboardingPermissions(linkStatus.data)) {
            throw new Error(
              "The active Testnet delegation does not contain exactly the seven onboarding permissions.",
            );
          }
          recoveredLink = linkStatus.data;
          setLink(recoveredLink);
          setFunded(true);
          setFundingSource("route");
          const storedApproval = parseStoredOnboardingTrustApproval(
            sessionStorage.getItem(ONBOARDING_TRUST_APPROVAL_KEY),
            nextAccount,
          );
          if (storedApproval) {
            if (
              storedApproval.delegate !== recoveredLink.delegate ||
              Date.parse(storedApproval.expires_at) <= Date.now()
            ) {
              sessionStorage.removeItem(ONBOARDING_TRUST_APPROVAL_KEY);
              sessionStorage.removeItem(ONBOARDING_TRUST_INTENT_KEY);
            } else {
              const accountInfo = await harbor.op("ledger.account.info", {
                account: nextAccount,
                network,
                ledger_index: "validated",
              });
              if (!accountInfo.ok) throw new Error(accountInfo.error.message);
              const sequence = accountInfo.data.account_data.Sequence;
              if (!Number.isSafeInteger(sequence)) {
                throw new Error("Harbor did not return the validated account sequence.");
              }
              const signable = signableTrustBuild(storedApproval.build);
              assertSafeTrustSet(
                signable,
                nextAccount,
                network,
                publicConfig.stableAsset,
                validatedLedgerIndex(accountInfo.data),
                Number(sequence),
              );
              setPending({
                kind: "trust",
                build: signable,
                approvalId: storedApproval.approval_id,
                expiresAt: storedApproval.expires_at,
                expectedDelegate: storedApproval.delegate,
              });
              setStep("delegate");
              return;
            }
          }
          const trusted = await hasExactConfiguredTrustLine(
            harbor,
            nextAccount,
            network,
            publicConfig.stableAsset,
          );
          if (!trusted) {
            setStep("delegate");
            return;
          }
          const readinessHint = parseOnboardingReadinessHint(
            sessionStorage.getItem(ONBOARDING_READINESS_KEY),
            nextAccount,
          );
          if (!readinessHint) {
            throw new Error(
              "The validated TrustSet is missing its Harbor onboarding readiness evidence.",
            );
          }
          await requireLiveOnboardingReadiness(
            harbor,
            recoveredLink,
            readinessHint.trust_set_hash,
          );
        }
        const hint = parseAcquisitionRecoveryHint(
          sessionStorage.getItem(ACQUISITION_RECOVERY_KEY),
          nextAccount,
        );
        if (hint) {
          const recovered = await recoverRlusdAcquisition(hint);
          setAcquisition(recovered);
          if (recovered.status === "validated") {
            sessionStorage.removeItem(ACQUISITION_RECOVERY_KEY);
            setFundingSource("acquisition");
            setFunded(true);
            if (recoveredLink && recovered.hash) {
              sessionStorage.setItem(
                "pilot:onboarding",
                JSON.stringify(storedActiveOnboardingRecord(
                  recoveredLink,
                  provider,
                  model,
                  aiMode,
                  recovered.hash,
                  provider === "ledger" ? storedLedgerSelection() : undefined,
                )),
              );
              clearOnboardingTrustCheckpoints(sessionStorage);
              setStep("ready");
            } else {
              setStep("delegate");
            }
            return;
          }
          setStep("acquire");
          if (recovered.status === "prepared") {
            if (Date.parse(recovered.approval_expires_at!) <= Date.now()) {
              throw new Error("The RLUSD acquisition owner approval expired before it could be signed.");
            }
            setPending({ kind: "acquire", state: recovered as PreparedAcquisitionState });
            return;
          }
          if (recovered.status === "signed_pending") {
            throw new Error(
              `RLUSD acquisition ${recovered.hash} is still pending. Pilot checked status without signing or submitting again.`,
            );
          }
          throw new Error(`The RLUSD acquisition is ${recovered.status.replaceAll("_", " ")}.`);
        }
        if (recoveredLink) {
          setStep("acquire");
          return;
        }
      }
      setStep(nextStepAfterWalletAuthentication());
    });

  const prepareFunding = () =>
    run(async () => {
      if (!account || !wallet || !network || !publicConfig) {
        throw new Error("Connect a wallet before funding it.");
      }
      assertOfficialLiveDevRlusdConfig(publicConfig, provider);
      if (publicConfig.mockMode) {
        setFundingSource("fixture");
        setFunded(true);
        setStep("delegate");
        return;
      }
      const acquisitionFunding = shouldUseLiveDevAcquisition(
        provider,
        network,
        publicConfig.mockMode,
      );
      if (acquisitionFunding && link?.status === "active") {
        await requireActivatedDelegateAccount(harbor, link);
        await prepareLiveTrustForLink(link);
        return;
      }
      const priorFundingHint = acquisitionFunding
        ? parseAcquisitionRecoveryHint(sessionStorage.getItem(ACQUISITION_FAUCET_RECOVERY_KEY), account)
        : undefined;
      let fundingHint = priorFundingHint;
      if (acquisitionFunding && !fundingHint) {
        const initialized = await requestRlusdAcquisition(
          rlusdAcquisitionRequestBody("initialize"),
          account,
        );
        if (initialized.status !== "initializing") {
          throw new Error(
            `The server-owned RLUSD acquisition operation is ${initialized.status.replaceAll("_", " ")}; it cannot authorize another faucet request.`,
          );
        }
        fundingHint = acquisitionRecoveryHint(initialized);
        // Persist the public operation identity before the possibly ambiguous
        // faucet POST so a retry cannot dispatch another request.
        sessionStorage.setItem(
          ACQUISITION_FAUCET_RECOVERY_KEY,
          JSON.stringify(fundingHint),
        );
      }
      const faucetBody = fundingHint
        ? acquisitionFaucetRequestBody(account, fundingHint.operation_id)
        : { address: account, network };
      const faucetResponse = await fetch("/api/dev/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(faucetBody),
      });
      const faucetPayload = await faucetResponse.json().catch(() => undefined) as
        | { error?: { message?: string }; funded?: boolean; message?: string }
        | undefined;
      if (!faucetResponse.ok) {
        throw new Error(
          faucetPayload?.error?.message || "The public test-network faucet is unavailable.",
        );
      }
      if (acquisitionFunding && faucetPayload?.funded !== true) {
        throw new Error(
          faucetPayload?.message ||
          "The prior Testnet faucet request is still awaiting validated XRP headroom. Pilot will not submit it again.",
        );
      }
      if (fundingHint) sessionStorage.removeItem(ACQUISITION_FAUCET_RECOVERY_KEY);
      await requireActivatedAccount(harbor, account, network, provider);
      if (acquisitionFunding) {
        setFundingSource("route");
        setFunded(true);
        setStep("delegate");
        return;
      }
      const build = await harbor.op("tx.trustSet", {
        account,
        network,
        intent_id: `onboarding-trust-${publicConfig.stableAsset.currency.toLowerCase()}`,
        limit_amount: {
          currency: harborIssuedCurrency(publicConfig.stableAsset.currency),
          issuer: publicConfig.stableAsset.issuer!,
          value: "10000",
        },
      });
      if (!build.ok) throw new Error(build.error.message);
      const accountInfo = await harbor.op("ledger.account.info", {
        account,
        network,
        ledger_index: "validated",
      });
      if (!accountInfo.ok) throw new Error(accountInfo.error.message);
      const ledgerIndex = validatedLedgerIndex(accountInfo.data);
      const accountSequence = accountInfo.data.account_data.Sequence;
      if (!Number.isSafeInteger(accountSequence)) throw new Error("Harbor did not return the validated account sequence.");
      const signable = signableTrustBuild(build.data);
      assertSafeTrustSet(signable, account, network, publicConfig.stableAsset, ledgerIndex, Number(accountSequence));
      setPending({ kind: "trust", build: signable });
    });

  const prepareAcquisition = () =>
    run(async () => {
      if (!account || !network || !publicConfig || !wallet) {
        throw new Error("Connect the Testnet development signer before acquiring RLUSD.");
      }
      if (!shouldUseLiveDevAcquisition(provider, network, publicConfig.mockMode)) {
        throw new Error("The local RLUSD acquisition is available only to the live Testnet development signer.");
      }
      assertOfficialLiveDevRlusdConfig(publicConfig, provider);
      const existing = parseAcquisitionRecoveryHint(
        sessionStorage.getItem(ACQUISITION_RECOVERY_KEY),
        account,
      );
      const refreshExpired = existing && acquisition?.status === "expired_unsubmitted" &&
        acquisition.operation_id === existing.operation_id;
      if (refreshExpired) setPending(undefined);
      const state = existing
        ? await requestRlusdAcquisition(
          rlusdAcquisitionRecoveryRequestBody(existing, acquisition),
          account,
        )
        : await requestRlusdAcquisition(rlusdAcquisitionRequestBody("prepare"), account);
      setAcquisition(state);
      sessionStorage.setItem(
        ACQUISITION_RECOVERY_KEY,
        JSON.stringify(acquisitionRecoveryHint(state)),
      );
      if (state.status === "validated") {
        sessionStorage.removeItem(ACQUISITION_RECOVERY_KEY);
        setFundingSource("acquisition");
        setFunded(true);
        if (link && hasExactOnboardingPermissions(link) && state.hash) {
          sessionStorage.setItem(
            "pilot:onboarding",
            JSON.stringify(storedActiveOnboardingRecord(
              link,
              provider,
              model,
              aiMode,
              state.hash,
              provider === "ledger" ? storedLedgerSelection() : undefined,
            )),
          );
          clearOnboardingTrustCheckpoints(sessionStorage);
          setStep("ready");
        } else {
          setStep("delegate");
        }
        return;
      }
      if (state.status === "prepared") {
        if (
          typeof state.approval_expires_at !== "string" ||
          Date.parse(state.approval_expires_at) <= Date.now()
        ) {
          throw new Error("The RLUSD acquisition owner approval expired before it could be signed.");
        }
        setPending({ kind: "acquire", state: state as PreparedAcquisitionState });
        return;
      }
      if (state.status === "signed_pending") {
        throw new Error(
          `RLUSD acquisition ${state.hash} is still pending. Pilot checked status without signing or submitting again.`,
        );
      }
      throw new Error(`The RLUSD acquisition is ${state.status.replaceAll("_", " ")}.`);
    });

  const prepareDelegation = () =>
    run(async () => {
      if (!account || !wallet || !network) throw new Error("Connect a wallet before linking it.");
      if (liveDevAcquisition && !funded) {
        throw new Error("The Testnet account must have validated XRP headroom before delegation.");
      }
      const response = await harbor.op("account.link", {
        owner: account,
        network,
        permissions: [...DEFAULT_PERMISSIONS],
      });
      if (!response.ok) throw new Error(response.error.message);
      if (provider === "ledger" && !hasExactLedgerPermissionSet(response.data.permissions)) {
        throw new Error("Harbor returned a permission set that does not match the seven Ledger legend values.");
      }
      if (!response.data.delegate_set_tx) throw new Error("Harbor did not prepare a DelegateSet transaction.");
      const accountInfo = await harbor.op("ledger.account.info", {
        account,
        network,
        ledger_index: "validated",
      });
      if (!accountInfo.ok) throw new Error(accountInfo.error.message);
      const ledgerIndex = validatedLedgerIndex(accountInfo.data);
      const accountSequence = accountInfo.data.account_data.Sequence;
      if (!Number.isSafeInteger(accountSequence)) throw new Error("Harbor did not return the validated account sequence.");
      assertSafeDelegateSet(response.data, account, network, ledgerIndex, Number(accountSequence));
      setLink(response.data);
      if (!liveDevAcquisition && provider !== "ledger") {
        setPending({ kind: "delegate", link: response.data });
      }
    });

  const reviewFundedDelegation = () =>
    run(async () => {
      if (!link || link.status !== "pending" || !link.delegate_set_tx) {
        throw new Error("Prepare the exact pending DelegateSet before reviewing it.");
      }
      if (provider === "ledger" && !ledgerBlindSigningConfirmed) {
        throw new Error("Confirm that blind signing is on before reviewing the Ledger delegation.");
      }
      await requireActivatedDelegateAccount(harbor, link);
      setPending({ kind: "delegate", link });
    });

  const prepareRevocation = () =>
    run(async () => {
      if (!hasVerifiedRevocationContext({
        provider,
        walletConnected: Boolean(wallet),
        sessionAuthenticated: walletSessionReady,
        account,
        network,
        link,
      })) {
        throw new Error(
          "A connected, authenticated supported wallet for this exact active or suspended Testnet delegation is required for revocation.",
        );
      }
      if (!account || !wallet || network !== "testnet" || !link) {
        throw new Error("The verified Testnet revocation context is unavailable.");
      }
      if (hasPersistedPendingSubmission(
        sessionStorage.getItem("pilot:onboarding-pending"),
      )) {
        throw new Error(
          "A signed onboarding transaction is already unresolved. Resume status recovery without preparing another revocation.",
        );
      }
      const prepared = await prepareOnboardingRevocation(
        harbor,
        account,
        network,
        link.delegate,
      );
      setLink(prepared);
      setPending({ kind: "revoke", link: prepared });
    });

  useEffect(() => {
    const record = requestedRevocationRef.current;
    if (!record || busy) return;
    if (error !== undefined || step === "ready") {
      void dispatchRequestedOnboardingRevocation(requestedRevocationRef, {
        provider,
        walletConnected: Boolean(wallet),
        sessionAuthenticated: walletSessionReady,
        account,
        network,
        link,
        step,
        busy,
        error,
        pendingKind: pending?.kind,
        persistedPendingSubmission: persistedPendingExitGuard,
      }, async () => prepareRevocation());
    }
  }, [
    account,
    busy,
    error,
    link,
    network,
    pending?.kind,
    persistedPendingExitGuard,
    provider,
    step,
    wallet,
    walletSessionReady,
  ]);

  const approvalRequest = useMemo<ApprovalRequest | undefined>(() => {
    if (!pending || !network) return undefined;
    if (pending.kind === "trust") {
      return {
        approvalId: pending.approvalId,
        expiresAt: pending.expiresAt,
        txJson: pending.build.tx_json,
        summary: {
          action: pending.build.summary.action,
          amounts: pending.build.summary.amounts,
          destination: destinationFrom(pending.build.tx_json),
          feeDrops: pending.build.summary.fee_drops,
          network,
        },
      };
    }
    if (pending.kind === "acquire") {
      return {
        expiresAt: pending.state.approval_expires_at,
        txJson: pending.state.tx_json,
        summary: {
          action: "Acquire exactly 75 official Testnet RLUSD",
          amounts: [
            `${RLUSD_ACQUISITION_EXACT_OUTPUT} official Testnet RLUSD`,
            "Spend at most 275 XRP, including the 1% slippage ceiling",
            "Fill or kill (FOK): receive all 75 RLUSD or cancel",
          ],
          destination: OFFICIAL_TESTNET_RLUSD_ISSUER,
          feeDrops: String(pending.state.tx_json.Fee ?? "100"),
          network: "testnet",
        },
      };
    }
    const txJson = pending.kind === "revoke"
      ? pending.link.revoke_tx!
      : pending.link.delegate_set_tx!;
    return {
      txJson,
      summary: {
        action: pending.kind === "revoke"
          ? revocationApprovalAction(provider)
          : `Grant ${pending.link.permissions.length} scoped permissions to Harbor's delegate`,
        amounts: pending.kind === "revoke"
          ? [
              "No payment or value transfer",
              "Stops new delegated submissions after validated ledger evidence; does not cancel an in-flight transaction",
            ]
          : ["No payment or value transfer"],
        destination: pending.link.delegate,
        feeDrops: String(txJson.Fee ?? "12"),
        network,
      },
    };
  }, [network, pending, provider]);

  const approvalWallet: SignOnlyWallet | undefined = wallet &&
    provider === "ledger" && (pending?.kind === "delegate" || pending?.kind === "revoke")
    ? {
        async signOnly(txJson) {
          try {
            return await wallet.signOnly(txJson);
          } catch (cause) {
            if (isLedgerBlindSigningDisabled(cause)) {
              setLedgerBlindSigningConfirmed(false);
              setPending(undefined);
              setError(ledgerDelegateSetBlindSigningMessage(
                pending?.kind === "revoke" ? "revoke" : "delegate",
              ));
              setErrorCode("LEDGER_BLIND_SIGNING_DISABLED");
            }
            throw cause;
          }
        },
      }
    : wallet;

  const preflightRevocationApproval = async () => {
    if (!account || network !== "testnet" || pending?.kind !== "revoke") {
      throw new Error("The reviewed Testnet revocation is unavailable.");
    }
    await preflightPreparedOnboardingRevocation(
      harbor,
      pending.link,
      account,
      network,
      pending.link.delegate,
      sessionStorage,
    );
  };

  const submitApproval = async (txBlob: string, approvalId?: string): Promise<ApprovalSubmission> => {
    if (!account || !network || !pending) throw new Error("The wallet-bound account is unavailable.");
    const expectedApprovalId = pending.kind === "trust" ? pending.approvalId : undefined;
    if (approvalId !== expectedApprovalId) {
      throw new Error("The wallet approval reference does not match the prepared transaction.");
    }
    if (pending.kind === "acquire") {
      const hint = acquisitionRecoveryHint(pending.state);
      let state: RlusdAcquisitionRouteState;
      try {
        state = await requestRlusdAcquisition(
          rlusdAcquisitionRequestBody("submit", pending.state.operation_id, txBlob),
          account,
        );
      } catch (cause) {
        // A lost submit response is ambiguous. Status is the only safe recovery:
        // once the route has durably entered signed_pending, never send the blob again.
        state = await recoverRlusdAcquisition(hint).catch(() => {
          throw cause;
        });
      }
      setAcquisition(state);
      if (state.status === "validated") {
        return { status: "validated", hash: state.hash };
      }
      if (state.status === "signed_pending") {
        return { status: "pending", hash: state.hash };
      }
      throw new Error(`The RLUSD acquisition is ${state.status.replaceAll("_", " ")}.`);
    }
    const lastLedgerSequence = Number(pending.kind === "trust"
      ? pending.build.tx_json.LastLedgerSequence
      : pending.kind === "revoke"
        ? pending.link.revoke_tx?.LastLedgerSequence
        : pending.link.delegate_set_tx?.LastLedgerSequence);
    const expectedHash = hashes.hashSignedTx(txBlob).toUpperCase();
    if (pending.kind === "trust") {
      if (!publicConfig) throw new Error("The stable asset configuration is unavailable.");
      if (pending.approvalId !== undefined) {
        sessionStorage.setItem(
          "pilot:onboarding-pending",
          JSON.stringify(pendingSubmissionRecord(pending, expectedHash, account, network)),
        );
        sessionStorage.removeItem(ONBOARDING_TRUST_APPROVAL_KEY);
        const response = await harbor.op("tx.submit", {
          tx_blob: txBlob,
          approval_id: pending.approvalId,
          network,
        });
        if (!response.ok) throw new Error(response.error.message);
        try {
          const completed = await waitForValidatedSubmission(
            harbor,
            response.data,
            account,
            network,
            lastLedgerSequence,
          );
          if (completed.status === "validated") {
            await requireExactConfiguredTrustLine(
              harbor,
              account,
              network,
              publicConfig.stableAsset,
            );
          }
          return completed;
        } catch (cause) {
          const rebuildStep = clearTerminalPendingSubmission(cause, pending.kind, sessionStorage);
          if (rebuildStep) {
            setPending(undefined);
            setStep(pending.approvalId === undefined ? rebuildStep : "delegate");
          }
          throw cause;
        }
      }
      const submitted = await authorizePersistAndSubmitDirectTrustSet(
        txBlob,
        expectedHash,
        pending,
        account,
        network,
        sessionStorage,
      );
      try {
        return await waitForValidatedDirectTrustSet(
          harbor,
          submitted,
          account,
          network,
          publicConfig.stableAsset,
          lastLedgerSequence,
        );
      } catch (cause) {
        const rebuildStep = clearTerminalPendingSubmission(cause, pending.kind, sessionStorage);
        if (rebuildStep) {
          setPending(undefined);
          setStep(rebuildStep);
        }
        throw cause;
      }
    }
    if (pending.kind === "revoke") {
      setPersistedPendingExitGuard(true);
      try {
        return await submitPreparedOnboardingRevocation(
          harbor,
          pending.link,
          txBlob,
          account,
          network,
          sessionStorage,
        );
      } catch (cause) {
        const rebuildStep = clearTerminalPendingSubmission(
          cause,
          pending.kind,
          sessionStorage,
        );
        if (rebuildStep) {
          setPersistedPendingExitGuard(false);
          setPending(undefined);
          setStep(rebuildStep);
        } else if (hasPersistedPendingSubmission(
          sessionStorage.getItem("pilot:onboarding-pending"),
        )) {
          // A submit response can be lost after Harbor receives the blob. Once
          // the signed hash is durable, close the signing surface and recover
          // only through status polling; never offer a second signature.
          setPending(undefined);
        } else {
          setPersistedPendingExitGuard(false);
        }
        throw cause;
      }
    }
    setPersistedPendingExitGuard(true);
    sessionStorage.setItem(
      "pilot:onboarding-pending",
      JSON.stringify(pendingSubmissionRecord(pending, expectedHash, account, network)),
    );
    const response = await harbor.op("tx.submit", {
      tx_blob: txBlob,
      network,
    });
    if (!response.ok) throw new Error(response.error.message);
    try {
      return await waitForValidatedSubmission(
        harbor,
        response.data,
        account,
        network,
        lastLedgerSequence,
      );
    } catch (cause) {
      const rebuildStep = clearTerminalPendingSubmission(cause, pending.kind, sessionStorage);
      if (rebuildStep) {
        setPersistedPendingExitGuard(false);
        setPending(undefined);
        setStep(rebuildStep);
      }
      throw cause;
    }
  };

  const preflightAcquisitionApproval = async () => {
    if (!account || !pending || pending.kind !== "acquire") {
      throw new Error("The current RLUSD acquisition approval is unavailable.");
    }
    const expected = pending.state;
    let checked: RlusdAcquisitionRouteState;
    try {
      checked = await requestRlusdAcquisition(
        rlusdAcquisitionPreflightRequestBody(expected),
        account,
      );
    } catch (cause) {
      const recovered = await recoverRlusdAcquisition(
        acquisitionRecoveryHint(expected),
      ).catch(() => undefined);
      if (recovered) {
        setAcquisition(recovered);
        if (recovered.status === "expired_unsubmitted") setPending(undefined);
      }
      setError(cause instanceof Error
        ? cause.message
        : "The RLUSD acquisition preflight was blocked.");
      throw cause;
    }
    if (acquisitionPreflightChanged(expected.approval_binding, checked)) {
      const message = "The reviewed RLUSD acquisition changed before signing. Review the current transaction.";
      setError(message);
      throw new Error(message);
    }
  };

  const recordAcquisitionSignCompletion = () => {
    if (!pending || pending.kind !== "acquire") return;
    console.info("rlusd_acquisition_timing", JSON.stringify({
      operationId: pending.state.operation_id,
      stage: "sign_completed",
      at: new Date().toISOString(),
      lastLedgerSequence: Number(pending.state.tx_json.LastLedgerSequence),
    }));
  };

  const finishPending = (submission: ApprovalSubmission) => {
    const action = pending;
    if (!action) return;
    void run(async () => {
      if (!account || !network) throw new Error("The wallet-bound account is unavailable.");
      try {
        if (action.kind === "acquire") {
          let state = acquisition;
          if (submission.status === "pending" || state?.status !== "validated") {
            state = await waitForValidatedRlusdAcquisition(
              acquisitionRecoveryHint(action.state),
              { attempts: 120 },
            );
            setAcquisition(state);
          }
          if (state.status !== "validated") {
            throw new Error(
              `RLUSD acquisition ${state.hash} is still pending; status recovery will not submit it again.`,
            );
          }
          sessionStorage.removeItem(ACQUISITION_RECOVERY_KEY);
          setFundingSource("acquisition");
          setFunded(true);
          setPending(undefined);
          if (link && hasExactOnboardingPermissions(link) && state.hash) {
            sessionStorage.setItem(
              "pilot:onboarding",
              JSON.stringify(storedActiveOnboardingRecord(
                link,
                provider,
                model,
                aiMode,
                state.hash,
                provider === "ledger" ? storedLedgerSelection() : undefined,
              )),
            );
            clearOnboardingTrustCheckpoints(sessionStorage);
            setStep("verify");
          } else {
            setStep("delegate");
          }
          return;
        }
        let completed = submission;
        if (completed.status === "pending") {
          const lastLedgerSequence = Number(action.kind === "trust"
            ? action.build.tx_json.LastLedgerSequence
            : action.kind === "revoke"
              ? action.link.revoke_tx?.LastLedgerSequence
              : action.link.delegate_set_tx?.LastLedgerSequence);
          completed = action.kind === "trust" && action.approvalId === undefined
            ? await waitForValidatedDirectTrustSet(
              harbor,
              { hash: completed.hash!, network, validated: false },
              account,
              network,
              publicConfig!.stableAsset,
              lastLedgerSequence,
              { attempts: 120 },
            )
            : await waitForValidatedSubmission(
              harbor,
              { hash: completed.hash!, validated: false },
              account,
              network,
              lastLedgerSequence,
              { attempts: 120 },
            );
          if (
            completed.status === "validated" && action.kind === "trust" &&
            action.approvalId !== undefined
          ) {
            await requireExactConfiguredTrustLine(
              harbor,
              account,
              network,
              publicConfig!.stableAsset,
            );
          }
          if (completed.status !== "validated") {
            throw new Error(`Transaction ${completed.hash} is still pending; resume status polling without signing again.`);
          }
        }
        if (action.kind === "trust" && action.approvalId !== undefined) {
          if (!publicConfig || !link || !completed.hash) {
            throw new Error("The Harbor TrustSet readiness context is unavailable.");
          }
          await requireExactConfiguredTrustLine(
            harbor,
            account,
            network,
            publicConfig.stableAsset,
          );
          sessionStorage.setItem(
            ONBOARDING_READINESS_KEY,
            JSON.stringify(onboardingReadinessHint(account, completed.hash)),
          );
          await requireLiveOnboardingReadiness(harbor, link, completed.hash);
          sessionStorage.removeItem(ONBOARDING_TRUST_APPROVAL_KEY);
          sessionStorage.removeItem(ONBOARDING_TRUST_INTENT_KEY);
        }
        if (action.kind === "trust") {
          if (!account || !network || !publicConfig) {
            throw new Error("The funding request is missing its public network configuration.");
          }
          const nextStep = nextStepAfterValidatedTrust(provider, network, publicConfig.mockMode);
          if (nextStep === "acquire") {
            sessionStorage.removeItem("pilot:onboarding-pending");
            setPending(undefined);
            setStep("acquire");
            return;
          }
          if (publicConfig.mockMode) {
            setFundingSource("fixture");
          } else {
            const response = await fetch("/api/dev/fund", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(devFundRequestBody(account, network)),
            });
            if (!response.ok) {
              const payload = await response.json().catch(() => undefined) as
                | { error?: { message?: string } }
                | undefined;
              throw new Error(payload?.error?.message || "The test-network funding request failed.");
            }
            setFundingSource("route");
          }
          sessionStorage.removeItem("pilot:onboarding-pending");
          setFunded(true);
          setPending(undefined);
          setStep("delegate");
          return;
        }
        if (action.kind === "revoke") {
          const revoked = await waitForRevokedOnboardingLink(
            harbor,
            account,
            network,
            action.link.delegate,
            completed.hash ?? "",
          );
          // Clear server authorization first. If that fails, retain the owner
          // key so the user can retry cleanup rather than strand a capability.
          if (!wallet) throw new Error("The verified wallet connection is unavailable.");
          await finalizeValidatedOnboardingRevocation(
            provider,
            wallet,
            clearWalletSession,
            sessionStorage,
          );
          setLink(revoked);
          setWallet(undefined);
          setAccount(undefined);
          setWalletSessionReady(false);
          setWalletSessionStatusUnavailable(false);
          setModelSessionStatusUnavailable(false);
          setConnectedExtension(undefined);
          setAvailableExtension(undefined);
          setLedgerRestoredWithoutDevice(false);
          setStoredActiveExitGuard(false);
          setPersistedPendingExitGuard(false);
          setPending(undefined);
          setStep("wallet");
          return;
        }
        const activeLink = await waitForActiveOnboardingLink(
          harbor,
          account,
          network,
          action.link.delegate,
          completed.hash ?? "",
        );
        setLink(activeLink);
        setPending(undefined);
        sessionStorage.removeItem("pilot:onboarding-pending");
        setPersistedPendingExitGuard(false);
        setStep("verify");
        sessionStorage.setItem(
          "pilot:onboarding",
          JSON.stringify(storedActiveOnboardingRecord(
            activeLink,
            provider,
            model,
            aiMode,
            completed.hash ?? "",
            provider === "ledger" ? storedLedgerSelection() : undefined,
          )),
        );
      } catch (cause) {
        if (action.kind !== "acquire") {
          const rebuildStep = clearTerminalPendingSubmission(cause, action.kind, sessionStorage);
          if (rebuildStep) {
            setPersistedPendingExitGuard(false);
            setPending(undefined);
            setStep(action.kind === "trust" && action.approvalId !== undefined
              ? "delegate"
              : rebuildStep);
          }
        }
        throw cause;
      }
    });
  };

  const payeeOptions = useMemo<MandatePayeeOption[]>(
    () => merchants.map(({ id, name }) => ({ id, name })),
    [merchants],
  );
  const mandateMerchants = useMemo(
    () =>
      merchants.map(({ id, name, required_credential, xrpl_address }) => ({
        credentialIssuer: required_credential.issuer,
        credentialTypeHex: required_credential.credential_type_hex,
        id,
        name,
        xrplAddress: xrpl_address,
      })),
    [merchants],
  );

  const signingCapability = walletBatchCapability(provider === "ledger" ? "gemwallet" : provider);
  const signingMode = signingCapability === "supported" ? "batch" : "sequential";
  const channelPreviews = useMemo(
    () =>
      preparedMandate
        ? mandateChannelPreviews(preparedMandate, mandateMerchants)
        : [],
    [mandateMerchants, preparedMandate],
  );

  const recordOpenFinance = (value: VerifiedOpenFinance) => {
    setOpenFinance(value);
    const proposal = Math.max(0.01, value.mandate_budget_usd);
    const total = proposal.toFixed(2);
    setMandateForm((current) => ({
      ...current,
      perPaymentMaxUsd: Math.min(5, proposal).toFixed(2),
      dailyMaxUsd: total,
      totalMaxUsd: total,
    }));
  };

  const continueToMandate = () =>
    run(async () => {
      if (!openFinance) {
        throw new Error("Verify the budget account with Open Finance first.");
      }
      const response = await harbor.op("merchants.list", {});
      if (!response.ok) throw new Error(response.error.message);
      if (response.data.length === 0) throw new Error("No AP4M merchants are available.");
      setMerchants(response.data);
      setMandateForm((current) => ({
        ...current,
        payees: current.payees.length ? current.payees : [response.data[0]!.id],
      }));
      setStep("mandate");
    });

  const prepareMandateApproval = () =>
    run(async () => {
      if (!account || !wallet) throw new Error("Connect the budget wallet first.");
      if (!openFinance) throw new Error("Open Finance verification is required.");
      const validated = validateMandateDraft(mandateForm, {
        maximumTotalUsd: openFinance.mandate_budget_usd.toFixed(2),
        availablePayeeIds: payeeOptions.map(({ id }) => id),
      });
      const expiresAt = new Date(validated.expiresAt).toISOString();
      const selectedSkus = merchants
        .filter(({ id }) => validated.payees.includes(id))
        .flatMap(({ products }) => products.map(({ sku }) => sku));
      const draft = await prepareMandateDraft(
        {
          audience: harborAudience,
          constraints: {
            currency: "USD",
            per_payment_max: validated.perPaymentMaxUsd,
            daily_max: validated.dailyMaxUsd,
            total_max: validated.totalMaxUsd,
            payees: validated.payees,
            ...(selectedSkus.length ? { skus: selectedSkus } : {}),
          },
          expiresAt,
          ofVerification: {
            customer_ref_hash: openFinance.customer_ref_hash,
            owner_name_hash: openFinance.owner_name_hash,
            verified: true,
          },
          owner: account,
        },
        {
          issueL1: async (input) => {
            const response = await fetch("/api/demo-network/vi/l1", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
            });
            const body = (await response.json()) as {
              digest?: string;
              error?: { message?: string };
              l1?: string;
            };
            if (!response.ok || !body.l1 || !body.digest) {
              throw new Error(
                body.error?.message ?? "The Demo Network could not issue the L1 intent.",
              );
            }
            return { digest: body.digest, l1: body.l1 };
          },
          prepare: async (input) => {
            const response = await harbor.op("mandate.prepare", input);
            if (!response.ok) throw new Error(response.error.message);
            return response.data;
          },
        },
      );
      // Validate exactly what the approval card will describe before rendering
      // any owner-signing action. A mismatch fails closed before a wallet prompt.
      mandateChannelPreviews(draft, mandateMerchants);
      setPreparedMandate(draft);
    });

  const approveMandate = () =>
    run(async () => {
      if (!wallet || !openFinance || !preparedMandate) {
        throw new Error("Prepare the mandate before approving it.");
      }
      const registered = await approveAndRegisterMandate(
        preparedMandate,
        signingCapability,
        {
          wallet,
          submit: async (txBlob) => {
            const response = await harbor.op("tx.submit", { tx_blob: txBlob, network: "testnet" });
            if (!response.ok) throw new Error(response.error.message);
            return "status" in response.data
              ? { status: "failed" as const }
              : { hash: response.data.hash, status: "validated" as const };
          },
          register: async (input) => {
            const response = await harbor.op("mandate.register", input);
            if (!response.ok) throw new Error(response.error.message);
            return response.data;
          },
        },
      );

      const active = {
        form: mandateForm,
        mandate: registered.mandate,
        setupTransactionHashes: registered.setupTxHashes,
      };
      // Clear compact L1/L2 presentations before any persistence or navigation.
      const l1Digest = preparedMandate.l1Digest;
      const l2Digest = preparedMandate.l2Digest;
      setPreparedMandate(undefined);
      setActiveMandate(active);
      const mandateNote = {
        owner: account,
        mandate_id: registered.mandate.id,
        network: "testnet",
        status: registered.mandate.status,
        execution_type: "DEFERRED",
        not_before: registered.mandate.not_before,
        expires_at: registered.mandate.expires_at,
        constraints: registered.mandate.constraints,
        l1_digest: l1Digest,
        l2_digest: l2Digest,
        setup_tx_hashes: registered.setupTxHashes,
        channels: registered.mandate.channels,
        open_finance: {
          label: openFinance.label,
          mode: openFinance.mode,
          owner_name_hash: openFinance.owner_name_hash,
          masked_account_label: `${openFinance.owner_name_masked} · •••• ${openFinance.last4}`,
          balance_snapshot: {
            amount: String(openFinance.balance),
            currency: openFinance.currency,
          },
        },
        recorded_at: new Date().toISOString(),
      };
      const vaultResponse = await fetch("/api/vault/ap4m/mandate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mandateNote),
      });
      if (!vaultResponse.ok) throw new Error("The mandate is active, but its vault evidence could not be written.");
      sessionStorage.setItem(
        "pilot:ap4m",
        JSON.stringify({
          mandateId: registered.mandate.id,
          status: registered.mandate.status,
          setupTransactionHashes: registered.setupTxHashes,
        }),
      );
      setStep("ready");
    });

  const signOutWalletAccess = () =>
    run(async () => {
      await signOutPilotWallet({
        disconnect: wallet?.disconnect ? () => wallet.disconnect!() : undefined,
      });
      setWallet(undefined);
      setAccount(undefined);
      setWalletSessionReady(false);
      setWalletSessionStatusUnavailable(false);
      setModelSessionStatusUnavailable(false);
      setAvailableExtension(undefined);
      setConnectedExtension(undefined);
      setOauthConnected(false);
      setModelAccessReady(false);
      setModels([]);
      setModel(DEFAULT_MODEL);
      setAiMode("demo");
      setDemoCatalog({ status: "idle" });
      setDemoLimits(undefined);
      setRestorationSuppressed(true);
      setStep("wallet");
      setWalletNotice(
        "Signed out of Pilot. Any saved delegation or pending-submission recovery record remains unchanged, and an active autonomous strategy continues until separately paused, stopped, or killed. Reconnect the exact wallet to continue.",
      );
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete("openrouter");
      nextUrl.searchParams.set("wallet", "signed-out");
      window.history.replaceState(
        window.history.state,
        "",
        `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
      );
    });

  const selectedModelChoice = models.find((choice) => choice.id === model);
  const selectingNearAi = selectedModelChoice?.provider === "near-ai";
  const modelAction = selectingNearAi
    ? continueNearAi
    : oauthConnected
      ? continueOpenRouter
      : startDemo;
  const modelActionLabel = selectingNearAi
    ? "Continue with NEAR AI"
    : oauthConnected
      ? "Continue with OpenRouter"
      : demoCatalog.status === "loading"
        ? "Checking free demo"
        : demoCatalog.status === "unavailable"
          ? "Free demo unavailable"
          : "Try free demo";

  return (
    <div className="flex min-h-dvh flex-col">
    <header className="border-b border-border">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-8 lg:px-12">
        <a href="/" className="flex items-center gap-1.5 focus-visible:outline-offset-4" aria-label="Pilot home">
          <Navigation aria-hidden="true" className="h-[1.05rem] w-[1.05rem] shrink-0 text-primary" strokeWidth={2.25} />
          <span className="text-[15px] font-medium tracking-tight text-primary">Pilot</span>
          <span className="label-mono ml-1 hidden sm:inline">Guided setup</span>
        </a>
        {/* A full navigation (not client routing) so the unresolved-delegation beforeunload warning still applies. */}
        <a href="/chat" className="bracket bracket-light inline-flex h-9 items-center gap-2 border border-border bg-white/[0.03] px-3 text-[13px] font-medium text-foreground transition hover:bg-white/[0.06] rounded-md">
          <X aria-hidden="true" className="size-3.5" />
          Exit setup
        </a>
      </div>
    </header>
    <main className="mx-auto flex w-full max-w-6xl flex-1 items-center px-4 py-8 sm:px-8 lg:px-12">
      <div className="bracket bracket-light grid w-full overflow-hidden border border-border bg-card lg:grid-cols-[0.8fr_1.2fr] rounded-xl">
        <aside aria-label="About setup" className="relative overflow-hidden border-b border-border bg-surface p-6 sm:p-9 lg:border-b-0 lg:border-r">
          <div className="relative">
            <p className="label-mono flex items-center gap-2"><Compass aria-hidden="true" className="size-3.5 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" />Get started</p>
            <h1 className="mt-4 max-w-md text-[1.75rem] font-semibold leading-[1.15] tracking-[-0.02em] font-display">Set up Pilot in about a minute.</h1>
            <p className="mt-5 max-w-md text-sm leading-6 text-muted-foreground">Connect your wallet and pick an AI model. Connecting is free: no money moves and nothing is sent to the ledger. Trading stays off until you turn it on.</p>
            <div className="mt-8"><OnboardingSteps current={step} includeAcquire={liveDevAcquisition} /></div>
          </div>
        </aside>

        <section className="min-w-0 p-6 sm:p-9 lg:p-12">
          {step === "ai" ? (
            <div className="space-y-6">
              <div><p className="label-mono">Step 2 of 3 · wallet connected</p><h2 className="mt-2 text-xl font-normal tracking-[-0.02em]">Choose an AI model <span className="text-muted-foreground">(optional)</span></h2><p className="mt-2 text-sm leading-6 text-muted-foreground">You’re signed in. Pick the model Pilot uses to chat. Try the free demo, use configured NEAR AI, connect your own OpenRouter account, or skip this for now. Provider keys stay on Pilot&apos;s server.</p></div>
              <ModelPicker
                {...{
                  bedrockMode: oauthConnected ? bedrockMode : "off",
                  bedrockModels,
                }}
                disabled={busy || walletSessionStatusUnavailable || modelSessionStatusUnavailable}
                models={models}
                onChange={(choice) => setModel(choice.id)}
                value={model}
              />
              {walletSessionStatusUnavailable ? (
                <div className="space-y-3">
                  <p className="border border-approval/35 bg-approval/10 px-3 py-2 text-xs leading-5 text-approval rounded-xl" role="status">
                    Pilot could not revalidate this wallet session. The known account remains visible, but model and trading changes are locked until the session can be checked again.
                  </p>
                  <AccountPanel account={account} network={network} />
                </div>
              ) : null}
              {!walletSessionStatusUnavailable && modelSessionStatusUnavailable ? (
                <div className="space-y-3">
                  <p className="border border-approval/35 bg-approval/10 px-3 py-2 text-xs leading-5 text-approval rounded-xl" role="status">
                    Pilot verified this wallet account but could not check its existing model session. Model changes are locked; retry when connectivity returns or use “Skip model setup” to clear the server session first.
                  </p>
                  <AccountPanel account={account} network={network} />
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                {walletSessionStatusUnavailable || modelSessionStatusUnavailable ? (
                  <span aria-disabled="true" className="bracket bracket-light inline-flex h-11 cursor-not-allowed items-center justify-center gap-2 border border-border bg-white/[0.03] px-4 text-[13px] font-medium opacity-45 rounded-md">
                    <ExternalLink className="size-4" /> {oauthConnected ? "Reconnect OpenRouter" : "Connect OpenRouter"}
                  </span>
                ) : (
                  <a className="bracket bracket-light inline-flex h-11 items-center justify-center gap-2 border border-border bg-white/[0.03] px-4 text-[13px] font-medium transition hover:bg-white/[0.06] rounded-md" href="/api/auth/openrouter/start?returnTo=%2Fonboarding%3Fopenrouter%3Dconnected" onClick={() => setAiMode("openrouter")}>
                    <ExternalLink className="size-4" /> {oauthConnected ? "Reconnect OpenRouter" : "Connect OpenRouter"}
                  </a>
                )}
                <button className="inline-flex h-11 items-center justify-center gap-2 bg-primary px-4 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45 rounded-md" disabled={busy || walletSessionStatusUnavailable || modelSessionStatusUnavailable || (!selectingNearAi && !oauthConnected && demoCatalog.status !== "available")} onClick={modelAction} type="button">
                  {busy || (!selectingNearAi && !oauthConnected && demoCatalog.status === "loading") ? <LoaderCircle className="size-4 animate-spin" /> : selectingNearAi || oauthConnected ? <ArrowRight className="size-4" /> : <Bot className="size-4" />} {modelActionLabel}
                </button>
              </div>
              {!selectingNearAi && !oauthConnected && demoCatalog.status === "unavailable" ? (
                <p className="border border-approval/35 bg-approval/10 px-3 py-2 text-xs leading-5 text-approval rounded-xl" role="status">
                  {demoCatalog.message} Connect OpenRouter instead, or return to the wallet step to explore the read-only demo.
                </p>
              ) : null}
              <p className="text-xs leading-5 text-muted-foreground">The free demo uses free models with a daily message limit.{demoLimits?.maxOutputTokens ? ` Each reply is capped at ${demoLimits.maxOutputTokens} tokens.` : ""}</p>
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
                <button className="bracket bracket-light inline-flex h-11 items-center justify-center gap-2 border border-border bg-white/[0.03] px-4 text-[13px] font-medium transition hover:bg-white/[0.06] disabled:opacity-50 rounded-md" disabled={busy} onClick={() => void signOutWalletAccess()} type="button"><WalletCards className="size-4" /> Use a different wallet</button>
                <button className="inline-flex h-11 items-center justify-center border border-border px-4 text-[13px] font-medium text-muted-foreground transition hover:bg-white/[0.04] disabled:opacity-50 rounded-md" disabled={busy} onClick={skipModelAccess} type="button">Skip model setup</button>
              </div>
            </div>
          ) : null}

          {step === "wallet" ? (
            <div className="space-y-6">
              <div><p className="label-mono">Step 1 of 3</p><h2 className="mt-2 text-xl font-normal tracking-[-0.02em]">Connect your wallet</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Open your wallet extension, switch it to Testnet, then pick it below. You’ll sign a free message to prove the account is yours.</p></div>
              {walletNotice ? <p className="border border-info/30 bg-info/[0.06] px-4 py-3 text-sm text-muted-foreground rounded-xl" role="status">{walletNotice}</p> : null}
              <div className="grid gap-3 sm:grid-cols-2">
                {(["gemwallet", "crossmark", "ledger", "dev"] as const)
                  .filter((choice) =>
                    choice === "ledger"
                      ? publicConfig?.ledger?.enabled
                      : choice !== "dev" || publicConfig?.devSignerEnabled)
                  .map((choice) => {
                    const unavailableReason = walletProviderUnavailableReason(choice) ??
                      walletViewportUnavailableReason(walletViewportState);
                    return (
                      <button aria-disabled={unavailableReason || busy ? true : undefined} aria-pressed={provider === choice} className={`border p-4 text-left transition rounded-md ${provider === choice ? "bracket bracket-accent border-border-strong bg-primary-soft" : "border-border bg-white/[0.02] hover:border-border-strong hover:bg-white/[0.04]"} disabled:cursor-not-allowed disabled:opacity-55`} disabled={Boolean(unavailableReason) || busy} key={choice} onClick={() => chooseWalletProvider(choice)} type="button">
                        <span className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{WALLET_NAMES[choice]}</span>{provider === choice ? <Check aria-hidden="true" className="size-4 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" /> : null}</span>
                        <span className="mt-2 block text-xs leading-5 text-muted-foreground">{unavailableReason ?? (choice === "gemwallet" ? "Recommended · browser extension" : choice === "crossmark" ? "Also works · browser extension" : choice === "ledger" ? "Hardware wallet" : "Temporary wallet for this browser")}</span>
                      </button>
                    );
                  })}
              </div>
              {provider === "ledger" && publicConfig?.ledger ? (
                <LedgerWalletStep
                  accountIndex={ledgerAccountIndex}
                  accounts={ledgerAccounts}
                  config={publicConfig.ledger}
                  onAccountIndexChange={(index) => {
                    setLedgerAccountIndex(index);
                    setWallet(ledgerWalletsRef.current.get(index));
                    setAccount(ledgerAccounts[index]);
                  }}
                  onTransportChange={(next) => {
                    if (next !== ledgerTransport) {
                      void run(async () => resetLedgerDiscovery(next));
                    }
                  }}
                  transport={ledgerTransport}
                  wallet={wallet}
                  simulatedDeviceSlot={
                    shouldShowSimulatedLedgerReplay(aiMode, ledgerAccounts) ? (
                      <SimulatedDevice transcript={verifyAddressTranscript} />
                    ) : undefined
                  }
                />
              ) : null}
              <DesktopWalletGuide smallScreen={walletViewportState === "small-screen"} />
              {!publicConfig ? <p className="text-xs text-muted-foreground" role="status">Getting things ready…</p> : null}
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <PrimaryButton
                  busy={busy || !publicConfig}
                  disabled={walletViewportState !== "desktop" || (provider === "ledger" && !ledgerTransportAvailable(publicConfig?.ledger, ledgerTransport))}
                  icon={<WalletCards className="size-4" />}
                  label={walletViewportState === "checking"
                    ? "Checking wallet availability"
                    : walletViewportState === "small-screen"
                      ? "Desktop wallet required"
                      : isExtensionWalletProvider(provider)
                        ? availableExtension !== provider
                          ? "Find my wallet"
                          : connectedExtension !== provider || !wallet || !account
                            ? "Connect account"
                            : "Sign in with wallet"
                        : provider === "ledger"
                          ? ledgerRestoredWithoutDevice
                            ? "Reconnect Ledger"
                            : LEDGER_ONBOARDING_ACCOUNT_INDEXES.every((index) => ledgerAccounts[index])
                              ? "Verify address and sign in"
                              : "Connect Ledger"
                          : "Authenticate wallet"}
                  onClick={isExtensionWalletProvider(provider) && availableExtension !== provider
                    ? checkWalletAvailability
                    : connectWallet}
                />
              </div>
            </div>
          ) : null}

          {step === "access" ? (
            <div className="space-y-6">
              <div>
                <p className="label-mono">Step 3 of 3 · done</p>
                <h2 className="mt-2 text-xl font-normal tracking-[-0.02em]">{modelAccessReady ? "You’re all set" : "Your wallet is connected"}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {modelAccessReady
                    ? "Pilot is ready to chat with your wallet."
                    : "Pilot is ready with your wallet. You can add an AI model any time."} Pilot can’t trade for you yet. That stays off until you turn it on.
                </p>
              </div>
              {walletSessionStatusUnavailable ? (
                <p className="border border-approval/35 bg-approval/10 px-4 py-3 text-sm leading-6 text-approval rounded-xl" role="status">
                  Pilot could not revalidate this wallet session. Read-only navigation remains available, but model and trading changes are locked until the session can be checked again.
                </p>
              ) : null}
              <AccountPanel account={account} network={network} />
              <div className="grid gap-px border border-border bg-border text-left sm:grid-cols-2 rounded-xl overflow-hidden">
                <div className="bg-card p-4"><p className="label-mono">Wallet</p><p className="mt-1.5 text-sm font-medium">{WALLET_NAMES[provider] ?? provider}</p></div>
                <div className="bg-card p-4"><p className="label-mono">AI model</p><p className="mt-1.5 text-sm font-medium">{modelAccessReady ? aiMode === "openrouter" ? "Your OpenRouter account" : aiMode === "near-ai" ? "Configured NEAR AI" : "Free demo" : "Not set up yet"}</p></div>
              </div>
              <p className="border border-approval/35 bg-approval/[0.06] px-4 py-3 text-sm leading-6 text-muted-foreground rounded-xl">
                Want Pilot to trade for you? Turn on Testnet trading next. You’ll review and sign each step in your wallet. You don’t need it to explore or chat.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <a className="inline-flex h-11 items-center justify-center gap-2 bg-primary px-4 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90 rounded-md" href="/chat">Open Pilot <ArrowRight className="size-4" /></a>
                <button className="bracket bracket-light inline-flex h-11 items-center justify-center gap-2 border border-border bg-white/[0.03] px-4 text-[13px] font-medium transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45 rounded-md" disabled={walletSessionStatusUnavailable} onClick={() => setStep("fund")} type="button"><ShieldCheck className="size-4" /> Enable Testnet trading</button>
              </div>
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
                <BackButton onClick={() => setStep("ai")} />
                <button className="inline-flex h-11 items-center justify-center border border-border px-4 text-[13px] font-medium text-muted-foreground transition hover:bg-white/[0.04] disabled:opacity-50 rounded-md" disabled={busy} onClick={() => void signOutWalletAccess()} type="button">Sign out wallet</button>
              </div>
            </div>
          ) : null}

          {tradingStepLocked ? (
            <div className="space-y-6">
              <div>
                <p className="label-mono">Session check required · authority preserved</p>
                <h2 className="mt-2 text-xl font-normal tracking-[-0.02em]">Trading changes are locked</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Pilot could not revalidate this wallet session, so every signature, submission, delegation, mandate, and revocation control is unavailable. Pilot has not changed or revoked any existing Testnet state. A trust line, funding, delegation, mandate, pending transaction, or strategy that already existed may still remain active.
                </p>
              </div>
              <AccountPanel account={account} network={network} />
              {link?.status === "active" ? (
                <p className="border border-approval/35 bg-approval/10 px-4 py-3 text-sm leading-6 text-approval rounded-xl" role="status">
                  The recorded delegation for this account remains active until an exact owner-authorized revocation is completed. This temporary lock is not a revocation.
                </p>
              ) : pending ? (
                <p className="border border-approval/35 bg-approval/10 px-4 py-3 text-sm leading-6 text-approval rounded-xl" role="status">
                  A signed transaction remains pending or uncertain. Pilot will not sign or submit it again while the wallet session is indeterminate.
                </p>
              ) : (
                <p className="border border-approval/35 bg-approval/10 px-4 py-3 text-sm leading-6 text-approval rounded-xl" role="status">
                  Partially completed Testnet setup is preserved. Pilot will not assume it was rolled back or create additional authority while the wallet session is indeterminate.
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <a className="inline-flex h-11 items-center justify-center gap-2 bg-primary px-4 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90 rounded-md" href="/chat">Open read-only Pilot <ArrowRight className="size-4" /></a>
                <button className="bracket bracket-light inline-flex h-11 items-center justify-center gap-2 border border-border bg-white/[0.03] px-4 text-[13px] font-medium transition hover:bg-white/[0.06] rounded-md" onClick={() => window.dispatchEvent(new Event(WALLET_SESSION_CHANGED_EVENT))} type="button">Retry session check</button>
              </div>
            </div>
          ) : null}

          {step === "fund" && !tradingStepLocked ? (
            <div className="space-y-6">
              <StepHeading eyebrow={`Optional trading · step 1 of ${liveDevAcquisition ? 6 : 5}`} title="Prepare the budget account">{liveDevAcquisition ? "Pilot requests the fixed Testnet XRP headroom, then your wallet signs the exact official RLUSD TrustSet. The next step acquires RLUSD through a separate owner approval." : `First sign a ${publicConfig?.stableAsset.currency ?? "configured stablecoin"} trust line. The test-only fund handoff then sends 1,000 ${publicConfig?.stableAsset.currency ?? "stablecoin units"} to this budget address; an explicitly enabled public mock records only a fixture.`}</StepHeading>
              <AccountPanel account={account} network={network} />
              {provider === "ledger" ? (
                <LedgerSigningGuide phase="trust" transport={ledgerTransport} wallet={wallet} />
              ) : null}
              <div className="border border-border bg-white/[0.02] p-4 text-sm text-muted-foreground rounded-xl"><p className="label-mono text-foreground">What happens</p><ol className="mt-3 space-y-2"><li>1. Pilot confirms the account has XRP for reserves, fees{liveDevAcquisition ? ", and the capped RLUSD acquisition" : ""}.</li><li>2. Harbor builds and simulates the TrustSet; your wallet signs that exact transaction, then Pilot relays it through its fixed test-network provider.</li><li>3. {liveDevAcquisition ? "Pilot unlocks the separate 75 RLUSD acquisition approval." : "The configured test-network stablecoin funding handoff runs."}</li></ol></div>
              {fundingSource === "fixture" ? <p className="border border-info/30 bg-info/[0.06] px-4 py-3 text-sm text-muted-foreground rounded-xl" role="status">Mock funding fixture staged. No testnet balance transfer was asserted.</p> : null}
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between"><BackButton onClick={() => setStep("access")} /><PrimaryButton busy={busy} icon={<NetworkIcon className="size-4" />} label={funded ? fundingSource === "fixture" ? "Mock budget staged" : "Budget funded" : "Create trust line"} onClick={prepareFunding} /></div>
            </div>
          ) : null}

          {step === "acquire" && !tradingStepLocked ? (
            <div className="space-y-6">
              <StepHeading eyebrow="Optional trading · step 2 of 6" title="Acquire 75 official Testnet RLUSD">Review an exact-output, fill-or-kill offer. It receives exactly 75 RLUSD or cancels, uses a 1% slippage ceiling, and can spend no more than 275 XRP.</StepHeading>
              <AccountPanel account={account} network={network} />
              <div className="border border-approval/35 bg-approval/[0.06] p-4 text-sm text-muted-foreground rounded-xl">
                <p className="label-mono text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]">Exact owner approval</p>
                <ul className="mt-3 space-y-2">
                  <li>75 official Testnet RLUSD</li>
                  <li>At most 275 XRP, including the 1% slippage ceiling</li>
                  <li>Fill or kill (FOK): all 75 RLUSD or the offer cancels</li>
                </ul>
              </div>
              {acquisition?.status === "signed_pending" ? <p className="border border-info/30 bg-info/[0.06] px-4 py-3 text-sm text-muted-foreground rounded-xl" role="status">The signed acquisition is pending. Check status safely; Pilot will not sign or submit it again.</p> : null}
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between"><BackButton onClick={() => setStep("fund")} /><PrimaryButton busy={busy} icon={<ShieldCheck className="size-4" />} label={acquisition?.status === "signed_pending" ? "Check acquisition status" : "Review RLUSD acquisition"} onClick={prepareAcquisition} /></div>
            </div>
          ) : null}

          {step === "delegate" && !tradingStepLocked ? (
            <div className="space-y-6">
              <StepHeading eyebrow={`Optional trading · step ${liveDevAcquisition ? 3 : 2} of ${liveDevAcquisition ? 6 : 5}`} title="Approve seven narrow permissions">None can send value to another account. Your wallet signs DelegateSet; Harbor's delegate pays network fees for permitted actions.</StepHeading>
              <ul className="grid gap-px border border-border bg-border sm:grid-cols-2 rounded-xl overflow-hidden">{DEFAULT_PERMISSIONS.map((permission) => <li className="flex items-center gap-2 bg-card px-3 py-2.5 text-[13px]" key={permission}><Check aria-hidden="true" className="size-3.5 shrink-0 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" />{permission.replace(/([a-z])([A-Z])/g, "$1 $2")}</li>)}</ul>
              <p className="border-l-2 border-approval/60 bg-approval/[0.05] px-4 py-3 text-sm text-muted-foreground">Payments, account controls, vaults, lending, and outer Batch transactions always require your signature.</p>
              {provider === "ledger" && link?.status === "pending" ? (
                <LedgerSigningGuide
                  blindSigningConfirmed={ledgerBlindSigningConfirmed}
                  delegateAddress={link.delegate}
                  onBlindSigningConfirmed={setLedgerBlindSigningConfirmed}
                  phase="delegate"
                  transport={ledgerTransport}
                  wallet={wallet}
                />
              ) : null}
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between"><BackButton onClick={() => setStep(liveDevAcquisition ? "acquire" : "fund")} /><PrimaryButton busy={busy} icon={<ShieldCheck className="size-4" />} label={provider === "ledger" && link?.status === "pending" ? "Review DelegateSet" : "Prepare DelegateSet"} onClick={provider === "ledger" && link?.status === "pending" ? reviewFundedDelegation : prepareDelegation} /></div>
            </div>
          ) : null}

          {step === "verify" && !tradingStepLocked ? (
            <div className="space-y-6">
              <StepHeading eyebrow={`Optional trading · step ${liveDevAcquisition ? 4 : 3} of ${liveDevAcquisition ? 6 : 5}`} title="Verify a bounded budget">Mastercard Open Finance supplies a mock, hash-only proof and a budget proposal. Raw customer references and credentials never reach this browser.</StepHeading>
              {provider === "ledger" ? <p className="border border-approval bg-approval/10 px-4 py-3 text-sm text-approval rounded-xl">Delegation validated. Turn blind signing off again in the XRP app before continuing.</p> : null}
              <OpenFinanceStep dailyCapUsd={25} onVerified={recordOpenFinance} />
              {openFinance ? (
                <p className="rounded-2xl border border-primary/20 bg-primary/8 px-4 py-3 text-sm text-muted-foreground" role="status">
                  Verified budget proposal: up to ${openFinance.mandate_budget_usd.toFixed(2)}. You can only lower it in the next step.
                </p>
              ) : null}
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
                <BackButton onClick={() => setStep("delegate")} />
                <PrimaryButton busy={busy} disabled={!openFinance} icon={<ArrowRight className="size-4" />} label="Set mandate limits" onClick={continueToMandate} />
              </div>
            </div>
          ) : null}

          {step === "mandate" && !tradingStepLocked ? (
            <div className="space-y-6">
              <StepHeading eyebrow={`Optional trading · step ${liveDevAcquisition ? 5 : 4} of ${liveDevAcquisition ? 6 : 5}`} title="Approve the autonomous mandate">Review the exact limits, merchants, expiry, and XRPL Testnet channel locks. Nothing is signed until you use the approval button below.</StepHeading>
              {activeMandate ? (
                <MandateSummary
                  draft={activeMandate.form}
                  mandateId={activeMandate.mandate.id}
                  payees={payeeOptions}
                  setupTransactionHashes={activeMandate.setupTransactionHashes}
                />
              ) : preparedMandate ? (
                <MandateApprovalCard
                  channels={channelPreviews}
                  disabled={busy}
                  draft={mandateForm}
                  onApprove={approveMandate}
                  onBack={() => setPreparedMandate(undefined)}
                  payees={payeeOptions}
                  promptCount={signingMode === "batch" ? 1 : preparedMandate.unsignedSequential?.length ?? 0}
                  signingMode={signingMode}
                />
              ) : (
                <>
                  <MandateBuilder
                    availablePayees={payeeOptions}
                    disabled={busy}
                    maximumTotalUsd={(openFinance?.mandate_budget_usd ?? 0).toFixed(2)}
                    onChange={setMandateForm}
                    value={mandateForm}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">
                    Demo Network — Mastercard&apos;s role in production. Verifiable Intent v0.1 is checked against the reference verifier before Harbor prepares setup transactions.
                  </p>
                  <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
                    <BackButton onClick={() => setStep("verify")} />
                    <PrimaryButton busy={busy} icon={<ShieldCheck className="size-4" />} label="Prepare approval" onClick={prepareMandateApproval} />
                  </div>
                </>
              )}
            </div>
          ) : null}

          {step === "ready" && !tradingStepLocked ? (
            <div className="space-y-6 text-center sm:text-left">
              <div className="mx-auto grid size-14 place-items-center border border-executed/40 bg-executed/10 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))] sm:mx-0 rounded-xl"><Check aria-hidden="true" className="size-7" strokeWidth={1.75} /></div>
              <StepHeading eyebrow={`Optional trading · step ${liveDevAcquisition ? 6 : 5} of ${liveDevAcquisition ? 6 : 5} · setup complete`} title={`Your ${network ?? "test-network"} trading setup is active`}>{fundingSource === "fixture" ? "The explicit mock funding fixture is staged" : "The test-network wallet is funded"}, the delegate is active, and the bounded AP4M mandate is ACTIVE.</StepHeading>
              <AccountPanel account={account} network={network} />
              {provider === "ledger" ? (
                <p className="border border-executed/35 bg-executed/10 px-4 py-3 text-left text-sm text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))] rounded-xl">
                  Owner: Ledger (account {ledgerAccountIndex}, verified on device) · Harbor delegate: {link?.permissions.length ?? DEFAULT_PERMISSIONS.length} permissions
                </p>
              ) : null}
              {activeMandate ? <MandateSummary draft={activeMandate.form} mandateId={activeMandate.mandate.id} payees={payeeOptions} setupTransactionHashes={activeMandate.setupTransactionHashes} /> : null}
              <div className="grid gap-px border border-border bg-border text-left sm:grid-cols-3 rounded-xl overflow-hidden"><div className="bg-card p-4"><p className="label-mono">Delegation</p><p className="mt-1.5 text-sm text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">{link?.status ?? "active"}</p></div><div className="bg-card p-4"><p className="label-mono">Permissions</p><p className="mt-1.5 font-mono text-sm">{link?.permissions.length ?? DEFAULT_PERMISSIONS.length} of 10 maximum</p></div><div className="bg-card p-4"><p className="label-mono">Funding</p><p className="mt-1.5 text-sm font-medium">{fundingSource === "fixture" ? "Mock fixture" : fundingSource === "acquisition" ? "75 Testnet RLUSD acquired" : `${network ?? "Test network"} route`}</p></div></div>
              {devRevocationRequired ? <p className="border border-blocked/35 bg-blocked/10 px-4 py-3 text-sm text-blocked rounded-xl">The owner key exists only in this browser tab session. Revoke the active delegation before closing this tab or leaving onboarding. Pilot chat remains disabled until revocation is proven.</p> : null}
              {provider !== "dev" && supportsOnboardingRevocation(provider) ? (
                <p className="border border-border bg-card px-4 py-3 text-left text-sm leading-6 text-muted-foreground rounded-xl">
                  Owner control: revocation signs an empty-permission DelegateSet for this exact Testnet account. It stops new Harbor delegated submissions only after validated ledger evidence; it does not cancel an in-flight or uncertain transaction and does not delete your external wallet key.
                  {provider === "ledger" && !wallet ? " Reconnect the exact Ledger account before review or signing." : ""}
                </p>
              ) : null}
              {provider !== "dev" && persistedPendingExitGuard ? (
                <p className="border border-blocked/35 bg-blocked/10 px-4 py-3 text-left text-sm leading-6 text-blocked rounded-xl">
                  A signed onboarding transaction is unresolved. Reconnect this exact wallet to resume status reconciliation; Pilot will not request another signature or submit a replacement transaction.
                </p>
              ) : null}
              <p className="text-xs leading-5 text-muted-foreground">Profile data remains in this browser session until a wallet-bound server capability can safely persist <span className="font-mono">Pilot/Profile.md</span>.</p>
              <div className="flex flex-col gap-3 sm:flex-row">
                {provider === "ledger" && !wallet ? (
                  <button className="bracket bracket-light inline-flex h-11 w-full items-center justify-center gap-2 border border-border px-4 text-[13px] font-medium transition hover:bg-white/[0.04] sm:w-auto rounded-md" disabled={busy} onClick={connectWallet} type="button">
                    <WalletCards className="size-4" /> Reconnect Ledger
                  </button>
                ) : null}
                {devRevocationRequired ? (
                  <button className="inline-flex h-11 items-center justify-center gap-2 bg-primary px-4 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90 w-full cursor-not-allowed opacity-45 sm:w-auto rounded-md" disabled type="button">Revoke before opening Pilot <ArrowRight className="size-4" /></button>
                ) : (
                  <>
                    <a className="inline-flex h-11 items-center justify-center gap-2 bg-primary px-4 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90 w-full sm:w-auto rounded-md" href="/chat">Open Pilot <ArrowRight className="size-4" /></a>
                    <a className="bracket bracket-light inline-flex h-11 w-full items-center justify-center gap-2 border border-border px-4 text-[13px] font-medium transition hover:bg-white/[0.04] sm:w-auto rounded-md" href="/chat?mode=autonomous">Draft a strategy</a>
                  </>
                )}
                {devRevocationRequired ? (
                  <button className="inline-flex h-11 w-full items-center justify-center gap-2 border border-blocked/45 px-4 text-[13px] font-medium text-blocked transition hover:bg-blocked/10 disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto rounded-md" disabled={busy} onClick={prepareRevocation} type="button">
                    <ShieldCheck className="size-4" /> Revoke and discard local wallet
                  </button>
                ) : null}
                {externalRevocationAvailable ? (
                  <button className="inline-flex h-11 w-full items-center justify-center gap-2 border border-blocked/45 px-4 text-[13px] font-medium text-blocked transition hover:bg-blocked/10 disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto rounded-md" disabled={busy} onClick={prepareRevocation} type="button">
                    <ShieldCheck className="size-4" /> Review delegation revocation
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {offerRevocationRecovery ? (
            <div className="mt-6 space-y-3 rounded-2xl border border-blocked/30 bg-blocked/10 p-4">
              <p className="text-sm font-medium text-blocked">Active delegation cleanup is still available</p>
              <p className="text-sm leading-6 text-muted-foreground">
                Onboarding does not need to succeed before cleanup. Review an owner-signed revocation for this exact connected Testnet account; Pilot will not retry or sign the blocked acquisition.
              </p>
              <button
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-blocked/40 px-4 py-3.5 text-sm font-semibold text-blocked transition hover:bg-blocked/10 disabled:opacity-50 sm:w-auto"
                disabled={busy}
                onClick={prepareRevocation}
                type="button"
              >
                <ShieldCheck className="size-4" /> Review delegation revocation
              </button>
            </div>
          ) : null}

          {error ? (
            <div className="mt-5 border border-blocked/35 bg-blocked/10 px-4 py-3 rounded-xl" role="alert">
              <p className="text-sm leading-6 text-blocked">{error}</p>
              {errorCode ? <p className="mt-2 break-words border-t border-blocked/25 pt-2 font-mono text-[11px] text-blocked/80">{errorCode}</p> : null}
            </div>
          ) : null}
        </section>
      </div>

      {approvalWallet && approvalRequest ? (
        <ApprovalModal
          beforeSign={pending?.kind === "acquire"
            ? preflightAcquisitionApproval
            : pending?.kind === "revoke"
              ? preflightRevocationApproval
              : undefined}
          onClose={() => setPending(undefined)}
          onComplete={finishPending}
          onSignComplete={pending?.kind === "acquire" ? recordAcquisitionSignCompletion : undefined}
          onSubmit={submitApproval}
          open={Boolean(pending)}
          request={approvalRequest}
          wallet={approvalWallet}
        />
      ) : null}
    </main>
    </div>
  );
}

function StepHeading({ children, eyebrow, title }: { children: React.ReactNode; eyebrow: string; title: string }) {
  return <div><p className="label-mono">{eyebrow}</p><h2 className="mt-2 text-xl font-normal tracking-[-0.02em]">{title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{children}</p></div>;
}

function AccountPanel({ account, network }: { account?: string; network?: TestNetwork }) {
  return <div className="min-w-0 border border-border bg-white/[0.02] p-4 rounded-xl"><div className="flex items-center justify-between gap-3"><span className="label-mono">Budget address</span><span className="border border-border-strong px-1.5 py-0.5 text-xs font-medium text-foreground rounded capitalize">{network ?? "loading"}</span></div><p className="mt-2 break-all font-mono text-xs">{account}</p></div>;
}

function BackButton({ onClick }: { onClick: () => void }) {
  return <button className="bracket bracket-light inline-flex h-11 items-center justify-center gap-2 border border-border bg-white/[0.03] px-4 text-[13px] font-medium transition hover:bg-white/[0.06] rounded-md" onClick={onClick} type="button"><ArrowLeft aria-hidden="true" className="size-4" />Back</button>;
}

function PrimaryButton({ busy, disabled = false, icon, label, onClick }: { busy: boolean; disabled?: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className="inline-flex h-11 items-center justify-center gap-2 bg-primary px-4 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45 rounded-md" disabled={busy || disabled} onClick={onClick} type="button">{busy ? <LoaderCircle className="size-4 animate-spin" /> : icon}{label}</button>;
}
