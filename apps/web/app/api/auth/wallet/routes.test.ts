import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sealWalletSession,
  WALLET_CHALLENGE_COOKIE,
  WALLET_SESSION_COOKIE,
  WALLET_SUBMISSIONS_COOKIE,
} from "../../../../lib/wallet-session";
import {
  OPENROUTER_PENDING_SESSION_COOKIE,
  OPENROUTER_RETURN_TO_COOKIE,
  OPENROUTER_SESSION_COOKIE,
  OPENROUTER_STATE_COOKIE,
  OPENROUTER_VERIFIER_COOKIE,
  OPENROUTER_WALLET_BINDING_COOKIE,
} from "../../../../lib/openrouter-session";
import { POST as issueChallenge } from "./challenge/route";
import { POST as issueStrategyChallenge } from "./strategy-challenge/route";
import {
  DELETE as deleteSession,
  GET as getSession,
  POST as createSession,
} from "./session/route";

const SECRET = "wallet-route-test-secret-that-is-longer-than-thirty-two-characters";
const PROFILE_KEYS = [
  "NEXT_PUBLIC_PILOT_BUILD_MARKER",
  "PILOT_DEPLOYMENT_PROFILE",
  "PILOT_PUBLIC_ORIGIN",
  "NEXT_PUBLIC_DEV_SIGNER",
  "SESSION_SECRET",
  "EXEC_NETWORK",
  "HARBOR_URL",
  "PILOT_HOSTED_STATE_API_KEY",
  "P_LIVE_RLUSD_ACQUISITION_STATE_DIR",
] as const;
const originalEnvironment = Object.fromEntries(
  PROFILE_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof PROFILE_KEYS)[number], string | undefined>;
let proofStateDirectory: string;

