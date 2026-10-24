import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_X402_PROBE_URL,
  LocalX402TargetError,
  isLocalDevRequest,
  probeLocalX402,
  validateLocalX402Target,
} from "../src/local-x402";

afterEach(() => {
  vi.useRealTimers();
});

describe("local development request boundary", () => {
  it("requires the flag, loopback destination and safe browser provenance", () => {
    const env = { HARBOR_LOCAL_DEV: "true" };
    expect(
      isLocalDevRequest(new Request("http://127.0.0.1:8791/mcp"), env),
    ).toBe(true);
    expect(
      isLocalDevRequest(
        new Request("http://127.0.0.1:8791/mcp", {
          headers: {
            origin: "http://127.0.0.1:8791",
            "sec-fetch-site": "same-origin",
          },
        }),
        env,
      ),
    ).toBe(true);
    expect(
      isLocalDevRequest(
        new Request("http://127.0.0.1:8791/mcp", {
          headers: { "sec-fetch-site": "none" },
        }),
        env,
      ),
    ).toBe(true);
    expect(
      isLocalDevRequest(
        new Request("http://127.0.0.1:8791/mcp"),
        {},
      ),
    ).toBe(false);
    expect(
      isLocalDevRequest(new Request("https://harbor.example/mcp"), env),
    ).toBe(false);
    expect(
      isLocalDevRequest(new Request("http://localhost:8787/mcp"), env),
    ).toBe(false);
    expect(
      isLocalDevRequest(new Request("http://[::1]:8787/mcp"), env),
    ).toBe(false);
    expect(
      isLocalDevRequest(new Request("http://127.0.0.1:8787/mcp"), env),
    ).toBe(false);
    expect(
      isLocalDevRequest(
        new Request("http://127.0.0.1:8791/mcp", {
          headers: { origin: "https://attacker.example" },
        }),
        env,
      ),
    ).toBe(false);
    expect(
      isLocalDevRequest(
        new Request("http://127.0.0.1:8791/mcp", {
          headers: { origin: "http://127.0.0.1:9999" },
        }),
        env,
      ),
    ).toBe(false);
    expect(
      isLocalDevRequest(
        new Request("http://127.0.0.1:8791/mcp", {
          headers: { "sec-fetch-site": "cross-site" },
        }),
        env,
      ),
    ).toBe(false);
  });
});

describe("local x402 target validation", () => {
  it("accepts only a raw canonical URL at the fixed merchant origin", () => {
    const target = `${LOCAL_X402_PROBE_URL}?asset=XRP`;
    expect(validateLocalX402Target(target, true).href).toBe(target);
    expect(validateLocalX402Target("http://127.0.0.1:8000", true).href).toBe(
      "http://127.0.0.1:8000/",
    );
  });

  it.each([
    "http://localhost:8000/api/x402/compare",
    "http://[::1]:8000/api/x402/compare",
    "http://127.0.0.2:8000/api/x402/compare",
    "http://127.0.0.1/api/x402/compare",
    "http://127.0.0.1:8001/api/x402/compare",
    "http://2130706433:8000/api/x402/compare",
    "http://0177.0.0.1:8000/api/x402/compare",
    "http://0x7f000001:8000/api/x402/compare",
    "http://user@127.0.0.1:8000/api/x402/compare",
    "http://127.0.0.1:8000@evil.example/api/x402/compare",
    "http://127.0.0.1:8000/api/x402/compare#fragment",
    "http://127.0.0.1:8000/api/../admin",
    "https://127.0.0.1:8000/api/x402/compare",
  ])("rejects non-canonical or expanded target %s", (target) => {
    expect(() => validateLocalX402Target(target, true)).toThrow(
      LocalX402TargetError,
    );
  });

  it("stays fail-closed outside local requests and for redirects", () => {
    expect(() => validateLocalX402Target(LOCAL_X402_PROBE_URL, false)).toThrow(
      LocalX402TargetError,
    );
    expect(() =>
      validateLocalX402Target(LOCAL_X402_PROBE_URL, true, true),
    ).toThrow(LocalX402TargetError);
  });
});

describe("local x402 connectivity probe", () => {
  it("makes one fixed credential-free GET, never follows redirects, and cancels the body", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () =>
      new Response(
        new ReadableStream({
          cancel,
        }),
        {
          status: 402,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await expect(probeLocalX402(true, { fetch: fetcher })).resolves.toEqual({
      reachable: true,
      status: 402,
      contentType: "application/json",
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [target, init] = fetcher.mock.calls[0]!;
    expect(String(target)).toBe(LOCAL_X402_PROBE_URL);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    const headers = new Headers(init?.headers);
    expect([...headers]).toEqual([]);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-payment")).toBe(false);
    expect(headers.has("payment-signature")).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns only a fixed unreachable result on transport failure", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("private upstream diagnostics");
    });
    await expect(probeLocalX402(true, { fetch: fetcher })).resolves.toEqual({
      reachable: false,
      status: null,
      contentType: null,
    });
  });

  it("cannot run outside a derived local request and treats redirects as unreachable", async () => {
    const fetcher = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: {
          location: "http://127.0.0.2/private",
          "content-type": "text/plain",
        },
      }),
    );
    await expect(probeLocalX402(false, { fetch: fetcher })).rejects.toThrow(
      LocalX402TargetError,
    );
    expect(fetcher).not.toHaveBeenCalled();

    await expect(probeLocalX402(true, { fetch: fetcher })).resolves.toEqual({
      reachable: false,
      status: 302,
      contentType: "text/plain",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("returns without waiting for a transport that ignores abort", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      () => new Promise<Response>(() => undefined),
    );
    const result = probeLocalX402(true, { fetch: fetcher, timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toEqual({
      reachable: false,
      status: null,
      contentType: null,
    });
  });
});
