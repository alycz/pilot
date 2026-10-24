import { describe, expect, it, vi } from "vitest";
import { RippledError } from "xrpl";

import type { Network } from "../src/contracts";
import {
  createXrplRpc,
  JsonRpcTransport,
  normalizeXrplResponse,
  requestXrpl,
  resolveXrplNetwork,
  XRPL_NETWORKS,
  XRPL_RPC_RETRIES,
  XRPL_RPC_TIMEOUT_MS,
  XrplRpcError,
  XrplWebSocketTransport,
  type XrplTransport,
  type XrplTransportRequest,
  type XrplWebSocketClient,
} from "../src/adapters/xrpl-rpc";

class FixtureTransport implements XrplTransport {
  readonly requests: XrplTransportRequest[] = [];

  constructor(
    private readonly fixture: (
      request: XrplTransportRequest,
      call: number,
    ) => unknown | Promise<unknown>,
  ) {}

  async request(request: XrplTransportRequest): Promise<unknown> {
    this.requests.push(request);
    return this.fixture(request, this.requests.length);
  }
}

describe("XRPL network configuration", () => {
  it("maps all four contract networks to HTTP and WebSocket endpoints", () => {
    expect(Object.keys(XRPL_NETWORKS).sort()).toEqual([
      "devnet",
      "lending-devnet",
      "mainnet",
      "testnet",
    ]);
    for (const config of Object.values(XRPL_NETWORKS)) {
      expect(config.jsonRpcUrl).toMatch(/^https:\/\//);
      expect(config.websocketUrl).toMatch(/^wss:\/\//);
    }
  });

  it("applies each protocol-specific environment override", () => {
    expect(
      resolveXrplNetwork("testnet", {
        XRPL_TESTNET_URL: "https://example.test/rpc",
      }),
    ).toMatchObject({
      jsonRpcUrl: "https://example.test/rpc",
      websocketUrl: XRPL_NETWORKS.testnet.websocketUrl,
    });
    expect(
      resolveXrplNetwork("lending-devnet", {
        XRPL_LENDING_DEVNET_URL: "wss://example.test/ws",
      }),
    ).toMatchObject({
      jsonRpcUrl: XRPL_NETWORKS["lending-devnet"].jsonRpcUrl,
      websocketUrl: "wss://example.test/ws",
    });
  });

  it("rejects malformed endpoint overrides without echoing the URL", () => {
    expect(() =>
      resolveXrplNetwork("mainnet", {
        XRPL_MAINNET_URL: "credential-bearing-invalid-value",
      }),
    ).toThrowError("Invalid endpoint override for mainnet");
  });
});

describe("XRPL transports", () => {
  it("formats JSON-RPC requests as a one-item params array", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ result: { status: "success", ledger_index: 42 } }),
    );
    const transport = new JsonRpcTransport(fetcher);
    const controller = new AbortController();

    await expect(
      transport.request({
        network: "testnet",
        kind: "json-rpc",
        url: "https://example.test/rpc",
        command: "account_info",
        params: { account: "rExample", ledger_index: "validated" },
        timeoutMs: 8_000,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ result: { ledger_index: 42 } });

    const [, init] = fetcher.mock.calls[0];
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      method: "account_info",
      params: [{ account: "rExample", ledger_index: "validated" }],
    });
  });

  it("formats WebSocket parameters at the top level and disconnects", async () => {
    const client: XrplWebSocketClient = {
      connect: vi.fn(async () => undefined),
      request: vi.fn(async () => ({ result: { alternatives: [] } })),
      disconnect: vi.fn(async () => undefined),
    };
    const factory = vi.fn(() => client);
    const transport = new XrplWebSocketTransport(factory);

    await expect(
      transport.request({
        network: "testnet",
        kind: "websocket",
        url: "wss://example.test/ws",
        command: "path_find",
        params: { subcommand: "create", source_account: "rSource" },
        timeoutMs: 8_000,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ result: { alternatives: [] } });

    expect(factory).toHaveBeenCalledWith("wss://example.test/ws", 8_000);
    expect(client.request).toHaveBeenCalledWith({
      command: "path_find",
      subcommand: "create",
      source_account: "rSource",
    });
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it("preserves only a safe protocol code from a rejected RippledError", async () => {
    const client: XrplWebSocketClient = {
      connect: vi.fn(async () => undefined),
      request: vi.fn(async () => {
        throw new RippledError("unsafe upstream message", {
          error: "actNotFound",
          request: { command: "path_find", passphrase: "do-not-disclose" },
        });
      }),
      disconnect: vi.fn(async () => undefined),
    };
    const transport = new XrplWebSocketTransport(() => client);

    await expect(
      transport.request({
        network: "testnet",
        kind: "websocket",
        url: "wss://example.test/ws",
        command: "path_find",
        params: { subcommand: "create" },
        timeoutMs: 8_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "actNotFound",
      kind: "soft-empty",
      retryable: false,
    });
    try {
      await transport.request({
        network: "testnet",
        kind: "websocket",
        url: "wss://example.test/ws",
        command: "path_find",
        params: {},
        timeoutMs: 8_000,
        signal: new AbortController().signal,
      });
    } catch (error) {
      expect(String(error)).not.toContain("do-not-disclose");
      expect(error).not.toHaveProperty("data");
    }
  });
});

describe("XRPL response normalization", () => {
  it("unwraps both recorded JSON-RPC and WebSocket success fixtures", () => {
    expect(
      normalizeXrplResponse({
        result: { status: "success", account_data: { Balance: "100" } },
      }),
    ).toEqual({ status: "success", account_data: { Balance: "100" } });
    expect(
      normalizeXrplResponse({
        id: 1,
        type: "response",
        result: { alternatives: [], status: "success" },
      }),
    ).toEqual({ alternatives: [], status: "success" });
  });

  it("normalizes soft-empty protocol errors without retaining echoed input", () => {
    const fixture = {
      result: {
        status: "error",
        error: "actNotFound",
        error_message: "Account not found for secret-value",
        request: { command: "account_info", passphrase: "secret-value" },
      },
    };

    try {
      normalizeXrplResponse(fixture);
      throw new Error("expected normalization to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(XrplRpcError);
      expect(error).toMatchObject({
        service: "xrpl",
        kind: "soft-empty",
        code: "actNotFound",
        retryable: false,
      });
      expect(String(error)).not.toContain("secret-value");
      expect(error).not.toHaveProperty("request");
    }
  });

  it("rejects malformed fixture responses", () => {
    expect(() => normalizeXrplResponse([])).toThrowError(
      expect.objectContaining({ code: "XRPL_MALFORMED_RESPONSE" }),
    );
    expect(() => normalizeXrplResponse({ result: null })).toThrowError(
      expect.objectContaining({ code: "XRPL_MALFORMED_RESPONSE" }),
    );
  });
});

describe("XRPL RPC adapter", () => {
  it("uses the documented 8 second timeout and one retry by default", () => {
    expect(XRPL_RPC_TIMEOUT_MS).toBe(8_000);
    expect(XRPL_RPC_RETRIES).toBe(1);
  });

  it("retries a transient fixture failure once and returns normalized data", async () => {
    const transport = new FixtureTransport((_request, call) => {
      if (call === 1) {
        return { result: { status: "error", error: "tooBusy" } };
      }
      return { result: { status: "success", drops: { base_fee: "10" } } };
    });
    const rpc = createXrplRpc({ transport });

    await expect(rpc.request("testnet", "fee")).resolves.toEqual({
      status: "success",
      drops: { base_fee: "10" },
    });
    expect(transport.requests).toHaveLength(2);
  });

  it("performs no second retry after two transient failures", async () => {
    const transport = new FixtureTransport(() => {
      throw new Error("recorded network failure");
    });
    const rpc = createXrplRpc({ transport, timeoutMs: 100 });

    await expect(rpc.request("devnet", "fee")).rejects.toMatchObject({
      code: "XRPL_TRANSPORT_ERROR",
      retryable: true,
    });
    expect(transport.requests).toHaveLength(2);
  });

  it("times out each attempt and retries only once", async () => {
    const transport = new FixtureTransport(
      () => new Promise(() => undefined),
    );
    const rpc = createXrplRpc({ transport, timeoutMs: 5 });

    await expect(rpc.request("devnet", "server_info")).rejects.toMatchObject({
      code: "XRPL_TIMEOUT",
    });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.every(({ signal }) => signal.aborted)).toBe(true);
  });

  it("routes path_find to WebSocket and ordinary reads to JSON-RPC", async () => {
    const transport = new FixtureTransport((request) => ({
      result: { status: "success", kind: request.kind },
    }));
    const rpc = createXrplRpc({ transport });

    await expect(rpc.request("testnet", "path_find")).resolves.toMatchObject({
      kind: "websocket",
    });
    await expect(rpc.request("testnet", "book_offers")).resolves.toMatchObject({
      kind: "json-rpc",
    });
  });

  it("uses a WebSocket endpoint override for ordinary requests", async () => {
    const transport = new FixtureTransport((request) => ({
      result: { status: "success", url: request.url, kind: request.kind },
    }));
    const rpc = createXrplRpc({
      env: { XRPL_DEVNET_URL: "wss://private.example/ws" },
      transport,
    });

    await expect(rpc.request("devnet", "fee")).resolves.toMatchObject({
      url: "wss://private.example/ws",
      kind: "websocket",
    });
  });

  it.each(["submit", "submit_multisigned"])(
    "blocks mainnet %s before reaching a transport",
    async (command) => {
      const transport = new FixtureTransport(() => ({ result: {} }));
      const rpc = createXrplRpc({ transport });

      await expect(rpc.request("mainnet", command)).rejects.toMatchObject({
        code: "MAINNET_EXECUTION_DISABLED",
        retryable: false,
      });
      expect(transport.requests).toHaveLength(0);
    },
  );

  it("allows mainnet reads but rejects an explicit execute intent", async () => {
    const transport = new FixtureTransport(() => ({
      result: { status: "success", ledger_index: 100 },
    }));
    const rpc = createXrplRpc({ transport });

    await expect(rpc.request("mainnet", "ledger")).resolves.toMatchObject({
      ledger_index: 100,
    });
    await expect(
      rpc.request("mainnet", "simulate", {}, { intent: "execute" }),
    ).rejects.toMatchObject({ code: "MAINNET_EXECUTION_DISABLED" });
    expect(transport.requests).toHaveLength(1);
  });

  it.each(["sign", "sign_for", "wallet_propose"])(
    "rejects secret-bearing command %s before transport",
    async (command) => {
      const transport = new FixtureTransport(() => ({ result: {} }));
      const rpc = createXrplRpc({ transport });

      await expect(rpc.request("testnet", command)).rejects.toMatchObject({
        code: "XRPL_UNSAFE_COMMAND",
      });
      expect(transport.requests).toHaveLength(0);
    },
  );

  it("forwards operation context calls to the injected RPC with stable arity", async () => {
    const request = vi.fn(
      async (_network: Network, _command: string) => ({ ledger_index: 9 }),
    );
    const ctx = { principal: "fixture", xrplRpc: { request } };

    await expect(
      requestXrpl(ctx, "testnet", "ledger", { ledger_index: "validated" }),
    ).resolves.toEqual({ ledger_index: 9 });
    expect(request).toHaveBeenCalledWith(
      "testnet",
      "ledger",
      { ledger_index: "validated" },
      undefined,
    );
  });
});
