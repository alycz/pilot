import { AccountLinkSchema, type AccountLink, type Envelope } from "@pilot/contracts";
import {
  createBrowserHarborClient,
  loadPublicPilotConfig,
  loadWalletSessionStatus,
  WALLET_SESSION_CHANGED_EVENT,
  type PublicPilotConfig,
  type WalletSessionStatus,
} from "../../lib/harbor-browser";

import harborReads from "../../../../packages/harbor-client/fixtures/reads.json";

type LinkStatus = AccountLink["status"];

export type ShellIdentityState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "disconnected"; network: "testnet" | "devnet" }
  | {
      kind: "network-mismatch";
      network: "testnet" | "devnet";
      account: string;
      sessionNetwork: "testnet" | "devnet";
      expiresAt?: number;
    }
  | {
      kind: "connected";
      network: "testnet" | "devnet";
      account: string;
      expiresAt?: number;
    };

export type ShellIdentityLabels = {
  networkLabel: string;
  walletStatus: "loading" | "unavailable" | "disconnected" | "network-mismatch" | "connected";
  walletLabel: string;
  walletDetail: string;
  walletAccount?: string;
};

export type ShellWalletAction =
  | { label: "Checking wallet…"; href?: undefined }
  | { label: "Connect wallet" | "Reconnect wallet" | "Manage wallet"; href: "/onboarding" };

type RefreshEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;
type VisibilityEventTarget = RefreshEventTarget & { visibilityState: DocumentVisibilityState };

export type ShellIdentityRefreshOptions = {
  onInvalidate(): void;
  windowTarget: RefreshEventTarget;
  documentTarget: VisibilityEventTarget;
  setIntervalImpl(callback: () => void, milliseconds: number): number;
  clearIntervalImpl(handle: number): void;
  intervalMilliseconds?: number;
};

export type DelegationStatusState =
  | { kind: "loading"; label: string; detail: string; identity: ShellIdentityState }
  | { kind: "missing-session"; label: string; detail: string; identity: ShellIdentityState }
  | { kind: "unknown"; label: string; detail: string; identity: ShellIdentityState }
  | { kind: "error"; label: string; detail: string; identity: ShellIdentityState }
  | {
      kind: LinkStatus;
      label: string;
      detail: string;
      owner: string;
      network: "testnet" | "devnet";
      permissions: string[];
      mock: boolean;
      identity: ShellIdentityState;
    };

export type DelegationStatusDependencies = {
  loadConfig(signal?: AbortSignal): Promise<PublicPilotConfig>;
  loadSession(signal?: AbortSignal): Promise<WalletSessionStatus>;
  readStatus(
    owner: string,
    network: "testnet" | "devnet",
  ): Promise<Envelope<AccountLink>>;
  mockLink: AccountLink;
};

export const DELEGATION_STATUS_LOADING: DelegationStatusState = {
  kind: "loading",
  label: "Checking delegation",
  detail: "Loading the wallet-bound delegation status.",
  identity: { kind: "loading" },
};

function networkLabel(network: "testnet" | "devnet"): string {
  return network === "testnet" ? "Testnet" : "Devnet";
}

export function shortenWalletAccount(account: string): string {
  if (account.length <= 12) return account;
  return `${account.slice(0, 6)}…${account.slice(-4)}`;
}

