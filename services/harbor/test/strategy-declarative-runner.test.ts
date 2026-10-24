import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  StrategyDecisionSchema,
  type Strategy,
  type StrategyCreateArgs,
} from "../src/contracts";
import type { StrategyObservation } from "../src/strategy/engine";
import {
  runStrategyScheduler,
  type StrategyExecutionAdapter,
} from "../src/strategy/runner";
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
    for (const name of [
      "0011_autonomous_strategies.sql",
      "0014_declarative_strategies.sql",
    ]) {
      this.sqlite.exec(readFileSync(
        new URL(`../migrations/${name}`, import.meta.url),
        "utf8",
      ));
    }
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
const principal = "tenant:declarative-runner";
const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const currency = "524C555344000000000000000000000000000000";
const createdAt = new Date("2026-10-22T12:00:00.000Z");
const dueAt = new Date(createdAt.getTime() + 300_001);

const draft: StrategyCreateArgs = {
  semantics_version: "harbor.declarative-strategy/1",
  kind: "declarative_strategy_v1",
  network: "testnet",
  account,
  issued_asset: { currency, issuer },
  plan: {
    plan_version: "1",
    trigger: { kind: "interval", interval_seconds: 300 },
    rules: [{
      rule_id: "price-buy",
      all: [{
        kind: "price_threshold",
        side: "ask",
        comparator: "lte",
        price: "1",
      }],
      action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "5" },
    }],
    fallback: { kind: "hold" },
  },
  limits: {
    max_order_value: "10",
    max_daily_value: "20",
    max_cumulative_value: "20",
    min_order_value: "1",
    max_fee_drops: "20",
    max_daily_fee_drops: "100",
    max_cumulative_fee_drops: "1000",
    max_daily_trades: 10,
    max_total_trades: 20,
    cumulative_scope: "owner_network_asset_lifetime",
    max_slippage_bps: 100,
    max_price_impact_bps: 100,
    min_xrp_reserve_drops: "12000000",
    fee_buffer_drops: "1000",
    max_xrp_exposure_drops: "1000000000",
    max_issued_exposure: "1000",
    min_liquidity_value: "5",
    cooldown_seconds: 300,
    max_quote_age_seconds: 20,
    max_ledger_gap: 1,
  },
  execution_mode: "offer_create_fok",
  not_before: createdAt.toISOString(),
  expires_at: "2026-10-23T12:00:00.000Z",
};

async function activeStrategy(
  database: Database,
  expiresAt = draft.expires_at,
  maxMandateOccurrences?: number,
): Promise<Strategy> {
  const store = new StrategyStore(d1(database), principal);
  const created = await store.createDraft({
    ...draft,
    expires_at: expiresAt,
    limits: {
      ...draft.limits,
      ...(maxMandateOccurrences === undefined
        ? {}
        : {
            max_daily_trades: Math.min(
              draft.limits.max_daily_trades,
              maxMandateOccurrences,
            ),
            max_mandate_occurrences: maxMandateOccurrences,
          }),
    },
  }, createdAt);
  await store.setGlobalKill(
    account,
    "testnet",
    false,
    "offline test activation gate",
    createdAt,
  );
  return store.authorizeAndActivate({
    strategy_id: created.strategy_id,
    mandate_version: created.mandate.version,
    mandate_digest: created.mandate.digest,
    authorization: {
      authorization_id: "authorization:declarative-runner",
      method: "wallet_action_proof_v1",
      owner: account,
      mandate_digest: created.mandate.digest,
      mandate_version: created.mandate.version,
      approved_at: createdAt.toISOString(),
      expires_at: expiresAt,
    },
  }, createdAt);
}

function observation(at: Date, ask = "1"): StrategyObservation {
  return {
    account,
    network: "testnet",
    issuedCurrency: currency,
    issuedIssuer: issuer,
    xrpBalanceDrops: "100000000",
    issuedBalance: "100",
    bid: ask === "1" ? "0.995" : "1.095",
    ask,
    executableLiquidityValue: "1000",
    feeDrops: "10",
    reserveBaseDrops: "10000000",
    reserveIncrementDrops: "2000000",
    ownerCount: 1,
    pendingDailyValue: "0",
    ledgerIndex: 100,
    quoteLedgerIndex: 100,
    observedAt: at.toISOString(),
    grantActive: true,
    policyActive: true,
  };
}

