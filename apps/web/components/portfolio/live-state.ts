import type { Network } from "@pilot/contracts";
import type {
  PublicPilotConfig,
  WalletSessionStatus,
} from "@/lib/harbor-browser";

import type { PortfolioContext } from "./portfolio-data";

export const PORTFOLIO_REFRESH_DEADLINE_MS = 5_000;
export const PORTFOLIO_IDENTITY_REVALIDATION_MS = 15_000;

const XRPL_WEBSOCKET_URLS: Record<Network, string> = {
  mainnet: "wss://s1.ripple.com",
  testnet: "wss://s.altnet.rippletest.net:51233",
  devnet: "wss://s.devnet.rippletest.net:51233",
  "lending-devnet": "wss://lend.devnet.rippletest.net:51233",
};

export type PortfolioConnectionStatus = {
  kind: "demo" | "fixture" | "connecting" | "live" | "degraded" | "stale" | "unavailable" | "error";
  detail: string;
  accountCount: number;
};

export type PortfolioAccess =
  | { kind: "loading"; detail: string }
  | { kind: "mock" }
  | { kind: "unavailable"; detail: string }
  | { kind: "error"; detail: string }
  | { kind: "live"; context: PortfolioContext };

export type XrplTransactionEvent = {
  validated?: boolean;
  hash?: string;
  transaction?: { hash?: string } | Record<string, unknown>;
  tx?: { hash?: string } | Record<string, unknown>;
};

export type PortfolioWebSocketClient = {
  connect(): Promise<void>;
  request(request: {
    command: "subscribe" | "unsubscribe";
    accounts: string[];
  }): Promise<unknown>;
  on(event: "transaction", listener: (event: XrplTransactionEvent) => void): void;
  off(event: "transaction", listener: (event: XrplTransactionEvent) => void): void;
  disconnect(): Promise<void>;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Authorizes every live read from server-verified, same-origin state. Browser
 * storage is deliberately not an ownership source.
 */
export function resolvePortfolioAccess(
  config: PublicPilotConfig | null | undefined,
  session: WalletSessionStatus | null | undefined,
): PortfolioAccess {
  if (config === undefined) {
    return { kind: "loading", detail: "Checking Pilot's public configuration." };
  }
  if (config === null) {
    return {
      kind: "error",
      detail: "Pilot's public configuration is unavailable. No portfolio data was loaded.",
    };
  }
  if (config.mockMode) return { kind: "mock" };
  if (session === undefined) {
    return { kind: "loading", detail: "Checking the authenticated wallet session." };
  }
  if (session === null) {
    return {
      kind: "error",
      detail: "The authenticated wallet session could not be checked. No portfolio data was loaded.",
    };
  }
  if (!session.authenticated) {
    return {
      kind: "unavailable",
      detail: "Connect and verify a wallet session to load its owner-scoped portfolio.",
    };
  }
  if (session.network !== config.network) {
    return {
      kind: "unavailable",
      detail: `The wallet session is for ${session.network}, but Pilot is configured for ${config.network}. No cross-network data was loaded.`,
    };
  }
  return {
    kind: "live",
    context: {
      budgetAccount: session.account,
      network: session.network,
      stableAsset: config.stableAsset,
    },
  };
}

export type PortfolioPresentation =
  | { kind: "loading"; detail: string }
  | { kind: "live" }
  | { kind: "demo"; detail: string };

/**
 * Chooses what the page renders. Only a verified, same-network wallet session
 * reaches live reads; every other state shows the local, clearly labelled demo
 * snapshot instead of an empty page. Demo data never mixes with live data.
 */
export function portfolioPresentation(access: PortfolioAccess): PortfolioPresentation {
  switch (access.kind) {
    case "loading":
      return { kind: "loading", detail: access.detail };
    case "live":
      return { kind: "live" };
    case "mock":
      return {
        kind: "demo",
        detail: "Pilot is running in demo mode. Balances, positions and activity are simulated.",
      };
    case "unavailable":
    case "error":
      return {
        kind: "demo",
        detail: `Simulated demo portfolio. ${access.detail}`,
      };
  }
}

export function walletSessionExpiryDelay(
  session: WalletSessionStatus | null | undefined,
  now = Date.now(),
): number | undefined {
  if (
    !session?.authenticated ||
    !Number.isSafeInteger(session.expiresAt) ||
    (session.expiresAt ?? 0) < 1
  ) return undefined;
  return Math.max(0, session.expiresAt! - now);
}

export function portfolioRefreshFailure(
  hasSnapshot: boolean,
  detail: string,
  accountCount: number,
): PortfolioConnectionStatus {
  return {
    kind: hasSnapshot ? "stale" : "error",
    detail: hasSnapshot
      ? `Showing the last successful owner-scoped snapshot because the validated-ledger refresh failed: ${detail}`
      : `Ledger event arrived, but Harbor did not refresh within five seconds: ${detail}`,
    accountCount,
  };
}

export function subscriptionAccounts(context: PortfolioContext): string[] {
  return [...new Set([context.mainAccount, context.budgetAccount].filter(
    (account): account is string => Boolean(account),
  ))];
}

export function hasDistinctMainAndBudget(context: PortfolioContext): boolean {
  return Boolean(context.mainAccount && context.mainAccount !== context.budgetAccount);
}

export function websocketUrlForNetwork(network: Network): string {
  return XRPL_WEBSOCKET_URLS[network];
}

function transactionHash(event: XrplTransactionEvent): string | undefined {
  return nonEmptyString(event.hash)
    ?? nonEmptyString(object(event.transaction)?.hash)
    ?? nonEmptyString(object(event.tx)?.hash);
}

function withDeadline(
  task: Promise<void>,
  milliseconds: number,
  setTimer: typeof setTimeout,
  clearTimer: typeof clearTimeout,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimer(
      () => reject(new Error(`Portfolio refresh exceeded ${milliseconds} ms`)),
      milliseconds,
    );
    task.then(
      () => {
        clearTimer(timer);
        resolve();
      },
      (error) => {
        clearTimer(timer);
        reject(error);
      },
    );
  });
}

