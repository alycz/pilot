import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createValidatedRefreshCoordinator,
  hasDistinctMainAndBudget,
  portfolioPresentation,
  portfolioRefreshFailure,
  resolvePortfolioAccess,
  subscribeToPortfolioTransactions,
  subscriptionAccounts,
  walletSessionExpiryDelay,
  websocketUrlForNetwork,
  type PortfolioWebSocketClient,
  type XrplTransactionEvent,
} from "./live-state";

class FakeWebSocket implements PortfolioWebSocketClient {
  readonly requests: Array<{ command: "subscribe" | "unsubscribe"; accounts: string[] }> = [];
  readonly listeners = new Set<(event: XrplTransactionEvent) => void>();
  connected = false;
  disconnected = false;

  async connect() {
    this.connected = true;
  }

  async request(request: { command: "subscribe" | "unsubscribe"; accounts: string[] }) {
    this.requests.push(request);
    return {};
  }

  on(_event: "transaction", listener: (event: XrplTransactionEvent) => void) {
    this.listeners.add(listener);
  }

  off(_event: "transaction", listener: (event: XrplTransactionEvent) => void) {
    this.listeners.delete(listener);
  }

  async disconnect() {
    this.disconnected = true;
  }

  emit(event: XrplTransactionEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("portfolio live context", () => {
  const config = {
    network: "testnet" as const,
    stableAsset: {
      currency: "RLUSD",
      issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
    },
    devSignerEnabled: true,
    walletActionProofRequired: true,
    walletActionProofConfigured: true,
    mockMode: false,
  };
  const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

  it("derives live account scope only from the authenticated wallet session", () => {
    const access = resolvePortfolioAccess(config, {
      authenticated: true,
      account: owner,
      network: "testnet",
    });

    expect(access).toEqual({
      kind: "live",
      context: {
        budgetAccount: owner,
        network: "testnet",
        stableAsset: config.stableAsset,
      },
    });
    if (access.kind !== "live") throw new Error("expected live access");
    expect(subscriptionAccounts(access.context)).toEqual([owner]);
    expect(hasDistinctMainAndBudget(access.context)).toBe(false);
    expect(websocketUrlForNetwork("testnet")).toContain("s.altnet.rippletest.net");
  });

  it("fails closed while configuration or wallet-session state is loading or unavailable", () => {
    expect(resolvePortfolioAccess(undefined, undefined)).toMatchObject({ kind: "loading" });
    expect(resolvePortfolioAccess(null, { authenticated: false })).toMatchObject({ kind: "error" });
    expect(resolvePortfolioAccess(config, undefined)).toMatchObject({ kind: "loading" });
    expect(resolvePortfolioAccess(config, null)).toMatchObject({ kind: "error" });
    expect(resolvePortfolioAccess(config, { authenticated: false })).toMatchObject({
      kind: "unavailable",
      detail: expect.stringContaining("verify a wallet session"),
    });
  });

  it("rejects a wallet-session network change instead of reading cross-network data", () => {
    expect(resolvePortfolioAccess(config, {
      authenticated: true,
      account: owner,
      network: "devnet",
    })).toMatchObject({
      kind: "unavailable",
      detail: expect.stringContaining("No cross-network data was loaded"),
    });
  });

  it("rebinds the live context when the authenticated owner changes", () => {
    const first = resolvePortfolioAccess(config, {
      authenticated: true,
      account: owner,
      network: "testnet",
    });
    const secondOwner = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
    const second = resolvePortfolioAccess(config, {
      authenticated: true,
      account: secondOwner,
      network: "testnet",
    });

    expect(first.kind === "live" && first.context.budgetAccount).toBe(owner);
    expect(second.kind === "live" && second.context.budgetAccount).toBe(secondOwner);
  });

  it("fails closed when a previously authenticated foreground session expires", () => {
    const active = resolvePortfolioAccess(config, {
      authenticated: true,
      account: owner,
      network: "testnet",
    });
    const expiredSession = { authenticated: false as const };
    const expired = resolvePortfolioAccess(config, expiredSession);

    expect(active).toMatchObject({ kind: "live" });
    expect(expired).toMatchObject({
      kind: "unavailable",
      detail: expect.stringContaining("verify a wallet session"),
    });
    expect(walletSessionExpiryDelay({
      authenticated: true,
      account: owner,
      network: "testnet",
      expiresAt: 12_000,
    }, 10_000)).toBe(2_000);
    expect(walletSessionExpiryDelay({
      authenticated: true,
      account: owner,
      network: "testnet",
      expiresAt: 9_999,
    }, 10_000)).toBe(0);
    expect(walletSessionExpiryDelay(expiredSession, 10_000)).toBeUndefined();
  });

  it("uses fixtures only when public configuration explicitly enables mock mode", () => {
    expect(resolvePortfolioAccess({ ...config, mockMode: true }, { authenticated: false }))
      .toEqual({ kind: "mock" });
  });

  it("shows the labelled demo to every visitor without a verified, same-network session", () => {
    expect(portfolioPresentation(resolvePortfolioAccess({ ...config, mockMode: true }, { authenticated: false })))
      .toMatchObject({ kind: "demo" });
    expect(portfolioPresentation(resolvePortfolioAccess(config, { authenticated: false })))
      .toMatchObject({ kind: "demo", detail: expect.stringContaining("Simulated demo portfolio") });
    expect(portfolioPresentation(resolvePortfolioAccess(null, { authenticated: false })))
      .toMatchObject({ kind: "demo" });
    expect(portfolioPresentation(resolvePortfolioAccess(config, null)))
      .toMatchObject({ kind: "demo" });
    expect(portfolioPresentation(resolvePortfolioAccess(config, {
      authenticated: true,
      account: owner,
      network: "devnet",
    }))).toMatchObject({ kind: "demo" });
  });

  it("keeps loading and live sessions out of the demo", () => {
    expect(portfolioPresentation(resolvePortfolioAccess(undefined, undefined)))
      .toMatchObject({ kind: "loading" });
    expect(portfolioPresentation(resolvePortfolioAccess(config, undefined)))
      .toMatchObject({ kind: "loading" });
    expect(portfolioPresentation(resolvePortfolioAccess(config, {
      authenticated: true,
      account: owner,
      network: "testnet",
    }))).toEqual({ kind: "live" });
  });

  it("marks a failed refresh stale only when a prior owner-scoped snapshot exists", () => {
    expect(portfolioRefreshFailure(true, "timeout", 1)).toMatchObject({
      kind: "stale",
      detail: expect.stringContaining("last successful owner-scoped snapshot"),
    });
    expect(portfolioRefreshFailure(false, "timeout", 1)).toMatchObject({
      kind: "error",
      detail: expect.stringContaining("did not refresh"),
    });
  });
});

describe("XRPL portfolio subscription", () => {
  it("subscribes once to both accounts and cleans up with unsubscribe", async () => {
    const client = new FakeWebSocket();
    const onTransaction = vi.fn();
    const cleanup = await subscribeToPortfolioTransactions({
      client,
      accounts: ["rMain", "rBudget", "rBudget"],
      onTransaction,
    });

    expect(client.connected).toBe(true);
    expect(client.requests).toEqual([
      { command: "subscribe", accounts: ["rMain", "rBudget"] },
    ]);
    client.emit({ validated: true, transaction: { hash: "A" } });
    expect(onTransaction).toHaveBeenCalledOnce();

    await cleanup();
    expect(client.requests.at(-1)).toEqual({
      command: "unsubscribe",
      accounts: ["rMain", "rBudget"],
    });
    expect(client.listeners.size).toBe(0);
    expect(client.disconnected).toBe(true);
  });

  it("ignores unvalidated events, deduplicates hashes, and coalesces a burst", async () => {
    const resolvers: Array<() => void> = [];
    const refresh = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
    const coordinator = createValidatedRefreshCoordinator({ refresh });

    coordinator.handle({ validated: false, transaction: { hash: "IGNORED" } });
    coordinator.handle({ validated: true, transaction: { hash: "A" } });
    coordinator.handle({ validated: true, transaction: { hash: "A" } });
    coordinator.handle({ validated: true, transaction: { hash: "B" } });
    coordinator.handle({ validated: true, transaction: { hash: "C" } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("A");

    resolvers.shift()?.();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenLastCalledWith("C");
    resolvers.shift()?.();
    coordinator.dispose();
  });

  it("applies a validated WebSocket refresh before the five-second deadline", async () => {
    vi.useFakeTimers();
    const client = new FakeWebSocket();
    let displayedBalance = 250;
    const coordinator = createValidatedRefreshCoordinator({
      refresh: () => new Promise<void>((resolve) => {
        setTimeout(() => {
          displayedBalance = 300;
          resolve();
        }, 4_999);
      }),
      onError: (error) => {
        throw error;
      },
    });
    const cleanup = await subscribeToPortfolioTransactions({
      client,
      accounts: ["rMain", "rBudget"],
      onTransaction: coordinator.handle,
    });

    client.emit({ validated: true, transaction: { hash: "VALIDATED-HASH" } });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(displayedBalance).toBe(300);

    coordinator.dispose();
    await cleanup();
  });

  it("reports a refresh that misses the five-second deadline", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const coordinator = createValidatedRefreshCoordinator({
      refresh: () => new Promise<void>(() => undefined),
      onError,
    });

    coordinator.handle({ validated: true, hash: "SLOW-HASH" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("5000 ms") }),
    );
    coordinator.dispose();
  });
});