function adapter(
  observations: StrategyObservation[],
  calls: { observe: number; build: number; execute: number },
): StrategyExecutionAdapter {
  return {
    async observe() {
      const value = observations[Math.min(calls.observe, observations.length - 1)]!;
      calls.observe += 1;
      return value;
    },
    async build(_strategy, decision) {
      calls.build += 1;
      expect(decision).toMatchObject({
        action: "buy_xrp",
        matched_rule_id: "price-buy",
        semantics_version: "harbor.declarative-strategy/1",
        proposed_value: "5",
      });
      return {
        buildId: "build:declarative",
        buildRevision: 1,
        lastLedgerSequence: 120,
        feeDrops: "11",
      };
    },
    async execute() {
      calls.execute += 1;
      return { status: "executed", txHash: "AB".repeat(32), network: "testnet",
        ledgerIndex: 101, validated: true, engineResult: "tesSUCCESS", result: "success" };
    },
    async reconcile() { return { status: "pending" }; },
  };
}

async function run(
  database: Database,
  executionAdapter: StrategyExecutionAdapter,
  at = dueAt,
) {
  return runStrategyScheduler({
    db: d1(database),
    now: at,
    holderId: "runner:declarative",
    clock: () => at,
    adapterForPrincipal: () => executionAdapter,
  });
}

