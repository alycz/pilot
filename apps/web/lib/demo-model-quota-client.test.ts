import { describe, expect, it, vi } from "vitest";

import {
  HarborDemoQuotaClient,
  HarborDemoQuotaClientError,
} from "./demo-model-quota-client";

const BASE = "https://harbor.example/base";
const KEY = `pilot:${"k".repeat(40)}`;
const POLICY = "free-demo-v1";
const RESERVATION_ID = "550e8400-e29b-41d4-a716-446655440000";

function response(
  url: string,
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  const value = new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
  Object.defineProperty(value, "url", { value: url });
  return value;
}

function client(fetch: typeof globalThis.fetch) {
  return new HarborDemoQuotaClient({
    baseUrl: BASE,
    apiKey: KEY,
    policyVersion: POLICY,
  }, { fetch });
}

describe("HarborDemoQuotaClient", () => {
  it("posts only opaque reservation scopes to the fixed base-path endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(String(request)).toBe(
        "https://harbor.example/base/internal/demo-model/v1/reservations",
      );
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        cache: "no-store",
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        version: 1,
        requestId: "a".repeat(64),
        walletScopeId: "b".repeat(64),
        sessionScopeId: "c".repeat(64),
        network: "testnet",
        model: "provider/tool-model:free",
        inputBytes: 128,
      });
      expect(JSON.stringify(body)).not.toContain("r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59");
      return response(String(request), {
        ok: true,
        reservation: {
          id: RESERVATION_ID,
          timeoutMs: 28_000,
          maxOutputTokens: 85,
          maxSteps: 3,
          remainingGlobalDailyOutputTokens: 744,
          remainingWalletDailyOutputTokens: 256,
          remainingWalletDailyRequests: 9,
          policyVersion: POLICY,
        },
      });
    });

    await expect(client(fetch).reserve({
      version: 1,
      requestId: "a".repeat(64),
      walletScopeId: "b".repeat(64),
      sessionScopeId: "c".repeat(64),
      network: "testnet",
      model: "provider/tool-model:free",
      inputBytes: 128,
    })).resolves.toEqual(expect.objectContaining({
      id: RESERVATION_ID,
      policyVersion: POLICY,
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses fixed settle and status endpoints with strict response contracts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const url = String(request);
      if (url.endsWith("/status")) {
        return response(url, {
          ok: true,
          status: {
            available: true,
            policyVersion: POLICY,
            costPolicy: "free-only",
            allowedModels: ["provider/tool-model:free"],
            globalDailyOutputTokens: 10_000,
            globalDailyRequests: 100,
            walletDailyOutputTokens: 2_000,
            walletDailyRequests: 10,
            rateWindowSeconds: 60,
            rateRequests: 3,
            maxGlobalConcurrency: 4,
            maxWalletConcurrency: 1,
            reservationTtlSeconds: 120,
            abortGraceSeconds: 10,
            maxInputBytes: 4096,
            maxOutputTokens: 256,
            maxSteps: 3,
          },
        });
      }
      expect(url).toBe(
        `https://harbor.example/base/internal/demo-model/v1/reservations/${RESERVATION_ID}/settle`,
      );
      return response(url, {
        ok: true,
        settlement: {
          id: RESERVATION_ID,
          outcome: "uncertain",
          alreadySettled: false,
        },
      });
    });
    const quota = client(fetch);
    await expect(quota.status()).resolves.toEqual(expect.objectContaining({
      available: true,
      policyVersion: POLICY,
    }));
    await expect(quota.settle({
      version: 1,
      reservationId: RESERVATION_ID,
      outcome: "uncertain",
      integrityFailure: "missing-cost",
    })).resolves.toEqual({
      id: RESERVATION_ID,
      outcome: "uncertain",
      alreadySettled: false,
    });
  });

  it("retries an ambiguous reservation response with the exact idempotency body", async () => {
    const bodies: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new Error("synthetic response loss");
      return response(String(request), {
        ok: true,
        reservation: {
          id: RESERVATION_ID,
          timeoutMs: 28_000,
          maxOutputTokens: 85,
          maxSteps: 3,
          remainingGlobalDailyOutputTokens: 744,
          remainingWalletDailyOutputTokens: 256,
          remainingWalletDailyRequests: 9,
          policyVersion: POLICY,
        },
      });
    });
    await expect(client(fetch).reserve({
      version: 1,
      requestId: "a".repeat(64),
      walletScopeId: "b".repeat(64),
      sessionScopeId: "c".repeat(64),
      network: "testnet",
      model: "provider/tool-model:free",
      inputBytes: 128,
    })).resolves.toEqual(expect.objectContaining({ id: RESERVATION_ID }));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("retries an ambiguous settlement with the exact reservation and body", async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      urls.push(String(request));
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new Error("synthetic settlement response loss");
      return response(String(request), {
        ok: true,
        settlement: {
          id: RESERVATION_ID,
          outcome: "uncertain",
          alreadySettled: true,
        },
      });
    });

    await expect(client(fetch).settle({
      version: 1,
      reservationId: RESERVATION_ID,
      outcome: "uncertain",
      actualOutputTokens: 17,
    })).resolves.toEqual({
      id: RESERVATION_ID,
      outcome: "uncertain",
      alreadySettled: true,
    });
    expect(urls).toEqual([
      `${BASE}/internal/demo-model/v1/reservations/${RESERVATION_ID}/settle`,
      `${BASE}/internal/demo-model/v1/reservations/${RESERVATION_ID}/settle`,
    ]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("preserves bounded quota errors but rejects malformed or unexpected responses", async () => {
    const errorUrl = `${BASE}/internal/demo-model/v1/status`;
    const denied = client(vi.fn(async () => response(errorUrl, {
      ok: false,
      error: {
        code: "DEMO_RATE_LIMITED",
        message: "Rate limited",
        retryAfterSeconds: 12,
      },
    }, 429)) as typeof globalThis.fetch);
    await expect(denied.status()).rejects.toEqual(expect.objectContaining({
      code: "DEMO_RATE_LIMITED",
      status: 429,
      retryAfterSeconds: 12,
    }));

    for (const fetch of [
      vi.fn(async () => response("https://other.example/", { ok: true, status: {} })),
      vi.fn(async (request) => response(String(request), { ok: true, status: {}, extra: true })),
      vi.fn(async (request) => response(String(request), { ok: true, status: {} }, 200, {
        "Content-Length": "40000",
      })),
    ]) {
      await expect(client(fetch as typeof globalThis.fetch).status()).rejects.toBeInstanceOf(
        HarborDemoQuotaClientError,
      );
      await expect(client(fetch as typeof globalThis.fetch).status()).rejects.toEqual(
        expect.objectContaining({ code: "DEMO_STATE_UNAVAILABLE", status: 503 }),
      );
    }
  });

  it("cancels a chunked response as soon as it exceeds the byte bound", async () => {
    let cancelled = false;
    const oversized = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20 * 1024));
        controller.enqueue(new Uint8Array(20 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200 });
    Object.defineProperty(oversized, "url", {
      value: `${BASE}/internal/demo-model/v1/status`,
    });

    await expect(client(vi.fn(async () => oversized)).status()).rejects.toEqual(
      expect.objectContaining({ code: "DEMO_STATE_UNAVAILABLE", status: 503 }),
    );
    expect(cancelled).toBe(true);
  });

  it("rejects invalid outbound protocol values without issuing a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(client(fetch).reserve({
      version: 1,
      requestId: "A".repeat(64),
      walletScopeId: "b".repeat(64),
      sessionScopeId: "c".repeat(64),
      network: "testnet",
      model: "provider/tool-model:free",
      inputBytes: 1,
    })).rejects.toEqual(expect.objectContaining({
      code: "DEMO_STATE_UNAVAILABLE",
    }));
    expect(fetch).not.toHaveBeenCalled();
  });
});
