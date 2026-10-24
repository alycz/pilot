import { describe, expect, it, vi } from "vitest";

import {
  qnRest,
  QuickNodeError,
  validateQuickNodeStartup,
  type QuickNodeEnv,
} from "../src/quicknode/client";

const LOCAL_ENV: QuickNodeEnv = {
  QN_API_BASE: "http://127.0.0.1:8793",
  QN_API_KEY: "local-fixture-api-key",
  EXEC_NETWORK: "testnet",
  HARBOR_LOCAL_DEV: "true",
};

const LOCAL_CONTEXT = { runtimeLocal: true, requestLocal: true } as const;

describe("QuickNode REST client", () => {
  it("sends an authenticated JSON request to the loopback stand-in", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ items: ["rAccount"] }));
    await expect(
      qnRest("POST", "/kv/rest/v1/lists", { key: "accounts", items: ["rAccount"] }, {
        env: LOCAL_ENV,
        ...LOCAL_CONTEXT,
        fetcher,
      }),
    ).resolves.toEqual({ items: ["rAccount"] });

    const [input, init] = fetcher.mock.calls[0]!;
    expect(String(input)).toBe("http://127.0.0.1:8793/kv/rest/v1/lists");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("local-fixture-api-key");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it.each([
    [{ ...LOCAL_ENV, EXEC_NETWORK: "mainnet" as const }],
    [{ ...LOCAL_ENV, HARBOR_LOCAL_DEV: "false" }],
    [{ ...LOCAL_ENV, QN_API_BASE: "https://attacker.example" }],
  ])("rejects unsafe API base overrides", async (env) => {
    const fetcher = vi.fn();
    await expect(
      qnRest("GET", "/kv/rest/v1/lists/accounts", undefined, { env, ...LOCAL_CONTEXT, fetcher }),
    ).rejects.toBeInstanceOf(QuickNodeError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects paths outside known QuickNode REST namespaces", async () => {
    await expect(
      qnRest("GET", "https://attacker.example/collect", undefined, { env: LOCAL_ENV, ...LOCAL_CONTEXT }),
    ).rejects.toMatchObject({ code: "QN_INVALID_REQUEST" });
  });

  it.each([
    "/kv/rest/v1/../secrets",
    "/kv/rest/v1/%2e%2e/secrets",
    "/kv/rest/v1/%2E%2E/secrets",
    "/kv/rest/v1/%2e%2e%2fsecrets",
  ])("rejects normalized path escapes: %s", async (path) => {
    const fetcher = vi.fn();
    await expect(
      qnRest("GET", path, undefined, { env: LOCAL_ENV, ...LOCAL_CONTEXT, fetcher }),
    ).rejects.toMatchObject({ code: "QN_INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires independent local-runtime and local-request evidence for overrides", async () => {
    expect(() => validateQuickNodeStartup(LOCAL_ENV, { runtimeLocal: false })).toThrowError(
      expect.objectContaining({ code: "QN_API_BASE_FORBIDDEN" }),
    );
    expect(() => validateQuickNodeStartup(LOCAL_ENV, { runtimeLocal: true })).not.toThrow();
    expect(() => validateQuickNodeStartup({}, { runtimeLocal: false })).not.toThrow();

    const fetcher = vi.fn();
    await expect(qnRest("GET", "/kv/rest/v1/lists/accounts", undefined, {
      env: LOCAL_ENV,
      runtimeLocal: true,
      requestLocal: false,
      fetcher,
    })).rejects.toMatchObject({ code: "QN_API_BASE_FORBIDDEN" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes upstream and transport errors without retaining secrets or bodies", async () => {
    const secretBody = { material: "must-not-escape" };
    const upstream = vi.fn().mockResolvedValue(
      Response.json({ message: "echoed-local-fixture-api-key" }, { status: 400 }),
    );
    const error = await qnRest("POST", "/values/rest/v1", secretBody, {
      env: LOCAL_ENV,
      ...LOCAL_CONTEXT,
      fetcher: upstream,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "QN_INVALID_REQUEST" });

    const validUpstream = vi.fn().mockResolvedValue(
      Response.json({ message: "echoed-local-fixture-api-key" }, { status: 400 }),
    );
    const httpError = await qnRest("POST", "/kv/rest/v1/values", secretBody, {
      env: LOCAL_ENV,
      ...LOCAL_CONTEXT,
      fetcher: validUpstream,
    }).catch((caught: unknown) => caught);
    expect(httpError).toMatchObject({ code: "QN_HTTP_400", retryable: false });
    expect(JSON.stringify(httpError)).not.toContain("must-not-escape");
    expect(JSON.stringify(httpError)).not.toContain("local-fixture-api-key");

    const transport = await qnRest("GET", "/kv/rest/v1/lists/accounts", undefined, {
      env: LOCAL_ENV,
      ...LOCAL_CONTEXT,
      fetcher: vi.fn().mockRejectedValue(new Error("token and body echoed")),
    }).catch((caught: unknown) => caught);
    expect(transport).toMatchObject({ code: "QN_TRANSPORT_ERROR", retryable: true });
    expect(JSON.stringify(transport)).not.toContain("token and body echoed");
  });

  it("handles no-content responses and requires an explicit API key", async () => {
    await expect(
      qnRest("DELETE", "/kv/rest/v1/lists/accounts", undefined, {
        env: LOCAL_ENV,
        ...LOCAL_CONTEXT,
        fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      }),
    ).resolves.toBeNull();

    await expect(
      qnRest("GET", "/kv/rest/v1/lists/accounts", undefined, {
        env: { ...LOCAL_ENV, QN_API_KEY: undefined },
        ...LOCAL_CONTEXT,
      }),
    ).rejects.toMatchObject({ code: "QN_API_KEY_MISSING" });
  });
});
