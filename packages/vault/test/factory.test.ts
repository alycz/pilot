import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createVaultFromEnv } from "../src/factory";
import type { StructuredPreferenceStore } from "../src/preference-store";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "pilot-vault-factory-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

function remoteStore(): StructuredPreferenceStore {
  return {
    privateStorage: "remote",
    read: async () => null,
    compareAndSwap: async () => true,
    readWorkflowLessons: async () => null,
    compareAndSwapWorkflowLessons: async () => true,
  };
}

describe("createVaultFromEnv structured preference backend", () => {
  it("preserves local private storage as the default", async () => {
    const vaultRoot = await root();
    const stateRoot = await root();
    const service = createVaultFromEnv({
      VAULT_BACKEND: "fs",
      VAULT_PATH: vaultRoot,
      PILOT_STRUCTURED_PREFERENCES: "1",
      PILOT_PERSONALIZATION_STATE_DIR: stateRoot,
    });
    expect(service).toBeDefined();
  });

  it("requires an explicitly injected remote store for harbor-d1", async () => {
    const vaultRoot = await root();
    const environment = {
      VAULT_BACKEND: "fs",
      VAULT_PATH: vaultRoot,
      PILOT_STRUCTURED_PREFERENCES: "1",
      PILOT_PERSONALIZATION_BACKEND: "harbor-d1",
    } as const;
    expect(() => createVaultFromEnv(environment)).toThrow(/injected remote private store/i);
    expect(() => createVaultFromEnv(environment, undefined, remoteStore())).not.toThrow();
  });

  it("does not silently substitute local storage for an invalid or ambiguous remote setup", async () => {
    const vaultRoot = await root();
    const stateRoot = await root();
    expect(() => createVaultFromEnv({
      VAULT_BACKEND: "fs",
      VAULT_PATH: vaultRoot,
      PILOT_STRUCTURED_PREFERENCES: "1",
      PILOT_PERSONALIZATION_BACKEND: "harbor-d1",
      PILOT_PERSONALIZATION_STATE_DIR: stateRoot,
    }, undefined, remoteStore())).toThrow(/must not be set for harbor-d1/i);
    expect(() => createVaultFromEnv({
      VAULT_BACKEND: "fs",
      VAULT_PATH: vaultRoot,
      PILOT_STRUCTURED_PREFERENCES: "1",
      PILOT_PERSONALIZATION_BACKEND: "unknown",
      PILOT_PERSONALIZATION_STATE_DIR: stateRoot,
    })).toThrow(/exactly local or harbor-d1/i);
    expect(() => createVaultFromEnv({
      VAULT_BACKEND: "fs",
      VAULT_PATH: vaultRoot,
      PILOT_STRUCTURED_PREFERENCES: "1",
      PILOT_PERSONALIZATION_STATE_DIR: stateRoot,
    }, undefined, remoteStore())).toThrow(/local structured preferences cannot use an injected store/i);
    expect(() => createVaultFromEnv({
      VAULT_BACKEND: "fs",
      VAULT_PATH: vaultRoot,
      PILOT_STRUCTURED_PREFERENCES: "0",
      PILOT_PERSONALIZATION_BACKEND: "harbor-d1",
    }, undefined, remoteStore())).toThrow(/cannot be injected while the feature is disabled/i);
  });
});
