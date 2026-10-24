import { describe, expect, it } from "vitest";

import { sealWalletSession, WALLET_SESSION_COOKIE } from "../../../../../lib/wallet-session";

import {
  BacktestQuotaError,
  InMemoryBacktestExternalReadQuota,
  resolveAuthenticatedBacktestScope,
  type BacktestAccessScope,
} from "./access-control";

const SECRET = "backtest-access-test-secret-with-at-least-thirty-two-characters";
const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER_OWNER = "r3vi7mWxru9rJCxETCyA1CHvzL96eZWx5z";
const ENVIRONMENT = {
  SESSION_SECRET: SECRET,
  PILOT_DEPLOYMENT_PROFILE: "hosted",
  PILOT_PUBLIC_ORIGIN: "https://pilot.example",
} as const;

function request(account = OWNER): Request {
  const cookie = sealWalletSession({
    version: 1,
    account,
    network: "testnet",
    expiresAt: Date.now() + 60_000,
  }, SECRET);
  return new Request("https://pilot.example/api/research/backtests/run", {
    headers: {
      cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(cookie)}`,
      origin: "https://pilot.example",
      "sec-fetch-site": "same-origin",
    },
  });
}

function scope(account: string, session: string): BacktestAccessScope {
  return { accountScopeId: account, sessionScopeId: session, network: "testnet", sessionExpiresAt: 60_000 };
}

describe("authenticated backtest access", () => {
  it("derives opaque account and exact-session scopes without exposing the wallet", () => {
    const first = resolveAuthenticatedBacktestScope(request(), ENVIRONMENT);
    const replacement = resolveAuthenticatedBacktestScope(request(), ENVIRONMENT);
    const other = resolveAuthenticatedBacktestScope(request(OTHER_OWNER), ENVIRONMENT);
    expect(first).not.toBeNull();
    expect(first?.accountScopeId).toMatch(/^[a-f0-9]{64}$/);
    expect(first?.sessionScopeId).toMatch(/^[a-f0-9]{64}$/);
    expect(first?.accountScopeId).not.toContain(OWNER);
    expect(first?.accountScopeId).toBe(replacement?.accountScopeId);
    expect(first?.sessionScopeId).not.toBe(replacement?.sessionScopeId);
    expect(first?.accountScopeId).not.toBe(other?.accountScopeId);
  });

  it("treats missing, tampered, expired, and misconfigured sessions as signed out", () => {
    expect(resolveAuthenticatedBacktestScope(new Request("https://pilot.example", {
      headers: { origin: "https://pilot.example", "sec-fetch-site": "same-origin" },
    }), ENVIRONMENT)).toBeNull();
    expect(resolveAuthenticatedBacktestScope(new Request("https://pilot.example", {
      headers: {
        cookie: `${WALLET_SESSION_COOKIE}=tampered`,
        origin: "https://pilot.example",
        "sec-fetch-site": "same-origin",
      },
    }), ENVIRONMENT)).toBeNull();
    const expired = sealWalletSession({
      version: 1,
      account: OWNER,
      network: "testnet",
      expiresAt: 1,
    }, SECRET);
    expect(resolveAuthenticatedBacktestScope(new Request("https://pilot.example", {
      headers: {
        cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(expired)}`,
        origin: "https://pilot.example",
        "sec-fetch-site": "same-origin",
      },
    }), ENVIRONMENT)).toBeNull();
    expect(resolveAuthenticatedBacktestScope(request(), {})).toBeNull();
  });

  it("rejects missing or sibling-origin browser metadata even with a valid wallet cookie", () => {
    const validCookie = request().headers.get("cookie")!;
    expect(resolveAuthenticatedBacktestScope(new Request("https://pilot.example/api/research/backtests/run", {
      headers: { cookie: validCookie },
    }), ENVIRONMENT)).toBeNull();
    expect(resolveAuthenticatedBacktestScope(new Request("https://pilot.example/api/research/backtests/run", {
      headers: {
        cookie: validCookie,
        origin: "https://sibling.example",
        "sec-fetch-site": "same-site",
      },
    }), ENVIRONMENT)).toBeNull();
  });
});

describe("bounded backtest external-read quota", () => {
  it("enforces the session cap synchronously", () => {
    const quota = new InMemoryBacktestExternalReadQuota(4, 2, 1_000, 10);
    const current = scope("account-a", "session-a");
    quota.reserve(current, 100);
    quota.reserve(current, 100);
    expect(() => quota.reserve(current, 100)).toThrowError(BacktestQuotaError);
  });

  it("shares the account cap across replacement sessions but isolates accounts", () => {
    const quota = new InMemoryBacktestExternalReadQuota(2, 2, 1_000, 10);
    quota.reserve(scope("account-a", "session-a"), 100);
    quota.reserve(scope("account-a", "session-b"), 100);
    expect(() => quota.reserve(scope("account-a", "session-c"), 100)).toThrow(/exhausted/i);
    expect(() => quota.reserve(scope("account-b", "session-d"), 100)).not.toThrow();
  });

  it("fails closed when scope state is saturated and recovers after the window", () => {
    const quota = new InMemoryBacktestExternalReadQuota(2, 2, 100, 2);
    quota.reserve(scope("account-a", "session-a"), 100);
    expect(() => quota.reserve(scope("account-b", "session-b"), 100)).toThrow(/saturated/i);
    expect(() => quota.reserve(scope("account-b", "session-b"), 200)).not.toThrow();
  });
});
