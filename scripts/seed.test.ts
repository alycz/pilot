import { describe, expect, it } from "vitest";
import type { AccountOffer, BookOffer } from "xrpl";

import {
  assertLendingDevnetEndpoint,
  assertPublicSeedFile,
  isDuplicateAmm,
  isRetryableLedgerExpiry,
  mainnetMidFromBooks,
  parseArgs,
  planFreemoneyReconciliation,
  stableConfigEntries,
  toLedgerCurrency,
  vaultLedgerIndex,
} from "./seed";

const RLUSD = "524C555344000000000000000000000000000000";
const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const FREE_ISSUER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function offer(gets: BookOffer["TakerGets"], pays: BookOffer["TakerPays"]): BookOffer {
  return { TakerGets: gets, TakerPays: pays } as BookOffer;
}

function accountOffer(seq: number, gets: AccountOffer["taker_gets"], pays: AccountOffer["taker_pays"]): AccountOffer {
  return { seq, flags: 0, quality: "1", taker_gets: gets, taker_pays: pays };
}

describe("seed CLI guardrails", () => {
  it("accepts only explicit test networks", () => {
    expect(parseArgs(["--network", "testnet"])).toEqual({ network: "testnet" });
    expect(parseArgs(["--network=devnet"])).toEqual({ network: "devnet" });
    expect(() => parseArgs([])).toThrow(/Missing required --network/);
    expect(() => parseArgs(["--network", "mainnet"])).toThrow(/Refusing to seed mainnet/);
  });
});

describe("XRPL asset and price normalization", () => {
  it("encodes non-standard currency codes as uppercase 160-bit hex", () => {
    expect(toLedgerCurrency("USD")).toBe("USD");
    expect(toLedgerCurrency("RLUSD")).toBe(RLUSD);
    expect(toLedgerCurrency(RLUSD.toLowerCase())).toBe(RLUSD);
    expect(toLedgerCurrency("tUSD")).toBe("7455534400000000000000000000000000000000");
    expect(toLedgerCurrency("FREEMONEY")).toBe("465245454D4F4E45590000000000000000000000");
  });

  it("derives the mid from funded XRP/RLUSD amounts in both books", () => {
    const asks = [offer("1000000", { currency: RLUSD, issuer: ISSUER, value: "2.1" })];
    const bids = [offer({ currency: RLUSD, issuer: ISSUER, value: "2" }, "1000000")];
    expect(mainnetMidFromBooks(asks, bids)).toBeCloseTo(2.05);
  });
});

describe("AMM idempotency", () => {
  it("recognizes a duplicate AMM transaction result without masking other failures", () => {
    expect(isDuplicateAmm(new Error("AMMCreate failed with tecDUPLICATE."))).toBe(true);
    expect(isDuplicateAmm(new Error("AMMCreate failed with tecUNFUNDED."))).toBe(false);
  });
});

describe("transaction expiry retries", () => {
  it("retries only a past-ledger-sequence result", () => {
    expect(
      isRetryableLedgerExpiry(
        new Error(
          "The latest ledger sequence 21625022 is greater than the transaction's LastLedgerSequence (21625021). Preliminary result: tefPAST_SEQ",
        ),
      ),
    ).toBe(true);
    expect(
      isRetryableLedgerExpiry(
        new Error(
          "The latest ledger sequence is greater than the transaction's LastLedgerSequence.",
        ),
      ),
    ).toBe(false);
    expect(isRetryableLedgerExpiry(new Error("Payment failed with tecUNFUNDED_PAYMENT."))).toBe(false);
  });
});

describe("public seed file", () => {
  it("allows only addresses and vault IDs", () => {
    expect(() =>
      assertPublicSeedFile({
        testnet: {
          marketMakerAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
          xrpVaultId: "A".repeat(64),
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertPublicSeedFile({ testnet: { marketMakerAddress: "not-an-address" } }),
    ).toThrow(/addresses or ledger IDs/);
    expect(() => assertPublicSeedFile({ testnet: { seed: "secret" } } as never)).toThrow(/forbidden/);
    expect(() => assertPublicSeedFile({ testnet: { xrpVaultId: null } } as never)).toThrow(
      /addresses or ledger IDs/,
    );
  });
});

describe("stablecoin configuration", () => {
  it("updates the global Harbor code only for the active execution network", () => {
    const issuer = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
    expect(stableConfigEntries("testnet", { displayCode: "RLUSD", issuer }, "testnet")).toEqual({
      STABLE_CODE: "RLUSD",
      STABLE_CODE_TESTNET: "RLUSD",
      STABLE_ISSUER_TESTNET: issuer,
    });
    expect(stableConfigEntries("devnet", { displayCode: "tUSD", issuer }, "testnet")).toEqual({
      STABLE_CODE_DEVNET: "tUSD",
      STABLE_ISSUER_DEVNET: issuer,
    });
  });
});

describe("FREEMONEY book reconciliation", () => {
  it("replaces stale or unfunded offers while retaining funded equivalent levels", () => {
    const stable = { displayCode: "tUSD", currency: "tUSD", issuer: ISSUER };
    const free = { displayCode: "FREEMONEY", currency: "FREEMONEY", issuer: FREE_ISSUER };
    const existing = [
      accountOffer(
        11,
        { currency: free.currency, issuer: free.issuer, value: "1000" },
        { currency: stable.currency, issuer: stable.issuer, value: "10.5" },
      ),
      accountOffer(
        12,
        { currency: free.currency, issuer: free.issuer, value: "2000" },
        { currency: stable.currency, issuer: stable.issuer, value: "21" },
      ),
      accountOffer(
        21,
        { currency: stable.currency, issuer: stable.issuer, value: "7" },
        { currency: free.currency, issuer: free.issuer, value: "1000" },
      ),
      accountOffer(
        22,
        { currency: stable.currency, issuer: stable.issuer, value: "16" },
        { currency: free.currency, issuer: free.issuer, value: "2000" },
      ),
    ];

    expect(planFreemoneyReconciliation(existing, new Set([11, 21, 22]), stable, free)).toEqual([
      {
        kind: "replace",
        offerSequence: 12,
        desired: {
          side: "ask",
          level: 2,
          takerGets: { currency: free.currency, issuer: free.issuer, value: "2000" },
          takerPays: { currency: stable.currency, issuer: stable.issuer, value: "21" },
        },
      },
      {
        kind: "replace",
        offerSequence: 21,
        desired: {
          side: "bid",
          level: 1,
          takerGets: { currency: stable.currency, issuer: stable.issuer, value: "8" },
          takerPays: { currency: free.currency, issuer: free.issuer, value: "1000" },
        },
      },
    ]);
  });
});

describe("Lending-Devnet guardrails", () => {
  it("accepts only the approved endpoint on the devnet network ID", () => {
    expect(() =>
      assertLendingDevnetEndpoint("wss://lend.devnet.rippletest.net:51233", 2),
    ).not.toThrow();
    expect(() =>
      assertLendingDevnetEndpoint("wss://s.altnet.rippletest.net:51233", 2),
    ).toThrow(/unapproved Lending-Devnet endpoint/);
    expect(() =>
      assertLendingDevnetEndpoint("wss://lend.devnet.rippletest.net:51233", 1),
    ).toThrow(/expected 2/);
  });
});

describe("vault metadata", () => {
  it("reads the ledger key from rippled's account_objects index field", () => {
    const index = "A".repeat(64);
    expect(vaultLedgerIndex({ index })).toBe(index);
    expect(vaultLedgerIndex({ index: "not-a-ledger-index" })).toBeUndefined();
    expect(vaultLedgerIndex({})).toBeUndefined();
  });
});
