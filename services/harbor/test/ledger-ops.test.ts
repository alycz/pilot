import { describe, expect, it, vi } from "vitest";

import type { OpContext, OpDef } from "../src/catalog/registry";
import { invokeOp } from "../src/guard";
import { ops } from "../src/ops/ledger";

const ACCOUNT = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const PEER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const LEDGER_HASH = "A".repeat(64);
const AS_OF = "2026-10-18T00:00:00.000Z";

function operation(name: string): OpDef {
  const op = ops.find((candidate) => candidate.name === name);
  if (!op) throw new Error(`Missing operation ${name}`);
  return op;
}

function context(request: ReturnType<typeof vi.fn>): OpContext {
  return {
    principal: "fixture-test",
    xrplRpc: { request },
  };
}

async function invoke(
  name: string,
  args: Record<string, unknown>,
  request: ReturnType<typeof vi.fn>,
) {
  return invokeOp(operation(name), context(request), args, {
    asOf: AS_OF,
    asOfBasis: "recorded-fixture",
  });
}

describe("ledger operation catalog", () => {
  it("exports the complete ledger operation family inline", () => {
    expect(ops.map(({ name }) => name)).toEqual([
      "ledger.account.info",
      "ledger.account.lines",
      "ledger.account.objects",
      "ledger.account.tx",
      "ledger.fee",
    ]);
    expect(ops.every(({ family }) => family === "ledger")).toBe(true);
  });

  it("uses strict argument schemas and the contract network enum", () => {
    const fee = operation("ledger.fee");
    expect(fee.args.safeParse({ network: "mainnet" }).success).toBe(true);
    expect(fee.args.safeParse({ network: "lending-devnet" }).success).toBe(true);
    expect(fee.args.safeParse({ network: "sidechain" }).success).toBe(false);
    expect(
      fee.args.safeParse({ network: "testnet", unexpected: true }).success,
    ).toBe(false);

    const lines = operation("ledger.account.lines");
    expect(
      lines.args.safeParse({ network: "testnet", account: ACCOUNT, limit: 10 })
        .success,
    ).toBe(true);
    expect(
      lines.args.safeParse({ network: "testnet", account: ACCOUNT, limit: 9 })
        .success,
    ).toBe(false);
    expect(
      lines.args.safeParse({ network: "testnet", account: ACCOUNT, limit: 401 })
        .success,
    ).toBe(false);

    const transactions = operation("ledger.account.tx");
    expect(
      transactions.args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        delegate: { delegate_filter: "actor", extra: true },
      }).success,
    ).toBe(false);
    expect(
      transactions.args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        ledger_index: "validated",
        ledger_index_min: 1,
      }).success,
    ).toBe(false);
  });
});

