import { describe, expect, it, vi } from "vitest";

import { BACKTEST_SESSION_STORAGE_KEY } from "../integration/client/contracts";
import type { BrowserStorage } from "../integration/client/storage";
import { clientBundle } from "../integration/client/test-fixture";
import { loadBrowserBacktestEvidence } from "./browser-evidence";
import { RESEARCH_ONLY_DISCLOSURE, encodeBacktestChatReference } from "./evidence-reference";

const bundle = clientBundle();
const reference = {
  version: "v1" as const,
  runId: bundle.chatEvidence.runId,
  resultFingerprint: bundle.chatEvidence.resultFingerprint,
  datasetNormalizedHash: bundle.chatEvidence.datasetNormalizedHash,
  strategyVersion: bundle.chatEvidence.strategyVersion,
};

function storageWithSavedRun(): BrowserStorage {
  const value = JSON.stringify([{ version: 1, bundle }]);
  return {
    getItem: (key) => key === BACKTEST_SESSION_STORAGE_KEY ? value : null,
    setItem: vi.fn(),
  };
}

function verifiedContext() {
  return {
    kind: "saved_backtest_research_evidence",
    authority: "research_only",
    reference: { ...reference },
    dataset: {
      label: bundle.chatEvidence.datasetLabel,
      sourceKind: bundle.chatEvidence.sourceKind,
      sourceDisclosure: bundle.chatEvidence.sourceDisclosure,
      startDate: bundle.chatEvidence.period.startDate,
      endDate: bundle.chatEvidence.period.endDate,
    },
    result: { quoteSymbol: bundle.chatEvidence.quoteSymbol, ...bundle.chatEvidence.metrics },
    disclosure: RESEARCH_ONLY_DISCLOSURE,
  };
}

describe("browser backtest evidence", () => {
  it("does nothing when chat has no backtest reference", async () => {
    const fetcher = vi.fn();
    expect(await loadBrowserBacktestEvidence({ search: "?action=swap", storage: storageWithSavedRun(), fetcher })).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires the full saved report to be verified server-side", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json(verifiedContext()));
    const state = await loadBrowserBacktestEvidence({
      search: `?${encodeBacktestChatReference(reference)}`,
      storage: storageWithSavedRun(),
      fetcher: fetcher as typeof fetch,
    });
    expect(state).toMatchObject({ kind: "ready", evidence: { authority: "research_only", reference } });
    expect(fetcher).toHaveBeenCalledWith("/api/research/backtests/evidence", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ reference, savedRun: expect.objectContaining({ scope: "local_research_only" }) });
  });

  it("fails closed for missing, rejected, or mismatched saved evidence", async () => {
    const search = `?${encodeBacktestChatReference(reference)}`;
    expect(await loadBrowserBacktestEvidence({ search, storage: undefined, fetcher: vi.fn() })).toMatchObject({ kind: "unavailable" });
    expect(await loadBrowserBacktestEvidence({
      search,
      storage: storageWithSavedRun(),
      fetcher: vi.fn(async () => Response.json({ error: "invalid" }, { status: 400 })) as typeof fetch,
    })).toMatchObject({ kind: "error" });
    const mismatched = verifiedContext();
    mismatched.reference.resultFingerprint = "f".repeat(64);
    expect(await loadBrowserBacktestEvidence({
      search,
      storage: storageWithSavedRun(),
      fetcher: vi.fn(async () => Response.json(mismatched)) as typeof fetch,
    })).toMatchObject({ kind: "error" });
  });
});
