import { describe, expect, it, vi } from "vitest";

import {
  AgentCorePublicMarketError,
  AGENTCORE_RLUSD_CURRENCY,
  AGENTCORE_XRPL_TESTNET_RPC,
  createXrplPublicMarketSource,
  isValidXrplClassicAddress,
  type AgentCorePublicMarketConfig,
} from "../src/public-market";
import { AGENTCORE_PUBLIC_MARKET_VENUE } from "../src/contracts";

const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const RLUSD = AGENTCORE_RLUSD_CURRENCY;
const NOW = Date.parse("2026-10-24T12:00:30.000Z");
const CLOSE = Date.parse("2026-10-24T12:00:00.000Z") / 1_000 - 946_684_800;
const LEDGER_HASH = "A".repeat(64);

const config: AgentCorePublicMarketConfig = {
  endpoint: AGENTCORE_XRPL_TESTNET_RPC,
  pair: "XRP/RLUSD",
  venue: AGENTCORE_PUBLIC_MARKET_VENUE,
  base: { symbol: "XRP", currency: "XRP" },
  quote: { symbol: "RLUSD", currency: RLUSD, issuer: ISSUER },
};
const request = {
  requestId: "market-1",
  scopeDigest: "a".repeat(64),
};

function json(result: unknown) {
  return new Response(JSON.stringify({ result, status: "success" }), {
    headers: { "content-type": "application/json" },
  });
}
function ledger(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ledger_hash: LEDGER_HASH,
    ledger_index: 12_345,
    validated: true,
    ledger: {
      ledger_hash: LEDGER_HASH,
      ledger_index: 12_345,
      close_time: CLOSE,
      close_time_resolution: 10,
      closed: true,
    },
    ...overrides,
  };
}
function book(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ledger_hash: LEDGER_HASH,
    ledger_index: 12_345,
    offers: [{ quality: "1000000" }, { quality: "1000100" }],
    ...overrides,
  };
}
function fixtureFetch(ledgerResult: unknown = ledger(), bookResult: unknown = book()) {
  const calls: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const body = JSON.parse(String(init?.body)) as { method: string };
    return body.method === "ledger" ? json(ledgerResult) : json(bookResult);
  });
  return { fetch, calls };
}