export function shellIdentityLabels(identity: ShellIdentityState): ShellIdentityLabels {
  switch (identity.kind) {
    case "loading":
      return {
        networkLabel: "Checking…",
        walletStatus: "loading",
        walletLabel: "Checking wallet",
        walletDetail: "Verifying the configured network and wallet session.",
      };
    case "unavailable":
      return {
        networkLabel: "Unavailable",
        walletStatus: "unavailable",
        walletLabel: "Wallet unavailable",
        walletDetail: "Pilot could not verify the configured network and wallet session.",
      };
    case "disconnected":
      return {
        networkLabel: networkLabel(identity.network),
        walletStatus: "disconnected",
        walletLabel: "Disconnected",
        walletDetail: `Connect an owner wallet on ${networkLabel(identity.network)}.`,
      };
    case "network-mismatch":
      return {
        networkLabel: networkLabel(identity.network),
        walletStatus: "network-mismatch",
        walletLabel: "Network mismatch",
        walletDetail: `Wallet is on ${networkLabel(identity.sessionNetwork)}; Pilot is configured for ${networkLabel(identity.network)}.`,
        walletAccount: shortenWalletAccount(identity.account),
      };
    case "connected":
      return {
        networkLabel: networkLabel(identity.network),
        walletStatus: "connected",
        walletLabel: "Connected",
        walletDetail: `Owner wallet verified on ${networkLabel(identity.network)}.`,
        walletAccount: shortenWalletAccount(identity.account),
      };
  }
}

export function shellWalletAction(
  status: ShellIdentityLabels["walletStatus"],
): ShellWalletAction {
  switch (status) {
    case "loading":
      return { label: "Checking wallet…" };
    case "disconnected":
      return { label: "Connect wallet", href: "/onboarding" };
    case "unavailable":
    case "network-mismatch":
      return { label: "Reconnect wallet", href: "/onboarding" };
    case "connected":
      return { label: "Manage wallet", href: "/onboarding" };
  }
}

export function shellSessionExpiryDelay(
  identity: ShellIdentityState,
  now = Date.now(),
): number | undefined {
  if (
    (identity.kind !== "connected" && identity.kind !== "network-mismatch") ||
    !Number.isSafeInteger(identity.expiresAt) ||
    (identity.expiresAt ?? 0) < 1
  ) return undefined;
  return Math.max(0, identity.expiresAt! - now);
}

export function registerShellIdentityRefresh({
  onInvalidate,
  windowTarget,
  documentTarget,
  setIntervalImpl,
  clearIntervalImpl,
  intervalMilliseconds = 30_000,
}: ShellIdentityRefreshOptions): () => void {
  const refreshWhenVisible = () => {
    if (documentTarget.visibilityState === "visible") onInvalidate();
  };
  windowTarget.addEventListener("focus", onInvalidate);
  windowTarget.addEventListener(WALLET_SESSION_CHANGED_EVENT, onInvalidate);
  documentTarget.addEventListener("visibilitychange", refreshWhenVisible);
  const interval = setIntervalImpl(refreshWhenVisible, intervalMilliseconds);
  return () => {
    clearIntervalImpl(interval);
    windowTarget.removeEventListener("focus", onInvalidate);
    windowTarget.removeEventListener(WALLET_SESSION_CHANGED_EVENT, onInvalidate);
    documentTarget.removeEventListener("visibilitychange", refreshWhenVisible);
  };
}

const mockStatusEnvelope = harborReads["account.status"];
const MOCK_ACCOUNT_LINK = AccountLinkSchema.parse(
  mockStatusEnvelope.ok ? mockStatusEnvelope.data : undefined,
);

function permissionLabel(count: number): string {
  return `${count} ${count === 1 ? "permission" : "permissions"}`;
}

function linkState(
  link: AccountLink,
  owner: string,
  network: "testnet" | "devnet",
  mock: boolean,
  expiresAt?: number,
): DelegationStatusState {
  const permissions = [...link.permissions];
  const statusLabel = `${link.status[0]!.toUpperCase()}${link.status.slice(1)}`;
  return {
    kind: link.status,
    label: `${mock ? "Mock " : ""}${statusLabel} · ${permissionLabel(permissions.length)}`,
    detail: permissions.length > 0
      ? permissions.join(" · ")
      : "No permissions granted.",
    owner,
    network,
    permissions,
    mock,
    identity: { kind: "connected", network, account: owner, expiresAt },
  };
}

