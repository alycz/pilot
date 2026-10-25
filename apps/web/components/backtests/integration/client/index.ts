export { BacktestsClient, INITIAL_DRAFT, requestFromDraft } from "./backtests-client";
export { BACKTEST_SESSION_STORAGE_KEY, MAX_SAVED_BACKTEST_BYTES, MAX_SAVED_BACKTEST_RUNS, BacktestRunBundleSchema, BacktestRunRequestSchema, type BacktestRunBundle, type BacktestRunRequest, type StoredBacktestRun } from "./contracts";
export { compareRunEvidence, savedRunRows } from "./comparison";
export { BACKTEST_SESSION_INVALIDATED_EVENT, BacktestSessionLifecycleGuard, registerBacktestSessionInvalidation } from "./session-lifecycle-guard";
export { clearStoredBacktestRuns, loadStoredBacktestRuns, lookupStoredBacktestBundle, saveBacktestRun, type BrowserStorage } from "./storage";
