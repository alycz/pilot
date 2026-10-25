import {
  createVaultFromEnv,
  type PolicySync,
  type VaultEnvironment,
  type VaultService,
} from "@pilot/vault";

import {
  createHarborHostedStateClientFromEnv,
  type HostedStateEnvironment,
} from "./harbor-hosted-state-client";
import {
  HarborStructuredPreferenceStore,
  type HostedPersonalizationClient,
} from "./harbor-structured-preference-store";

export type AppVaultEnvironment = VaultEnvironment & HostedStateEnvironment & Readonly<{
  SESSION_SECRET?: string;
}>;

export type AppVaultDependencies = Readonly<{
  createHostedStateClient?: (
    environment: HostedStateEnvironment,
  ) => HostedPersonalizationClient;
}>;

/**
 * Server-only composition root for vault persistence.
 * Remote state is selected explicitly and never falls back to local storage.
 */
export function createAppVaultFromEnv(
  environment: AppVaultEnvironment = process.env,
  policySync?: PolicySync,
  dependencies: AppVaultDependencies = {},
): VaultService {
  const remoteSelected = environment.PILOT_STRUCTURED_PREFERENCES === "1" &&
    environment.PILOT_PERSONALIZATION_BACKEND?.trim() === "harbor-d1";
  if (remoteSelected && environment.PILOT_DEPLOYMENT_PROFILE !== "hosted") {
    throw new Error("harbor-d1 structured preferences require the exact hosted deployment profile");
  }
  let preferenceStore: HarborStructuredPreferenceStore | undefined;
  if (remoteSelected) {
    const sessionSecret = environment.SESSION_SECRET;
    if (!sessionSecret || sessionSecret !== sessionSecret.trim()) {
      throw new Error("SESSION_SECRET is required without surrounding whitespace for harbor-d1 preferences");
    }
    const clientFactory = dependencies.createHostedStateClient ??
      createHarborHostedStateClientFromEnv;
    preferenceStore = new HarborStructuredPreferenceStore(
      clientFactory(environment),
      sessionSecret,
    );
  }
  return createVaultFromEnv(environment, policySync, preferenceStore);
}