export function createValidatedRefreshCoordinator(options: {
  refresh: (hash: string) => Promise<void>;
  onError?: (error: unknown) => void;
  deadlineMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}) {
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  let active = false;
  let pendingHash: string | undefined;
  let disposed = false;

  const run = async (hash: string): Promise<void> => {
    active = true;
    try {
      await withDeadline(
        options.refresh(hash),
        options.deadlineMs ?? PORTFOLIO_REFRESH_DEADLINE_MS,
        options.setTimer ?? setTimeout,
        options.clearTimer ?? clearTimeout,
      );
    } catch (error) {
      if (!disposed) options.onError?.(error);
    } finally {
      active = false;
      const queued = pendingHash;
      pendingHash = undefined;
      if (!disposed && queued) void run(queued);
    }
  };

  return {
    handle(event: XrplTransactionEvent) {
      if (disposed || event.validated !== true) return;
      const hash = transactionHash(event);
      if (!hash || seen.has(hash)) return;
      seen.add(hash);
      seenOrder.push(hash);
      if (seenOrder.length > 256) {
        const oldest = seenOrder.shift();
        if (oldest) seen.delete(oldest);
      }
      if (active) {
        // One final refresh observes the state after every transaction in the
        // burst, so intermediate refreshes can be safely coalesced.
        pendingHash = hash;
        return;
      }
      void run(hash);
    },
    dispose() {
      disposed = true;
      pendingHash = undefined;
    },
  };
}

export async function subscribeToPortfolioTransactions(options: {
  client: PortfolioWebSocketClient;
  accounts: string[];
  onTransaction: (event: XrplTransactionEvent) => void;
}): Promise<() => Promise<void>> {
  const accounts = [...new Set(options.accounts)];
  if (accounts.length === 0) throw new Error("At least one XRPL account is required");
  options.client.on("transaction", options.onTransaction);
  try {
    await options.client.connect();
    await options.client.request({ command: "subscribe", accounts });
  } catch (error) {
    options.client.off("transaction", options.onTransaction);
    try {
      await options.client.disconnect();
    } catch {
      // Preserve the original connection failure.
    }
    throw error;
  }

  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    options.client.off("transaction", options.onTransaction);
    try {
      await options.client.request({ command: "unsubscribe", accounts });
    } catch {
      // A closed socket cannot accept unsubscribe; disconnect still completes cleanup.
    }
    try {
      await options.client.disconnect();
    } catch {
      // Cleanup is best-effort during navigation or network loss.
    }
  };
}
