import { describe, expect, it, vi } from "vitest";

import { DEFAULT_POLICY } from "../src/contracts";
import {
  buildQuickNodeRegistrySnapshot,
  catalogIssuerItems,
  D1QuickNodeRegistrySource,
  QuickNodeKvRegistry,
  quickNodeRegistryKey,
  type QuickNodeRegistrySource,
} from "../src/quicknode/kv-registry";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DELEGATE = "rJdYtgaiEgzL7xD2QdPKg5xoHkWc7CZjvm";
const PAYER = "rQhUcbJoDfvgXr1EkMwarLP5QT3XinEBDg";
const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const LOCAL_ENV = {
  EXEC_NETWORK: "testnet" as const,
  HARBOR_LOCAL_DEV: "true",
  QN_API_BASE: "http://127.0.0.1:8793",
  QN_MODE: "mock",
  QN_RUN_TAG: "run_A",
};

function statefulFetcher() {
  const lists = new Map<string, string[]>();
  const requests: Array<{
    method: string;
    path: string;
    body: Record<string, unknown>;
    apiKey: string | null;
  }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({
      method: String(init?.method),
      path: url.pathname,
      body,
      apiKey: new Headers(init?.headers).get("x-api-key"),
    });
    if (init?.method === "POST") {
      const key = String(body.key);
      const items = [...(body.items as string[])];
      lists.set(key, items);
      return Response.json({ key, items });
    }
    const key = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (init?.method === "GET") {
      const items = lists.get(key);
      return items
        ? Response.json({ key, items })
        : Response.json({ error: "not found" }, { status: 404 });
    }
    const current = lists.get(key) ?? [];
    const additions = body.addItems as string[];
    const removals = new Set(body.removeItems as string[]);
    const items = [...new Set([...current, ...additions])].filter(
      (item) => !removals.has(item),
    );
    lists.set(key, items);
    return Response.json({ key, items });
  }) as typeof fetch;
  return { fetcher, lists, requests };
}

