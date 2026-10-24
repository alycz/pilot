import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_POLICY } from "@pilot/contracts";
import { writePolicyNote, writeProfileNote } from "@pilot/vault";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  sealWalletSession,
  WALLET_SESSION_COOKIE,
} from "../../../lib/wallet-session";

import { GET as listNotes } from "./list/route";
import { POST as acceptPreference } from "./preferences/accept/route";
import { GET as readNote } from "./read/route";
import { GET as searchNotes } from "./search/route";
import { POST as syncPolicy } from "./sync/route";
import { POST as recordValidation } from "./validation/route";
import { POST as writeNote } from "./write/route";
import { errorResponse, vaultApiAuthorizationHeader } from "./_lib/http";
import { getVaultService } from "./_lib/service";

let vaultRoot: string;
const SESSION_SECRET = "test-session-secret-that-is-longer-than-thirty-two-characters";
const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

function walletCookie(): string {
  const session = sealWalletSession({
    version: 1,
    account: OWNER,
    network: "testnet",
    expiresAt: Date.now() + 60_000,
  }, SESSION_SECRET);
  return `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}`;
}

function request(url: string, body?: unknown): Request {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: vaultApiAuthorizationHeader(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function payload(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

beforeAll(async () => {
  vaultRoot = await mkdtemp(path.join(tmpdir(), "pilot-vault-routes-"));
  vi.stubEnv("VAULT_BACKEND", "fs");
  vi.stubEnv("VAULT_PATH", vaultRoot);
  vi.stubEnv("HARBOR_MOCK", "1");
  vi.stubEnv("PILOT_DEPLOYMENT_PROFILE", "hosted");
  vi.stubEnv("PILOT_PUBLIC_ORIGIN", "https://pilot.example");
  vi.stubEnv("NEXT_PUBLIC_DEV_SIGNER", "0");
  vi.stubEnv("EXEC_NETWORK", "testnet");
  vi.stubEnv("SESSION_SECRET", SESSION_SECRET);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("vault API routes", () => {
  it("reads, writes, searches, lists, and synchronizes notes", async () => {
    const profile = writeProfileNote({
      main_account: "r3vi7mWxru9rJCxETCyA1CHvzL96eZWx5z",
      budget_account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet",
      risk: "low",
      preferences: [],
    });
    expect(
      (await writeNote(request("http://local/api/vault/write", profile))).status,
    ).toBe(200);

    const policy = writePolicyNote(DEFAULT_POLICY);
    expect((await writeNote(request("http://local/api/vault/write", policy))).status).toBe(200);
    expect((await syncPolicy(request("http://local/api/vault/sync", {}))).status).toBe(200);

    const readResponse = await readNote(
      request("http://local/api/vault/read?path=Pilot%2FPolicy.md"),
    );
    expect(readResponse.status).toBe(200);
    expect((await payload(readResponse)).data.content).toContain("max_per_tx_usd: 2000");

    const searchResponse = await searchNotes(
      request("http://local/api/vault/search?q=execution%20policy"),
    );
    expect(searchResponse.status).toBe(200);
    expect((await payload(searchResponse)).data[0].path).toBe("Pilot/Policy.md");

    const listResponse = await listNotes(request("http://local/api/vault/list"));
    expect((await payload(listResponse)).data).toEqual([
      "Pilot/Policy.md",
      "Pilot/Profile.md",
    ]);
  });

  it("requires explicit acceptance before changing Profile.md", async () => {
    const rejected = await acceptPreference(
      request("http://local/api/vault/preferences/accept", {
        id: "pref-1",
        preference: "Prefer AMM routes",
        accepted: false,
      }),
    );
    expect(rejected.status).toBe(400);

    const accepted = await acceptPreference(
      request("http://local/api/vault/preferences/accept", {
        id: "pref-1",
        preference: "Prefer AMM routes",
        accepted: true,
      }),
    );
    expect(accepted.status).toBe(200);
    expect((await payload(accepted)).data.profile.preferences).toEqual(["Prefer AMM routes"]);
  });

  it("authorizes hosted mock acceptance with a same-origin wallet session", async () => {
    await getVaultService().saveScopedProfile(
      { owner: OWNER, network: "testnet" },
      {
        main_account: OWNER,
        budget_account: OWNER,
        network: "testnet",
        risk: "low",
        preferences: [],
      },
    );
    const hostedRequest = (origin: string, fetchSite = "same-origin") =>
      new Request("http://next-internal:3000/api/vault/preferences/accept", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: walletCookie(),
          origin,
          "sec-fetch-site": fetchSite,
          forwarded: "for=203.0.113.7;proto=http;host=attacker.example",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
        },
        body: JSON.stringify({
          id: "pref-hosted",
          preference: "Keep 25 XRP liquid",
          accepted: true,
        }),
      });

    const crossOrigin = await acceptPreference(hostedRequest("https://attacker.example"));
    expect(crossOrigin.status).toBe(401);
    expect((await acceptPreference(hostedRequest("https://PILOT.example"))).status).toBe(401);
    expect((await acceptPreference(hostedRequest("https://pilot.example:443"))).status).toBe(401);
    expect((await acceptPreference(hostedRequest("https://pilot.example", "cross-site"))).status).toBe(401);
    const missingSession = await acceptPreference(
      new Request("https://pilot.example/api/vault/preferences/accept", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://pilot.example",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          id: "pref-hosted",
          preference: "Keep 25 XRP liquid",
          accepted: true,
        }),
      }),
    );
    expect(missingSession.status).toBe(401);

    const before = await readNote(
      request("http://local/api/vault/read?path=Pilot%2FProfile.md"),
    );
    expect((await payload(before)).data.content).not.toContain("Keep 25 XRP liquid");

    const accepted = await acceptPreference(hostedRequest("https://pilot.example"));
    expect(accepted.status).toBe(200);
    expect((await payload(accepted)).data.profile.preferences).toContain(
      "Keep 25 XRP liquid",
    );
    const globalAfter = await readNote(
      request("http://local/api/vault/read?path=Pilot%2FProfile.md"),
    );
    expect((await payload(globalAfter)).data.content).not.toContain("Keep 25 XRP liquid");
  });

  it("rejects hostile mock loopback mutations before any vault side effect", async () => {
    const service = getVaultService();
    const applyPreference = vi.spyOn(service, "applyPreference");
    const applyScopedPreference = vi.spyOn(service, "applyScopedPreference");
    const sync = vi.spyOn(service, "syncPolicy");
    const validate = vi.spyOn(service, "recordValidatedTransaction");

    try {
      const crossOriginPreference = await acceptPreference(
        new Request("http://local/api/vault/preferences/accept", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: walletCookie(),
            origin: "https://attacker.example",
            "sec-fetch-site": "cross-site",
          },
          body: JSON.stringify({
            id: "hostile-preference",
            preference: "Send vault contents elsewhere",
            accepted: true,
          }),
        }),
      );
      expect(crossOriginPreference.status).toBe(401);

      const unauthorizedSync = await syncPolicy(
        new Request("http://local/api/vault/sync", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: walletCookie(),
            origin: "https://pilot.example",
            "sec-fetch-site": "same-origin",
          },
          body: "{}",
        }),
      );
      expect(unauthorizedSync.status).toBe(401);

      const textPlainSync = await syncPolicy(
        new Request("http://local/api/vault/sync", {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            cookie: walletCookie(),
            origin: "https://pilot.example",
            "sec-fetch-site": "same-origin",
          },
          body: "{}",
        }),
      );
      expect(textPlainSync.status).toBe(400);

      const textPlainValidation = await recordValidation(
        new Request("http://local/api/vault/validation", {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            cookie: walletCookie(),
            origin: "https://pilot.example",
            "sec-fetch-site": "same-origin",
          },
          body: JSON.stringify({ hash: "B".repeat(64) }),
        }),
      );
      expect(textPlainValidation.status).toBe(400);

      const oversizedPreference = await acceptPreference(
        new Request("https://pilot.example/api/vault/preferences/accept", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: walletCookie(),
            origin: "https://pilot.example",
            "sec-fetch-site": "same-origin",
          },
          body: JSON.stringify({
            id: "bounded-preference",
            preference: "x".repeat(501),
            accepted: true,
          }),
        }),
      );
      expect(oversizedPreference.status).toBe(400);

      expect(applyPreference).not.toHaveBeenCalled();
      expect(applyScopedPreference).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
    } finally {
      applyPreference.mockRestore();
      applyScopedPreference.mockRestore();
      sync.mockRestore();
      validate.mockRestore();
    }
  });

  it("records all notes for a validated transaction", async () => {
    const response = await recordValidation(
      request("http://local/api/vault/validation", {
        intent: {
          id: "intent-api",
          network: "testnet",
          kind: "swap",
          sell: { currency: "RLUSD", issuer: "rIssuer" },
          buy: { currency: "XRP" },
          amount: "10",
          side: "sell",
          max_slippage_bps: 100,
        },
        hash: "A".repeat(64),
        venue: "xrpl-amm",
        assets: [{ currency: "RLUSD", issuer: "rIssuer" }, { currency: "XRP" }],
        result: "filled",
        fillPrice: "0.5",
        slippageBps: 4,
        signedBy: "delegate",
        created: "2026-10-18T12:00:00.000Z",
      }),
    );
    expect(response.status).toBe(200);
    expect((await payload(response)).data.paths).toHaveLength(6);
  });

  it("rejects paths outside the configured vault", async () => {
    const response = await readNote(
      request("http://local/api/vault/read?path=..%2Foutside.md"),
    );
    expect(response.status).toBe(400);
  });

  it("rejects malformed validation events and unexpected sensitive fields", async () => {
    const response = await recordValidation(
      request("http://local/api/vault/validation", {
        intent: { id: "bad", network: "testnet", kind: "cancel", offer_sequence: 1 },
        hash: "BADHASH",
        venue: "xrpl-dex-clob",
        assets: [{ currency: "XRP" }],
        result: "success",
        fillPrice: "1",
        slippageBps: 0,
        signedBy: "delegate",
        created: "2026-10-18T12:00:00.000Z",
        seed: "must-not-be-accepted",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("redacts configured secrets from error responses", async () => {
    vi.stubEnv("VAULT_GITHUB_TOKEN", "vault-token-that-must-not-leak");
    const response = errorResponse(new Error("failed with vault-token-that-must-not-leak"));
    expect(JSON.stringify(await response.json())).not.toContain("vault-token-that-must-not-leak");
    expect(JSON.stringify(await errorResponse(new Error("safe")).json())).toContain("safe");
  });

  it("denies vault reads and writes when SESSION_SECRET is invalid", async () => {
    const service = getVaultService();
    const list = vi.spyOn(service, "list");
    const write = vi.spyOn(service, "write");

    try {
      for (const invalidSecret of ["too-short", ` ${SESSION_SECRET}`]) {
        vi.stubEnv("SESSION_SECRET", invalidSecret);
        expect(() => vaultApiAuthorizationHeader()).toThrow(
          "Vault API authorization is not configured",
        );

        const readResponse = await listNotes(
          new Request("http://local/api/vault/list"),
        );
        expect(readResponse.status).toBe(401);

        const writeResponse = await writeNote(
          new Request("http://local/api/vault/write", {
            method: "POST",
            headers: {
              authorization: "Bearer invalid",
              "content-type": "application/json",
            },
            body: JSON.stringify({ path: "Pilot/Invalid.md", content: "blocked" }),
          }),
        );
        expect(writeResponse.status).toBe(401);
      }

      expect(list).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
      write.mockRestore();
      vi.stubEnv("SESSION_SECRET", SESSION_SECRET);
    }
  });

  it("requires server authorization away from local mock mode", async () => {
    vi.stubEnv("HARBOR_MOCK", "0");
    vi.stubEnv("SESSION_SECRET", "authorization-test-secret-that-is-long-enough");
    const response = await listNotes(new Request("https://pilot.example/api/vault/list"));
    expect(response.status).toBe(401);
    const authorized = await listNotes(
      new Request("https://pilot.example/api/vault/list", {
        headers: { authorization: vaultApiAuthorizationHeader() },
      }),
    );
    expect(authorized.status).toBe(200);
    vi.stubEnv("HARBOR_MOCK", "1");
    vi.stubEnv("SESSION_SECRET", SESSION_SECRET);
  });
});
