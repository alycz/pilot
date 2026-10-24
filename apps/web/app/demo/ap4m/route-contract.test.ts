import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as revokeRoute from "./revoke/route";
import * as rogueRoute from "./rogue/route";
import * as settleRoute from "./settle/route";

const routes = [
  ["/demo/ap4m/settle", settleRoute],
  ["/demo/ap4m/revoke", revokeRoute],
  ["/demo/ap4m/rogue", rogueRoute],
] as const;

describe("MP6 action route contract", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("EXEC_NETWORK", "testnet");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(routes)("exposes only a POST action at %s", async (path, route) => {
    expect(route.POST).toBeTypeOf("function");
    expect("GET" in route).toBe(false);
    expect("PUT" in route).toBe(false);
    expect("PATCH" in route).toBe(false);
    expect("DELETE" in route).toBe(false);

    const response = await route.POST(
      new Request(`http://localhost${path}`, {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      evidence: {
        source: "offline-injected",
        network: "testnet",
        submitted: false,
        verified_live: false,
        tx_hash: null,
      },
    });
  });

  it.each(routes)("rejects request fields at %s", async (path, route) => {
    const response = await route.POST(
      new Request(`http://localhost${path}`, {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "AP4M_DEMO_ACTION_BODY_FORBIDDEN" },
    });
  });

  it("uses MO2's merged offline rogue evidence helper", async () => {
    const response = await rogueRoute.POST(
      new Request("http://localhost/demo/ap4m/rogue", { method: "POST" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      evidence: {
        schema: "ap4m_rogue_v1",
        source: "offline-injected",
        outcome: "rejected",
        engine_result: "tecNO_PERMISSION",
        tx_hash: null,
        rogue_address: null,
        submitted: false,
        verified_live: false,
        label: "Mock-only safety evidence · LIVE Testnet check pending",
      },
    });
  });
});
