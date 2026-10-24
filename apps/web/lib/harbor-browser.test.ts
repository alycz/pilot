import { describe, expect, it, vi } from "vitest";
import { hashes, Wallet } from "xrpl";

import {
  HarborBrowserError,
  WALLET_SESSION_CHANGED_EVENT,
  bindWalletSession,
  clearWalletSession,
  createBrowserHarborClient,
  loadPublicPilotConfig,
  loadWalletSessionStatus,
} from "./harbor-browser";

const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const HASH = "A".repeat(64);
const X402_PAY_TO = "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr";

describe("browser Harbor client", () => {
  it("preserves the settled Devnet owner and approval request shapes", async () => {
    const wallet = Wallet.generate();
    const directBlob = wallet.sign({
      TransactionType: "AccountSet",
      Account: wallet.classicAddress,
      Fee: "12",
      Sequence: 1,
    }).tx_blob;
    const approvalBlob = wallet.sign({
      TransactionType: "AccountSet",
      Account: wallet.classicAddress,
      Domain: "70696C6F742E6578616D706C65",
      Fee: "12",
      Sequence: 2,
    }).tx_blob;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const args = JSON.parse(String(init?.body)) as { hash?: string; tx_blob?: string };
      const hash = args.tx_blob ? hashes.hashSignedTx(args.tx_blob).toUpperCase() : args.hash;
      return Response.json({
        ok: true,
        data: String(input).endsWith("tx.submit")
          ? { hash, ledger_index: 123, engine_result: "tesSUCCESS", validated: true }
          : { hash, network: "devnet", validated: false },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger",
      });
    });
    const client = createBrowserHarborClient(fetchImpl as typeof fetch);

    await client.op("tx.submit", { tx_blob: directBlob, network: "devnet" });
    await client.op("tx.status", { hash: HASH, account: ACCOUNT, network: "devnet" });
    await client.op("tx.submit", {
      tx_blob: approvalBlob,
      approval_id: "approval-vault-1",
      network: "devnet",
    });
    await client.op("tx.status", { hash: HASH });

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
      ["/api/harbor/tx.submit", { tx_blob: directBlob, network: "devnet" }],
      ["/api/harbor/tx.status", { hash: HASH, account: ACCOUNT, network: "devnet" }],
      ["/api/harbor/tx.submit", { tx_blob: approvalBlob, approval_id: "approval-vault-1", network: "devnet" }],
      ["/api/harbor/tx.status", { hash: HASH }],
    ]);
  });

  it("posts typed arguments only to the fixed same-origin proxy", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        ok: true,
        data: { hash: HASH, network: "testnet", validated: false },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger",
      }),
    );
    const client = createBrowserHarborClient(fetchImpl as typeof fetch);

    await expect(client.op("tx.status", { hash: HASH, account: ACCOUNT, network: "testnet" })).resolves.toMatchObject({
      ok: true,
      data: { hash: HASH, network: "testnet", validated: false },
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/harbor/tx.status");
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ hash: HASH, account: ACCOUNT, network: "testnet" }),
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(init?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
    expect(JSON.stringify(init)).not.toMatch(/authorization|api.?key/i);
  });

  it("returns a valid error envelope even when the proxy uses an error status", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(
        {
          ok: false,
          error: { service: "harbor", kind: "error", message: "not found" },
        },
        { status: 404 },
      ),
    );

    await expect(
      createBrowserHarborClient(fetchImpl as typeof fetch).op("tx.status", { hash: HASH, account: ACCOUNT, network: "testnet" }),
    ).resolves.toEqual({
      ok: false,
      error: { service: "harbor", kind: "error", message: "not found" },
    });
  });

  it("rejects invalid arguments before fetch and invalid envelopes after fetch", async () => {
    const neverFetch = vi.fn();
    await expect(
      createBrowserHarborClient(neverFetch as typeof fetch).op("tx.status", { hash: "", account: ACCOUNT, network: "testnet" }),
    ).rejects.toBeInstanceOf(HarborBrowserError);
    expect(neverFetch).not.toHaveBeenCalled();

    const invalidFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ data: { status: "pending" } }),
    );
    await expect(
      createBrowserHarborClient(invalidFetch as typeof fetch).op("tx.status", { hash: HASH, account: ACCOUNT, network: "testnet" }),
    ).rejects.toThrow("invalid response");
  });

  it("rejects incomplete validated operation results", async () => {
    const client = createBrowserHarborClient(vi.fn(async () => Response.json({
      ok: true,
      data: { hash: HASH, network: "testnet", validated: true },
      asOf: "2026-10-18T00:00:00.000Z",
      asOfBasis: "ledger",
    })) as typeof fetch);
    await expect(client.op("tx.status", { hash: HASH })).rejects.toThrow("invalid response");
  });

  it("rejects a status result for a different transaction hash", async () => {
    const client = createBrowserHarborClient(vi.fn(async () => Response.json({
      ok: true,
      data: { hash: "B".repeat(64), network: "testnet", validated: false },
      asOf: "2026-10-18T00:00:00.000Z",
      asOfBasis: "ledger",
    })) as typeof fetch);
    await expect(client.op("tx.status", { hash: HASH })).rejects.toThrow("mismatched transaction hash");
  });

  it.each([
    ["the exact payment", "5000", X402_PAY_TO],
    ["a changed 4999-drop price", "4999", X402_PAY_TO],
    ["a changed 5001-drop price", "5001", X402_PAY_TO],
    ["the legacy 100000-drop price", "100000", X402_PAY_TO],
    ["a changed receiver", "5000", ACCOUNT],
    ["a legacy request without a receiver", "5000", undefined],
  ])("blocks browser x402 dispatch for %s", async (_label, maxPriceDrops, payTo) => {
    const fetchImpl = vi.fn();
    const client = createBrowserHarborClient(fetchImpl as typeof fetch);
    const request = {
      owner: ACCOUNT,
      network: "testnet",
      resource: "compare",
      max_price_drops: maxPriceDrops,
      idempotency_key: "pilot-x402:browser-blocked-1",
      ...(payTo === undefined ? {} : { pay_to: payTo }),
    };

    await expect(client.op("x402.pay", request as never)).rejects.toThrow(
      /invalid|fresh wallet action proof/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("public Pilot config client", () => {
  it("loads strict safe metadata from the same-origin route", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        network: "testnet",
        stableAsset: {
          currency: "RLUSD",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        },
        devSignerEnabled: false,
        walletActionProofRequired: false,
        walletActionProofConfigured: false,
        mockMode: false,
      }),
    );

    await expect(loadPublicPilotConfig(fetchImpl as typeof fetch)).resolves.toMatchObject({
      network: "testnet",
      stableAsset: { currency: "RLUSD" },
      walletActionProofConfigured: false,
      mockMode: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/config/public",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("rejects mainnet or additional secret-shaped fields", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        network: "mainnet",
        stableAsset: {
          currency: "RLUSD",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        },
        devSignerEnabled: false,
        walletActionProofRequired: false,
        walletActionProofConfigured: false,
        mockMode: false,
        apiKey: "nope",
      }),
    );

    await expect(loadPublicPilotConfig(fetchImpl as typeof fetch)).rejects.toThrow(
      "configuration is invalid",
    );
  });

  it("rejects a public configuration without the strict proof-readiness indicator", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      network: "testnet",
      stableAsset: {
        currency: "RLUSD",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      },
      devSignerEnabled: false,
      walletActionProofRequired: false,
      mockMode: false,
    }));

    await expect(loadPublicPilotConfig(fetchImpl as typeof fetch)).rejects.toThrow(
      "configuration is invalid",
    );
  });
});

