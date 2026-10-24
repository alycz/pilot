import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { StructuredPreferenceScope } from "@pilot/vault";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  sealWalletSession,
  WALLET_SESSION_COOKIE,
} from "../../../../../lib/wallet-session";

import { getVaultService } from "../../_lib/service";
import { POST } from "./route";

const SESSION_SECRET = "structured-preference-route-test-secret-longer-than-thirty-two";
const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER_OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const OBSERVED_AT = "2026-10-21T01:00:00.000Z";
let vaultRoot: string;
let personalizationRoot: string;

function cookie(owner: string): string {
  const sealed = sealWalletSession({
    version: 1,
    account: owner,
    network: "testnet",
    expiresAt: Date.now() + 60_000,
  }, SESSION_SECRET);
  return `${WALLET_SESSION_COOKIE}=${encodeURIComponent(sealed)}`;
}

function browserRequest(owner: string, body: Record<string, unknown>): Request {
  return new Request("http://next-internal:3000/api/vault/preferences/structured", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookie(owner),
      origin: "https://pilot.example",
      "sec-fetch-site": "same-origin",
      forwarded: "for=203.0.113.7;proto=http;host=attacker.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
    },
    body: JSON.stringify(body),
  });
}

async function payload(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

function scope(tenantId: string, owner = OWNER): StructuredPreferenceScope {
  return { tenantId, owner, network: "testnet" };
}

async function seedProposal(tenantId: string, id: string, key = "response_format") {
  const service = getVaultService();
  return service.proposeStructuredPreference(scope(tenantId), {
    id,
    category: "presentation",
    key,
    value: "Prefer concise summaries",
    origin: "explicit",
    evidence: { messageIds: [`message-${id}`], observedAt: OBSERVED_AT },
    confidence: 1,
  }, 0, `propose-${id}`, new Date("2026-10-21T01:01:00.000Z"));
}

beforeAll(async () => {
  vaultRoot = await mkdtemp(path.join(tmpdir(), "pilot-structured-route-"));
  personalizationRoot = `${vaultRoot}-personalization`;
  vi.stubEnv("VAULT_BACKEND", "fs");
  vi.stubEnv("VAULT_PATH", vaultRoot);
  vi.stubEnv("PILOT_PERSONALIZATION_STATE_DIR", personalizationRoot);
  vi.stubEnv("PILOT_STRUCTURED_PREFERENCES", "1");
  vi.stubEnv("HARBOR_MOCK", "1");
  vi.stubEnv("PILOT_DEPLOYMENT_PROFILE", "hosted");
  vi.stubEnv("PILOT_PUBLIC_ORIGIN", "https://pilot.example");
  vi.stubEnv("NEXT_PUBLIC_DEV_SIGNER", "0");
  vi.stubEnv("EXEC_NETWORK", "testnet");
  vi.stubEnv("SESSION_SECRET", SESSION_SECRET);
  const service = getVaultService();
  for (const owner of [OWNER, OTHER_OWNER]) {
    await service.saveScopedProfile(
      { owner, network: "testnet" },
      {
        main_account: owner,
        budget_account: owner,
        network: "testnet",
        risk: "low",
        preferences: [],
      },
    );
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all([
    rm(vaultRoot, { recursive: true, force: true }),
    rm(personalizationRoot, { recursive: true, force: true }),
  ]);
});

describe("structured preference route", () => {
  it("is default-off and requires a server-configured tenant when enabled", async () => {
    vi.stubEnv("PILOT_STRUCTURED_PREFERENCES", "0");
    vi.stubEnv("PILOT_PERSONALIZATION_TENANT_ID", "ignored-tenant");
    const disabled = await POST(browserRequest(OWNER, { action: "list" }));
    expect(disabled.status).toBe(404);
    expect((await payload(disabled)).error.code).toBe("STRUCTURED_PREFERENCES_DISABLED");

    vi.stubEnv("PILOT_STRUCTURED_PREFERENCES", "1");
    vi.stubEnv("PILOT_PERSONALIZATION_TENANT_ID", "");
    const missingTenant = await POST(browserRequest(OWNER, { action: "list" }));
    expect(missingTenant.ok).toBe(false);
    expect((await payload(missingTenant)).error.message).toMatch(/tenant identity is not configured/i);
  });

  it("rejects client-selected tenant, owner, or network scope", async () => {
    vi.stubEnv("PILOT_STRUCTURED_PREFERENCES", "1");
    vi.stubEnv("PILOT_PERSONALIZATION_TENANT_ID", "route-scope-test");
    for (const injected of [
      { tenantId: "foreign" },
      { tenant_id: "foreign" },
      { owner: OTHER_OWNER },
      { network: "devnet" },
    ]) {
      const response = await POST(browserRequest(OWNER, { action: "list", ...injected }));
      expect(response.ok).toBe(false);
      expect((await payload(response)).error.message).toMatch(/server-derived/i);
    }
    const unknown = await POST(browserRequest(OWNER, { action: "list", extra: true }));
    expect(unknown.status).toBe(400);
    expect((await payload(unknown)).error.message).toMatch(/unsupported fields/i);
  });

  it("lists, accepts, corrects, and forgets with conflicts and exact idempotent replay", async () => {
    const tenantId = "route-lifecycle-test";
    vi.stubEnv("PILOT_STRUCTURED_PREFERENCES", "1");
    vi.stubEnv("PILOT_PERSONALIZATION_TENANT_ID", tenantId);
    await seedProposal(tenantId, "pref-route-1");

    const listed = await POST(browserRequest(OWNER, { action: "list" }));
    expect(listed.status).toBe(200);
    expect((await payload(listed)).data).toMatchObject({
      revision: 1,
      records: [{ id: "pref-route-1", status: "proposed", version: 1 }],
    });

    const acceptBody = {
      action: "accept",
      recordId: "pref-route-1",
      expectedRevision: 1,
      expectedVersion: 1,
      idempotencyKey: "route-accept-1",
    };
    const accepted = await POST(browserRequest(OWNER, acceptBody));
    expect(accepted.status).toBe(200);
    expect((await payload(accepted)).data).toMatchObject({
      revision: 2,
      idempotent: false,
      record: { id: "pref-route-1", status: "accepted", version: 2 },
    });

    const replayed = await POST(browserRequest(OWNER, acceptBody));
    expect(replayed.status).toBe(200);
    expect((await payload(replayed)).data).toMatchObject({ revision: 2, idempotent: true });

    const stale = await POST(browserRequest(OWNER, {
      action: "correct",
      recordId: "pref-route-1",
      expectedRevision: 1,
      expectedVersion: 2,
      idempotencyKey: "route-stale-correction",
      value: "Prefer bullet summaries",
    }));
    expect(stale.ok).toBe(false);
    expect((await payload(stale)).error.message).toMatch(/revision conflict/i);

    const wrongVersion = await POST(browserRequest(OWNER, {
      action: "correct",
      recordId: "pref-route-1",
      expectedRevision: 2,
      expectedVersion: 1,
      idempotencyKey: "route-wrong-version",
      value: "Prefer bullet summaries",
    }));
    expect(wrongVersion.ok).toBe(false);
    expect((await payload(wrongVersion)).error.message).toMatch(/version conflict/i);

    const correctionBody = {
      action: "correct",
      recordId: "pref-route-1",
      expectedRevision: 2,
      expectedVersion: 2,
      idempotencyKey: "route-correct-1",
      value: "Prefer bullet summaries",
    };
    const corrected = await POST(browserRequest(OWNER, correctionBody));
    expect(corrected.status).toBe(200);
    const correctedPayload = await payload(corrected);
    expect(correctedPayload.data).toMatchObject({
      revision: 3,
      record: {
        status: "accepted",
        version: 1,
        value: "Prefer bullet summaries",
        supersedes: "pref-route-1",
      },
    });
    const replacementId = correctedPayload.data.record.id as string;
    const correctionReplay = await POST(browserRequest(OWNER, correctionBody));
    expect(correctionReplay.status).toBe(200);
    expect((await payload(correctionReplay)).data).toMatchObject({
      revision: 3,
      idempotent: true,
      record: { id: replacementId, value: "Prefer bullet summaries" },
    });

    const forgotten = await POST(browserRequest(OWNER, {
      action: "forget",
      recordId: replacementId,
      expectedRevision: 3,
      expectedVersion: 1,
      idempotencyKey: "route-forget-1",
    }));
    expect(forgotten.status).toBe(200);
    expect((await payload(forgotten)).data).toMatchObject({ revision: 4, records: [] });
    const afterForget = await POST(browserRequest(OWNER, { action: "list" }));
    expect((await payload(afterForget)).data).toEqual({ revision: 4, records: [] });
  });

  it("keeps records isolated from another authenticated wallet", async () => {
    const tenantId = "route-wallet-isolation";
    vi.stubEnv("PILOT_STRUCTURED_PREFERENCES", "1");
    vi.stubEnv("PILOT_PERSONALIZATION_TENANT_ID", tenantId);
    await seedProposal(tenantId, "pref-owner-only", "tone");

    const ownerList = await POST(browserRequest(OWNER, { action: "list" }));
    expect((await payload(ownerList)).data.records).toHaveLength(1);
    const otherList = await POST(browserRequest(OTHER_OWNER, { action: "list" }));
    expect(otherList.status).toBe(200);
    expect((await payload(otherList)).data).toEqual({ revision: 0, records: [] });

    const crossWalletMutation = await POST(browserRequest(OTHER_OWNER, {
      action: "accept",
      recordId: "pref-owner-only",
      expectedRevision: 0,
      expectedVersion: 1,
      idempotencyKey: "cross-wallet-accept",
    }));
    expect(crossWalletMutation.ok).toBe(false);
    expect((await payload(crossWalletMutation)).error.message).toMatch(/not found/i);
    const ownerAfter = await POST(browserRequest(OWNER, { action: "list" }));
    expect((await payload(ownerAfter)).data.records[0]).toMatchObject({
      id: "pref-owner-only",
      status: "proposed",
    });
  });
});
