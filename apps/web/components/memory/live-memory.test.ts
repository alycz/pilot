import { DEFAULT_POLICY } from "@pilot/contracts";
import type { HarborClient } from "@pilot/harbor-client";
import { describe, expect, it, vi } from "vitest";
import { WALLET_SESSION_CHANGED_EVENT } from "../../lib/harbor-browser";

import {
  buildLiveMemoryGraph,
  fetchLiveMemorySnapshot,
  livePolicyEditorKey,
  memoryContextKey,
  memorySessionExpiryDelay,
  memorySnapshotMatchesContext,
  registerMemoryIdentityRefresh,
  memoryPresentation,
  resolveMemoryReadiness,
} from "./live-memory";

const OWNER = "r5QTTcw4XtrY58EeBiaJDoDV7ZRzYa5GL";
const OTHER_OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const LIVE_CONFIG = {
  network: "testnet" as const,
  stableAsset: { currency: "RLUSD", issuer: OTHER_OWNER },
  devSignerEnabled: false,
  walletActionProofRequired: false,
  walletActionProofConfigured: false,
  mockMode: false,
};

function harborWithPolicy() {
  return {
    op: vi.fn().mockResolvedValue({
      ok: true,
      data: DEFAULT_POLICY,
      asOf: "2026-10-19T00:00:00.000Z",
      asOfBasis: "harbor-policy",
    }),
  } as unknown as Pick<HarborClient, "op">;
}

function snapshotResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({
    ok: true,
    data: {
      owner: OWNER,
      network: "testnet",
      generatedAt: "2026-10-19T00:00:00.000Z",
      notes: [
        {
          path: "Pilot/Profile.md",
          content: "---\nnetwork: testnet\n---\n# Pilot profile\n\nStored preference.",
        },
      ],
      ...overrides,
    },
  });
}