function isMissingLink(envelope: Extract<Envelope<AccountLink>, { ok: false }>): boolean {
  return envelope.error.kind === "soft-empty" ||
    envelope.error.code === "LINK_NOT_FOUND" ||
    envelope.error.code === "NOT_FOUND";
}

export const defaultDelegationStatusDependencies: DelegationStatusDependencies = {
  loadConfig: (signal) => loadPublicPilotConfig(globalThis.fetch, signal),
  loadSession: (signal) => loadWalletSessionStatus(globalThis.fetch, signal),
  readStatus: async (owner, network) => createBrowserHarborClient().op(
    "account.status",
    { owner, network },
  ),
  mockLink: MOCK_ACCOUNT_LINK,
};

/**
 * Resolve the sidebar status from an authenticated account/network pair. Live
 * Harbor data is accepted only when its scope exactly matches that session.
 */
export async function loadDelegationStatus(
  dependencies: DelegationStatusDependencies = defaultDelegationStatusDependencies,
  signal?: AbortSignal,
): Promise<DelegationStatusState> {
  let config: PublicPilotConfig;
  let session: WalletSessionStatus;
  try {
    [config, session] = await Promise.all([
      dependencies.loadConfig(signal),
      dependencies.loadSession(signal),
    ]);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    return {
      kind: "error",
      label: "Delegation unavailable",
      detail: "Pilot could not verify its configuration and wallet session.",
      identity: { kind: "unavailable" },
    };
  }

  if (!session.authenticated) {
    return {
      kind: "missing-session",
      label: "No wallet session",
      detail: "Connect the owner wallet to read delegation permissions.",
      identity: { kind: "disconnected", network: config.network },
    };
  }
  if (session.expiresAt !== undefined && session.expiresAt <= Date.now()) {
    return {
      kind: "missing-session",
      label: "Wallet session expired",
      detail: "Reconnect the owner wallet to read delegation permissions.",
      identity: { kind: "disconnected", network: config.network },
    };
  }
  if (session.network !== config.network) {
    return {
      kind: "unknown",
      label: "Delegation unknown",
      detail: "The wallet session does not match Pilot's configured network.",
      identity: {
        kind: "network-mismatch",
        network: config.network,
        account: session.account,
        sessionNetwork: session.network,
        expiresAt: session.expiresAt,
      },
    };
  }

  const identity: ShellIdentityState = {
    kind: "connected",
    network: session.network,
    account: session.account,
    expiresAt: session.expiresAt,
  };

  if (config.mockMode) {
    return linkState(
      dependencies.mockLink,
      session.account,
      session.network,
      true,
      session.expiresAt,
    );
  }

  let envelope: Envelope<AccountLink>;
  try {
    envelope = await dependencies.readStatus(session.account, session.network);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    return {
      kind: "error",
      label: "Delegation unavailable",
      detail: "Harbor could not load the wallet-bound delegation status.",
      identity,
    };
  }

  if (!envelope.ok) {
    return isMissingLink(envelope)
      ? {
          kind: "unknown",
          label: "No delegation found",
          detail: "Harbor has no delegation link for this owner and network.",
          identity,
        }
      : {
          kind: "error",
          label: "Delegation unavailable",
          detail: "Harbor could not verify the delegation status.",
          identity,
        };
  }

  if (envelope.data.owner !== session.account || envelope.data.network !== session.network) {
    return {
      kind: "error",
      label: "Delegation unavailable",
      detail: "Harbor returned delegation data for a different owner or network.",
      identity,
    };
  }

  if (session.expiresAt !== undefined && session.expiresAt <= Date.now()) {
    return {
      kind: "missing-session",
      label: "Wallet session expired",
      detail: "Reconnect the owner wallet to read delegation permissions.",
      identity: { kind: "disconnected", network: config.network },
    };
  }

  return linkState(
    envelope.data,
    session.account,
    session.network,
    false,
    session.expiresAt,
  );
}
