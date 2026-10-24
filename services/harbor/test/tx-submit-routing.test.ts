import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";
import { Wallet, type DelegateSet } from "xrpl";

import type { OpContext } from "../src/catalog/registry";
import type { EventInsert, EventRow, LinkRow, Store } from "../src/exec/store";
import {
  handleTxStatus,
  handleTxSubmit,
  TxStatusArgsSchema,
  TxSubmitArgsSchema,
  type ExecutionServices,
} from "../src/ops/tx-exec";

type SqlValue = string | number | bigint | null | Uint8Array;

class SequenceDatabaseStatement {
  private values: SqlValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): this {
    this.values = values as SqlValue[];
    return this;
  }

  async run(): Promise<D1Result> {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } as D1Result["meta"] };
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }
}

class SequenceDatabase {
  private readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    this.sqlite.exec(readFileSync(
      new URL("../migrations/0011_autonomous_strategies.sql", import.meta.url),
      "utf8",
    ));
  }

  prepare(sql: string): SequenceDatabaseStatement {
    return new SequenceDatabaseStatement(this.sqlite.prepare(sql));
  }
}

function harness() {
  const ownerWallet = Wallet.generate();
  const delegateWallet = Wallet.generate();
  const permissions = ["OfferCancel"];
  const link: LinkRow = {
    id: "devnet-direct-link",
    principal: "direct-routing-test",
    owner: ownerWallet.classicAddress,
    network: "devnet",
    delegate: delegateWallet.classicAddress,
    delegateSeedEnc: new Uint8Array([1]).buffer,
    iv: new Uint8Array([2]).buffer,
    permissions,
    status: "pending",
    lastLedger: null,
    revokeTx: null,
    createdAt: "2026-10-18T10:00:00.000Z",
  };
  const transaction: DelegateSet = {
    TransactionType: "DelegateSet",
    Account: ownerWallet.classicAddress,
    Authorize: delegateWallet.classicAddress,
    Permissions: permissions.map((PermissionValue) => ({
      Permission: { PermissionValue },
    })),
    Fee: "10",
    Sequence: 1,
    LastLedgerSequence: 140,
  };
  const signed = ownerWallet.sign(transaction);
  const events = new Map<string, EventRow>();
  const getLink = vi.fn(async (owner: string, network: string) =>
    owner === link.owner && network === link.network ? link : null,
  );
  const insertEvent = vi.fn(async (input: EventInsert) => {
    const row = { ...input, principal: link.principal };
    if (events.has(input.id)) throw new Error("duplicate event");
    events.set(input.id, row);
    return row;
  });
  const store = {
    getLink,
    getEvent: vi.fn(async (id: string) => events.get(id) ?? null),
    insertEvent,
    findExecutionByHash: vi.fn(async () => null),
    getBuild: vi.fn(async () => null),
  } as unknown as Store;
  const submitSigned = vi.fn(
    async ({ network }: { network: "testnet" | "devnet" }) => ({
      hash: signed.hash,
      ledger_index: 101,
      engine_result: "tesSUCCESS",
      validated: true as const,
      network,
    }),
  );
  const status = vi.fn(
    async (
      _ctx: OpContext,
      network: "testnet" | "devnet",
      hash: string,
    ) => ({
      hash,
      network,
      validated: true,
      ledger_index: 101,
      engine_result: "tesSUCCESS",
    }),
  );
  const services = {
    store,
    submitSigned,
    status,
    now: () => new Date("2026-10-18T10:00:00.000Z"),
  } satisfies ExecutionServices;
  const ctx = {
    principal: link.principal,
    env: { EXEC_NETWORK: "testnet" },
    db: new SequenceDatabase() as unknown as D1Database,
    xrplRpc: {
      request: vi.fn(async (_network: string, command: string) => {
        if (command === "ledger") {
          return { validated: true, ledger_index: 100 };
        }
        throw new Error(`unexpected XRPL command ${command}`);
      }),
    },
    executionServices: services,
  } as OpContext;
  return {
    ctx,
    events,
    getLink,
    insertEvent,
    link,
    ownerWallet,
    signed,
    status,
    submitSigned,
    transaction,
  };
}

