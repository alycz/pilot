import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ledgerSigningMode } from "@pilot/wallet";

import type { PublicPilotConfig } from "@/lib/harbor-browser";

import {
  XAMAN_UNAVAILABLE_REASON,
  configuredWalletMetadata,
  configuredWalletOptions,
  ledgerDeviceReady,
  ledgerRebuildIdempotencyKey,
} from "./configured-wallet";

const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const PUBLIC_CONFIG: PublicPilotConfig = {
  network: "testnet",
  stableAsset: { currency: "RLUSD", issuer: ACCOUNT },
  devSignerEnabled: false,
  walletActionProofRequired: true,
  walletActionProofConfigured: true,
  mockMode: false,
  ledger: { enabled: false, transports: [], defaultAccountIndex: 0 },
};

describe("chat wallet restoration", () => {
  it("keeps Ledger provenance display client-local and never posts it to the vault", () => {
    const source = readFileSync(new URL("./chat-view.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("ledger-owner-validation");
    expect(source).not.toContain("ownerSigner:");
    expect(source).toContain("setOwnerSigners");
  });

  it("requires exact stored wallet metadata instead of defaulting to the dev signer", () => {
    for (const raw of [null, "not-json", "{}", JSON.stringify({
      provider: "dev",
      network: "devnet",
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
    }), JSON.stringify({
      provider: "dev",
      network: "testnet",
    }), JSON.stringify({
      provider: "unknown",
      network: "testnet",
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
    }), JSON.stringify({
      provider: "dev",
      network: "testnet",
      account: "not-an-xrpl-account",
    })]) {
      expect(() => configuredWalletMetadata(raw, "testnet")).toThrow(
        "Reconnect the exact wallet",
      );
    }
  });

  it("restores only the explicitly recorded provider and public account", () => {
    expect(configuredWalletMetadata(JSON.stringify({
      provider: "dev",
      network: "testnet",
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
    }), "testnet")).toEqual({
      provider: "dev",
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
    });
  });

  it("restores only strict bounded Ledger transport metadata", () => {
    const configured = configuredWalletMetadata(JSON.stringify({
      provider: "ledger",
      network: "testnet",
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      ledger: { transport: "virtual", accountIndex: 2 },
    }), "testnet");
    expect(configured).toEqual({
      provider: "ledger",
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      ledger: { transport: "virtual", accountIndex: 2 },
    });
    expect(configuredWalletOptions(configured, "testnet")).toEqual({
      provider: "ledger",
      network: "testnet",
      ledger: { transport: "virtual", accountIndex: 2 },
    });

    for (const ledger of [
      undefined,
      { transport: "bluetooth", accountIndex: 2 },
      { transport: "webhid", accountIndex: -1 },
      { transport: "webhid", accountIndex: 3 },
      { transport: "virtual", accountIndex: 2, seed: "forbidden" },
    ]) {
      expect(() => configuredWalletMetadata(JSON.stringify({
        provider: "ledger",
        network: "testnet",
        account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        ...(ledger === undefined ? {} : { ledger }),
      }), "testnet")).toThrow("Reconnect the exact wallet");
    }
  });

  it("rejects Ledger metadata on a non-Ledger wallet", () => {
    expect(() => configuredWalletMetadata(JSON.stringify({
      provider: "dev",
      network: "testnet",
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      ledger: { transport: "virtual", accountIndex: 0 },
    }), "testnet")).toThrow("Reconnect the exact wallet");
  });

  it("rejects a saved Ledger wallet when hosted configuration disables Ledger", () => {
    expect(() => configuredWalletMetadata(JSON.stringify({
      provider: "ledger",
      network: "testnet",
      account: ACCOUNT,
      ledger: { transport: "webhid", accountIndex: 0 },
    }), PUBLIC_CONFIG)).toThrow("The saved Ledger transport is not enabled in this build.");
  });

  it("rejects a saved Ledger transport outside the local allowlist", () => {
    expect(() => configuredWalletMetadata(JSON.stringify({
      provider: "ledger",
      network: "testnet",
      account: ACCOUNT,
      ledger: { transport: "virtual", accountIndex: 0 },
    }), {
      ...PUBLIC_CONFIG,
      ledger: { enabled: true, transports: ["webhid"], defaultAccountIndex: 0 },
    })).toThrow("The saved Ledger transport is not enabled in this build.");
  });

  it("rejects a saved development signer when the public build disables it", () => {
    expect(() => configuredWalletMetadata(JSON.stringify({
      provider: "dev",
      network: "testnet",
      account: ACCOUNT,
    }), PUBLIC_CONFIG)).toThrow("The saved development wallet cannot be restored in this build.");
  });

  it("rejects Xaman with the exact explicit unavailable reason", () => {
    expect(() => configuredWalletMetadata(JSON.stringify({
      provider: "xaman",
      network: "testnet",
      account: ACCOUNT,
    }), PUBLIC_CONFIG)).toThrow(XAMAN_UNAVAILABLE_REASON);
  });

  it.each(["gemwallet", "crossmark"] as const)(
    "allows %s under hosted public configuration",
    (provider) => {
      expect(configuredWalletMetadata(JSON.stringify({
        provider,
        network: "testnet",
        account: ACCOUNT,
      }), PUBLIC_CONFIG)).toEqual({ provider, account: ACCOUNT });
    },
  );

  it("allows Ledger only when the local public configuration enables its stored transport", () => {
    expect(configuredWalletMetadata(JSON.stringify({
      provider: "ledger",
      network: "testnet",
      account: ACCOUNT,
      ledger: { transport: "virtual", accountIndex: 2 },
    }), {
      ...PUBLIC_CONFIG,
      ledger: { enabled: true, transports: ["webhid", "virtual"], defaultAccountIndex: 0 },
    })).toEqual({
      provider: "ledger",
      account: ACCOUNT,
      ledger: { transport: "virtual", accountIndex: 2 },
    });
  });

  it("creates a fresh bounded rebuild identity for every explicit attempt", () => {
    const ids = [
      "123e4567-e89b-42d3-a456-426614174000",
      "123e4567-e89b-42d3-a456-426614174001",
    ];
    expect(ledgerRebuildIdempotencyKey(() => ids.shift()!)).toBe(
      "ui-ledger-rebuild:123e4567-e89b-42d3-a456-426614174000",
    );
    expect(ledgerRebuildIdempotencyKey(() => ids.shift()!)).toBe(
      "ui-ledger-rebuild:123e4567-e89b-42d3-a456-426614174001",
    );
    expect(() => ledgerRebuildIdempotencyKey(() => "reused-or-malformed"))
      .toThrow("fresh approval identity");
  });

  it("fails unknown owner approvals closed to Ledger blind review", () => {
    expect(ledgerSigningMode({ TransactionType: "OfferCreate", Flags: 0x0004_0000 })).toBe("clear");
    expect(ledgerSigningMode({ TransactionType: "OfferCreate", Flags: 0x20 })).toBe("blind");
    expect(ledgerSigningMode({ TransactionType: "TrustSet" })).toBe("clear");
    expect(ledgerSigningMode({ TransactionType: "VaultDeposit" })).toBe("blind");
    expect(ledgerSigningMode({ TransactionType: "DelegateSet" })).toBe("blind");
    expect(ledgerSigningMode({ TransactionType: "FutureTransaction" })).toBe("blind");
    expect(ledgerSigningMode({})).toBe("blind");
  });

  it("marks the Ledger ready only after preparation with no active device interaction", () => {
    expect(ledgerDeviceReady(false, { interaction: "none", busy: false })).toBe(false);
    expect(ledgerDeviceReady(true, { interaction: "none", busy: false })).toBe(true);
    expect(ledgerDeviceReady(true, { interaction: "none", busy: true })).toBe(false);
    expect(ledgerDeviceReady(true, { interaction: "unlock-device", busy: false })).toBe(false);
    expect(ledgerDeviceReady(true, { interaction: "confirm-open-app", busy: true })).toBe(false);
    expect(ledgerDeviceReady(true, { interaction: "sign-transaction", busy: true })).toBe(false);
  });
});
