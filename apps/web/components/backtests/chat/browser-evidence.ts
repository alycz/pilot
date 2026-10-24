import {
  lookupStoredBacktestBundle,
  type BrowserStorage,
} from "../integration/client/storage";

import type { BacktestEvidenceCardState } from "./backtest-evidence-card";
import {
  BACKTEST_CHAT_QUERY_KEY,
  BacktestChatEvidenceContextSchema,
  decodeBacktestChatReference,
} from "./evidence-reference";

/** A URL identifier is inert until its full saved report passes server verification. */
export async function loadBrowserBacktestEvidence(options: Readonly<{
  search: string;
  storage?: BrowserStorage;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}>): Promise<BacktestEvidenceCardState | undefined> {
  const params = new URLSearchParams(options.search.startsWith("?") ? options.search.slice(1) : options.search);
  if (!params.has(BACKTEST_CHAT_QUERY_KEY)) return undefined;

  try {
    const reference = decodeBacktestChatReference(params);
    const bundle = lookupStoredBacktestBundle(options.storage, reference.runId);
    if (!bundle) {
      return { kind: "unavailable", reason: "This run is not saved in this browser research session." };
    }
    const response = await options.fetcher("/api/research/backtests/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference, savedRun: bundle.savedRun }),
      signal: options.signal,
    });
    if (!response.ok) {
      return { kind: "error", reason: "The saved report could not be verified against its deterministic fingerprints." };
    }
    const evidence = BacktestChatEvidenceContextSchema.parse(await response.json());
    if (
      evidence.reference.runId !== reference.runId ||
      evidence.reference.resultFingerprint !== reference.resultFingerprint ||
      evidence.reference.datasetNormalizedHash !== reference.datasetNormalizedHash ||
      evidence.reference.strategyVersion !== reference.strategyVersion
    ) {
      return { kind: "error", reason: "The verified report does not match the requested evidence reference." };
    }
    return { kind: "ready", evidence };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    return { kind: "error", reason: "The backtest evidence reference is invalid or its saved report was changed." };
  }
}
