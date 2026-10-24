import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  StrategyDecisionSchema,
  StrategySchema,
  type Strategy,
  type StrategyDecision,
} from "../src/contracts";
import { StrategyStore } from "../src/strategy/store";

type SqlValue = string | number | bigint | null | Uint8Array;

class Statement {
  private values: SqlValue[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]): this {
    this.values = values as SqlValue[];
    return this;
  }
  execute(): D1Result {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      meta: { changes: Number(result.changes) } as D1Result["meta"],
    };
  }
  async run(): Promise<D1Result> { return this.execute(); }
  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }
  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: {} as D1Result<T>["meta"],
    };
  }
}

class Database {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec(readFileSync(
      new URL("../migrations/0011_autonomous_strategies.sql", import.meta.url),
      "utf8",
    ));
    this.sqlite.exec(readFileSync(
      new URL("../migrations/0014_declarative_strategies.sql", import.meta.url),
      "utf8",
    ));
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
const now = new Date("2026-10-22T12:00:00.000Z");
const owner = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const currency = "524C555344000000000000000000000000000000";

function strategy(
  id: string,
  version: number,
  notBefore = "2026-10-22T00:00:00.000Z",
  expiresAt = "2026-10-23T00:00:00.000Z",
  occurrenceLimits?: {
    maxMandateOccurrences: number;
    maxDailyTrades?: number;
    maxTotalTrades?: number;
  },
): Strategy {
  return StrategySchema.parse({
    strategy_id: id,
    lifecycle: "active",
    generation: version,
    next_evaluation_at: now.toISOString(),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    mandate: {
      mandate_id: `mandate:${id}:${version}`,
      strategy_id: id,
      version,
      digest: `${version}`.padStart(64, "A").slice(-64),
      status: "approved",
      semantics_version: "harbor.declarative-strategy/1",
      kind: "declarative_strategy_v1",
      network: "testnet",
      account: owner,
      issued_asset: { currency, issuer },
      plan: {
        plan_version: "1",
        trigger: { kind: "interval", interval_seconds: 300 },
        rules: [{
          rule_id: "fixed-buy",
          all: [{ kind: "always" }],
          action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "60" },
        }],
        fallback: { kind: "hold" },
      },
      limits: {
        max_order_value: "100",
        max_daily_value: "100",
        max_cumulative_value: "100",
        min_order_value: "1",
        max_fee_drops: "10",
        max_daily_fee_drops: "10",
        max_cumulative_fee_drops: "10",
        max_daily_trades: occurrenceLimits?.maxDailyTrades ?? 2,
        max_total_trades: occurrenceLimits?.maxTotalTrades ?? 2,
        ...(occurrenceLimits
          ? { max_mandate_occurrences: occurrenceLimits.maxMandateOccurrences }
          : {}),
        cumulative_scope: "owner_network_asset_lifetime",
        max_slippage_bps: 100,
        max_price_impact_bps: 100,
        min_xrp_reserve_drops: "12000000",
        fee_buffer_drops: "1000",
        max_xrp_exposure_drops: "1000000000",
        max_issued_exposure: "1000",
        min_liquidity_value: "1",
        cooldown_seconds: 300,
        max_quote_age_seconds: 20,
        max_ledger_gap: 1,
      },
      schedule: { interval_seconds: 300, next_evaluation_at: now.toISOString() },
      execution_mode: "offer_create_fok",
      not_before: notBefore,
      expires_at: expiresAt,
      authorization: {
        authorization_id: `auth:${id}:${version}`,
        method: "wallet_action_proof_v1",
        owner,
        mandate_digest: `${version}`.padStart(64, "A").slice(-64),
        mandate_version: version,
        approved_at: notBefore,
        expires_at: expiresAt,
      },
    },
  });
}

function decision(id: string, strategyId: string, value: string): StrategyDecision {
  return StrategyDecisionSchema.parse({
    decision_id: id,
    trigger_id: `trigger:${id}`,
    strategy_id: strategyId,
    mandate_digest: "AB".repeat(32),
    mandate_version: 1,
    action: "buy_xrp",
    hold_codes: [],
    proposed_value: value,
    semantics_version: "harbor.declarative-strategy/1",
    plan_digest: "AB".repeat(32),
    matched_rule_id: "fixed-buy",
    explanation: "bounded fixed buy",
    created_at: now.toISOString(),
  });
}