describe("Memory live readiness", () => {
  it("requires parsed configuration and a matching authenticated session", () => {
    expect(resolveMemoryReadiness(undefined, undefined)).toEqual({ kind: "checking" });
    expect(resolveMemoryReadiness(null, { authenticated: false })).toEqual({ kind: "configuration-error" });
    expect(resolveMemoryReadiness(LIVE_CONFIG, null)).toEqual({ kind: "session-error" });
    expect(resolveMemoryReadiness(LIVE_CONFIG, { authenticated: false })).toEqual({ kind: "no-session" });
    expect(resolveMemoryReadiness(LIVE_CONFIG, {
      authenticated: true,
      account: OWNER,
      network: "devnet",
    })).toEqual({
      kind: "network-mismatch",
      configuredNetwork: "testnet",
      sessionNetwork: "devnet",
    });
    expect(resolveMemoryReadiness(LIVE_CONFIG, {
      authenticated: true,
      account: OWNER,
      network: "testnet",
    })).toEqual({ kind: "live", owner: OWNER, network: "testnet" });
  });

  it("permits fixtures only for explicit mock mode", () => {
    expect(resolveMemoryReadiness({ ...LIVE_CONFIG, mockMode: true }, null)).toEqual({ kind: "mock" });
  });

  it("shows the labelled demo vault to every visitor without a verified session", () => {
    expect(memoryPresentation(resolveMemoryReadiness({ ...LIVE_CONFIG, mockMode: true }, null))).toEqual({ kind: "demo" });
    expect(memoryPresentation(resolveMemoryReadiness(LIVE_CONFIG, { authenticated: false }))).toEqual({ kind: "demo" });
    expect(memoryPresentation(resolveMemoryReadiness(null, { authenticated: false }))).toMatchObject({ kind: "demo", reason: expect.any(String) });
    expect(memoryPresentation(resolveMemoryReadiness(LIVE_CONFIG, null))).toMatchObject({ kind: "demo", reason: expect.any(String) });
    expect(memoryPresentation(resolveMemoryReadiness(LIVE_CONFIG, {
      authenticated: true,
      account: OWNER,
      network: "devnet",
    }))).toMatchObject({ kind: "demo", reason: expect.stringContaining("devnet") });
  });

  it("never shows the demo while checking or for a live session", () => {
    expect(memoryPresentation(resolveMemoryReadiness(undefined, undefined))).toEqual({ kind: "checking" });
    expect(memoryPresentation(resolveMemoryReadiness(LIVE_CONFIG, {
      authenticated: true,
      account: OWNER,
      network: "testnet",
    }))).toEqual({ kind: "live" });
  });

  it("fails closed for an authenticated session at or after its exact expiry", () => {
    const session = {
      authenticated: true as const,
      account: OWNER,
      network: "testnet" as const,
      expiresAt: 12_000,
    };

    expect(resolveMemoryReadiness(LIVE_CONFIG, session, 11_999)).toEqual({
      kind: "live",
      owner: OWNER,
      network: "testnet",
    });
    expect(resolveMemoryReadiness(LIVE_CONFIG, session, 12_000)).toEqual({ kind: "session-expired" });
    expect(memorySnapshotMatchesContext(
      { owner: OWNER, network: "testnet" },
      resolveMemoryReadiness(LIVE_CONFIG, session, 12_000),
    )).toBe(false);
    expect(memorySessionExpiryDelay(session, 10_000)).toBe(2_000);
    expect(memorySessionExpiryDelay(session, 12_001)).toBe(0);
  });

  it("invalidates immediately on a same-tab wallet-session owner change", () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget() as EventTarget & {
      visibilityState: DocumentVisibilityState;
    };
    Object.defineProperty(documentTarget, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    const onInvalidate = vi.fn();
    const clearIntervalImpl = vi.fn();
    const cleanup = registerMemoryIdentityRefresh({
      onInvalidate,
      windowTarget,
      documentTarget,
      setIntervalImpl: () => 19,
      clearIntervalImpl,
    });

    windowTarget.dispatchEvent(new Event(WALLET_SESSION_CHANGED_EVENT));
    expect(onInvalidate).toHaveBeenCalledOnce();
    cleanup();
    windowTarget.dispatchEvent(new Event(WALLET_SESSION_CHANGED_EVENT));
    expect(onInvalidate).toHaveBeenCalledOnce();
    expect(clearIntervalImpl).toHaveBeenCalledWith(19);
  });

  it("changes the context identity when owner or network changes", () => {
    expect(memoryContextKey(OWNER, "testnet")).not.toBe(memoryContextKey(OTHER_OWNER, "testnet"));
    expect(memoryContextKey(OWNER, "testnet")).not.toBe(memoryContextKey(OWNER, "devnet"));
  });

  it("changes the live policy editor identity when the same owner receives a refreshed policy", () => {
    const snapshot = {
      owner: OWNER,
      network: "testnet" as const,
      generatedAt: "2026-10-19T00:00:00.000Z",
      policy: DEFAULT_POLICY,
    };

    expect(livePolicyEditorKey(snapshot)).not.toBe(livePolicyEditorKey({
      ...snapshot,
      generatedAt: "2026-10-19T00:00:30.000Z",
      policy: { ...DEFAULT_POLICY, execute_under_usd: 225 },
    }));
  });

  it("hides an owner snapshot while identity is pending or changes", () => {
    const snapshot = { owner: OWNER, network: "testnet" as const };
    expect(memorySnapshotMatchesContext(snapshot, { kind: "checking" })).toBe(false);
    expect(memorySnapshotMatchesContext(snapshot, {
      kind: "live",
      owner: OTHER_OWNER,
      network: "testnet",
    })).toBe(false);
    expect(memorySnapshotMatchesContext(snapshot, {
      kind: "live",
      owner: OWNER,
      network: "testnet",
    })).toBe(true);
  });
});

