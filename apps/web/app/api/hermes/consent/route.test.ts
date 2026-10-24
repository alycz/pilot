import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  readWalletSession: vi.fn((request: Request) => {
    const cookie = request.headers.get("cookie") ?? "";
    const match = cookie.match(/(?:^|;\s*)test-wallet=([^;]+)/);
    if (!match) return null;
    const [owner, network] = decodeURIComponent(match[1]!).split("|");
    if (!owner || (network !== "testnet" && network !== "devnet")) return null;
    return { version: 1, account: owner, network, expiresAt: Date.now() + 60_000 };
  }),
}));
const runtimeReadiness = vi.hoisted(() => ({
  probe: vi.fn(),
}));
const aclInspector = vi.hoisted(() => ({
  inspect: vi.fn(),
}));

vi.mock("../../../../lib/wallet-session", () => wallet);
vi.mock("../../../../lib/hermes-runtime", () => ({
  probeHermesRuntimeReadinessFromEnvironment: runtimeReadiness.probe,
}));
vi.mock("../../../../lib/hermes-profile-gate", () => ({
  inspectHermesPrivateMacAcl: aclInspector.inspect,
}));

import { GET, POST, DELETE } from "./route";
import { hermesConsentScopeDigest } from "../../../../lib/hermes-consent";
import {
  HermesRetentionCommitUncertainError,
  HermesRetentionContentionError,
  HermesRetentionJournal,
} from "../../../../lib/hermes-retention";

const ORIGIN = "https://pilot.example";
const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER_OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const SESSION_SECRET = "hermes-consent-session-secret-at-least-32";
const CONSENT_SECRET = "separate-hermes-consent-secret-at-least-32";
let stateDirectory = "";

function walletCookie(owner = OWNER, network: "testnet" | "devnet" = "testnet"): string {
  return `test-wallet=${encodeURIComponent(`${owner}|${network}`)}`;
}

