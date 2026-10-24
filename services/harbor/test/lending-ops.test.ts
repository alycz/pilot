import { describe, expect, it, vi } from "vitest";

import type { OpContext } from "../src/catalog/registry";
import { invokeOp } from "../src/guard";
import { ops } from "../src/ops/lending";

const HASH = "A".repeat(64);
const VAULT_ID = "B".repeat(64);
const PREVIOUS_TX = "C".repeat(64);
const MARKER = "D".repeat(64);
const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OWNER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const AS_OF = "2026-10-18T00:00:00.000Z";

const sparseBroker = {
  LedgerEntryType: "LoanBroker",
  index: HASH,
  Flags: 0,
  Account: ACCOUNT,
  DebtMaximum: "0",
  LoanSequence: 0,
  Owner: OWNER,
  OwnerNode: "0",
  PreviousTxnID: PREVIOUS_TX,
  PreviousTxnLgrSeq: 12_344,
  Sequence: 1,
  VaultNode: "0",
  VaultID: VAULT_ID,
};

const fixture = {
  ledger_hash: HASH,
  ledger_index: 12_345,
  validated: true,
  state: [
    {
      LedgerEntryType: "LoanBroker",
      index: HASH,
      Flags: 0,
      Account: ACCOUNT,
      CoverAvailable: "10000",
      CoverRateMinimum: 10_000,
      CoverRateLiquidation: 5_000,
      Data: "74657374",
      DebtMaximum: "100000",
      DebtTotal: "50000",
      LoanSequence: 2,
      ManagementFeeRate: 100,
      Owner: OWNER,
      OwnerCount: 3,
      OwnerNode: "2",
      PreviousTxnID: PREVIOUS_TX,
      PreviousTxnLgrSeq: 12_344,
      Sequence: 1,
      VaultNode: "1",
      VaultID: VAULT_ID,
    },
  ],
  marker: MARKER,
};

function operation() {
  const op = ops.find(({ name }) => name === "lending.brokers");
  if (!op) throw new Error("Missing lending.brokers");
  return op;
}

describe("lending.brokers", () => {
  it("is Lending-Devnet-only and carries both fixed protocol caveats", () => {
    const op = operation();
    expect(op.caveats).toEqual(["devnet-only", "amendment-pending"]);
    expect(op.args.safeParse({ network: "lending-devnet" }).success).toBe(true);
    expect(op.args.safeParse({ network: "devnet" }).success).toBe(false);
    expect(op.args.safeParse({ network: "testnet" }).success).toBe(false);
    expect(op.args.safeParse({ network: "mainnet" }).success).toBe(false);
    expect(
      op.args.safeParse({ network: "lending-devnet", unexpected: true }).success,
    ).toBe(false);
  });

  it("reads a validated, filtered page through the injectable XRPL adapter", async () => {
    const request = vi.fn().mockResolvedValue(fixture);
    const ctx = {
      principal: "lending-fixture-test",
      xrplRpc: { request },
    } satisfies OpContext;

    const result = await invokeOp(
      operation(),
      ctx,
      { network: "lending-devnet", limit: 50, marker: MARKER },
      { asOf: AS_OF, asOfBasis: "recorded-fixture" },
    );

    expect(request).toHaveBeenCalledWith(
      "lending-devnet",
      "ledger_data",
      {
        ledger_index: "validated",
        type: "LoanBroker",
        limit: 50,
        marker: MARKER,
      },
      undefined,
    );
    expect(result).toEqual({
      ok: true,
      data: {
        network: "lending-devnet",
        ledger_hash: HASH,
        ledger_index: 12_345,
        validated: true,
        brokers: fixture.state,
        marker: MARKER,
      },
      asOf: AS_OF,
      asOfBasis: "recorded-fixture",
      caveat: ["devnet-only", "amendment-pending"],
    });
  });

  it("rejects malformed or non-LoanBroker fixture data", async () => {
    const request = vi.fn().mockResolvedValue({
      ...fixture,
      state: [{ ...fixture.state[0], LedgerEntryType: "Vault" }],
    });

    await expect(
      operation().handler(
        { principal: "lending-fixture-test", xrplRpc: { request } },
        { network: "lending-devnet" },
      ),
    ).rejects.toThrow();
  });

  it("accepts a sparse LoanBroker with only required XRPL fields", async () => {
    const request = vi.fn().mockResolvedValue({
      ledger_hash: HASH,
      ledger_index: 12_345,
      validated: true,
      state: [sparseBroker],
    });

    await expect(
      operation().handler(
        { principal: "lending-fixture-test", xrplRpc: { request } },
        { network: "lending-devnet" },
      ),
    ).resolves.toMatchObject({ brokers: [sparseBroker] });
  });

  it("rejects a LoanBroker missing required DebtMaximum", async () => {
    const { DebtMaximum: _missing, ...withoutDebtMaximum } = sparseBroker;
    const request = vi.fn().mockResolvedValue({
      ledger_hash: HASH,
      ledger_index: 12_345,
      validated: true,
      state: [withoutDebtMaximum],
    });

    await expect(
      operation().handler(
        { principal: "lending-fixture-test", xrplRpc: { request } },
        { network: "lending-devnet" },
      ),
    ).rejects.toThrow();
  });
});
