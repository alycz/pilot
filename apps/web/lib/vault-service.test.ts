import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostedPersonalizationClient } from "./harbor-structured-preference-store";
import { createAppVaultFromEnv, type AppVaultEnvironment } from "./vault-service";

const SECRET = "hosted-vault-service-test-secret-longer-than-thirty-two";
const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "pilot-app-vault-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

function client(): HostedPersonalizationClient {
  const rows = new Map<string, { ciphertext: string; contentDigest: string }>();
  const key = (input: { scopeId: string; resource: string }) => `${input.scopeId}:${input.resource}`;
  return {
    readPersonalization: async (input) =>
      rows.get(key(input)) ?? { ciphertext: null, contentDigest: null },
    compareAndSwapPersonalization: async (input) => {
      const rowKey = key(input);
      if ((rows.get(rowKey)?.contentDigest ?? null) !== input.expectedDigest) {
        return { swapped: false };
      }
      rows.set(rowKey, {
        ciphertext: input.ciphertext,
        contentDigest: input.contentDigest,
      });
      return { swapped: true };
    },
  };
}

async function remoteEnvironment(): Promise<AppVaultEnvironment> {
  return {
    VAULT_BACKEND: "fs",
    VAULT_PATH: await root(),
    PILOT_STRUCTURED_PREFERENCES: "1",
    PILOT_PERSONALIZATION_BACKEND: "harbor-d1",
    PILOT_DEPLOYMENT_PROFILE: "hosted",
    HARBOR_URL: "https://harbor.example",
    PILOT_HOSTED_STATE_API_KEY: `pilot:${"a".repeat(32)}`,
    SESSION_SECRET: SECRET,
  };
}

describe("createAppVaultFromEnv", () => {
  it("composes encrypted remote preferences only under the explicit backend", async () => {
    const createHostedStateClient = vi.fn(() => client());
    const service = createAppVaultFromEnv(
      await remoteEnvironment(),
      undefined,
      { createHostedStateClient },
    );
    await service.saveScopedProfile(
      { owner: OWNER, network: "testnet" },
      {
        main_account: OWNER,
        budget_account: OWNER,
        network: "testnet",
        risk: "low",
        preferences: [],
      },
    );
    const scope = { tenantId: "hosted-test", owner: OWNER, network: "testnet" as const };
    await service.proposeStructuredPreference(scope, {
      id: "preference-1",
      category: "presentation",
      key: "response_format",
      value: "Prefer concise summaries",
      origin: "explicit",
      evidence: { messageIds: ["message-1"], observedAt: "2026-10-25T00:00:00.000Z" },
      confidence: 1,
    }, 0, "proposal-1", new Date("2026-10-25T00:00:01.000Z"));

    await expect(service.readStructuredPreferences(scope)).resolves.toMatchObject({ revision: 1 });
    expect(createHostedStateClient).toHaveBeenCalledOnce();
  });

  it("preserves local storage without constructing a hosted client", async () => {
    const createHostedStateClient = vi.fn(() => client());
    const service = createAppVaultFromEnv({
      VAULT_BACKEND: "fs",
      VAULT_PATH: await root(),
      PILOT_STRUCTURED_PREFERENCES: "1",
      PILOT_PERSONALIZATION_STATE_DIR: await root(),
    }, undefined, { createHostedStateClient });
    expect(service).toBeDefined();
    expect(createHostedStateClient).not.toHaveBeenCalled();
  });

  it("fails closed instead of falling back when remote configuration is invalid", async () => {
    const environment = await remoteEnvironment();
    expect(() => createAppVaultFromEnv({ ...environment, SESSION_SECRET: "short" }, undefined, {
      createHostedStateClient: () => client(),
    })).toThrow(/32 bytes/i);
    expect(() => createAppVaultFromEnv(environment, undefined, {
      createHostedStateClient: () => {
        throw new Error("hosted state unavailable");
      },
    })).toThrow("hosted state unavailable");
  });

  it.each([
    ["missing", undefined],
    ["local", "local"],
    ["isolated", "isolated"],
    ["unknown", "unknown"],
  ])("rejects harbor-d1 under the %s deployment profile", async (_label, profile) => {
    const environment = await remoteEnvironment();
    expect(() => createAppVaultFromEnv({
      ...environment,
      PILOT_DEPLOYMENT_PROFILE: profile,
    }, undefined, {
      createHostedStateClient: () => client(),
    })).toThrow(/require the exact hosted deployment profile/i);
  });

  it("preserves local preference storage outside the hosted profile", async () => {
    const service = createAppVaultFromEnv({
      VAULT_BACKEND: "fs",
      VAULT_PATH: await root(),
      PILOT_STRUCTURED_PREFERENCES: "1",
      PILOT_PERSONALIZATION_BACKEND: "local",
      PILOT_PERSONALIZATION_STATE_DIR: await root(),
      PILOT_DEPLOYMENT_PROFILE: "isolated",
    });
    expect(service).toBeDefined();
  });
});
