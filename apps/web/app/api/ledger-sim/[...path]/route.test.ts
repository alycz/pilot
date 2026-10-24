import { describe, expect, it, vi } from "vitest";

import {
  createLedgerSimProxyHandlers,
  type LedgerSimProxyEnvironment,
} from "./handler";
import * as routeModule from "./route";

const ORIGIN = "http://127.0.0.1:3003";
const UPSTREAM = "http://127.0.0.1:5000";
const LOCAL_ENVIRONMENT: LedgerSimProxyEnvironment = {
  EXEC_NETWORK: "testnet",
  HARBOR_URL: "http://127.0.0.1:8791",
  LEDGER_MODE: "webhid+virtual",
  LEDGER_SPECULOS_URL: UPSTREAM,
  NEXT_PUBLIC_DEV_SIGNER: "0",
  PILOT_DEPLOYMENT_PROFILE: "local-wallet",
};

function request(
  path: string,
  method: "GET" | "POST",
  options: {
    body?: string;
    origin?: string | null;
    fetchSite?: string;
  } = {},
): Request {
  const headers = new Headers({ host: "127.0.0.1:3003" });
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? ORIGIN);
  }
  if (options.fetchSite !== undefined) {
    headers.set("sec-fetch-site", options.fetchSite);
  }
  if (method === "POST") headers.set("content-type", "application/json");
  return new Request(`${ORIGIN}/api/ledger-sim/${path}`, {
    method,
    headers,
    ...(method === "POST" ? { body: options.body ?? "{}" } : {}),
  });
}

function context(path: string) {
  return {
    params: Promise.resolve({ path: path.split("/").filter(Boolean) }),
  };
}

function fetchDependency(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch;
}

function handlers(fetchMock = vi.fn(async () => new Response("ok"))) {
  return {
    fetchMock,
    ...createLedgerSimProxyHandlers({
      env: LOCAL_ENVIRONMENT,
      fetch: fetchDependency(fetchMock),
    }),
  };
}

describe("/api/ledger-sim/[...path]", () => {
  it("exports only Next-supported route fields", () => {
    expect(Object.keys(routeModule).sort()).toEqual([
      "GET",
      "POST",
      "dynamic",
      "runtime",
    ]);
  });

  it.each([
    ["GET", "events", `${UPSTREAM}/events`],
    ["GET", "events?stream=true", `${UPSTREAM}/events?stream=true`],
    [
      "GET",
      "events?currentscreenonly=true",
      `${UPSTREAM}/events?currentscreenonly=true`,
    ],
    ["GET", "screenshot", `${UPSTREAM}/screenshot`],
    ["POST", "apdu", `${UPSTREAM}/apdu`],
    ["POST", "button/left", `${UPSTREAM}/button/left`],
    ["POST", "button/right", `${UPSTREAM}/button/right`],
    ["POST", "button/both", `${UPSTREAM}/button/both`],
  ] as const)("allows only %s %s", async (method, path, expectedUrl) => {
    const { GET, POST, fetchMock } = handlers();
    const routePath = path.split("?")[0]!;
    const response = await (method === "GET" ? GET : POST)(
      request(path, method),
      context(routePath),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledWith(
      expectedUrl,
      expect.objectContaining({ method, cache: "no-store", redirect: "error" }),
    );
  });

  it("rejects unknown paths, query widening and wrong methods", async () => {
    const { GET, POST, fetchMock } = handlers();

    await expect(GET(request("admin", "GET"), context("admin")))
      .resolves.toMatchObject({ status: 404 });
    await expect(
      GET(request("events?stream=false", "GET"), context("events")),
    ).resolves.toMatchObject({ status: 404 });
    await expect(GET(request("apdu", "GET"), context("apdu")))
      .resolves.toMatchObject({ status: 405 });
    await expect(POST(request("screenshot", "POST"), context("screenshot")))
      .resolves.toMatchObject({ status: 405 });
    await expect(POST(request("button/up", "POST"), context("button/up")))
      .resolves.toMatchObject({ status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 on hosted and when the virtual transport is disabled", async () => {
    const fetchMock = vi.fn();
    const hosted = createLedgerSimProxyHandlers({
      env: {
        EXEC_NETWORK: "testnet",
        HARBOR_URL: "https://harbor.example",
        LEDGER_MODE: "webhid+virtual",
        LEDGER_SPECULOS_URL: UPSTREAM,
        PILOT_DEPLOYMENT_PROFILE: "hosted",
        PILOT_PUBLIC_ORIGIN: "https://pilot.example",
      },
      fetch: fetchDependency(fetchMock),
    });
    const webhidOnly = createLedgerSimProxyHandlers({
      env: { ...LOCAL_ENVIRONMENT, LEDGER_MODE: "webhid" },
      fetch: fetchDependency(fetchMock),
    });

    await expect(
      hosted.GET(
        new Request("https://pilot.example/api/ledger-sim/events", {
          headers: { origin: "https://pilot.example" },
        }),
        context("events"),
      ),
    ).resolves.toMatchObject({ status: 404 });
    await expect(webhidOnly.GET(request("events", "GET"), context("events")))
      .resolves.toMatchObject({ status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts browser GET metadata without weakening POST origin checks", async () => {
    const { GET, POST, fetchMock } = handlers();

    await expect(
      GET(
        request("screenshot", "GET", {
          origin: null,
          fetchSite: "same-origin",
        }),
        context("screenshot"),
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      GET(request("events", "GET", { origin: null }), context("events")),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      GET(
        request("events", "GET", {
          origin: null,
          fetchSite: "cross-site",
        }),
        context("events"),
      ),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      GET(
        request("events", "GET", {
          origin: "https://attacker.example",
          fetchSite: "same-origin",
        }),
        context("events"),
      ),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      POST(
        request("apdu", "POST", {
          origin: null,
          fetchSite: "same-origin",
        }),
        context("apdu"),
      ),
    ).resolves.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts 4 KB and rejects a body one byte larger before fetch", async () => {
    const { POST, fetchMock } = handlers();
    const accepted = "A".repeat(4 * 1024);
    const rejected = `${accepted}B`;

    await expect(POST(request("apdu", "POST", { body: accepted }), context("apdu")))
      .resolves.toMatchObject({ status: 200 });
    await expect(POST(request("apdu", "POST", { body: rejected }), context("apdu")))
      .resolves.toMatchObject({ status: 413 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit | undefined]
    >;
    expect(calls[0]?.[1]).toMatchObject({ body: accepted });
  });

  it("passes the SSE response body through without buffering", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: screen\n\n"));
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }));
    const { GET } = handlers(fetchMock);

    const result = await GET(
      request("events?stream=true", "GET"),
      context("events"),
    );

    expect(result.body).toBe(stream);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
});