function request(
  method: "GET" | "POST" | "DELETE",
  options: {
    cookie?: string;
    origin?: string;
    fetchSite?: string;
    body?: unknown;
    contentType?: string;
    signal?: AbortSignal;
  } = {},
): Request {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Request(`${ORIGIN}/api/hermes/consent`, {
    method,
    headers: {
      origin: options.origin ?? ORIGIN,
      "sec-fetch-site": options.fetchSite ?? "same-origin",
      ...(options.cookie === "" ? {} : { cookie: options.cookie ?? walletCookie() }),
      ...(body === undefined ? {} : {
        "content-type": options.contentType ?? "application/json",
      }),
    },
    body,
    signal: options.signal,
  });
}

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(
    await realpath(tmpdir()),
    "pilot-hermes-consent-route-",
  ));
  vi.stubEnv("PILOT_HERMES_ENABLED", "1");
  vi.stubEnv("PILOT_HERMES_PROVIDER", "openrouter");
  vi.stubEnv("PILOT_HERMES_MODEL", "example/read-only");
  vi.stubEnv("PILOT_HERMES_RETENTION_DAYS", "7");
  vi.stubEnv("PILOT_HERMES_TERMS_VERSION", "2026-10-21");
  vi.stubEnv("PILOT_HERMES_CONSENT_SECRET", CONSENT_SECRET);
  vi.stubEnv("PILOT_HERMES_RETENTION_STATE_PATH", join(stateDirectory, "state.json"));
  vi.stubEnv("PILOT_PERSONALIZATION_TENANT_ID", "tenant-a");
  vi.stubEnv("EXEC_NETWORK", "testnet");
  vi.stubEnv("SESSION_SECRET", SESSION_SECRET);
  vi.stubEnv("PILOT_DEPLOYMENT_PROFILE", "hosted");
  vi.stubEnv("PILOT_PUBLIC_ORIGIN", ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_DEV_SIGNER", "0");
  vi.stubEnv("NEXT_PUBLIC_PILOT_BUILD_MARKER", undefined);
  runtimeReadiness.probe.mockReset().mockResolvedValue({
    ready: false,
    reason: "configuration-invalid",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(stateDirectory, { recursive: true, force: true });
});

describe("/api/hermes/consent", () => {
  it("returns only the exact disclosure and current scoped consent state", async () => {
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({
      configured: true,
      activationReady: false,
      activationBlock: "configuration-invalid",
      authenticated: true,
      disclosure: {
        provider: "openrouter",
        model: "example/read-only",
        dataPolicy: "bounded-redacted-proposals",
        retentionDays: 7,
        termsVersion: "2026-10-21",
      },
      consented: false,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(raw).not.toContain(OWNER);
  });

  it("allows a same-origin browser GET that omits the Origin header", async () => {
    const original = request("GET");
    const headers = new Headers(original.headers);
    headers.delete("origin");
    const response = await GET(new Request(original, { headers }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      activationReady: false,
      authenticated: true,
      consented: false,
    });
  });

  it("issues a hardened consent cookie bound to the authenticated scope", async () => {
    const accepted = await POST(request("POST", { body: { action: "accept" } }));
    expect(accepted.status).toBe(200);
    expect(await accepted.clone().json()).toMatchObject({
      configured: true,
      activationReady: false,
      activationBlock: "configuration-invalid",
    });
    const setCookie = accepted.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^__Host-pilot-hermes-consent=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    const token = setCookie.match(/^__Host-pilot-hermes-consent=([^;]+)/)![1]!;

    const sameScope = await GET(request("GET", {
      cookie: `${walletCookie()}; __Host-pilot-hermes-consent=${token}`,
    }));
    expect(await sameScope.json()).toMatchObject({ consented: true });

    const otherScope = await GET(request("GET", {
      cookie: `${walletCookie(OTHER_OWNER)}; __Host-pilot-hermes-consent=${token}`,
    }));
    expect(await otherScope.json()).toMatchObject({ consented: false });
  });

  it("maps only exhausted retention contention to a retryable response", async () => {
    vi.spyOn(HermesRetentionJournal.prototype, "acceptConsent")
      .mockRejectedValueOnce(new HermesRetentionContentionError());

    const response = await POST(request("POST", { body: { action: "accept" } }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      error: "Hermes consent state is temporarily busy.",
    });
  });

  it("keeps non-contention retention failures as non-retryable conflicts", async () => {
    vi.spyOn(HermesRetentionJournal.prototype, "acceptConsent")
      .mockRejectedValueOnce(new Error("unsafe state path"));

    const response = await POST(request("POST", { body: { action: "accept" } }));
    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      error: "Hermes workflow advisory configuration is invalid.",
    });
  });

  it("preserves request cancellation instead of converting it to a conflict", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(POST(request("POST", {
      body: { action: "accept" },
      signal: controller.signal,
    }))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("revokes consent without disclosing scope", async () => {
    const response = await DELETE(request("DELETE"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ consented: false });
    expect(response.headers.get("set-cookie")).toBe(
      "__Host-pilot-hermes-consent=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict",
    );
  });

  it("rejects a captured signed cookie after durable revocation", async () => {
    const accepted = await POST(request("POST", { body: { action: "accept" } }));
    const token = accepted.headers.get("set-cookie")!.match(/=([^;]+)/)![1]!;
    expect((await GET(request("GET", {
      cookie: `${walletCookie()}; __Host-pilot-hermes-consent=${token}`,
    }))).status).toBe(200);

    const revoked = await DELETE(request("DELETE", {
      cookie: `${walletCookie()}; __Host-pilot-hermes-consent=${token}`,
    }));
    expect(await revoked.json()).toMatchObject({
      consented: false,
      retention: { state: "no-sessions", remaining: 0 },
    });

    const replayed = await GET(request("GET", {
      cookie: `${walletCookie()}; __Host-pilot-hermes-consent=${token}`,
    }));
    expect(await replayed.json()).toMatchObject({ consented: false });
  });

  it("reports only verified Hermes DB-row absence for registered sessions", async () => {
    await POST(request("POST", { body: { action: "accept" } }));
    const statePath = join(stateDirectory, "state.json");
    const scopeDigest = hermesConsentScopeDigest({
      tenantId: "tenant-a",
      owner: OWNER,
      network: "testnet",
    }, CONSENT_SECRET);
    const journal = new HermesRetentionJournal(statePath);
    await journal.registerSession({
      scopeDigest,
      sessionId: "session-one",
      expectedConsentEpoch: 1,
      creationDeadline: Date.now() + 45_000,
      deleteAfter: Date.now() + 60_000,
    });
    await journal.settleSessionCreation({
      scopeDigest,
      sessionId: "session-one",
      expectedConsentEpoch: 1,
      outcome: "created",
    });
    vi.stubEnv("PILOT_HERMES_ORIGIN", "http://127.0.0.1:8642");
    vi.stubEnv("PILOT_HERMES_PROFILE", "pilot-proposal-v1");
    vi.stubEnv("PILOT_HERMES_API_KEY", "synthetic-profile-key-not-a-secret");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        object: "hermes.session.deleted",
        id: "session-one",
        deleted: true,
      }))
      .mockResolvedValueOnce(Response.json(
        { error: { code: "session_not_found" } },
        { status: 404 },
      ));
    vi.stubGlobal("fetch", fetcher);

    const response = await DELETE(request("DELETE"));
    expect(await response.json()).toMatchObject({
      consented: false,
      retention: {
        state: "database-absence-verified",
        attempted: 1,
        databaseAbsent: 1,
        remaining: 0,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("revokes consent but reports cleanup unverified without a deletion client", async () => {
    await POST(request("POST", { body: { action: "accept" } }));
    const scopeDigest = hermesConsentScopeDigest({
      tenantId: "tenant-a",
      owner: OWNER,
      network: "testnet",
    }, CONSENT_SECRET);
    const journal = new HermesRetentionJournal(join(stateDirectory, "state.json"));
    await journal.registerSession({
      scopeDigest,
      sessionId: "session-pending",
      expectedConsentEpoch: 1,
      creationDeadline: Date.now() + 45_000,
      deleteAfter: Date.now() + 60_000,
    });
    await journal.settleSessionCreation({
      scopeDigest,
      sessionId: "session-pending",
      expectedConsentEpoch: 1,
      outcome: "created",
    });

    const response = await DELETE(request("DELETE"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      consented: false,
      retention: {
        state: "unverified",
        attempted: 0,
        databaseAbsent: 0,
        remaining: 1,
      },
    });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("keeps revocation committed when cleanup and readiness fail afterward", async () => {
    await POST(request("POST", { body: { action: "accept" } }));
    const scopeDigest = hermesConsentScopeDigest({
      tenantId: "tenant-a",
      owner: OWNER,
      network: "testnet",
    }, CONSENT_SECRET);
    const journal = new HermesRetentionJournal(join(stateDirectory, "state.json"));
    await journal.registerSession({
      scopeDigest,
      sessionId: "session-cleanup-failure",
      expectedConsentEpoch: 1,
      creationDeadline: Date.now() + 45_000,
      deleteAfter: Date.now() + 60_000,
    });
    await journal.settleSessionCreation({
      scopeDigest,
      sessionId: "session-cleanup-failure",
      expectedConsentEpoch: 1,
      outcome: "created",
    });
    vi.stubEnv("PILOT_HERMES_ORIGIN", "http://127.0.0.1:8642");
    vi.stubEnv("PILOT_HERMES_PROFILE", "pilot-proposal-v1");
    vi.stubEnv("PILOT_HERMES_API_KEY", "synthetic-profile-key-not-a-secret");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
    runtimeReadiness.probe.mockRejectedValueOnce(new Error("readiness unavailable"));

    const response = await DELETE(request("DELETE"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      activationReady: false,
      activationBlock: "runtime-readiness-unavailable",
      consented: false,
      retention: {
        state: "unverified",
        remaining: 1,
      },
    });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await journal.consent(scopeDigest)).toMatchObject({ state: "revoked" });
  });

  it("expires browser consent when revocation commit durability is uncertain", async () => {
    vi.spyOn(HermesRetentionJournal.prototype, "revokeConsent")
      .mockRejectedValueOnce(new HermesRetentionCommitUncertainError());

    const response = await DELETE(request("DELETE"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      activationReady: false,
      activationBlock: "retention-revocation-commit-uncertain",
      consented: false,
      retention: {
        state: "unverified",
        remaining: null,
      },
    });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each([
    ["no wallet", { cookie: "" }, 401],
    ["foreign origin", { origin: "https://evil.example" }, 401],
    ["cross-site", { fetchSite: "cross-site" }, 401],
  ])("rejects %s", async (_label, options, expected) => {
    const response = await GET(request("GET", options));
    expect(response.status).toBe(expected);
  });

  it("rejects client-selected scope, disclosure, and malformed actions", async () => {
    for (const body of [
      { action: "accept", owner: OWNER },
      { action: "accept", provider: "other" },
      { action: "accept", retentionDays: 30 },
      { action: "revoke" },
      {},
    ]) {
      const response = await POST(request("POST", { body }));
      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("requires an exact JSON content type", async () => {
    const response = await POST(request("POST", {
      body: { action: "accept" },
      contentType: "text/plain",
    }));
    expect(response.status).toBe(415);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("is unavailable when default-off and fails closed for invalid configuration", async () => {
    vi.stubEnv("PILOT_HERMES_ENABLED", "0");
    const disabled = await GET(request("GET"));
    expect(disabled.status).toBe(404);
    expect(disabled.headers.get("set-cookie")).toBeNull();

    vi.stubEnv("PILOT_HERMES_ENABLED", "1");
    vi.stubEnv("PILOT_HERMES_RETENTION_DAYS", "31");
    const invalid = await POST(request("POST", { body: { action: "accept" } }));
    expect(invalid.status).toBe(409);
    expect(invalid.headers.get("set-cookie")).toBeNull();
  });

  it("never returns configured secrets in errors", async () => {
    vi.stubEnv("PILOT_HERMES_CONSENT_SECRET", `${CONSENT_SECRET}\ninvalid`);
    const response = await GET(request("GET"));
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain(CONSENT_SECRET);
    expect(text).not.toContain(SESSION_SECRET);
  });

  it("does not accept a consent cookie as wallet authentication", async () => {
    const accepted = await POST(request("POST", { body: { action: "accept" } }));
    const token = accepted.headers.get("set-cookie")!.match(/=([^;]+)/)![1]!;
    const response = await GET(request("GET", {
      cookie: `__Host-pilot-hermes-consent=${token}`,
    }));
    expect(response.status).toBe(401);
  });
});
