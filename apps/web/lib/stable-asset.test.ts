import { describe, expect, it } from "vitest";

import {
  TESTNET_RLUSD_ISSUER,
  resolveStableAsset,
  toLedgerCurrencyCode,
} from "./stable-asset";

describe("stable asset configuration", () => {
  it("uses the official Testnet RLUSD default consistently", () => {
    expect(resolveStableAsset({
      STABLE_CODE: "tUSD",
      STABLE_CODE_TESTNET: "tUSD",
      STABLE_ISSUER_TESTNET: "r9q7rUoPpDCuzMHC9eki81bTK6LSEVHYp",
    }, "testnet")).toEqual({
      currency: "524C555344000000000000000000000000000000",
      displayCurrency: "RLUSD",
      issuer: TESTNET_RLUSD_ISSUER,
    });
  });

  it("uses network-specific settings before generic settings", () => {
    expect(resolveStableAsset({
      STABLE_CODE: "USD",
      STABLE_ISSUER: "rGeneric",
      STABLE_CODE_DEVNET: "tUSD",
      STABLE_ISSUER_DEVNET: "rDevnet",
    }, "devnet")).toEqual({
      currency: "7455534400000000000000000000000000000000",
      displayCurrency: "tUSD",
      issuer: "rDevnet",
    });
  });

  it("keeps Devnet unavailable without an explicitly configured issuer", () => {
    expect(resolveStableAsset({}, "devnet").issuer).toBeUndefined();
  });

  it("rejects malformed currency codes", () => {
    expect(() => toLedgerCurrencyCode("A".repeat(21))).toThrow("INVALID_STABLE_ASSET_CURRENCY");
    expect(() => toLedgerCurrencyCode("AB\nD")).toThrow("INVALID_STABLE_ASSET_CURRENCY");
    expect(() => toLedgerCurrencyCode("A".repeat(39))).toThrow("INVALID_STABLE_ASSET_CURRENCY");
  });
});