describe("AgentCore public XRPL market source", () => {
  it("reads one exact validated Testnet book without sending private scope", async () => {
    const fixture = fixtureFetch();
    const source = createXrplPublicMarketSource({ config, fetch: fixture.fetch, now: () => NOW });
    await expect(source.read(request, { signal: new AbortController().signal })).resolves.toEqual({
      summary: "Validated XRPL Testnet ledger 12345 exposed 2 ask-side XRP/RLUSD offers in the bounded sample.",
      evidence: [{
        source: AGENTCORE_PUBLIC_MARKET_VENUE,
        claim: "Read the exact configured XRP/RLUSD order book at one validated ledger, capped at 20 offers.",
        freshness: "2026-10-24T12:00:00.000Z",
      }],
      caveats: [
        "Read-only Testnet observation; no transaction was signed, submitted, or simulated.",
        "The sample is capped at 20 ask-side offers and is not an executable price or full-depth guarantee.",
        "Public XRPL RPC data is external evidence and never transaction authority.",
      ],
    });
    expect(fixture.calls.map((call) => call.url)).toEqual([
      AGENTCORE_XRPL_TESTNET_RPC,
      AGENTCORE_XRPL_TESTNET_RPC,
    ]);
    for (const call of fixture.calls) {
      expect(call.init?.method).toBe("POST");
      expect(call.init?.redirect).toBe("error");
      expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
      const serialized = String(call.init?.body);
      for (const forbidden of [request.requestId, request.scopeDigest, "tenantId", "prompt", "token", "privateKey"]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
    expect(JSON.parse(String(fixture.calls[0]?.init?.body))).toEqual({
      method: "ledger",
      params: [{ ledger_index: "validated", transactions: false, expand: false, owner_funds: false, api_version: 2 }],
    });
    expect(JSON.parse(String(fixture.calls[1]?.init?.body))).toEqual({
      method: "book_offers",
      params: [{
        ledger_hash: LEDGER_HASH,
        taker_gets: { currency: "XRP" },
        taker_pays: { currency: RLUSD, issuer: ISSUER },
        limit: 20,
        api_version: 2,
      }],
    });
  });

  it.each([
    ["pair selector", { ...request, pair: "XRP/RLUSD" }],
    ["venue selector", { ...request, venue: "xrpl-testnet-dex" }],
    ["timeframe selector", { ...request, timeframe: "spot" }],
    ["extra identity", { ...request, owner: ISSUER }],
  ])("rejects %s before transport", async (_name, candidate) => {
    const fetch = vi.fn();
    const source = createXrplPublicMarketSource({ config, fetch, now: () => NOW });
    await expect(source.read(candidate as never, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["non-allowlisted endpoint", { ...config, endpoint: "https://example.test/" }],
    ["bad issuer checksum", { ...config, quote: { ...config.quote, issuer: `${ISSUER.slice(0, -1)}r` } }],
    ["issuer on XRP", { ...config, base: { ...config.base, issuer: ISSUER } }],
    ["hex symbol mismatch", { ...config, quote: { ...config.quote, symbol: "USD" } }],
    ["pair mismatch", { ...config, pair: "XRP/USD" }],
  ])("rejects %s configuration", (_name, candidate) => {
    expect(() => createXrplPublicMarketSource({ config: candidate as AgentCorePublicMarketConfig }))
      .toThrow(AgentCorePublicMarketError);
  });

  it("checks classic-address version, alphabet, length, and checksum", () => {
    expect(isValidXrplClassicAddress(ISSUER)).toBe(true);
    expect(isValidXrplClassicAddress(`${ISSUER.slice(0, -1)}r`)).toBe(false);
    expect(isValidXrplClassicAddress("r0000000000000000000000000")).toBe(false);
    expect(isValidXrplClassicAddress(`X${ISSUER.slice(1)}`)).toBe(false);
  });

  it.each([
    ["unvalidated ledger", ledger({ validated: false }), book(), "invalid_response"],
    ["mismatched nested ledger", ledger({ ledger: { ...ledger().ledger, ledger_index: 12_346 } }), book(), "invalid_response"],
    ["mismatched book", ledger(), book({ ledger_hash: "B".repeat(64) }), "invalid_response"],
    ["oversized offer list", ledger(), book({ offers: new Array(21).fill({}) }), "invalid_response"],
    ["stale ledger", ledger({ ledger: { ...ledger().ledger, close_time: CLOSE - 121 } }), book(), "stale"],
    ["future ledger", ledger({ ledger: { ...ledger().ledger, close_time: CLOSE + 41 } }), book(), "stale"],
  ])("rejects %s evidence", async (_name, ledgerResult, bookResult, code) => {
    const fixture = fixtureFetch(ledgerResult, bookResult);
    const source = createXrplPublicMarketSource({ config, fetch: fixture.fetch, now: () => NOW });
    await expect(source.read(request, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code });
  });

  it("rechecks freshness after the order-book response", async () => {
    const fixture = fixtureFetch();
    const times = [NOW, NOW + 91_000];
    const source = createXrplPublicMarketSource({
      config,
      fetch: fixture.fetch,
      now: () => times.shift() ?? NOW + 91_000,
    });
    await expect(source.read(request, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "stale" });
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed on HTTP, media type, protocol, malformed, and oversized responses", async () => {
    const responses = [
      new Response("down", { status: 503, headers: { "content-type": "text/plain" } }),
      new Response("{}", { headers: { "content-type": "text/plain" } }),
      new Response(JSON.stringify({ error: { message: "must-not-leak" } }), { headers: { "content-type": "application/json" } }),
      new Response("not-json", { headers: { "content-type": "application/json" } }),
      new Response("x".repeat(1_025), { headers: { "content-type": "application/json", "content-length": "1025" } }),
    ];
    for (const response of responses) {
      const source = createXrplPublicMarketSource({
        config: { ...config, maxResponseBytes: 1_024 },
        fetch: vi.fn(async () => response),
        now: () => NOW,
      });
      const error = await source.read(request, { signal: new AbortController().signal }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(AgentCorePublicMarketError);
      expect(String(error)).not.toContain("must-not-leak");
    }
  });

  it("bounds both a fetch that ignores abort and a never-ending response body", async () => {
    const started = Date.now();
    const ignored = createXrplPublicMarketSource({
      config: { ...config, timeoutMs: 100 },
      fetch: async () => new Promise<never>(() => undefined),
      now: () => NOW,
    });
    await expect(ignored.read(request, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "timeout" });

    const body = new ReadableStream<Uint8Array>({ start() { /* remains pending */ } });
    const hanging = createXrplPublicMarketSource({
      config: { ...config, timeoutMs: 100 },
      fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
      now: () => NOW,
    });
    await expect(hanging.read(request, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("rejects an already-aborted source call before fetch", async () => {
    const fetch = vi.fn();
    const source = createXrplPublicMarketSource({ config, fetch, now: () => NOW });
    const controller = new AbortController();
    controller.abort();
    await expect(source.read(request, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "timeout" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
