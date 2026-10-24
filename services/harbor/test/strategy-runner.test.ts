import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { XrplRpc } from "../src/adapters/xrpl-rpc";
import type { StrategyCreateArgs, StrategyDecision } from "../src/contracts";
import type { StrategyObservation } from "../src/strategy/engine";
import { createProductionStrategyAdapter } from "../src/strategy/execution-adapter";
import {
  runStrategyScheduler,
  type StrategyExecutionAdapter,
} from "../src/strategy/runner";
import {
  stableStrategyId,
  StrategySchedulerStore,
  StrategyStore,
} from "../src/strategy/store";

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
const principal = "tenant:runner";
const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const currency = "524C555344000000000000000000000000000000";
const createdAt = new Date("2026-10-22T12:00:00.000Z");
const dueAt = new Date(createdAt.getTime() + 300_001);

const draft: StrategyCreateArgs = {
  kind: "xrp_issued_rebalancer_v1",
  network: "testnet",
  account,
  issued_asset: { currency, issuer },
  allocation: { target_xrp_bps: 5000, lower_xrp_bps: 4500, upper_xrp_bps: 5500 },
  limits: {
    max_order_value: "25",
    max_daily_value: "100",
    min_order_value: "1",
    max_fee_drops: "20",
    max_slippage_bps: 100,
    max_price_impact_bps: 100,
    min_xrp_reserve_drops: "12000000",
    fee_buffer_drops: "1000",
    max_xrp_exposure_drops: "1000000000",
    max_issued_exposure: "1000",
    min_liquidity_value: "50",
    cooldown_seconds: 300,
    max_quote_age_seconds: 20,
    max_ledger_gap: 1,
  },
  interval_seconds: 300,
  execution_mode: "offer_create_fok",
  not_before: createdAt.toISOString(),
  expires_at: "2026-10-23T12:00:00.000Z",
};

async function activeStrategy(database: Database, expiry = draft.expires_at) {
  const store = new StrategyStore(d1(database), principal);
  const created = await store.createDraft({ ...draft, expires_at: expiry }, createdAt);
  await store.setGlobalKill(account, "testnet", false, "offline test activation gate", createdAt);
  return store.authorizeAndActivate({
    strategy_id: created.strategy_id,
    mandate_version: created.mandate.version,
    mandate_digest: created.mandate.digest,
    authorization: {
      authorization_id: "authorization:runner",
      method: "wallet_action_proof_v1",
      owner: account,
      mandate_digest: created.mandate.digest,
      mandate_version: created.mandate.version,
      approved_at: createdAt.toISOString(),
      expires_at: expiry,
    },
  }, createdAt);
}

