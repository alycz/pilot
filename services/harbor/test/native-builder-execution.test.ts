import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";

import type { OpContext } from "../src/catalog/registry";
import { DEFAULT_POLICY, type Policy } from "../src/contracts";
import { DEFAULT_DELEGATED_PERMISSIONS } from "../src/exec/delegation";
import type { BuildRow } from "../src/exec/store";
import {
  handleTxExecute,
  type ExecutionServices,
} from "../src/ops/tx-exec";

const PRINCIPAL = "native-builder-execution";
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DESTINATION = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const DELEGATE = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";
const NOW = "2026-10-21T12:00:00.000Z";
const CHECK_ID = "A".repeat(64);

const SCHEMA = `
CREATE TABLE links (id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL, network TEXT NOT NULL,
  delegate TEXT NOT NULL, delegate_seed_enc BLOB NOT NULL, iv BLOB NOT NULL, permissions TEXT NOT NULL,
  status TEXT NOT NULL, last_ledger INTEGER, revoke_tx TEXT, created_at TEXT NOT NULL,
  frozen_at TEXT, frozen_reason TEXT,
  UNIQUE (principal, owner, network));
CREATE TABLE policies (principal TEXT NOT NULL, owner TEXT NOT NULL, network TEXT NOT NULL, json TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (principal, owner, network));
CREATE TABLE builds (id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL, network TEXT NOT NULL,
  tx_json TEXT NOT NULL, summary TEXT NOT NULL, last_ledger_seq INTEGER NOT NULL, created_at TEXT NOT NULL,
  origin_profile TEXT, execution_contract TEXT, build_revision INTEGER);
CREATE TABLE build_consumptions (principal TEXT NOT NULL, build_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, status TEXT NOT NULL, claimed_at TEXT NOT NULL, consumed_at TEXT,
  PRIMARY KEY (principal, build_id));
CREATE TABLE executions (id TEXT PRIMARY KEY, principal TEXT NOT NULL, build_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, hash TEXT, usd_value REAL, signed_by TEXT,
  confirmed_by TEXT, confirmed_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE approvals (id TEXT PRIMARY KEY, principal TEXT NOT NULL, build_id TEXT NOT NULL, tx_json TEXT NOT NULL,
  expires_at TEXT NOT NULL, status TEXT NOT NULL, execution_id TEXT, execution_contract TEXT,
  build_revision INTEGER);
CREATE TABLE events (id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
  detail TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE direct_submission_bindings (principal TEXT NOT NULL, hash TEXT NOT NULL,
  owner TEXT NOT NULL, network TEXT NOT NULL, origin_profile TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (principal, hash));
CREATE TABLE build_revisions (principal TEXT NOT NULL, build_id TEXT NOT NULL,
  build_revision INTEGER NOT NULL, execution_contract TEXT NOT NULL, owner TEXT NOT NULL,
  network TEXT NOT NULL, tx_json TEXT NOT NULL, summary TEXT NOT NULL, unsigned_tx_digest TEXT NOT NULL,
  unsigned_tx_digest_alg TEXT NOT NULL, economic_fingerprint TEXT NOT NULL,
  economic_fingerprint_alg TEXT NOT NULL, build_ledger INTEGER NOT NULL,
  first_inclusion_ledger INTEGER NOT NULL, last_ledger_sequence INTEGER NOT NULL,
  minimum_remaining_ledgers INTEGER NOT NULL, approval_expires_in_seconds INTEGER NOT NULL,
  quote_ledger INTEGER, quote_valid_through_ledger INTEGER,
  acquisition_balance_invariant TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (principal, build_id, build_revision));
CREATE TABLE execution_snapshots (execution_id TEXT NOT NULL, principal TEXT NOT NULL,
  build_id TEXT NOT NULL, execution_contract TEXT NOT NULL, build_revision INTEGER NOT NULL,
  policy_snapshot TEXT NOT NULL, policy_revision TEXT NOT NULL, unsigned_tx_digest TEXT NOT NULL,
  unsigned_tx_digest_alg TEXT NOT NULL, economic_fingerprint TEXT NOT NULL,
  economic_fingerprint_alg TEXT NOT NULL, snapshot_owner TEXT NOT NULL,
  snapshot_network TEXT NOT NULL, snapshot_sequence INTEGER NOT NULL,
  first_inclusion_ledger INTEGER NOT NULL, last_ledger_sequence INTEGER NOT NULL,
  approval_id TEXT, approval_expires_at TEXT, acquisition_balance_invariant TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY (execution_id, principal, build_id),
  UNIQUE (principal, approval_id));
CREATE TABLE ap4m_mandates (id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL,
  network TEXT NOT NULL, status TEXT NOT NULL, execution_type TEXT NOT NULL,
  not_before TEXT NOT NULL, expires_at TEXT NOT NULL, constraints_json TEXT NOT NULL,
  agent_public_jwk TEXT NOT NULL, agent_key_enc BLOB NOT NULL, agent_key_iv BLOB NOT NULL,
  claim_keys_enc BLOB NOT NULL, claim_keys_iv BLOB NOT NULL, claim_public_keys_json TEXT NOT NULL,
  prepared_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ap4m_spend (id TEXT PRIMARY KEY, principal TEXT NOT NULL, mandate_id TEXT NOT NULL,
  spend_day TEXT NOT NULL, idempotency_key TEXT NOT NULL, amount_usd TEXT NOT NULL,
  amount_microusd INTEGER NOT NULL, status TEXT NOT NULL, receipt_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_exec_hash ON executions(hash);
`;

