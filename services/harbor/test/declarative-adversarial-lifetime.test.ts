import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
  StrategySchema,
  TESTNET_RLUSD_CURRENCY,
  TESTNET_RLUSD_ISSUER,
  type Strategy,
  type StrategyDecision,
} from "../src/contracts";
import { StrategyStore } from "../src/strategy/store";

type SqlValue = string | number | bigint | null | Uint8Array;
class Statement {
  private values: SqlValue[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]): this { this.values = values as SqlValue[]; return this; }
  async run(): Promise<D1Result> {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } as D1Result["meta"] };
  }
  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }
}
class Database {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec(readFileSync(new URL("../migrations/0011_autonomous_strategies.sql", import.meta.url), "utf8"));
    this.sqlite.exec(readFileSync(new URL("../migrations/0014_declarative_strategies.sql", import.meta.url), "utf8"));
  }
  prepare(sql: string): Statement { return new Statement(this.sqlite.prepare(sql)); }
  close(): void { this.sqlite.close(); }
}

const d1 = (database: Database) => database as unknown as D1Database;
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function strategy(input: {
  id: string;
  version: number;
  notBefore: string;
  expiresAt: string;
  cumulativeValue?: string;
  cumulativeFees?: string;
  totalTrades?: number;
}): Strategy {
  const digest = input.version.toString(16).padStart(2, "0").repeat(32).toUpperCase();
  const created = input.notBefore;
  return StrategySchema.parse({
    strategy_id: input.id,
    lifecycle: "active",
    generation: 1,
    next_evaluation_at: created,
    created_at: created,
    updated_at: created,
    mandate: {
      mandate_id: `mandate:${input.id}:${input.version}`,
      strategy_id: input.id,
      version: input.version,
      digest,
      status: "approved",
      semantics_version: DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
      kind: "declarative_strategy_v1",
      network: "testnet",
      account: OWNER,
      issued_asset: { currency: TESTNET_RLUSD_CURRENCY, issuer: TESTNET_RLUSD_ISSUER },
      plan: {
        plan_version: "1",
        trigger: { kind: "interval", interval_seconds: 300 },
        rules: [{
          rule_id: "buy",
          all: [{ kind: "always" }],
          action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "6" },
        }],
        fallback: { kind: "hold" },
      },
      limits: {
        max_order_value: "6", max_daily_value: input.cumulativeValue === "6" ? "6" : "10",
        max_cumulative_value: input.cumulativeValue ?? "10", min_order_value: "1",
        max_fee_drops: "20", max_daily_fee_drops: input.cumulativeFees ?? "20",
        max_cumulative_fee_drops: input.cumulativeFees ?? "20",
        max_daily_trades: input.totalTrades ?? 10, max_total_trades: input.totalTrades ?? 10,
        cumulative_scope: "owner_network_asset_lifetime",
        max_slippage_bps: 100, max_price_impact_bps: 100,
        min_xrp_reserve_drops: "12000000", fee_buffer_drops: "1000",
        max_xrp_exposure_drops: "1000000000", max_issued_exposure: "1000",
        min_liquidity_value: "10", cooldown_seconds: 300,
        max_quote_age_seconds: 20, max_ledger_gap: 1,
      },
      schedule: { interval_seconds: 300, next_evaluation_at: created },
      execution_mode: "offer_create_fok",
      not_before: input.notBefore,
      expires_at: input.expiresAt,
      authorization: {
        authorization_id: `authorization:${input.id}:${input.version}`,
        method: "wallet_action_proof_v1",
        owner: OWNER,
        mandate_digest: digest,
        mandate_version: input.version,
        approved_at: input.notBefore,
        expires_at: input.expiresAt,
      },
    },
  });
}

function decision(strategyValue: Strategy, suffix: string, value = "6"): StrategyDecision {
  return {
    decision_id: `decision:${suffix}`,
    trigger_id: `trigger:${suffix}`,
    strategy_id: strategyValue.strategy_id,
    mandate_digest: strategyValue.mandate.digest,
    mandate_version: strategyValue.mandate.version,
    action: "buy_xrp",
    hold_codes: [],
    proposed_value: value,
    semantics_version: DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
    plan_digest: strategyValue.mandate.digest,
    matched_rule_id: "buy",
    explanation: "bounded test buy",
    created_at: strategyValue.created_at,
  };
}

