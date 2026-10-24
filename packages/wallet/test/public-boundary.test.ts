import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  PilotWalletError,
  WALLET_PROVIDERS,
} from "../src/index.js";
import type {
  CreateWalletOptions as PublicCreateWalletOptions,
  LedgerDeviceState as PublicLedgerDeviceState,
  PilotWallet as PublicPilotWallet,
  PilotWalletErrorCode as PublicPilotWalletErrorCode,
  WalletProvider as PublicWalletProvider,
} from "../src/index.js";
import { PilotWalletError as SharedPilotWalletError } from "../src/types.js";
import type {
  CreateWalletOptions as SharedCreateWalletOptions,
  LedgerDeviceState as SharedLedgerDeviceState,
  PilotWallet as SharedPilotWallet,
  PilotWalletErrorCode as SharedPilotWalletErrorCode,
  WalletProvider as SharedWalletProvider,
} from "../src/types.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Condition extends true> = Condition;

type PublicTypesRemainReExports = [
  Assert<Equal<PublicCreateWalletOptions, SharedCreateWalletOptions>>,
  Assert<Equal<PublicLedgerDeviceState, SharedLedgerDeviceState>>,
  Assert<Equal<PublicPilotWallet, SharedPilotWallet>>,
  Assert<Equal<PublicPilotWalletErrorCode, SharedPilotWalletErrorCode>>,
  Assert<Equal<PublicWalletProvider, SharedWalletProvider>>,
  Assert<Equal<(typeof WALLET_PROVIDERS)[number], PublicWalletProvider>>,
];

const publicTypesRemainReExports: PublicTypesRemainReExports = [
  true,
  true,
  true,
  true,
  true,
  true,
];

describe("wallet public boundary", () => {
  it("preserves the public provider order and error-class identity", () => {
    expect(WALLET_PROVIDERS).toEqual([
      "ledger",
      "gemwallet",
      "crossmark",
      "xaman",
      "dev",
    ]);
    expect(PilotWalletError).toBe(SharedPilotWalletError);
    expect(publicTypesRemainReExports).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("keeps Ledger internals independent from the root wallet facade", async () => {
    const modules = ["facade.ts", "device-manager.ts", "xrp.ts"];
    for (const module of modules) {
      const source = await readFile(
        new URL(`../src/ledger/${module}`, import.meta.url),
        "utf8",
      );
      expect(source).not.toMatch(/from\s+["']\.\.\/index\.js["']/u);
    }
  });
});
