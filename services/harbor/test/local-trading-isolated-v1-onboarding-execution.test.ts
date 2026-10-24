import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";
import type { TrustSet } from "xrpl";

import { XrplRpcError } from "../src/adapters/xrpl-rpc";

vi.mock("xrpl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xrpl")>();
  return {
    ...actual,
    deriveAddress: () => "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    verifySignature: () => true,
  };
});

vi.mock("../src/exec/submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/exec/submit")>();
  const owner = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
  const delegate = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
  const defaults = [
    "OfferCreate",
    "OfferCancel",
    "TrustSet",
    "AMMDeposit",
    "AMMWithdraw",
    "EscrowFinish",
    "CheckCash",
  ];
  return {
    ...actual,
    signedTransactionHash: (blob: string) =>
      blob === "AA" ? "A".repeat(64) : blob === "BB" ? "B".repeat(64) : "C".repeat(64),
    decodeSignedBlob: (blob: string) => {
      if (blob === "AA") return {
        TransactionType: "TrustSet",
        Account: owner,
      };
      return {
        TransactionType: "DelegateSet",
        Account: owner,
        Authorize: delegate,
        SigningPubKey: "ED" + "1".repeat(64),
        Sequence: 7,
        LastLedgerSequence: 120,
        Permissions: blob === "BB"
          ? defaults.map((PermissionValue) => ({ Permission: { PermissionValue } }))
          : [],
      };
    },
  };
});

import type { OpContext } from "../src/catalog/registry";
import { DEFAULT_POLICY } from "../src/contracts";
import { AccountSequenceLeaseAuthority } from "../src/exec/account-sequence-lease";
import { DEFAULT_DELEGATED_PERMISSIONS } from "../src/exec/delegation";
import type { LinkRow } from "../src/exec/store";
import {
  LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE,
} from "../src/local-trading-isolated-v1";
import {
  LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
  LOCAL_TRADING_ISOLATED_ONBOARDING_V1_SIGNING_PROFILE,
} from "../src/local-trading-isolated-onboarding-v1";
import {
  LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
  LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
} from "../src/local-trading-onboarding";
import { handleAccountLink } from "../src/ops/account";
import { handleOnboardingReadiness } from "../src/ops/onboarding";
import {
  handleTxApprovalPreflight,
  handleTxExecute,
  handleTxStatus,
  handleTxSubmit,
  type ExecutionServices,
} from "../src/ops/tx-exec";

const PRINCIPAL = "isolated-onboarding-execution-tests";
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DELEGATE = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const NOW = "2026-10-20T10:00:00.000Z";
const HASH_A = "A".repeat(64);
const HASH_B = "B".repeat(64);

const REVIEWED_BASE = {
  EXEC_NETWORK: "testnet",
  EXECUTOR: "quickjs",
  MAINNET_EXECUTION: "false",
  HARBOR_LOCAL_DEV: "true",
  HARBOR_LOCAL_READ_ONLY: "false",
  HARBOR_LOCAL_AUTH_REQUIRED: "true",
  HARBOR_LOCAL_CRON_DISABLED: "true",
  HARBOR_LOCAL_X402: "false",
  HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
  HARBOR_SOURCE_TAG: "2610240",
} as const;

const ISOLATED_ONBOARDING_ENV = {
  ...REVIEWED_BASE,
  HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE:
    LOCAL_TRADING_ISOLATED_ONBOARDING_V1_SIGNING_PROFILE,
} as const;

const LEGACY_ONBOARDING_ENV = {
  ...REVIEWED_BASE,
  HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE:
    LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
} as const;

const ISOLATED_TRADING_ENV = {
  ...REVIEWED_BASE,
  HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE:
    LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE,
} as const;

