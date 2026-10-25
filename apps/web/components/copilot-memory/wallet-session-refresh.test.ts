import { describe, expect, it } from "vitest";

import type { WalletSessionStatus } from "../../lib/harbor-browser";
import { observeWalletSessionChanges, type WalletSessionRefreshState } from "./wallet-session-refresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const firstWallet: WalletSessionStatus = {
  authenticated: true,
  account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  network: "testnet",
};
const secondWallet: WalletSessionStatus = {
  authenticated: true,
  account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
  network: "testnet",
};

describe("observeWalletSessionChanges", () => {
  it("invalidates the visible scope immediately and ignores an older in-flight response", async () => {
    const target = new EventTarget();
    const first = deferred<WalletSessionStatus>();
    const second = deferred<WalletSessionStatus>();
    const requests = [first, second];
    const states: WalletSessionRefreshState[] = [];
    const stop = observeWalletSessionChanges({
      eventName: "wallet-changed",
      load: () => requests.shift()!.promise,
      onChange: (state) => states.push(state),
      target,
    });

    target.dispatchEvent(new Event("wallet-changed"));
    first.resolve(firstWallet);
    await first.promise;
    await Promise.resolve();
    expect(states).toEqual([undefined, undefined]);

    second.resolve(secondWallet);
    await second.promise;
    await Promise.resolve();
    expect(states).toEqual([undefined, undefined, secondWallet]);
    stop();
  });

  it("recovers as unavailable on failure and stops observing after cleanup", async () => {
    const target = new EventTarget();
    const failed = deferred<WalletSessionStatus>();
    const states: WalletSessionRefreshState[] = [];
    let calls = 0;
    const stop = observeWalletSessionChanges({
      eventName: "wallet-changed",
      load: () => { calls += 1; return failed.promise; },
      onChange: (state) => states.push(state),
      target,
    });
    failed.reject(new Error("unavailable"));
    await failed.promise.catch(() => undefined);
    await Promise.resolve();
    expect(states).toEqual([undefined, null]);

    stop();
    target.dispatchEvent(new Event("wallet-changed"));
    expect(calls).toBe(1);
  });
});
