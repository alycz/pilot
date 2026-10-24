import { describe, expect, it } from "vitest";

import {
  isPersonalizationFixtureBrowserRequest,
  PERSONALIZATION_FIXTURE_COOKIE,
  PERSONALIZATION_FIXTURE_OWNER,
  readPersonalizationFixtureSession,
  resolvePersonalizationFixtureScope,
  sealPersonalizationFixtureSession,
} from "./personalization-fixture-session";

const ENVIRONMENT = {
  NODE_ENV: "test",
  HARBOR_MOCK: "1",
  EXEC_NETWORK: "testnet",
  PILOT_DEPLOYMENT_PROFILE: "local-wallet",
  PILOT_STRUCTURED_PREFERENCES: "1",
  PILOT_PERSONALIZATION_FIXTURE: "1",
  PILOT_PERSONALIZATION_TENANT_ID: "fixture-tenant",
  PILOT_PERSONALIZATION_STATE_DIR: "/tmp/pilot-fixture-personalization-test",
  SESSION_SECRET: "fixture-personalization-session-secret-long-enough",
} as const;

function request(token: string): Request {
  return new Request("http://127.0.0.1:3003/api/vault/preferences/structured", {
    headers: { cookie: `${PERSONALIZATION_FIXTURE_COOKIE}=${token}` },
  });
}

function browserRequest(origin: string, internalOrigin = origin): Request {
  const url = new URL("/api/dev/personalization-session", internalOrigin);
  const publicUrl = new URL(origin);
  return new Request(url, {
    method: "POST",
    headers: {
      host: publicUrl.host,
      origin,
      "sec-fetch-site": "same-origin",
    },
  });
}

describe("personalization fixture cookie", () => {
  it("binds the signed cookie to the fixed configured scope and expiry", () => {
    const scope = resolvePersonalizationFixtureScope(ENVIRONMENT)!;
    const sealed = sealPersonalizationFixtureSession(scope, {
      environment: ENVIRONMENT,
      now: 1_000,
    });
    expect(readPersonalizationFixtureSession(request(sealed.token), {
      environment: ENVIRONMENT,
      now: 2_000,
    })).toEqual({
      owner: PERSONALIZATION_FIXTURE_OWNER,
      network: "testnet",
      expiresAt: sealed.expiresAt,
    });
    expect(readPersonalizationFixtureSession(request(`${sealed.token}x`), {
      environment: ENVIRONMENT,
      now: 2_000,
    })).toBeUndefined();
    expect(readPersonalizationFixtureSession(request(sealed.token), {
      environment: ENVIRONMENT,
      now: sealed.expiresAt,
    })).toBeUndefined();
  });

  it("cannot be opened when the exact fixture gate is no longer active", () => {
    const scope = resolvePersonalizationFixtureScope(ENVIRONMENT)!;
    const sealed = sealPersonalizationFixtureSession(scope, { environment: ENVIRONMENT });
    expect(readPersonalizationFixtureSession(request(sealed.token), {
      environment: { ...ENVIRONMENT, NODE_ENV: "production" },
    })).toBeUndefined();
    expect(readPersonalizationFixtureSession(request(sealed.token), {
      environment: { ...ENVIRONMENT, HARBOR_MOCK: "0" },
    })).toBeUndefined();
  });

  it("binds browser authorization to one strict configured loopback origin", () => {
    const origin = "http://127.0.0.1:3016";
    const environment = {
      ...ENVIRONMENT,
      PILOT_PERSONALIZATION_FIXTURE_ORIGIN: origin,
    };
    expect(isPersonalizationFixtureBrowserRequest(
      browserRequest(origin),
      environment,
    )).toBe(true);
    expect(isPersonalizationFixtureBrowserRequest(
      browserRequest(origin, "http://localhost:3016"),
      environment,
    )).toBe(true);
    expect(isPersonalizationFixtureBrowserRequest(
      browserRequest("http://127.0.0.1:3017"),
      environment,
    )).toBe(false);

    for (const invalidOrigin of [
      "http://localhost:3016",
      "http://127.0.0.2:3016",
      "https://127.0.0.1:3016",
      "http://127.0.0.1:3016/chat",
      "http://127.0.0.1",
    ]) {
      expect(resolvePersonalizationFixtureScope({
        ...ENVIRONMENT,
        PILOT_PERSONALIZATION_FIXTURE_ORIGIN: invalidOrigin,
      })).toBeUndefined();
    }
  });
});