describe("ledger operation RPC requests", () => {
  it("passes account_info selectors through and preserves the raw fixture", async () => {
    const fixture = {
      account_data: {
        Account: ACCOUNT,
        Balance: "999999990",
        OwnerCount: 2,
        Sequence: 7,
      },
      ledger_current_index: 100,
      queue_data: { txn_count: 0 },
      validated: false,
    };
    const request = vi.fn().mockResolvedValue(fixture);

    const result = await invoke(
      "ledger.account.info",
      {
        network: "testnet",
        account: ACCOUNT,
        ledger_index: "current",
        queue: true,
        signer_lists: true,
      },
      request,
    );

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "testnet",
      "account_info",
      {
        account: ACCOUNT,
        ledger_index: "current",
        queue: true,
        signer_lists: true,
      },
      undefined,
    );
    expect(result).toEqual({
      ok: true,
      data: fixture,
      asOf: AS_OF,
      asOfBasis: "recorded-fixture",
    });
  });

  it("passes account_lines filters and an opaque marker through", async () => {
    const marker = { ledger: 98, seq: 4 };
    const fixture = {
      account: ACCOUNT,
      ledger_hash: LEDGER_HASH,
      ledger_index: 99,
      lines: [
        {
          account: PEER,
          balance: "12.5",
          currency: "USD",
          limit: "100",
          no_ripple: false,
        },
      ],
      marker: "next-page",
    };
    const request = vi.fn().mockResolvedValue(fixture);

    const result = await invoke(
      "ledger.account.lines",
      {
        network: "devnet",
        account: ACCOUNT,
        peer: PEER,
        ignore_default: true,
        ledger_hash: LEDGER_HASH,
        limit: 25,
        marker,
      },
      request,
    );

    expect(request).toHaveBeenCalledWith(
      "devnet",
      "account_lines",
      {
        account: ACCOUNT,
        peer: PEER,
        ignore_default: true,
        ledger_hash: LEDGER_HASH,
        limit: 25,
        marker,
      },
      undefined,
    );
    expect(result).toMatchObject({ ok: true, data: fixture });
  });

  it("passes account_objects filters through and preserves raw ledger entries", async () => {
    const fixture = {
      account: ACCOUNT,
      account_objects: [
        {
          LedgerEntryType: "Offer",
          Account: ACCOUNT,
          Sequence: 11,
          TakerGets: "1000000",
          index: "B".repeat(64),
        },
      ],
      ledger_index: 101,
      validated: true,
    };
    const request = vi.fn().mockResolvedValue(fixture);

    const result = await invoke(
      "ledger.account.objects",
      {
        network: "mainnet",
        account: ACCOUNT,
        deletion_blockers_only: true,
        ledger_index: "validated",
        limit: 40,
        marker: "directory-marker",
        sponsored: false,
        type: "offer",
      },
      request,
    );

    expect(request).toHaveBeenCalledWith(
      "mainnet",
      "account_objects",
      {
        account: ACCOUNT,
        deletion_blockers_only: true,
        ledger_index: "validated",
        limit: 40,
        marker: "directory-marker",
        sponsored: false,
        type: "offer",
      },
      undefined,
    );
    expect(result).toMatchObject({ ok: true, data: fixture });
  });

  it("passes account_tx range, ordering, and delegation filters through", async () => {
    const fixture = {
      account: ACCOUNT,
      ledger_index_min: 50,
      ledger_index_max: 100,
      transactions: [
        {
          close_time_iso: "2026-10-18T00:00:00Z",
          ledger_index: 99,
          meta: { TransactionResult: "tesSUCCESS" },
          tx_json: { Account: ACCOUNT, TransactionType: "OfferCreate" },
          validated: true,
        },
      ],
      marker: { ledger: 75, seq: 2 },
    };
    const request = vi.fn().mockResolvedValue(fixture);

    const result = await invoke(
      "ledger.account.tx",
      {
        network: "testnet",
        account: ACCOUNT,
        tx_type: "OfferCreate",
        ledger_index_min: 50,
        ledger_index_max: 100,
        binary: false,
        forward: true,
        limit: 50,
        marker: { ledger: 50, seq: 1 },
        delegate: { delegate_filter: "actor", counter_party: PEER },
      },
      request,
    );

    expect(request).toHaveBeenCalledWith(
      "testnet",
      "account_tx",
      {
        account: ACCOUNT,
        tx_type: "OfferCreate",
        ledger_index_min: 50,
        ledger_index_max: 100,
        binary: false,
        forward: true,
        limit: 50,
        marker: { ledger: 50, seq: 1 },
        delegate: { delegate_filter: "actor", counter_party: PEER },
      },
      undefined,
    );
    expect(result).toMatchObject({ ok: true, data: fixture });
  });

  it("calls fee without command parameters and retains all fee metrics", async () => {
    const fixture = {
      current_ledger_size: "14",
      current_queue_size: "0",
      drops: {
        base_fee: "10",
        median_fee: "12",
        minimum_fee: "10",
        open_ledger_fee: "10",
      },
      ledger_current_index: 102,
      levels: {
        median_level: "307",
        minimum_level: "256",
        open_ledger_level: "256",
        reference_level: "256",
      },
      max_queue_size: "480",
    };
    const request = vi.fn().mockResolvedValue(fixture);

    const result = await invoke(
      "ledger.fee",
      { network: "lending-devnet" },
      request,
    );

    expect(request).toHaveBeenCalledWith(
      "lending-devnet",
      "fee",
      undefined,
      undefined,
    );
    expect(result).toMatchObject({ ok: true, data: fixture });
  });

  it.each([
    ["ledger.account.lines", "lines"],
    ["ledger.account.objects", "account_objects"],
    ["ledger.account.tx", "transactions"],
  ] as const)("normalizes an omitted %s row collection", async (name, key) => {
    const request = vi.fn().mockResolvedValue({ account: ACCOUNT, validated: true });

    const result = await invoke(
      name,
      { network: "testnet", account: ACCOUNT },
      request,
    );

    expect(result).toMatchObject({
      ok: true,
      data: { account: ACCOUNT, validated: true, [key]: [] },
    });
  });
});
