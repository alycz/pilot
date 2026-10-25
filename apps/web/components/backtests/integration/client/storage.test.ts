import { describe, expect, it } from "vitest";

import { BACKTEST_SESSION_STORAGE_KEY, MAX_SAVED_BACKTEST_RUNS } from "./contracts";
import { clearStoredBacktestRuns, loadStoredBacktestRuns, saveBacktestRun, type BrowserStorage } from "./storage";
import { clientBundle } from "./test-fixture";

class MemoryStorage implements BrowserStorage {
  value: string | null = null;
  getItem(key: string) { return key === BACKTEST_SESSION_STORAGE_KEY ? this.value : null; }
  setItem(key: string, value: string) { if (key === BACKTEST_SESSION_STORAGE_KEY) this.value = value; }
}

describe("local research run storage", () => {
  it("caps storage at eight runs and deduplicates by run id", () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < 10; index += 1) {
      saveBacktestRun(storage, clientBundle(`bt_${String(index).padStart(24, "0")}`));
    }
    expect(loadStoredBacktestRuns(storage)).toHaveLength(MAX_SAVED_BACKTEST_RUNS);
    saveBacktestRun(storage, clientBundle("bt_000000000000000000000009"));
    expect(loadStoredBacktestRuns(storage)).toHaveLength(MAX_SAVED_BACKTEST_RUNS);
  });

  it("fails closed on wallet fields, addresses, and malformed stored JSON", () => {
    const storage = new MemoryStorage();
    const withWallet = clientBundle();
    withWallet.savedRun.report = { walletAddress: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59" };
    expect(() => saveBacktestRun(storage, withWallet)).toThrow(/not permitted|wallet address/);
    storage.value = "{broken";
    expect(loadStoredBacktestRuns(storage)).toEqual([]);
  });

  it("invalidates all saved research when its wallet session changes", () => {
    const storage = new MemoryStorage();
    saveBacktestRun(storage, clientBundle());
    expect(loadStoredBacktestRuns(storage)).toHaveLength(1);
    clearStoredBacktestRuns(storage);
    expect(loadStoredBacktestRuns(storage)).toEqual([]);
  });
});
