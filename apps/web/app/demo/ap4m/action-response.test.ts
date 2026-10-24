import { describe, expect, it, vi } from "vitest";

import { createDemoActionHandler } from "./action-response";

const NOW = new Date("2026-10-21T21:20:00.000Z");

function request(path: string, body?: string) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    ...(body === undefined ? {} : { body }),
  });
}

describe("MP6 dev-only action routes", () => {
  it.each([
    ["settle", "ap4m_settle_preview_v1", "previewed"],
    ["revoke", "ap4m_revoke_preview_v1", "previewed"],
    ["rogue", "ap4m_rogue_v1", "rejected"],
  ] as const)("returns public mock-only %s evidence without side effects", async (action, schema, outcome) => {
    const handler = createDemoActionHandler(action, {
      env: { NODE_ENV: "test", EXEC_NETWORK: "testnet" },
      now: () => NOW,
    });
    const response = await handler(request(`/demo/ap4m/${action}`));
    const value = await response.json();

    expect(response.status).toBe(200);
    expect(value).toMatchObject({
      ok: true,
      evidence: {
        schema,
        source: "offline-injected",
        network: "testnet",
        outcome,
        tx_hash: null,
        submitted: false,
        verified_live: false,
        at: NOW.toISOString(),
      },
    });
    expect(JSON.stringify(value)).not.toMatch(/seed|private[_ -]?key|secret/i);
  });

  it("is hidden in production and outside Testnet", async () => {
    const production = createDemoActionHandler("rogue", {
      env: { NODE_ENV: "production", EXEC_NETWORK: "testnet" },
    });
    const wrongNetwork = createDemoActionHandler("rogue", {
      env: { NODE_ENV: "test", EXEC_NETWORK: "mainnet" },
    });

    await expect(production(request("/demo/ap4m/rogue")).then((response) => response.status))
      .resolves.toBe(404);
    await expect(wrongNetwork(request("/demo/ap4m/rogue")).then((response) => response.status))
      .resolves.toBe(404);
  });

  it.each([
    [{ EXEC_NETWORK: "testnet" }, "missing mode"],
    [{ NODE_ENV: "preview", EXEC_NETWORK: "testnet" }, "unknown mode"],
    [{ NODE_ENV: "development" }, "missing network"],
    [{ NODE_ENV: "development", EXEC_NETWORK: "testnett" }, "unknown network"],
  ] as const)("fails closed for %s (%s)", async (env, _label) => {
    const handler = createDemoActionHandler("rogue", { env });
    const response = await handler(request("/demo/ap4m/rogue"));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("rejects request fields before any action", async () => {
    const handler = createDemoActionHandler("settle", {
      env: { NODE_ENV: "test", EXEC_NETWORK: "testnet" },
      now: vi.fn(() => NOW),
    });
    const response = await handler(request("/demo/ap4m/settle", "{}"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "AP4M_DEMO_ACTION_BODY_FORBIDDEN" },
    });

    const queryResponse = await handler(request("/demo/ap4m/settle?live=1"));
    expect(queryResponse.status).toBe(400);
    await expect(queryResponse.json()).resolves.toEqual({
      ok: false,
      error: { code: "AP4M_DEMO_ACTION_QUERY_FORBIDDEN" },
    });
  });

  it("accepts a runtime-normalized empty POST stream", async () => {
    const handler = createDemoActionHandler("settle", {
      env: { NODE_ENV: "development", EXEC_NETWORK: "testnet" },
      now: () => NOW,
    });
    const response = await handler(new Request("http://localhost/demo/ap4m/settle", {
      method: "POST",
      body: "",
      headers: { "content-length": "0" },
    }));

    expect(response.status).toBe(200);
  });
});
