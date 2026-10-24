import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WalletSessionStatus } from "../../lib/harbor-browser";
import { ConversationSessionController, type ConversationSession } from "./conversation-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ConversationSessionController provisional session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T19:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces a slow provisional demo with the authenticated account scope", async () => {
    const slow = deferred<WalletSessionStatus | null>();
    const published: Array<ConversationSession | undefined> = [];
    const controller = new ConversationSessionController(() => slow.promise, (value) => published.push(value), 1_500);

    controller.refresh();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(published).toEqual([{ scope: "signed-out", session: { authenticated: false } }]);

    slow.resolve({
      authenticated: true,
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    });
    await flushPromises();
    expect(published.at(-1)?.scope).toContain("r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59");
    expect(published.at(-1)?.session).toMatchObject({ authenticated: true });
    controller.dispose();
  });

  it("drops superseded account results and publishes only the latest refresh", async () => {
    const accountA = deferred<WalletSessionStatus | null>();
    const accountB = deferred<WalletSessionStatus | null>();
    const loads = [accountA, accountB];
    const published: Array<ConversationSession | undefined> = [];
    let index = 0;
    const controller = new ConversationSessionController(() => loads[index++]!.promise, (value) => published.push(value), 1_500);

    controller.refresh();
    controller.refreshAfterSessionChange();
    accountA.resolve({ authenticated: true, account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", network: "testnet", expiresAt: Date.now() + 60_000 });
    accountB.resolve({ authenticated: true, account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", network: "testnet", expiresAt: Date.now() + 60_000 });
    await flushPromises();

    expect(published.some((entry) => entry?.scope.includes("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"))).toBe(false);
    expect(published.at(-1)?.scope).toContain("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
    controller.dispose();
  });

  it("publishes nothing after disposal", async () => {
    const pending = deferred<WalletSessionStatus | null>();
    const published: Array<ConversationSession | undefined> = [];
    const controller = new ConversationSessionController(() => pending.promise, (value) => published.push(value), 1_500);
    controller.refresh();
    controller.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    pending.resolve({ authenticated: false });
    await flushPromises();
    expect(published).toEqual([]);
  });
});
