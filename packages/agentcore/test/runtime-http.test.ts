import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startAgentCoreRuntimeHttpServer } from "../src/runtime-http";

const close: Array<() => Promise<void>> = [];
const AUTHENTICATED_JSON_HEADERS = Object.freeze({
  "content-type": "application/json",
  WorkloadAccessToken: "opaque-platform-workload-token",
});
afterEach(async () => Promise.all(close.splice(0).map((entry) => entry())));

async function start(input: Parameters<typeof startAgentCoreRuntimeHttpServer>[0]) {
  const runtime = await startAgentCoreRuntimeHttpServer({
    host: "127.0.0.1",
    port: 0,
    requestTimeoutMs: 250,
    ...input,
  });
  close.push(runtime.close);
  return runtime;
}

async function postWithRawHeaders(
  origin: string,
  headers: OutgoingHttpHeaders,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const url = new URL("/invocations", origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      }));
    });
    request.once("error", reject);
    request.end("{}");
  });
}

describe("AgentCore Runtime HTTP contract", () => {
  it("serves health and invokes the injected bounded handler", async () => {
    const invoke = vi.fn(async (value: unknown, _context: unknown) => ({ ok: true, value }));
    const runtime = await start({ handler: { invoke } });

    const ping = await fetch(`${runtime.origin}/ping`);
    expect(ping.status).toBe(200);
    expect(ping.headers.get("content-type")).toContain("application/json");
    expect(await ping.json()).toEqual({ status: "Healthy" });

    const response = await fetch(`${runtime.origin}/invocations`, {
      method: "POST",
      headers: {
        ...AUTHENTICATED_JSON_HEADERS,
        "content-type": "application/json; charset=utf-8",
        "x-not-forwarded": "private-header-value",
      },
      body: JSON.stringify({ bounded: "request" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, value: { bounded: "request" } });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      signal: expect.any(AbortSignal),
      workloadAccessToken: "opaque-platform-workload-token",
    });
  });

  it.each([
    ["GET", "/invocations", undefined, 404, "not_found"],
    ["POST", "/unknown", "{}", 404, "not_found"],
    ["POST", "/invocations?debug=1", "{}", 404, "not_found"],
    ["POST", "/invocations", undefined, 415, "unsupported_media_type"],
  ])("fails closed for %s %s", async (method, path, body, status, error) => {
    const runtime = await start({ handler: { async invoke() { return {}; } } });
    const response = await fetch(`${runtime.origin}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("rejects invalid and oversized bodies without invoking the handler", async () => {
    const invoke = vi.fn();
    const runtime = await start({ handler: { invoke }, maxRequestBytes: 16 });
    const invalid = await fetch(`${runtime.origin}/invocations`, {
      method: "POST",
      headers: AUTHENTICATED_JSON_HEADERS,
      body: "not-json",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_request" });

    const oversized = await fetch(`${runtime.origin}/invocations`, {
      method: "POST",
      headers: AUTHENTICATED_JSON_HEADERS,
      body: JSON.stringify({ input: "too-large" }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request_too_large" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("requires one bounded platform workload token and rejects duplicates", async () => {
    const invoke = vi.fn(async () => ({}));
    const runtime = await start({ handler: { invoke } });
    const missing = await fetch(`${runtime.origin}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "workload_identity_required" });

    const malformed = await fetch(`${runtime.origin}/invocations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        WorkloadAccessToken: "token with spaces",
      },
      body: "{}",
    });
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toEqual({ error: "workload_identity_required" });

    const duplicate = await postWithRawHeaders(runtime.origin, {
      "content-type": "application/json",
      WorkloadAccessToken: ["token-one", "token-two"],
    });
    expect(duplicate).toEqual({ status: 401, body: { error: "workload_identity_required" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports HealthyBusy and rejects concurrent work instead of queuing it", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const runtime = await start({
      handler: { async invoke() { await pending; return { ok: true }; } },
      maxConcurrentRequests: 1,
    });
    const first = fetch(`${runtime.origin}/invocations`, {
      method: "POST",
      headers: AUTHENTICATED_JSON_HEADERS,
      body: "{}",
    });
    await vi.waitFor(async () => {
      expect(await (await fetch(`${runtime.origin}/ping`)).json()).toEqual({ status: "HealthyBusy" });
    });
    const second = await fetch(`${runtime.origin}/invocations`, {
      method: "POST",
      headers: AUTHENTICATED_JSON_HEADERS,
      body: "{}",
    });
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "runtime_busy" });
    release();
    expect((await first).status).toBe(200);
  });

  it("bounds dependency latency and never returns exception details", async () => {
    const runtime = await start({
      handler: { async invoke(_value, context) {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("sensitive provider failure")),
            { once: true },
          );
        });
        return {};
      } },
      requestTimeoutMs: 100,
    });
    const response = await fetch(`${runtime.origin}/invocations`, {
      method: "POST",
      headers: AUTHENTICATED_JSON_HEADERS,
      body: "{}",
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "runtime_timeout" });
  });

  it("releases capacity when a dependency ignores cancellation forever", async () => {
    const invoke = vi.fn()
      .mockImplementationOnce(async () => new Promise<never>(() => undefined))
      .mockImplementationOnce(async () => ({ recovered: true }));
    const runtime = await start({
      handler: { invoke },
      requestTimeoutMs: 100,
      maxConcurrentRequests: 1,
    });
    const first = await fetch(`${runtime.origin}/invocations`, {
      method: "POST",
      headers: AUTHENTICATED_JSON_HEADERS,
      body: "{}",
    });
    expect(first.status).toBe(504);

    const second = await fetch(`${runtime.origin}/invocations`, {
      method: "POST",
      headers: AUTHENTICATED_JSON_HEADERS,
      body: "{}",
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ recovered: true });
  });

  it("rejects non-serializable and oversized dependency responses", async () => {
    const invalid = await start({
      handler: { async invoke() {
        const circular: { self?: unknown } = {};
        circular.self = circular;
        return circular;
      } },
    });
    const invalidResponse = await fetch(`${invalid.origin}/invocations`, {
      method: "POST",
      headers: AUTHENTICATED_JSON_HEADERS,
      body: "{}",
    });
    expect(invalidResponse.status).toBe(502);
    expect(await invalidResponse.json()).toEqual({ error: "runtime_response_invalid" });

    const undefinedResult = await start({
      handler: { async invoke() { return undefined; } },
    });
    const undefinedResponse = await fetch(`${undefinedResult.origin}/invocations`, {
      method: "POST",
      headers: AUTHENTICATED_JSON_HEADERS,
      body: "{}",
    });
    expect(undefinedResponse.status).toBe(502);
    expect(await undefinedResponse.json()).toEqual({ error: "runtime_response_invalid" });

    const oversized = await start({
      handler: { async invoke() { return { output: "x".repeat(1_000) }; } },
      maxResponseBytes: 100,
    });
    const oversizedResponse = await fetch(`${oversized.origin}/invocations`, {
      method: "POST",
      headers: AUTHENTICATED_JSON_HEADERS,
      body: "{}",
    });
    expect(oversizedResponse.status).toBe(502);
    expect(await oversizedResponse.json()).toEqual({ error: "runtime_response_too_large" });
  });
});