describe("declarative strategy runner", () => {
  it("executes one compiled fixed swap and commits its aggregate reservation", async () => {
    const database = new Database();
    try {
      await activeStrategy(database);
      const calls = { observe: 0, build: 0, execute: 0 };
      const summary = await run(database, adapter([
        observation(dueAt),
        observation(dueAt),
      ], calls));

      expect(summary.executed).toBe(1);
      expect(calls).toEqual({ observe: 2, build: 1, execute: 1 });
      expect(database.sqlite.prepare(`SELECT state, order_value, fee_drops
        FROM strategy_declarative_reservations`).get()).toEqual({
        state: "committed",
        order_value: "5",
        fee_drops: 11,
      });
    } finally {
      database.close();
    }
  });

  it("holds before build when lifetime owner/network/asset usage is exhausted", async () => {
    const database = new Database();
    try {
      const strategy = await activeStrategy(database);
      const prior = StrategyDecisionSchema.parse({
        decision_id: "decision:prior",
        trigger_id: "trigger:prior",
        strategy_id: strategy.strategy_id,
        mandate_digest: strategy.mandate.digest,
        mandate_version: strategy.mandate.version,
        action: "buy_xrp",
        hold_codes: [],
        proposed_value: "20",
        semantics_version: "harbor.declarative-strategy/1",
        plan_digest: strategy.mandate.digest,
        matched_rule_id: "price-buy",
        explanation: "prior bounded trade",
        created_at: createdAt.toISOString(),
      });
      expect(await new StrategyStore(d1(database), "another-principal").reserveDecision(
        strategy,
        prior,
        "execution:prior",
        new Date("2026-10-21T12:00:00.000Z"),
        "10",
      )).toBe(true);

      const calls = { observe: 0, build: 0, execute: 0 };
      const summary = await run(database, adapter([observation(dueAt)], calls));
      expect(summary.held).toBe(1);
      expect(calls).toEqual({ observe: 1, build: 0, execute: 0 });
      const row = database.sqlite.prepare(
        "SELECT hold_codes_json FROM strategy_decisions",
      ).get() as { hold_codes_json: string };
      expect(JSON.parse(row.hold_codes_json)).toContain("cumulative_limit");
    } finally {
      database.close();
    }
  });

  it("releases the reservation and blocks submit when the matched rule changes", async () => {
    const database = new Database();
    try {
      const strategy = await activeStrategy(database);
      const calls = { observe: 0, build: 0, execute: 0 };
      const summary = await run(database, adapter([
        observation(dueAt, "1"),
        observation(dueAt, "1.1"),
      ], calls));

      expect(summary.blocked).toBe(1);
      expect(calls).toEqual({ observe: 2, build: 1, execute: 0 });
      expect(database.sqlite.prepare(
        "SELECT state FROM strategy_declarative_reservations",
      ).get()).toEqual({ state: "released" });
      expect((await new StrategyStore(d1(database), principal)
        .getStrategy(strategy.strategy_id))?.lifecycle).toBe("paused");
    } finally {
      database.close();
    }
  });

  it("atomically rejects authority that expires during pre-submit reads", async () => {
    const database = new Database();
    try {
      const expiresAt = new Date(dueAt.getTime() + 1).toISOString();
      await activeStrategy(database, expiresAt);
      const calls = { observe: 0, build: 0, execute: 0 };
      let clockReads = 0;
      const expired = new Date(dueAt.getTime() + 2);
      const summary = await runStrategyScheduler({
        db: d1(database),
        now: dueAt,
        holderId: "runner:expiry-race",
        clock: () => {
          clockReads += 1;
          return clockReads < 8 ? dueAt : expired;
        },
        adapterForPrincipal: () => adapter([
          observation(dueAt),
          observation(dueAt),
        ], calls),
      });

      expect(summary.blocked).toBe(1);
      expect(calls.build).toBe(1);
      expect(calls.execute).toBe(0);
      expect(database.sqlite.prepare(
        "SELECT submission_state FROM strategy_executions",
      ).get()).toEqual({ submission_state: "failed" });
    } finally {
      database.close();
    }
  });

  it("does not consume an occurrence when build fails before execute", async () => {
    const database = new Database();
    try {
      const strategy = await activeStrategy(database, draft.expires_at, 1);
      const calls = { observe: 0, build: 0, execute: 0 };
      const failing = adapter([
        observation(dueAt),
        observation(dueAt),
      ], calls);
      failing.build = async () => {
        calls.build += 1;
        throw new Error("simulation rejected before submission");
      };

      const summary = await run(database, failing);
      expect(summary.failed).toBe(1);
      expect(calls).toEqual({ observe: 1, build: 1, execute: 0 });
      await expect(
        new StrategyStore(d1(database), principal).getDeclarativeUsage(
          strategy,
          dueAt,
        ),
      ).resolves.toMatchObject({ mandate_occurrences: 0 });
      const row = database.sqlite.prepare(`SELECT state, release_evidence
        FROM strategy_declarative_reservations`).get() as {
          state: string;
          release_evidence: string;
        };
      expect(row.state).toBe("released");
      expect(JSON.parse(row.release_evidence)).toMatchObject({
        occurrence_release_reason: "pre_submit",
      });
    } finally {
      database.close();
    }
  });

  it("holds without building after the approved mandate occurrence count is exhausted", async () => {
    const database = new Database();
    try {
      await activeStrategy(database, draft.expires_at, 1);
      const firstCalls = { observe: 0, build: 0, execute: 0 };
      expect((await run(database, adapter([
        observation(dueAt),
        observation(dueAt),
      ], firstCalls))).executed).toBe(1);

      const nextDue = new Date(dueAt.getTime() + 300_000);
      const calls = { observe: 0, build: 0, execute: 0 };
      const summary = await run(
        database,
        adapter([observation(nextDue)], calls),
        nextDue,
      );
      expect(summary.held).toBe(1);
      expect(calls).toEqual({ observe: 1, build: 0, execute: 0 });
      const latest = database.sqlite.prepare(`SELECT explanation, hold_codes_json
        FROM strategy_decisions ORDER BY created_at DESC, id DESC LIMIT 1`).get() as {
          explanation: string;
          hold_codes_json: string;
        };
      expect(latest.explanation).toContain("executed-action occurrence count");
      expect(JSON.parse(latest.hold_codes_json)).toContain("trade_count_limit");
    } finally {
      database.close();
    }
  });
});