type SqlValue = string | number | bigint | null | Uint8Array;

function sqliteValue(value: unknown): SqlValue {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : (value as SqlValue);
}

class SqliteD1Statement {
  private values: SqlValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): this {
    this.values = values.map(sqliteValue);
    return this;
  }

  execute(): D1Result {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      meta: { changes: Number(result.changes) } as D1Result["meta"],
    };
  }

  async run(): Promise<D1Result> {
    return this.execute();
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.values) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    return (column === undefined ? row : row[column]) as T;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: {} as D1Result<T>["meta"],
    };
  }
}

class SqliteD1 {
  private readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    this.sqlite.exec(SCHEMA);
    this.sqlite.exec(readFileSync(
      new URL("../migrations/0011_autonomous_strategies.sql", import.meta.url),
      "utf8",
    ));
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite.prepare(sql));
  }

  async batch(statements: SqliteD1Statement[]): Promise<D1Result[]> {
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

  close(): void {
    this.sqlite.close();
  }
}

function asD1(db: SqliteD1): D1Database {
  return db as unknown as D1Database;
}

function transaction(transactionType: string): Record<string, unknown> {
  const common = {
    TransactionType: transactionType,
    Account: OWNER,
    Fee: "12",
    Sequence: 7,
    LastLedgerSequence: 200,
  };
  switch (transactionType) {
    case "EscrowCreate":
      return {
        ...common,
        Destination: DESTINATION,
        Amount: "1000000",
        CancelAfter: 900_000_000,
      };
    case "EscrowFinish":
    case "EscrowCancel":
      return { ...common, Owner: DESTINATION, OfferSequence: 4 };
    case "CheckCreate":
      return {
        ...common,
        Destination: DESTINATION,
        SendMax: "1000000",
        Expiration: 900_000_000,
      };
    case "CheckCash":
      return { ...common, CheckID: CHECK_ID, Amount: "1000000" };
    case "CheckCancel":
      return { ...common, CheckID: CHECK_ID };
    default:
      throw new Error(`unsupported fixture transaction ${transactionType}`);
  }
}

function buildRow(transactionType: string): BuildRow {
  return {
    id: `build-${transactionType}`,
    principal: PRINCIPAL,
    owner: OWNER,
    network: "testnet",
    txJson: transaction(transactionType),
    summary: {
      action: transactionType,
      account: OWNER,
      amounts: ["1000000 drops XRP"],
      fee_drops: "12",
      reserve_delta_drops: "0",
      usd_value: "10",
    },
    lastLedgerSeq: 200,
    createdAt: NOW,
  };
}

async function seedBuild(db: SqliteD1, row: BuildRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO builds
        (id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.principal,
      row.owner,
      row.network,
      JSON.stringify(row.txJson),
      JSON.stringify(row.summary),
      row.lastLedgerSeq,
      row.createdAt,
    )
    .run();
}