describe("direct owner submission routing", () => {
  it("binds a signed Devnet DelegateSet to its authenticated account and reuses that route for status", async () => {
    const { ctx, events, link, signed, status, submitSigned } = harness();

    await expect(
      handleTxSubmit(ctx, { tx_blob: signed.tx_blob, network: "devnet" }),
    ).resolves.toMatchObject({ hash: signed.hash, validated: true });
    expect(submitSigned).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx,
        network: "devnet",
        txBlob: signed.tx_blob,
      }),
    );
    expect([...events.values()]).toEqual([
      expect.objectContaining({
        owner: link.owner,
        kind: "direct_owner_submission",
        detail: { hash: signed.hash, network: "devnet" },
      }),
    ]);
    expect([...events.keys()]).toEqual([
      `direct-owner-submit:${link.principal}:${signed.hash}`,
    ]);

    await expect(
      handleTxStatus(ctx, {
        hash: signed.hash,
        network: "devnet",
        account: link.owner,
      }),
    ).resolves.toMatchObject({
      hash: signed.hash,
      network: "devnet",
      validated: true,
    });
    expect(status).toHaveBeenCalledWith(ctx, "devnet", signed.hash);

    status.mockClear();
    await expect(handleTxStatus(ctx, { hash: signed.hash })).resolves.toMatchObject({
      hash: signed.hash,
      network: "devnet",
      validated: true,
    });
    expect(status).toHaveBeenCalledWith(ctx, "devnet", signed.hash);
  });

  it("recovers an insert race only when the persisted binding is identical", async () => {
    const { ctx, events, insertEvent, link, signed, submitSigned } = harness();
    insertEvent.mockImplementationOnce(async (input: EventInsert) => {
      events.set(input.id, { ...input, principal: link.principal });
      throw new Error("simulated concurrent insert");
    });

    await expect(
      handleTxSubmit(ctx, { tx_blob: signed.tx_blob, network: "devnet" }),
    ).resolves.toMatchObject({ hash: signed.hash, validated: true });
    expect(submitSigned).toHaveBeenCalledTimes(1);
  });

  it("fails closed on missing or mismatched direct-submit routing", async () => {
    const {
      ctx,
      events,
      link,
      signed,
      status,
      submitSigned,
      transaction,
      ownerWallet,
    } = harness();

    await expect(handleTxSubmit(ctx, { tx_blob: signed.tx_blob })).rejects.toThrow(
      /network is required/i,
    );
    await expect(
      handleTxSubmit(ctx, { tx_blob: signed.tx_blob, network: "testnet" }),
    ).rejects.toThrow(/no matching account link/i);

    const changed = ownerWallet.sign({ ...transaction, Permissions: [] });
    await expect(
      handleTxSubmit(ctx, { tx_blob: changed.tx_blob, network: "devnet" }),
    ).rejects.toThrow(/link state/i);
    expect(submitSigned).not.toHaveBeenCalled();

    await handleTxSubmit(ctx, { tx_blob: signed.tx_blob, network: "devnet" });
    status.mockClear();
    await expect(
      handleTxStatus(ctx, {
        hash: signed.hash,
        network: "testnet",
        account: link.owner,
      }),
    ).rejects.toThrow(/does not match/i);
    await expect(
      handleTxStatus(ctx, {
        hash: signed.hash,
        network: "devnet",
        account: Wallet.generate().classicAddress,
      }),
    ).rejects.toThrow(/does not match/i);
    await expect(
      handleTxStatus(ctx, {
        hash: "A".repeat(64),
        network: "devnet",
        account: link.owner,
      }),
    ).rejects.toThrow(/does not match/i);

    const [[eventId, event]] = [...events.entries()];
    events.set(eventId, {
      ...event,
      detail: { ...event.detail, network: "mainnet" },
    });
    await expect(handleTxStatus(ctx, { hash: signed.hash })).rejects.toThrow(
      /binding is malformed/i,
    );
    expect(status).not.toHaveBeenCalled();
  });

  it("requires paired account/network status context and allowlisted networks", () => {
    expect(
      TxSubmitArgsSchema.safeParse({ tx_blob: "AA", network: "devnet" })
        .success,
    ).toBe(true);
    expect(TxSubmitArgsSchema.safeParse({ tx_blob: "AA" }).success).toBe(false);
    expect(
      TxSubmitArgsSchema.safeParse({
        tx_blob: "AA",
        approval_id: "approval",
      }).success,
    ).toBe(true);
    expect(
      TxSubmitArgsSchema.safeParse({ tx_blob: "AA", network: "mainnet" })
        .success,
    ).toBe(false);
    expect(
      TxStatusArgsSchema.safeParse({ hash: "A".repeat(64) }).success,
    ).toBe(true);
    expect(
      TxStatusArgsSchema.safeParse({
        hash: "A".repeat(64),
        network: "devnet",
        account: Wallet.generate().classicAddress,
      }).success,
    ).toBe(true);
    expect(
      TxStatusArgsSchema.safeParse({
        hash: "A".repeat(64),
        network: "devnet",
      }).success,
    ).toBe(false);
    expect(
      TxStatusArgsSchema.safeParse({
        hash: "A".repeat(64),
        account: Wallet.generate().classicAddress,
      }).success,
    ).toBe(false);
  });
});