describe("declarative strategy account-global reservations", () => {
  it("cannot reset value, fee, or trade-count limits with another principal, strategy, revision, or authority window", async () => {
    const database = new Database();
    try {
      const first = strategy("strategy:first", 1);
      const copied = strategy(
        "strategy:copied",
        9,
        "2026-10-22T11:00:00.000Z",
        "2026-10-24T00:00:00.000Z",
      );
      const storeA = new StrategyStore(d1(database), "principal:a");
      const storeB = new StrategyStore(d1(database), "principal:b");

      expect(await storeA.reserveDecision(
        first,
        decision("decision:first", first.strategy_id, "60"),
        "execution:first",
        now,
        "4",
      )).toBe(true);
      expect(await storeB.reserveDecision(
        copied,
        decision("decision:too-much", copied.strategy_id, "50"),
        "execution:too-much",
        now,
        "1",
      )).toBe(false);
      expect(await storeB.reserveDecision(
        copied,
        decision("decision:second", copied.strategy_id, "30"),
        "execution:second",
        now,
        "4",
      )).toBe(true);
      expect(await storeA.reserveDecision(
        strategy("strategy:third", 2),
        decision("decision:third", "strategy:third", "5"),
        "execution:third",
        now,
        "1",
      )).toBe(false);

      await expect(storeB.getDeclarativeUsage(copied, now)).resolves.toEqual({
        daily_value: "90",
        cumulative_value: "90",
        daily_fee_drops: "8",
        cumulative_fee_drops: "8",
        daily_trades: 2,
        total_trades: 2,
        mandate_occurrences: 1,
      });
      await expect(storeB.updateReservedFee(
        copied,
        "decision:second",
        "7",
        now,
      )).resolves.toBe(false);
    } finally {
      database.close();
    }
  });

  it("reserves finite mandate occurrences atomically and does not double count restart retries or ambiguity", async () => {
    const database = new Database();
    try {
      const recurring = strategy(
        "strategy:recurring",
        1,
        undefined,
        undefined,
        { maxMandateOccurrences: 2, maxTotalTrades: 10 },
      );
      const firstStore = new StrategyStore(d1(database), "principal:recurring");
      const firstDecision = decision("decision:occurrence:1", recurring.strategy_id, "10");
      await firstStore.beginExecution(firstDecision, "execution:occurrence:1", "idem:occurrence:1", now);
      expect(await firstStore.reserveDecision(
        recurring,
        firstDecision,
        "execution:occurrence:1",
        now,
        "1",
      )).toBe(true);
      await firstStore.markExecution("execution:occurrence:1", "unknown", now);

      const restarted = new StrategyStore(d1(database), "principal:recurring");
      await expect(restarted.getDeclarativeUsage(recurring, now)).resolves.toMatchObject({
        mandate_occurrences: 1,
        total_trades: 1,
      });
      expect(await restarted.reserveDecision(
        recurring,
        firstDecision,
        "execution:occurrence:1",
        now,
        "1",
      )).toBe(false);

      const secondDecision = decision("decision:occurrence:2", recurring.strategy_id, "10");
      const thirdDecision = decision("decision:occurrence:3", recurring.strategy_id, "10");
      await restarted.beginExecution(secondDecision, "execution:occurrence:2", "idem:occurrence:2", now);
      await restarted.beginExecution(thirdDecision, "execution:occurrence:3", "idem:occurrence:3", now);
      expect((await Promise.all([
        restarted.reserveDecision(
          recurring,
          secondDecision,
          "execution:occurrence:2",
          now,
          "1",
        ),
        restarted.reserveDecision(
          recurring,
          thirdDecision,
          "execution:occurrence:3",
          now,
          "1",
        ),
      ])).sort()).toEqual([false, true]);
      await expect(restarted.getDeclarativeUsage(recurring, now)).resolves.toMatchObject({
        mandate_occurrences: 2,
        total_trades: 2,
      });
    } finally {
      database.close();
    }
  });

  it("frees only marked pre-submit and not-included occurrences while charging post-dispatch failures", async () => {
    const database = new Database();
    try {
      const recurring = strategy(
        "strategy:release-semantics",
        1,
        undefined,
        undefined,
        { maxMandateOccurrences: 2, maxTotalTrades: 10 },
      );
      const store = new StrategyStore(d1(database), "principal:release-semantics");

      const preSubmit = decision("decision:pre-submit", recurring.strategy_id, "10");
      await store.beginExecution(preSubmit, "execution:pre-submit", "idem:pre-submit", now);
      expect(await store.reserveDecision(recurring, preSubmit, "execution:pre-submit", now, "1")).toBe(true);
      database.sqlite.prepare(`UPDATE strategy_declarative_reservations
        SET state = 'released', release_evidence = ? WHERE decision_id = ?`).run(
        JSON.stringify({ occurrence_release_reason: "pre_submit" }),
        preSubmit.decision_id,
      );

      const notIncluded = decision("decision:not-included", recurring.strategy_id, "10");
      await store.beginExecution(notIncluded, "execution:not-included", "idem:not-included", now);
      expect(await store.reserveDecision(recurring, notIncluded, "execution:not-included", now, "1")).toBe(true);
      database.sqlite.prepare(`UPDATE strategy_declarative_reservations
        SET state = 'released', release_evidence = ? WHERE decision_id = ?`).run(
        JSON.stringify({ occurrence_release_reason: "not_included" }),
        notIncluded.decision_id,
      );
      expect(database.sqlite.prepare(`SELECT decision_id, state,
        json_extract(release_evidence, '$.occurrence_release_reason') AS occurrence_release_reason
        FROM strategy_declarative_reservations ORDER BY decision_id`).all()).toEqual([
        {
          decision_id: "decision:not-included",
          state: "released",
          occurrence_release_reason: "not_included",
        },
        {
          decision_id: "decision:pre-submit",
          state: "released",
          occurrence_release_reason: "pre_submit",
        },
      ]);

      const postDispatchFailure = decision("decision:post-failure", recurring.strategy_id, "10");
      await store.beginExecution(postDispatchFailure, "execution:post-failure", "idem:post-failure", now);
      expect(await store.reserveDecision(recurring, postDispatchFailure, "execution:post-failure", now, "1")).toBe(true);
      database.sqlite.prepare(`UPDATE strategy_declarative_reservations
        SET state = 'released', release_evidence = ? WHERE decision_id = ?`).run(
        JSON.stringify({ state: "failed" }),
        postDispatchFailure.decision_id,
      );

      await expect(store.getDeclarativeUsage(recurring, now)).resolves.toMatchObject({
        mandate_occurrences: 1,
        total_trades: 0,
      });
      const next = decision("decision:after-release", recurring.strategy_id, "10");
      await store.beginExecution(next, "execution:after-release", "idem:after-release", now);
      expect(await store.reserveDecision(recurring, next, "execution:after-release", now, "1")).toBe(true);
      const exhausted = decision("decision:exhausted", recurring.strategy_id, "10");
      await store.beginExecution(exhausted, "execution:exhausted", "idem:exhausted", now);
      expect(await store.reserveDecision(recurring, exhausted, "execution:exhausted", now, "1")).toBe(false);
    } finally {
      database.close();
    }
  });

  it("resets occurrences only for a newly approved digest while retaining prior lifetime value and trade usage", async () => {
    const database = new Database();
    try {
      const store = new StrategyStore(d1(database), "principal:versioned-recurring");
      const first = strategy(
        "strategy:versioned-recurring",
        1,
        undefined,
        undefined,
        { maxMandateOccurrences: 1, maxDailyTrades: 1, maxTotalTrades: 10 },
      );
      const firstDecision = decision("decision:version:1", first.strategy_id, "60");
      expect(await store.reserveDecision(first, firstDecision, "execution:version:1", now, "1")).toBe(true);

      const second = strategy(
        "strategy:versioned-recurring",
        2,
        undefined,
        undefined,
        { maxMandateOccurrences: 2, maxDailyTrades: 2, maxTotalTrades: 2 },
      );
      expect(second.mandate.digest).not.toBe(first.mandate.digest);
      expect(second.mandate.status).toBe("approved");
      expect(second.mandate.authorization).toMatchObject({
        mandate_digest: second.mandate.digest,
        mandate_version: 2,
      });
      const secondDecision = decision("decision:version:2", second.strategy_id, "30");
      expect(await store.reserveDecision(second, secondDecision, "execution:version:2", now, "1")).toBe(true);
      await expect(store.getDeclarativeUsage(second, now)).resolves.toMatchObject({
        cumulative_value: "90",
        total_trades: 2,
        mandate_occurrences: 1,
      });
      expect(await store.reserveDecision(
        second,
        decision("decision:version:2:total-cap", second.strategy_id, "5"),
        "execution:version:2:total-cap",
        now,
        "1",
      )).toBe(false);

      const third = strategy(
        "strategy:versioned-recurring",
        3,
        undefined,
        "2026-10-24T00:00:00.000Z",
        { maxMandateOccurrences: 2, maxDailyTrades: 2, maxTotalTrades: 10 },
      );
      const nextDay = new Date("2026-10-23T12:00:00.000Z");
      expect(third.mandate.digest).not.toBe(second.mandate.digest);
      expect(await store.reserveDecision(
        third,
        decision("decision:version:3:value-cap", third.strategy_id, "20"),
        "execution:version:3:value-cap",
        nextDay,
        "1",
      )).toBe(false);
      expect(await store.reserveDecision(
        third,
        decision("decision:version:3:within", third.strategy_id, "5"),
        "execution:version:3:within",
        nextDay,
        "1",
      )).toBe(true);
      await expect(store.getDeclarativeUsage(third, nextDay)).resolves.toMatchObject({
        cumulative_value: "95",
        total_trades: 3,
        mandate_occurrences: 1,
      });
    } finally {
      database.close();
    }
  });

  it("keeps the canonical and isolated-profile migration bytes identical", () => {
    expect(readFileSync(
      new URL("../migrations/0014_declarative_strategies.sql", import.meta.url),
      "utf8",
    )).toBe(readFileSync(
      new URL("../migrations-profile-trading-isolated-v1/0014_declarative_strategies.sql", import.meta.url),
      "utf8",
    ));
  });
});