async function seedLink(
  db: SqliteD1,
  permissions: readonly string[],
  status: "pending" | "active" | "suspended" | "revoked" = "active",
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO links
        (id, principal, owner, network, delegate, delegate_seed_enc, iv, permissions,
         status, last_ledger, revoke_tx, created_at)
       VALUES ('native-link', ?, ?, 'testnet', ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .bind(
      PRINCIPAL,
      OWNER,
      DELEGATE,
      new Uint8Array([1]).buffer,
      new Uint8Array([2]).buffer,
      JSON.stringify(permissions),
      status,
      NOW,
    )
    .run();
}

async function seedPolicy(
  db: SqliteD1,
  transactionType?: string,
): Promise<void> {
  const policy: Policy = {
    ...DEFAULT_POLICY,
    allowed_tx_types: [
      ...new Set([
        ...DEFAULT_POLICY.allowed_tx_types,
        ...(transactionType === undefined ? [] : [transactionType]),
      ]),
    ],
    issuer_allowlist: [...DEFAULT_POLICY.issuer_allowlist],
    networks: [...DEFAULT_POLICY.networks],
  };
  await db
    .prepare(
      `INSERT INTO policies (principal, owner, network, json, updated_at)
       VALUES (?, ?, 'testnet', ?, ?)`,
    )
    .bind(PRINCIPAL, OWNER, JSON.stringify(policy), NOW)
    .run();
}

function xrplRpc(simulationResult = "tesSUCCESS") {
  return {
    request: vi.fn(async (_network: string, command: string) => {
      if (command === "ledger_current") return { ledger_current_index: 100 };
      if (command === "account_info") {
        return {
          account_data: {
            Account: OWNER,
            Balance: "100000000",
            OwnerCount: 0,
            Sequence: 7,
            Flags: 0,
          },
          ledger_index: 100,
        };
      }
      if (command === "server_info") {
        return {
          info: {
            validated_ledger: {
              reserve_base_xrp: 1,
              reserve_inc_xrp: 0.2,
            },
          },
        };
      }
      if (command === "simulate") {
        return {
          engine_result: simulationResult,
          engine_result_message:
            simulationResult === "tesSUCCESS"
              ? "The simulated transaction would succeed."
              : "The simulated transaction would fail.",
          applied: false,
        };
      }
      throw new Error(`Unexpected XRPL command: ${command}`);
    }),
  };
}

function executionContext(
  db: SqliteD1,
  services: ExecutionServices,
  simulationResult = "tesSUCCESS",
): OpContext {
  return {
    principal: PRINCIPAL,
    db: asD1(db),
    xrplRpc: xrplRpc(simulationResult),
    executionServices: services,
  };
}

function ids(...values: string[]): () => string {
  const queue = [...values];
  return () => queue.shift() ?? "unused-id";
}

describe("native escrow and check builders through tx.execute", () => {
  it.each(["EscrowFinish", "CheckCash"])(
    "executes delegable %s under the auto-execute threshold with only a fake signer",
    async (transactionType) => {
      const db = new SqliteD1();
      try {
        const build = buildRow(transactionType);
        await seedBuild(db, build);
        await seedLink(db, [transactionType]);
        await seedPolicy(db, transactionType);

        const fakeWallet = Wallet.generate();
        const fakeSigned = fakeWallet.sign({
          TransactionType: "AccountSet",
          Account: fakeWallet.address,
          Fee: "12",
          Sequence: 1,
          LastLedgerSequence: 200,
        });
        const signDelegate = vi.fn(async () => ({
          tx_blob: fakeSigned.tx_blob,
          hash: fakeSigned.hash,
        }));
        const submitSigned = vi.fn(async () => ({
          hash: fakeSigned.hash,
          ledger_index: 198,
          engine_result: "tesSUCCESS",
          validated: true as const,
        }));
        const result = await handleTxExecute(
          executionContext(db, {
            facts: {
              getPolicyFacts: vi.fn(async () => ({
                usdValue: "10",
                issuerFacts: [],
              })),
            },
            signDelegate,
            submitSigned,
            now: () => new Date(NOW),
            randomUUID: ids(`execute-${transactionType}`),
          }),
          {
            build_id: build.id,
            idempotency_key: `intent-${transactionType}`,
          },
        );

        expect(result).toEqual({
          status: "executed",
          hash: fakeSigned.hash,
          ledger_index: 198,
          result: "success",
          signed_by: "delegate",
          confirmation: {
            provider: "poll",
            at: NOW,
            latency_ms: 0,
          },
        });
        expect(signDelegate).toHaveBeenCalledOnce();
        expect(submitSigned).toHaveBeenCalledOnce();
      } finally {
        db.close();
      }
    },
  );

  it.each([
    ["pending", "blocked", "block"],
    ["suspended", "blocked", "block"],
    ["revoked", "needs_approval", "needs_approval"],
  ] as const)(
    "does not delegate a rehydrated CheckCash through a %s link",
    async (linkStatus, expectedStatus, expectedVerdict) => {
      const db = new SqliteD1();
      try {
        const build = buildRow("CheckCash");
        await seedBuild(db, build);
        await seedLink(db, ["CheckCash"], linkStatus);
        await seedPolicy(db, "CheckCash");
        const getPolicyFacts = vi.fn(async (rehydratedBuild) => {
          expect(rehydratedBuild.delegable).toBe(false);
          return { usdValue: "10", issuerFacts: [] };
        });
        const signDelegate = vi.fn();
        const submitSigned = vi.fn();
        const result = await handleTxExecute(
          executionContext(db, {
            facts: { getPolicyFacts },
            signDelegate,
            submitSigned,
            now: () => new Date(NOW),
            randomUUID: ids(
              `inactive-execution-${linkStatus}`,
              `inactive-approval-${linkStatus}`,
            ),
          }),
          {
            build_id: build.id,
            idempotency_key: `inactive-intent-${linkStatus}`,
          },
        );

        expect(result).toMatchObject({
          status: expectedStatus,
          policy: { verdict: expectedVerdict },
        });
        expect(getPolicyFacts).toHaveBeenCalledOnce();
        expect(signDelegate).not.toHaveBeenCalled();
        expect(submitSigned).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    },
  );

  it.each(["EscrowCancel", "CheckCancel"])(
    "executes %s only when custom policy and link permissions both allow it",
    async (transactionType) => {
      const db = new SqliteD1();
      try {
        const build = buildRow(transactionType);
        await seedBuild(db, build);
        await seedLink(db, [transactionType]);
        await seedPolicy(db, transactionType);

        const fakeWallet = Wallet.generate();
        const fakeSigned = fakeWallet.sign({
          TransactionType: "AccountSet",
          Account: fakeWallet.address,
          Fee: "12",
          Sequence: 1,
          LastLedgerSequence: 200,
        });
        const signDelegate = vi.fn(async () => ({
          tx_blob: fakeSigned.tx_blob,
          hash: fakeSigned.hash,
        }));
        const submitSigned = vi.fn(async () => ({
          hash: fakeSigned.hash,
          ledger_index: 198,
          engine_result: "tesSUCCESS",
          validated: true as const,
        }));
        const result = await handleTxExecute(
          executionContext(db, {
            facts: {
              getPolicyFacts: vi.fn(async () => ({
                usdValue: "10",
                issuerFacts: [],
              })),
            },
            signDelegate,
            submitSigned,
            now: () => new Date(NOW),
            randomUUID: ids(`custom-cancel-${transactionType}`),
          }),
          {
            build_id: build.id,
            idempotency_key: `custom-cancel-intent-${transactionType}`,
          },
        );

        expect(result).toEqual({
          status: "executed",
          hash: fakeSigned.hash,
          ledger_index: 198,
          result: "success",
          signed_by: "delegate",
          confirmation: {
            provider: "poll",
            at: NOW,
            latency_ms: 0,
          },
        });
        expect(signDelegate).toHaveBeenCalledOnce();
        expect(submitSigned).toHaveBeenCalledOnce();
      } finally {
        db.close();
      }
    },
  );

  it.each(["EscrowCreate", "CheckCreate"])(
    "keeps %s non-delegable even when stale link data maliciously grants it",
    async (transactionType) => {
      const db = new SqliteD1();
      try {
        const build = buildRow(transactionType);
        await seedBuild(db, build);
        await seedLink(db, [transactionType]);
        await seedPolicy(db, transactionType);
        const getPolicyFacts = vi.fn(async (rehydratedBuild) => {
          expect(rehydratedBuild.delegable).toBe(false);
          return { usdValue: "10", issuerFacts: [] };
        });
        const signDelegate = vi.fn();
        const submitSigned = vi.fn();
        const result = await handleTxExecute(
          executionContext(db, {
            facts: { getPolicyFacts },
            signDelegate,
            submitSigned,
            now: () => new Date(NOW),
            randomUUID: ids(
              `stale-create-execution-${transactionType}`,
              `stale-create-approval-${transactionType}`,
            ),
          }),
          {
            build_id: build.id,
            idempotency_key: `stale-create-intent-${transactionType}`,
          },
        );

        expect(result).toMatchObject({
          status: "needs_approval",
          policy: { verdict: "needs_approval" },
        });
        if (result.status === "needs_approval") {
          expect(result.policy.reasons).toContainEqual({
            rule: "transaction_type",
            pass: false,
            detail: `${transactionType} is never delegated and requires owner approval`,
          });
        }
        expect(getPolicyFacts).toHaveBeenCalledOnce();
        expect(signDelegate).not.toHaveBeenCalled();
        expect(submitSigned).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    },
  );

  it.each([
    "EscrowCreate",
    "EscrowCancel",
    "CheckCreate",
    "CheckCancel",
  ])(
    "routes %s to owner approval without calling the delegate signer",
    async (transactionType) => {
      const db = new SqliteD1();
      try {
        const build = buildRow(transactionType);
        await seedBuild(db, build);
        await seedLink(db, DEFAULT_DELEGATED_PERMISSIONS);
        await seedPolicy(
          db,
          transactionType.endsWith("Create") ? transactionType : undefined,
        );
        const signDelegate = vi.fn();
        const submitSigned = vi.fn();
        const result = await handleTxExecute(
          executionContext(db, {
            facts: {
              getPolicyFacts: vi.fn(async () => ({
                usdValue: "10",
                issuerFacts: [],
              })),
            },
            signDelegate,
            submitSigned,
            now: () => new Date(NOW),
            randomUUID: ids(
              `approval-execution-${transactionType}`,
              `approval-token-${transactionType}`,
            ),
          }),
          {
            build_id: build.id,
            idempotency_key: `intent-${transactionType}`,
          },
        );

        expect(result).toMatchObject({
          status: "needs_approval",
          approval_id: `approval-execution-${transactionType}.approval-token-${transactionType}`,
          tx_json: build.txJson,
          policy: { verdict: "needs_approval" },
        });
        if (result.status === "needs_approval") {
          expect(result.policy.reasons).toContainEqual(
            expect.objectContaining({
              rule: "transaction_type",
              pass: false,
            }),
          );
        }
        expect(signDelegate).not.toHaveBeenCalled();
        expect(submitSigned).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    },
  );

  it("blocks a CheckCash whose execution-time simulation fails", async () => {
    const db = new SqliteD1();
    try {
      const build = buildRow("CheckCash");
      await seedBuild(db, build);
      await seedLink(db, ["CheckCash"]);
      await seedPolicy(db, "CheckCash");
      const signDelegate = vi.fn();
      const submitSigned = vi.fn();
      const result = await handleTxExecute(
        executionContext(
          db,
          {
            facts: {
              getPolicyFacts: vi.fn(async () => ({
                usdValue: "10",
                issuerFacts: [],
              })),
            },
            signDelegate,
            submitSigned,
            now: () => new Date(NOW),
            randomUUID: ids("blocked-CheckCash"),
          },
          "tecPATH_DRY",
        ),
        { build_id: build.id, idempotency_key: "intent-blocked-CheckCash" },
      );

      expect(result).toMatchObject({
        status: "blocked",
        policy: { verdict: "block" },
      });
      if (result.status === "blocked") {
        expect(result.policy.reasons).toContainEqual({
          rule: "simulation",
          pass: false,
          detail: "Simulation returned tecPATH_DRY",
        });
      }
      expect(signDelegate).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