describe("wallet session status client", () => {
  it("clears all server wallet authorization and notifies same-tab consumers", async () => {
    const dispatchEvent = vi.fn((_event: Event) => true);
    vi.stubGlobal("dispatchEvent", dispatchEvent);
    const fetchImpl = vi.fn(async () => Response.json({ authenticated: false }));
    try {
      await clearWalletSession(fetchImpl as typeof fetch);
      expect(fetchImpl).toHaveBeenCalledWith(
        "/api/auth/wallet/session",
        expect.objectContaining({
          method: "DELETE",
          cache: "no-store",
          credentials: "same-origin",
        }),
      );
      expect(dispatchEvent).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("signals same-tab consumers immediately after binding a replacement session", async () => {
    const dispatchEvent = vi.fn((_event: Event) => true);
    vi.stubGlobal("dispatchEvent", dispatchEvent);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ tx_json: { TransactionType: "AccountSet" } }))
      .mockResolvedValueOnce(Response.json({
        authenticated: true,
        account: ACCOUNT,
        network: "testnet",
        expiresAt: Date.now() + 60_000,
      }));
    const wallet = { signOnly: vi.fn(async () => "signed-proof") };

    try {
      await bindWalletSession(wallet, ACCOUNT, "testnet", fetchImpl as typeof fetch);
      expect(dispatchEvent).toHaveBeenCalledOnce();
      expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
        type: WALLET_SESSION_CHANGED_EVENT,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads only strict same-origin public session metadata", async () => {
    const expiresAt = Date.now() + 60_000;
    const fetchImpl = vi.fn(async () => Response.json({
      authenticated: true,
      account: ACCOUNT,
      network: "testnet",
      expiresAt,
    }));

    await expect(loadWalletSessionStatus(fetchImpl as typeof fetch)).resolves.toEqual({
      authenticated: true,
      account: ACCOUNT,
      network: "testnet",
      expiresAt,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/auth/wallet/session",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("accepts an unauthenticated result and rejects secret-shaped or incomplete metadata", async () => {
    await expect(loadWalletSessionStatus(
      vi.fn(async () => Response.json({ authenticated: false })) as typeof fetch,
    )).resolves.toEqual({ authenticated: false });

    await expect(loadWalletSessionStatus(
      vi.fn(async () => Response.json({ authenticated: false, cookie: "nope" })) as typeof fetch,
    )).rejects.toThrow("session status is invalid");

    await expect(loadWalletSessionStatus(
      vi.fn(async () => Response.json({ authenticated: true, account: ACCOUNT })) as typeof fetch,
    )).rejects.toThrow("session status is invalid");
  });

  it("preserves cancellation while reading the response body", async () => {
    const aborted = new DOMException("aborted", "AbortError");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => { throw aborted; },
    }) as unknown as Response);

    await expect(loadWalletSessionStatus(fetchImpl as typeof fetch)).rejects.toBe(aborted);
  });
});
