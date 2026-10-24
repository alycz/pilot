import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { Strategy, StrategyDecision } from "../src/contracts";
import { StrategySchedulerStore, StrategyStore } from "../src/strategy/store";

type SqlValue = string | number | bigint | null | Uint8Array;
class Statement {
  private values: SqlValue[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]): this { this.values = values as SqlValue[]; return this; }
  execute(): D1Result {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } as D1Result["meta"] };
  }
  async run(): Promise<D1Result> { return this.execute(); }
  async first<T>(): Promise<T | null> { return (this.statement.get(...this.values) as T | undefined) ?? null; }
  async all<T>(): Promise<D1Result<T>> { return { success: true, results: this.statement.all(...this.values) as T[], meta: {} as D1Result<T>["meta"] }; }
}
class Database {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec(readFileSync(new URL("../migrations/0011_autonomous_strategies.sql", import.meta.url), "utf8"));
    this.sqlite.exec("PRAGMA foreign_keys = OFF");
  }
  prepare(sql: string): Statement { return new Statement(this.sqlite.prepare(sql)); }
  async batch(statements: Statement[]): Promise<D1Result[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const results = statements.map((statement) => statement.execute()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.sqlite.close(); }
}
const d1 = (database: Database) => database as unknown as D1Database;
const now = new Date("2026-10-22T12:00:00.000Z");
const accountA = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const accountB = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

function strategy(): Strategy {
  return { strategy_id: "strategy:1", lifecycle: "active", generation: 1,
    next_evaluation_at: now.toISOString(), created_at: now.toISOString(), updated_at: now.toISOString(),
    mandate: { mandate_id: "mandate:1", strategy_id: "strategy:1", version: 1, digest: "AB".repeat(32),
      status: "approved", kind: "xrp_issued_rebalancer_v1", network: "testnet", account: accountA,
      issued_asset: { currency: "524C555344000000000000000000000000000000", issuer: accountB },
      allocation: { target_xrp_bps: 5000, lower_xrp_bps: 4500, upper_xrp_bps: 5500 },
      limits: { max_order_value: "100", max_daily_value: "100", min_order_value: "1", max_fee_drops: "20",
        max_slippage_bps: 100, max_price_impact_bps: 100, min_xrp_reserve_drops: "12000000",
        fee_buffer_drops: "1000", max_xrp_exposure_drops: "1000000000", max_issued_exposure: "1000",
        min_liquidity_value: "50", cooldown_seconds: 300, max_quote_age_seconds: 20, max_ledger_gap: 1 },
      schedule: { interval_seconds: 300, next_evaluation_at: now.toISOString() }, execution_mode: "offer_create_fok",
      not_before: now.toISOString(), expires_at: "2026-10-23T12:00:00.000Z",
      authorization: { authorization_id: "auth:1", method: "wallet_action_proof_v1", owner: accountA,
        mandate_digest: "AB".repeat(32), mandate_version: 1, approved_at: now.toISOString(), expires_at: "2026-10-23T12:00:00.000Z" } } };
}

function decision(id: string): StrategyDecision {
  return { decision_id: id, trigger_id: `trigger:${id}`, strategy_id: "strategy:1", mandate_digest: "AB".repeat(32),
    mandate_version: 1, action: "buy_xrp", hold_codes: [], proposed_value: "60", explanation: "bounded buy",
    created_at: now.toISOString() };
}

describe("StrategyStore durable isolation and concurrency", () => {
  it("scopes the fail-closed global kill by owner and network within one principal binding", async () => {
    const database = new Database();
    try {
      const store = new StrategyStore(d1(database), "shared-principal");
      expect((await store.getGlobalKill(accountA, "testnet")).enabled).toBe(true);
      await store.setGlobalKill(accountA, "testnet", false, "owner authorized", now);
      expect((await store.getGlobalKill(accountA, "testnet")).enabled).toBe(false);
      expect((await store.getGlobalKill(accountB, "testnet")).enabled).toBe(true);
    } finally { database.close(); }
  });

  it("fences an expired worker after a lease takeover", async () => {
    const database = new Database();
    try {
      const scheduler = new StrategySchedulerStore(d1(database));
      const due = { principal: "tenant:a", strategyId: "strategy:1", mandateVersion: 1,
        scheduleGeneration: 0, scheduledFor: now.toISOString() };
      const first = await scheduler.claim(due, "worker:1", now, 1_000);
      expect(first).not.toBeNull();
      const later = new Date(now.getTime() + 2_000);
      const second = await scheduler.claim(due, "worker:2", later, 60_000);
      expect(second?.fencingToken).toBe(2);
      expect(await scheduler.isCurrent(first!, later)).toBe(false);
      expect(await scheduler.isCurrent(second!, later)).toBe(true);
    } finally { database.close(); }
  });

  it("atomically prevents concurrent workers from exceeding the mandate daily cap", async () => {
    const database = new Database();
    try {
      const store = new StrategyStore(d1(database), "tenant:a");
      const results = await Promise.all([
        store.reserveDecision(strategy(), decision("decision:1"), "execution:1", now),
        store.reserveDecision(strategy(), decision("decision:2"), "execution:2", now),
      ]);
      expect(results.sort()).toEqual([false, true]);
      expect(await store.getPendingDailyValue("strategy:1", now)).toBe("60");
    } finally { database.close(); }
  });

  it("replays completed control receipts and rejects digest substitution", async () => {
    const database = new Database();
    try {
      const store = new StrategyStore(d1(database), "tenant:a");
      let calls = 0;
      const digest = "AB".repeat(32);
      expect(await store.runControlOnce("request:1", "pause", digest, async () => ({ strategy_id: "strategy:1", ok: ++calls })))
        .toEqual({ strategy_id: "strategy:1", ok: 1 });
      expect(await store.runControlOnce("request:1", "pause", digest, async () => ({ ok: ++calls }))).toEqual({ strategy_id: "strategy:1", ok: 1 });
      await expect(store.runControlOnce("request:1", "pause", "CD".repeat(32), async () => null))
        .rejects.toThrow("different immutable input");
      expect(calls).toBe(1);
    } finally { database.close(); }
  });
});
