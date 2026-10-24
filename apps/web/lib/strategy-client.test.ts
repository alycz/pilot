import { describe, expect, it, vi } from "vitest";

import { createStrategyClient } from "./strategy-client";

describe("strategy client", () => {
  it("uses same-origin reads without credentials or scope supplied by the browser", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true, data: [], asOf: "2026-10-22T00:00:00.000Z", asOfBasis: "server",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createStrategyClient(fetcher as typeof fetch);

    await expect(client.list()).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/strategy/list", expect.objectContaining({
      method: "POST", credentials: "same-origin",
    }));
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({});
  });

  it("makes one mutation attempt and preserves the caller request id on network ambiguity", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      throw new Error("connection reset");
    });
    const client = createStrategyClient(fetcher as typeof fetch);
    const requestId = "request-pause-stable-001";

    const outcome = client.pause("strategy-test-001", "owner pause", requestId);
    await expect(outcome).rejects.toMatchObject({ requestId });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
      strategy_id: "strategy-test-001", request_id: requestId,
    });
  });

  it("preserves the request id from an explicit upstream-outcome-unknown response", async () => {
    const requestId = "request-stop-stable-001";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: false,
      error: {
        code: "STRATEGY_UPSTREAM_OUTCOME_UNKNOWN",
        message: "unknown",
        request_id: requestId,
      },
    }), { status: 502, headers: { "content-type": "application/json" } }));
    const client = createStrategyClient(fetcher as typeof fetch);

    await expect(client.stop("strategy-test-001", "owner stop", requestId))
      .rejects.toMatchObject({ requestId });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reads the exact projected Testnet global-kill scope without browser-supplied authority", async () => {
    const scoped = {
      owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet" as const,
      kill_switch: { enabled: true, reason: "Owner emergency stop", updated_at: "2026-10-23T00:00:00.000Z" },
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true, data: scoped, asOf: "2026-10-23T00:00:00.000Z", asOfBasis: "server",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createStrategyClient(fetcher as typeof fetch);

    await expect(client.globalKillGet()).resolves.toEqual(scoped);
    expect(fetcher).toHaveBeenCalledWith("/api/strategy/global-kill-get", expect.objectContaining({
      credentials: "same-origin",
    }));
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({});
  });

  it("sends explicit enable and proof-bound clear mutations with one stable request id", async () => {
    const scoped = {
      owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet",
      kill_switch: { enabled: false, reason: "Cleared by owner wallet proof", updated_at: "2026-10-23T00:00:00.000Z" },
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true, data: scoped, asOf: "now", asOfBasis: "server",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createStrategyClient(fetcher as typeof fetch);
    const proof = {
      strategy_id: "strategy-test-001",
      mandate_version: 3,
      mandate_digest: "A".repeat(64),
      mandate_expires_at: "2026-10-30T00:00:00.000Z",
      challenge_token: "challenge-token",
      tx_blob: "DEADBEEF",
      request_id: "request-clear-global-001",
    };

    await client.globalKillEnable("Owner emergency stop", "request-enable-global-001");
    await client.globalKillClear(proof);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      reason: "Owner emergency stop", request_id: "request-enable-global-001",
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual(proof);
  });

  it("fails closed on malformed scoped global-kill responses", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true,
      data: {
        owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        network: "mainnet",
        kill_switch: { enabled: true, updated_at: "2026-10-23T00:00:00.000Z" },
        unexpected: true,
      },
      asOf: "now",
      asOfBasis: "server",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createStrategyClient(fetcher as typeof fetch);

    await expect(client.globalKillGet()).rejects.toThrow("Strategy response was invalid");
  });

  it("preserves the clear request id when the scoped mutation response is malformed", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true, data: { enabled: false }, asOf: "now", asOfBasis: "server",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createStrategyClient(fetcher as typeof fetch);
    const requestId = "request-clear-global-001";

    await expect(client.globalKillClear({
      strategy_id: "strategy-test-001",
      mandate_version: 3,
      mandate_digest: "A".repeat(64),
      mandate_expires_at: "2026-10-30T00:00:00.000Z",
      challenge_token: "challenge-token",
      tx_blob: "DEADBEEF",
      request_id: requestId,
    })).rejects.toMatchObject({ requestId });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
