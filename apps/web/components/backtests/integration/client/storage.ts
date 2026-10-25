import {
  BACKTEST_SESSION_STORAGE_KEY,
  MAX_SAVED_BACKTEST_BYTES,
  MAX_SAVED_BACKTEST_RUNS,
  StoredBacktestRunSchema,
  type BacktestRunBundle,
  type StoredBacktestRun,
} from "./contracts";

export interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PRIVATE_KEY = /wallet(?:address|id)?$|account(?:address|id)?$|^address$|user.?id$|session(?:id)?$|credential|secret|private.?key|seed|approval.?id$|permission.?id$|capability.?id$|transaction|tx.?json/i;
const XRPL_CLASSIC_ADDRESS = /\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/;

function assertResearchOnly(value: unknown, path = "savedRun"): void {
  if (typeof value === "string") {
    if (XRPL_CLASSIC_ADDRESS.test(value)) throw new TypeError(`${path} must not contain a wallet address`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertResearchOnly(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) throw new TypeError(`${path}.${key} is not permitted in local research storage`);
    assertResearchOnly(entry, `${path}.${key}`);
  }
}

export function loadStoredBacktestRuns(storage?: BrowserStorage): readonly StoredBacktestRun[] {
  if (!storage) return [];
  const raw = storage.getItem(BACKTEST_SESSION_STORAGE_KEY);
  if (!raw || raw.length > MAX_SAVED_BACKTEST_BYTES) return [];
  try {
    const decoded = JSON.parse(raw) as unknown;
    if (!Array.isArray(decoded) || decoded.length > MAX_SAVED_BACKTEST_RUNS) return [];
    return decoded.map((entry) => {
      assertResearchOnly(entry);
      return StoredBacktestRunSchema.parse(entry);
    });
  } catch {
    return [];
  }
}

export function saveBacktestRun(storage: BrowserStorage, bundleInput: BacktestRunBundle): readonly StoredBacktestRun[] {
  assertResearchOnly(bundleInput);
  const candidate = StoredBacktestRunSchema.parse({ version: 1, bundle: bundleInput });
  assertResearchOnly(candidate);
  const previous = loadStoredBacktestRuns(storage);
  const runId = candidate.bundle.chatEvidence.runId;
  let next = [candidate, ...previous.filter((entry) => entry.bundle.chatEvidence.runId !== runId)]
    .slice(0, MAX_SAVED_BACKTEST_RUNS);
  let serialized = JSON.stringify(next);
  while (serialized.length > MAX_SAVED_BACKTEST_BYTES && next.length > 1) {
    next = next.slice(0, -1);
    serialized = JSON.stringify(next);
  }
  if (serialized.length > MAX_SAVED_BACKTEST_BYTES) throw new RangeError("saved backtest exceeds the local research storage limit");
  storage.setItem(BACKTEST_SESSION_STORAGE_KEY, serialized);
  return next;
}

export function clearStoredBacktestRuns(storage: BrowserStorage): void {
  storage.setItem(BACKTEST_SESSION_STORAGE_KEY, "[]");
}

export function lookupStoredBacktestBundle(storage: BrowserStorage | undefined, runId: string): BacktestRunBundle | undefined {
  return loadStoredBacktestRuns(storage).find((entry) => entry.bundle.chatEvidence.runId === runId)?.bundle;
}
