import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { StrategyCreateArgs, StrategyDecision } from "../src/contracts";
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
  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} as D1Result<T>["meta"] };
  }
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
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void { this.sqlite.close(); }
}

const d1 = (database: Database) => database as unknown as D1Database;
const now = new Date("2026-10-23T12:00:00.000Z");
const ownerA = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ownerB = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const issuer = ownerB;
const digest = "AB".repeat(32);

const draft: StrategyCreateArgs = {
  kind: "xrp_issued_rebalancer_v1",
  network: "testnet",
  account: ownerA,
  issued_asset: { currency: "524C555344000000000000000000000000000000", issuer },
  allocation: { target_xrp_bps: 5000, lower_xrp_bps: 4500, upper_xrp_bps: 5500 },
  limits: {
    max_order_value: "25", max_daily_value: "100", min_order_value: "1", max_fee_drops: "20",
    max_slippage_bps: 100, max_price_impact_bps: 100, min_xrp_reserve_drops: "12000000",
    fee_buffer_drops: "1000", max_xrp_exposure_drops: "1000000000", max_issued_exposure: "1000",
    min_liquidity_value: "50", cooldown_seconds: 300, max_quote_age_seconds: 20, max_ledger_gap: 1,
  },
  interval_seconds: 300,
  execution_mode: "offer_create_fok",
  not_before: now.toISOString(),
  expires_at: "2026-10-24T12:00:00.000Z",
};

function insertStrategy(database: Database, principal: string, id: string, owner = ownerA): void {
  database.sqlite.prepare(`INSERT INTO strategies(
    id, principal, owner, network, issued_currency, issued_issuer, lifecycle,
    mandate_id, mandate_version, mandate_digest, generation, created_at, updated_at
  ) VALUES (?, ?, ?, 'testnet', ?, ?, 'active', ?, 1, ?, 1, ?, ?)`)
    .run(id, principal, owner, draft.issued_asset.currency, issuer, `mandate:${id}`, digest,
      now.toISOString(), now.toISOString());
}

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

describe("strategy owner scope migration", () => {
  it("atomically rejects a second principal for the same owner and network", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(migration("0011_autonomous_strategies.sql"));
      database.exec(migration("0014_declarative_strategies.sql"));
      database.exec(migration("0015_strategy_owner_scope.sql"));
      database.exec("PRAGMA foreign_keys = OFF");
      const insert = database.prepare(`INSERT INTO strategies(
        id, principal, owner, network, issued_currency, issued_issuer, lifecycle,
        mandate_id, mandate_version, mandate_digest, generation, created_at, updated_at
      ) VALUES (?, ?, ?, 'testnet', ?, ?, 'draft', ?, 1, ?, 0, ?, ?)`);
      insert.run("strategy:a", "tenant:a", ownerA, draft.issued_asset.currency, issuer,
        "mandate:a", digest, now.toISOString(), now.toISOString());
      expect(() => insert.run("strategy:b", "tenant:b", ownerA, draft.issued_asset.currency, issuer,
        "mandate:b", "CD".repeat(32), now.toISOString(), now.toISOString())).toThrow();
      expect(() => insert.run("strategy:other-owner", "tenant:b", ownerB, draft.issued_asset.currency, issuer,
        "mandate:other", "EF".repeat(32), now.toISOString(), now.toISOString())).not.toThrow();
    } finally { database.close(); }
  });

  it("fails migration rather than choosing among pre-existing conflicting principals", () => {
    const database = new Database();
    try {
      insertStrategy(database, "tenant:a", "strategy:a");
      insertStrategy(database, "tenant:b", "strategy:b");
      database.sqlite.exec(migration("0014_declarative_strategies.sql"));
      expect(() => database.sqlite.exec(migration("0015_strategy_owner_scope.sql"))).toThrow();
    } finally { database.close(); }
  });
});

describe("fail-closed account-wide kill owner binding", () => {
  it("makes a legacy cross-principal conflict visible as killed and forbids clear", async () => {
    const database = new Database();
    try {
      insertStrategy(database, "tenant:a", "strategy:a");
      insertStrategy(database, "tenant:b", "strategy:b");
      const first = new StrategyStore(d1(database), "tenant:a");
      const second = new StrategyStore(d1(database), "tenant:b");

      expect((await first.setGlobalKill(ownerA, "testnet", true, "Emergency stop", now)).enabled).toBe(true);
      expect((await second.getGlobalKill(ownerA, "testnet")).enabled).toBe(true);
      await expect(first.setGlobalKill(ownerA, "testnet", false, "Attempted clear", now))
        .rejects.toThrow("conflicts across authenticated principals");

      expect((await first.setGlobalKill(ownerB, "testnet", false, "Independent owner", now)).enabled).toBe(false);
      await expect(first.setGlobalKill(ownerB, "devnet" as "testnet", false, "Wrong network", now))
        .rejects.toThrow();
      expect((await first.getGlobalKill(ownerB, "testnet")).enabled).toBe(false);
    } finally { database.close(); }
  });

  it("fences a submission if conflicting principal state appears before relay", async () => {
    const database = new Database();
    try {
      const store = new StrategyStore(d1(database), "tenant:a");
      const created = await store.createDraft(draft, now);
      await store.setGlobalKill(ownerA, "testnet", false, "Owner enabled strategy", now);
      const strategy = await store.authorizeAndActivate({
        strategy_id: created.strategy_id,
        mandate_version: created.mandate.version,
        mandate_digest: created.mandate.digest,
        authorization: {
          authorization_id: "authorization:owner-scope",
          method: "wallet_action_proof_v1",
          owner: ownerA,
          mandate_digest: created.mandate.digest,
          mandate_version: created.mandate.version,
          approved_at: now.toISOString(),
          expires_at: draft.expires_at,
        },
      }, now);
      const scheduler = new StrategySchedulerStore(d1(database));
      const lease = await scheduler.claim({
        principal: "tenant:a", strategyId: strategy.strategy_id,
        mandateVersion: 1, scheduleGeneration: 0, scheduledFor: now.toISOString(),
      }, "runner:owner-scope", now, 60_000);
      expect(lease).not.toBeNull();
      const decision: StrategyDecision = {
        decision_id: "decision:owner-scope", trigger_id: "trigger:owner-scope",
        strategy_id: strategy.strategy_id, mandate_digest: strategy.mandate.digest,
        mandate_version: strategy.mandate.version, action: "buy_xrp", hold_codes: [],
        proposed_value: "5", explanation: "bounded test", created_at: now.toISOString(),
      };
      await store.beginExecution(decision, "execution:owner-scope", "strategy:owner-scope", now);
      expect(await store.reserveDecision(strategy, decision, "execution:owner-scope", now, "10")).toBe(true);

      insertStrategy(database, "tenant:b", "strategy:conflict");
      expect(await store.markSubmittingFenced("execution:owner-scope", strategy, lease!, now)).toBe(false);
      expect(database.sqlite.prepare(`SELECT submission_state, unresolved FROM strategy_executions
        WHERE id = 'execution:owner-scope'`).get()).toEqual({ submission_state: "prepared", unresolved: 1 });
      expect(database.sqlite.prepare(`SELECT state FROM strategy_budget_reservations
        WHERE execution_id = 'execution:owner-scope'`).get()).toEqual({ state: "reserved" });
    } finally { database.close(); }
  });
});
