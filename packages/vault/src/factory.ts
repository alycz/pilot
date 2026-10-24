import path from "node:path";

import { GitHubVaultBackend } from "./backends/github";
import { FsVaultBackend } from "./backends/fs";
import { FsStructuredPreferenceStore } from "./preference-store";
import type { PolicySync, VaultEnvironment } from "./types";
import { VaultService } from "./vault";

export function createVaultFromEnv(
  environment: VaultEnvironment = {
    VAULT_BACKEND: process.env.VAULT_BACKEND,
    VAULT_PATH: process.env.VAULT_PATH,
    VAULT_GITHUB_TOKEN: process.env.VAULT_GITHUB_TOKEN,
    VAULT_REPO: process.env.VAULT_REPO,
    PILOT_PERSONALIZATION_STATE_DIR: process.env.PILOT_PERSONALIZATION_STATE_DIR,
    PILOT_STRUCTURED_PREFERENCES: process.env.PILOT_STRUCTURED_PREFERENCES,
  },
  policySync?: PolicySync,
): VaultService {
  const backend = environment.VAULT_BACKEND?.trim() || "fs";
  const personalizationFlag = environment.PILOT_STRUCTURED_PREFERENCES;
  if (personalizationFlag !== undefined && personalizationFlag !== "0" && personalizationFlag !== "1") {
    throw new Error("PILOT_STRUCTURED_PREFERENCES must be exactly 0 or 1");
  }
  const personalizationPath = personalizationFlag === "1"
    ? environment.PILOT_PERSONALIZATION_STATE_DIR?.trim()
    : undefined;
  if (personalizationFlag === "1" && !personalizationPath) {
    throw new Error("PILOT_PERSONALIZATION_STATE_DIR is required when structured preferences are enabled");
  }
  if (backend === "fs" && personalizationPath && environment.VAULT_PATH) {
    const vaultPath = path.resolve(environment.VAULT_PATH);
    const privatePath = path.resolve(personalizationPath);
    const relative = path.relative(vaultPath, privatePath);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw new Error("Personalization state must be outside the Git-backed vault path");
    }
  }
  const personalizationStore = personalizationPath
    ? new FsStructuredPreferenceStore(
        personalizationPath,
        backend === "fs" ? environment.VAULT_PATH : undefined,
      )
    : undefined;
  if (backend === "fs") {
    if (!environment.VAULT_PATH) throw new Error("VAULT_PATH is required for the fs vault backend");
    return new VaultService(new FsVaultBackend(environment.VAULT_PATH), {
      policySync,
      ...(personalizationStore ? { personalizationStore } : {}),
    });
  }
  if (backend === "github") {
    if (!environment.VAULT_REPO) throw new Error("VAULT_REPO is required for the github vault backend");
    if (!environment.VAULT_GITHUB_TOKEN) {
      throw new Error("VAULT_GITHUB_TOKEN is required for the github vault backend");
    }
    return new VaultService(
      new GitHubVaultBackend({
        repository: environment.VAULT_REPO,
        token: environment.VAULT_GITHUB_TOKEN,
      }),
      { policySync, ...(personalizationStore ? { personalizationStore } : {}) },
    );
  }
  throw new Error(`Unsupported VAULT_BACKEND: ${backend}`);
}
