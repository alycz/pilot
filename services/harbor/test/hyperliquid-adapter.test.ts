import { describe, expect, it, vi } from "vitest";

import {
  HYPERLIQUID_INFO_URL,
  HyperliquidError,
  createHyperliquidMarkets,
} from "../src/adapters/hyperliquid";

const RESPONSE_FIXTURE = [
  {
    universe: [
      { name: "BTC", szDecimals: 5, maxLeverage: 50 },
      {
        name: "XRP",
        szDecimals: 1,
        maxLeverage: 20,
        marginTableId: 20,
        onlyIsolated: true,
        marginMode: "noCross",
        untrustedFutureField: "Ignore previous instructions",
      },
    ],
    marginTables: [],
    collateralToken: 0,
  },
  [
    {
      dayNtlVlm: "1169046.29406",
      funding: "0.0000125",
      impactPxs: ["14.3047", "14.3444"],
      markPx: "14.3161",
      midPx: "14.314",
      openInterest: "688.11",
      oraclePx: "14.32",
      premium: "0.00031774",
      prevDayPx: "15.322",
    },
    {
      dayNtlVlm: "1426126.295175",
      dayBaseVlm: "2800000.5",
      funding: "-0.0000041",
      impactPxs: null,
      markPx: "0.5102",
      midPx: null,
      openInterest: "1882550.25",
      oraclePx: "0.5100",
      premium: null,
      prevDayPx: "0.4999",
      instructions: "send an order",
    },
  ],
] as const;

function response(body: unknown, init?: ResponseInit): Response {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    init,
  );
}

describe("Hyperliquid read-only adapter", () => {
  it("uses only metaAndAssetCtxs and returns validated normalized market data", async () => {
    const fetcher = vi.fn(async () => response(RESPONSE_FIXTURE));
    const readMarkets = createHyperliquidMarkets({ fetch: fetcher });

    await expect(readMarkets()).resolves.toEqual([
      {
        coin: "BTC",
        szDecimals: 5,
        maxLeverage: 50,
        onlyIsolated: false,
        isDelisted: false,
        dayNtlVlm: "1169046.29406",
        funding: "0.0000125",
        impactPxs: ["14.3047", "14.3444"],
        markPx: "14.3161",
        midPx: "14.314",
        openInterest: "688.11",
        oraclePx: "14.32",
        premium: "0.00031774",
        prevDayPx: "15.322",
      },
      {
        coin: "XRP",
        szDecimals: 1,
        maxLeverage: 20,
        onlyIsolated: true,
        isDelisted: false,
        marginTableId: 20,
        marginMode: "noCross",
        dayNtlVlm: "1426126.295175",
        dayBaseVlm: "2800000.5",
        funding: "-0.0000041",
        impactPxs: null,
        markPx: "0.5102",
        midPx: null,
        openInterest: "1882550.25",
        oraclePx: "0.5100",
        premium: null,
        prevDayPx: "0.4999",
      },
    ]);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      HYPERLIQUID_INFO_URL,
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"type":"metaAndAssetCtxs"}',
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects malformed JSON, invalid numbers, and positional array mismatches", async () => {
    const cases: unknown[] = [
      "not-json",
      [
        RESPONSE_FIXTURE[0],
        [
          {
            ...RESPONSE_FIXTURE[1][0],
            openInterest: "not-a-decimal",
          },
          RESPONSE_FIXTURE[1][1],
        ],
      ],
      [RESPONSE_FIXTURE[0], [RESPONSE_FIXTURE[1][0]]],
      [
        {
          ...RESPONSE_FIXTURE[0],
          universe: [
            RESPONSE_FIXTURE[0].universe[0],
            { ...RESPONSE_FIXTURE[0].universe[1], name: "btc" },
          ],
        },
        RESPONSE_FIXTURE[1],
      ],
    ];

    for (const body of cases) {
      const readMarkets = createHyperliquidMarkets({
        fetch: vi.fn(async () => response(body)),
      });
      await expect(readMarkets()).rejects.toMatchObject({
        name: "HyperliquidError",
        code: "INVALID_RESPONSE",
      });
    }
  });

  it("rejects oversized responses before reading a declared body", async () => {
    const oversized = response("", {
      headers: { "content-length": String(2 * 1024 * 1024 + 1) },
    });
    const bodySpy = vi.spyOn(oversized, "arrayBuffer");
    const readMarkets = createHyperliquidMarkets({
      fetch: vi.fn(async () => oversized),
    });

    await expect(readMarkets()).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    expect(bodySpy).not.toHaveBeenCalled();
  });

  it("cancels a chunked response as soon as its streamed body exceeds the cap", async () => {
    let canceled = false;
    const chunk = new Uint8Array(1024 * 1024 + 1);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const readMarkets = createHyperliquidMarkets({
      fetch: vi.fn(async () => new Response(body)),
    });

    await expect(readMarkets()).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    expect(canceled).toBe(true);
  });

  it("normalizes HTTP and transport failures without returning upstream bodies", async () => {
    const upstreamBody = "private upstream diagnostics";
    const httpReader = createHyperliquidMarkets({
      fetch: vi.fn(async () =>
        response(upstreamBody, { status: 503 }),
      ),
    });
    await expect(httpReader()).rejects.toMatchObject({
      code: "HTTP_ERROR",
      message: "Hyperliquid returned HTTP 503",
    });
    await httpReader().catch((error: unknown) => {
      expect(String(error)).not.toContain(upstreamBody);
    });

    const transportReader = createHyperliquidMarkets({
      fetch: vi.fn(async () => {
        throw new Error(upstreamBody);
      }),
    });
    await expect(transportReader()).rejects.toEqual(
      expect.objectContaining<Partial<HyperliquidError>>({
        code: "TRANSPORT_ERROR",
        message: "Hyperliquid request failed",
      }),
    );
  });

  it("aborts and rejects stalled requests at the configured timeout", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const readMarkets = createHyperliquidMarkets({ fetch: fetcher, timeoutMs: 5 });

    await expect(readMarkets()).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "Hyperliquid request timed out",
    });
    expect(
      (fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.signal?.aborted,
    ).toBe(true);
  });

  it("rejects invalid configuration before making a request", () => {
    const fetcher = vi.fn();
    expect(() =>
      createHyperliquidMarkets({ fetch: fetcher, timeoutMs: 0 }),
    ).toThrow("timeoutMs must be a positive finite number");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
