import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OPENROUTER_RETURN_TO_COOKIE,
  OPENROUTER_PENDING_SESSION_COOKIE,
  OPENROUTER_SESSION_COOKIE,
  OPENROUTER_STATE_COOKIE,
  OPENROUTER_VERIFIER_COOKIE,
  OPENROUTER_WALLET_BINDING_COOKIE,
  createPendingOpenRouterSession,
  createOpenRouterSession,
  openPendingOpenRouterSession,
  openOpenRouterSession,
  openRouterAttemptId,
  sealPendingWalletBinding,
  sealPendingOpenRouterSession,
  sealOpenRouterSession,
  walletModelBinding,
} from "../../../../lib/openrouter-session";
import { DemoModelBudget } from "../../../../lib/demo-model-budget";
import {
  WALLET_SESSION_COOKIE,
  sealWalletSession,
  type WalletSession,
} from "../../../../lib/wallet-session";
import { GET as callback } from "./callback/route";
import { GET as models } from "./models/route";
import { POST as finalize } from "./finalize/route";
import {
  DELETE as deleteSession,
  GET as getSession,
  POST as updateSession,
} from "./session/route";
import { GET as start } from "./start/route";

const SECRET = "test-session-secret-that-is-longer-than-thirty-two-characters";
const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

function request(
  url: string,
  options: RequestInit & { cookies?: Record<string, string> } = {},
): NextRequest {
  const { cookies, signal, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  if (cookies) {
    headers.set(
      "Cookie",
      Object.entries(cookies)
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join("; "),
    );
  }
  return new NextRequest(url, {
    ...requestOptions,
    ...(signal ? { signal } : {}),
    headers,
  });
}

function cookieFlags(response: Response): string {
  return response.headers.get("set-cookie") ?? "";
}

function walletFixture(
  overrides: Partial<WalletSession> = {},
): { cookie: string; session: WalletSession } {
  const session: WalletSession = {
    version: 1,
    account: ACCOUNT,
    network: "testnet",
    expiresAt: Date.now() + 60 * 60 * 1_000,
    ...overrides,
  };
  return { cookie: sealWalletSession(session, SECRET), session };
}

function pendingWalletBinding(cookie: string, session: WalletSession): string {
  const bindingRequest = request("https://pilot.example/bind", {
    cookies: { [WALLET_SESSION_COOKIE]: cookie },
  });
  return sealPendingWalletBinding(walletModelBinding(bindingRequest, session)!, SECRET);
}

function useHarborDemoBackend(): void {
  process.env.DEMO_MODEL_QUOTA_BACKEND = "harbor-d1";
  process.env.DEMO_MODEL_QUOTA_POLICY_VERSION = "demo-policy-v1";
  process.env.HARBOR_URL = "https://harbor.example";
  process.env.HARBOR_API_KEY = "pilot:synthetic-harbor-token";
  delete process.env.DEMO_MODEL_STATE_DIR;
}

function harborDemoStatusResponse(overrides: Record<string, unknown> = {}): Response {
  const response = Response.json({
    ok: true,
    status: {
      available: true,
      policyVersion: "demo-policy-v1",
      costPolicy: "free-only",
      allowedModels: ["provider/free-tools:free", "provider/free:free"],
      globalDailyOutputTokens: 10_000,
      globalDailyRequests: 20,
      walletDailyOutputTokens: 1_000,
      walletDailyRequests: 10,
      rateWindowSeconds: 60,
      rateRequests: 10,
      maxGlobalConcurrency: 1,
      maxWalletConcurrency: 1,
      reservationTtlSeconds: 60,
      abortGraceSeconds: 2,
      maxInputBytes: 4_096,
      maxOutputTokens: 256,
      maxSteps: 4,
      ...overrides,
    },
  });
  Object.defineProperty(response, "url", {
    value: "https://harbor.example/internal/demo-model/v1/status",
  });
  return response;
}

describe("OpenRouter OAuth routes", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
    process.env.MODEL_DEFAULT = "provider/default:free";
    process.env.PILOT_DEPLOYMENT_PROFILE = "hosted";
    process.env.PILOT_PUBLIC_ORIGIN = "https://pilot.example";
    process.env.NEXT_PUBLIC_DEV_SIGNER = "0";
    process.env.OPENROUTER_ALLOWED_MODELS = "provider/paid-tools";
  });

  it("requires a current wallet session before starting OAuth", async () => {
    const response = await start(
      request("https://pilot.example/api/auth/openrouter/start"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.get(OPENROUTER_STATE_COOKIE)).toBeUndefined();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SESSION_SECRET;
    delete process.env.MODEL_DEFAULT;
    delete process.env.PILOT_DEPLOYMENT_PROFILE;
    delete process.env.PILOT_PUBLIC_ORIGIN;
    delete process.env.NEXT_PUBLIC_DEV_SIGNER;
    delete process.env.OPENROUTER_ALLOWED_MODELS;
  });

  it("starts PKCE S256 with server-held secure cookies", async () => {
    const wallet = walletFixture();
    const response = await start(
      request("http://next-internal:3000/api/auth/openrouter/start?returnTo=/settings", {
        headers: {
          forwarded: "for=203.0.113.7;proto=http;host=attacker.example",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
        },
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      }),
    );
    const redirect = new URL(response.headers.get("location")!);
    const callbackUrl = new URL(redirect.searchParams.get("callback_url")!);
    const state = response.cookies.get(OPENROUTER_STATE_COOKIE)?.value;
    const verifier = response.cookies.get(OPENROUTER_VERIFIER_COOKIE)?.value;

    expect(redirect.origin).toBe("https://openrouter.ai");
    expect(redirect.pathname).toBe("/auth");
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    expect(redirect.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier!, "ascii").digest("base64url"),
    );
    expect(callbackUrl.origin).toBe("https://pilot.example");
    expect(callbackUrl.searchParams.has("state")).toBe(false);
    expect(redirect.searchParams.getAll("state")).toEqual([state]);
    expect(response.cookies.get(OPENROUTER_WALLET_BINDING_COOKIE)?.value).toBeTruthy();
    expect(response.cookies.get(OPENROUTER_RETURN_TO_COOKIE)?.value).toBe("/settings");
    expect(response.cookies.get(OPENROUTER_PENDING_SESSION_COOKIE)).toMatchObject({
      value: "",
      maxAge: 0,
    });
    expect(cookieFlags(response)).toMatch(/HttpOnly/i);
    expect(cookieFlags(response)).toMatch(/Secure/i);
    expect(cookieFlags(response)).toMatch(/SameSite=lax/i);
  });

  it.each([
    String.raw`/\attacker.example/steal`,
    String.raw`/\\attacker.example/steal`,
    "/%5cattacker.example/steal",
    "//pilot.example@attacker.example/steal",
  ])("rejects an unsafe returnTo value %j before storing it", async (returnTo) => {
    const wallet = walletFixture();
    const url = new URL("https://pilot.example/api/auth/openrouter/start");
    url.searchParams.set("returnTo", returnTo);

    const response = await start(request(url.toString(), {
      cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
    }));

    expect(response.cookies.get(OPENROUTER_RETURN_TO_COOKIE)?.value).toBe(
      "/onboarding?openrouter=connected",
    );
  });

  it("exchanges without the Strict wallet cookie, then finalizes from same origin", async () => {
    const wallet = walletFixture();
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        Response.json({ key: "sk-or-user-secret", user_id: "user-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await callback(
      request(
        "http://next-internal:3000/api/auth/openrouter/callback?code=one-time-code&state=expected-state",
        {
          headers: {
            forwarded: "for=203.0.113.7;proto=http;host=attacker.example",
            "x-forwarded-host": "attacker.example",
            "x-forwarded-proto": "http",
          },
          cookies: {
            [OPENROUTER_STATE_COOKIE]: "expected-state",
            [OPENROUTER_VERIFIER_COOKIE]: "pkce-verifier",
            [OPENROUTER_RETURN_TO_COOKIE]: "/settings?connected=1",
            [OPENROUTER_WALLET_BINDING_COOKIE]: pendingWalletBinding(
              wallet.cookie,
              wallet.session,
            ),
          },
        },
      ),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({
      code: "one-time-code",
      code_verifier: "pkce-verifier",
      code_challenge_method: "S256",
    });
    expect(response.headers.get("location")).toBe(
      "https://pilot.example/openrouter/finalize",
    );

    const pendingCookie = response.cookies.get(OPENROUTER_PENDING_SESSION_COOKIE)?.value;
    expect(pendingCookie).not.toContain("sk-or-user-secret");
    expect(openPendingOpenRouterSession(pendingCookie, SECRET)).toMatchObject({
      version: 2,
      attemptId: openRouterAttemptId("expected-state"),
      model: "provider/default:free",
      apiKey: "sk-or-user-secret",
      returnTo: "/settings?connected=1",
      wallet: {
        account: ACCOUNT,
        network: "testnet",
      },
    });
    expect(response.cookies.get(OPENROUTER_SESSION_COOKIE)).toBeUndefined();
    expect(cookieFlags(response)).toMatch(/SameSite=strict/i);

    const finalized = finalize(request(
      "https://pilot.example/api/auth/openrouter/finalize",
      {
        method: "POST",
        headers: { Origin: "https://pilot.example" },
        cookies: {
          [WALLET_SESSION_COOKIE]: wallet.cookie,
          [OPENROUTER_PENDING_SESSION_COOKIE]: pendingCookie!,
          [OPENROUTER_STATE_COOKIE]: "expected-state",
        },
      },
    ));
    expect(await finalized.json()).toEqual({
      connected: true,
      returnTo: "/settings?connected=1",
    });
    expect(openOpenRouterSession(
      finalized.cookies.get(OPENROUTER_SESSION_COOKIE)?.value,
      SECRET,
    )).toMatchObject({
      version: 2,
      mode: "oauth",
      model: "provider/default:free",
      apiKey: "sk-or-user-secret",
      wallet: { account: ACCOUNT, network: "testnet" },
    });
    expect(cookieFlags(finalized)).toMatch(/HttpOnly/i);
    expect(cookieFlags(finalized)).toMatch(/Secure/i);
    expect(cookieFlags(finalized)).toMatch(/SameSite=lax/i);
    expect(cookieFlags(finalized)).toMatch(/Max-Age=0/i);
    const replay = finalize(request(
      "https://pilot.example/api/auth/openrouter/finalize",
      {
        method: "POST",
        headers: { Origin: "https://pilot.example" },
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      },
    ));
    expect(replay.status).toBe(400);
  });

  it.each([
    String.raw`/\attacker.example/steal`,
    "/%5cattacker.example/steal",
    "//pilot.example@attacker.example/steal",
  ])("revalidates an unsafe return cookie %j before redirecting", async (returnTo) => {
    const wallet = walletFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ key: "sk-or-user-secret" })),
    );

    const response = await callback(
      request(
        "https://pilot.example/api/auth/openrouter/callback?code=one-time-code&state=expected-state",
        {
          cookies: {
            [OPENROUTER_STATE_COOKIE]: "expected-state",
            [OPENROUTER_VERIFIER_COOKIE]: "pkce-verifier",
            [OPENROUTER_RETURN_TO_COOKIE]: returnTo,
            [OPENROUTER_WALLET_BINDING_COOKIE]: pendingWalletBinding(
              wallet.cookie,
              wallet.session,
            ),
          },
        },
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://pilot.example/openrouter/finalize",
    );
    expect(openPendingOpenRouterSession(
      response.cookies.get(OPENROUTER_PENDING_SESSION_COOKIE)?.value,
      SECRET,
    )?.returnTo).toBe("/onboarding?openrouter=connected");
  });

  it("rejects mismatched state without calling OpenRouter", async () => {
    const wallet = walletFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await callback(
      request(
        "https://pilot.example/api/auth/openrouter/callback?code=code&state=attacker-state",
        {
          cookies: {
            [WALLET_SESSION_COOKIE]: wallet.cookie,
            [OPENROUTER_STATE_COOKIE]: "expected-state",
            [OPENROUTER_VERIFIER_COOKIE]: "pkce-verifier",
            [OPENROUTER_WALLET_BINDING_COOKIE]: pendingWalletBinding(
              wallet.cookie,
              wallet.session,
            ),
          },
        },
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://pilot.example/onboarding?openrouter=error",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the provider returns an explicit authorization denial", async () => {
    const wallet = walletFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await callback(request(
      "https://pilot.example/api/auth/openrouter/callback?error=access_denied&state=expected-state",
      {
        cookies: {
          [OPENROUTER_STATE_COOKIE]: "expected-state",
          [OPENROUTER_VERIFIER_COOKIE]: "pkce-verifier",
          [OPENROUTER_WALLET_BINDING_COOKIE]: pendingWalletBinding(
            wallet.cookie,
            wallet.session,
          ),
        },
      },
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://pilot.example/onboarding?openrouter=error",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.cookies.get(OPENROUTER_PENDING_SESSION_COOKIE)).toBeUndefined();
    expect(response.cookies.get(OPENROUTER_SESSION_COOKIE)).toBeUndefined();
  });

  it("preserves a newer attempt and pending credential when a stale callback arrives", async () => {
    const wallet = walletFixture();
    const binding = walletModelBinding(request("https://pilot.example/bind", {
      cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
    }), wallet.session)!;
    const pending = sealPendingOpenRouterSession(createPendingOpenRouterSession({
      apiKey: "sk-or-newer-user-secret",
      model: "provider/default:free",
      returnTo: "/onboarding?openrouter=connected",
      attemptId: openRouterAttemptId("newer-state"),
    }, binding), SECRET);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await callback(request(
      "https://pilot.example/api/auth/openrouter/callback?code=stale-code&state=stale-state",
      {
        cookies: {
          [OPENROUTER_STATE_COOKIE]: "newer-state",
          [OPENROUTER_VERIFIER_COOKIE]: "newer-verifier",
          [OPENROUTER_WALLET_BINDING_COOKIE]: sealPendingWalletBinding(binding, SECRET),
          [OPENROUTER_PENDING_SESSION_COOKIE]: pending,
        },
      },
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://pilot.example/onboarding?openrouter=error",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const afterSuccessfulExchange = await callback(request(
      "https://pilot.example/api/auth/openrouter/callback?code=older-code&state=older-state",
      { cookies: { [OPENROUTER_PENDING_SESSION_COOKIE]: pending } },
    ));
    expect(afterSuccessfulExchange.status).toBe(303);
    expect(afterSuccessfulExchange.headers.get("set-cookie")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an older callback response that arrives after a newer start", async () => {
    const wallet = walletFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ key: "sk-or-older-user-secret" })),
    );

    // This request snapshot represents attempt A entering the exchange before
    // the browser receives a newer /start response for attempt B.
    const olderCallback = await callback(request(
      "https://pilot.example/api/auth/openrouter/callback?code=older-code&state=older-state",
      {
        cookies: {
          [OPENROUTER_STATE_COOKIE]: "older-state",
          [OPENROUTER_VERIFIER_COOKIE]: "older-verifier",
          [OPENROUTER_WALLET_BINDING_COOKIE]: pendingWalletBinding(
            wallet.cookie,
            wallet.session,
          ),
        },
      },
    ));
    const olderPending = olderCallback.cookies.get(
      OPENROUTER_PENDING_SESSION_COOKIE,
    )?.value;
    expect(olderPending).toBeTruthy();
    expect(olderCallback.cookies.get(OPENROUTER_STATE_COOKIE)).toBeUndefined();

    // Applying A's response after B may replace only the pending cookie. The
    // newer state cookie remains, so the same-origin finalizer must reject A.
    const staleFinalize = finalize(request(
      "https://pilot.example/api/auth/openrouter/finalize",
      {
        method: "POST",
        headers: { Origin: "https://pilot.example" },
        cookies: {
          [WALLET_SESSION_COOKIE]: wallet.cookie,
          [OPENROUTER_PENDING_SESSION_COOKIE]: olderPending!,
          [OPENROUTER_STATE_COOKIE]: "newer-state",
        },
      },
    ));

    expect(staleFinalize.status).toBe(400);
    expect(staleFinalize.cookies.get(OPENROUTER_SESSION_COOKIE)).toBeUndefined();
    expect(staleFinalize.cookies.get(OPENROUTER_STATE_COOKIE)).toBeUndefined();
    expect(staleFinalize.cookies.get(OPENROUTER_PENDING_SESSION_COOKIE)).toMatchObject({
      value: "",
      maxAge: 0,
    });
  });

  it("rejects an unexpected exchange response URL without mutating attempt cookies", async () => {
    const wallet = walletFixture();
    const redirected = Response.json({ key: "sk-or-user-secret" });
    Object.defineProperty(redirected, "url", {
      configurable: true,
      value: "https://unexpected.example/api/v1/auth/keys",
    });
    vi.stubGlobal("fetch", vi.fn(async () => redirected));

    const response = await callback(request(
      "https://pilot.example/api/auth/openrouter/callback?code=code&state=expected",
      {
        cookies: {
          [OPENROUTER_STATE_COOKIE]: "expected",
          [OPENROUTER_VERIFIER_COOKIE]: "verifier",
          [OPENROUTER_WALLET_BINDING_COOKIE]: pendingWalletBinding(
            wallet.cookie,
            wallet.session,
          ),
        },
      },
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://pilot.example/onboarding?openrouter=error",
    );
    expect(response.cookies.get(OPENROUTER_STATE_COOKIE)).toBeUndefined();
    expect(response.cookies.get(OPENROUTER_PENDING_SESSION_COOKIE)).toBeUndefined();
  });

  it.each([
    {
      name: "the exchange request throws",
      exchange: async () => {
        throw new TypeError("synthetic offline exchange failure");
      },
    },
    {
      name: "the exchange response is non-OK",
      exchange: async () => Response.json({ error: "invalid code" }, { status: 401 }),
    },
    {
      name: "the exchange response contains malformed JSON",
      exchange: async () => new Response("{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    },
    {
      name: "the exchange response omits the API key",
      exchange: async () => Response.json({ user_id: "user-1" }),
    },
    {
      name: "the exchange response contains a short API key",
      exchange: async () => Response.json({ key: "too-short" }),
    },
  ])("fails closed when $name", async ({ exchange }) => {
    const wallet = walletFixture();
    const fetchMock = vi.fn(exchange);
    vi.stubGlobal("fetch", fetchMock);

    const response = await callback(request(
      "https://pilot.example/api/auth/openrouter/callback?code=code&state=expected",
      {
        cookies: {
          [OPENROUTER_STATE_COOKIE]: "expected",
          [OPENROUTER_VERIFIER_COOKIE]: "verifier",
          [OPENROUTER_WALLET_BINDING_COOKIE]: pendingWalletBinding(
            wallet.cookie,
            wallet.session,
          ),
        },
      },
    ));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://pilot.example/onboarding?openrouter=error",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.cookies.get(OPENROUTER_PENDING_SESSION_COOKIE)).toBeUndefined();
    expect(response.cookies.get(OPENROUTER_SESSION_COOKIE)).toBeUndefined();
  });

  it("rejects finalization after the wallet session cookie changes", async () => {
    const original = walletFixture();
    const replacement = walletFixture({ expiresAt: original.session.expiresAt - 1_000 });
    const originalBinding = walletModelBinding(request("https://pilot.example/bind", {
      cookies: { [WALLET_SESSION_COOKIE]: original.cookie },
    }), original.session)!;
    const pending = sealPendingOpenRouterSession(createPendingOpenRouterSession({
      apiKey: "sk-or-user-secret",
      model: "provider/default:free",
      returnTo: "/onboarding?openrouter=connected",
      attemptId: openRouterAttemptId("expected-state"),
    }, originalBinding), SECRET);

    const response = finalize(request(
      "https://pilot.example/api/auth/openrouter/finalize",
      {
        method: "POST",
        headers: { Origin: "https://pilot.example" },
        cookies: {
          [WALLET_SESSION_COOKIE]: replacement.cookie,
          [OPENROUTER_PENDING_SESSION_COOKIE]: pending,
          [OPENROUTER_STATE_COOKIE]: "expected-state",
        },
      },
    ));

    expect(response.status).toBe(400);
    expect(cookieFlags(response)).toMatch(/Max-Age=0/i);
  });

  it("requires exact origin and a fresh pending credential for finalization", async () => {
    const wallet = walletFixture();
    const missingPending = finalize(request(
      "https://pilot.example/api/auth/openrouter/finalize",
      {
        method: "POST",
        headers: { Origin: "https://pilot.example" },
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      },
    ));
    expect(missingPending.status).toBe(400);

    const wrongOrigin = finalize(request(
      "https://pilot.example/api/auth/openrouter/finalize",
      {
        method: "POST",
        headers: { Origin: "https://attacker.example" },
      },
    ));
    expect(wrongOrigin.status).toBe(403);
  });

  it("finalizes idempotently when the exact wallet-bound OAuth session already exists", async () => {
    const wallet = walletFixture();
    const binding = walletModelBinding(request("https://pilot.example/bind", {
      cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
    }), wallet.session)!;
    const established = sealOpenRouterSession(createOpenRouterSession({
      mode: "oauth",
      apiKey: "sk-or-established-user-secret",
      model: "provider/default:free",
    }, binding), SECRET);

    const response = finalize(request(
      "https://pilot.example/api/auth/openrouter/finalize",
      {
        method: "POST",
        headers: { Origin: "https://pilot.example" },
        cookies: {
          [WALLET_SESSION_COOKIE]: wallet.cookie,
          [OPENROUTER_SESSION_COOKIE]: established,
        },
      },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connected: true,
      returnTo: "/onboarding?openrouter=connected",
    });
    expect(response.cookies.get(OPENROUTER_SESSION_COOKIE)).toBeUndefined();
    expect(response.cookies.get(OPENROUTER_PENDING_SESSION_COOKIE)).toMatchObject({
      value: "",
      maxAge: 0,
    });
  });

  it("rejects an expired pending credential during same-origin finalization", () => {
    const wallet = walletFixture();
    const binding = walletModelBinding(request("https://pilot.example/bind", {
      cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
    }), wallet.session)!;
    const pending = sealPendingOpenRouterSession(createPendingOpenRouterSession({
      apiKey: "sk-or-user-secret",
      model: "provider/default:free",
      returnTo: "/onboarding?openrouter=connected",
      attemptId: openRouterAttemptId("expected-state"),
    }, binding, Date.now() - 6 * 60 * 1_000), SECRET);

    const response = finalize(request(
      "https://pilot.example/api/auth/openrouter/finalize",
      {
        method: "POST",
        headers: { Origin: "https://pilot.example" },
        cookies: {
          [WALLET_SESSION_COOKIE]: wallet.cookie,
          [OPENROUTER_PENDING_SESSION_COOKIE]: pending,
          [OPENROUTER_STATE_COOKIE]: "expected-state",
        },
      },
    ));
    expect(response.status).toBe(400);
    expect(cookieFlags(response)).toMatch(/Max-Age=0/i);
  });

  it("rejects control characters in an exchanged API key", async () => {
    const wallet = walletFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ key: "sk-or-valid-prefix\r\ninjected" })),
    );
    const response = await callback(request(
      "https://pilot.example/api/auth/openrouter/callback?code=code&state=expected",
      {
        cookies: {
          [WALLET_SESSION_COOKIE]: wallet.cookie,
          [OPENROUTER_STATE_COOKIE]: "expected",
          [OPENROUTER_VERIFIER_COOKIE]: "verifier",
          [OPENROUTER_WALLET_BINDING_COOKIE]: pendingWalletBinding(
            wallet.cookie,
            wallet.session,
          ),
        },
      },
    ));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://pilot.example/onboarding?openrouter=error",
    );
    expect(response.cookies.get(OPENROUTER_SESSION_COOKIE)).toBeUndefined();
  });

  it.each([undefined, "http://pilot.example", "https://localhost."])(
    "fails closed for unsafe hosted public origin %s before redirect or exchange",
    async (publicOrigin) => {
      if (publicOrigin === undefined) delete process.env.PILOT_PUBLIC_ORIGIN;
      else process.env.PILOT_PUBLIC_ORIGIN = publicOrigin;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const startResponse = await start(
        request("http://next-internal:3000/api/auth/openrouter/start"),
      );
      const callbackResponse = await callback(request(
        "http://next-internal:3000/api/auth/openrouter/callback?code=code&state=expected",
        {
          cookies: {
            [OPENROUTER_STATE_COOKIE]: "expected",
            [OPENROUTER_VERIFIER_COOKIE]: "verifier",
          },
        },
      ));

      expect(startResponse.status).toBe(403);
      expect(callbackResponse.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("model and session routes", () => {
  let demoStateDirectory: string;

  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
    process.env.MODEL_DEFAULT = "provider/free-tools:free";
    process.env.PILOT_DEPLOYMENT_PROFILE = "hosted";
    process.env.PILOT_PUBLIC_ORIGIN = "https://pilot.example";
    process.env.NEXT_PUBLIC_DEV_SIGNER = "0";
    process.env.OPENROUTER_ALLOWED_MODELS = "provider/paid-tools,provider/new";
    demoStateDirectory = mkdtempSync(join(tmpdir(), "pilot-demo-route-test-"));
    chmodSync(demoStateDirectory, 0o700);
    process.env.DEMO_MODEL_ENABLED = "1";
    process.env.DEMO_MODEL_QUOTA_BACKEND = "sqlite-single-host";
    process.env.DEMO_MODEL_COST_POLICY = "free-only";
    process.env.DEMO_OPENROUTER_FREE_ONLY_ACCEPTANCE = "verified";
    process.env.DEMO_OPENROUTER_KEY_LIMIT_USD = "0";
    process.env.DEMO_OPENROUTER_INCLUDE_BYOK_IN_LIMIT = "1";
    process.env.DEMO_OPENROUTER_NO_BYOK = "verified";
    process.env.DEMO_OPENROUTER_PAID_ADDONS_DISABLED = "verified";
    process.env.DEMO_MODEL_STATE_DIR = demoStateDirectory;
    process.env.DEMO_MODEL_ALLOWED_MODELS = "provider/free-tools:free,provider/free:free";
    process.env.DEMO_MODEL_GLOBAL_DAILY_OUTPUT_TOKENS = "10000";
    process.env.DEMO_MODEL_GLOBAL_DAILY_REQUESTS = "20";
    process.env.DEMO_MODEL_WALLET_DAILY_OUTPUT_TOKENS = "1000";
    process.env.DEMO_MODEL_WALLET_DAILY_REQUESTS = "10";
    process.env.DEMO_MODEL_RATE_WINDOW_SECONDS = "60";
    process.env.DEMO_MODEL_RATE_REQUESTS = "10";
    process.env.DEMO_MODEL_MAX_GLOBAL_CONCURRENCY = "1";
    process.env.DEMO_MODEL_MAX_WALLET_CONCURRENCY = "1";
    process.env.DEMO_MODEL_RESERVATION_TTL_SECONDS = "60";
    process.env.DEMO_MODEL_ABORT_GRACE_SECONDS = "2";
    process.env.DEMO_MODEL_MAX_INPUT_BYTES = "4096";
    process.env.DEMO_MODEL_MAX_OUTPUT_TOKENS = "256";
    process.env.DEMO_MODEL_MAX_STEPS = "4";
    process.env.DEMO_OPENROUTER_API_KEY = "server-only-test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SESSION_SECRET;
    delete process.env.MODEL_DEFAULT;
    delete process.env.PILOT_DEPLOYMENT_PROFILE;
    delete process.env.PILOT_PUBLIC_ORIGIN;
    delete process.env.NEXT_PUBLIC_DEV_SIGNER;
    delete process.env.OPENROUTER_ALLOWED_MODELS;
    delete process.env.DEMO_MODEL_ENABLED;
    delete process.env.DEMO_MODEL_QUOTA_BACKEND;
    delete process.env.DEMO_MODEL_QUOTA_POLICY_VERSION;
    delete process.env.DEMO_MODEL_STATE_DIR;
    delete process.env.DEMO_MODEL_ALLOWED_MODELS;
    delete process.env.DEMO_MODEL_COST_POLICY;
    delete process.env.DEMO_MODEL_GLOBAL_DAILY_OUTPUT_TOKENS;
    delete process.env.DEMO_MODEL_GLOBAL_DAILY_REQUESTS;
    delete process.env.DEMO_MODEL_WALLET_DAILY_OUTPUT_TOKENS;
    delete process.env.DEMO_MODEL_WALLET_DAILY_REQUESTS;
    delete process.env.DEMO_MODEL_RATE_WINDOW_SECONDS;
    delete process.env.DEMO_MODEL_RATE_REQUESTS;
    delete process.env.DEMO_MODEL_MAX_GLOBAL_CONCURRENCY;
    delete process.env.DEMO_MODEL_MAX_WALLET_CONCURRENCY;
    delete process.env.DEMO_MODEL_RESERVATION_TTL_SECONDS;
    delete process.env.DEMO_MODEL_ABORT_GRACE_SECONDS;
    delete process.env.DEMO_MODEL_MAX_INPUT_BYTES;
    delete process.env.DEMO_MODEL_MAX_OUTPUT_TOKENS;
    delete process.env.DEMO_MODEL_MAX_STEPS;
    delete process.env.DEMO_OPENROUTER_API_KEY;
    delete process.env.DEMO_OPENROUTER_FREE_ONLY_ACCEPTANCE;
    delete process.env.DEMO_OPENROUTER_KEY_LIMIT_USD;
    delete process.env.DEMO_OPENROUTER_INCLUDE_BYOK_IN_LIMIT;
    delete process.env.DEMO_OPENROUTER_NO_BYOK;
    delete process.env.DEMO_OPENROUTER_PAID_ADDONS_DISABLED;
    delete process.env.HARBOR_URL;
    delete process.env.HARBOR_API_KEY;
    delete process.env.NEAR_AI_ENABLED;
    delete process.env.NEAR_AI_API_KEY;
    delete process.env.NEAR_AI_MODEL;
    delete process.env.NEAR_AI_PRIVACY_TIER;
    rmSync(demoStateDirectory, { recursive: true, force: true });
  });

  it("proxies only tool-capable models and applies demo free filtering", async () => {
    const wallet = walletFixture();
    const binding = walletModelBinding(request("https://pilot.example/bind", {
      cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
    }), wallet.session)!;
    const oauthCookie = sealOpenRouterSession(createOpenRouterSession({
      mode: "oauth",
      model: "provider/paid-tools",
      apiKey: "sk-or-test-only-key",
    }, binding), SECRET);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "provider/free-tools:free",
              name: "Free Tools",
              supported_parameters: ["tools"],
              pricing: { prompt: "0", completion: "0" },
            },
            {
              id: "provider/paid-tools",
              name: "Paid Tools",
              supported_parameters: ["tools"],
            },
            {
              id: "provider/free-no-tools:free",
              name: "No Tools",
              supported_parameters: ["temperature"],
            },
          ],
        }),
      ),
    );

    const demoResponse = await models(
      request("https://pilot.example/api/auth/openrouter/models?mode=demo", {
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      }),
    );
    expect(await demoResponse.json()).toMatchObject({
      models: [{ id: "provider/free-tools:free" }],
      defaultModel: "provider/free-tools:free",
      demo: { available: true },
    });
    expect(demoResponse.headers.get("cache-control")).toBe("no-store");

    const oauthResponse = await models(
      request("https://pilot.example/api/auth/openrouter/models?mode=oauth", {
        cookies: {
          [WALLET_SESSION_COOKIE]: wallet.cookie,
          [OPENROUTER_SESSION_COOKIE]: oauthCookie,
        },
      }),
    );
    const oauthPayload = await oauthResponse.json();
    expect({ status: oauthResponse.status, payload: oauthPayload }).toMatchObject({
      status: 200,
      payload: { models: expect.any(Array) },
    });
    expect(oauthPayload.models).toHaveLength(2);
  });

  it("advertises only a ready tool-capable configured NEAR AI model without its key", async () => {
    process.env.NEAR_AI_ENABLED = "1";
    process.env.NEAR_AI_API_KEY = "server-only-near-ai-key";
    process.env.NEAR_AI_MODEL = "z-ai/example-model";
    process.env.NEAR_AI_PRIVACY_TIER = "incognito";
    const wallet = walletFixture();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url === "https://cloud-api.near.ai/v1/models") {
        return Response.json({
          data: [{
            id: "z-ai/example-model",
            supported_features: ["tools"],
            supported_sampling_parameters: ["temperature"],
            is_ready: true,
          }],
        });
      }
      return Response.json({
        data: [{
          id: "provider/paid-tools",
          name: "Paid Tools",
          supported_parameters: ["tools"],
        }],
      });
    }));

    const response = await models(request(
      "https://pilot.example/api/auth/openrouter/models?mode=near-ai",
      {
        cookies: {
          [WALLET_SESSION_COOKIE]: wallet.cookie,
        },
      },
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.models).toContainEqual(expect.objectContaining({
      id: "z-ai/example-model",
      provider: "near-ai",
      privacy: {
        tier: "incognito",
        declaredBy: "operator-configuration",
        attestationVerified: false,
        summary: expect.stringContaining("upstream model runs outside"),
      },
    }));
    expect(JSON.stringify(payload)).not.toContain("server-only-near-ai-key");

    const selected = await updateSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      {
        method: "POST",
        body: JSON.stringify({
          mode: "near-ai",
          provider: "near-ai",
          model: "z-ai/example-model",
        }),
        headers: { "Content-Type": "application/json", Origin: "https://pilot.example" },
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      },
    ));
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({
      mode: "near-ai",
      provider: "near-ai",
      model: "z-ai/example-model",
      selected: true,
    });
    const persisted = openOpenRouterSession(
      selected.cookies.get(OPENROUTER_SESSION_COOKIE)?.value,
      SECRET,
    );
    expect(persisted).toMatchObject({
      mode: "near-ai",
      provider: "near-ai",
      model: "z-ai/example-model",
    });
    expect(persisted).not.toHaveProperty("apiKey");

    const status = await getSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      {
        cookies: {
          [WALLET_SESSION_COOKIE]: wallet.cookie,
          [OPENROUTER_SESSION_COOKIE]: selected.cookies.get(OPENROUTER_SESSION_COOKIE)!.value,
        },
      },
    ));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      mode: "near-ai",
      provider: "near-ai",
      model: "z-ai/example-model",
      selected: true,
      connected: false,
    });
  });

  it("keeps OpenRouter available and rejects explicit NEAR AI selection when NEAR AI config is invalid", async () => {
    process.env.NEAR_AI_ENABLED = "1";
    process.env.NEAR_AI_MODEL = "z-ai/example-model";
    process.env.NEAR_AI_PRIVACY_TIER = "incognito";
    const wallet = walletFixture();
    const binding = walletModelBinding(request("https://pilot.example/bind", {
      cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
    }), wallet.session)!;
    const oauthCookie = sealOpenRouterSession(createOpenRouterSession({
      mode: "oauth",
      model: "provider/paid-tools",
      apiKey: "sk-or-test-only-key",
    }, binding), SECRET);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [
        {
          id: "provider/paid-tools",
          name: "Paid Tools",
          supported_parameters: ["tools"],
        },
        {
          id: "z-ai/example-model",
          name: "Colliding OpenRouter model",
          supported_parameters: ["tools"],
        },
      ],
    })));

    const listed = await models(request(
      "https://pilot.example/api/auth/openrouter/models?mode=oauth",
      {
        cookies: {
          [WALLET_SESSION_COOKIE]: wallet.cookie,
          [OPENROUTER_SESSION_COOKIE]: oauthCookie,
        },
      },
    ));
    const listedPayload = await listed.json();
    expect(listed.status).toBe(200);
    expect(listedPayload.models).toEqual([
      expect.objectContaining({ id: "provider/paid-tools" }),
    ]);
    expect(listedPayload.defaultModel).toBe("provider/paid-tools");

    const selected = await updateSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      {
        method: "POST",
        body: JSON.stringify({
          mode: "near-ai",
          provider: "near-ai",
          model: "z-ai/example-model",
        }),
        headers: { "Content-Type": "application/json", Origin: "https://pilot.example" },
        cookies: {
          [WALLET_SESSION_COOKIE]: wallet.cookie,
        },
      },
    ));
    await expect(selected.json()).resolves.toMatchObject({
      code: "NEAR_AI_UNAVAILABLE",
      error: expect.stringContaining("NEAR AI provider is unavailable"),
    });
    expect(selected.status).toBe(503);
    expect(selected.cookies.get(OPENROUTER_SESSION_COOKIE)).toBeUndefined();
  });

  it("persists demo selection but refuses a paid demo model", async () => {
    const wallet = walletFixture();
    const paid = await updateSession(
      request("https://pilot.example/api/auth/openrouter/session", {
        method: "POST",
        body: JSON.stringify({ mode: "demo", model: "provider/paid" }),
        headers: { "Content-Type": "application/json", Origin: "https://pilot.example" },
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      }),
    );
    expect(paid.status).toBe(400);
    expect(paid.cookies.get(OPENROUTER_SESSION_COOKIE)).toBeUndefined();

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{
        id: "provider/free:free",
        supported_parameters: ["tools"],
        pricing: { prompt: "0", completion: "0" },
      }],
    })));

    const selected = await updateSession(
      request("https://pilot.example/api/auth/openrouter/session", {
        method: "POST",
        body: JSON.stringify({ mode: "demo", model: "provider/free:free" }),
        headers: { "Content-Type": "application/json", Origin: "https://pilot.example" },
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      }),
    );
    expect(selected.status).toBe(200);
    expect(
      openOpenRouterSession(
        selected.cookies.get(OPENROUTER_SESSION_COOKIE)?.value,
        SECRET,
      ),
    ).toMatchObject({
      version: 2,
      mode: "demo",
      model: "provider/free:free",
      wallet: { account: ACCOUNT, network: "testnet" },
    });
  });

  it("fails closed before any upstream request when the server-only demo key is absent", async () => {
    const wallet = walletFixture();
    delete process.env.DEMO_OPENROUTER_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await models(request(
      "https://pilot.example/api/auth/openrouter/models?mode=demo",
      { cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie } },
    ));
    expect(catalog.status).toBe(503);
    expect(await catalog.json()).toMatchObject({ code: "DEMO_MISCONFIGURED" });

    const activation = await updateSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      {
        method: "POST",
        body: JSON.stringify({ mode: "demo", model: "provider/free-tools:free" }),
        headers: { "Content-Type": "application/json", Origin: "https://pilot.example" },
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      },
    ));
    expect(activation.status).toBe(503);
    expect(await activation.json()).toMatchObject({ code: "DEMO_MISCONFIGURED" });
    expect(activation.cookies.get(OPENROUTER_SESSION_COOKIE)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a sanitized unavailable response when the default model is not configured", async () => {
    const wallet = walletFixture();
    delete process.env.MODEL_DEFAULT;

    const response = await getSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      { cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie } },
    ));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Model access configuration is unavailable.",
      code: "MODEL_ACCESS_UNAVAILABLE",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("uses the authenticated Harbor status backend without exposing its credential or wallet identity", async () => {
    const wallet = walletFixture();
    useHarborDemoBackend();
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url === "https://harbor.example/internal/demo-model/v1/status") {
        return harborDemoStatusResponse();
      }
      if (url === "https://openrouter.ai/api/v1/models") {
        return Response.json({
          data: [{
            id: "provider/free-tools:free",
            supported_parameters: ["tools"],
            pricing: { prompt: "0", completion: "0" },
          }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await models(request(
      "https://pilot.example/api/auth/openrouter/models?mode=demo",
      { cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie } },
    ));
    expect(catalog.status).toBe(200);
    const catalogText = await catalog.text();
    expect(JSON.parse(catalogText)).toMatchObject({
      models: [{ id: "provider/free-tools:free" }],
      demo: { available: true, costPolicy: "free-only" },
    });
    expect(catalogText).not.toContain("synthetic-harbor-token");
    expect(catalogText).not.toContain(ACCOUNT);

    const status = await getSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      { cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie } },
    ));
    const statusText = await status.text();
    expect(status.status).toBe(200);
    expect(JSON.parse(statusText)).toMatchObject({ demo: { available: true } });
    expect(statusText).not.toContain("synthetic-harbor-token");
    expect(statusText).not.toContain(ACCOUNT);

    const harborCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      return url === "https://harbor.example/internal/demo-model/v1/status";
    });
    expect(harborCalls).toHaveLength(2);
    for (const [, init] of harborCalls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer pilot:synthetic-harbor-token",
      );
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBeUndefined();
    }
  });

  it("does not issue a demo session when the shared Harbor ledger is unavailable", async () => {
    const wallet = walletFixture();
    useHarborDemoBackend();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url === "https://harbor.example/internal/demo-model/v1/status") {
        const response = Response.json(
          {
            ok: false,
            error: {
              code: "DEMO_STATE_UNAVAILABLE",
              message: "Shared demo quota state is unavailable",
            },
          },
          { status: 503 },
        );
        Object.defineProperty(response, "url", { value: url });
        return response;
      }
      throw new Error(`Unexpected upstream call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await models(request(
      "https://pilot.example/api/auth/openrouter/models?mode=demo",
      { cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie } },
    ));
    expect(catalog.status).toBe(503);
    expect(await catalog.json()).toMatchObject({ code: "DEMO_STATE_UNAVAILABLE" });

    const activation = await updateSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      {
        method: "POST",
        body: JSON.stringify({ mode: "demo", model: "provider/free-tools:free" }),
        headers: { "Content-Type": "application/json", Origin: "https://pilot.example" },
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      },
    ));
    expect(activation.status).toBe(503);
    expect(await activation.json()).toMatchObject({ code: "DEMO_STATE_UNAVAILABLE" });
    expect(activation.cookies.get(OPENROUTER_SESSION_COOKIE)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops advertising or activating demo access after an integrity trip", async () => {
    const wallet = walletFixture();
    const budget = DemoModelBudget.fromEnvironment(process.env);
    const reservation = budget.reserve({
      walletAccount: ACCOUNT,
      walletSessionId: "a".repeat(64),
      network: "testnet",
      model: "provider/free-tools:free",
      inputBytes: 0,
    });
    budget.settle(reservation.id, {
      outcome: "uncertain",
      integrityFailure: "nonzero-cost",
    });
    budget.close();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await models(request(
      "https://pilot.example/api/auth/openrouter/models?mode=demo",
      { cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie } },
    ));
    expect(catalog.status).toBe(503);
    expect(await catalog.json()).toMatchObject({
      code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
    });
    expect(catalog.headers.get("cache-control")).toBe("no-store");

    const activation = await updateSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      {
        method: "POST",
        body: JSON.stringify({ mode: "demo", model: "provider/free-tools:free" }),
        headers: { "Content-Type": "application/json", Origin: "https://pilot.example" },
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      },
    ));
    expect(activation.status).toBe(503);
    expect(await activation.json()).toMatchObject({
      code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
    });
    expect(activation.cookies.get(OPENROUTER_SESSION_COOKIE)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the exact origin and wallet session for model-session mutations", async () => {
    const wallet = walletFixture();
    const missingOrigin = await updateSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      {
        method: "POST",
        body: JSON.stringify({ mode: "demo", model: "provider/free:free" }),
        headers: { "Content-Type": "application/json" },
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      },
    ));
    expect(missingOrigin.status).toBe(403);

    const missingWallet = await updateSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      {
        method: "POST",
        body: JSON.stringify({ mode: "demo", model: "provider/free:free" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://pilot.example",
        },
      },
    ));
    expect(missingWallet.status).toBe(401);

    expect(deleteSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      { method: "DELETE", headers: { Origin: "https://evil.example" } },
    )).status).toBe(403);
  });

  it("updates an OAuth model without returning the user key", async () => {
    const wallet = walletFixture();
    const binding = walletModelBinding(
      request("https://pilot.example/bind", {
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      }),
      wallet.session,
    )!;
    const current = sealOpenRouterSession(
      createOpenRouterSession({
        mode: "oauth",
        model: "provider/old",
        apiKey: "sk-or-never-in-response",
      }, binding),
      SECRET,
    );
    const response = await updateSession(
      request("https://pilot.example/api/auth/openrouter/session", {
        method: "POST",
        body: JSON.stringify({ model: "provider/new" }),
        headers: { "Content-Type": "application/json", Origin: "https://pilot.example" },
        cookies: {
          [WALLET_SESSION_COOKIE]: wallet.cookie,
          [OPENROUTER_SESSION_COOKIE]: current,
        },
      }),
    );

    expect(await response.json()).toEqual({
      mode: "oauth",
      model: "provider/new",
      connected: true,
    });
    expect(
      openOpenRouterSession(
        response.cookies.get(OPENROUTER_SESSION_COOKIE)?.value,
        SECRET,
      ),
    ).toMatchObject({ apiKey: "sk-or-never-in-response", model: "provider/new" });
  });

  it("reports status without credentials and disconnects by expiring cookies", async () => {
    const wallet = walletFixture();
    const sessionResponse = await getSession(
      request("https://pilot.example/api/auth/openrouter/session", {
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      }),
    );
    expect(await sessionResponse.json()).toEqual({
      mode: "demo",
      model: "provider/free-tools:free",
      selected: false,
      connected: false,
      demo: expect.objectContaining({ available: true }),
    });

    const disconnected = deleteSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      {
        method: "DELETE",
        headers: { Origin: "https://pilot.example" },
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      },
    ));
    expect(await disconnected.json()).toEqual({
      mode: "demo",
      model: "provider/free-tools:free",
      connected: false,
    });
    expect(cookieFlags(disconnected)).toMatch(/Max-Age=0/i);
    expect(cookieFlags(disconnected)).toMatch(/HttpOnly/i);
    expect(cookieFlags(disconnected)).toMatch(/Secure/i);
  });

  it("clears local OAuth cookies after wallet and model configuration expire", async () => {
    delete process.env.SESSION_SECRET;
    delete process.env.MODEL_DEFAULT;

    const disconnected = deleteSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      {
        method: "DELETE",
        headers: { Origin: "https://pilot.example" },
      },
    ));

    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toEqual({
      mode: "demo",
      connected: false,
    });
    for (const name of [
      OPENROUTER_SESSION_COOKIE,
      OPENROUTER_STATE_COOKIE,
      OPENROUTER_VERIFIER_COOKIE,
      OPENROUTER_RETURN_TO_COOKIE,
      OPENROUTER_WALLET_BINDING_COOKIE,
      OPENROUTER_PENDING_SESSION_COOKIE,
    ]) {
      expect(disconnected.cookies.get(name)).toMatchObject({ value: "", maxAge: 0 });
    }
  });

  it("reports a wallet-bound OAuth session without exposing key or binding metadata", async () => {
    const wallet = walletFixture();
    const binding = walletModelBinding(request("https://pilot.example/bind", {
      cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
    }), wallet.session)!;
    const modelCookie = sealOpenRouterSession(createOpenRouterSession({
      mode: "oauth",
      model: "provider/paid-tools",
      apiKey: "sk-or-private-account-key",
    }, binding), SECRET);
    const response = await getSession(request(
      "https://pilot.example/api/auth/openrouter/session",
      {
        cookies: {
          [WALLET_SESSION_COOKIE]: wallet.cookie,
          [OPENROUTER_SESSION_COOKIE]: modelCookie,
        },
      },
    ));
    expect(await response.json()).toEqual({
      mode: "oauth",
      model: "provider/paid-tools",
      selected: true,
      connected: true,
      demo: expect.objectContaining({ available: true }),
    });
  });
});

describe("session route without SESSION_SECRET", () => {
  beforeEach(() => {
    delete process.env.SESSION_SECRET;
    process.env.PILOT_DEPLOYMENT_PROFILE = "hosted";
    process.env.PILOT_PUBLIC_ORIGIN = "https://pilot.example";
    process.env.NEXT_PUBLIC_DEV_SIGNER = "0";
    process.env.MODEL_DEFAULT = "provider/free:free";
  });

  afterEach(() => {
    delete process.env.PILOT_DEPLOYMENT_PROFILE;
    delete process.env.PILOT_PUBLIC_ORIGIN;
    delete process.env.NEXT_PUBLIC_DEV_SIGNER;
    delete process.env.MODEL_DEFAULT;
  });

  it("returns a readable 503 instead of an empty 500", async () => {
    const wallet = walletFixture();
    const status = await getSession(request("https://pilot.example/api/auth/openrouter/session", {
      cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
    }));
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({
      error: "SESSION_SECRET is not configured",
      code: "SESSION_UNAVAILABLE",
    });

    const demo = await updateSession(
      request("https://pilot.example/api/auth/openrouter/session", {
        method: "POST",
        body: JSON.stringify({ mode: "demo", model: "provider/free:free" }),
        headers: { "Content-Type": "application/json", Origin: "https://pilot.example" },
        cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie },
      }),
    );
    expect(demo.status).toBe(503);
    expect((await demo.json()).code).toBe("SESSION_UNAVAILABLE");
    expect(demo.cookies.get(OPENROUTER_SESSION_COOKIE)).toBeUndefined();

    const catalog = await models(request(
      "https://pilot.example/api/auth/openrouter/models?mode=demo",
      { cookies: { [WALLET_SESSION_COOKIE]: wallet.cookie } },
    ));
    expect(catalog.status).toBe(503);
    expect(await catalog.json()).toEqual({
      error: "Model access session storage is unavailable.",
    });
  });
});
