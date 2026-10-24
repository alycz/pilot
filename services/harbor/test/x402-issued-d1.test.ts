import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  D1IssuedX402Budget,
  D1IssuedX402State,
  type D1IssuedX402WritePoint,
} from "../src/exec/x402-issued-d1";
import type {
  X402IssuedFixtureResult,
  X402IssuedPolicy,
} from "../src/exec/x402-issued-offline";

const MIGRATION = readFileSync(
  new URL("../migrations-local-x402/0010_issued_x402_authority.sql", import.meta.url),
  "utf8",
);
const PAYER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const PAY_TO = "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr";
const ISSUER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const CURRENCY = "524C555344000000000000000000000000000000";
const HASH = "A".repeat(64);
const NOW = new Date("2026-10-24T12:00:00.000Z");

const policy: X402IssuedPolicy = {
  asset: { kind: "xrpl-issued", network: "xrpl:1", currency: CURRENCY, issuer: ISSUER },
  payTo: PAY_TO,
  sourceTag: 2_610_240,
  maxPerCall: "1",
  dailyCap: "2",
  lifetimeCap: "3",
  maxFeeDrops: "20",
  dailyFeeCapDrops: "40",
  lifetimeFeeCapDrops: "60",
  minimumXrpReserveDrops: "1200000",
};

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
  private values: SqlValue[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]): this {
    this.values = values as SqlValue[];
    return this;
  }
  runSync(): D1Result {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } as D1Result["meta"] };
  }
  async run(): Promise<D1Result> {
    return this.runSync();
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return (column === undefined ? row : row[column]) as T;
  }
  async all<T>(): Promise<D1Result<T>> {
    const results = this.statement.all(...this.values) as T[];
    return { success: true, results, meta: {} as D1Result["meta"] };
  }
}

class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec(MIGRATION);
  }
  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite.prepare(sql));
  }
  async batch(statements: SqliteD1Statement[]): Promise<D1Result[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void { this.sqlite.close(); }
}

function asD1(db: SqliteD1): D1Database {
  return db as unknown as D1Database;
}

function stateInput(
  key: string,
  changes: Partial<Parameters<D1IssuedX402State["reserve"]>[0]> = {},
) {
  const merchantInvoice = `merchant-${key}`;
  const approvalId = `approval-${key}`;
  const approvalDigest = createHash("sha256").update(approvalId).digest("hex").toUpperCase();
  return {
    idempotencyKey: key,
    scope: "issued-route:session:merchant",
    binding: JSON.stringify([
      key, "http://127.0.0.1:8000/api/x402/compare",
      `xrpl:1:${CURRENCY}:${ISSUER}`, "0.1", PAY_TO, merchantInvoice,
      approvalId, approvalDigest,
    ]),
    payer: PAYER,
    invoiceId: approvalDigest,
    sequence: 1,
    approvalId,
    approvalDigest,
    ...changes,
  };
}

function budgetInput(key: string, amount = "0.1", feeDrops = "5") {
  return {
    idempotencyKey: key,
    payer: PAYER,
    asset: policy.asset,
    amount,
    feeDrops,
    xrpBalanceDrops: "5000000",
    minimumReserveDrops: "1200000",
  };
}

async function prepareState(db: SqliteD1, key: string, sequence: number): Promise<void> {
  await new D1IssuedX402State(asD1(db), { enabled: true, now: () => NOW })
    .reserve(stateInput(key, { sequence }));
}

function options(fault?: D1IssuedX402WritePoint) {
  let token = 0;
  return {
    enabled: true,
    now: () => NOW,
    lockToken: () => `lock-${fault ?? "none"}-${++token}`,
    faultAfterWrite: async (point: D1IssuedX402WritePoint) => {
      if (point === fault) throw new Error(`FAULT:${point}`);
    },
  } as const;
}

function deliveredResult(key: string): X402IssuedFixtureResult {
  return {
    status: "fixture_delivered", evidence: "deterministic-offline-fixture",
    idempotencyKey: key, asset: policy.asset, amount: "0.1",
    payer: PAYER, payTo: PAY_TO, invoiceId: `merchant-${key}`,
    approvalDigest: stateInput(key).approvalDigest,
    sessionScope: "principal-owner-review-0001",
    merchantId: "merchant-compare-v1",
    feeDrops: "5", transactionHash: HASH,
    validatedLedgerIndex: 101,
    merchantBody: { comparison: ["dex", "amm"] },
  };
}

