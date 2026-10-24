import type { CardEvent } from "@pilot/contracts";
import {
  WALLET_PROVIDERS,
  type LedgerDeviceState,
  type CreateWalletOptions,
  type PilotWallet,
  type WalletProvider,
} from "@pilot/wallet";
import { isValidClassicAddress } from "xrpl";

import type { PublicPilotConfig } from "@/lib/harbor-browser";

export const XAMAN_UNAVAILABLE_REASON =
  "Unavailable: Xaman needs an app API key, and the current adapter cannot sign Pilot's non-broadcast wallet-auth proof safely.";

export type ConfiguredWalletMetadata = {
  provider: WalletProvider;
  account: string;
  ledger?: {
    transport: "webhid" | "virtual";
    accountIndex: number;
  };
};

function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === keys.length &&
    keys.every((key) => Object.hasOwn(value as object, key)),
  );
}

function ledgerMetadata(value: unknown): ConfiguredWalletMetadata["ledger"] {
  if (!isExactObject(value, ["transport", "accountIndex"])) {
    throw new Error("Reconnect the exact wallet used for this Pilot session before signing.");
  }
  if (
    (value.transport !== "webhid" && value.transport !== "virtual") ||
    !Number.isSafeInteger(value.accountIndex) ||
    Number(value.accountIndex) < 0 || Number(value.accountIndex) > 2
  ) {
    throw new Error("Reconnect the exact wallet used for this Pilot session before signing.");
  }
  return {
    transport: value.transport,
    accountIndex: Number(value.accountIndex),
  };
}

export function configuredWalletMetadata(
  raw: string | null,
  context: CardEvent["intent"]["network"] | PublicPilotConfig,
): ConfiguredWalletMetadata {
  const network = typeof context === "string" ? context : context.network;
  let stored: unknown;
  try {
    stored = JSON.parse(raw ?? "null");
  } catch {
    throw new Error("Reconnect the exact wallet used for this Pilot session before signing.");
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error("Reconnect the exact wallet used for this Pilot session before signing.");
  }
  const value = stored as Record<string, unknown>;
  const provider = value.provider;
  if (
    value.network !== network || typeof provider !== "string" ||
    !WALLET_PROVIDERS.includes(provider as WalletProvider) ||
    typeof value.account !== "string" || !isValidClassicAddress(value.account)
  ) {
    throw new Error("Reconnect the exact wallet used for this Pilot session before signing.");
  }
  const expectedKeys = provider === "ledger"
    ? ["provider", "network", "account", "ledger"]
    : ["provider", "network", "account"];
  if (!isExactObject(value, expectedKeys)) {
    throw new Error("Reconnect the exact wallet used for this Pilot session before signing.");
  }
  const ledger = provider === "ledger" ? ledgerMetadata(value.ledger) : undefined;
  const configured: ConfiguredWalletMetadata = {
    provider: provider as WalletProvider,
    account: value.account,
    ...(ledger === undefined ? {} : { ledger }),
  };
  if (typeof context !== "string") assertConfiguredWalletProviderPolicy(configured, context);
  return configured;
}

function assertConfiguredWalletProviderPolicy(
  configured: ConfiguredWalletMetadata,
  config: PublicPilotConfig,
): void {
  if (configured.provider === "xaman") {
    throw new Error(XAMAN_UNAVAILABLE_REASON);
  }
  if (configured.provider === "dev" && !config.devSignerEnabled) {
    throw new Error("The saved development wallet cannot be restored in this build.");
  }
  if (configured.provider === "ledger") {
    const transport = configured.ledger?.transport;
    if (
      transport === undefined || !config.ledger?.enabled ||
      !config.ledger.transports.includes(transport)
    ) {
      throw new Error("The saved Ledger transport is not enabled in this build.");
    }
  }
}

export function configuredWalletOptions(
  configured: ConfiguredWalletMetadata,
  network: CardEvent["intent"]["network"],
): CreateWalletOptions {
  return {
    provider: configured.provider,
    network,
    ...(configured.ledger === undefined ? {} : { ledger: configured.ledger }),
  };
}

export function isConfiguredLedgerFacade(
  configured: ConfiguredWalletMetadata,
  wallet: Pick<PilotWallet, "provider" | "custody" | "ledgerTransport">,
): boolean {
  if (configured.provider !== "ledger" || configured.ledger === undefined) return false;
  const { transport } = configured.ledger;
  return wallet.provider === "ledger" &&
    wallet.ledgerTransport === transport &&
    wallet.custody === (transport === "webhid" ? "hardware" : "software");
}

export function ledgerRebuildIdempotencyKey(
  randomId: () => string = () => globalThis.crypto.randomUUID(),
): string {
  const id = randomId();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("A fresh approval identity could not be created.");
  }
  return `ui-ledger-rebuild:${id.toLowerCase()}`;
}

export function ledgerDeviceReady(
  prepared: boolean,
  state: LedgerDeviceState,
): boolean {
  return prepared && !state.busy && state.interaction === "none";
}