function request(
  url: string,
  options: RequestInit & { cookies?: Record<string, string> } = {},
): NextRequest {
  const { cookies, signal, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  if (!headers.has("host")) headers.set("host", new URL(url).host);
  if (cookies) {
    headers.set(
      "cookie",
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

function configure(
  profile: string | undefined,
  devSigner: string | undefined,
  buildMarker?: string,
): void {
  if (profile === undefined) delete process.env.PILOT_DEPLOYMENT_PROFILE;
  else process.env.PILOT_DEPLOYMENT_PROFILE = profile;
  if (devSigner === undefined) delete process.env.NEXT_PUBLIC_DEV_SIGNER;
  else process.env.NEXT_PUBLIC_DEV_SIGNER = devSigner;
  if (buildMarker === undefined) delete process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER;
  else process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER = buildMarker;
  if (profile === "hosted") {
    process.env.PILOT_PUBLIC_ORIGIN = "https://pilot.example";
    process.env.HARBOR_URL = "https://harbor.example";
    process.env.PILOT_HOSTED_STATE_API_KEY = `pilot-hosted-state:${"H".repeat(32)}`;
  } else {
    delete process.env.PILOT_PUBLIC_ORIGIN;
    delete process.env.HARBOR_URL;
    delete process.env.PILOT_HOSTED_STATE_API_KEY;
  }
}

function expectNoCookie(response: Response): void {
  expect(response.headers.get("set-cookie")).toBeNull();
}

function challengeRequest(url: string, wallet: Wallet, headers: HeadersInit = {}): NextRequest {
  return request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(url).origin, ...headers },
    body: JSON.stringify({ account: wallet.classicAddress, network: "testnet" }),
  });
}

describe("wallet auth route deployment boundary", () => {
  beforeEach(async () => {
    proofStateDirectory = await mkdtemp(join(tmpdir(), "pilot-wallet-auth-route-"));
    await chmod(proofStateDirectory, 0o700);
    process.env.SESSION_SECRET = SECRET;
    process.env.P_LIVE_RLUSD_ACQUISITION_STATE_DIR = proofStateDirectory;
    delete process.env.PILOT_DEPLOYMENT_PROFILE;
    delete process.env.PILOT_PUBLIC_ORIGIN;
    delete process.env.NEXT_PUBLIC_DEV_SIGNER;
    delete process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const key of PROFILE_KEYS) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(proofStateDirectory, { recursive: true, force: true });
  });

  it.each([
    ["missing profile", undefined, "0", "https://pilot.example"],
    ["invalid profile", "preview", "0", "https://pilot.example"],
    ["hosted dev signer", "hosted", "1", "https://pilot.example"],
    ["remote local-wallet URL", "local-wallet", "1", "https://pilot.example"],
    ["localhost alias", "local-wallet", "1", "http://localhost:3003"],
    ["unapproved former test port", "local-wallet", "1", "http://127.0.0.1:3004"],
    ["unapproved loopback port", "local-wallet", "1", "http://127.0.0.1:3005"],
  ])("rejects %s before challenge or session cookie work", async (_name, profile, signer, origin) => {
    configure(profile, signer);
    const wallet = Wallet.generate();
    const spoofed = {
      "x-forwarded-host": "127.0.0.1:3003",
      "x-forwarded-proto": "http",
    };

    const challenge = await issueChallenge(challengeRequest(
      `${origin}/api/auth/wallet/challenge`,
      wallet,
      spoofed,
    ));
    const get = getSession(request(`${origin}/api/auth/wallet/session`, {
      headers: spoofed,
      cookies: { [WALLET_SESSION_COOKIE]: "not-a-session" },
    }));
    const post = await createSession(request(`${origin}/api/auth/wallet/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...spoofed,
      },
      body: JSON.stringify({ tx_blob: "not-a-proof" }),
      cookies: { [WALLET_CHALLENGE_COOKIE]: "not-a-challenge" },
    }));

    for (const response of [challenge, get, post]) {
      expect(response.status).toBe(403);
      expectNoCookie(response);
    }
  });

  it("allows the approved local-wallet origin on port 3003", async () => {
    configure("local-wallet", "1");
    const wallet = Wallet.generate();
    const origin = "http://127.0.0.1:3003";

    const challenge = await issueChallenge(challengeRequest(
      `${origin}/api/auth/wallet/challenge`,
      wallet,
    ));
    expect(challenge.status).toBe(200);
    expect(challenge.cookies.get(WALLET_CHALLENGE_COOKIE)?.value).toBeTruthy();

    const session = getSession(request(`${origin}/api/auth/wallet/session`));
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ authenticated: false });
  });

  it("allows only the exact isolated profile, marker, and host-scoped cookie authority", async () => {
    configure("local-wallet-isolated-v1", "1", "pilot-local-wallet-isolated-v1");
    const wallet = Wallet.generate();
    const origin = "http://127.0.0.2:3003";

    const challenge = await issueChallenge(challengeRequest(
      `${origin}/api/auth/wallet/challenge`,
      wallet,
    ));
    expect(challenge.status).toBe(200);
    expect(challenge.cookies.get(WALLET_CHALLENGE_COOKIE)?.value).toBeTruthy();
    const setCookie = challenge.headers.get("set-cookie");
    expect(setCookie).toContain(`${WALLET_CHALLENGE_COOKIE}=`);
    expect(setCookie).toMatch(/Path=\//i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).not.toMatch(/Domain=/i);

    const session = getSession(request(`${origin}/api/auth/wallet/session`));
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ authenticated: false });
  });

  it("issues a clear-global-kill challenge only for the wallet-bound Testnet session", async () => {
    configure("hosted", "0");
    process.env.EXEC_NETWORK = "testnet";
    const wallet = Wallet.generate();
    const session = sealWalletSession({
      version: 1, account: wallet.classicAddress, network: "testnet", expiresAt: Date.now() + 60_000,
    });
    const mandateExpiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const response = await issueStrategyChallenge(request(
      "https://pilot.example/api/auth/wallet/strategy-challenge",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://pilot.example",
          "sec-fetch-site": "same-origin",
        },
        cookies: { [WALLET_SESSION_COOKIE]: session },
        body: JSON.stringify({
          action: "clear_global_kill",
          strategy_id: "strategy-test-001",
          mandate_version: 3,
          mandate_digest: "A".repeat(64),
          mandate_expires_at: mandateExpiresAt,
          request_id: "request-clear-global-001",
        }),
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      account: wallet.classicAddress,
      network: "testnet",
      mandate_version: 3,
      mandate_digest: "A".repeat(64),
      mandate_expires_at: mandateExpiresAt,
      request_id: "request-clear-global-001",
    });
  });

  it.each([
    ["cross-site", { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }, {}, 403],
    ["extra key", {}, { unexpected: true }, 400],
    ["unsupported action", {}, { action: "global-kill-clear" }, 400],
  ] as const)("rejects a %s strategy challenge", async (_name, headerOverrides, bodyOverrides, status) => {
    configure("hosted", "0");
    process.env.EXEC_NETWORK = "testnet";
    const wallet = Wallet.generate();
    const session = sealWalletSession({
      version: 1, account: wallet.classicAddress, network: "testnet", expiresAt: Date.now() + 60_000,
    });
    const response = await issueStrategyChallenge(request(
      "https://pilot.example/api/auth/wallet/strategy-challenge",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://pilot.example",
          "sec-fetch-site": "same-origin",
          ...headerOverrides,
        },
        cookies: { [WALLET_SESSION_COOKIE]: session },
        body: JSON.stringify({
          action: "clear_global_kill",
          strategy_id: "strategy-test-001",
          mandate_version: 3,
          mandate_digest: "A".repeat(64),
          mandate_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          request_id: "request-clear-global-001",
          ...bodyOverrides,
        }),
      },
    ));

    expect(response.status).toBe(status);
  });

  it.each([
    ["missing marker", "local-wallet-isolated-v1", undefined, "http://127.0.0.2:3003"],
    ["wrong marker", "local-wallet-isolated-v1", "pilot-other", "http://127.0.0.2:3003"],
    ["isolated profile on legacy slot", "local-wallet-isolated-v1", "pilot-local-wallet-isolated-v1", "http://127.0.0.1:3003"],
    ["legacy profile on isolated slot", "local-wallet", undefined, "http://127.0.0.2:3003"],
    ["localhost alias", "local-wallet-isolated-v1", "pilot-local-wallet-isolated-v1", "http://localhost:3003"],
    ["other port", "local-wallet-isolated-v1", "pilot-local-wallet-isolated-v1", "http://127.0.0.2:3004"],
  ])("rejects isolated wallet boundary mismatch: %s", async (
    _name,
    profile,
    marker,
    origin,
  ) => {
    configure(profile, "1", marker);
    const response = await issueChallenge(challengeRequest(
      `${origin}/api/auth/wallet/challenge`,
      Wallet.generate(),
    ));

    expect(response.status).toBe(403);
    expectNoCookie(response);
  });

  it.each([
    ["Forwarded", { forwarded: "for=203.0.113.7;proto=https;host=pilot.example" }],
    ["X-Forwarded-Host", { "x-forwarded-host": "pilot.example" }],
    ["X-Forwarded-Proto", { "x-forwarded-proto": "https" }],
    ["X-Forwarded-Port", { "x-forwarded-port": "443" }],
    ["multi-value Forwarded", { forwarded: "for=127.0.0.1,for=203.0.113.7" }],
    ["multi-value X-Forwarded-Host", { "x-forwarded-host": "127.0.0.1:3003,pilot.example" }],
    ["multi-value X-Forwarded-Proto", { "x-forwarded-proto": "http,https" }],
    ["multi-value X-Forwarded-Port", { "x-forwarded-port": "3003,443" }],
  ])("rejects spoofed %s authority before cookie work", async (_name, forwardedHeaders) => {
    configure("local-wallet", "1");
    const wallet = Wallet.generate();
    const origin = "http://127.0.0.1:3003";

    const challenge = await issueChallenge(challengeRequest(
      `${origin}/api/auth/wallet/challenge`,
      wallet,
      forwardedHeaders,
    ));
    const get = getSession(request(`${origin}/api/auth/wallet/session`, {
      headers: forwardedHeaders,
      cookies: { [WALLET_SESSION_COOKIE]: "not-a-session" },
    }));
    const post = await createSession(request(`${origin}/api/auth/wallet/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...forwardedHeaders },
      body: JSON.stringify({ tx_blob: "not-a-proof" }),
      cookies: { [WALLET_CHALLENGE_COOKIE]: "not-a-challenge" },
    }));

    for (const response of [challenge, get, post]) {
      expect(response.status).toBe(403);
      expectNoCookie(response);
    }
  });

  it("rejects a remote request URL even when Host and Origin spoof the approved authority", async () => {
    configure("local-wallet", "1");
    const wallet = Wallet.generate();
    const headers = {
      host: "127.0.0.1:3003",
      origin: "http://127.0.0.1:3003",
    };
    const challenge = await issueChallenge(challengeRequest(
      "http://pilot.example:3003/api/auth/wallet/challenge",
      wallet,
      headers,
    ));
    const get = getSession(request("http://pilot.example:3003/api/auth/wallet/session", {
      headers,
      cookies: { [WALLET_SESSION_COOKIE]: "not-a-session" },
    }));

    expect(challenge.status).toBe(403);
    expect(get.status).toBe(403);
    expectNoCookie(challenge);
    expectNoCookie(get);
  });

  it("allows matching framework forwarding metadata on the approved local origin", async () => {
    configure("local-wallet", "1");
    const wallet = Wallet.generate();
    const origin = "http://127.0.0.1:3003";
    const response = await issueChallenge(challengeRequest(
      `${origin}/api/auth/wallet/challenge`,
      wallet,
      {
        "x-forwarded-host": "127.0.0.1:3003",
        "x-forwarded-proto": "http",
        "x-forwarded-port": "3003",
      },
    ));

    expect(response.status).toBe(200);
    expect(response.cookies.get(WALLET_CHALLENGE_COOKIE)?.value).toBeTruthy();
  });

  it("still requires same-origin POSTs after the local URL boundary passes", async () => {
    configure("local-wallet", "1");
    const wallet = Wallet.generate();
    const challenge = await issueChallenge(request(
      "http://127.0.0.1:3003/api/auth/wallet/challenge",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://attacker.example" },
        body: JSON.stringify({ account: wallet.classicAddress, network: "testnet" }),
      },
    ));
    const session = await createSession(request(
      "http://127.0.0.1:3003/api/auth/wallet/session",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://attacker.example" },
        body: JSON.stringify({ tx_blob: "not-a-proof" }),
      },
    ));

    expect(challenge.status).toBe(403);
    expect(session.status).toBe(403);
    expectNoCookie(challenge);
    expectNoCookie(session);
  });

  it("preserves remote challenge and session issuance for explicit hosted signer-off mode", async () => {
    configure("hosted", "0");
    const hostedConsume = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ consumed: true }),
      { headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", hostedConsume);
    const wallet = Wallet.generate();
    const origin = "https://pilot.example";
    const internalOrigin = "http://next-internal:3000";
    const untrustedForwarding = {
      origin,
      forwarded: "for=203.0.113.7;proto=http;host=attacker.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
    };
    const challengeResponse = await issueChallenge(challengeRequest(
      `${internalOrigin}/api/auth/wallet/challenge`,
      wallet,
      untrustedForwarding,
    ));
    expect(challengeResponse.status).toBe(200);
    const challengeCookie = challengeResponse.cookies.get(WALLET_CHALLENGE_COOKIE)?.value;
    const challengeBody = await challengeResponse.json() as { tx_json: Record<string, unknown> };
    expect(challengeCookie).toBeTruthy();

    const txBlob = wallet.sign(challengeBody.tx_json as never).tx_blob;
    const created = await createSession(request(`${internalOrigin}/api/auth/wallet/session`, {
      method: "POST",
      headers: { "content-type": "application/json", ...untrustedForwarding },
      body: JSON.stringify({ tx_blob: txBlob }),
      cookies: { [WALLET_CHALLENGE_COOKIE]: challengeCookie! },
    }));
    expect(created.status).toBe(200);
    expect(created.cookies.get(WALLET_SESSION_COOKIE)?.value).toBeTruthy();
    expect(hostedConsume).toHaveBeenCalledTimes(1);
    const [stateUrl, stateInit] = hostedConsume.mock.calls[0]!;
    expect(String(stateUrl)).toBe(
      "https://harbor.example/internal/pilot-state/v1/wallet-proofs/consume",
    );
    expect(new Headers(stateInit?.headers).get("authorization")).toBe(
      `Bearer pilot-hosted-state:${"H".repeat(32)}`,
    );
    const stateBody = JSON.parse(String(stateInit?.body)) as Record<string, unknown>;
    expect(stateBody).toMatchObject({
      version: 1,
      namespace: "wallet-auth",
      expiresAtMs: expect.any(Number),
      nonceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      scopeId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(stateBody)).not.toContain(wallet.classicAddress);

    const sealed = sealWalletSession({
      version: 1,
      account: wallet.classicAddress,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    }, SECRET);
    const status = getSession(request(`${internalOrigin}/api/auth/wallet/session`, {
      headers: untrustedForwarding,
      cookies: { [WALLET_SESSION_COOKIE]: sealed },
    }));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      authenticated: true,
      account: wallet.classicAddress,
      network: "testnet",
    });
  });

  it("fails hosted wallet authorization closed before issuing a session when replay state is absent", async () => {
    configure("hosted", "0");
    const wallet = Wallet.generate();
    const origin = "https://pilot.example";
    const internalOrigin = "http://next-internal:3000";
    const challenge = await issueChallenge(challengeRequest(
      `${internalOrigin}/api/auth/wallet/challenge`,
      wallet,
      { origin },
    ));
    const challengeCookie = challenge.cookies.get(WALLET_CHALLENGE_COOKIE)?.value;
    const body = await challenge.json() as { tx_json: Record<string, unknown> };
    delete process.env.PILOT_HOSTED_STATE_API_KEY;

    const response = await createSession(request(`${internalOrigin}/api/auth/wallet/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ tx_blob: wallet.sign(body.tx_json as never).tx_blob }),
      cookies: { [WALLET_CHALLENGE_COOKIE]: challengeCookie! },
    }));

    expect(response.status).toBe(503);
    expect(response.cookies.get(WALLET_SESSION_COOKIE)).toBeUndefined();
    await expect(response.json()).resolves.toEqual({
      error: "Wallet authorization replay protection is unavailable.",
    });
  });

  it("durably consumes one signed authentication proof before issuing a session", async () => {
    // This test isolates same-instant atomic consumption. A separate clock-race
    // test verifies that a newer durable fence may fail the older request
    // closed after publication, so do not let scheduler latency mix the two
    // invariants here.
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      configure("local-wallet", "1");
      const wallet = Wallet.generate();
      const origin = "http://127.0.0.1:3003";
      const challengeResponse = await issueChallenge(challengeRequest(
        `${origin}/api/auth/wallet/challenge`,
        wallet,
      ));
      const challengeCookie = challengeResponse.cookies.get(WALLET_CHALLENGE_COOKIE)?.value;
      const challengeBody = await challengeResponse.json() as { tx_json: Record<string, unknown> };
      const txBlob = wallet.sign(challengeBody.tx_json as never).tx_blob;
      const post = () => createSession(request(`${origin}/api/auth/wallet/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ tx_blob: txBlob }),
        cookies: { [WALLET_CHALLENGE_COOKIE]: challengeCookie! },
      }));

      const responses = await Promise.all([post(), post()]);
      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      expect(responses.every((response) => [200, 401, 503].includes(response.status))).toBe(true);
      expect(responses.filter(
        (response) => response.cookies.get(WALLET_SESSION_COOKIE)?.value,
      )).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it.each([undefined, "https://localhost."])(
    "rejects unsafe hosted public origin %s before wallet cookie work",
    async (publicOrigin) => {
      configure("hosted", "0");
      if (publicOrigin === undefined) delete process.env.PILOT_PUBLIC_ORIGIN;
      else process.env.PILOT_PUBLIC_ORIGIN = publicOrigin;
      const wallet = Wallet.generate();
      const challenge = await issueChallenge(challengeRequest(
        "http://next-internal:3000/api/auth/wallet/challenge",
        wallet,
        { origin: publicOrigin ?? "https://pilot.example" },
      ));
      const status = getSession(request(
        "http://next-internal:3000/api/auth/wallet/session",
        { cookies: { [WALLET_SESSION_COOKIE]: "not-a-session" } },
      ));

      expect(challenge.status).toBe(403);
      expect(status.status).toBe(403);
      expectNoCookie(challenge);
      expectNoCookie(status);
    },
  );

  it("expires wallet and all local model credentials on DELETE", async () => {
    configure("local-wallet", "1");
    const origin = "http://127.0.0.1:3003";
    const response = deleteSession(request(`${origin}/api/auth/wallet/session`, {
      method: "DELETE",
      headers: { origin },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false });
    expect(response.cookies.get(WALLET_SESSION_COOKIE)?.value).toBe("");
    expect(response.cookies.get(WALLET_SUBMISSIONS_COOKIE)?.value).toBe("");
    expect(response.cookies.get(WALLET_CHALLENGE_COOKIE)?.value).toBe("");
    expect(response.cookies.get(OPENROUTER_SESSION_COOKIE)?.value).toBe("");
    expect(response.cookies.get(OPENROUTER_PENDING_SESSION_COOKIE)?.value).toBe("");
    expect(response.cookies.get(OPENROUTER_STATE_COOKIE)?.value).toBe("");
    expect(response.cookies.get(OPENROUTER_VERIFIER_COOKIE)?.value).toBe("");
    expect(response.cookies.get(OPENROUTER_RETURN_TO_COOKIE)?.value).toBe("");
    expect(response.cookies.get(OPENROUTER_WALLET_BINDING_COOKIE)?.value).toBe("");
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it("rejects cross-origin wallet sign-out without clearing cookies", async () => {
    configure("local-wallet", "1");
    const response = deleteSession(request(
      "http://127.0.0.1:3003/api/auth/wallet/session",
      { method: "DELETE", headers: { origin: "https://attacker.example" } },
    ));

    expect(response.status).toBe(403);
    expectNoCookie(response);
  });
});