describe("issued x402 D1 authorities", () => {
  it("is default-off", async () => {
    const db = new SqliteD1();
    await expect(new D1IssuedX402State(asD1(db)).get("off"))
      .rejects.toThrow("ISSUED_X402_D1_DISABLED");
    await expect(new D1IssuedX402Budget(asD1(db), policy).reserve(budgetInput("off")))
      .rejects.toThrow("ISSUED_X402_D1_DISABLED");
    db.close();
  });

  it("durably binds raw merchant invoice to InvoiceID and all unique fences", async () => {
    const db = new SqliteD1();
    const first = new D1IssuedX402State(asD1(db), { enabled: true, now: () => NOW });
    expect((await first.reserve(stateInput("one"))).replay).toBe(false);
    const restarted = new D1IssuedX402State(asD1(db), { enabled: true, now: () => NOW });
    expect((await restarted.reserve(stateInput("one"))).replay).toBe(true);
    const stored = db.sqlite.prepare(`SELECT merchant_invoice_id, invoice_id
      FROM issued_x402_state WHERE idempotency_key = ?`).get("one") as {
        merchant_invoice_id: string; invoice_id: string;
      };
    expect(stored).toEqual({
      merchant_invoice_id: "merchant-one",
      invoice_id: stateInput("one").approvalDigest,
    });
    await expect(restarted.reserve(stateInput("one", { binding: "different" })))
      .rejects.toThrow("INVALID_ISSUED_STATE_BINDING");
    const duplicateInvoice = stateInput("two", { sequence: 2 });
    const duplicateBinding = JSON.parse(duplicateInvoice.binding) as unknown[];
    duplicateBinding[5] = "merchant-one";
    await expect(restarted.reserve({
      ...duplicateInvoice,
      binding: JSON.stringify(duplicateBinding),
    })).rejects.toThrow("ISSUED_INVOICE_OR_SEQUENCE_CONFLICT");
    await expect(restarted.reserve(stateInput("three", { sequence: 1 })))
      .rejects.toThrow("ISSUED_INVOICE_OR_SEQUENCE_CONFLICT");
    db.close();
  });

  it("persists signing and delivery state across authority instances", async () => {
    const db = new SqliteD1();
    const state = new D1IssuedX402State(asD1(db), { enabled: true, now: () => NOW });
    await state.reserve(stateInput("lifecycle"));
    const budget = new D1IssuedX402Budget(asD1(db), policy, options());
    await budget.reserve(budgetInput("lifecycle"));
    await state.markSigningStarted("lifecycle");
    await state.markSigned("lifecycle", HASH, "ABCD");
    await budget.commit("lifecycle");
    const result = deliveredResult("lifecycle");
    await new D1IssuedX402State(asD1(db), { enabled: true, now: () => NOW })
      .markDelivered("lifecycle", result);
    expect(await state.get("lifecycle")).toMatchObject({ status: "delivered", result });
    await expect(state.releasePreSign("lifecycle")).rejects.toThrow("ISSUED_STATE_MISMATCH");
    db.close();
  });

  it.each([
    ["state_reserved", "released_pre_sign", 0, 0],
    ["budget_reserved", "released_pre_sign", 0, 0],
    ["state_signing_started", "reconciliation_required", 0, 0],
    ["state_signed", "reconciliation_required", 1, 0],
    ["budget_committed", "reconciliation_required", 1, 1],
    ["delivered_journaled", "delivered", 1, 1],
  ] as const)(
    "repairs a restart after %s without double signing or payment",
    async (fault, expectedRecovery, expectedSigns, expectedPays) => {
      const db = new SqliteD1();
      const state = new D1IssuedX402State(asD1(db), options(fault));
      const budget = new D1IssuedX402Budget(asD1(db), policy, options(fault));
      let signCalls = 0;
      let payCalls = 0;

      const interrupted = async (): Promise<void> => {
        await state.reserve(stateInput("crash"));
        await budget.reserve(budgetInput("crash"));
        await state.markSigningStarted("crash");
        signCalls += 1;
        await state.markSigned("crash", HASH, "ABCD");
        payCalls += 1;
        await budget.commit("crash");
        await state.markDelivered("crash", deliveredResult("crash"));
      };
      await expect(interrupted()).rejects.toThrow(`FAULT:${fault}`);

      const restartedState = new D1IssuedX402State(asD1(db), options());
      const restartedBudget = new D1IssuedX402Budget(asD1(db), policy, options());
      const recovery = await restartedState.recover("crash");
      expect(recovery.outcome).toBe(expectedRecovery);
      expect(signCalls).toBe(expectedSigns);
      expect(payCalls).toBe(expectedPays);

      if (recovery.outcome === "released_pre_sign") {
        await restartedState.reserve(stateInput("crash"));
        await restartedBudget.reserve(budgetInput("crash"));
        await restartedState.markSigningStarted("crash");
        signCalls += 1;
        await restartedState.markSigned("crash", HASH, "ABCD");
        payCalls += 1;
        await restartedBudget.commit("crash");
        await restartedState.markDelivered("crash", deliveredResult("crash"));
        expect((await restartedState.recover("crash")).outcome).toBe("delivered");
      } else {
        expect((await restartedState.recover("crash")).outcome).toBe(expectedRecovery);
      }
      expect(signCalls).toBeLessThanOrEqual(1);
      expect(payCalls).toBeLessThanOrEqual(1);
      db.close();
    },
  );

  it("recovers post-write release and uncertainty faults conservatively", async () => {
    {
      const db = new SqliteD1();
      await prepareState(db, "state-release", 1);
      const state = new D1IssuedX402State(asD1(db), options("state_released_pre_sign"));
      await expect(state.releasePreSign("state-release"))
        .rejects.toThrow("FAULT:state_released_pre_sign");
      expect((await new D1IssuedX402State(asD1(db), options())
        .recover("state-release")).outcome).toBe("absent");
      db.close();
    }
    {
      const db = new SqliteD1();
      await prepareState(db, "budget-release", 1);
      await new D1IssuedX402Budget(asD1(db), policy, options())
        .reserve(budgetInput("budget-release"));
      const budget = new D1IssuedX402Budget(
        asD1(db), policy, options("budget_released_pre_sign"),
      );
      await expect(budget.releasePreSign("budget-release"))
        .rejects.toThrow("FAULT:budget_released_pre_sign");
      expect((await new D1IssuedX402State(asD1(db), options())
        .recover("budget-release")).outcome).toBe("released_pre_sign");
      db.close();
    }
    {
      const db = new SqliteD1();
      await prepareState(db, "state-uncertain", 1);
      const budget = new D1IssuedX402Budget(asD1(db), policy, options());
      await budget.reserve(budgetInput("state-uncertain"));
      const normalState = new D1IssuedX402State(asD1(db), options());
      await normalState.markSigningStarted("state-uncertain");
      const state = new D1IssuedX402State(asD1(db), options("state_uncertain"));
      await expect(state.markUncertain("state-uncertain"))
        .rejects.toThrow("FAULT:state_uncertain");
      const recovered = await new D1IssuedX402State(asD1(db), options())
        .recover("state-uncertain");
      expect(recovered).toMatchObject({
        outcome: "reconciliation_required", record: { status: "uncertain" },
      });
      db.close();
    }
    {
      const db = new SqliteD1();
      await prepareState(db, "budget-uncertain", 1);
      await new D1IssuedX402Budget(asD1(db), policy, options())
        .reserve(budgetInput("budget-uncertain"));
      await new D1IssuedX402State(asD1(db), options())
        .markSigningStarted("budget-uncertain");
      const budget = new D1IssuedX402Budget(
        asD1(db), policy, options("budget_uncertain"),
      );
      await expect(budget.markUncertain("budget-uncertain"))
        .rejects.toThrow("FAULT:budget_uncertain");
      const recovered = await new D1IssuedX402State(asD1(db), options())
        .recover("budget-uncertain");
      expect(recovered).toMatchObject({
        outcome: "reconciliation_required", record: { status: "uncertain" },
      });
      db.close();
    }
  });

  it("retains signing ambiguity without inventing a hash", async () => {
    const db = new SqliteD1();
    const state = new D1IssuedX402State(asD1(db), { enabled: true, now: () => NOW });
    await state.reserve(stateInput("ambiguous"));
    await state.markSigningStarted("ambiguous");
    await state.markUncertain("ambiguous");
    expect(await state.get("ambiguous")).toMatchObject({ status: "uncertain" });
    expect(await state.get("ambiguous")).not.toHaveProperty("hash");
    db.close();
  });

  it("uses exact decimal arithmetic and preserves uncertain budget", async () => {
    const db = new SqliteD1();
    await prepareState(db, "a", 1);
    await prepareState(db, "b", 2);
    let token = 0;
    const budget = new D1IssuedX402Budget(asD1(db), policy, {
      enabled: true, now: () => NOW, lockToken: () => `lock-${++token}`,
    });
    await budget.reserve(budgetInput("a", "0.1", "5"));
    await budget.markUncertain("a");
    expect((await budget.reserve(budgetInput("a", "0.1", "5"))).replay).toBe(true);
    await expect(budget.releasePreSign("a")).rejects.toThrow("ISSUED_BUDGET_STATE_MISMATCH");
    await budget.reserve(budgetInput("b", "0.2", "5"));
    await budget.commit("b");
    const totals = db.sqlite.prepare(
      "SELECT amount_atoms FROM issued_x402_budget ORDER BY idempotency_key",
    ).all() as Array<{ amount_atoms: string }>;
    expect(BigInt(totals[0]!.amount_atoms) * 2n).toBe(BigInt(totals[1]!.amount_atoms));
    db.close();
  });

  it("serializes concurrent reservations without oversubscribing a cap", async () => {
    const db = new SqliteD1();
    await prepareState(db, "one", 1);
    await prepareState(db, "two", 2);
    const tight = { ...policy, maxPerCall: "1", dailyCap: "1", lifetimeCap: "1" };
    let token = 0;
    const budget = new D1IssuedX402Budget(asD1(db), tight, {
      enabled: true, now: () => NOW, lockToken: () => `concurrent-${++token}`,
    });
    const outcomes = await Promise.allSettled([
      budget.reserve(budgetInput("one", "1", "5")),
      budget.reserve(budgetInput("two", "1", "5")),
    ]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    const failed = outcomes.find((value) => value.status === "rejected");
    expect(failed?.status).toBe("rejected");
    if (failed?.status === "rejected") {
      expect(["ISSUED_BUDGET_BUSY", "ISSUED_BUDGET_REJECTED"])
        .toContain((failed.reason as Error).message);
    }
    await expect(budget.reserve(budgetInput("two", "1", "5")))
      .rejects.toThrow("ISSUED_BUDGET_REJECTED");
    const count = db.sqlite.prepare("SELECT COUNT(*) AS count FROM issued_x402_budget")
      .get() as { count: number };
    expect(count.count).toBe(1);
    db.close();
  });

  it("enforces daily and lifetime issued caps across restarts and UTC days", async () => {
    const db = new SqliteD1();
    await prepareState(db, "day-one", 1);
    await prepareState(db, "daily", 2);
    await prepareState(db, "day-two", 3);
    await prepareState(db, "lifetime", 4);
    let now = NOW;
    let token = 0;
    const bounded = { ...policy, maxPerCall: "1", dailyCap: "1.5", lifetimeCap: "2" };
    const first = new D1IssuedX402Budget(asD1(db), bounded, {
      enabled: true, now: () => now, lockToken: () => `caps-${++token}`,
    });
    await first.reserve(budgetInput("day-one", "1", "5"));
    await expect(first.reserve(budgetInput("daily", "0.6", "5")))
      .rejects.toThrow("ISSUED_BUDGET_REJECTED");
    now = new Date("2026-10-25T00:00:00.000Z");
    const restarted = new D1IssuedX402Budget(asD1(db), bounded, {
      enabled: true, now: () => now, lockToken: () => `caps-${++token}`,
    });
    await restarted.reserve(budgetInput("day-two", "1", "5"));
    await expect(restarted.reserve(budgetInput("lifetime", "0.1", "5")))
      .rejects.toThrow("ISSUED_BUDGET_REJECTED");
    db.close();
  });

  it("keeps issued amount caps separate from XRP fee and reserve caps", async () => {
    const db = new SqliteD1();
    await prepareState(db, "fee", 1);
    await prepareState(db, "reserve", 2);
    let token = 0;
    const budget = new D1IssuedX402Budget(asD1(db), policy, {
      enabled: true, now: () => NOW, lockToken: () => `fees-${++token}`,
    });
    await expect(budget.reserve(budgetInput("fee", "0.01", "21")))
      .rejects.toThrow("ISSUED_BUDGET_REJECTED");
    await expect(budget.reserve({
      ...budgetInput("reserve", "0.01", "5"), xrpBalanceDrops: "1200004",
    })).rejects.toThrow("ISSUED_XRP_RESERVE_REJECTED");
    db.close();
  });
});
