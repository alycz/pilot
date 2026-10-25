import {
  PublicPilotConfigSchema,
  type PublicPilotConfig,
} from "../../../../lib/harbor-browser";
import { resolveStableAsset } from "../../../../lib/stable-asset";
import { isHarborHostedStateConfigured } from "../../../../lib/harbor-hosted-state-client";
import { validateWalletActionProofDirectory } from "../../../../lib/wallet-action-proof";
import {
  resolveProfileDevSignerEnabled,
  resolveProfileLedgerConfig,
  resolveProfilePublicBuildMarker,
  resolveProfileWalletActionProofRequired,
} from "../../../../lib/runtime-profile";
import { resolveStructuredPreferenceTenant } from "../../../../lib/structured-preferences";

export async function resolveWalletActionProofConfigured(
  environment: Readonly<Record<string, string | undefined>>,
  validateDirectory: (directory: string | undefined) => Promise<string> =
    validateWalletActionProofDirectory,
): Promise<boolean> {
  const secret = environment.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) return false;
  if (environment.PILOT_DEPLOYMENT_PROFILE === "hosted") {
    return isHarborHostedStateConfigured(environment);
  }
  try {
    await validateDirectory(environment.P_LIVE_RLUSD_ACQUISITION_STATE_DIR);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePublicPilotConfig(
  environment: Readonly<Record<string, string | undefined>>,
  request: Request,
  validateDirectory: (directory: string | undefined) => Promise<string> =
    validateWalletActionProofDirectory,
): Promise<PublicPilotConfig> {
  const network = environment.EXEC_NETWORK?.trim() || "testnet";
  if (network !== "testnet" && network !== "devnet") {
    throw new Error("UNSUPPORTED_PUBLIC_NETWORK");
  }

  const stableAsset = resolveStableAsset(environment, network);
  const harborMode = environment.HARBOR_MOCK;
  if (harborMode !== "0" && harborMode !== "1") {
    throw new Error("UNSUPPORTED_PUBLIC_HARBOR_MODE");
  }

  const buildMarker = resolveProfilePublicBuildMarker(environment);
  const personalizationTenant = resolveStructuredPreferenceTenant(environment);
  if (personalizationTenant) {
    const backend = environment.PILOT_PERSONALIZATION_BACKEND?.trim() || "local";
    if (backend === "harbor-d1") {
      const secret = environment.SESSION_SECRET;
      if (
        environment.PILOT_DEPLOYMENT_PROFILE !== "hosted" ||
        environment.PILOT_PERSONALIZATION_STATE_DIR?.trim() ||
        !secret || secret !== secret.trim() || Buffer.byteLength(secret, "utf8") < 32 ||
        !isHarborHostedStateConfigured(environment)
      ) {
        throw new Error("STRUCTURED_PREFERENCE_STORAGE_NOT_CONFIGURED");
      }
    } else if (backend !== "local" || !environment.PILOT_PERSONALIZATION_STATE_DIR?.trim()) {
      throw new Error("STRUCTURED_PREFERENCE_STORAGE_NOT_CONFIGURED");
    }
  }
  const ledger = resolveProfileLedgerConfig(environment, request);
  return PublicPilotConfigSchema.parse({
    ...(buildMarker === undefined ? {} : { buildMarker }),
    network,
    stableAsset: { currency: stableAsset.displayCurrency, issuer: stableAsset.issuer },
    devSignerEnabled: resolveProfileDevSignerEnabled(environment, request),
    walletActionProofRequired: resolveProfileWalletActionProofRequired(environment, request),
    walletActionProofConfigured: await resolveWalletActionProofConfigured(
      environment,
      validateDirectory,
    ),
    mockMode: harborMode === "1",
    ledger: {
      enabled: ledger.enabled,
      transports: ledger.transports,
      defaultAccountIndex: ledger.defaultAccountIndex,
    },
    ...(personalizationTenant ? { structuredPreferencesEnabled: true } : {}),
  });
}
