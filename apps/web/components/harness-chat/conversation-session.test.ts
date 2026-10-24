import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WalletSessionStatus } from "../../lib/harbor-browser";

import {
  ConversationSessionController,
  type ConversationSession,
} from "./conversation-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ConversationSessionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T19:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the old expiry armed while a focus-style refresh is pending", async () => {
    const initial = deferred<WalletSessionStatus | null>();
    const pendingFocusRefresh = deferred<WalletSessionStatus | null>();
    const postExpiryRefresh = deferred<WalletSessionStatus | null>();
    const signals: AbortSignal[] = [];
    const loads = [initial, pendingFocusRefresh, postExpiryRefresh];
    const published: Array<ConversationSession | undefined> = [];
    const controller = new ConversationSessionController((signal) => {
      signals.push(signal);
      return loads[signals.length - 1]!.promise;
    }, (session) => published.push(session));

    controller.refresh();
    initial.resolve({
      authenticated: true,
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet",
      expiresAt: Date.now() + 100,
    });
    await flushPromises();
    expect(published.at(-1)?.scope).toContain("r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59");

    vi.advanceTimersByTime(50);
    controller.refresh();
    expect(published.at(-1)?.scope).toContain("r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59");
    vi.advanceTimersByTime(50);

    expect(signals[1]?.aborted).toBe(true);
    expect(published.at(-1)).toEqual({ scope: "signed-out", session: { authenticated: false } });
    expect(signals).toHaveLength(3);
    controller.dispose();
  });

  it("drops the old owner immediately for a cross-tab session change and still honors its boundary", async () => {
    const initial = deferred<WalletSessionStatus | null>();
    const pendingCrossTabRefresh = deferred<WalletSessionStatus | null>();
    const postExpiryRefresh = deferred<WalletSessionStatus | null>();
    const loads = [initial, pendingCrossTabRefresh, postExpiryRefresh];
    const signals: AbortSignal[] = [];
    const published: Array<ConversationSession | undefined> = [];
    const controller = new ConversationSessionController((signal) => {
      signals.push(signal);
      return loads[signals.length - 1]!.promise;
    }, (session) => published.push(session));

    controller.refresh();
    initial.resolve({
      authenticated: true,
      account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      network: "testnet",
      expiresAt: Date.now() + 100,
    });
    await flushPromises();

    controller.refreshAfterSessionChange();
    expect(published.at(-1)).toBeUndefined();
    vi.advanceTimersByTime(100);

    expect(signals[1]?.aborted).toBe(true);
    expect(published.at(-1)).toEqual({ scope: "signed-out", session: { authenticated: false } });
    expect(signals).toHaveLength(3);
    controller.dispose();
  });

  it("ignores a superseded loader even if it resolves after cancellation", async () => {
    const superseded = deferred<WalletSessionStatus | null>();
    const current = deferred<WalletSessionStatus | null>();
    const signals: AbortSignal[] = [];
    const published: Array<ConversationSession | undefined> = [];
    const controller = new ConversationSessionController((signal) => {
      signals.push(signal);
      return (signals.length === 1 ? superseded : current).promise;
    }, (session) => published.push(session));

    controller.refresh();
    controller.refresh();
    expect(signals[0]?.aborted).toBe(true);

    superseded.resolve({
      authenticated: true,
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet",
      expiresAt: Date.now() + 1_000,
    });
    await flushPromises();
    expect(published).toEqual([]);

    current.resolve({ authenticated: false });
    await flushPromises();
    expect(published).toEqual([{ scope: "signed-out", session: { authenticated: false } }]);
    controller.dispose();
  });

  it("preserves the conversation key across a successful same-scope refresh", async () => {
    const initial = deferred<WalletSessionStatus | null>();
    const replacement = deferred<WalletSessionStatus | null>();
    const loads = [initial, replacement];
    const published: Array<ConversationSession | undefined> = [];
    let loadIndex = 0;
    const controller = new ConversationSessionController(
      () => loads[loadIndex++]!.promise,
      (session) => published.push(session),
    );
    const account = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

    controller.refresh();
    initial.resolve({
      authenticated: true,
      account,
      network: "testnet",
      expiresAt: Date.now() + 1_000,
    });
    await flushPromises();
    const originalScope = published.at(-1)?.scope;

    controller.refresh();
    expect(published.at(-1)?.scope).toBe(originalScope);
    replacement.resolve({
      authenticated: true,
      account,
      network: "testnet",
      expiresAt: Date.now() + 2_000,
    });
    await flushPromises();

    expect(published).toHaveLength(2);
    expect(published.map((session) => session?.scope)).toEqual([originalScope, originalScope]);
    expect(vi.getTimerCount()).toBe(1);
    controller.dispose();
  });

  it("dispose aborts a pending read, clears expiry, and prevents late publication", async () => {
    const initial = deferred<WalletSessionStatus | null>();
    const pending = deferred<WalletSessionStatus | null>();
    const signals: AbortSignal[] = [];
    const published: Array<ConversationSession | undefined> = [];
    const controller = new ConversationSessionController((signal) => {
      signals.push(signal);
      return (signals.length === 1 ? initial : pending).promise;
    }, (session) => published.push(session));

    controller.refresh();
    initial.resolve({
      authenticated: true,
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet",
      expiresAt: Date.now() + 100,
    });
    await flushPromises();
    controller.refresh();
    controller.dispose();

    expect(signals[1]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve({
      authenticated: true,
      account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      network: "testnet",
      expiresAt: Date.now() + 1_000,
    });
    vi.advanceTimersByTime(1_000);
    await flushPromises();
    expect(published).toHaveLength(1);
  });

  it("projects already-expired and exact-boundary sessions to signed out without a timer", async () => {
    const loads: WalletSessionStatus[] = [
      {
        authenticated: true,
        account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        network: "testnet",
        expiresAt: Date.now() - 1,
      },
      {
        authenticated: true,
        account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        network: "testnet",
        expiresAt: Date.now(),
      },
    ];
    const published: Array<ConversationSession | undefined> = [];
    const controller = new ConversationSessionController(
      async () => loads.shift()!,
      (session) => published.push(session),
    );

    controller.refresh();
    await flushPromises();
    controller.refresh();
    await flushPromises();

    expect(published).toEqual([
      { scope: "signed-out", session: { authenticated: false } },
      { scope: "signed-out", session: { authenticated: false } },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });
});
