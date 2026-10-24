import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readWalletSession,
  WALLET_SESSION_COOKIE,
  WALLET_SUBMISSIONS_COOKIE,
} from "../../../../lib/wallet-session";
import {
  PERSONALIZATION_FIXTURE_COOKIE,
  PERSONALIZATION_FIXTURE_OWNER,
  resolvePersonalizationFixtureScope,
} from "../../../../lib/personalization-fixture-session";
import { assertPreferenceAcceptanceAuthorized } from "../../vault/_lib/http";
import { GET, POST } from "./route";

const SECRET = "fixture-personalization-session-secret-long-enough";
const mocks = vi.hoisted(() => ({
  ensureScopedProfile: vi.fn(),
}));

vi.mock("../../vault/_lib/service", () => ({
  getVaultService: () => ({ ensureScopedProfile: mocks.ensureScopedProfile }),
}));

function request(method: "GET" | "POST", cookie?: string, origin = "http://127.0.0.1:3004") {
  return new NextRequest("http://127.0.0.1:3004/api/dev/personalization-session", {
    method,
    headers: {
      host: "127.0.0.1:3004",
      origin,
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie } : {}),
    },
    ...(method === "POST" ? {
      body: JSON.stringify({
        owner: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        network: "devnet",
      }),
      headers: {
        host: "127.0.0.1:3004",
        origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
    } : {}),
  });
}

beforeEach(() => {
  mocks.ensureScopedProfile.mockReset();
  mocks.ensureScopedProfile.mockResolvedValue({
    main_account: PERSONALIZATION_FIXTURE_OWNER,
    budget_account: PERSONALIZATION_FIXTURE_OWNER,
    network: "testnet",
    risk: "low",
    preferences: [],
  });
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HARBOR_MOCK", "1");
  vi.stubEnv("EXEC_NETWORK", "testnet");
  vi.stubEnv("PILOT_STRUCTURED_PREFERENCES", "1");
  vi.stubEnv("PILOT_PERSONALIZATION_FIXTURE", "1");
  vi.stubEnv("PILOT_PERSONALIZATION_TENANT_ID", "fixture-tenant");
  vi.stubEnv("PILOT_PERSONALIZATION_STATE_DIR", "/tmp/pilot-fixture-personalization-test");
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("PILOT_DEPLOYMENT_PROFILE", "local-wallet");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("development personalization fixture session", () => {
  it("derives one fixed server-owned scope and never accepts body-selected identity", async () => {
    expect(resolvePersonalizationFixtureScope()).toEqual({
      owner: PERSONALIZATION_FIXTURE_OWNER,
      network: "testnet",
    });
    const response = await POST(request("POST"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      enabled: true,
      authenticated: true,
      account: PERSONALIZATION_FIXTURE_OWNER,
      network: "testnet",
    });
    const session = response.cookies.get(PERSONALIZATION_FIXTURE_COOKIE)?.value;
    expect(session).toBeTruthy();
    expect(response.cookies.get(WALLET_SESSION_COOKIE)?.value).toBe("");
    expect(response.cookies.get(WALLET_SUBMISSIONS_COOKIE)?.value).toBe("");
    expect(mocks.ensureScopedProfile).toHaveBeenCalledWith(
      {
        owner: PERSONALIZATION_FIXTURE_OWNER,
        network: "testnet",
        mainAccount: PERSONALIZATION_FIXTURE_OWNER,
      },
      {
        main_account: PERSONALIZATION_FIXTURE_OWNER,
        budget_account: PERSONALIZATION_FIXTURE_OWNER,
        network: "testnet",
        risk: "low",
        preferences: [],
      },
    );

    const fixtureCookie = `${PERSONALIZATION_FIXTURE_COOKIE}=${session}`;
    const status = GET(request("GET", fixtureCookie));
    await expect(status.json()).resolves.toMatchObject({
      enabled: true,
      authenticated: true,
      account: PERSONALIZATION_FIXTURE_OWNER,
      network: "testnet",
    });

    const unrelated = new Request("http://127.0.0.1:3003/api/auth/wallet/session", {
      headers: { cookie: fixtureCookie },
    });
    expect(readWalletSession(unrelated)).toBeNull();

    const personalizationRequest = (pathname: string) => new Request(
      `http://127.0.0.1:3004${pathname}`,
      {
        method: "POST",
        headers: {
          host: "127.0.0.1:3004",
          cookie: fixtureCookie,
          origin: "http://127.0.0.1:3004",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "list" }),
      },
    );
    expect(assertPreferenceAcceptanceAuthorized(
      personalizationRequest("/api/vault/preferences/structured"),
    )).toEqual({ owner: PERSONALIZATION_FIXTURE_OWNER, network: "testnet" });
    expect(assertPreferenceAcceptanceAuthorized(
      personalizationRequest("/api/vault/lessons"),
    )).toEqual({ owner: PERSONALIZATION_FIXTURE_OWNER, network: "testnet" });
    expect(() => assertPreferenceAcceptanceAuthorized(
      personalizationRequest("/api/vault/preferences/accept"),
    )).toThrow(/authorization failed/i);
  });

  it("fails closed in production, hosted, live-Harbor, and unconfigured modes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(resolvePersonalizationFixtureScope()).toBeUndefined();
    expect(GET(request("GET")).status).toBe(404);

    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PILOT_DEPLOYMENT_PROFILE", "hosted");
    expect(resolvePersonalizationFixtureScope()).toBeUndefined();

    vi.stubEnv("PILOT_DEPLOYMENT_PROFILE", "local-wallet");
    vi.stubEnv("HARBOR_MOCK", "0");
    expect(resolvePersonalizationFixtureScope()).toBeUndefined();

    vi.stubEnv("HARBOR_MOCK", "1");
    vi.stubEnv("PILOT_PERSONALIZATION_FIXTURE", "0");
    expect((await POST(request("POST"))).status).toBe(404);

    vi.stubEnv("PILOT_PERSONALIZATION_FIXTURE", "1");
    vi.stubEnv("SESSION_SECRET", "too-short");
    expect(resolvePersonalizationFixtureScope()).toBeUndefined();
    expect((await POST(request("POST"))).status).toBe(404);
  });

  it("requires an exact same-origin browser request before issuing a cookie", async () => {
    const response = await POST(request("POST", undefined, "https://attacker.invalid"));
    expect(response.status).toBe(403);
    expect(response.cookies.get(PERSONALIZATION_FIXTURE_COOKIE)).toBeUndefined();
    expect(mocks.ensureScopedProfile).not.toHaveBeenCalled();
  });

  it("does not issue a fixture cookie when its private scoped profile cannot be initialized", async () => {
    mocks.ensureScopedProfile.mockRejectedValueOnce(new Error("storage busy"));
    const response = await POST(request("POST"));
    expect(response.status).toBe(503);
    expect(response.cookies.get(PERSONALIZATION_FIXTURE_COOKIE)).toBeUndefined();
  });
});