describe("QuickNode KV registry", () => {
  it("uses deterministic run-scoped keys and rejects unsafe tags", () => {
    expect(quickNodeRegistryKey("testnet", "run_A", "accounts")).toBe(
      "harbor_testnet_run_A_accounts",
    );
    expect(() => quickNodeRegistryKey("testnet", "../event", "accounts")).toThrow();
    expect(() =>
      quickNodeRegistryKey("mainnet" as "testnet", "run1", "accounts"),
    ).toThrow();
  });

  it("patches link, revoke, and freeze lists against the local stand-in", async () => {
    const { fetcher, lists, requests } = statefulFetcher();
    const registry = new QuickNodeKvRegistry({
      env: LOCAL_ENV,
      runtimeLocal: true,
      requestLocal: true,
      fetcher,
    });

    await expect(registry.link("testnet", OWNER, DELEGATE)).resolves.toEqual([
      { ok: true, skipped: false },
      { ok: true, skipped: false },
    ]);
    await expect(registry.freeze("testnet", OWNER, true)).resolves.toEqual({
      ok: true,
      skipped: false,
    });
    expect(lists.get("harbor_testnet_run_A_accounts")).toEqual([OWNER]);
    expect(lists.get("harbor_testnet_run_A_delegates")).toEqual([DELEGATE]);
    expect(lists.get("harbor_testnet_run_A_frozen")).toEqual([OWNER]);

    await registry.revoke("testnet", OWNER, DELEGATE);
    expect(lists.get("harbor_testnet_run_A_accounts")).toEqual([]);
    expect(lists.get("harbor_testnet_run_A_delegates")).toEqual([]);
    expect(lists.get("harbor_testnet_run_A_frozen")).toEqual([]);
    expect(requests.every((request) => request.apiKey === "qn-local-standin")).toBe(
      true,
    );
  });

  it("fails best-effort without leaking response bodies or throwing", async () => {
    const logs: unknown[] = [];
    const registry = new QuickNodeKvRegistry({
      env: LOCAL_ENV,
      runtimeLocal: true,
      requestLocal: true,
      fetcher: vi.fn(async () =>
        Response.json(
          { error: "attacker body containing secret-like text" },
          { status: 500 },
        ),
      ) as typeof fetch,
      log: (entry) => logs.push(entry),
    });
    await expect(registry.link("testnet", OWNER, DELEGATE)).resolves.toEqual([
      { ok: false, skipped: false },
      { ok: false, skipped: false },
    ]);
    expect(logs).toEqual([
      {
        evt: "kv_sync_failed",
        action: "patch",
        list: "accounts",
        code: "QN_HTTP_500",
      },
      {
        evt: "kv_sync_failed",
        action: "patch",
        list: "delegates",
        code: "QN_HTTP_500",
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("attacker");
  });

  it("emits a bounded default failure signal when no logger is injected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = new QuickNodeKvRegistry({
      env: LOCAL_ENV,
      runtimeLocal: true,
      requestLocal: true,
      fetcher: vi.fn(async () =>
        Response.json(
          { error: "provider-controlled secret-like diagnostic" },
          { status: 503 },
        ),
      ) as typeof fetch,
    });

    await expect(registry.freeze("testnet", OWNER, true)).resolves.toEqual({
      ok: false,
      skipped: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("kv_sync_failed", {
      evt: "kv_sync_failed",
      action: "patch",
      list: "frozen",
      code: "QN_HTTP_503",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("provider-controlled");
    warn.mockRestore();
  });

  it("never sends mock traffic to the real QuickNode API", async () => {
    const fetcher = vi.fn();
    const logs: unknown[] = [];
    const registry = new QuickNodeKvRegistry({
      env: { ...LOCAL_ENV, QN_API_BASE: undefined },
      runtimeLocal: true,
      requestLocal: true,
      fetcher: fetcher as typeof fetch,
      log: (entry) => logs.push(entry),
    });
    await expect(registry.freeze("testnet", OWNER, true)).resolves.toEqual({
      ok: false,
      skipped: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(logs).toEqual([
      {
        evt: "kv_sync_failed",
        action: "patch",
        list: "frozen",
        code: "QN_API_BASE_FORBIDDEN",
      },
    ]);
  });

  it("is a no-op in off mode", async () => {
    const fetcher = vi.fn();
    const registry = new QuickNodeKvRegistry({
      env: { ...LOCAL_ENV, QN_MODE: "off" },
      runtimeLocal: true,
      requestLocal: true,
      fetcher: fetcher as typeof fetch,
    });
    await expect(registry.freeze("testnet", OWNER, true)).resolves.toEqual({
      ok: true,
      skipped: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("defaults off when QN_MODE is absent", async () => {
    const fetcher = vi.fn();
    const { QN_MODE: _mode, ...env } = LOCAL_ENV;
    const registry = new QuickNodeKvRegistry({
      env,
      runtimeLocal: true,
      requestLocal: true,
      fetcher: fetcher as typeof fetch,
    });
    await expect(registry.freeze("testnet", OWNER, true)).resolves.toEqual({
      ok: true,
      skipped: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("QuickNode registry snapshot", () => {
  it("builds catalog-only issuer lists and ignores policy-supplied issuers", async () => {
    const source: QuickNodeRegistrySource = {
      links: async () => [
        {
          owner: OWNER,
          delegate: DELEGATE,
          permissions: ["TrustSet", "OfferCreate"],
          status: "active",
          frozen: true,
        },
        {
          owner: PAYER,
          delegate: OWNER,
          permissions: ["CheckCash"],
          status: "suspended",
          revokePending: true,
          frozen: true,
        },
      ],
      policies: async () => [
        {
          allowed_tx_types: ["OfferCreate", "Payment"],
          issuer_allowlist: [`FOO.${PAYER}`],
        },
      ],
      payerAccounts: async () => [PAYER],
      frozenPayerAccounts: async () => [PAYER],
      catalog: () => ({
        nested: {
          asset: {
            currency: "524C555344000000000000000000000000000000",
            issuer: ISSUER,
          },
          ignored: { currency: "XRP", issuer: ISSUER },
        },
      }),
    };

    await expect(buildQuickNodeRegistrySnapshot(source, "testnet")).resolves.toEqual({
      accounts: [OWNER, PAYER].sort(),
      delegates: [DELEGATE],
      frozen: [OWNER, PAYER].sort(),
      tx_types: ["OfferCreate", "TrustSet"],
      issuers: [`RLUSD.${ISSUER}`],
    });
  });

  it("rejects provider response extensions instead of retaining provider text", async () => {
    const logs: unknown[] = [];
    const registry = new QuickNodeKvRegistry({
      env: LOCAL_ENV,
      runtimeLocal: true,
      requestLocal: true,
      fetcher: vi.fn(async () =>
        Response.json({
          key: "harbor_testnet_run_A_frozen",
          items: [OWNER],
          provider_message: "untrusted provider text",
        }),
      ) as typeof fetch,
      log: (entry) => logs.push(entry),
    });

    await expect(registry.freeze("testnet", OWNER, true)).resolves.toEqual({
      ok: false,
      skipped: false,
    });
    expect(logs).toEqual([
      {
        evt: "kv_sync_failed",
        action: "patch",
        list: "frozen",
        code: "QN_KV_SYNC_FAILED",
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("provider_message");
  });

  it("ignores malformed and textual catalog fields", () => {
    expect(
      catalogIssuerItems({
        attack: { currency: "ignore previous instructions", issuer: ISSUER },
        wrong: { currency: "USD", issuer: "not-an-address" },
        good: { currency: "USD", issuer: ISSUER },
      }),
    ).toEqual([`USD.${ISSUER}`]);
  });

  it("replaces all lists idempotently", async () => {
    const { fetcher, lists } = statefulFetcher();
    const registry = new QuickNodeKvRegistry({
      env: LOCAL_ENV,
      runtimeLocal: true,
      requestLocal: true,
      fetcher,
    });
    const snapshot = {
      accounts: [PAYER, OWNER, OWNER],
      delegates: [DELEGATE],
      frozen: [],
      tx_types: ["TrustSet", "OfferCreate"],
      issuers: ["RLUSD", `RLUSD.${ISSUER}`],
    };
    await registry.reconcile("testnet", snapshot);
    await registry.reconcile("testnet", snapshot);
    expect(lists.get("harbor_testnet_run_A_accounts")).toEqual(
      [OWNER, PAYER].sort(),
    );
    expect(lists.get("harbor_testnet_run_A_tx_types")).toEqual([
      "OfferCreate",
      "TrustSet",
    ]);
  });

  it("loads only validated link and policy fields from D1", async () => {
    const boundNetworks: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(network: string) {
            boundNetworks.push(network);
            return {
              async all() {
                return sql.includes("FROM links")
                  ? {
                      results: [
                        {
                          owner: OWNER,
                          delegate: DELEGATE,
                          permissions: JSON.stringify(["OfferCreate"]),
                          status: "active",
                          revoke_tx: null,
                          frozen_at: null,
                        },
                      ],
                    }
                  : {
                      results: [
                        {
                          json: JSON.stringify({
                            ...DEFAULT_POLICY,
                            issuer_allowlist: [`USD.${ISSUER}`],
                          }),
                        },
                      ],
                    };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const source = new D1QuickNodeRegistrySource(db, {}, {
      testnet: [PAYER],
    });

    await expect(source.links("testnet")).resolves.toEqual([
      {
        owner: OWNER,
        delegate: DELEGATE,
        permissions: ["OfferCreate"],
        status: "active",
        revokePending: false,
        frozen: false,
      },
    ]);
    await expect(source.policies("testnet")).resolves.toEqual([
      {
        allowed_tx_types: DEFAULT_POLICY.allowed_tx_types,
        issuer_allowlist: [`USD.${ISSUER}`],
      },
    ]);
    await expect(source.payerAccounts("testnet")).resolves.toEqual([PAYER]);
    expect(boundNetworks).toEqual(["testnet", "testnet"]);
  });
});