const SCHEMA = `
CREATE TABLE links (id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL, network TEXT NOT NULL,
  delegate TEXT NOT NULL, delegate_seed_enc BLOB NOT NULL, iv BLOB NOT NULL, permissions TEXT NOT NULL,
  status TEXT NOT NULL, last_ledger INTEGER, revoke_tx TEXT, created_at TEXT NOT NULL,
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
  created_at TEXT NOT NULL);
CREATE TABLE approvals (id TEXT PRIMARY KEY, principal TEXT NOT NULL, build_id TEXT NOT NULL, tx_json TEXT NOT NULL,
  expires_at TEXT NOT NULL, status TEXT NOT NULL, execution_id TEXT, execution_contract TEXT,
  build_revision INTEGER);
CREATE TABLE events (id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
  detail TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE direct_submission_bindings (principal TEXT NOT NULL, hash TEXT NOT NULL,
  owner TEXT NOT NULL, network TEXT NOT NULL, origin_profile TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (principal, hash));
CREATE INDEX idx_exec_hash ON executions(hash);
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
  created_at TEXT NOT NULL, PRIMARY KEY (execution_id, principal, build_id));
CREATE TABLE relay_claims (principal TEXT NOT NULL, execution_id TEXT NOT NULL,
  hash TEXT NOT NULL, attempted_at TEXT NOT NULL, PRIMARY KEY (principal, execution_id, hash));
CREATE TABLE approval_preflight_rejections (principal TEXT NOT NULL, approval_id TEXT NOT NULL,
  execution_id TEXT NOT NULL, error_code TEXT NOT NULL, rejected_at TEXT NOT NULL,
  PRIMARY KEY (principal, approval_id));
CREATE TABLE approval_recoveries (principal TEXT NOT NULL, approval_id TEXT NOT NULL,
  execution_id TEXT NOT NULL, build_id TEXT NOT NULL, build_revision INTEGER NOT NULL,
  unsigned_tx_digest TEXT NOT NULL, economic_fingerprint TEXT NOT NULL,
  validated_ledger INTEGER NOT NULL, first_inclusion_ledger INTEGER NOT NULL,
  last_ledger_sequence INTEGER NOT NULL, recovered_at TEXT NOT NULL,
  PRIMARY KEY (principal, approval_id));
`;

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
  private values: SqlValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): this {
    this.values = values.map((value) =>
      value instanceof ArrayBuffer ? new Uint8Array(value) : value as SqlValue,
    );
    return this;
  }

  execute(): D1Result {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } as D1Result["meta"] };
  }

  async run(): Promise<D1Result> {
    return this.execute();
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
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
      "migrations-profile-trading-isolated-v1/0012_isolated_sequence_authority.sql",
      "utf8",
    ));
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite.prepare(sql));
  }

  exec(sql: string): void {
    this.sqlite.exec(sql);
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

function trustSet(owner = OWNER): TrustSet {
  return {
    TransactionType: "TrustSet",
    Account: owner,
    LimitAmount: {
      currency: "USD",
      issuer: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",
      value: "100",
    },
    Fee: "12",
    Sequence: 7,
    LastLedgerSequence: 200,
  };
}

async function seedBuild(
  db: SqliteD1,
  id: string,
  owner = OWNER,
  origin = LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
  tx: Record<string, unknown> = trustSet(owner),
): Promise<void> {
  await db.prepare(
    `INSERT INTO builds
      (id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at, origin_profile)
     VALUES (?, ?, ?, 'testnet', ?, ?, 200, ?, ?)`,
  ).bind(
    id,
    PRINCIPAL,
    owner,
    JSON.stringify(tx),
    JSON.stringify({
      action: "Set trust line",
      account: owner,
      amounts: [],
      fee_drops: "12",
      reserve_delta_drops: "0",
      usd_value: "10",
    }),
    NOW,
    origin,
  ).run();
}

async function seedLink(
  db: SqliteD1,
  owner = OWNER,
  status: "pending" | "active" | "suspended" = "active",
): Promise<void> {
  await db.prepare(
    `INSERT INTO links
      (id, principal, owner, network, delegate, delegate_seed_enc, iv, permissions,
       status, last_ledger, revoke_tx, created_at)
     VALUES (?, ?, ?, 'testnet', ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).bind(
    `link-${owner}`,
    PRINCIPAL,
    owner,
    DELEGATE,
    new Uint8Array([1]).buffer,
    new Uint8Array(12).buffer,
    JSON.stringify(DEFAULT_DELEGATED_PERMISSIONS),
    status,
    NOW,
  ).run();
}

async function seedPolicy(db: SqliteD1, owner = OWNER): Promise<void> {
  await db.prepare(
    `INSERT INTO policies (principal, owner, network, json, updated_at)
     VALUES (?, ?, 'testnet', ?, ?)`,
  ).bind(PRINCIPAL, owner, JSON.stringify(DEFAULT_POLICY), NOW).run();
}

async function seedConsumption(
  db: SqliteD1,
  buildId: string,
  idempotencyKey: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO build_consumptions
      (principal, build_id, idempotency_key, status, claimed_at, consumed_at)
     VALUES (?, ?, ?, 'consumed', ?, ?)`,
  ).bind(PRINCIPAL, buildId, idempotencyKey, NOW, NOW).run();
}

function context(
  db: SqliteD1,
  env: Record<string, string>,
  executionServices: ExecutionServices = {},
): OpContext {
  return {
    principal: PRINCIPAL,
    localDevRequest: true,
    env,
    db: asD1(db),
    xrplRpc: {
      request: vi.fn(async (_network: string, command: string) => {
        if (command === "ledger") {
          return { validated: true, ledger_index: 100 };
        }
        if (command === "account_info") {
          return {
            validated: true,
            ledger_index: 100,
            account_data: { Account: OWNER, Flags: 0 },
          };
        }
        throw new Error(`unexpected XRPL command ${command}`);
      }),
    },
    executionServices,
  };
}

describe("isolated onboarding execution and wallet lifecycle bindings", () => {
  it("migrates existing bindings, admits only the new onboarding origin, and still rejects isolated trading", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(readFileSync("migrations/0001_init.sql", "utf8"));
      sqlite.exec(readFileSync("migrations/0002_build_capability_isolation.sql", "utf8"));
      sqlite.prepare(
        `INSERT INTO direct_submission_bindings
          (principal, hash, owner, network, origin_profile, created_at)
         VALUES (?, ?, ?, 'testnet', 'local-trading-onboarding', ?)`,
      ).run(PRINCIPAL, HASH_A, OWNER, NOW);

      for (const migration of [
        "migrations/0003_execution_lifetime_v2.sql",
        "migrations/0004_v2_preflight_rejections.sql",
        "migrations/0005_v2_approval_recovery.sql",
      ]) {
        sqlite.exec(readFileSync(migration, "utf8"));
      }

      sqlite.exec(
        readFileSync(
          "migrations/0006_local_trading_isolated_onboarding_v1.sql",
          "utf8",
        ),
      );

      expect(sqlite.prepare(
        "SELECT origin_profile FROM direct_submission_bindings WHERE hash = ?",
      ).get(HASH_A)).toEqual({ origin_profile: "local-trading-onboarding" });
      expect(() => sqlite.prepare(
        `INSERT INTO direct_submission_bindings
          (principal, hash, owner, network, origin_profile, created_at)
         VALUES (?, ?, ?, 'testnet', ?, ?)`,
      ).run(
        PRINCIPAL,
        HASH_B,
        OWNER,
        LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
        NOW,
      )).not.toThrow();
      expect(() => sqlite.prepare(
        `INSERT INTO direct_submission_bindings
          (principal, hash, owner, network, origin_profile, created_at)
         VALUES (?, ?, ?, 'testnet', 'local-trading-isolated-v1', ?)`,
      ).run(PRINCIPAL, "C".repeat(64), OWNER, NOW)).toThrow(/constraint/i);

      expect(() => sqlite.prepare(
        `UPDATE direct_submission_bindings
            SET origin_profile = 'local-trading-isolated-onboarding-v1'
          WHERE principal = ? AND hash = ?`,
      ).run(PRINCIPAL, HASH_A)).toThrow(/bindings are immutable/i);
      expect(() => sqlite.prepare(
        "DELETE FROM direct_submission_bindings WHERE principal = ? AND hash = ?",
      ).run(PRINCIPAL, HASH_A)).toThrow(/bindings are immutable/i);
      expect(sqlite.prepare(
        "SELECT origin_profile FROM direct_submission_bindings WHERE hash = ?",
      ).get(HASH_A)).toEqual({ origin_profile: "local-trading-onboarding" });

      const insertBuild = sqlite.prepare(
        `INSERT INTO builds
          (id, principal, owner, network, tx_json, summary, last_ledger_seq,
           created_at, origin_profile, build_revision, execution_contract)
         VALUES (?, ?, ?, 'testnet', '{}', '{}', 200, ?, ?, NULL, NULL)`,
      );
      insertBuild.run(
        "origin-bearing-build",
        PRINCIPAL,
        OWNER,
        NOW,
        LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
      );
      insertBuild.run("originless-build", PRINCIPAL, OWNER, NOW, null);

      expect(() => sqlite.prepare(
        "UPDATE builds SET origin_profile = 'local-trading-onboarding' WHERE id = ?",
      ).run("origin-bearing-build")).toThrow(/origin profile is immutable/i);
      expect(() => sqlite.prepare(
        "UPDATE builds SET origin_profile = 'local-trading' WHERE id = ?",
      ).run("originless-build")).toThrow(/origin profile is immutable/i);
      expect(() => sqlite.prepare(
        "DELETE FROM builds WHERE id = ?",
      ).run("origin-bearing-build")).toThrow(/origin-bearing builds are immutable/i);

      expect(() => sqlite.prepare(
        "UPDATE builds SET summary = ? WHERE id = ?",
      ).run('{"updated":true}', "origin-bearing-build")).not.toThrow();
      expect(() => sqlite.prepare(
        "DELETE FROM builds WHERE id = ?",
      ).run("originless-build")).not.toThrow();
      expect(sqlite.prepare(
        "SELECT summary, origin_profile FROM builds WHERE id = ?",
      ).get("origin-bearing-build")).toEqual({
        summary: '{"updated":true}',
        origin_profile: LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
      });
    } finally {
      sqlite.close();
    }
  });

  it("recognizes the exact account/readiness profile while retaining onboarding defaults and no-faucet behavior", async () => {
    let row: LinkRow | null = null;
    const fundDelegateAccount = vi.fn();
    const createWrappedDelegateKey = vi.fn(async () => ({
      address: DELEGATE,
      ciphertext: new Uint8Array([1]).buffer,
      iv: new Uint8Array(12).buffer,
    }));
    const accountContext = {
      principal: PRINCIPAL,
      localDevRequest: true,
      env: { ...ISOLATED_ONBOARDING_ENV, HARBOR_KEK: "test-kek" },
      accountServices: {
        store: {
          getLink: vi.fn(async () => row),
          insertLink: vi.fn(async (input) => {
            row = { ...input, principal: PRINCIPAL };
            return row;
          }),
          updateLink: vi.fn(async () => row),
        },
        ledger: {
          prepareTransaction: vi.fn(async (_network, transaction) => ({
            ...transaction,
            Fee: "12",
            Sequence: 7,
            LastLedgerSequence: 200,
          })),
          readDelegate: vi.fn(async () => null),
          isAccountFunded: vi.fn(async () => false),
        },
        createWrappedDelegateKey,
        fundDelegateAccount,
        randomUUID: () => "link-1",
        now: () => new Date(NOW),
      },
    } as unknown as OpContext;

    const link = await handleAccountLink(accountContext, {
      owner: OWNER,
      network: "testnet",
    });
    expect(link.permissions).toEqual(DEFAULT_DELEGATED_PERMISSIONS);
    expect(fundDelegateAccount).not.toHaveBeenCalled();
    await expect(handleAccountLink(accountContext, {
      owner: OWNER,
      network: "testnet",
      permissions: ["TrustSet"],
    })).rejects.toThrow(/exact reviewed delegated permissions/i);

    const readiness = await handleOnboardingReadiness({
      principal: PRINCIPAL,
      localDevRequest: true,
      env: ISOLATED_ONBOARDING_ENV,
      onboardingReadinessServices: {
        store: {
          getLink: vi.fn(async () => null),
          getPolicy: vi.fn(),
          findExecutionByHash: vi.fn(),
          getBuild: vi.fn(),
        },
      },
    } as unknown as OpContext, {
      owner: OWNER,
      network: "testnet",
      expected_policy: DEFAULT_POLICY,
      trust_set_hash: HASH_A,
    });
    expect(readiness.checks.reviewed_runtime).toBe(true);
  });

  it("replays only the durable one-shot TrustSet intent and rejects every cross-profile consumer", async () => {
    const db = new SqliteD1();
    try {
      const buildId = "isolated-onboarding-trust-set";
      const executionId = "isolated-onboarding-execution";
      const durableKey = `${PRINCIPAL}:wallet-intent`;
      await seedBuild(db, buildId);
      await seedLink(db);
      await seedPolicy(db);
      await seedConsumption(db, buildId, durableKey);
      await db.prepare(
        `INSERT INTO executions
          (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
         VALUES (?, ?, ?, ?, 'needs_approval', NULL, 10, NULL, ?)`,
      ).bind(executionId, PRINCIPAL, buildId, durableKey, NOW).run();
      await db.prepare(
        `INSERT INTO events (id, principal, owner, kind, detail, created_at)
         VALUES (?, ?, ?, 'execution_claim', ?, ?)`,
      ).bind(
        `execution-claim:${executionId}`,
        PRINCIPAL,
        OWNER,
        JSON.stringify({
          build_id: buildId,
          execution_mode: "require_owner_approval",
        }),
        NOW,
      ).run();
      const replay = {
        status: "needs_approval",
        approval_id: `${executionId}.approval`,
        tx_json: trustSet(),
        expires_at: "2026-10-20T10:10:00.000Z",
        policy: { verdict: "needs_approval", reasons: [] },
      } as const;
      await db.prepare(
        `INSERT INTO events (id, principal, owner, kind, detail, created_at)
         VALUES (?, ?, ?, 'execution_result', ?, ?)`,
      ).bind(
        `execution-result:${executionId}`,
        PRINCIPAL,
        OWNER,
        JSON.stringify({ result: replay }),
        NOW,
      ).run();

      const isolated = context(db, ISOLATED_ONBOARDING_ENV);
      await expect(handleTxExecute(isolated, {
        build_id: buildId,
        idempotency_key: "wallet-intent",
        require_owner_approval: true,
      })).resolves.toEqual(replay);
      await expect(handleTxExecute(isolated, {
        build_id: buildId,
        idempotency_key: "different-intent",
        require_owner_approval: true,
      })).rejects.toThrow(/different idempotency key/i);

      for (const env of [LEGACY_ONBOARDING_ENV, ISOLATED_TRADING_ENV]) {
        await expect(handleTxExecute(context(db, env), {
          build_id: buildId,
          idempotency_key: "wallet-intent",
          require_owner_approval: true,
        })).rejects.toThrow(/isolated onboarding profile/i);
      }
      expect(await db.prepare(
        "SELECT COUNT(*) AS count FROM executions WHERE build_id = ?",
      ).bind(buildId).first()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("binds approvals, preflight snapshots, submission replays, and status to the exact origin and Testnet", async () => {
    const db = new SqliteD1();
    try {
      const transaction = trustSet();
      const txBlob = "AA";
      const signedHash = HASH_A;
      const buildId = "approval-build";
      const executionId = "approval-execution";
      const approvalId = `${executionId}.approval`;
      const durableKey = `${PRINCIPAL}:approval-intent`;
      await seedBuild(
        db,
        buildId,
        OWNER,
        LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
        transaction,
      );
      await seedLink(db);
      await seedPolicy(db);
      await seedConsumption(db, buildId, durableKey);
      await db.prepare(
        `INSERT INTO executions
          (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
         VALUES (?, ?, ?, ?, 'executed', ?, 10, 'owner', ?)`,
      ).bind(
        executionId,
        PRINCIPAL,
        buildId,
        durableKey,
        signedHash,
        NOW,
      ).run();
      await db.prepare(
        `INSERT INTO approvals
          (id, principal, build_id, tx_json, expires_at, status)
         VALUES (?, ?, ?, ?, '2026-10-20T10:10:00.000Z', 'approved')`,
      ).bind(approvalId, PRINCIPAL, buildId, JSON.stringify(transaction)).run();
      const terminal = {
        status: "executed",
        hash: signedHash,
        ledger_index: 101,
        result: "success",
        signed_by: "owner",
      } as const;
      await db.prepare(
        `INSERT INTO events (id, principal, owner, kind, detail, created_at)
         VALUES (?, ?, ?, 'execution_result', ?, ?)`,
      ).bind(
        `execution-result:${executionId}`,
        PRINCIPAL,
        OWNER,
        JSON.stringify({ result: terminal }),
        NOW,
      ).run();

      const status = vi.fn(async () => ({
        hash: signedHash,
        network: "testnet" as const,
        validated: true,
        ledger_index: 101,
        engine_result: "tesSUCCESS",
      }));
      const isolated = context(db, ISOLATED_ONBOARDING_ENV, { status });
      await expect(handleTxSubmit(isolated, {
        approval_id: approvalId,
        tx_blob: txBlob,
      })).resolves.toMatchObject({
        hash: signedHash,
        validated: true,
      });
      await expect(handleTxStatus(isolated, {
        hash: signedHash,
      })).resolves.toMatchObject({ validated: true, network: "testnet" });
      expect(status).toHaveBeenCalledOnce();

      for (const env of [LEGACY_ONBOARDING_ENV, ISOLATED_TRADING_ENV]) {
        const services = { submitApproval: vi.fn(), submitSigned: vi.fn(), status: vi.fn() };
        await expect(handleTxSubmit(context(db, env, services), {
          approval_id: approvalId,
          tx_blob: txBlob,
        })).rejects.toThrow(/isolated onboarding profile/i);
        await expect(handleTxStatus(context(db, env, services), {
          hash: signedHash,
        })).rejects.toThrow(/isolated onboarding profile/i);
        expect(services.submitApproval).not.toHaveBeenCalled();
        expect(services.submitSigned).not.toHaveBeenCalled();
        expect(services.status).not.toHaveBeenCalled();
      }

      const v2Execution = "bad-snapshot-execution";
      const v2Approval = "bad-snapshot-approval";
      await db.prepare(
        `INSERT INTO executions
          (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
         VALUES (?, ?, ?, ?, 'needs_approval', NULL, 10, NULL, ?)`,
      ).bind(v2Execution, PRINCIPAL, buildId, `${PRINCIPAL}:bad-snapshot`, NOW).run();
      await db.prepare(
        `INSERT INTO approvals
          (id, principal, build_id, tx_json, expires_at, status,
           execution_id, execution_contract, build_revision)
         VALUES (?, ?, ?, ?, '2026-10-20T10:10:00.000Z', 'pending', ?, 'xrpl_execution_v2', 1)`,
      ).bind(v2Approval, PRINCIPAL, buildId, JSON.stringify(transaction), v2Execution).run();
      await db.prepare(
        `INSERT INTO build_revisions
          (principal, build_id, build_revision, execution_contract, owner, network,
           tx_json, summary, unsigned_tx_digest, unsigned_tx_digest_alg,
           economic_fingerprint, economic_fingerprint_alg, build_ledger,
           first_inclusion_ledger, last_ledger_sequence, minimum_remaining_ledgers,
           approval_expires_in_seconds, quote_ledger, quote_valid_through_ledger,
           acquisition_balance_invariant, created_at)
         SELECT principal, id, 1, 'xrpl_execution_v2', owner, 'devnet', ?,
                summary, ?, 'sha256-jcs-v1', ?, 'sha256-jcs-economic-v1',
                100, 101, 164, 8, 90, NULL, NULL, NULL, ?
           FROM builds WHERE principal = ? AND id = ?`,
      ).bind(
        JSON.stringify({ ...transaction, LastLedgerSequence: 164 }),
        HASH_A,
        HASH_B,
        NOW,
        PRINCIPAL,
        buildId,
      ).run();
      await db.prepare(
        `INSERT INTO execution_snapshots
          (execution_id, principal, build_id, execution_contract, build_revision,
           policy_snapshot, policy_revision, unsigned_tx_digest, unsigned_tx_digest_alg,
           economic_fingerprint, economic_fingerprint_alg, snapshot_owner, snapshot_network,
           snapshot_sequence, first_inclusion_ledger, last_ledger_sequence,
           approval_id, approval_expires_at, acquisition_balance_invariant, created_at)
         VALUES (?, ?, ?, 'xrpl_execution_v2', 1, ?, ?, ?, 'sha256-jcs-v1', ?,
                 'sha256-jcs-economic-v1', ?, 'devnet', 7, 101, 164, ?,
                 '2026-10-20T10:10:00.000Z', NULL, ?)`,
      ).bind(
        v2Execution,
        PRINCIPAL,
        buildId,
        JSON.stringify(DEFAULT_POLICY),
        NOW,
        HASH_A,
        HASH_B,
        OWNER,
        v2Approval,
        NOW,
      ).run();
      await expect(handleTxApprovalPreflight(isolated, {
        approval_id: v2Approval,
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
        unsigned_tx_digest: HASH_A,
        economic_fingerprint: HASH_B,
      })).rejects.toThrow(/authoritative Testnet snapshot/i);
    } finally {
      db.close();
    }
  });

  it.each(["grant", "revoke"] as const)(
    "durably binds an owner DelegateSet %s to isolated onboarding and nowhere else",
    async (mode) => {
      const db = new SqliteD1();
      try {
        const txBlob = mode === "grant" ? "BB" : "CC";
        const signedHash = mode === "grant" ? HASH_B : "C".repeat(64);
        await seedLink(
          db,
          OWNER,
          mode === "grant" ? "pending" : "suspended",
        );
        const submitSigned = vi.fn(async () => ({
          hash: signedHash,
          ledger_index: 101,
          engine_result: "tesSUCCESS",
          validated: true as const,
        }));
        const status = vi.fn(async () => ({
          hash: signedHash,
          network: "testnet" as const,
          validated: true,
          ledger_index: 101,
          engine_result: "tesSUCCESS",
        }));
        const isolated = context(db, ISOLATED_ONBOARDING_ENV, {
          submitSigned,
          status,
        });

        await expect(handleTxSubmit(isolated, {
          tx_blob: txBlob,
          network: "testnet",
        })).resolves.toMatchObject({ validated: true });
        await expect(handleTxSubmit(isolated, {
          tx_blob: txBlob,
          network: "testnet",
        })).resolves.toMatchObject({
          hash: signedHash,
          validated: true,
          ledger_index: 101,
        });
        expect(submitSigned).toHaveBeenCalledTimes(1);
        expect(await db.prepare(
          `SELECT origin_profile FROM direct_submission_bindings
            WHERE principal = ? AND hash = ?`,
        ).bind(PRINCIPAL, signedHash).first()).toEqual({
          origin_profile: LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
        });
        await expect(handleTxStatus(isolated, {
          hash: signedHash,
        })).resolves.toMatchObject({ validated: true });

        for (const env of [LEGACY_ONBOARDING_ENV, ISOLATED_TRADING_ENV]) {
          const crossStatus = vi.fn();
          await expect(handleTxStatus(context(db, env, { status: crossStatus }), {
            hash: signedHash,
          })).rejects.toThrow(/active local profile|does not permit direct/i);
          expect(crossStatus).not.toHaveBeenCalled();
        }

        const tradingSubmit = vi.fn();
        await expect(handleTxSubmit(context(db, ISOLATED_TRADING_ENV, {
          submitSigned: tradingSubmit,
        }), {
          tx_blob: txBlob,
          network: "testnet",
        })).rejects.toThrow(/only in the reviewed local trading onboarding profile/i);
        expect(tradingSubmit).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    },
  );

  it.each(["validated", "absent"] as const)(
    "reconciles an ambiguous direct owner submission from exact %s ledger evidence without resubmission",
    async (terminalKind) => {
      const db = new SqliteD1();
      try {
        await seedLink(db, OWNER, "pending");
        let terminal = false;
        const submitSigned = vi.fn(async () => {
          throw new Error("relay outcome unknown");
        });
        const status = vi.fn(async () =>
          terminal && terminalKind === "validated"
            ? {
                hash: HASH_B,
                network: "testnet" as const,
                validated: true,
                ledger_index: 101,
                engine_result: "tesSUCCESS",
              }
            : {
                hash: HASH_B,
                network: "testnet" as const,
                validated: false,
              });
        const request = vi.fn(async (_network: string, command: string, params: unknown) => {
          if (command === "ledger") {
            return {
              validated: true,
              ledger_index: terminal && terminalKind === "absent" ? 121 : 100,
            };
          }
          if (command === "account_info") {
            return {
              validated: true,
              ledger_index: 100,
              account_data: { Account: OWNER, Flags: 0 },
            };
          }
          if (command === "tx" && terminal && terminalKind === "absent") {
            expect(params).toEqual({
              transaction: HASH_B,
              binary: false,
              min_ledger: 101,
              max_ledger: 120,
              api_version: 1,
            });
            throw new XrplRpcError(
              "transaction not found",
              "transactionNotFound",
              "soft-empty",
              false,
              true,
            );
          }
          throw new Error(`unexpected XRPL command ${command}`);
        });
        const isolated: OpContext = {
          ...context(db, ISOLATED_ONBOARDING_ENV, { submitSigned, status }),
          xrplRpc: { request },
        };

        await expect(handleTxSubmit(isolated, {
          tx_blob: "BB",
          network: "testnet",
        })).rejects.toThrow(/pending ledger reconciliation/i);
        expect(submitSigned).toHaveBeenCalledTimes(1);
        await expect(db.prepare(`SELECT state, tx_hash FROM account_sequence_leases
          WHERE network = 'testnet' AND account = ?`).bind(OWNER).first())
          .resolves.toEqual({ state: "ambiguous", tx_hash: HASH_B });

        terminal = true;
        await expect(handleTxStatus(isolated, { hash: HASH_B })).resolves.toMatchObject(
          terminalKind === "validated"
            ? { hash: HASH_B, validated: true, ledger_index: 101 }
            : { hash: HASH_B, validated: false },
        );
        const lease = await db.prepare(`SELECT state, release_evidence
          FROM account_sequence_leases WHERE network = 'testnet' AND account = ?`)
          .bind(OWNER).first<{ state: string; release_evidence: string }>();
        expect(lease?.state).toBe("released");
        expect(JSON.parse(lease?.release_evidence ?? "null")).toMatchObject(
          terminalKind === "validated"
            ? { kind: "validated_terminal", hash: HASH_B, ledger_index: 101 }
            : {
                kind: "expired_absent",
                hash: HASH_B,
                validated_head: 121,
                checked_from: 101,
                checked_through: 120,
                searched_all: true,
              },
        );

        await expect(handleTxSubmit(isolated, {
          tx_blob: "BB",
          network: "testnet",
        })).resolves.toMatchObject(
          terminalKind === "validated"
            ? { hash: HASH_B, validated: true, ledger_index: 101 }
            : { status: "failed", engine_result: "tefMAX_LEDGER" },
        );
        expect(submitSigned).toHaveBeenCalledTimes(1);
      } finally {
        db.close();
      }
    },
  );

  it("blocks direct owner relay while another producer owns the ledger account sequence", async () => {
    const db = new SqliteD1();
    try {
      await seedLink(db, OWNER, "pending");
      const authority = new AccountSequenceLeaseAuthority(asD1(db));
      await expect(authority.acquire({
        principal: "another-tenant",
        network: "testnet",
        account: OWNER,
        source: "strategy",
        attemptId: "strategy:decision-1",
        token: "D".repeat(64),
        at: NOW,
      })).resolves.toMatchObject({ outcome: "acquired" });
      const submitSigned = vi.fn();
      const isolated = context(db, ISOLATED_ONBOARDING_ENV, { submitSigned });

      await expect(handleTxSubmit(isolated, {
        tx_blob: "BB",
        network: "testnet",
      })).rejects.toThrow(/another transaction.*owns the sequence lease/i);
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(db.prepare(
        "SELECT COUNT(*) AS count FROM direct_submission_bindings",
      ).first()).resolves.toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("resumes a signed direct owner attempt after a pre-submit crash without losing provenance", async () => {
    const db = new SqliteD1();
    try {
      await seedLink(db, OWNER, "pending");
      db.exec(`CREATE TRIGGER fail_direct_submit_transition
        BEFORE UPDATE OF state ON account_sequence_leases
        WHEN NEW.state = 'submitted'
        BEGIN SELECT RAISE(ABORT, 'injected pre-submit crash'); END`);
      const submitSigned = vi.fn(async () => ({
        hash: HASH_B,
        ledger_index: 101,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));
      const isolated = context(db, ISOLATED_ONBOARDING_ENV, { submitSigned });

      await expect(handleTxSubmit(isolated, {
        tx_blob: "BB",
        network: "testnet",
      })).rejects.toThrow(/injected pre-submit crash/i);
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(db.prepare(`SELECT state, tx_hash FROM account_sequence_leases
        WHERE network = 'testnet' AND account = ?`).bind(OWNER).first())
        .resolves.toEqual({ state: "signed", tx_hash: HASH_B });
      await expect(db.prepare(
        "SELECT COUNT(*) AS count FROM direct_submission_bindings",
      ).first()).resolves.toEqual({ count: 1 });

      db.exec("DROP TRIGGER fail_direct_submit_transition");
      await expect(handleTxSubmit(isolated, {
        tx_blob: "BB",
        network: "testnet",
      })).resolves.toMatchObject({
        hash: HASH_B,
        ledger_index: 101,
        validated: true,
      });
      expect(submitSigned).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("relays one signed blob only once across concurrent direct owner submissions", async () => {
    const db = new SqliteD1();
    let releaseRelay: (() => void) | undefined;
    try {
      await seedLink(db, OWNER, "pending");
      let announceRelay: (() => void) | undefined;
      const relayStarted = new Promise<void>((resolve) => {
        announceRelay = resolve;
      });
      const relayGate = new Promise<void>((resolve) => {
        releaseRelay = resolve;
      });
      const submitSigned = vi.fn(async () => {
        announceRelay?.();
        await relayGate;
        return {
          hash: HASH_B,
          ledger_index: 101,
          engine_result: "tesSUCCESS",
          validated: true as const,
        };
      });
      const status = vi.fn(async () => ({
        hash: HASH_B,
        network: "testnet" as const,
        validated: false as const,
      }));
      const isolated = context(db, ISOLATED_ONBOARDING_ENV, {
        submitSigned,
        status,
      });

      const first = handleTxSubmit(isolated, {
        tx_blob: "BB",
        network: "testnet",
      });
      await relayStarted;
      await expect(handleTxSubmit(isolated, {
        tx_blob: "BB",
        network: "testnet",
      })).rejects.toThrow(/pending ledger reconciliation/i);
      expect(submitSigned).toHaveBeenCalledTimes(1);

      releaseRelay?.();
      await expect(first).resolves.toMatchObject({
        hash: HASH_B,
        ledger_index: 101,
        validated: true,
      });
      expect(submitSigned).toHaveBeenCalledTimes(1);
    } finally {
      releaseRelay?.();
      db.close();
    }
  });

  it("does not let the new profile consume a legacy-onboarding build", async () => {
    const db = new SqliteD1();
    try {
      await seedBuild(
        db,
        "legacy-origin-build",
        OWNER,
        LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
      );
      await seedLink(db);
      await seedPolicy(db);
      await expect(handleTxExecute(context(db, ISOLATED_ONBOARDING_ENV), {
        build_id: "legacy-origin-build",
        idempotency_key: "legacy-origin",
        require_owner_approval: true,
      })).rejects.toThrow(/isolated onboarding profile/i);
      expect(await db.prepare("SELECT COUNT(*) AS count FROM executions").first())
        .toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