describe("declarative lifetime quota cannot be reset by identity churn", () => {
  it("counts same-owner usage across principal, strategy, mandate version and authority window", async () => {
    const database = new Database();
    try {
      const first = strategy({
        id: "strategy:first", version: 1,
        notBefore: "2026-10-23T00:00:00.000Z", expiresAt: "2026-10-23T23:59:59.000Z",
      });
      expect(await new StrategyStore(d1(database), "tenant:first").reserveDecision(
        first, decision(first, "first"), "execution:first", new Date("2026-10-23T12:00:00.000Z"), "12",
      )).toBe(true);

      const copied = strategy({
        id: "strategy:copied", version: 99,
        notBefore: "2026-10-24T00:00:00.000Z", expiresAt: "2026-11-24T00:00:00.000Z",
      });
      expect(await new StrategyStore(d1(database), "tenant:other").reserveDecision(
        copied, decision(copied, "copied", "5"), "execution:copied", new Date("2026-10-24T12:00:00.000Z"), "8",
      )).toBe(false);

      // A fresh owner-approved cap may expand authority, but prior lifetime use remains counted.
      const expanded = strategy({
        id: "strategy:expanded", version: 100,
        notBefore: "2026-10-25T00:00:00.000Z", expiresAt: "2026-11-25T00:00:00.000Z",
        cumulativeValue: "20", cumulativeFees: "40",
      });
      expect(await new StrategyStore(d1(database), "tenant:third").reserveDecision(
        expanded, decision(expanded, "expanded", "5"), "execution:expanded", new Date("2026-10-25T12:00:00.000Z"), "8",
      )).toBe(true);

      const rows = database.sqlite.prepare(`SELECT principal, strategy_id, mandate_version,
        order_value_microunits, fee_drops FROM strategy_declarative_reservations ORDER BY reserved_at`).all();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.principal)).toEqual(["tenant:first", "tenant:third"]);
      expect(rows.reduce((sum, row) => sum + BigInt(row.order_value_microunits as number), 0n)).toBe(11_000_000n);
      expect(rows.reduce((sum, row) => sum + BigInt(row.fee_drops as number), 0n)).toBe(20n);
    } finally {
      database.close();
    }
  });

  it("atomically allows only one concurrent reservation at the remaining lifetime boundary", async () => {
    const database = new Database();
    try {
      const value = strategy({
        id: "strategy:concurrent", version: 1,
        notBefore: "2026-10-23T00:00:00.000Z", expiresAt: "2026-10-30T00:00:00.000Z",
        cumulativeValue: "6", totalTrades: 1,
      });
      const [left, right] = await Promise.all([
        new StrategyStore(d1(database), "tenant:left").reserveDecision(
          value, decision(value, "left"), "execution:left", new Date("2026-10-23T12:00:00.000Z"), "10",
        ),
        new StrategyStore(d1(database), "tenant:right").reserveDecision(
          { ...value, strategy_id: "strategy:other", mandate: { ...value.mandate, mandate_id: "mandate:other", strategy_id: "strategy:other", version: 2 } },
          { ...decision(value, "right"), strategy_id: "strategy:other", mandate_version: 2 },
          "execution:right", new Date("2026-10-23T12:00:00.000Z"), "10",
        ),
      ]);
      expect([left, right].sort()).toEqual([false, true]);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM strategy_declarative_reservations").get())
        .toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("resets the UTC-day counters without resetting owner/network/asset lifetime authority", async () => {
    const database = new Database();
    try {
      const first = strategy({
        id: "strategy:day-one", version: 1,
        notBefore: "2026-10-23T00:00:00.000Z", expiresAt: "2026-11-30T00:00:00.000Z",
      });
      const firstStore = new StrategyStore(d1(database), "tenant:day-one");
      expect(await firstStore.reserveDecision(
        first, decision(first, "day-one"), "execution:day-one",
        new Date("2026-10-23T23:59:59.000Z"), "12",
      )).toBe(true);

      const copied = strategy({
        id: "strategy:day-two", version: 2,
        notBefore: "2026-10-24T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z",
      });
      const secondStore = new StrategyStore(d1(database), "tenant:day-two");
      await expect(secondStore.getDeclarativeUsage(
        copied,
        new Date("2026-10-24T00:00:00.000Z"),
      )).resolves.toMatchObject({
        daily_value: "0",
        cumulative_value: "6",
        daily_fee_drops: "0",
        cumulative_fee_drops: "12",
        daily_trades: 0,
        total_trades: 1,
      });
      expect(await secondStore.reserveDecision(
        copied, decision(copied, "day-two", "5"), "execution:day-two",
        new Date("2026-10-24T00:00:00.000Z"), "1",
      )).toBe(false);
    } finally {
      database.close();
    }
  });
});