describe("Memory vault graph", () => {
  it("derives notes and graph edges only from stored Markdown", () => {
    const graph = buildLiveMemoryGraph([
      {
        path: "Pilot/Trades/ABC.md",
        content: "---\nnetwork: testnet\ncreated: 2026-10-18T12:00:00.000Z\n---\n# Transaction ABC\n\nA stored fill.\n\nAsset: [[XRP]]",
      },
      {
        path: "Pilot/Tokens/XRP.md",
        content: "---\ntype: token\n---\n# XRP\n\nNative asset.",
      },
      { path: "Pilot/Unsupported.md", content: "# Must not appear" },
    ]);

    expect(graph.notes).toHaveLength(2);
    const trade = graph.notes.find((note) => note.path.endsWith("ABC.md"));
    const token = graph.notes.find((note) => note.path.endsWith("XRP.md"));
    expect(trade).toMatchObject({
      title: "Transaction ABC",
      summary: "A stored fill.",
      network: "testnet",
      links: [token?.id],
    });
    expect(token?.updatedAt).toBeUndefined();
    expect(graph.edges).toEqual([{ from: trade?.id, to: token?.id }]);
  });

  it("keeps punctuation-colliding paths selectable and linked as distinct notes", () => {
    const graph = buildLiveMemoryGraph([
      {
        path: "Pilot/Tokens/A-B.md",
        content: "# A dash B\n\nDash asset.",
      },
      {
        path: "Pilot/Tokens/A_B.md",
        content: "# A underscore B\n\nUnderscore asset.",
      },
      {
        path: "Pilot/Journal/Compare.md",
        content: "# Comparison\n\nCompare [[Tokens/A-B]] with [[Tokens/A_B]].",
      },
    ]);

    const dash = graph.notes.find((note) => note.path === "Pilot/Tokens/A-B.md")!;
    const underscore = graph.notes.find((note) => note.path === "Pilot/Tokens/A_B.md")!;
    const comparison = graph.notes.find((note) => note.path === "Pilot/Journal/Compare.md")!;

    expect(new Set(graph.notes.map((note) => note.id)).size).toBe(3);
    expect(dash.id).not.toBe(underscore.id);
    expect(graph.notes.find((note) => note.id === dash.id)?.path).toBe("Pilot/Tokens/A-B.md");
    expect(graph.notes.find((note) => note.id === underscore.id)?.path).toBe("Pilot/Tokens/A_B.md");
    expect(comparison.links).toEqual([dash.id, underscore.id]);
    expect(graph.edges).toEqual([
      { from: comparison.id, to: dash.id },
      { from: comparison.id, to: underscore.id },
    ]);
  });

  it("does not invent notes or links for an empty snapshot", () => {
    expect(buildLiveMemoryGraph([])).toEqual({ notes: [], nodes: [], edges: [] });
  });
});

describe("Memory live snapshot", () => {
  it("loads the wallet-scoped vault snapshot and Harbor policy", async () => {
    const harbor = harborWithPolicy();
    const fetcher = vi.fn().mockResolvedValue(snapshotResponse());

    const result = await fetchLiveMemorySnapshot(
      harbor,
      { owner: OWNER, network: "testnet" },
      fetcher as typeof fetch,
    );

    expect(fetcher).toHaveBeenCalledWith("/api/vault/snapshot", expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
    }));
    expect(harbor.op).toHaveBeenCalledWith("policy.get", { owner: OWNER, network: "testnet" });
    expect(result).toMatchObject({
      mode: "live",
      owner: OWNER,
      network: "testnet",
      generatedAt: "2026-10-19T00:00:00.000Z",
      policy: DEFAULT_POLICY,
    });
    expect(result.notes).toHaveLength(1);
  });

  it("fails closed on stale owner/network data instead of returning it", async () => {
    const harbor = harborWithPolicy();
    const fetcher = vi.fn().mockResolvedValue(snapshotResponse({ owner: OTHER_OWNER }));

    await expect(fetchLiveMemorySnapshot(
      harbor,
      { owner: OWNER, network: "testnet" },
      fetcher as typeof fetch,
    )).rejects.toThrow("does not match the authenticated wallet session");
    expect(harbor.op).not.toHaveBeenCalled();
  });

  it("fails closed on snapshot errors and invalid freshness metadata", async () => {
    await expect(fetchLiveMemorySnapshot(
      harborWithPolicy(),
      { owner: OWNER, network: "testnet" },
      vi.fn().mockResolvedValue(Response.json({
        ok: false,
        error: { code: "VAULT_SESSION_REQUIRED", message: "Wallet session required" },
      }, { status: 401 })) as typeof fetch,
    )).rejects.toThrow("snapshot is unavailable");

    await expect(fetchLiveMemorySnapshot(
      harborWithPolicy(),
      { owner: OWNER, network: "testnet" },
      vi.fn().mockResolvedValue(snapshotResponse({ generatedAt: "not-a-timestamp" })) as typeof fetch,
    )).rejects.toThrow("snapshot is invalid");
  });

  it("surfaces Harbor policy errors without substituting the default policy", async () => {
    const harbor = {
      op: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "POLICY_UNAVAILABLE", message: "Scoped policy is unavailable" },
      }),
    } as unknown as Pick<HarborClient, "op">;

    await expect(fetchLiveMemorySnapshot(
      harbor,
      { owner: OWNER, network: "testnet" },
      vi.fn().mockResolvedValue(snapshotResponse()) as typeof fetch,
    )).rejects.toThrow("Scoped policy is unavailable");
  });
});
