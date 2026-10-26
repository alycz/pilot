import { describe, expect, it, vi } from "vitest";

import {
  createNearEarnDiscoveryPlan,
  createNearReadOnlyRpcClient,
  readNearReadOnlyRpcConfig,
} from "./near-data";

describe("NEAR read-only RPC", () => {
  it("defaults off and pins the official endpoint for the selected network", () => {
    expect(readNearReadOnlyRpcConfig({})).toEqual({ enabled: false });
    expect(readNearReadOnlyRpcConfig({
      NEAR_RPC_READ_ENABLED: "1",
      NEAR_RPC_NETWORK: "mainnet",
    })).toEqual({
      enabled: true,
      network: "mainnet",
      endpoint: "https://rpc.mainnet.near.org",
    });
  });

  it.each([
    "https://example.com",
    "https://rpc.mainnet.near.org/path",
    "https://user:pass@rpc.mainnet.near.org",
    "https://rpc.mainnet.near.org?key=secret",
  ])("rejects an unapproved endpoint: %s", (url) => {
    expect(() => readNearReadOnlyRpcConfig({
      NEAR_RPC_READ_ENABLED: "1",
      NEAR_RPC_NETWORK: "mainnet",
      NEAR_RPC_URL: url,
    })).toThrow("NEAR_RPC_URL");
  });

  it("exposes only status and final account views", async () => {
    const requests: unknown[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      const result = request.method === "status"
        ? { chain_id: "mainnet" }
        : {
            amount: "100",
            locked: "0",
            code_hash: "11111111111111111111111111111111",
            storage_usage: 182,
            storage_paid_at: 0,
            block_height: 123,
            block_hash: "block-hash",
          };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    }) as typeof globalThis.fetch;
    const config = readNearReadOnlyRpcConfig({
      NEAR_RPC_READ_ENABLED: "1",
      NEAR_RPC_NETWORK: "mainnet",
    });
    if (!config.enabled) throw new Error("expected enabled config");
    const client = createNearReadOnlyRpcClient(config, { fetch });
    await expect(client.status()).resolves.toMatchObject({ chain_id: "mainnet" });
    await expect(client.viewAccount("pilot.near")).resolves.toMatchObject({ amount: "100" });
    expect(requests).toEqual([
      expect.objectContaining({ method: "status", params: [] }),
      expect.objectContaining({
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: "pilot.near" },
      }),
    ]);
    expect(Object.keys(client).sort()).toEqual(["status", "viewAccount"]);
  });

  it("rejects mismatched and oversized responses", async () => {
    const config = readNearReadOnlyRpcConfig({
      NEAR_RPC_READ_ENABLED: "1",
      NEAR_RPC_NETWORK: "testnet",
    });
    if (!config.enabled) throw new Error("expected enabled config");
    const mismatched = createNearReadOnlyRpcClient(config, {
      fetch: vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "wrong", result: {} }))) as typeof globalThis.fetch,
    });
    await expect(mismatched.status()).rejects.toThrow("did not match");
    const oversized = createNearReadOnlyRpcClient(config, {
      maxResponseBytes: 1_024,
      fetch: vi.fn(async () => new Response("x".repeat(1_025), {
        headers: { "content-length": "1025" },
      })) as typeof globalThis.fetch,
    });
    await expect(oversized.status()).rejects.toThrow("byte limit");
  });
});

describe("NEAR Intents Earn discovery", () => {
  it("uses tokens then a dry quote and never invents a deposit endpoint", () => {
    const plan = createNearEarnDiscoveryPlan({
      assetIn: "near:test-asset-id-returned-by-token-list",
      assetOut: "near:test-receipt-asset-id-returned-by-token-list",
      amountIn: "1000000",
    });
    expect(plan.executable).toBe(false);
    expect(plan.steps).toEqual([
      { operation: "tokens", purpose: "resolve-exact-asset-ids" },
      { operation: "quote", dry: true, purpose: "read-only-opportunity-preview" },
    ]);
    expect(plan.caveats.join(" ")).toContain("not an executable authorization");
  });

  it("carries deposit address and memo together when observing an existing settlement", () => {
    const plan = createNearEarnDiscoveryPlan({
      assetIn: "near:test-asset-in",
      assetOut: "near:test-asset-out",
      amountIn: "42",
      statusReference: { depositAddress: "deposit-address", depositMemo: "route-memo" },
    });
    expect(plan.steps.at(-1)).toEqual({
      operation: "status",
      reference: { depositAddress: "deposit-address", depositMemo: "route-memo" },
      purpose: "observe-existing-executable-quote-only",
    });
  });
});

