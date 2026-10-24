import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  collectIssuedPolicyAssets,
  configuredStablePolicyAsset,
} from "../src/exec/transaction/facts";

const TESTNET_FALLBACK = {
  currency: "524C555344000000000000000000000000000000",
  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
};

describe("transaction policy facts", () => {
  it("collects unique nested issued assets in encounter order", () => {
    expect(
      collectIssuedPolicyAssets({
        TransactionType: "OfferCreate",
        TakerPays: "1000000",
        TakerGets: {
          currency: "USD",
          issuer: "rIssuerOne",
          value: "10",
        },
        Paths: [
          [
            { currency: "EUR", issuer: "rIssuerTwo" },
            { currency: "USD", issuer: "rIssuerOne", value: "duplicate" },
          ],
          { currency: "incomplete" },
        ],
      }),
    ).toEqual([
      { currency: "USD", issuer: "rIssuerOne" },
      { currency: "EUR", issuer: "rIssuerTwo" },
    ]);
  });

  it("ignores native, scalar, null, and incomplete values", () => {
    expect(
      collectIssuedPolicyAssets([
        "1000000",
        null,
        4,
        { currency: "XRP" },
        { issuer: "rIssuerOnly" },
      ]),
    ).toEqual([]);
  });

  it("uses a complete network-specific configured issue", () => {
    expect(
      configuredStablePolicyAsset(
        {
          STABLE_CODE: "tUSD",
          STABLE_ISSUER_LENDING_DEVNET: "rConfigured",
        },
        "lending-devnet",
        TESTNET_FALLBACK,
      ),
    ).toEqual({ currency: "tUSD", issuer: "rConfigured" });
  });

  it("uses the Testnet default only when configuration is incomplete", () => {
    const resolved = configuredStablePolicyAsset(
      { STABLE_CODE: "tUSD" },
      "testnet",
      TESTNET_FALLBACK,
    );
    expect(resolved).toEqual(TESTNET_FALLBACK);
    expect(resolved).not.toBe(TESTNET_FALLBACK);
  });

  it("has no implicit stable issue outside Testnet", () => {
    expect(
      configuredStablePolicyAsset(undefined, "devnet", TESTNET_FALLBACK),
    ).toBeUndefined();
  });

  it("keeps the extracted module free of execution and persistence imports", () => {
    const source = readFileSync(
      new URL("../src/exec/transaction/facts.ts", import.meta.url),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    expect(imports).toEqual(["../../contracts"]);
    expect(source).not.toContain("requestXrpl");
  });
});