function observation(at: Date, xrpBalanceDrops: string, issuedBalance: string): StrategyObservation {
  return {
    account,
    network: "testnet",
    issuedCurrency: currency,
    issuedIssuer: issuer,
    xrpBalanceDrops,
    issuedBalance,
    bid: "1",
    ask: "1",
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

function adapter(options: {
  observation: StrategyObservation;
  outcome?: Awaited<ReturnType<StrategyExecutionAdapter["execute"]>>;
  buildError?: Error;
  reconcile?: Awaited<ReturnType<StrategyExecutionAdapter["reconcile"]>>;
  calls?: { observe: number; build: number; execute: number; reconcile: number };
}): StrategyExecutionAdapter {
  const calls = options.calls ?? { observe: 0, build: 0, execute: 0, reconcile: 0 };
  return {
    async observe() { calls.observe += 1; return options.observation; },
    async build() {
      calls.build += 1;
      if (options.buildError) throw options.buildError;
      return { buildId: "build:runner", buildRevision: 1, lastLedgerSequence: 120, feeDrops: "10" };
    },
    async execute() {
      calls.execute += 1;
      return options.outcome ?? { status: "executed", txHash: "AB".repeat(32) };
    },
    async reconcile() {
      calls.reconcile += 1;
      return options.reconcile ?? { status: "pending" };
    },
  };
}

async function run(database: Database, executionAdapter: StrategyExecutionAdapter, now = dueAt, holderId = "runner:1") {
  return runStrategyScheduler({
    db: d1(database),
    now,
    holderId,
    clock: () => now,
    adapterForPrincipal: () => executionAdapter,
  });
}

describe("autonomous strategy runner restart and safety boundaries", () => {
  it("holds inside the band without building, then advances exactly one schedule generation", async () => {
    const database = new Database();
    try {
      const strategy = await activeStrategy(database);
      const calls = { observe: 0, build: 0, execute: 0, reconcile: 0 };
      const result = await run(database, adapter({ observation: observation(dueAt, "50000000", "50"), calls }));
      expect(result.held).toBe(1);
      expect(calls).toMatchObject({ observe: 1, build: 0, execute: 0 });
      const current = await new StrategyStore(d1(database), principal).getStrategy(strategy.strategy_id);
      expect(current?.hold_reason).toContain("inside the approved band");
      const schedule = database.sqlite.prepare("SELECT generation FROM strategy_schedules WHERE strategy_id = ?").get(strategy.strategy_id) as { generation: number };
      expect(schedule.generation).toBe(2);
    } finally { database.close(); }
  });

  it("uses a post-read clock and holds when slow observations become stale", async () => {
    const database = new Database();
    try {
      await activeStrategy(database);
      const calls = { observe: 0, build: 0, execute: 0, reconcile: 0 };
      const late = new Date(dueAt.getTime() + 21_000);
      const result = await runStrategyScheduler({ db: d1(database), now: dueAt, holderId: "runner:slow-read",
        clock: () => late, adapterForPrincipal: () => adapter({
          observation: observation(dueAt, "10000000", "90"), calls,
        }) });
      expect(result.held).toBe(1);
      expect(calls.build).toBe(0);
      const row = database.sqlite.prepare("SELECT hold_codes_json FROM strategy_decisions").get() as { hold_codes_json: string };
      expect(JSON.parse(row.hold_codes_json)).toContain("stale_price");
    } finally { database.close(); }
  });

  it("counts production RPC latency from read start through the runner decision clock", async () => {
    const database = new Database();
    try {
      await activeStrategy(database);
      let clockTime = dueAt;
      const late = new Date(dueAt.getTime() + 21_000);
      const rpc: XrplRpc = { request: async (_network, command, params = {}) => {
        if (command === "account_info") return { validated: true, ledger_index: 100,
          account_data: { Account: account, Balance: "10000000", OwnerCount: 1 } };
        if (command === "account_lines") {
          clockTime = late;
          return { validated: true, ledger_index: 100,
            lines: [{ account: issuer, currency, balance: "90", peer_authorized: true }] };
        }
        if (command === "book_offers") {
          const gets = params.taker_gets as { currency?: string };
          return { validated: true, ledger_index: 100, offers: [gets.currency === "XRP"
            ? { TakerGets: "1000000", TakerPays: { currency, issuer, value: "1" } }
            : { TakerGets: { currency, issuer, value: "1" }, TakerPays: "1000000" }] };
        }
        if (command === "fee") return { drops: { open_ledger_fee: "10" } };
        if (command === "server_info") return { info: { validated_ledger: { reserve_base_xrp: "10", reserve_inc_xrp: "2" } } };
        throw new Error(`unexpected RPC ${command}`);
      } };
      const observationDb = { prepare: (sql: string) => ({ bind: () => ({ first: async () =>
        sql.includes("FROM links")
          ? { status: "active", permissions: JSON.stringify(["OfferCreate"]), frozen_at: null }
          : { json: JSON.stringify({ networks: ["testnet"] }) } }) }) } as unknown as D1Database;
      const production = createProductionStrategyAdapter({ principal: "tenantrunner", db: observationDb,
        env: { EXEC_NETWORK: "testnet" }, xrplRpc: rpc });
      const result = await runStrategyScheduler({ db: d1(database), now: dueAt, holderId: "runner:production-slow",
        clock: () => clockTime, adapterForPrincipal: () => production });
      expect(result.held).toBe(1);
      const row = database.sqlite.prepare("SELECT hold_codes_json, snapshot_json FROM strategy_decisions").get() as {
        hold_codes_json: string; snapshot_json: string;
      };
      expect(JSON.parse(row.hold_codes_json)).toContain("stale_price");
      expect(JSON.parse(row.snapshot_json)).toMatchObject({ observedAt: dueAt.toISOString() });
    } finally { database.close(); }
  });

  it.each([
    ["buy_xrp", "10000000", "90"],
    ["sell_xrp", "90000000", "10"],
  ] as const)("executes one bounded %s correction and never duplicates it under concurrent workers", async (_side, xrp, issued) => {
    const database = new Database();
    try {
      await activeStrategy(database);
      const calls = { observe: 0, build: 0, execute: 0, reconcile: 0 };
      const executionAdapter = adapter({ observation: observation(dueAt, xrp, issued), calls });
      const results = await Promise.all([
        run(database, executionAdapter, dueAt, "runner:a"),
        run(database, executionAdapter, dueAt, "runner:b"),
      ]);
      expect(results.reduce((sum, result) => sum + result.executed, 0)).toBe(1);
      expect(calls.build).toBe(1);
      expect(calls.execute).toBe(1);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM strategy_executions").get()).toEqual({ count: 1 });
    } finally { database.close(); }
  });

  it("recovers a crashed prepared execution without submitting a replacement", async () => {
    const database = new Database();
    try {
      const strategy = await activeStrategy(database);
      const scheduler = new StrategySchedulerStore(d1(database));
      const store = new StrategyStore(d1(database), principal);
      const due = (await scheduler.listDue(dueAt))[0];
      const crashed = await scheduler.claim(due, "crashed", dueAt, 1_000);
      expect(crashed).not.toBeNull();
      const triggerId = await stableStrategyId("trigger", due.strategyId, String(due.scheduleGeneration), due.scheduledFor);
      const decisionId = await stableStrategyId("decision", triggerId, strategy.mandate.digest);
      expect(await scheduler.createTrigger(due, crashed!, triggerId, dueAt)).toBe("created");
      const decision: StrategyDecision = {
        decision_id: decisionId,
        trigger_id: triggerId,
        strategy_id: strategy.strategy_id,
        mandate_digest: strategy.mandate.digest,
        mandate_version: strategy.mandate.version,
        action: "buy_xrp",
        hold_codes: [],
        proposed_value: "10",
        explanation: "bounded buy",
        created_at: dueAt.toISOString(),
      };
      expect(await scheduler.persistDecision(principal, crashed!, strategy.mandate, decision, dueAt)).toBe(true);
      const executionId = await stableStrategyId("execution", decisionId);
      await store.beginExecution(decision, executionId, `strategy:${strategy.strategy_id}:${decisionId}`, dueAt);
      expect(await store.reserveDecision(strategy, decision, executionId, dueAt)).toBe(true);

      const calls = { observe: 0, build: 0, execute: 0, reconcile: 0 };
      const restartedAt = new Date(dueAt.getTime() + 2_000);
      const result = await run(database, adapter({ observation: observation(restartedAt, "10000000", "90"), calls }), restartedAt, "runner:restart");
      expect(result.failed).toBe(1);
      expect(calls.execute).toBe(0);
      expect(database.sqlite.prepare("SELECT submission_state, unresolved FROM strategy_executions WHERE id = ?").get(executionId))
        .toEqual({ submission_state: "failed", unresolved: 0 });
      expect(database.sqlite.prepare("SELECT state FROM strategy_budget_reservations WHERE execution_id = ?").get(executionId))
        .toEqual({ state: "released" });
    } finally { database.close(); }
  });

  it("reconciles unresolved work while paused without building or submitting new work", async () => {
    const database = new Database();
    try {
      const strategy = await activeStrategy(database);
      const calls = { observe: 0, build: 0, execute: 0, reconcile: 0 };
      const firstAdapter = adapter({
        observation: observation(dueAt, "10000000", "90"),
        outcome: { status: "pending_reconciliation", txHash: "CD".repeat(32) },
        calls,
      });
      expect((await run(database, firstAdapter)).blocked).toBe(1);
      expect((await new StrategyStore(d1(database), principal).getStrategy(strategy.strategy_id))?.lifecycle).toBe("paused");
      const reconciledAt = new Date(dueAt.getTime() + 60_000);
      const secondAdapter = adapter({
        observation: observation(reconciledAt, "10000000", "90"),
        reconcile: { status: "validated", evidence: { tx_hash: "CD".repeat(32), ledger_index: 110 } },
        calls,
      });
      await run(database, secondAdapter, reconciledAt, "runner:reconcile");
      expect(calls.reconcile).toBe(1);
      expect(calls.build).toBe(1);
      expect(calls.execute).toBe(1);
      expect(database.sqlite.prepare("SELECT submission_state, unresolved FROM strategy_executions").get())
        .toEqual({ submission_state: "validated", unresolved: 0 });
    } finally { database.close(); }
  });

  it("pauses on build or simulation failure instead of retrying every interval", async () => {
    const database = new Database();
    try {
      const strategy = await activeStrategy(database);
      const calls = { observe: 0, build: 0, execute: 0, reconcile: 0 };
      const result = await run(database, adapter({
        observation: observation(dueAt, "10000000", "90"),
        buildError: new Error("simulation rejected"),
        calls,
      }));
      expect(result.failed).toBe(1);
      expect(calls.execute).toBe(0);
      const current = await new StrategyStore(d1(database), principal).getStrategy(strategy.strategy_id);
      expect(current?.lifecycle).toBe("paused");
      expect(current?.hold_reason).toContain("simulation failed");
      await run(database, adapter({ observation: observation(new Date(dueAt.getTime() + 300_000), "10000000", "90"), calls }), new Date(dueAt.getTime() + 300_000));
      expect(calls.build).toBe(1);
    } finally { database.close(); }
  });

  it("preserves needs-approval identity and never owner-signs or submits a replacement", async () => {
    const database = new Database();
    try {
      const strategy = await activeStrategy(database);
      const calls = { observe: 0, build: 0, execute: 0, reconcile: 0 };
      const first = adapter({
        observation: observation(dueAt, "10000000", "90"),
        outcome: { status: "needs_approval", harborExecutionId: "approval:exact" },
        calls,
      });
      expect((await run(database, first)).blocked).toBe(1);
      expect((await new StrategyStore(d1(database), principal).getStrategy(strategy.strategy_id))?.lifecycle).toBe("paused");
      const event = database.sqlite.prepare("SELECT detail_json FROM strategy_audit_events WHERE kind = 'needs_approval'").get() as { detail_json: string };
      expect(JSON.parse(event.detail_json)).toMatchObject({ approval_id: "approval:exact", preserved: true });
      await run(database, adapter({ observation: observation(new Date(dueAt.getTime() + 60_000), "10000000", "90"), calls }), new Date(dueAt.getTime() + 60_000));
      expect(calls.reconcile).toBe(1);
      expect(calls.execute).toBe(1);
      expect(calls.build).toBe(1);
    } finally { database.close(); }
  });

  it("recovers approval identity when Harbor persisted it before the worker crashed", async () => {
    const database = new Database();
    try {
      await activeStrategy(database);
      const calls = { observe: 0, build: 0, execute: 0, reconcile: 0 };
      await run(database, adapter({ observation: observation(dueAt, "10000000", "90"),
        outcome: { status: "pending_reconciliation" }, calls }));
      const reconciledAt = new Date(dueAt.getTime() + 60_000);
      await run(database, adapter({ observation: observation(reconciledAt, "10000000", "90"),
        reconcile: { status: "needs_approval", approvalId: "approval:recovered" }, calls }),
      reconciledAt, "runner:approval-recovery");
      expect(database.sqlite.prepare(`SELECT submission_state, harbor_execution_id, unresolved
        FROM strategy_executions`).get()).toEqual({
        submission_state: "needs_approval", harbor_execution_id: "approval:recovered", unresolved: 1,
      });
      const event = database.sqlite.prepare(`SELECT detail_json FROM strategy_audit_events
        WHERE kind = 'needs_approval' ORDER BY created_at DESC LIMIT 1`).get() as { detail_json: string };
      expect(JSON.parse(event.detail_json)).toMatchObject({ approval_id: "approval:recovered", preserved: true });
      expect(calls.build).toBe(1);
      expect(calls.execute).toBe(1);
    } finally { database.close(); }
  });

  it("holds an expired mandate before build or submission", async () => {
    const database = new Database();
    try {
      const expiry = new Date(createdAt.getTime() + 301_000).toISOString();
      await activeStrategy(database, expiry);
      const expiredAt = new Date(createdAt.getTime() + 302_000);
      const calls = { observe: 0, build: 0, execute: 0, reconcile: 0 };
      const result = await run(database, adapter({ observation: observation(expiredAt, "10000000", "90"), calls }), expiredAt);
      expect(result.held).toBe(1);
      expect(calls.build).toBe(0);
      expect(calls.execute).toBe(0);
    } finally { database.close(); }
  });
});
