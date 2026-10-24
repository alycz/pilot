import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";
import { Wallet, type AccountSet, type DelegateSet, type Transaction } from "xrpl";

import { XrplRpcError } from "../src/adapters/xrpl-rpc";
import { OpRegistry, type OpContext } from "../src/catalog/registry";
import { DEFAULT_POLICY, type ExecResult } from "../src/contracts";
import {
  RLUSD_HEX_CURRENCY,
  TESTNET_RLUSD_ISSUER,
  v2CanonicalBindings,
} from "../src/exec/build";
import { DelegateKeyError } from "../src/exec/keys";
import {
  AccountSequenceLeaseAuthority,
  accountSequenceIdentity,
} from "../src/exec/account-sequence-lease";
import { Ap4mPurchaseStore } from "../src/exec/ap4m-store";
import {
  DelegatedSigningError,
  signDelegatedTransaction,
} from "../src/exec/sign";
import { SubmitValidationError } from "../src/exec/submit";
import { Store, type BuildRow } from "../src/exec/store";
import {
  LOCAL_TRADING_BUILD_ORIGIN,
  LOCAL_TRADING_SIGNING_PROFILE,
} from "../src/local-trading";
import {
  LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
  LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
} from "../src/local-trading-onboarding";
import { handleRestOperation } from "../src/rest";
import {
  handleTxApprovalPreflight,
  handleTxApprovalReconcile,
  handleTxExecute,
  handleTxStatus,
  handleTxSubmit,
  ops as txOps,
  reserveDailyBudgetAtomic,
  TxExecuteArgsSchema,
  TxApprovalPreflightArgsSchema,
  TxApprovalReconcileArgsSchema,
  type ExecutionServices,
} from "../src/ops/tx-exec";

const PRINCIPAL = "reservation-tests";
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DELEGATE = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const NOW = "2026-10-18T10:00:00.000Z";
const YESTERDAY = "2026-10-17T23:59:00.000Z";

const REVIEWED_LOCAL_BASE = {
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

const REVIEWED_ONBOARDING_ENV = {
  ...REVIEWED_LOCAL_BASE,
  HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE:
    LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
} as const;

const REVIEWED_TRADING_ENV = {
  ...REVIEWED_LOCAL_BASE,
  HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_SIGNING_PROFILE: LOCAL_TRADING_SIGNING_PROFILE,
} as const;

const SCHEMA = `
CREATE TABLE links (id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL, network TEXT NOT NULL,
  delegate TEXT NOT NULL, delegate_seed_enc BLOB NOT NULL, iv BLOB NOT NULL, permissions TEXT NOT NULL,
  status TEXT NOT NULL, last_ledger INTEGER, revoke_tx TEXT, created_at TEXT NOT NULL,
  frozen_at TEXT, frozen_reason TEXT,
  UNIQUE (principal, owner, network));
CREATE TABLE policies (principal TEXT NOT NULL, owner TEXT NOT NULL, network TEXT NOT NULL, json TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (principal, owner, network));
CREATE TABLE ap4m_mandates (
  id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network = 'testnet'),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED', 'EXPIRED')),
  execution_type TEXT NOT NULL CHECK (execution_type = 'DEFERRED'),
  not_before TEXT NOT NULL, expires_at TEXT NOT NULL, constraints_json TEXT NOT NULL,
  agent_public_jwk TEXT NOT NULL, agent_key_enc BLOB NOT NULL, agent_key_iv BLOB NOT NULL,
  claim_keys_enc BLOB NOT NULL, claim_keys_iv BLOB NOT NULL,
  claim_public_keys_json TEXT NOT NULL, prepared_json TEXT NOT NULL,
  l1_digest TEXT NOT NULL DEFAULT '', l2_digest TEXT NOT NULL DEFAULT '',
  vi_chain_enc BLOB, vi_chain_iv BLOB, setup_batch_hash TEXT,
  channels_json TEXT NOT NULL DEFAULT '[]', spent_usd TEXT NOT NULL DEFAULT '0',
  spent_microusd INTEGER NOT NULL DEFAULT 0 CHECK (spent_microusd >= 0),
  close_requested INTEGER NOT NULL DEFAULT 0 CHECK (close_requested IN (0, 1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (principal, owner, network, id));
CREATE TABLE ap4m_spend (
  id TEXT PRIMARY KEY, principal TEXT NOT NULL, mandate_id TEXT NOT NULL,
  spend_day TEXT NOT NULL, idempotency_key TEXT NOT NULL, amount_usd TEXT NOT NULL,
  amount_microusd INTEGER NOT NULL CHECK (amount_microusd >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
  receipt_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (principal, mandate_id, idempotency_key),
  FOREIGN KEY (mandate_id) REFERENCES ap4m_mandates(id));
CREATE TABLE ap4m_purchase_attempts (
  id TEXT PRIMARY KEY, principal TEXT NOT NULL, mandate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  merchant_id TEXT NOT NULL, sku TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'prepared', 'signed', 'settlement_unknown', 'settled', 'delivered', 'failed')),
  spend_id TEXT, spend_day TEXT, amount_usd TEXT,
  amount_microusd INTEGER CHECK (amount_microusd IS NULL OR amount_microusd > 0),
  prepared_context_enc BLOB, prepared_context_iv BLOB, prepared_context_public_json TEXT,
  prepared_context_digest TEXT, lease_acquired_at TEXT NOT NULL, signing_started_at TEXT,
  signing_lease_token TEXT, first_eligible_ledger_index INTEGER,
  signed_blob TEXT, tx_hash TEXT, last_ledger_sequence INTEGER, settlement_unknown_at TEXT,
  settled_at TEXT, delivered_at TEXT, failed_at TEXT, ledger_index INTEGER,
  delivered_amount TEXT, receipt_id TEXT, merchant_response_json TEXT,
  merchant_response_at TEXT, result_json TEXT, failure_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (principal, mandate_id, idempotency_key), UNIQUE (spend_id), UNIQUE (tx_hash),
  FOREIGN KEY (mandate_id) REFERENCES ap4m_mandates(id),
  FOREIGN KEY (spend_id) REFERENCES ap4m_spend(id));
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
  created_at TEXT NOT NULL, PRIMARY KEY (execution_id, principal, build_id),
  UNIQUE (principal, approval_id));
CREATE TABLE relay_claims (principal TEXT NOT NULL, execution_id TEXT NOT NULL,
  hash TEXT NOT NULL, attempted_at TEXT NOT NULL, PRIMARY KEY (principal, execution_id, hash),
  UNIQUE (principal, execution_id), UNIQUE (principal, hash));
CREATE TABLE approval_preflight_rejections (principal TEXT NOT NULL, approval_id TEXT NOT NULL,
  execution_id TEXT NOT NULL, error_code TEXT NOT NULL, rejected_at TEXT NOT NULL,
  PRIMARY KEY (principal, approval_id), UNIQUE (principal, execution_id));
CREATE TRIGGER validate_approval_preflight_rejection_insert
BEFORE INSERT ON approval_preflight_rejections
WHEN NOT EXISTS (
  SELECT 1 FROM approvals AS a
  JOIN executions AS e ON e.principal = a.principal AND e.id = a.execution_id
  JOIN execution_snapshots AS s ON s.principal = a.principal AND s.execution_id = a.execution_id
  WHERE a.principal = NEW.principal AND a.id = NEW.approval_id
    AND a.execution_id = NEW.execution_id AND a.execution_contract = 'xrpl_execution_v2'
    AND a.status = 'pending' AND e.build_id = a.build_id AND e.status = 'needs_approval'
    AND e.hash IS NULL AND e.signed_by IS NULL AND s.build_id = a.build_id
    AND s.build_revision = a.build_revision AND s.approval_id = a.id)
BEGIN SELECT RAISE(ABORT, 'preflight rejection is not claimable'); END;
CREATE TRIGGER finalize_approval_preflight_rejection_insert
AFTER INSERT ON approval_preflight_rejections
BEGIN
  UPDATE approvals SET status = 'rejected'
   WHERE principal = NEW.principal AND id = NEW.approval_id
     AND execution_id = NEW.execution_id AND status = 'pending';
  UPDATE executions SET status = 'failed'
   WHERE principal = NEW.principal AND id = NEW.execution_id
     AND status = 'needs_approval' AND hash IS NULL AND signed_by IS NULL;
  UPDATE events SET detail = '{"result":{"status":"failed","engine_result":"'
    || NEW.error_code || '","detail":"Owner approval failed preflight before signing"}}'
   WHERE principal = NEW.principal AND id = 'execution-result:' || NEW.execution_id
     AND kind = 'execution_result';
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM approvals AS a
    JOIN executions AS e ON e.principal = a.principal AND e.id = a.execution_id
    JOIN events AS ev ON ev.principal = e.principal
      AND ev.id = 'execution-result:' || e.id AND ev.kind = 'execution_result'
    WHERE a.principal = NEW.principal AND a.id = NEW.approval_id
      AND a.execution_id = NEW.execution_id AND a.status = 'rejected'
      AND e.status = 'failed' AND e.hash IS NULL AND e.signed_by IS NULL
      AND ev.detail = '{"result":{"status":"failed","engine_result":"'
        || NEW.error_code || '","detail":"Owner approval failed preflight before signing"}}'
  ) THEN RAISE(ABORT, 'preflight rejection did not finalize atomically') END;
END;
CREATE TRIGGER reject_approval_preflight_rejection_update
BEFORE UPDATE ON approval_preflight_rejections
BEGIN SELECT RAISE(ABORT, 'preflight rejections are immutable'); END;
CREATE TRIGGER reject_approval_preflight_rejection_delete
BEFORE DELETE ON approval_preflight_rejections
BEGIN SELECT RAISE(ABORT, 'preflight rejections are immutable'); END;
CREATE TABLE approval_recoveries (principal TEXT NOT NULL, approval_id TEXT NOT NULL,
  execution_id TEXT NOT NULL, build_id TEXT NOT NULL, build_revision INTEGER NOT NULL,
  unsigned_tx_digest TEXT NOT NULL, economic_fingerprint TEXT NOT NULL,
  validated_ledger INTEGER NOT NULL, first_inclusion_ledger INTEGER NOT NULL,
  last_ledger_sequence INTEGER NOT NULL, recovered_at TEXT NOT NULL,
  PRIMARY KEY (principal, approval_id), UNIQUE (principal, execution_id),
  UNIQUE (principal, build_id, build_revision));
CREATE TRIGGER validate_approval_recovery_insert
BEFORE INSERT ON approval_recoveries
WHEN NOT EXISTS (
  SELECT 1 FROM approvals a
  JOIN executions e ON e.principal = a.principal AND e.id = a.execution_id
  JOIN execution_snapshots s ON s.principal = a.principal AND s.execution_id = a.execution_id
  JOIN build_revisions r ON r.principal = a.principal AND r.build_id = a.build_id
    AND r.build_revision = a.build_revision
  JOIN events ev ON ev.principal = e.principal AND ev.id = 'execution-result:' || e.id
    AND ev.kind = 'execution_result'
  WHERE a.principal = NEW.principal AND a.id = NEW.approval_id
    AND a.execution_id = NEW.execution_id AND a.build_id = NEW.build_id
    AND a.build_revision = NEW.build_revision AND a.execution_contract = 'xrpl_execution_v2'
    AND a.status = 'preflighted' AND e.build_id = a.build_id
    AND e.status = 'needs_approval' AND e.hash IS NULL AND e.signed_by IS NULL
    AND s.build_id = a.build_id AND s.build_revision = a.build_revision
    AND s.approval_id = a.id AND s.unsigned_tx_digest = NEW.unsigned_tx_digest
    AND s.economic_fingerprint = NEW.economic_fingerprint
    AND s.first_inclusion_ledger = NEW.first_inclusion_ledger
    AND s.last_ledger_sequence = NEW.last_ledger_sequence
    AND r.unsigned_tx_digest = NEW.unsigned_tx_digest
    AND r.economic_fingerprint = NEW.economic_fingerprint
    AND json_extract(ev.detail, '$.result.status') = 'needs_approval'
    AND NOT EXISTS (SELECT 1 FROM relay_claims c WHERE c.principal = a.principal AND c.execution_id = a.execution_id)
    AND NOT EXISTS (SELECT 1 FROM approval_preflight_rejections p WHERE p.principal = a.principal AND p.approval_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM executions other WHERE other.principal = a.principal
      AND other.build_id = a.build_id AND other.id <> a.execution_id))
BEGIN SELECT RAISE(ABORT, 'approval recovery is not claimable'); END;
CREATE TRIGGER finalize_approval_recovery_insert
AFTER INSERT ON approval_recoveries
BEGIN
  UPDATE approvals SET status = 'expired' WHERE principal = NEW.principal
    AND id = NEW.approval_id AND execution_id = NEW.execution_id AND status = 'preflighted';
  UPDATE executions SET status = 'failed' WHERE principal = NEW.principal
    AND id = NEW.execution_id AND build_id = NEW.build_id AND status = 'needs_approval'
    AND hash IS NULL AND signed_by IS NULL;
  UPDATE events SET detail = '{"result":{"status":"failed","engine_result":"APPROVAL_RECOVERED_NONINCLUSION","detail":"Unsigned owner approval expired with complete non-inclusion proof"}}'
    WHERE principal = NEW.principal AND id = 'execution-result:' || NEW.execution_id
    AND kind = 'execution_result';
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM approvals a JOIN executions e ON e.principal = a.principal AND e.id = a.execution_id
    JOIN events ev ON ev.principal = e.principal AND ev.id = 'execution-result:' || e.id
      AND ev.kind = 'execution_result'
    WHERE a.principal = NEW.principal AND a.id = NEW.approval_id
      AND a.execution_id = NEW.execution_id AND a.status = 'expired'
      AND e.status = 'failed' AND e.hash IS NULL AND e.signed_by IS NULL
      AND json_extract(ev.detail, '$.result.status') = 'failed'
      AND json_extract(ev.detail, '$.result.engine_result') = 'APPROVAL_RECOVERED_NONINCLUSION')
  THEN RAISE(ABORT, 'approval recovery did not finalize atomically') END;
END;
CREATE TRIGGER reject_approval_recovery_update BEFORE UPDATE ON approval_recoveries
BEGIN SELECT RAISE(ABORT, 'approval recoveries are immutable'); END;
CREATE TRIGGER reject_approval_recovery_delete BEFORE DELETE ON approval_recoveries
BEGIN SELECT RAISE(ABORT, 'approval recoveries are immutable'); END;
CREATE TRIGGER reject_recovered_build_execution BEFORE INSERT ON executions
WHEN EXISTS (SELECT 1 FROM approval_recoveries r WHERE r.principal = NEW.principal AND r.build_id = NEW.build_id)
BEGIN SELECT RAISE(ABORT, 'recovered build is permanently burned'); END;
CREATE TRIGGER consume_onboarding_build_after_execution_terminal
AFTER UPDATE OF status ON executions
WHEN NEW.status IN ('executed', 'needs_approval', 'blocked', 'failed')
BEGIN
  UPDATE build_consumptions SET status = 'consumed', consumed_at = COALESCE(consumed_at, 'trigger-time')
   WHERE principal = NEW.principal AND build_id = NEW.build_id
     AND idempotency_key = NEW.idempotency_key AND status = 'claimed';
END;
`;

type SqlValue = string | number | bigint | null | Uint8Array;

function sqliteValue(value: unknown): SqlValue {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SqlValue;
}

/** Execute production SQL against SQLite while exposing only the D1 methods used here. */
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

function txJson(owner = OWNER, sequence = 7): Record<string, unknown> {
  return {
    TransactionType: "OfferCancel",
    Account: owner,
    OfferSequence: 1,
    Fee: "12",
    Sequence: sequence,
    LastLedgerSequence: 200,
  };
}

function buildRow(id: string, owner = OWNER): BuildRow {
  return {
    id,
    principal: PRINCIPAL,
    owner,
    network: "testnet",
    txJson: txJson(owner),
    summary: {
      action: "cancel offer",
      account: owner,
      amounts: [],
      fee_drops: "12",
      reserve_delta_drops: "0",
      usd_value: "10",
    },
    lastLedgerSeq: 200,
    createdAt: NOW,
    originProfile: null,
  };
}

async function seedBuild(db: SqliteD1, row: BuildRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO builds
        (id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at, origin_profile,
         execution_contract, build_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.originProfile,
      row.executionContract ?? null,
      row.buildRevision ?? null,
    )
    .run();
}

async function seedLink(
  db: SqliteD1,
  status: "pending" | "active" | "revoked" | "suspended" = "active",
  owner = OWNER,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO links
        (id, principal, owner, network, delegate, delegate_seed_enc, iv, permissions,
         status, last_ledger, revoke_tx, created_at)
       VALUES (?, ?, ?, 'testnet', ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .bind(
      `link-${owner}`,
      PRINCIPAL,
      owner,
      DELEGATE,
      new Uint8Array([1]).buffer,
      new Uint8Array([2]).buffer,
      JSON.stringify(["OfferCancel"]),
      status,
      NOW,
    )
    .run();
}

async function seedPolicy(
  db: SqliteD1,
  owner = OWNER,
  dailyCapUsd = DEFAULT_POLICY.daily_cap_usd,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO policies (principal, owner, network, json, updated_at)
       VALUES (?, ?, 'testnet', ?, ?)`,
    )
    .bind(
      PRINCIPAL,
      owner,
      JSON.stringify({ ...DEFAULT_POLICY, daily_cap_usd: dailyCapUsd }),
      NOW,
    )
    .run();
}

async function seedAp4mSpend(
  db: SqliteD1,
  options: {
    amountUsd: number;
    status: "reserved" | "committed" | "released";
    id?: string;
    owner?: string;
    spendDay?: string;
  },
): Promise<void> {
  const id = options.id ?? `ap4m-spend-${options.status}`;
  const owner = options.owner ?? OWNER;
  const mandateId = `ap4m-mandate-${owner}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO ap4m_mandates (
        id, principal, owner, network, status, execution_type, not_before, expires_at,
        constraints_json, agent_public_jwk, agent_key_enc, agent_key_iv,
        claim_keys_enc, claim_keys_iv, claim_public_keys_json, prepared_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'testnet', 'ACTIVE', 'DEFERRED', ?, ?, '{}', '{}', X'01', X'02',
        X'03', X'04', '[]', '{}', ?, ?)`,
    )
    .bind(
      mandateId,
      PRINCIPAL,
      owner,
      "2026-10-18T00:00:00.000Z",
      "2026-10-19T00:00:00.000Z",
      NOW,
      NOW,
    )
    .run();
  const micros = Math.round(options.amountUsd * 1_000_000);
  await db
    .prepare(
      `INSERT INTO ap4m_spend (
        id, principal, mandate_id, spend_day, idempotency_key, amount_usd,
        amount_microusd, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      PRINCIPAL,
      mandateId,
      options.spendDay ?? NOW.slice(0, 10),
      `idem-${id}`,
      options.amountUsd.toFixed(6),
      micros,
      options.status,
      NOW,
      NOW,
    )
    .run();
}

const AP4M_FP = "A".repeat(64);
const AP4M_KEK = Buffer.alloc(32, 7).toString("base64");
const AP4M_RLUSD_WIRE = Buffer.from("RLUSD")
  .toString("hex")
  .toUpperCase()
  .padEnd(40, "0");

function ap4mPreparedContext(amount = "60") {
  const intent = {
    intentId: "demo-intent-11111111-1111-4111-8111-111111111111",
    intentSummary: "Purchase yield-report from Demo Merchant",
    intentStatus: "ACTIVE" as const,
    orders: [{
      orderId: "demo-order-22222222-2222-4222-8222-222222222222",
      orderExecutionType: "DEFERRED" as const,
      orderExpiry: 1_800_000_000,
      orderTotalAmount: { amount, currency: "USD" },
      items: [{
        itemId: "yield-report",
        itemName: "Yield report",
        itemUnitPrice: { amount, currency: "USD" },
        itemQuantity: 1,
        itemDeliveryMethod: "DIGITAL" as const,
      }],
      merchants: [{ srcDpaId: "src-dpa-1", merchantName: "Demo Merchant" }],
    }],
  };
  const acceptedRequirement = {
    scheme: "exact",
    network: "xrpl:1",
    asset: AP4M_RLUSD_WIRE,
    payTo: "rMerchant",
    amount,
    maxTimeoutSeconds: 60,
    extra: {
      areFeesSponsored: false,
      assetTransferMethod: "sequence",
      invoiceId: "invoice-cap-test",
      issuer: "rIssuer",
      sourceTag: 2610240,
    },
  };
  const intentHeader = Buffer.from(JSON.stringify(intent)).toString("base64url");
  return {
    intent,
    vi: {
      l1: "l1.jwt~disclosure",
      l2: "l2.jwt~disclosure",
      l3a: "l3a.jwt~disclosure",
      l3b: "l3b.jwt~disclosure",
      l3aDigest: "a".repeat(64),
      l3bDigest: "b".repeat(64),
    },
    challenge: {
      x402Version: 2,
      scheme: "exact",
      network: "xrpl:1",
      currency: AP4M_RLUSD_WIRE,
      issuer: "rIssuer",
      amount,
      payTo: "rMerchant",
      resource: { url: "https://merchant.example/resource/yield-report" },
      accepted: acceptedRequirement,
    },
    challengeState: "A".repeat(43),
    payer: "rCapTestPayer",
    merchantSnapshot: {
      id: "merchant-a",
      name: "Demo Merchant",
      network: "testnet" as const,
      base_url: "https://merchant.example",
      xrpl_address: "rMerchant",
      src_dpa_id: "src-dpa-1",
      schemes: ["exact" as const],
      settle_asset: { kind: "iou" as const, currency: "RLUSD", issuer: "rIssuer" },
      required_credential: {
        issuer: "rDemoNetwork",
        credential_type_hex: "4150344D2D4167656E74",
      },
      products: [{
        sku: "yield-report",
        name: "Yield report",
        description: "Typed report",
        price: {
          asset: { kind: "iou" as const, currency: "RLUSD", issuer: "rIssuer" },
          value: amount,
        },
        response_schema_id: "yield_report_v1",
      }],
      wba_required: true,
    },
    receiptAmount: {
      asset: { kind: "iou" as const, currency: "RLUSD", issuer: "rIssuer" },
      value: amount,
    },
    acceptedRequirement,
    resourceUrl: "https://merchant.example/resource/yield-report",
    receiptId: "receipt-cap-test",
    retryHeaders: {
      "x-mastercard-intent": intentHeader,
      "x-vi-l1": "l1.jwt~disclosure",
      "x-vi-l2": "l2.jwt~disclosure",
      "x-vi-l3b": "l3b.jwt~disclosure",
    },
  };
}

async function prepareAp4mCapReservation(db: SqliteD1, idempotencyKey: string) {
  await seedPolicy(db, OWNER, 100);
  await db
    .prepare(
      `INSERT INTO ap4m_mandates (
        id, principal, owner, network, status, execution_type, not_before, expires_at,
        constraints_json, agent_public_jwk, agent_key_enc, agent_key_iv,
        claim_keys_enc, claim_keys_iv, claim_public_keys_json, prepared_json,
        created_at, updated_at
      ) VALUES ('ap4m-mandate-cap', ?, ?, 'testnet', 'ACTIVE', 'DEFERRED', ?, ?, ?, '{}',
        X'01', X'02', X'03', X'04', '[]', '{}', ?, ?)`,
    )
    .bind(
      PRINCIPAL,
      OWNER,
      "2026-10-18T00:00:00.000Z",
      "2026-10-19T00:00:00.000Z",
      JSON.stringify({
        currency: "USD",
        per_payment_max: "100",
        daily_max: "100",
        total_max: "100",
        payees: ["merchant-a"],
      }),
      NOW,
      NOW,
    )
    .run();
  const store = new Ap4mPurchaseStore(asD1(db), PRINCIPAL, () => new Date(NOW));
  await store.claim({
    id: `attempt-${idempotencyKey}`,
    mandateId: "ap4m-mandate-cap",
    idempotencyKey,
    requestFingerprint: AP4M_FP,
    merchantId: "merchant-a",
    sku: "yield-report",
    createdAt: NOW,
  });
  return store;
}

async function reserveAp4mCap(
  store: Ap4mPurchaseStore,
  idempotencyKey: string,
  amount = "60",
) {
  return store.reserve({
    mandateId: "ap4m-mandate-cap",
    idempotencyKey,
    requestFingerprint: AP4M_FP,
    leaseAcquiredAt: NOW,
    spendId: `ap4m-spend-${idempotencyKey}`,
    spendDay: NOW.slice(0, 10),
    amountUsd: amount,
    preparedContext: ap4mPreparedContext(amount),
    preparedAt: NOW,
  }, AP4M_KEK);
}

function directDelegateSetFixture() {
  const owner = Wallet.generate();
  const transaction: DelegateSet = {
    TransactionType: "DelegateSet",
    Account: owner.classicAddress,
    Authorize: DELEGATE,
    Permissions: [{ Permission: { PermissionValue: "OfferCancel" } }],
    Fee: "10",
    Sequence: 1,
    LastLedgerSequence: 140,
  };
  return { owner: owner.classicAddress, signed: owner.sign(transaction) };
}

function xrplRpc(options: {
  submitResult?: Record<string, unknown>;
  validatedLedger?: number;
  accountOwner?: string;
} = {}) {
  const validatedLedger = options.validatedLedger ?? 100;
  const accountOwner = options.accountOwner ?? OWNER;
  return {
    request: vi.fn(async (_network: string, command: string) => {
      if (command === "ledger_current") return { ledger_current_index: 100 };
      if (command === "account_info") {
        return {
          account_data: {
            Account: accountOwner,
            Balance: "100000000",
            OwnerCount: 0,
            Sequence: 7,
            Flags: 0,
          },
          ledger_index: validatedLedger,
          validated: true,
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
      if (command === "fee") {
        return {
          drops: { open_ledger_fee: "10" },
          current_queue_size: "0",
          max_queue_size: "100",
          ledger_current_index: 101,
        };
      }
      if (command === "simulate") {
        return {
          engine_result: "tesSUCCESS",
          engine_result_message: "The simulated transaction would succeed.",
          applied: false,
        };
      }
      if (command === "ledger") {
        return {
          validated: true,
          ledger_index: validatedLedger,
          ledger: { ledger_index: validatedLedger },
        };
      }
      if (command === "submit" && options.submitResult) {
        return options.submitResult;
      }
      throw new Error(`Unexpected XRPL command: ${command}`);
    }),
  };
}

async function seedV2Build(
  db: SqliteD1,
  id: string,
  owner = OWNER,
  acquisitionBalanceInvariant: {
    kind: "issued_balance_unchanged";
    currency: string;
    issuer: string;
    balance: string;
    ledgerIndex: number;
  } | null = null,
  transaction?: Record<string, unknown>,
): Promise<BuildRow> {
  const build = buildRow(id, owner);
  build.originProfile = LOCAL_TRADING_BUILD_ORIGIN;
  build.executionContract = "xrpl_execution_v2";
  build.buildRevision = 1;
  build.txJson = transaction ?? txJson(owner, 7);
  build.txJson.LastLedgerSequence = 164;
  build.lastLedgerSeq = 164;
  const bindings = await v2CanonicalBindings(build.txJson, owner, "testnet");
  await seedBuild(db, build);
  await new Store(asD1(db), PRINCIPAL).insertBuildRevision({
    buildId: id,
    buildRevision: 1,
    executionContract: "xrpl_execution_v2",
    owner,
    network: "testnet",
    txJson: build.txJson,
    summary: build.summary,
    unsignedTxDigest: bindings.unsignedTxDigest,
    unsignedTxDigestAlg: "sha256-jcs-v1",
    economicFingerprint: bindings.economicFingerprint,
    economicFingerprintAlg: "sha256-jcs-economic-v1",
    buildLedger: 100,
    firstInclusionLedger: 101,
    lastLedgerSequence: 164,
    minimumRemainingLedgers: 8,
    approvalExpiresInSeconds: 90,
    quoteLedger: null,
    quoteValidThroughLedger: null,
    acquisitionBalanceInvariant,
    createdAt: NOW,
  });
  return build;
}

function v2Context(
  db: SqliteD1,
  services: ExecutionServices,
  validatedLedger: number,
  accountOwner = OWNER,
): OpContext {
  return {
    principal: PRINCIPAL,
    localDevRequest: true,
    env: { ...REVIEWED_TRADING_ENV, DB: asD1(db) },
    db: asD1(db),
    xrplRpc: xrplRpc({ validatedLedger, accountOwner }),
    executionServices: services,
  } as OpContext;
}

function facts() {
  return {
    getPolicyFacts: vi.fn(async () => ({ usdValue: "10", issuerFacts: [] })),
  };
}

async function seedPreflightedRecoveryCandidate(
  db: SqliteD1,
  id: string,
): Promise<{
  build: BuildRow;
  approvalId: string;
  executionId: string;
  binding: {
    approval_id: string;
    execution_contract: "xrpl_execution_v2";
    build_revision: number;
    unsigned_tx_digest: string;
    economic_fingerprint: string;
  };
}> {
  const invariant = {
    kind: "issued_balance_unchanged" as const,
    currency: RLUSD_HEX_CURRENCY,
    issuer: TESTNET_RLUSD_ISSUER,
    balance: "0",
    ledgerIndex: 100,
  };
  const build = await seedV2Build(db, id, OWNER, invariant, {
    TransactionType: "OfferCreate",
    Account: OWNER,
    TakerPays: {
      currency: RLUSD_HEX_CURRENCY,
      issuer: TESTNET_RLUSD_ISSUER,
      value: "75",
    },
    TakerGets: "100000000",
    Flags: 0x0004_0000,
    Fee: "12",
    Sequence: 7,
    LastLedgerSequence: 164,
  });
  await seedPolicy(db);
  await seedLink(db);
  const ids = [`${id}-execution`, `${id}-approval`];
  const ctx = v2Context(db, {
    facts: {
      getPolicyFacts: vi.fn(async () => ({
        usdValue: "75",
        issuerFacts: [{
          currency: RLUSD_HEX_CURRENCY,
          issuer: TESTNET_RLUSD_ISSUER,
          requireAuth: false,
        }],
        stableAsset: { currency: RLUSD_HEX_CURRENCY, issuer: TESTNET_RLUSD_ISSUER },
      })),
    },
    now: () => new Date(NOW),
    randomUUID: () => ids.shift()!,
  }, 156);
  const baseRequest = ctx.xrplRpc!.request.bind(ctx.xrplRpc);
  ctx.xrplRpc = {
    request: vi.fn(async (network, command, params, options) => {
      if (command === "account_lines") {
        return {
          account: OWNER,
          ledger_index: params?.ledger_index,
          validated: true,
          lines: [{
            account: TESTNET_RLUSD_ISSUER,
            currency: RLUSD_HEX_CURRENCY,
            balance: "0",
          }],
        };
      }
      return baseRequest(network, command, params, options);
    }),
  };
  const approvalResult = await handleTxExecute(ctx, {
    build_id: build.id,
    idempotency_key: id,
    require_owner_approval: true,
    execution_contract: "xrpl_execution_v2",
    build_revision: 1,
  });
  if (approvalResult.status !== "needs_approval") {
    throw new Error(`recovery fixture did not create approval: ${JSON.stringify(approvalResult)}`);
  }
  const approvalId = (approvalResult as { approval_id: string }).approval_id;
  const revision = await new Store(asD1(db), PRINCIPAL).getBuildRevision(build.id, 1);
  const binding = {
    approval_id: approvalId,
    execution_contract: "xrpl_execution_v2" as const,
    build_revision: 1,
    unsigned_tx_digest: revision!.unsignedTxDigest,
    economic_fingerprint: revision!.economicFingerprint,
  };
  await handleTxApprovalPreflight(ctx, binding);
  return { build, approvalId, executionId: `${id}-execution`, binding };
}

function context(
  db: SqliteD1,
  services: ExecutionServices,
): OpContext {
  return {
    principal: PRINCIPAL,
    db: asD1(db),
    xrplRpc: xrplRpc(),
    executionServices: services,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function storeWithGatedBuildRead(
  db: SqliteD1,
  entered: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>,
): Store {
  const store = new Store(asD1(db), PRINCIPAL);
  const getBuild = store.getBuild.bind(store);
  vi.spyOn(store, "getBuild").mockImplementation(async (id) => {
    entered.resolve();
    await release.promise;
    return getBuild(id);
  });
  return store;
}

async function seedPendingApproval(
  db: SqliteD1,
  name: string,
  transactionType: "AccountSet" | "TrustSet" = "AccountSet",
  originProfile: BuildRow["originProfile"] = null,
) {
  const wallet = Wallet.generate();
  const transaction: Transaction = transactionType === "TrustSet"
    ? {
        TransactionType: "TrustSet",
        Account: wallet.address,
        LimitAmount: {
          currency: "USD",
          issuer: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",
          value: "100",
        },
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 200,
      }
    : {
        TransactionType: "AccountSet",
        Account: wallet.address,
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 200,
      } satisfies AccountSet;
  const signed = wallet.sign(transaction);
  const executionId = `${name}-execution`;
  const approvalId = `${executionId}.approval`;
  const build = buildRow(`${name}-build`, wallet.address);
  build.txJson = transaction;
  build.originProfile = originProfile;
  await seedBuild(db, build);
  await seedPolicy(db, wallet.address);
  if (originProfile === LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN) {
    await db
      .prepare(
        `INSERT INTO build_consumptions
          (principal, build_id, idempotency_key, status, claimed_at, consumed_at)
         VALUES (?, ?, ?, 'consumed', ?, ?)`,
      )
      .bind(
        PRINCIPAL,
        build.id,
        `${PRINCIPAL}:${name}-request`,
        NOW,
        NOW,
      )
      .run();
  }
  await db
    .prepare(
      `INSERT INTO executions
        (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
       VALUES (?, ?, ?, ?, 'needs_approval', NULL, 10, NULL, ?)`,
    )
    .bind(
      executionId,
      PRINCIPAL,
      build.id,
      `${PRINCIPAL}:${name}-request`,
      NOW,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO approvals (id, principal, build_id, tx_json, expires_at, status)
       VALUES (?, ?, ?, ?, '2026-10-18T10:10:00.000Z', 'pending')`,
    )
    .bind(approvalId, PRINCIPAL, build.id, JSON.stringify(transaction))
    .run();
  await db
    .prepare(
      `INSERT INTO events (id, principal, owner, kind, detail, created_at)
       VALUES (?, ?, ?, 'execution_result', ?, ?)`,
    )
    .bind(
      `execution-result:${executionId}`,
      PRINCIPAL,
      wallet.address,
      JSON.stringify({
        result: {
          status: "needs_approval",
          approval_id: approvalId,
          tx_json: transaction,
          expires_at: "2026-10-18T10:10:00.000Z",
          policy: { verdict: "needs_approval", reasons: [] },
        },
      }),
      NOW,
    )
    .run();
  return {
    approvalId,
    buildId: build.id,
    executionId,
    idempotencyKey: `${name}-request`,
    owner: wallet.address,
    signed,
  };
}

async function seedSubmittedDelegated(
  db: SqliteD1,
  name: string,
  hash: string,
  mutateBuild?: (build: BuildRow) => void,
): Promise<BuildRow> {
  const build = buildRow(`${name}-build`);
  mutateBuild?.(build);
  await seedBuild(db, build);
  await db
    .prepare(
      `INSERT INTO executions
        (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
       VALUES (?, ?, ?, ?, 'submitted', ?, 10, 'delegate', ?)`,
    )
    .bind(
      `${name}-execution`,
      PRINCIPAL,
      build.id,
      `${PRINCIPAL}:${name}`,
      hash,
      NOW,
    )
    .run();
  return build;
}

async function seedSubmittedOwnerWithSequenceLease(
  db: SqliteD1,
  name: string,
) {
  const fixture = await seedPendingApproval(db, name);
  const hash = fixture.signed.hash.toUpperCase();
  await db
    .prepare(
      "UPDATE executions SET status = 'submitted', hash = ?, signed_by = 'owner' WHERE id = ?",
    )
    .bind(hash, fixture.executionId)
    .run();
  await db
    .prepare("UPDATE approvals SET status = 'submitted' WHERE id = ?")
    .bind(fixture.approvalId)
    .run();
  const authority = new AccountSequenceLeaseAuthority(asD1(db));
  const acquired = await authority.acquire({
    principal: PRINCIPAL,
    network: "testnet",
    account: fixture.owner,
    source: "manual",
    attemptId: fixture.executionId,
    token: "A".repeat(64),
    at: NOW,
  });
  if (acquired.outcome !== "acquired") {
    throw new Error("owner sequence fixture could not acquire its lease");
  }
  const identity = accountSequenceIdentity(acquired.lease);
  await authority.markSigning({
    ...identity,
    sequence: 1,
    firstLedgerSequence: 197,
    lastLedgerSequence: 200,
    at: NOW,
  });
  await authority.markSigned({ ...identity, hash, at: NOW });
  await authority.markSubmitted({ ...identity, hash, at: NOW });
  return { ...fixture, hash };
}

async function expectForcedApprovalRows(
  db: SqliteD1,
  input: {
    executionId: string;
    approvalId: string;
    buildId: string;
    idempotencyKey: string;
    txJson: Record<string, unknown>;
    result: Awaited<ReturnType<typeof handleTxExecute>>;
  },
): Promise<void> {
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM executions WHERE principal = ?) AS executions,
         (SELECT COUNT(*) FROM approvals WHERE principal = ?) AS approvals,
         (SELECT COUNT(*) FROM events WHERE principal = ?) AS events`,
    )
    .bind(PRINCIPAL, PRINCIPAL, PRINCIPAL)
    .first<{ executions: number; approvals: number; events: number }>();
  expect(counts).toEqual({ executions: 1, approvals: 1, events: 2 });

  const execution = await db
    .prepare(
      `SELECT id, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at
         FROM executions WHERE principal = ?`,
    )
    .bind(PRINCIPAL)
    .first<{
      id: string;
      build_id: string;
      idempotency_key: string;
      status: string;
      hash: string | null;
      usd_value: number;
      signed_by: string | null;
      created_at: string;
    }>();
  expect(execution).toEqual({
    id: input.executionId,
    build_id: input.buildId,
    idempotency_key: `${PRINCIPAL}:${input.idempotencyKey}`,
    status: "needs_approval",
    hash: null,
    usd_value: 10,
    signed_by: null,
    created_at: NOW,
  });

  const approval = await db
    .prepare(
      `SELECT id, build_id, tx_json, expires_at, status
         FROM approvals WHERE principal = ?`,
    )
    .bind(PRINCIPAL)
    .first<{
      id: string;
      build_id: string;
      tx_json: string;
      expires_at: string;
      status: string;
    }>();
  expect(approval).toMatchObject({
    id: input.approvalId,
    build_id: input.buildId,
    expires_at: "2026-10-18T10:10:00.000Z",
    status: "pending",
  });
  expect(JSON.parse(approval?.tx_json ?? "null")).toEqual(input.txJson);

  const event = await db
    .prepare(
      `SELECT id, owner, kind, detail, created_at
         FROM events WHERE principal = ? AND kind = 'execution_result'`,
    )
    .bind(PRINCIPAL)
    .first<{
      id: string;
      owner: string;
      kind: string;
      detail: string;
      created_at: string;
    }>();
  expect(event).toMatchObject({
    id: `execution-result:${input.executionId}`,
    owner: OWNER,
    kind: "execution_result",
    created_at: NOW,
  });
  expect(JSON.parse(event?.detail ?? "null")).toEqual({ result: input.result });

  const claim = await db
    .prepare(
      `SELECT id, owner, kind, detail, created_at
         FROM events WHERE principal = ? AND kind = 'execution_claim'`,
    )
    .bind(PRINCIPAL)
    .first<{
      id: string;
      owner: string;
      kind: string;
      detail: string;
      created_at: string;
    }>();
  expect(claim).toMatchObject({
    id: `execution-claim:${input.executionId}`,
    owner: OWNER,
    kind: "execution_claim",
    created_at: NOW,
  });
  expect(JSON.parse(claim?.detail ?? "null")).toEqual({
    build_id: input.buildId,
    execution_mode: "require_owner_approval",
  });

  const forbidden = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM executions
        WHERE principal = ?
          AND (status IN ('pending', 'submitted') OR signed_by = 'delegate')`,
    )
    .bind(PRINCIPAL)
    .first<{ count: number }>();
  expect(forbidden).toEqual({ count: 0 });
}

describe("forced owner approval execution", () => {
  it("accepts only the optional literal true flag in both execute schemas", () => {
    const op = txOps.find((candidate) => candidate.name === "tx.execute");
    expect(op).toBeDefined();
    const schemas = [TxExecuteArgsSchema, op!.args];
    const base = { build_id: "build", idempotency_key: "intent" };

    for (const schema of schemas) {
      expect(schema.parse(base)).toEqual(base);
      expect(schema.parse({ ...base, require_owner_approval: true })).toEqual({
        ...base,
        require_owner_approval: true,
      });
      for (const invalid of [false, "true", 1, null]) {
        expect(
          schema.safeParse({ ...base, require_owner_approval: invalid }).success,
        ).toBe(false);
      }
      expect(schema.safeParse({ ...base, unexpected: true }).success).toBe(false);
    }
  });

  it("atomically prepares exact owner approval instead of delegating under a permissive policy", async () => {
    const db = new SqliteD1();
    try {
      const build = buildRow("forced-approval-build");
      build.txJson.LastLedgerSequence = 99;
      build.lastLedgerSeq = 99;
      await seedBuild(db, build);
      await seedPolicy(db);
      await seedLink(db);

      const reserveDailyBudget = vi.fn(async () => "reserved" as const);
      const signDelegate = vi.fn();
      const submitSigned = vi.fn();
      const ids = ["forced-approval-execution", "forced-approval-token"];
      const executeContext = context(db, {
        facts: facts(),
        reserveDailyBudget,
        signDelegate,
        submitSigned,
        now: () => new Date(NOW),
        randomUUID: () => ids.shift()!,
      });
      const executeArgs = TxExecuteArgsSchema.parse({
        build_id: build.id,
        idempotency_key: "forced-approval",
        require_owner_approval: true,
      });
      const result = await handleTxExecute(executeContext, executeArgs);

      const refreshedTx = {
        TransactionType: "OfferCancel",
        Account: OWNER,
        OfferSequence: 1,
        Fee: "10",
        Sequence: 7,
        LastLedgerSequence: 104,
      };
      expect(result).toMatchObject({
        status: "needs_approval",
        approval_id: "forced-approval-execution.forced-approval-token",
        tx_json: refreshedTx,
        expires_at: "2026-10-18T10:10:00.000Z",
        policy: {
          verdict: "needs_approval",
          reasons: expect.arrayContaining([
            {
              rule: "require_owner_approval",
              pass: false,
              detail: "Owner approval was explicitly required by tx.execute",
            },
          ]),
        },
      });
      const refreshedBuild = await db
        .prepare("SELECT tx_json, last_ledger_seq FROM builds WHERE id = ?")
        .bind(build.id)
        .first<{ tx_json: string; last_ledger_seq: number }>();
      expect(refreshedBuild?.last_ledger_seq).toBe(104);
      expect(JSON.parse(refreshedBuild?.tx_json ?? "null")).toEqual(refreshedTx);
      await expect(handleTxExecute(executeContext, executeArgs)).resolves.toEqual(
        result,
      );
      await expectForcedApprovalRows(db, {
        executionId: "forced-approval-execution",
        approvalId: "forced-approval-execution.forced-approval-token",
        buildId: build.id,
        idempotencyKey: "forced-approval",
        txJson: refreshedTx,
        result,
      });
      expect(reserveDailyBudget).not.toHaveBeenCalled();
      expect(signDelegate).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("terminally refuses to refresh an expired exact-output FOK quote", async () => {
    const db = new SqliteD1();
    try {
      const build = buildRow("expired-exact-output-quote");
      build.txJson = {
        TransactionType: "OfferCreate",
        Account: OWNER,
        TakerGets: "271112288",
        TakerPays: {
          currency: "524C555344000000000000000000000000000000",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
          value: "75",
        },
        Flags: 0x0004_0000,
        Fee: "12",
        Sequence: 7,
        LastLedgerSequence: 99,
      };
      build.summary = {
        action: "swap",
        account: OWNER,
        amounts: ["271112288 drops XRP", "75 RLUSD"],
        fee_drops: "12",
        reserve_delta_drops: "0",
        est_slippage_bps: 100,
        usd_value: "135.556144",
      };
      build.lastLedgerSeq = 99;
      await seedBuild(db, build);
      await seedPolicy(db);
      await seedLink(db);

      const reserveDailyBudget = vi.fn(async () => "reserved" as const);
      const signDelegate = vi.fn();
      const submitSigned = vi.fn();
      const executeContext = context(db, {
        facts: facts(),
        reserveDailyBudget,
        signDelegate,
        submitSigned,
        now: () => new Date(NOW),
        randomUUID: () => "expired-quote-execution",
      });
      const executeArgs = TxExecuteArgsSchema.parse({
        build_id: build.id,
        idempotency_key: "expired-quote",
        require_owner_approval: true,
      });
      const expected = {
        status: "failed",
        engine_result: "QUOTE_EXPIRED",
        detail: "Exact-output FOK quote expired; request a fresh tx.swap build",
      } as const;

      await expect(handleTxExecute(executeContext, executeArgs)).resolves.toEqual(
        expected,
      );
      await expect(handleTxExecute(executeContext, executeArgs)).resolves.toEqual(
        expected,
      );
      const stored = await db
        .prepare(
          "SELECT tx_json, last_ledger_seq FROM builds WHERE principal = ? AND id = ?",
        )
        .bind(PRINCIPAL, build.id)
        .first<{ tx_json: string; last_ledger_seq: number }>();
      expect(stored?.last_ledger_seq).toBe(99);
      expect(JSON.parse(stored?.tx_json ?? "null")).toEqual(build.txJson);
      const execution = await db
        .prepare(
          "SELECT status, usd_value, signed_by FROM executions WHERE principal = ? AND id = ?",
        )
        .bind(PRINCIPAL, "expired-quote-execution")
        .first<{
          status: string;
          usd_value: number;
          signed_by: string | null;
        }>();
      expect(execution).toEqual({
        status: "failed",
        usd_value: 135.556144,
        signed_by: null,
      });
      expect(reserveDailyBudget).not.toHaveBeenCalled();
      expect(signDelegate).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("keeps forced approval when a concurrent policy update remains permissive", async () => {
    const db = new SqliteD1();
    try {
      const build = buildRow("forced-policy-race-build");
      await seedBuild(db, build);
      await seedPolicy(db);
      await seedLink(db);

      const enteredFacts = deferred<void>();
      const releaseFacts = deferred<void>();
      const policyFacts = {
        getPolicyFacts: vi.fn(async () => {
          enteredFacts.resolve();
          await releaseFacts.promise;
          return { usdValue: "10", issuerFacts: [] };
        }),
      };
      const reserveDailyBudget = vi.fn(async () => "reserved" as const);
      const signDelegate = vi.fn();
      const submitSigned = vi.fn();
      const ids = ["forced-policy-race-execution", "forced-policy-race-token"];
      const execution = handleTxExecute(
        context(db, {
          facts: policyFacts,
          reserveDailyBudget,
          signDelegate,
          submitSigned,
          now: () => new Date(NOW),
          randomUUID: () => ids.shift()!,
        }),
        TxExecuteArgsSchema.parse({
          build_id: build.id,
          idempotency_key: "forced-policy-race",
          require_owner_approval: true,
        }),
      );

      await enteredFacts.promise;
      await db
        .prepare(
          `UPDATE policies SET json = ?, updated_at = ?
            WHERE principal = ? AND owner = ? AND network = 'testnet'`,
        )
        .bind(
          JSON.stringify({
            ...DEFAULT_POLICY,
            execute_under_usd: 25,
            max_per_tx_usd: 2500,
          }),
          "2026-10-18T10:00:01.000Z",
          PRINCIPAL,
          OWNER,
        )
        .run();
      releaseFacts.resolve();

      const result = await execution;
      expect(result).toMatchObject({
        status: "needs_approval",
        approval_id: "forced-policy-race-execution.forced-policy-race-token",
        tx_json: build.txJson,
        policy: { verdict: "needs_approval" },
      });
      await expectForcedApprovalRows(db, {
        executionId: "forced-policy-race-execution",
        approvalId: "forced-policy-race-execution.forced-policy-race-token",
        buildId: build.id,
        idempotencyKey: "forced-policy-race",
        txJson: build.txJson,
        result,
      });
      expect(policyFacts.getPolicyFacts).toHaveBeenCalledTimes(1);
      expect(reserveDailyBudget).not.toHaveBeenCalled();
      expect(signDelegate).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each(["forced", "policy"] as const)(
    "binds a concurrent mixed-mode idempotency race to the %s first claimant",
    async (firstMode) => {
      const db = new SqliteD1();
      try {
        const build = buildRow(`mixed-mode-${firstMode}-build`);
        await seedBuild(db, build);
        await seedPolicy(db);
        await seedLink(db);

        const start = deferred<void>();
        const forcedBuildEntered = deferred<void>();
        const releaseForcedBuild = deferred<void>();
        const policyBuildEntered = deferred<void>();
        const releasePolicyBuild = deferred<void>();
        const forcedFactsEntered = deferred<void>();
        const releaseForcedFacts = deferred<void>();
        const policyFactsEntered = deferred<void>();
        const releasePolicyFacts = deferred<void>();
        const forcedFacts = {
          getPolicyFacts: vi.fn(async () => {
            forcedFactsEntered.resolve();
            await releaseForcedFacts.promise;
            return { usdValue: "10", issuerFacts: [] };
          }),
        };
        const policyFacts = {
          getPolicyFacts: vi.fn(async () => {
            policyFactsEntered.resolve();
            await releasePolicyFacts.promise;
            return { usdValue: "10", issuerFacts: [] };
          }),
        };
        const forcedReserve = vi.fn(async () => "reserved" as const);
        const policyContenderReserve = vi.fn(async () => "reserved" as const);
        const forcedSign = vi.fn();
        const forcedSubmit = vi.fn();
        const delegatedWallet = Wallet.generate();
        const delegated = delegatedWallet.sign({
          TransactionType: "AccountSet",
          Account: delegatedWallet.address,
          Fee: "12",
          Sequence: 1,
          LastLedgerSequence: 200,
        });
        const policySign = vi.fn(async () => ({
          tx_blob: delegated.tx_blob,
          hash: delegated.hash,
        }));
        const policySubmit = vi.fn(async () => ({
          hash: delegated.hash,
          ledger_index: 198,
          engine_result: "tesSUCCESS",
          validated: true as const,
        }));
        const forcedIds = [
          `mixed-mode-${firstMode}-forced-execution`,
          `mixed-mode-${firstMode}-forced-token`,
        ];
        const policyIds = [`mixed-mode-${firstMode}-policy-execution`];
        const idempotencyKey = `mixed-mode-${firstMode}`;
        const forcedContext = context(db, {
          store: storeWithGatedBuildRead(
            db,
            forcedBuildEntered,
            releaseForcedBuild,
          ),
          facts: forcedFacts,
          reserveDailyBudget: forcedReserve,
          signDelegate: forcedSign,
          submitSigned: forcedSubmit,
          now: () => new Date(NOW),
          randomUUID: () => forcedIds.shift()!,
        });
        const policyContext = context(db, {
          store: storeWithGatedBuildRead(
            db,
            policyBuildEntered,
            releasePolicyBuild,
          ),
          facts: policyFacts,
          ...(firstMode === "forced"
            ? { reserveDailyBudget: policyContenderReserve }
            : {}),
          signDelegate: policySign,
          submitSigned: policySubmit,
          now: () => new Date(NOW),
          randomUUID: () => policyIds.shift()!,
        });
        const forcedExecution = (async () => {
          await start.promise;
          return handleTxExecute(forcedContext, {
            build_id: build.id,
            idempotency_key: idempotencyKey,
            require_owner_approval: true,
          });
        })();
        const policyExecution = (async () => {
          await start.promise;
          return handleTxExecute(policyContext, {
            build_id: build.id,
            idempotency_key: idempotencyKey,
          });
        })();

        start.resolve();
        await Promise.all([
          forcedBuildEntered.promise,
          policyBuildEntered.promise,
        ]);

        if (firstMode === "forced") {
          releaseForcedBuild.resolve();
          await forcedFactsEntered.promise;
          const rejectedContender = expect(policyExecution).rejects.toThrow(
            /different execution mode/i,
          );
          releasePolicyBuild.resolve();
          await rejectedContender;
          releaseForcedFacts.resolve();

          const result = await forcedExecution;
          expect(result).toMatchObject({
            status: "needs_approval",
            approval_id: "mixed-mode-forced-forced-execution.mixed-mode-forced-forced-token",
            tx_json: build.txJson,
            policy: { verdict: "needs_approval" },
          });
          await expectForcedApprovalRows(db, {
            executionId: "mixed-mode-forced-forced-execution",
            approvalId:
              "mixed-mode-forced-forced-execution.mixed-mode-forced-forced-token",
            buildId: build.id,
            idempotencyKey,
            txJson: build.txJson,
            result,
          });
          expect(forcedFacts.getPolicyFacts).toHaveBeenCalledTimes(1);
          expect(policyFacts.getPolicyFacts).not.toHaveBeenCalled();
          expect(policyContenderReserve).not.toHaveBeenCalled();
          expect(policySign).not.toHaveBeenCalled();
          expect(policySubmit).not.toHaveBeenCalled();
        } else {
          releasePolicyBuild.resolve();
          await policyFactsEntered.promise;
          const rejectedContender = expect(forcedExecution).rejects.toThrow(
            /different execution mode/i,
          );
          releaseForcedBuild.resolve();
          await rejectedContender;
          releasePolicyFacts.resolve();

          await expect(policyExecution).resolves.toEqual({
            status: "executed",
            hash: delegated.hash,
            ledger_index: 198,
            result: "success",
            signed_by: "delegate",
            confirmation: {
              provider: "poll",
              at: NOW,
              latency_ms: 0,
            },
          });
          expect(policyFacts.getPolicyFacts).toHaveBeenCalledTimes(1);
          expect(forcedFacts.getPolicyFacts).not.toHaveBeenCalled();
          expect(policySign).toHaveBeenCalledTimes(1);
          expect(policySubmit).toHaveBeenCalledTimes(1);
          const persisted = await db
            .prepare(
              `SELECT id, build_id, idempotency_key, status, hash, usd_value, signed_by
                 FROM executions WHERE principal = ?`,
            )
            .bind(PRINCIPAL)
            .first<{
              id: string;
              build_id: string;
              idempotency_key: string;
              status: string;
              hash: string | null;
              usd_value: number | null;
              signed_by: string | null;
            }>();
          expect(persisted).toEqual({
            id: "mixed-mode-policy-policy-execution",
            build_id: build.id,
            idempotency_key: `${PRINCIPAL}:${idempotencyKey}`,
            status: "executed",
            hash: delegated.hash,
            usd_value: 10,
            signed_by: "delegate",
          });
          await expect(
            db
              .prepare("SELECT COUNT(*) AS count FROM approvals WHERE principal = ?")
              .bind(PRINCIPAL)
              .first<{ count: number }>(),
          ).resolves.toEqual({ count: 0 });
        }

        expect(forcedReserve).not.toHaveBeenCalled();
        expect(forcedSign).not.toHaveBeenCalled();
        expect(forcedSubmit).not.toHaveBeenCalled();
        const claims = await db
          .prepare(
            `SELECT id, detail FROM events
              WHERE principal = ? AND kind = 'execution_claim'`,
          )
          .bind(PRINCIPAL)
          .all<{ id: string; detail: string }>();
        expect(claims.results).toHaveLength(1);
        expect(claims.results[0]).toEqual({
          id: `execution-claim:mixed-mode-${firstMode}-${firstMode}-execution`,
          detail: JSON.stringify({
            build_id: build.id,
            execution_mode:
              firstMode === "forced" ? "require_owner_approval" : "policy",
          }),
        });
        const rows = await db
          .prepare("SELECT COUNT(*) AS count FROM executions WHERE principal = ?")
          .bind(PRINCIPAL)
          .first<{ count: number }>();
        expect(rows).toEqual({ count: 1 });
      } finally {
        db.close();
      }
    },
  );
});

describe("tx execution reservation regressions", () => {
  it.each([
    ["runtime", { HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true" }, false],
    [
      "onboarding",
      { HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE: "malformed" },
      true,
    ],
  ] as const)(
    "requires the exact principal/owner/Testnet policy before a %s execution claim",
    async (_profile, env, onboarding) => {
      const db = new SqliteD1();
      try {
        const build = buildRow(`missing-exact-policy-${_profile}`);
        build.originProfile = onboarding
          ? LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN
          : LOCAL_TRADING_BUILD_ORIGIN;
        if (onboarding) {
          build.txJson = {
            TransactionType: "TrustSet",
            Account: OWNER,
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
        await seedBuild(db, build);
        await seedLink(db);
        await db
          .prepare(
            `INSERT INTO policies (principal, owner, network, json, updated_at)
             VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
          )
          .bind(
            "other-principal",
            OWNER,
            "testnet",
            JSON.stringify(DEFAULT_POLICY),
            NOW,
            PRINCIPAL,
            DELEGATE,
            "testnet",
            JSON.stringify(DEFAULT_POLICY),
            NOW,
            PRINCIPAL,
            OWNER,
            "devnet",
            JSON.stringify(DEFAULT_POLICY),
            NOW,
          )
          .run();
        const policyFacts = facts();
        const reserveDailyBudget = vi.fn();
        const signDelegate = vi.fn();
        const submitSigned = vi.fn();
        const executeContext: OpContext = {
          ...context(db, {
            facts: policyFacts,
            reserveDailyBudget,
            signDelegate,
            submitSigned,
          }),
          env,
        };

        await expect(
          handleTxExecute(executeContext, {
            build_id: build.id,
            idempotency_key: `missing-exact-policy-${_profile}`,
          }),
        ).rejects.toThrow(/exact principal, owner, and network policy/i);

        expect(policyFacts.getPolicyFacts).not.toHaveBeenCalled();
        expect(reserveDailyBudget).not.toHaveBeenCalled();
        expect(signDelegate).not.toHaveBeenCalled();
        expect(submitSigned).not.toHaveBeenCalled();
        await expect(
          db
            .prepare("SELECT COUNT(*) AS count FROM executions")
            .first<{ count: number }>(),
        ).resolves.toEqual({ count: 0 });

        await db.batch([
          db
            .prepare(
              `INSERT INTO executions
                (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
               VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?)`,
            )
            .bind(
              `missing-exact-policy-${_profile}-execution`,
              PRINCIPAL,
              build.id,
              `${PRINCIPAL}:missing-exact-policy-${_profile}`,
              NOW,
            ),
          db
            .prepare(
              `INSERT INTO events (id, principal, owner, kind, detail, created_at)
               VALUES (?, ?, ?, 'execution_claim', ?, ?)`,
            )
            .bind(
              `execution-claim:missing-exact-policy-${_profile}-execution`,
              PRINCIPAL,
              OWNER,
              JSON.stringify({
                build_id: build.id,
                execution_mode: "policy",
              }),
              NOW,
            ),
        ]);
        if (onboarding) {
          await db
            .prepare(
              `INSERT INTO build_consumptions
                (principal, build_id, idempotency_key, status, claimed_at, consumed_at)
               VALUES (?, ?, ?, 'claimed', ?, NULL)`,
            )
            .bind(
              PRINCIPAL,
              build.id,
              `${PRINCIPAL}:missing-exact-policy-${_profile}`,
              NOW,
            )
            .run();
        }

        await expect(
          handleTxExecute(executeContext, {
            build_id: build.id,
            idempotency_key: `missing-exact-policy-${_profile}`,
          }),
        ).rejects.toThrow(/exact principal, owner, and network policy/i);
        expect(policyFacts.getPolicyFacts).not.toHaveBeenCalled();
        expect(reserveDailyBudget).not.toHaveBeenCalled();
        expect(signDelegate).not.toHaveBeenCalled();
        expect(submitSigned).not.toHaveBeenCalled();
        await expect(
          db
            .prepare("SELECT status FROM executions WHERE id = ?")
            .bind(`missing-exact-policy-${_profile}-execution`)
            .first<{ status: string }>(),
        ).resolves.toEqual({ status: "pending" });
      } finally {
        db.close();
      }
    },
  );

  it("executes with the intended exact Testnet policy under the local trading marker", async () => {
    const db = new SqliteD1();
    try {
      const build = buildRow("exact-local-policy-build");
      build.originProfile = LOCAL_TRADING_BUILD_ORIGIN;
      await seedBuild(db, build);
      await seedLink(db);
      await seedPolicy(db);
      const signer = Wallet.generate();
      const signed = signer.sign({
        TransactionType: "AccountSet",
        Account: signer.address,
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 200,
      });
      const policyFacts = facts();
      const signDelegate = vi.fn(async () => ({
        tx_blob: signed.tx_blob,
        hash: signed.hash,
      }));
      const submitSigned = vi.fn(async () => ({
        hash: signed.hash,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));
      const executeContext: OpContext = {
        ...context(db, {
          facts: policyFacts,
          signDelegate,
          submitSigned,
          now: () => new Date(NOW),
          randomUUID: () => "exact-local-policy-execution",
        }),
        env: { HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true" },
      };

      await expect(
        handleTxExecute(executeContext, {
          build_id: build.id,
          idempotency_key: "exact-local-policy",
        }),
      ).resolves.toEqual({
        status: "executed",
        hash: signed.hash,
        ledger_index: 198,
        result: "success",
        signed_by: "delegate",
        confirmation: {
          provider: "poll",
          at: NOW,
          latency_ms: 0,
        },
      });
      expect(policyFacts.getPolicyFacts).toHaveBeenCalledOnce();
      expect(signDelegate).toHaveBeenCalledOnce();
      expect(submitSigned).toHaveBeenCalledOnce();
      await expect(
        db
          .prepare(
            "SELECT created_at, confirmed_by, confirmed_at FROM executions WHERE id = ?",
          )
          .bind("exact-local-policy-execution")
          .first<{
            created_at: string;
            confirmed_by: string;
            confirmed_at: string;
          }>(),
      ).resolves.toEqual({
        created_at: NOW,
        confirmed_by: "poll",
        confirmed_at: NOW,
      });
      const resultEvent = await db
        .prepare("SELECT detail FROM events WHERE id = ?")
        .bind("execution-result:exact-local-policy-execution")
        .first<{ detail: string }>();
      expect(JSON.parse(resultEvent?.detail ?? "null")).toMatchObject({
        result: {
          status: "executed",
          confirmation: {
            provider: "poll",
            at: NOW,
            latency_ms: 0,
          },
        },
      });
    } finally {
      db.close();
    }
  });

  it("rejects fresh and replayed non-testnet builds under any local trading marker", async () => {
    const db = new SqliteD1();
    try {
      const build = buildRow("local-trading-mainnet-build");
      build.network = "mainnet";
      await seedBuild(db, build);
      const signDelegate = vi.fn();
      const submitSigned = vi.fn();
      const executeContext: OpContext = {
        ...context(db, { signDelegate, submitSigned }),
        env: { HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "false" },
      };
      const args = {
        build_id: build.id,
        idempotency_key: "local-trading-mainnet",
      };

      await expect(handleTxExecute(executeContext, args)).rejects.toThrow(
        /only testnet state/i,
      );
      await db
        .prepare(
          `INSERT INTO executions
            (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
           VALUES (?, ?, ?, ?, 'failed', NULL, 0, NULL, ?)`,
        )
        .bind(
          "local-trading-mainnet-existing",
          PRINCIPAL,
          build.id,
          `${PRINCIPAL}:${args.idempotency_key}`,
          NOW,
        )
        .run();
      await expect(handleTxExecute(executeContext, args)).rejects.toThrow(
        /only testnet state/i,
      );
      expect(signDelegate).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM executions WHERE principal = ?")
          .bind(PRINCIPAL)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("rejects fresh and replayed onboarding execution until the exact Testnet link is active", async () => {
    const db = new SqliteD1();
    try {
      const build = buildRow("onboarding-pending-link-build");
      build.originProfile = LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN;
      build.txJson = {
        TransactionType: "TrustSet",
        Account: OWNER,
        LimitAmount: {
          currency: "RLUSD",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
          value: "100",
        },
        Fee: "12",
        Sequence: 7,
        LastLedgerSequence: 200,
      };
      await seedBuild(db, build);
      await seedLink(db, "pending");
      const signDelegate = vi.fn();
      const submitSigned = vi.fn();
      const executeContext: OpContext = {
        ...context(db, { signDelegate, submitSigned }),
        env: { HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true" },
      };
      const args = {
        build_id: build.id,
        idempotency_key: "onboarding-pending-link",
      };

      await expect(handleTxExecute(executeContext, args)).rejects.toThrow(
        /requires an active account link/i,
      );
      await expect(
        db.prepare("SELECT COUNT(*) AS count FROM executions").first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });

      await db
        .prepare(
          `INSERT INTO executions
            (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
           VALUES (?, ?, ?, ?, 'failed', NULL, 0, NULL, ?)`,
        )
        .bind(
          "onboarding-pending-link-existing",
          PRINCIPAL,
          build.id,
          `${PRINCIPAL}:${args.idempotency_key}`,
          NOW,
        )
        .run();
      await db
        .prepare(
          `INSERT INTO build_consumptions
            (principal, build_id, idempotency_key, status, claimed_at, consumed_at)
           VALUES (?, ?, ?, 'consumed', ?, ?)`,
        )
        .bind(
          PRINCIPAL,
          build.id,
          `${PRINCIPAL}:${args.idempotency_key}`,
          NOW,
          NOW,
        )
        .run();
      await expect(handleTxExecute(executeContext, args)).rejects.toThrow(
        /requires an active account link/i,
      );
      expect(signDelegate).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(
        db.prepare("SELECT status FROM executions WHERE id = ?")
          .bind("onboarding-pending-link-existing")
          .first<{ status: string }>(),
      ).resolves.toEqual({ status: "failed" });
    } finally {
      db.close();
    }
  });

  it("rejects a non-TrustSet durable build under onboarding before claim or replay", async () => {
    const db = new SqliteD1();
    try {
      const build = buildRow("onboarding-wrong-type-build");
      build.originProfile = LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN;
      await seedBuild(db, build);
      await seedLink(db, "active");
      const executeContext: OpContext = {
        ...context(db, { signDelegate: vi.fn(), submitSigned: vi.fn() }),
        env: { HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE: "malformed" },
      };
      await expect(handleTxExecute(executeContext, {
        build_id: build.id,
        idempotency_key: "onboarding-wrong-type",
      })).rejects.toThrow(/only TrustSet builds/i);
      await expect(
        db.prepare("SELECT COUNT(*) AS count FROM executions").first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("rejects a non-testnet approval build before replay, claim, or submission", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPendingApproval(db, "local-trading-mainnet-approval");
      await db
        .prepare("UPDATE builds SET network = 'mainnet' WHERE id = ?")
        .bind(fixture.buildId)
        .run();
      const submitApproval = vi.fn();
      const submitSigned = vi.fn();
      const approvalContext: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        env: { HARBOR_LOCAL_TRADING_SIGNING_PROFILE: "malformed" },
        executionServices: {
          now: () => new Date(NOW),
          submitApproval,
          submitSigned,
        } satisfies ExecutionServices,
      };

      await expect(
        handleTxSubmit(approvalContext, {
          approval_id: fixture.approvalId,
          tx_blob: fixture.signed.tx_blob,
        }),
      ).rejects.toThrow(/only testnet state/i);
      expect(submitApproval).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(
        db
          .prepare("SELECT status FROM approvals WHERE id = ?")
          .bind(fixture.approvalId)
          .first<{ status: string }>(),
      ).resolves.toEqual({ status: "pending" });
    } finally {
      db.close();
    }
  });

  it("requires the exact policy before a terminal approval replay under a local trading marker", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPendingApproval(
        db,
        "local-policy-terminal-replay",
        "AccountSet",
        LOCAL_TRADING_BUILD_ORIGIN,
      );
      const submitApproval = vi.fn(async () => ({
        hash: fixture.signed.hash,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));
      const submitSigned = vi.fn();
      const services = {
        now: () => new Date(NOW),
        submitApproval,
        submitSigned,
      } satisfies ExecutionServices;
      await handleTxSubmit(
        {
          principal: PRINCIPAL,
          db: asD1(db),
          executionServices: services,
        },
        {
          approval_id: fixture.approvalId,
          tx_blob: fixture.signed.tx_blob,
        },
      );
      await db
        .prepare(
          "DELETE FROM policies WHERE principal = ? AND owner = ? AND network = 'testnet'",
        )
        .bind(PRINCIPAL, fixture.owner)
        .run();
      submitApproval.mockClear();
      const before = await db
        .prepare(
          `SELECT a.status AS approval_status, e.status AS execution_status,
                  e.hash, e.signed_by
             FROM approvals AS a
             JOIN executions AS e
               ON e.principal = a.principal
              AND e.id = substr(a.id, 1, instr(a.id, '.') - 1)
            WHERE a.principal = ? AND a.id = ?`,
        )
        .bind(PRINCIPAL, fixture.approvalId)
        .first();

      await expect(
        handleTxSubmit(
          {
            principal: PRINCIPAL,
            db: asD1(db),
            env: { HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true" },
            executionServices: services,
          },
          {
            approval_id: fixture.approvalId,
            tx_blob: fixture.signed.tx_blob,
          },
        ),
      ).rejects.toThrow(/exact principal, owner, and network policy/i);

      expect(submitApproval).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(
        db
          .prepare(
            `SELECT a.status AS approval_status, e.status AS execution_status,
                    e.hash, e.signed_by
               FROM approvals AS a
               JOIN executions AS e
                 ON e.principal = a.principal
                AND e.id = substr(a.id, 1, instr(a.id, '.') - 1)
              WHERE a.principal = ? AND a.id = ?`,
          )
          .bind(PRINCIPAL, fixture.approvalId)
          .first(),
      ).resolves.toEqual(before);
    } finally {
      db.close();
    }
  });

  it("rejects a non-TrustSet onboarding approval before replay, mutation, or submission", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPendingApproval(
        db,
        "onboarding-account-set-approval",
        "AccountSet",
        LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
      );
      await seedLink(db, "active", fixture.owner);
      const submitApproval = vi.fn();
      const submitSigned = vi.fn();
      const before = await db
        .prepare(
          `SELECT a.status AS approval_status, e.status AS execution_status,
                  e.hash, e.signed_by
             FROM approvals AS a
             JOIN executions AS e
               ON e.principal = a.principal
              AND e.id = substr(a.id, 1, instr(a.id, '.') - 1)
            WHERE a.principal = ? AND a.id = ?`,
        )
        .bind(PRINCIPAL, fixture.approvalId)
        .first();

      await expect(
        handleTxSubmit(
          {
            principal: PRINCIPAL,
            db: asD1(db),
            env: {
              HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
            },
            executionServices: {
              now: () => new Date(NOW),
              submitApproval,
              submitSigned,
            } satisfies ExecutionServices,
          },
          {
            approval_id: fixture.approvalId,
            tx_blob: fixture.signed.tx_blob,
          },
        ),
      ).rejects.toThrow(/only TrustSet builds/i);

      expect(submitApproval).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(
        db
          .prepare(
            `SELECT a.status AS approval_status, e.status AS execution_status,
                    e.hash, e.signed_by
               FROM approvals AS a
               JOIN executions AS e
                 ON e.principal = a.principal
                AND e.id = substr(a.id, 1, instr(a.id, '.') - 1)
              WHERE a.principal = ? AND a.id = ?`,
          )
          .bind(PRINCIPAL, fixture.approvalId)
          .first(),
      ).resolves.toEqual(before);
    } finally {
      db.close();
    }
  });

  it("submits a TrustSet onboarding approval with the exact active Testnet link and policy", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPendingApproval(
        db,
        "onboarding-trust-set-approval",
        "TrustSet",
        LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
      );
      await seedLink(db, "active", fixture.owner);
      const submitApproval = vi.fn(async () => ({
        hash: fixture.signed.hash,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));
      const submitSigned = vi.fn();

      await expect(
        handleTxSubmit(
          {
            principal: PRINCIPAL,
            db: asD1(db),
            env: {
              HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
            },
            executionServices: {
              now: () => new Date(NOW),
              submitApproval,
              submitSigned,
            } satisfies ExecutionServices,
          },
          {
            approval_id: fixture.approvalId,
            tx_blob: fixture.signed.tx_blob,
          },
        ),
      ).resolves.toEqual({
        hash: fixture.signed.hash,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true,
      });
      expect(submitApproval).toHaveBeenCalledOnce();
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(
        db
          .prepare(
            `SELECT a.status AS approval_status, e.status AS execution_status,
                    e.hash, e.signed_by
               FROM approvals AS a
               JOIN executions AS e
                 ON e.principal = a.principal
                AND e.id = substr(a.id, 1, instr(a.id, '.') - 1)
              WHERE a.principal = ? AND a.id = ?`,
          )
          .bind(PRINCIPAL, fixture.approvalId)
          .first(),
      ).resolves.toEqual({
        approval_status: "approved",
        execution_status: "executed",
        hash: fixture.signed.hash,
        signed_by: "owner",
      });
    } finally {
      db.close();
    }
  });

  it("rejects a stored non-testnet status route before its ledger request", async () => {
    const db = new SqliteD1();
    try {
      const hash = "D".repeat(64);
      const build = buildRow("local-trading-mainnet-status-build");
      build.network = "mainnet";
      await seedBuild(db, build);
      await db
        .prepare(
          `INSERT INTO executions
            (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
           VALUES (?, ?, ?, ?, 'submitted', ?, 0, 'owner', ?)`,
        )
        .bind(
          "local-trading-mainnet-status",
          PRINCIPAL,
          build.id,
          `${PRINCIPAL}:local-trading-mainnet-status`,
          hash,
          NOW,
        )
        .run();
      const status = vi.fn();

      await expect(
        handleTxStatus(
          {
            principal: PRINCIPAL,
            db: asD1(db),
            env: { HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "disabled" },
            executionServices: { status },
          },
          { hash },
        ),
      ).rejects.toThrow(/only testnet state/i);
      expect(status).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("atomically consumes an onboarding TrustSet once while replaying only the winning idempotency key", async () => {
    const db = new SqliteD1();
    try {
      const build = buildRow("onboarding-one-shot-build");
      build.originProfile = LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN;
      build.txJson = {
        TransactionType: "TrustSet",
        Account: OWNER,
        LimitAmount: {
          currency: "RLUSD",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
          value: "100",
        },
        Fee: "12",
        Sequence: 7,
        LastLedgerSequence: 200,
      };
      await seedBuild(db, build);
      await seedLink(db);
      await db
        .prepare("UPDATE links SET permissions = ? WHERE principal = ? AND id = ?")
        .bind(JSON.stringify(["TrustSet"]), PRINCIPAL, `link-${OWNER}`)
        .run();
      await seedPolicy(db);

      let nextId = 0;
      const executeContext: OpContext = {
        ...context(db, {
          facts: {
            getPolicyFacts: vi.fn(async () => ({
              usdValue: "10",
              issuerFacts: [
                {
                  currency: "RLUSD",
                  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
                  requireAuth: false,
                },
              ],
            })),
          },
          signDelegate: vi.fn(),
          submitSigned: vi.fn(),
          now: () => new Date(NOW),
          randomUUID: () => `onboarding-one-shot-${++nextId}`,
        }),
        env: { HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true" },
      };
      const request = (key: string) =>
        handleTxExecute(executeContext, {
          build_id: build.id,
          idempotency_key: key,
          require_owner_approval: true,
        });

      const raced = await Promise.allSettled([request("intent-a"), request("intent-b")]);
      const winnerIndex = raced.findIndex((result) => result.status === "fulfilled");
      const loserIndex = raced.findIndex((result) => result.status === "rejected");
      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      expect(loserIndex).toBeGreaterThanOrEqual(0);
      const winner = raced[winnerIndex] as PromiseFulfilledResult<Awaited<ReturnType<typeof request>>>;
      const loser = raced[loserIndex] as PromiseRejectedResult;
      expect(winner.value.status).toBe("needs_approval");
      expect(String(loser.reason)).toMatch(/different idempotency key/i);

      const winningKey = winnerIndex === 0 ? "intent-a" : "intent-b";
      const losingKey = winnerIndex === 0 ? "intent-b" : "intent-a";
      await expect(request(winningKey)).resolves.toEqual(winner.value);
      await expect(request(losingKey)).rejects.toThrow(/different idempotency key/i);

      await expect(
        db
          .prepare(
            `SELECT idempotency_key, status, consumed_at
               FROM build_consumptions
              WHERE principal = ? AND build_id = ?`,
          )
          .bind(PRINCIPAL, build.id)
          .first(),
      ).resolves.toEqual({
        idempotency_key: `${PRINCIPAL}:${winningKey}`,
        status: "consumed",
        consumed_at: "trigger-time",
      });
      await expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM executions WHERE principal = ? AND build_id = ?")
          .bind(PRINCIPAL, build.id)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 1 });
      await expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM approvals WHERE principal = ? AND build_id = ?")
          .bind(PRINCIPAL, build.id)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("fails closed when legacy or onboarding builds cross the local runtime handoff", async () => {
    const db = new SqliteD1();
    try {
      const legacy = buildRow("legacy-local-build");
      await seedBuild(db, legacy);
      await seedLink(db);
      await seedPolicy(db);
      const noSideEffects = {
        facts: facts(),
        signDelegate: vi.fn(),
        submitSigned: vi.fn(),
      } satisfies ExecutionServices;

      await expect(
        handleTxExecute(
          {
            ...context(db, noSideEffects),
            env: { HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true" },
          },
          { build_id: legacy.id, idempotency_key: "legacy-trading" },
        ),
      ).rejects.toThrow(/created by the trading profile/i);
      await expect(
        handleTxExecute(
          {
            ...context(db, noSideEffects),
            env: { HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true" },
          },
          { build_id: legacy.id, idempotency_key: "legacy-onboarding" },
        ),
      ).rejects.toThrow(/created by the onboarding profile/i);

      const fixture = await seedPendingApproval(
        db,
        "onboarding-handoff",
        "TrustSet",
        LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
      );
      await seedLink(db, "active", fixture.owner);
      const statusHash = fixture.signed.hash.toUpperCase();
      await db
        .prepare(
          `UPDATE executions
              SET status = 'submitted', hash = ?, signed_by = 'owner'
            WHERE principal = ? AND id = ?`,
        )
        .bind(statusHash, PRINCIPAL, fixture.executionId)
        .run();
      const submitApproval = vi.fn();
      const submitSigned = vi.fn();
      const status = vi.fn();
      const tradingContext: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        env: { HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true" },
        executionServices: { submitApproval, submitSigned, status },
      };

      await expect(
        handleTxExecute(tradingContext, {
          build_id: fixture.buildId,
          idempotency_key: fixture.idempotencyKey,
        }),
      ).rejects.toThrow(/created by the trading profile/i);
      await expect(
        handleTxSubmit(tradingContext, {
          approval_id: fixture.approvalId,
          tx_blob: fixture.signed.tx_blob,
        }),
      ).rejects.toThrow(/created by the trading profile/i);
      await expect(
        handleTxStatus(tradingContext, { hash: statusHash }),
      ).rejects.toThrow(/created by the trading profile/i);
      expect(submitApproval).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("rejects direct DelegateSet submission from the trading profile before binding or submission", async () => {
    const db = new SqliteD1();
    try {
      const fixture = directDelegateSetFixture();
      await seedLink(db, "active", fixture.owner);
      const submitSigned = vi.fn();
      const ctx: OpContext = {
        principal: PRINCIPAL,
        localDevRequest: true,
        db: asD1(db),
        env: REVIEWED_TRADING_ENV,
        executionServices: { submitSigned },
      };

      await expect(
        handleTxSubmit(ctx, {
          tx_blob: fixture.signed.tx_blob,
          network: "testnet",
        }),
      ).rejects.toThrow(/only in the reviewed local trading onboarding profile/i);
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(
        db.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
      await expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM direct_submission_bindings")
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("binds onboarding direct submission provenance and rejects it after the trading handoff", async () => {
    const db = new SqliteD1();
    try {
      const fixture = directDelegateSetFixture();
      await seedLink(db, "pending", fixture.owner);
      const submitSigned = vi.fn(async () => ({
        hash: fixture.signed.hash,
        ledger_index: 101,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));
      const onboardingStatus = vi.fn(async () => ({
        hash: fixture.signed.hash,
        network: "testnet" as const,
        validated: true,
        ledger_index: 101,
        engine_result: "tesSUCCESS",
      }));
      const onboardingContext: OpContext = {
        principal: PRINCIPAL,
        localDevRequest: true,
        db: asD1(db),
        xrplRpc: xrplRpc({ accountOwner: fixture.owner }),
        env: REVIEWED_ONBOARDING_ENV,
        executionServices: { submitSigned, status: onboardingStatus },
      };

      await expect(
        handleTxSubmit(onboardingContext, {
          tx_blob: fixture.signed.tx_blob,
          network: "testnet",
        }),
      ).resolves.toMatchObject({ hash: fixture.signed.hash, validated: true });
      await expect(
        db
          .prepare(
            `SELECT owner, network, origin_profile
               FROM direct_submission_bindings
              WHERE principal = ? AND hash = ?`,
          )
          .bind(PRINCIPAL, fixture.signed.hash)
          .first(),
      ).resolves.toEqual({
        owner: fixture.owner,
        network: "testnet",
        origin_profile: LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
      });
      await expect(
        handleTxStatus(onboardingContext, { hash: fixture.signed.hash }),
      ).resolves.toMatchObject({ hash: fixture.signed.hash, validated: true });
      expect(onboardingStatus).toHaveBeenCalledTimes(1);

      const tradingStatus = vi.fn();
      const tradingContext: OpContext = {
        principal: PRINCIPAL,
        localDevRequest: true,
        db: asD1(db),
        env: REVIEWED_TRADING_ENV,
        executionServices: { status: tradingStatus },
      };
      await expect(
        handleTxStatus(tradingContext, { hash: fixture.signed.hash }),
      ).rejects.toThrow(/does not match the active local profile/i);
      expect(tradingStatus).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("rejects legacy and null-origin direct bindings in every local profile", async () => {
    const db = new SqliteD1();
    try {
      const fixture = directDelegateSetFixture();
      await seedLink(db, "pending", fixture.owner);
      const legacyHash = "A".repeat(64);
      const nullOriginHash = "B".repeat(64);
      for (const hash of [legacyHash, nullOriginHash]) {
        await db
          .prepare(
            `INSERT INTO events (id, principal, owner, kind, detail, created_at)
             VALUES (?, ?, ?, 'direct_owner_submission', ?, ?)`,
          )
          .bind(
            `direct-owner-submit:${PRINCIPAL}:${hash}`,
            PRINCIPAL,
            fixture.owner,
            JSON.stringify({ hash, network: "testnet" }),
            NOW,
          )
          .run();
      }
      await db
        .prepare(
          `INSERT INTO direct_submission_bindings
            (principal, hash, owner, network, origin_profile, created_at)
           VALUES (?, ?, ?, 'testnet', NULL, ?)`,
        )
        .bind(PRINCIPAL, nullOriginHash, fixture.owner, NOW)
        .run();

      for (const env of [REVIEWED_ONBOARDING_ENV, REVIEWED_TRADING_ENV]) {
        const status = vi.fn();
        const ctx: OpContext = {
          principal: PRINCIPAL,
          localDevRequest: true,
          db: asD1(db),
          env,
          executionServices: { status },
        };
        await expect(handleTxStatus(ctx, { hash: legacyHash })).rejects.toThrow(
          /does not match the active local profile/i,
        );
        await expect(
          handleTxStatus(ctx, { hash: nullOriginHash }),
        ).rejects.toThrow(/does not match the active local profile/i);
        expect(status).not.toHaveBeenCalled();
      }
    } finally {
      db.close();
    }
  });

  it.each([
    ["onboarding", REVIEWED_ONBOARDING_ENV],
    ["trading", REVIEWED_TRADING_ENV],
  ] as const)(
    "rejects an unbound transaction status in the reviewed local %s profile before status I/O",
    async (_profile, env) => {
      const db = new SqliteD1();
      try {
        const status = vi.fn();
        const ctx: OpContext = {
          principal: PRINCIPAL,
          localDevRequest: true,
          db: asD1(db),
          env,
          executionServices: { status },
        };

        await expect(
          handleTxStatus(ctx, { hash: "C".repeat(64) }),
        ).rejects.toThrow(/profile-matching authenticated submission/i);
        expect(status).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    },
  );

  it("preserves arbitrary unbound status reads outside local trading safety profiles", async () => {
    const db = new SqliteD1();
    try {
      const hash = "C".repeat(64);
      const expected = {
        hash,
        network: "testnet" as const,
        validated: false,
      };
      const status = vi.fn(async () => expected);

      await expect(
        handleTxStatus(
          {
            principal: PRINCIPAL,
            db: asD1(db),
            executionServices: { status },
          },
          { hash },
        ),
      ).resolves.toEqual(expected);
      expect(status).toHaveBeenCalledWith(
        expect.objectContaining({ principal: PRINCIPAL }),
        "testnet",
        hash,
      );
    } finally {
      db.close();
    }
  });

  it("returns stable typed expiry through REST before blob validation and never submits", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPendingApproval(db, "expired-rest");
      const submitApproval = vi.fn();
      const submitSigned = vi.fn();
      const ctx: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        executionServices: {
          now: () => new Date("2026-10-18T10:10:00.001Z"),
          submitApproval,
          submitSigned,
        } satisfies ExecutionServices,
      };
      const registry = new OpRegistry(txOps);
      const invoke = () => handleRestOperation(
        new Request("https://harbor.test/api/ops/tx.submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // This passes the public hex schema but cannot decode as a signed XRPL
          // transaction. The expiry result therefore proves ordering.
          body: JSON.stringify({
            approval_id: fixture.approvalId,
            tx_blob: "00",
          }),
        }),
        "tx.submit",
        ctx,
        registry,
      );
      const expected = {
        ok: false,
        error: {
          service: "tx.submit",
          kind: "error",
          message: "Approval expired",
          code: "APPROVAL_EXPIRED",
        },
      };

      const first = await invoke();
      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toEqual(expected);
      const second = await invoke();
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toEqual(expected);

      expect(submitApproval).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(
        db.prepare("SELECT status FROM approvals WHERE id = ?")
          .bind(fixture.approvalId)
          .first<{ status: string }>(),
      ).resolves.toEqual({ status: "expired" });
    } finally {
      db.close();
    }
  });

  it("does not expire an approval concurrently claimed by a valid owner submission", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPendingApproval(db, "expiry-claim-race");
      const expiryBuildEntered = deferred<void>();
      const releaseExpiryBuild = deferred<void>();
      const expiryPolicyEntered = deferred<void>();
      const releaseExpiryPolicy = deferred<void>();
      const validSubmitEntered = deferred<void>();
      const releaseValidSubmit = deferred<void>();
      const validated = {
        hash: fixture.signed.hash,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true as const,
      };
      const validSubmitApproval = vi.fn(async () => {
        validSubmitEntered.resolve();
        await releaseValidSubmit.promise;
        return validated;
      });
      const validSubmitSigned = vi.fn();
      const expirySubmitApproval = vi.fn();
      const expirySubmitSigned = vi.fn();
      const expiryStatus = vi.fn(async () => {
        throw new Error("expiry loser must terminal-replay without status I/O");
      });
      const expiryStore = storeWithGatedBuildRead(
        db,
        expiryBuildEntered,
        releaseExpiryBuild,
      );
      const getExpiryPolicy = expiryStore.getPolicy.bind(expiryStore);
      const expiryPolicy = vi
        .spyOn(expiryStore, "getPolicy")
        .mockImplementation(async (owner, network) => {
          expiryPolicyEntered.resolve();
          await releaseExpiryPolicy.promise;
          return getExpiryPolicy(owner, network);
        });
      const validContext: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        executionServices: {
          now: () => new Date(NOW),
          submitApproval: validSubmitApproval,
          submitSigned: validSubmitSigned,
        } satisfies ExecutionServices,
      };
      const expiryContext: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        executionServices: {
          store: expiryStore,
          now: () => new Date("2026-10-18T10:10:00.001Z"),
          submitApproval: expirySubmitApproval,
          submitSigned: expirySubmitSigned,
          status: expiryStatus,
        } satisfies ExecutionServices,
      };
      const args = {
        approval_id: fixture.approvalId,
        tx_blob: fixture.signed.tx_blob,
      };

      const expiryAttempt = handleTxSubmit(expiryContext, args);
      await expiryBuildEntered.promise;
      const validAttempt = handleTxSubmit(validContext, args);
      await validSubmitEntered.promise;

      releaseExpiryBuild.resolve();
      await expiryPolicyEntered.promise;
      releaseValidSubmit.resolve();
      await expect(validAttempt).resolves.toEqual(validated);
      releaseExpiryPolicy.resolve();
      await expect(expiryAttempt).resolves.toEqual(validated);
      await expect(handleTxSubmit(expiryContext, args)).resolves.toEqual(
        validated,
      );
      await expect(handleTxSubmit(validContext, args)).resolves.toEqual(
        validated,
      );
      await expect(
        handleTxExecute(
          {
            principal: PRINCIPAL,
            db: asD1(db),
            executionServices: { status: expiryStatus },
          },
          {
            build_id: fixture.buildId,
            idempotency_key: "expiry-claim-race-request",
          },
        ),
      ).resolves.toEqual({
        status: "executed",
        hash: fixture.signed.hash,
        ledger_index: 198,
        result: "success",
        signed_by: "owner",
      });

      expect(validSubmitApproval).toHaveBeenCalledTimes(1);
      expect(expirySubmitApproval).not.toHaveBeenCalled();
      expect(validSubmitSigned).not.toHaveBeenCalled();
      expect(expirySubmitSigned).not.toHaveBeenCalled();
      expect(expiryPolicy).toHaveBeenCalledTimes(1);
      expect(expiryStatus).not.toHaveBeenCalled();
      const persisted = await db
        .prepare(
          `SELECT a.status AS approval_status, e.status AS execution_status,
                  e.hash, e.signed_by, ev.kind, ev.detail
             FROM approvals AS a
             JOIN executions AS e
               ON e.principal = a.principal
              AND e.id = substr(a.id, 1, instr(a.id, '.') - 1)
             JOIN events AS ev
               ON ev.principal = e.principal
              AND ev.id = 'execution-result:' || e.id
            WHERE a.principal = ? AND a.id = ?`,
        )
        .bind(PRINCIPAL, fixture.approvalId)
        .first<{
          approval_status: string;
          execution_status: string;
          hash: string | null;
          signed_by: string | null;
          kind: string;
          detail: string;
        }>();
      expect(persisted).toMatchObject({
        approval_status: "approved",
        execution_status: "executed",
        hash: fixture.signed.hash,
        signed_by: "owner",
        kind: "execution_result",
      });
      expect(JSON.parse(persisted?.detail ?? "null")).toEqual({
        result: {
          status: "executed",
          hash: fixture.signed.hash,
          ledger_index: 198,
          result: "success",
          signed_by: "owner",
        },
      });
      await expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM approvals WHERE principal = ? AND status = 'expired'",
          )
          .bind(PRINCIPAL)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("fails closed on a validated status response for a different transaction hash", async () => {
    const db = new SqliteD1();
    try {
      const requestedHash = "A".repeat(64);
      const request = vi.fn(async (_network: string, command: string) => {
        expect(command).toBe("tx");
        return {
          hash: "B".repeat(64),
          validated: true,
          ledger_index: 101,
          meta: { TransactionResult: "tesSUCCESS" },
        };
      });

      await expect(
        handleTxStatus(
          { principal: PRINCIPAL, db: asD1(db), xrplRpc: { request } },
          { hash: requestedHash },
        ),
      ).rejects.toThrow(/mismatched hash/i);
    } finally {
      db.close();
    }
  });

  it("releases an owner account sequence lease on matching validated tx.status evidence", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedSubmittedOwnerWithSequenceLease(
        db,
        "owner-status-validated",
      );
      const status = vi.fn(async () => ({
        hash: fixture.hash,
        network: "testnet" as const,
        validated: true as const,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
      }));

      await expect(handleTxStatus({
        principal: PRINCIPAL,
        db: asD1(db),
        executionServices: { status },
      }, { hash: fixture.hash })).resolves.toMatchObject({
        hash: fixture.hash,
        validated: true,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
      });

      const lease = await db.prepare(`SELECT state, release_evidence
        FROM account_sequence_leases WHERE network = 'testnet' AND account = ?`)
        .bind(fixture.owner)
        .first<{ state: string; release_evidence: string }>();
      expect(lease?.state).toBe("released");
      expect(JSON.parse(lease?.release_evidence ?? "null")).toEqual({
        kind: "validated_terminal",
        hash: fixture.hash,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
      });
      await expect(db.prepare(`SELECT a.status AS approval_status,
          e.status AS execution_status
        FROM approvals AS a JOIN executions AS e
          ON e.principal = a.principal AND e.id = ?
        WHERE a.id = ?`).bind(fixture.executionId, fixture.approvalId)
        .first()).resolves.toEqual({
          approval_status: "approved",
          execution_status: "executed",
        });
    } finally {
      db.close();
    }
  });

  it("releases an owner account sequence lease only after exhaustive full-window absence", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedSubmittedOwnerWithSequenceLease(
        db,
        "owner-status-absent",
      );
      const status = vi.fn(async () => ({
        hash: fixture.hash,
        network: "testnet" as const,
        validated: false as const,
      }));
      const request = vi.fn(async (_network: string, command: string, params: unknown) => {
        if (command === "ledger") {
          return { validated: true, ledger_index: 201 };
        }
        if (command === "tx") {
          expect(params).toEqual({
            transaction: fixture.hash,
            binary: false,
            min_ledger: 197,
            max_ledger: 200,
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
        throw new Error(`unexpected command ${command}`);
      });

      await expect(handleTxStatus({
        principal: PRINCIPAL,
        db: asD1(db),
        xrplRpc: { request },
        executionServices: { status },
      }, { hash: fixture.hash })).resolves.toEqual({
        hash: fixture.hash,
        network: "testnet",
        validated: false,
      });

      const lease = await db.prepare(`SELECT state, release_evidence
        FROM account_sequence_leases WHERE network = 'testnet' AND account = ?`)
        .bind(fixture.owner)
        .first<{ state: string; release_evidence: string }>();
      expect(lease?.state).toBe("released");
      expect(JSON.parse(lease?.release_evidence ?? "null")).toEqual({
        kind: "expired_absent",
        hash: fixture.hash,
        validated_head: 201,
        checked_from: 197,
        checked_through: 200,
        searched_all: true,
      });
      await expect(db.prepare(`SELECT a.status AS approval_status,
          e.status AS execution_status
        FROM approvals AS a JOIN executions AS e
          ON e.principal = a.principal AND e.id = ?
        WHERE a.id = ?`).bind(fixture.executionId, fixture.approvalId)
        .first()).resolves.toEqual({
          approval_status: "rejected",
          execution_status: "failed",
        });
    } finally {
      db.close();
    }
  });

  it("reconciles an owner approval only after head advancement and an exact bounded inclusion lookup", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPendingApproval(db, "owner-range-race");
      const hash = fixture.signed.hash.toUpperCase();
      await db
        .prepare(
          "UPDATE executions SET status = 'submitted', hash = ?, signed_by = 'owner' WHERE id = ?",
        )
        .bind(hash, fixture.executionId)
        .run();
      await db
        .prepare("UPDATE approvals SET status = 'submitted' WHERE id = ?")
        .bind(fixture.approvalId)
        .run();

      const order: string[] = [];
      const status = vi.fn(async () => {
        order.push("status");
        return { hash, network: "testnet" as const, validated: false };
      });
      const request = vi.fn(async (_network: string, command: string, params: unknown) => {
        if (command === "ledger") {
          order.push("head");
          return { validated: true, ledger_index: 201 };
        }
        if (command === "tx") {
          order.push("range");
          expect(params).toEqual({
            transaction: hash,
            binary: false,
            min_ledger: 197,
            max_ledger: 200,
            api_version: 1,
          });
          return {
            validated: true,
            hash,
            ledger_index: 200,
            meta: { TransactionResult: "tesSUCCESS" },
          };
        }
        throw new Error(`unexpected command ${command}`);
      });
      const submitApproval = vi.fn();
      const submitSigned = vi.fn();
      const ctx: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        xrplRpc: { request },
        executionServices: { status, submitApproval, submitSigned },
      };

      await expect(
        handleTxExecute(ctx, {
          build_id: fixture.buildId,
          idempotency_key: fixture.idempotencyKey,
        }),
      ).resolves.toEqual({
        status: "executed",
        hash,
        ledger_index: 200,
        result: "success",
        signed_by: "owner",
      });
      expect(order).toEqual(["status", "head", "range"]);
      expect(submitApproval).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("lets exact final-ledger inclusion win during delegated idempotent replay without signing or resubmitting", async () => {
    const db = new SqliteD1();
    try {
      const hash = "D".repeat(64);
      const build = await seedSubmittedDelegated(
        db,
        "delegated-range-race",
        hash,
      );
      const order: string[] = [];
      const status = vi.fn(async () => {
        order.push("status");
        return { hash, network: "testnet" as const, validated: false };
      });
      const request = vi.fn(async (_network: string, command: string) => {
        if (command === "ledger") {
          order.push("head");
          return { validated: true, ledger_index: 201 };
        }
        if (command === "tx") {
          order.push("range");
          return {
            validated: true,
            hash,
            ledger_index: 200,
            meta: { TransactionResult: "tesSUCCESS" },
          };
        }
        throw new Error(`unexpected command ${command}`);
      });
      const signDelegate = vi.fn();
      const submitSigned = vi.fn();
      const ctx: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        xrplRpc: { request },
        executionServices: {
          status,
          signDelegate,
          submitSigned,
          now: () => new Date(NOW),
        },
      };

      await expect(
        handleTxExecute(ctx, {
          build_id: build.id,
          idempotency_key: "delegated-range-race",
        }),
      ).resolves.toEqual({
        status: "executed",
        hash,
        ledger_index: 200,
        result: "success",
        signed_by: "delegate",
        confirmation: {
          provider: "poll",
          at: NOW,
          latency_ms: 0,
        },
      });
      expect(order).toEqual(["status", "head", "range"]);
      expect(signDelegate).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(
        db
          .prepare(
            "SELECT confirmed_by, confirmed_at FROM executions WHERE id = ?",
          )
          .bind("delegated-range-race-execution")
          .first<{ confirmed_by: string; confirmed_at: string }>(),
      ).resolves.toEqual({ confirmed_by: "poll", confirmed_at: NOW });
    } finally {
      db.close();
    }
  });

  it.each([
    ["complete", true, "failed"],
    ["incomplete", false, "submitted"],
    ["missing", undefined, "submitted"],
  ] as const)(
    "terminalizes a tx.status absence only for a %s searched_all proof",
    async (_name, searchedAll, expectedStatus) => {
      const db = new SqliteD1();
      try {
        const hash = "E".repeat(64);
        await seedSubmittedDelegated(db, `status-absence-${_name}`, hash);
        const order: string[] = [];
        const status = vi.fn(async () => {
          order.push("status");
          return { hash, network: "testnet" as const, validated: false };
        });
        const request = vi.fn(async (_network: string, command: string) => {
          if (command === "ledger") {
            order.push("head");
            return { validated: true, ledger_index: 201 };
          }
          if (command === "tx") {
            order.push("range");
            throw new XrplRpcError(
              "transaction not found",
              "transactionNotFound",
              "soft-empty",
              false,
              searchedAll,
            );
          }
          throw new Error(`unexpected command ${command}`);
        });
        const ctx: OpContext = {
          principal: PRINCIPAL,
          db: asD1(db),
          xrplRpc: { request },
          executionServices: { status },
        };

        await expect(handleTxStatus(ctx, { hash })).resolves.toEqual({
          hash,
          network: "testnet",
          validated: false,
        });
        expect(order).toEqual(["status", "head", "range"]);
        const execution = await db
          .prepare("SELECT status FROM executions WHERE hash = ?")
          .bind(hash)
          .first<{ status: string }>();
        expect(execution).toEqual({ status: expectedStatus });
      } finally {
        db.close();
      }
    },
  );

  it("keeps submitted state for malformed, partial, unvalidated, or out-of-window range evidence", async () => {
    const cases = [
      {
        name: "unvalidated",
        response: (hash: string) => ({
          validated: false,
          hash,
          ledger_index: 200,
          meta: { TransactionResult: "tesSUCCESS" },
        }),
      },
      {
        name: "partial",
        response: (hash: string) => ({
          validated: true,
          hash,
          ledger_index: 200,
        }),
      },
      {
        name: "mismatched",
        response: () => ({
          validated: true,
          hash: "F".repeat(64),
          ledger_index: 200,
          meta: { TransactionResult: "tesSUCCESS" },
        }),
      },
      {
        name: "out-of-window",
        response: (hash: string) => ({
          validated: true,
          hash,
          ledger_index: 195,
          meta: { TransactionResult: "tesSUCCESS" },
        }),
      },
      {
        name: "invalid-result",
        response: (hash: string) => ({
          validated: true,
          hash,
          ledger_index: 200,
          meta: { TransactionResult: "" },
        }),
      },
    ];

    for (const fixture of cases) {
      const db = new SqliteD1();
      try {
        const hash = "A".repeat(63) + String(cases.indexOf(fixture));
        await seedSubmittedDelegated(db, `range-${fixture.name}`, hash);
        const request = vi.fn(async (_network: string, command: string) => {
          if (command === "ledger") {
            return { validated: true, ledger_index: 201 };
          }
          if (command === "tx") return fixture.response(hash);
          throw new Error(`unexpected command ${command}`);
        });
        const ctx: OpContext = {
          principal: PRINCIPAL,
          db: asD1(db),
          xrplRpc: { request },
          executionServices: {
            status: vi.fn(async () => ({
              hash,
              network: "testnet" as const,
              validated: false,
            })),
          },
        };

        await handleTxStatus(ctx, { hash });
        await expect(
          db
            .prepare("SELECT status FROM executions WHERE hash = ?")
            .bind(hash)
            .first<{ status: string }>(),
        ).resolves.toEqual({ status: "submitted" });
      } finally {
        db.close();
      }
    }
  });

  it("keeps submitted state when the durable LastLedgerSequence fields disagree", async () => {
    const db = new SqliteD1();
    try {
      const hash = "B".repeat(64);
      await seedSubmittedDelegated(db, "changed-window", hash, (build) => {
        build.txJson.LastLedgerSequence = 199;
      });
      const request = vi.fn();
      const ctx: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        xrplRpc: { request },
        executionServices: {
          status: vi.fn(async () => ({
            hash,
            network: "testnet" as const,
            validated: false,
          })),
        },
      };

      await handleTxStatus(ctx, { hash });
      expect(request).not.toHaveBeenCalled();
      await expect(
        db
          .prepare("SELECT status FROM executions WHERE hash = ?")
          .bind(hash)
          .first<{ status: string }>(),
      ).resolves.toEqual({ status: "submitted" });
    } finally {
      db.close();
    }
  });

  it.each([
    ["out-of-window", 196, "tesSUCCESS"],
    ["invalid-result", 200, ""],
  ] as const)(
    "rejects %s validated status evidence without terminalizing",
    async (name, ledgerIndex, engineResult) => {
      const db = new SqliteD1();
      try {
        const hash = "C".repeat(64);
        await seedSubmittedDelegated(db, `status-${name}`, hash);
        const request = vi.fn();
        const ctx: OpContext = {
          principal: PRINCIPAL,
          db: asD1(db),
          xrplRpc: { request },
          executionServices: {
            status: vi.fn(async () => ({
              hash,
              network: "testnet" as const,
              validated: true,
              ledger_index: ledgerIndex,
              engine_result: engineResult,
            })),
          },
        };

        await expect(handleTxStatus(ctx, { hash })).rejects.toThrow(
          /validated transaction status is incomplete/i,
        );
        expect(request).not.toHaveBeenCalled();
        await expect(
          db
            .prepare("SELECT status FROM executions WHERE hash = ?")
            .bind(hash)
            .first<{ status: string }>(),
        ).resolves.toEqual({ status: "submitted" });
      } finally {
        db.close();
      }
    },
  );

  it("fails closed when a stored execution has no matching build", async () => {
    const db = new SqliteD1();
    try {
      const hash = "C".repeat(64);
      await db
        .prepare(
          `INSERT INTO executions
            (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
           VALUES (?, ?, ?, ?, 'submitted', ?, 0, 'owner', ?)`,
        )
        .bind(
          "missing-build-execution",
          PRINCIPAL,
          "missing-build",
          `${PRINCIPAL}:missing-build`,
          hash,
          NOW,
        )
        .run();
      const request = vi.fn();

      await expect(
        handleTxStatus(
          { principal: PRINCIPAL, db: asD1(db), xrplRpc: { request } },
          { hash },
        ),
      ).rejects.toThrow(/execution build not found/i);
      expect(request).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("atomically admits only one concurrent daily-budget reservation and identifies its replay", async () => {
    const db = new SqliteD1();
    try {
      const firstBuild = buildRow("build-race-a");
      const secondBuild = buildRow("build-race-b");
      await seedLink(db);
      await seedBuild(db, firstBuild);
      await seedBuild(db, secondBuild);

      const inputs = [firstBuild, secondBuild].map((build, index) => ({
        db: asD1(db),
        principal: PRINCIPAL,
        executionId: `execution-race-${index}`,
        build,
        idempotencyKey: `${PRINCIPAL}:race-${index}`,
        usdValue: 60,
        dailyCapUsd: 100,
        createdAt: NOW,
      }));
      const results = await Promise.all(
        inputs.map((input) => reserveDailyBudgetAtomic(input)),
      );

      expect(results.slice().sort()).toEqual(["busy", "reserved"]);
      const winner = results.indexOf("reserved");
      expect(
        await reserveDailyBudgetAtomic({
          ...inputs[winner],
          executionId: "execution-race-replay",
        }),
      ).toBe("duplicate");
      const rows = await db
        .prepare(
          "SELECT id, status, usd_value FROM executions ORDER BY id",
        )
        .all<{ id: string; status: string; usd_value: number }>();
      expect(rows.results).toEqual([
        {
          id: inputs[winner].executionId,
          status: "pending",
          usd_value: 60,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it.each(["reserved", "committed"] as const)(
    "counts %s AP4M spend before admitting an ordinary reservation",
    async (status) => {
      const db = new SqliteD1();
      try {
        const build = buildRow(`build-after-ap4m-${status}`);
        await seedLink(db);
        await seedBuild(db, build);
        await seedAp4mSpend(db, { amountUsd: 60, status });

        await expect(reserveDailyBudgetAtomic({
          db: asD1(db),
          principal: PRINCIPAL,
          executionId: `execution-after-ap4m-${status}`,
          build,
          idempotencyKey: `${PRINCIPAL}:after-ap4m-${status}`,
          usdValue: 60,
          dailyCapUsd: 100,
          createdAt: NOW,
        })).resolves.toBe("over-cap");
        await expect(db.prepare("SELECT COUNT(*) AS count FROM executions").first())
          .resolves.toEqual({ count: 0 });
      } finally {
        db.close();
      }
    },
  );

  it("ignores released AP4M spend when admitting an ordinary reservation", async () => {
    const db = new SqliteD1();
    try {
      const build = buildRow("build-after-released-ap4m");
      await seedLink(db);
      await seedBuild(db, build);
      await seedAp4mSpend(db, { amountUsd: 60, status: "released" });

      await expect(reserveDailyBudgetAtomic({
        db: asD1(db),
        principal: PRINCIPAL,
        executionId: "execution-after-released-ap4m",
        build,
        idempotencyKey: `${PRINCIPAL}:after-released-ap4m`,
        usdValue: 60,
        dailyCapUsd: 100,
        createdAt: NOW,
      })).resolves.toBe("reserved");
    } finally {
      db.close();
    }
  });

  it("atomically admits only one cross-path reservation under the shared daily cap", async () => {
    const db = new SqliteD1();
    try {
      const build = buildRow("build-cross-path-race");
      await seedLink(db);
      await seedBuild(db, build);
      const ap4mStore = await prepareAp4mCapReservation(db, "cross-path-race");

      const [ordinary, ap4m] = await Promise.all([
        reserveDailyBudgetAtomic({
          db: asD1(db),
          principal: PRINCIPAL,
          executionId: "execution-cross-path-race",
          build,
          idempotencyKey: `${PRINCIPAL}:cross-path-race`,
          usdValue: 60,
          dailyCapUsd: 100,
          createdAt: NOW,
        }),
        reserveAp4mCap(ap4mStore, "cross-path-race"),
      ]);

      expect([
        ordinary === "reserved",
        ap4m.outcome === "reserved",
      ].filter(Boolean)).toHaveLength(1);
      expect([
        ordinary === "over-cap" || ordinary === "busy",
        ap4m.outcome === "spend-limit",
      ].filter(Boolean)).toHaveLength(1);
      const ordinaryTotal = await db
        .prepare("SELECT COALESCE(SUM(usd_value), 0) AS total FROM executions WHERE usd_value IS NOT NULL")
        .first<{ total: number }>();
      const ap4mTotal = await db
        .prepare("SELECT COALESCE(SUM(amount_microusd), 0) AS total FROM ap4m_spend WHERE status IN ('reserved', 'committed')")
        .first<{ total: number }>();
      expect((ordinaryTotal?.total ?? 0) + (ap4mTotal?.total ?? 0) / 1_000_000)
        .toBe(60);
    } finally {
      db.close();
    }
  });

  it("replays the first persisted result for an idempotency key without reevaluating another build", async () => {
    const db = new SqliteD1();
    try {
      await seedBuild(db, buildRow("build-original"));
      const firstResult: ExecResult = {
        status: "failed",
        engine_result: "tefMAX_LEDGER",
        detail: "first result",
      };
      await db
        .prepare(
          `INSERT INTO executions
            (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
           VALUES ('execution-original', ?, 'build-original', ?, 'failed', NULL, 10, 'delegate', ?)`,
        )
        .bind(PRINCIPAL, `${PRINCIPAL}:same-request`, NOW)
        .run();
      await db
        .prepare(
          `INSERT INTO events (id, principal, owner, kind, detail, created_at)
           VALUES ('execution-result:execution-original', ?, ?, 'execution_result', ?, ?)`,
        )
        .bind(PRINCIPAL, OWNER, JSON.stringify({ result: firstResult }), NOW)
        .run();

      const [one, two] = await Promise.all([
        handleTxExecute(
          { principal: PRINCIPAL, db: asD1(db) },
          { build_id: "does-not-exist", idempotency_key: "same-request" },
        ),
        handleTxExecute(
          { principal: PRINCIPAL, db: asD1(db) },
          { build_id: "another-build", idempotency_key: "same-request" },
        ),
      ]);
      expect(one).toEqual(firstResult);
      expect(two).toEqual(firstResult);
    } finally {
      db.close();
    }
  });

  it("replays a concurrent terminal winner when stale neutral-claim failure loses its batch race", async () => {
    const db = new SqliteD1();
    try {
      const build = buildRow("stale-neutral-winner-build");
      const executionId = "stale-neutral-winner-execution";
      const approvalId = `${executionId}.approval`;
      const idempotencyKey = "stale-neutral-winner";
      const claimDetail = {
        build_id: build.id,
        execution_mode: "require_owner_approval",
      };
      const winner: ExecResult = {
        status: "needs_approval",
        approval_id: approvalId,
        tx_json: build.txJson,
        expires_at: "2026-10-18T10:10:00.000Z",
        policy: { verdict: "needs_approval", reasons: [] },
      };
      await seedBuild(db, build);
      await db
        .prepare(
          `INSERT INTO executions
            (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
           VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, '2026-10-18T09:40:00.000Z')`,
        )
        .bind(
          executionId,
          PRINCIPAL,
          build.id,
          `${PRINCIPAL}:${idempotencyKey}`,
        )
        .run();
      await db
        .prepare(
          `INSERT INTO events (id, principal, owner, kind, detail, created_at)
           VALUES (?, ?, ?, 'execution_claim', ?, '2026-10-18T09:40:00.000Z')`,
        )
        .bind(
          `execution-claim:${executionId}`,
          PRINCIPAL,
          OWNER,
          JSON.stringify(claimDetail),
        )
        .run();

      const staleBatchEntered = deferred<void>();
      const releaseStaleBatch = deferred<void>();
      const runBatch = db.batch.bind(db);
      let interceptedStaleBatch = false;
      const batch = vi.spyOn(db, "batch").mockImplementation(async (statements) => {
        if (!interceptedStaleBatch) {
          interceptedStaleBatch = true;
          staleBatchEntered.resolve();
          await releaseStaleBatch.promise;
        }
        return runBatch(statements);
      });
      const replay = handleTxExecute(
        context(db, { now: () => new Date(NOW) }),
        {
          build_id: build.id,
          idempotency_key: idempotencyKey,
          require_owner_approval: true,
        },
      );
      await staleBatchEntered.promise;

      await db.batch([
        db
          .prepare(
            `UPDATE executions
                SET status = 'needs_approval', usd_value = 10
              WHERE principal = ? AND id = ? AND status = 'pending'
                AND hash IS NULL AND usd_value IS NULL AND signed_by IS NULL`,
          )
          .bind(PRINCIPAL, executionId),
        db
          .prepare(
            `INSERT INTO approvals (id, principal, build_id, tx_json, expires_at, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
          )
          .bind(
            approvalId,
            PRINCIPAL,
            build.id,
            JSON.stringify(build.txJson),
            winner.expires_at,
          ),
        db
          .prepare(
            `INSERT INTO events (id, principal, owner, kind, detail, created_at)
             VALUES (?, ?, ?, 'execution_result', ?, ?)`,
          )
          .bind(
            `execution-result:${executionId}`,
            PRINCIPAL,
            OWNER,
            JSON.stringify({ result: winner }),
            NOW,
          ),
      ]);
      releaseStaleBatch.resolve();

      await expect(replay).resolves.toEqual(winner);
      expect(batch).toHaveBeenCalledTimes(2);
      const persisted = await db
        .prepare(
          `SELECT e.status, e.hash, e.usd_value, e.signed_by,
                  a.status AS approval_status, claim.detail AS claim_detail,
                  result.detail AS result_detail
             FROM executions AS e
             JOIN approvals AS a
               ON a.principal = e.principal AND a.id = ?
             JOIN events AS claim
               ON claim.principal = e.principal
              AND claim.id = 'execution-claim:' || e.id
             JOIN events AS result
               ON result.principal = e.principal
              AND result.id = 'execution-result:' || e.id
            WHERE e.principal = ? AND e.id = ?`,
        )
        .bind(approvalId, PRINCIPAL, executionId)
        .first<{
          status: string;
          hash: string | null;
          usd_value: number | null;
          signed_by: string | null;
          approval_status: string;
          claim_detail: string;
          result_detail: string;
        }>();
      expect(persisted).toEqual({
        status: "needs_approval",
        hash: null,
        usd_value: 10,
        signed_by: null,
        approval_status: "pending",
        claim_detail: JSON.stringify(claimDetail),
        result_detail: JSON.stringify({ result: winner }),
      });
      expect(persisted?.result_detail).not.toContain("EXECUTION_INTERRUPTED");
    } finally {
      db.close();
    }
  });

  it.each(["revoked", "missing"] as const)(
    "%s delegation never reaches the delegate signer",
    async (linkState) => {
      const db = new SqliteD1();
      try {
        await seedBuild(db, buildRow(`build-${linkState}`));
        await seedPolicy(db);
        if (linkState === "revoked") await seedLink(db, "revoked");
        const signDelegate = vi.fn();
        let id = 0;
        const result = await handleTxExecute(
          context(db, {
            facts: facts(),
            signDelegate,
            now: () => new Date(NOW),
            randomUUID: () => `${linkState}-${++id}`,
          }),
          {
            build_id: `build-${linkState}`,
            idempotency_key: `${linkState}-request`,
          },
        );

        expect(result.status).toBe(
          linkState === "revoked" ? "needs_approval" : "blocked",
        );
        expect(signDelegate).not.toHaveBeenCalled();
        const delegated = await db
          .prepare(
            "SELECT id FROM executions WHERE signed_by = 'delegate' OR status IN ('pending', 'submitted')",
          )
          .all();
        expect(delegated.results).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  it("blocks an already-frozen link before delegated signing", async () => {
    const db = new SqliteD1();
    try {
      await seedBuild(db, buildRow("build-link-frozen"));
      await seedPolicy(db);
      await seedLink(db);
      await db
        .prepare(
          "UPDATE links SET frozen_at = ?, frozen_reason = ? WHERE principal = ? AND owner = ? AND network = 'testnet'",
        )
        .bind(NOW, "quicknode:watchdog-test", PRINCIPAL, OWNER)
        .run();
      const signDelegate = vi.fn();
      const submitSigned = vi.fn();

      const result = await handleTxExecute(
        context(db, {
          facts: facts(),
          signDelegate,
          submitSigned,
          now: () => new Date(NOW),
          randomUUID: () => "execution-link-frozen",
        }),
        {
          build_id: "build-link-frozen",
          idempotency_key: "link-frozen",
        },
      );

      expect(result).toMatchObject({ status: "blocked" });
      expect(result.status === "blocked" ? result.policy.reasons : []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "link_frozen", pass: false }),
        ]),
      );
      expect(signDelegate).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(
        db
          .prepare("SELECT status, hash, signed_by FROM executions WHERE id = ?")
          .bind("execution-link-frozen")
          .first<{ status: string; hash: string | null; signed_by: string | null }>(),
      ).resolves.toEqual({ status: "blocked", hash: null, signed_by: null });
    } finally {
      db.close();
    }
  });

  it("persists the delegated hash but never submits when the link freezes during signing", async () => {
    const db = new SqliteD1();
    try {
      await seedBuild(db, buildRow("build-link-freeze-race"));
      await seedPolicy(db);
      await seedLink(db);
      const wallet = Wallet.generate();
      const signed = wallet.sign({
        TransactionType: "AccountSet",
        Account: wallet.address,
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 200,
      });
      const signDelegate = vi.fn(async () => {
        await db
          .prepare(
            "UPDATE links SET frozen_at = ?, frozen_reason = ? WHERE principal = ? AND owner = ? AND network = 'testnet'",
          )
          .bind(NOW, "quicknode:watchdog-race", PRINCIPAL, OWNER)
          .run();
        return { tx_blob: signed.tx_blob, hash: signed.hash };
      });
      const submitSigned = vi.fn();

      const result = await handleTxExecute(
        context(db, {
          facts: facts(),
          signDelegate,
          submitSigned,
          now: () => new Date(NOW),
          randomUUID: () => "execution-link-freeze-race",
        }),
        {
          build_id: "build-link-freeze-race",
          idempotency_key: "link-freeze-race",
        },
      );

      expect(result).toMatchObject({
        status: "failed",
        engine_result: "SUBMISSION_PENDING",
      });
      expect(signDelegate).toHaveBeenCalledOnce();
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(
        db
          .prepare("SELECT status, hash, signed_by FROM executions WHERE id = ?")
          .bind("execution-link-freeze-race")
          .first<{ status: string; hash: string; signed_by: string }>(),
      ).resolves.toEqual({
        status: "submitted",
        hash: signed.hash.toUpperCase(),
        signed_by: "delegate",
      });
      await expect(db.prepare(`SELECT state, tx_hash FROM account_sequence_leases
        WHERE network = 'testnet' AND account = ?`).bind(OWNER)
        .first<{ state: string; tx_hash: string }>()).resolves.toEqual({
          state: "ambiguous",
          tx_hash: signed.hash.toUpperCase(),
        });
    } finally {
      db.close();
    }
  });

  it("preserves delegated signing and submission for an unfrozen link", async () => {
    const db = new SqliteD1();
    try {
      await seedBuild(db, buildRow("build-link-unfrozen"));
      await seedPolicy(db);
      await seedLink(db);
      const wallet = Wallet.generate();
      const signed = wallet.sign({
        TransactionType: "AccountSet",
        Account: wallet.address,
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 200,
      });
      const signDelegate = vi.fn(async () => ({
        tx_blob: signed.tx_blob,
        hash: signed.hash,
      }));
      const submitSigned = vi.fn(async () => ({
        hash: signed.hash,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));

      await expect(
        handleTxExecute(
          context(db, {
            facts: facts(),
            signDelegate,
            submitSigned,
            now: () => new Date(NOW),
            randomUUID: () => "execution-link-unfrozen",
          }),
          {
            build_id: "build-link-unfrozen",
            idempotency_key: "link-unfrozen",
          },
        ),
      ).resolves.toMatchObject({
        status: "executed",
        hash: signed.hash.toUpperCase(),
        signed_by: "delegate",
      });
      expect(signDelegate).toHaveBeenCalledOnce();
      expect(submitSigned).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it("does not submit a signature after another request takes terminal ownership of the reservation", async () => {
    const db = new SqliteD1();
    try {
      await seedBuild(db, buildRow("build-cas"));
      await seedPolicy(db);
      await seedLink(db);
      const enteredSigner = deferred<void>();
      const signed = deferred<{ tx_blob: string; hash: string }>();
      const submitSigned = vi.fn();
      const fixtureWallet = Wallet.generate();
      const fixtureSigned = fixtureWallet.sign({
        TransactionType: "AccountSet",
        Account: fixtureWallet.address,
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 200,
      });
      const execution = handleTxExecute(
        context(db, {
          facts: facts(),
          signDelegate: vi.fn(async () => {
            enteredSigner.resolve();
            return signed.promise;
          }),
          submitSigned,
          now: () => new Date(NOW),
          randomUUID: () => "execution-cas",
        }),
        { build_id: "build-cas", idempotency_key: "cas-request" },
      );

      await enteredSigner.promise;
      const interrupted: ExecResult = {
        status: "failed",
        engine_result: "EXECUTION_INTERRUPTED",
        detail: "reservation owner stopped",
      };
      await db
        .prepare(
          "UPDATE executions SET status = 'failed' WHERE principal = ? AND id = ? AND status = 'pending'",
        )
        .bind(PRINCIPAL, "execution-cas")
        .run();
      await db
        .prepare(
          `INSERT INTO events (id, principal, owner, kind, detail, created_at)
           VALUES (?, ?, ?, 'execution_result', ?, ?)`,
        )
        .bind(
          "execution-result:execution-cas",
          PRINCIPAL,
          OWNER,
          JSON.stringify({ result: interrupted }),
          NOW,
        )
        .run();
      signed.resolve({
        tx_blob: fixtureSigned.tx_blob,
        hash: fixtureSigned.hash,
      });

      await expect(execution).resolves.toEqual(interrupted);
      expect(submitSigned).not.toHaveBeenCalled();
      const row = await db
        .prepare("SELECT status, hash FROM executions WHERE id = ?")
        .bind("execution-cas")
        .first<{ status: string; hash: string | null }>();
      expect(row).toEqual({ status: "failed", hash: null });
    } finally {
      db.close();
    }
  });

  it("reevaluates daily spend for the new UTC day after policy facts cross midnight", async () => {
    const db = new SqliteD1();
    try {
      const beforeMidnight = "2026-10-17T23:59:59.900Z";
      const afterMidnight = "2026-10-18T00:00:00.100Z";
      const priorBuild = buildRow("prior-day-spend-build");
      const currentBuild = buildRow("new-day-evaluation-build");
      await seedBuild(db, priorBuild);
      await seedBuild(db, currentBuild);
      await seedPolicy(db, OWNER, 100);
      await seedLink(db);
      await db
        .prepare(
          `INSERT INTO executions
            (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
           VALUES ('prior-day-spend', ?, ?, ?, 'executed', ?, 90, 'delegate',
                   '2026-10-17T23:59:30.000Z')`,
        )
        .bind(
          PRINCIPAL,
          priorBuild.id,
          `${PRINCIPAL}:prior-day-spend`,
          "A".repeat(64),
        )
        .run();

      const enteredFacts = deferred<void>();
      const releaseFacts = deferred<void>();
      const policyFacts = {
        getPolicyFacts: vi.fn(async () => {
          enteredFacts.resolve();
          await releaseFacts.promise;
          return { usdValue: "60", issuerFacts: [] };
        }),
      };
      const signerWallet = Wallet.generate();
      const signed = signerWallet.sign({
        TransactionType: "AccountSet",
        Account: signerWallet.address,
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 200,
      });
      const signDelegate = vi.fn(async () => ({
        tx_blob: signed.tx_blob,
        hash: signed.hash,
      }));
      const submitSigned = vi.fn(async () => ({
        hash: signed.hash,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));
      const store = new Store(asD1(db), PRINCIPAL);
      const readDailyUsdTotal = store.dailyUsdTotal.bind(store);
      const observedDailyTotals: number[] = [];
      const dailyUsdTotal = vi
        .spyOn(store, "dailyUsdTotal")
        .mockImplementation(async (owner, network, since) => {
          const total = since === undefined
            ? 90
            : await readDailyUsdTotal(owner, network, since);
          observedDailyTotals.push(total);
          return total;
        });
      let crossedMidnight = false;
      const execution = handleTxExecute(
        context(db, {
          store,
          facts: policyFacts,
          signDelegate,
          submitSigned,
          now: () =>
            new Date(crossedMidnight ? afterMidnight : beforeMidnight),
          randomUUID: () => "new-day-evaluation-execution",
        }),
        {
          build_id: currentBuild.id,
          idempotency_key: "new-day-evaluation",
        },
      );

      await enteredFacts.promise;
      crossedMidnight = true;
      releaseFacts.resolve();

      await expect(execution).resolves.toEqual({
        status: "executed",
        hash: signed.hash,
        ledger_index: 198,
        result: "success",
        signed_by: "delegate",
        confirmation: {
          provider: "poll",
          at: afterMidnight,
          latency_ms: 0,
        },
      });
      expect(dailyUsdTotal.mock.calls).toEqual([
        [OWNER, "testnet"],
        [OWNER, "testnet", "2026-10-18T00:00:00.000Z"],
      ]);
      expect(observedDailyTotals).toEqual([90, 0]);
      expect(signDelegate).toHaveBeenCalledTimes(1);
      expect(submitSigned).toHaveBeenCalledTimes(1);
      const currentExecution = await db
        .prepare(
          `SELECT status, usd_value, signed_by, created_at
             FROM executions WHERE id = ?`,
        )
        .bind("new-day-evaluation-execution")
        .first<{
          status: string;
          usd_value: number;
          signed_by: string;
          created_at: string;
        }>();
      expect(currentExecution).toEqual({
        status: "executed",
        usd_value: 60,
        signed_by: "delegate",
        created_at: afterMidnight,
      });
      const totals = await db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN created_at < '2026-10-18T00:00:00.000Z'
                               THEN usd_value ELSE 0 END), 0) AS prior_day,
             COALESCE(SUM(CASE WHEN created_at >= '2026-10-18T00:00:00.000Z'
                               THEN usd_value ELSE 0 END), 0) AS current_day
             FROM executions WHERE principal = ? AND status = 'executed'`,
        )
        .bind(PRINCIPAL)
        .first<{ prior_day: number; current_day: number }>();
      expect(totals).toEqual({ prior_day: 90, current_day: 60 });
    } finally {
      db.close();
    }
  });

  it("charges a delegated reservation to the UTC day when policy gathering crosses midnight", async () => {
    const db = new SqliteD1();
    try {
      const beforeMidnight = "2026-10-17T23:59:59.900Z";
      const afterMidnight = "2026-10-18T00:00:00.100Z";
      const firstBuild = buildRow("delegated-midnight-first");
      const secondBuild = buildRow("delegated-midnight-second");
      await seedBuild(db, firstBuild);
      await seedBuild(db, secondBuild);
      await seedPolicy(db, OWNER, 100);
      await seedLink(db);

      const enteredFirstFacts = deferred<void>();
      const releaseFirstFacts = deferred<void>();
      let factsCall = 0;
      const policyFacts = {
        getPolicyFacts: vi.fn(async () => {
          factsCall += 1;
          if (factsCall === 1) {
            enteredFirstFacts.resolve();
            await releaseFirstFacts.promise;
            return { usdValue: "60", issuerFacts: [] };
          }
          return { usdValue: "50", issuerFacts: [] };
        }),
      };
      const signerWallet = Wallet.generate();
      const signed = signerWallet.sign({
        TransactionType: "AccountSet",
        Account: signerWallet.address,
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 200,
      });
      const signDelegate = vi.fn(async () => ({
        tx_blob: signed.tx_blob,
        hash: signed.hash,
      }));
      const submitSigned = vi.fn(async () => ({
        hash: signed.hash,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));
      let crossedMidnight = false;
      const ids = ["delegated-midnight-execution-1", "delegated-midnight-execution-2"];
      const executeContext = context(db, {
        facts: policyFacts,
        signDelegate,
        submitSigned,
        now: () =>
          new Date(crossedMidnight ? afterMidnight : beforeMidnight),
        randomUUID: () => ids.shift()!,
      });

      const first = handleTxExecute(executeContext, {
        build_id: firstBuild.id,
        idempotency_key: "delegated-midnight-first",
      });
      await enteredFirstFacts.promise;
      const preReservation = await db
        .prepare(
          `SELECT e.status, e.created_at, claim.created_at AS claim_created_at
             FROM executions AS e
             JOIN events AS claim
               ON claim.principal = e.principal
              AND claim.id = 'execution-claim:' || e.id
            WHERE e.id = ?`,
        )
        .bind("delegated-midnight-execution-1")
        .first<{
          status: string;
          created_at: string;
          claim_created_at: string;
        }>();
      expect(preReservation).toEqual({
        status: "pending",
        created_at: beforeMidnight,
        claim_created_at: beforeMidnight,
      });

      crossedMidnight = true;
      releaseFirstFacts.resolve();
      await expect(first).resolves.toEqual({
        status: "executed",
        hash: signed.hash,
        ledger_index: 198,
        result: "success",
        signed_by: "delegate",
        confirmation: {
          provider: "poll",
          at: afterMidnight,
          latency_ms: 0,
        },
      });

      const reserved = await db
        .prepare(
          `SELECT e.status, e.usd_value, e.signed_by, e.created_at,
                  claim.created_at AS claim_created_at
             FROM executions AS e
             JOIN events AS claim
               ON claim.principal = e.principal
              AND claim.id = 'execution-claim:' || e.id
            WHERE e.id = ?`,
        )
        .bind("delegated-midnight-execution-1")
        .first<{
          status: string;
          usd_value: number;
          signed_by: string;
          created_at: string;
          claim_created_at: string;
        }>();
      expect(reserved).toEqual({
        status: "executed",
        usd_value: 60,
        signed_by: "delegate",
        created_at: afterMidnight,
        claim_created_at: beforeMidnight,
      });

      await expect(
        handleTxExecute(executeContext, {
          build_id: secondBuild.id,
          idempotency_key: "delegated-midnight-second",
        }),
      ).resolves.toMatchObject({
        status: "blocked",
        policy: {
          verdict: "block",
          reasons: expect.arrayContaining([
            expect.objectContaining({ rule: "daily_cap_usd", pass: false }),
          ]),
        },
      });
      expect(policyFacts.getPolicyFacts).toHaveBeenCalledTimes(2);
      expect(signDelegate).toHaveBeenCalledTimes(1);
      expect(submitSigned).toHaveBeenCalledTimes(1);
      const currentDaySpend = await db
        .prepare(
          `SELECT COALESCE(SUM(usd_value), 0) AS total
             FROM executions
            WHERE principal = ? AND created_at >= '2026-10-18T00:00:00.000Z'
              AND status IN ('pending', 'submitted', 'executed')`,
        )
        .bind(PRINCIPAL)
        .first<{ total: number }>();
      expect(currentDaySpend).toEqual({ total: 60 });
    } finally {
      db.close();
    }
  });

  it("charges an approval claimed after midnight to the current UTC day and keeps a second approval fail-closed", async () => {
    const db = new SqliteD1();
    try {
      const wallet = Wallet.generate();
      const owner = wallet.address;
      await seedPolicy(db, owner, 100);
      const submissions = [1, 2].map((sequence) => {
        const transaction: AccountSet = {
          TransactionType: "AccountSet",
          Account: owner,
          Fee: "12",
          Sequence: sequence,
          LastLedgerSequence: 200,
        };
        return { transaction, signed: wallet.sign(transaction) };
      });
      for (let index = 0; index < submissions.length; index += 1) {
        const executionId = `midnight-execution-${index}`;
        const build = buildRow(`midnight-build-${index}`, owner);
        build.txJson = submissions[index].transaction;
        build.lastLedgerSeq = 200;
        await seedBuild(db, build);
        await db
          .prepare(
            `INSERT INTO executions
              (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
             VALUES (?, ?, ?, ?, 'needs_approval', NULL, 60, NULL, ?)`,
          )
          .bind(
            executionId,
            PRINCIPAL,
            build.id,
            `${PRINCIPAL}:midnight-${index}`,
            YESTERDAY,
          )
          .run();
        await db
          .prepare(
            `INSERT INTO approvals (id, principal, build_id, tx_json, expires_at, status)
             VALUES (?, ?, ?, ?, '2026-10-18T10:10:00.000Z', 'pending')`,
          )
          .bind(
            `${executionId}.approval`,
            PRINCIPAL,
            build.id,
            JSON.stringify(submissions[index].transaction),
          )
          .run();
        await db
          .prepare(
            `INSERT INTO events (id, principal, owner, kind, detail, created_at)
             VALUES (?, ?, ?, 'execution_result', ?, ?)`,
          )
          .bind(
            `execution-result:${executionId}`,
            PRINCIPAL,
            owner,
            JSON.stringify({
              result: {
                status: "needs_approval",
                approval_id: `${executionId}.approval`,
                tx_json: submissions[index].transaction,
                expires_at: "2026-10-18T10:10:00.000Z",
                policy: {
                  verdict: "needs_approval",
                  reasons: [],
                },
              },
            }),
            YESTERDAY,
          )
          .run();
      }

      const firstSubmitEntered = deferred<void>();
      const releaseFirstSubmit = deferred<void>();
      const services: ExecutionServices = {
        now: () => new Date(NOW),
        status: vi.fn(async (_ctx, network, hash) => ({
          network,
          hash,
          validated: false,
        })),
        submitApproval: vi.fn(async ({ txBlob }) => {
          firstSubmitEntered.resolve();
          await releaseFirstSubmit.promise;
          return {
            hash: submissions[0].signed.hash,
            ledger_index: 198,
            engine_result: "tesSUCCESS",
            validated: true,
          };
        }),
        submitSigned: vi.fn(),
      };
      const approvalContext: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        executionServices: services,
      };
      const first = handleTxSubmit(approvalContext, {
        approval_id: "midnight-execution-0.approval",
        tx_blob: submissions[0].signed.tx_blob,
      });
      await firstSubmitEntered.promise;
      await expect(
        handleTxSubmit(approvalContext, {
          approval_id: "midnight-execution-1.approval",
          tx_blob: submissions[1].signed.tx_blob,
        }),
      ).rejects.toThrow(/cap|slot|available/i);
      releaseFirstSubmit.resolve();
      await expect(first).resolves.toMatchObject({ validated: true });

      const firstExecution = await db
        .prepare("SELECT status, created_at FROM executions WHERE id = ?")
        .bind("midnight-execution-0")
        .first<{ status: string; created_at: string }>();
      expect(firstExecution).toEqual({ status: "executed", created_at: NOW });
      await expect(
        handleTxSubmit(approvalContext, {
          approval_id: "midnight-execution-1.approval",
          tx_blob: submissions[1].signed.tx_blob,
        }),
      ).rejects.toThrow(/cap|slot|available/i);
    } finally {
      db.close();
    }
  });

  it("replays an approved owner terminal result after response loss without resubmitting", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPendingApproval(db, "approved-replay");
      const submitApproval = vi.fn(async () => ({
        hash: fixture.signed.hash,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));
      const submitSigned = vi.fn();
      const approvalContext: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        executionServices: {
          now: () => new Date(NOW),
          submitApproval,
          submitSigned,
        } satisfies ExecutionServices,
      };

      await handleTxSubmit(approvalContext, {
        approval_id: fixture.approvalId,
        tx_blob: fixture.signed.tx_blob,
      });
      const executeReplay = await handleTxExecute(approvalContext, {
        build_id: fixture.buildId,
        idempotency_key: fixture.idempotencyKey,
      });
      expect(executeReplay).toEqual({
        status: "executed",
        hash: fixture.signed.hash,
        ledger_index: 198,
        result: "success",
        signed_by: "owner",
      });

      await expect(
        handleTxSubmit(approvalContext, {
          approval_id: fixture.approvalId,
          tx_blob: fixture.signed.tx_blob,
        }),
      ).resolves.toEqual({
        hash: fixture.signed.hash,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true,
      });
      expect(submitApproval).toHaveBeenCalledTimes(1);
      expect(submitSigned).not.toHaveBeenCalled();
      await expect(
        db
          .prepare(
            "SELECT confirmed_by, confirmed_at FROM executions WHERE id = ?",
          )
          .bind(fixture.executionId)
          .first<{
            confirmed_by: string | null;
            confirmed_at: string | null;
          }>(),
      ).resolves.toEqual({ confirmed_by: null, confirmed_at: null });
    } finally {
      db.close();
    }
  });

  it("derives approval submission routing from the stored build and rejects a mismatched discriminator", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPendingApproval(db, "devnet-approval-route");
      await db
        .prepare("UPDATE builds SET network = 'devnet' WHERE id = ?")
        .bind(fixture.buildId)
        .run();
      const submitApproval = vi.fn(async ({ network }: { network: "testnet" | "devnet" }) => ({
        hash: fixture.signed.hash,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true as const,
        network,
      }));
      const approvalContext: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        executionServices: {
          now: () => new Date(NOW),
          submitApproval,
          submitSigned: vi.fn(),
        } satisfies ExecutionServices,
      };

      await expect(handleTxSubmit(approvalContext, {
        approval_id: fixture.approvalId,
        tx_blob: fixture.signed.tx_blob,
        network: "testnet",
      })).rejects.toThrow(/stored approval network/i);
      expect(submitApproval).not.toHaveBeenCalled();

      await expect(handleTxSubmit(approvalContext, {
        approval_id: fixture.approvalId,
        tx_blob: fixture.signed.tx_blob,
        network: "devnet",
      })).resolves.toMatchObject({ hash: fixture.signed.hash, validated: true });
      expect(submitApproval).toHaveBeenCalledWith(expect.objectContaining({
        network: "devnet",
      }));
    } finally {
      db.close();
    }
  });

  it("replays a rejected owner terminal result after response loss without resubmitting", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPendingApproval(db, "rejected-replay");
      const submitApproval = vi.fn(async () => {
        throw new Error("submit response lost");
      });
      const submitSigned = vi.fn();
      const approvalContext: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        executionServices: {
          now: () => new Date(NOW),
          submitApproval,
          submitSigned,
          status: vi.fn(async (_ctx, network, hash) => ({
            hash,
            network,
            validated: true,
            ledger_index: 200,
            engine_result: "tecFAILED_PROCESSING",
          })),
        } satisfies ExecutionServices,
      };

      await expect(
        handleTxSubmit(approvalContext, {
          approval_id: fixture.approvalId,
          tx_blob: fixture.signed.tx_blob,
        }),
      ).rejects.toThrow(/did not validate/i);
      const expectedFailure = {
        status: "failed",
        engine_result: "tecFAILED_PROCESSING",
        detail:
          "Owner-signed transaction reached a validated ledger without tesSUCCESS",
      };
      await expect(
        handleTxExecute(approvalContext, {
          build_id: fixture.buildId,
          idempotency_key: fixture.idempotencyKey,
        }),
      ).resolves.toEqual(expectedFailure);
      await expect(
        handleTxSubmit(approvalContext, {
          approval_id: fixture.approvalId,
          tx_blob: fixture.signed.tx_blob,
        }),
      ).resolves.toEqual(expectedFailure);
      expect(submitApproval).toHaveBeenCalledTimes(1);
      expect(submitSigned).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("does not submit an owner approval while x402 owns the same ledger account", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPendingApproval(db, "owner-x402-collision");
      const authority = new AccountSequenceLeaseAuthority(asD1(db));
      expect(await authority.acquire({
        principal: "payer-runtime:x402", network: "testnet", account: fixture.owner,
        source: "x402", attemptId: "x402-collision", token: "D".repeat(64), at: NOW,
      })).toMatchObject({ outcome: "acquired" });
      const submitApproval = vi.fn();
      const approvalContext: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        executionServices: {
          now: () => new Date(NOW), submitApproval, submitSigned: vi.fn(), status: vi.fn(),
        } satisfies ExecutionServices,
      };
      await expect(handleTxSubmit(approvalContext, {
        approval_id: fixture.approvalId, tx_blob: fixture.signed.tx_blob,
      })).rejects.toMatchObject({ code: "SUBMISSION_PENDING" });
      expect(submitApproval).not.toHaveBeenCalled();
      expect(await authority.get({ network: "testnet", account: fixture.owner }))
        .toMatchObject({ source: "x402", attemptId: "x402-collision" });
    } finally {
      db.close();
    }
  });

  it("holds an owner approval on a local pre-submit validation failure", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPendingApproval(db, "owner-local-validation");
      const submitApproval = vi.fn(async () => {
        throw new SubmitValidationError(
          "Transaction has passed its LastLedgerSequence",
          "TRANSACTION_EXPIRED",
        );
      });
      const status = vi.fn();
      const approvalContext: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        executionServices: {
          now: () => new Date(NOW),
          submitApproval,
          submitSigned: vi.fn(),
          status,
        } satisfies ExecutionServices,
      };

      await expect(
        handleTxSubmit(approvalContext, {
          approval_id: fixture.approvalId,
          tx_blob: fixture.signed.tx_blob,
        }),
      ).rejects.toMatchObject({ code: "SUBMISSION_PENDING" });
      await expect(
        handleTxSubmit(approvalContext, {
          approval_id: fixture.approvalId,
          tx_blob: fixture.signed.tx_blob,
        }),
      ).rejects.toMatchObject({ code: "SUBMISSION_PENDING" });
      expect(submitApproval).toHaveBeenCalledTimes(1);
      expect(status).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each([
    ["telCAN_NOT_QUEUE", 2],
    ["temMALFORMED", 1],
  ] as const)(
    "holds an owner approval after definitive %s submission failure",
    async (engineResult, expectedSubmitCalls) => {
      const db = new SqliteD1();
      try {
        const fixture = await seedPendingApproval(db, `owner-${engineResult}`);
        const request = vi.fn(async (_network: string, command: string) => {
          if (command === "ledger") {
            return { validated: true, ledger_index: 100 };
          }
          if (command === "submit") return { engine_result: engineResult };
          throw new Error(`Unexpected XRPL command: ${command}`);
        });
        const approvalContext: OpContext = {
          principal: PRINCIPAL,
          db: asD1(db),
          xrplRpc: { request },
          executionServices: { now: () => new Date(NOW) },
        };

        await expect(
          handleTxSubmit(approvalContext, {
            approval_id: fixture.approvalId,
            tx_blob: fixture.signed.tx_blob,
          }),
        ).rejects.toMatchObject({ code: "SUBMISSION_PENDING" });
        await expect(
          handleTxSubmit(approvalContext, {
            approval_id: fixture.approvalId,
            tx_blob: fixture.signed.tx_blob,
          }),
        ).rejects.toMatchObject({ code: "SUBMISSION_PENDING" });
        expect(
          request.mock.calls.filter(([, command]) => command === "submit"),
        ).toHaveLength(expectedSubmitCalls);
        expect(
          request.mock.calls.filter(([, command]) => command === "tx"),
        ).toHaveLength(2);
        const rows = await db
          .prepare(
            `SELECT e.status AS execution_status, a.status AS approval_status
               FROM executions AS e
               JOIN approvals AS a ON a.build_id = e.build_id AND a.principal = e.principal
              WHERE e.id = ?`,
          )
          .bind(fixture.executionId)
          .first<{ execution_status: string; approval_status: string }>();
        expect(rows).toEqual({
          execution_status: "submitted",
          approval_status: "submitted",
        });
      } finally {
        db.close();
      }
    },
  );

  it("holds a signed delegated reservation after telCAN_NOT_QUEUE retry exhaustion", async () => {
    const db = new SqliteD1();
    try {
      await seedBuild(db, buildRow("build-tel-retry"));
      await seedPolicy(db);
      await seedLink(db);
      const signer = Wallet.generate();
      const signed = signer.sign({
        TransactionType: "AccountSet",
        Account: signer.address,
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 200,
      });
      const rpc = xrplRpc({
        submitResult: { engine_result: "telCAN_NOT_QUEUE" },
      });
      const executeContext = context(db, {
        facts: facts(),
        signDelegate: vi.fn(async () => ({
          tx_blob: signed.tx_blob,
          hash: signed.hash,
        })),
        now: () => new Date(NOW),
        randomUUID: () => "execution-tel-retry",
      });
      executeContext.xrplRpc = rpc;

      const expectedFailure = {
        status: "failed",
        engine_result: "SUBMISSION_PENDING",
      };
      await expect(
        handleTxExecute(executeContext, {
          build_id: "build-tel-retry",
          idempotency_key: "tel-retry",
        }),
      ).resolves.toMatchObject(expectedFailure);
      const execution = await db
        .prepare("SELECT status FROM executions WHERE id = ?")
        .bind("execution-tel-retry")
        .first<{ status: string }>();
      expect(execution).toEqual({ status: "submitted" });
      await expect(
        handleTxExecute(executeContext, {
          build_id: "build-tel-retry",
          idempotency_key: "tel-retry",
        }),
      ).resolves.toMatchObject({ status: "failed" });
      expect(
        rpc.request.mock.calls.filter(([, command]) => command === "submit"),
      ).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("holds a signed delegated reservation on a local pre-submit validation failure", async () => {
    const db = new SqliteD1();
    try {
      await seedBuild(db, buildRow("build-local-validation"));
      await seedPolicy(db);
      await seedLink(db);
      const signer = Wallet.generate();
      const signed = signer.sign({
        TransactionType: "AccountSet",
        Account: signer.address,
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 200,
      });
      const submitSigned = vi.fn(async () => {
        throw new SubmitValidationError(
          "Transaction has passed its LastLedgerSequence",
          "TRANSACTION_EXPIRED",
        );
      });
      const executeContext = context(db, {
        facts: facts(),
        signDelegate: vi.fn(async () => ({
          tx_blob: signed.tx_blob,
          hash: signed.hash,
        })),
        submitSigned,
        now: () => new Date(NOW),
        randomUUID: () => "execution-local-validation",
      });
      const expectedFailure = {
        status: "failed",
        engine_result: "SUBMISSION_PENDING",
      };

      await expect(
        handleTxExecute(executeContext, {
          build_id: "build-local-validation",
          idempotency_key: "local-validation",
        }),
      ).resolves.toMatchObject(expectedFailure);
      await expect(
        handleTxExecute(executeContext, {
          build_id: "build-local-validation",
          idempotency_key: "local-validation",
        }),
      ).resolves.toMatchObject({ status: "failed" });
      expect(submitSigned).toHaveBeenCalledTimes(1);
      const execution = await db
        .prepare(
          "SELECT status, confirmed_by, confirmed_at FROM executions WHERE id = ?",
        )
        .bind("execution-local-validation")
        .first<{
          status: string;
          confirmed_by: string | null;
          confirmed_at: string | null;
        }>();
      expect(execution).toEqual({
        status: "submitted",
        confirmed_by: null,
        confirmed_at: null,
      });
    } finally {
      db.close();
    }
  });

  it("persists a secret-safe delegated signing failure code", async () => {
    const db = new SqliteD1();
    try {
      await seedBuild(db, buildRow("build-signing-diagnostic"));
      await seedPolicy(db);
      await seedLink(db);
      const submitSigned = vi.fn();
      const executeContext = context(db, {
        facts: facts(),
        signDelegate: vi.fn(async () => {
          throw new DelegatedSigningError(
            "sensitive provider detail that must not escape",
            "MISSING_KEK",
          );
        }),
        submitSigned,
        now: () => new Date(NOW),
        randomUUID: () => "execution-signing-diagnostic",
      });
      const expectedFailure = {
        status: "failed",
        engine_result: "SUBMISSION_PENDING",
      };

      await expect(
        handleTxExecute(executeContext, {
          build_id: "build-signing-diagnostic",
          idempotency_key: "signing-diagnostic",
        }),
      ).resolves.toMatchObject(expectedFailure);
      await expect(
        handleTxExecute(executeContext, {
          build_id: "build-signing-diagnostic",
          idempotency_key: "signing-diagnostic",
        }),
      ).resolves.toMatchObject(expectedFailure);
      expect(submitSigned).not.toHaveBeenCalled();
      const lease = await db.prepare(`SELECT state, tx_hash FROM account_sequence_leases
        WHERE network = 'testnet' AND account = ?`).bind(OWNER)
        .first<{ state: string; tx_hash: string | null }>();
      expect(lease).toEqual({ state: "ambiguous", tx_hash: null });
    } finally {
      db.close();
    }
  });

  it("normalizes an upstream-derived XRPL signing failure code", async () => {
    const db = new SqliteD1();
    try {
      await seedBuild(db, buildRow("build-xrpl-signing-diagnostic"));
      await seedPolicy(db);
      await seedLink(db);
      const submitSigned = vi.fn();
      const executeContext = context(db, {
        facts: facts(),
        signDelegate: vi.fn(async () => {
          throw new XrplRpcError(
            "sensitive upstream message sentinel",
            "UNTRUSTED_CODE_SENTINEL",
          );
        }),
        submitSigned,
        now: () => new Date(NOW),
        randomUUID: () => "execution-xrpl-signing-diagnostic",
      });
      const expectedFailure = {
        status: "failed",
        engine_result: "SUBMISSION_PENDING",
      };
      const args = {
        build_id: "build-xrpl-signing-diagnostic",
        idempotency_key: "xrpl-signing-diagnostic",
      };

      await expect(handleTxExecute(executeContext, args)).resolves.toMatchObject(expectedFailure);
      await expect(handleTxExecute(executeContext, args)).resolves.toMatchObject(expectedFailure);
      expect(submitSigned).not.toHaveBeenCalled();
      expect(JSON.stringify(await new AccountSequenceLeaseAuthority(asD1(db)).get({
        network: "testnet", account: OWNER,
      }))).not.toContain("UNTRUSTED_CODE_SENTINEL");
    } finally {
      db.close();
    }
  });

  it.each([
    ["before delegated signing", ["1"], 0],
    ["between signing and first relay", ["0", "0", "1"], 1],
  ] as const)("rejects an official-RLUSD balance-only change %s", async (_label, balances, expectedSigns) => {
    const db = new SqliteD1();
    try {
      const wallet = Wallet.generate();
      const invariant = {
        kind: "issued_balance_unchanged" as const,
        currency: "524C555344000000000000000000000000000000",
        issuer: DELEGATE,
        balance: "0",
        ledgerIndex: 100,
      };
      const build = await seedV2Build(
        db,
        `v2-balance-${expectedSigns}`,
        wallet.address,
        invariant,
      );
      await seedPolicy(db, wallet.address);
      await seedLink(db, "active", wallet.address);
      const signed = wallet.sign({
        ...build.txJson,
        Delegate: DELEGATE,
      } as Transaction);
      const signDelegate = vi.fn(async () => ({
        tx_blob: signed.tx_blob,
        hash: signed.hash,
      }));
      const submitSigned = vi.fn();
      const ctx = v2Context(
        db,
        {
          facts: facts(),
          now: () => new Date(NOW),
          randomUUID: () => `v2-balance-${expectedSigns}-execution`,
          signDelegate,
          submitSigned,
        },
        156,
        wallet.address,
      );
      const baseRequest = ctx.xrplRpc!.request.bind(ctx.xrplRpc);
      let balanceRead = 0;
      ctx.xrplRpc = {
        request: vi.fn(async (network, command, params, options) => {
          if (command === "account_lines") {
            const balance = balances[Math.min(balanceRead++, balances.length - 1)];
            return {
              account: wallet.address,
              ledger_index: params?.ledger_index,
              validated: true,
              lines: [{
                account: DELEGATE,
                currency: invariant.currency,
                balance,
              }],
            };
          }
          return baseRequest(network, command, params, options);
        }),
      };

      await expect(handleTxExecute(ctx, {
        build_id: build.id,
        idempotency_key: `v2-balance-${expectedSigns}`,
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
      })).rejects.toMatchObject({ code: "BALANCE_INVARIANT_CHANGED" });
      expect(signDelegate).toHaveBeenCalledTimes(expectedSigns);
      expect(submitSigned).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("uses immutable revision valuation after the mutable build summary is changed", async () => {
    const db = new SqliteD1();
    try {
      const wallet = Wallet.generate();
      const build = await seedV2Build(db, "v2-summary-tamper", wallet.address);
      await seedPolicy(db, wallet.address);
      await seedLink(db, "active", wallet.address);
      await db
        .prepare("UPDATE builds SET summary = ? WHERE id = ?")
        .bind(
          JSON.stringify({ ...build.summary, usd_value: "10000" }),
          build.id,
        )
        .run();
      const signed = wallet.sign({
        ...build.txJson,
        Delegate: DELEGATE,
      } as Transaction);
      const submitSigned = vi.fn(async () => ({
        hash: signed.hash.toUpperCase(),
        ledger_index: 157,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));
      const ctx = v2Context(
        db,
        {
          now: () => new Date(NOW),
          randomUUID: () => "v2-summary-tamper-execution",
          signDelegate: vi.fn(async () => ({
            tx_blob: signed.tx_blob,
            hash: signed.hash,
          })),
          submitSigned,
        },
        156,
        wallet.address,
      );

      await expect(handleTxExecute(ctx, {
        build_id: build.id,
        idempotency_key: "v2-summary-tamper",
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
      })).resolves.toMatchObject({ status: "executed", signed_by: "delegate" });
      expect(submitSigned).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});

describe("xrpl execution v2 lifetime", () => {
  it("enforces strict v2 request bindings without silently downgrading", () => {
    const base = { build_id: "build", idempotency_key: "intent" };
    expect(TxExecuteArgsSchema.parse(base)).toEqual(base);
    expect(
      TxExecuteArgsSchema.safeParse({
        ...base,
        execution_contract: "xrpl_execution_v2",
      }).success,
    ).toBe(false);
    expect(
      TxExecuteArgsSchema.safeParse({ ...base, build_revision: 1 }).success,
    ).toBe(false);
    expect(
      TxApprovalPreflightArgsSchema.safeParse({
        approval_id: "approval",
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
        unsigned_tx_digest: "a".repeat(64),
        economic_fingerprint: "B".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("rejects omission as a downgrade for a persisted v2 build", async () => {
    const db = new SqliteD1();
    try {
      const build = await seedV2Build(db, "v2-downgrade");
      await seedPolicy(db);
      await seedLink(db);
      await expect(
        handleTxExecute(v2Context(db, { facts: facts() }, 100), {
          build_id: build.id,
          idempotency_key: "v2-downgrade",
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_CONTRACT_MISMATCH" });
      const executions = await db
        .prepare("SELECT COUNT(*) AS count FROM executions")
        .first<{ count: number }>();
      expect(executions?.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects a receiptless v2 execution as a legacy replay", async () => {
    const db = new SqliteD1();
    try {
      const build = await seedV2Build(db, "v2-receiptless-downgrade");
      await new Store(asD1(db), PRINCIPAL).insertExecution({
        id: "v2-receiptless-execution",
        buildId: build.id,
        idempotencyKey: `${PRINCIPAL}:v2-receiptless-downgrade`,
        status: "pending",
        hash: null,
        usdValue: null,
        signedBy: null,
        createdAt: NOW,
      });
      await expect(
        handleTxExecute(v2Context(db, { facts: facts() }, 100), {
          build_id: build.id,
          idempotency_key: "v2-receiptless-downgrade",
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_CONTRACT_MISMATCH" });
    } finally {
      db.close();
    }
  });

  it.each([
    [156, true],
    [157, false],
  ] as const)(
    "creates a v2 approval only with at least eight ledgers remaining (head %s)",
    async (validatedLedger, succeeds) => {
      const db = new SqliteD1();
      try {
        const build = await seedV2Build(db, `v2-window-${validatedLedger}`);
        await seedPolicy(db);
        await seedLink(db);
        const ids = [
          `v2-window-${validatedLedger}-execution`,
          `v2-window-${validatedLedger}-approval`,
        ];
        const ctx = v2Context(
          db,
          {
            facts: facts(),
            now: () => new Date(NOW),
            randomUUID: () => ids.shift()!,
          },
          validatedLedger,
        );
        const promise = handleTxExecute(ctx, {
          build_id: build.id,
          idempotency_key: `v2-window-${validatedLedger}`,
          require_owner_approval: true,
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
        });
        if (!succeeds) {
          await expect(promise).rejects.toMatchObject({
            code: "TRANSACTION_WINDOW_TOO_SHORT",
          });
          const approvals = await db
            .prepare("SELECT COUNT(*) AS count FROM approvals")
            .first<{ count: number }>();
          const snapshots = await db
            .prepare("SELECT COUNT(*) AS count FROM execution_snapshots")
            .first<{ count: number }>();
          expect(approvals?.count).toBe(0);
          expect(snapshots?.count).toBe(0);
          const executions = await db
            .prepare("SELECT COUNT(*) AS count FROM executions")
            .first<{ count: number }>();
          expect(executions?.count).toBe(0);
          await expect(handleTxExecute(ctx, {
            build_id: build.id,
            idempotency_key: `v2-window-${validatedLedger}`,
          })).rejects.toMatchObject({ code: "EXECUTION_CONTRACT_MISMATCH" });
          await expect(handleTxExecute(ctx, {
            build_id: build.id,
            idempotency_key: `v2-window-${validatedLedger}`,
            require_owner_approval: true,
            execution_contract: "xrpl_execution_v2",
            build_revision: 1,
          })).rejects.toMatchObject({ code: "TRANSACTION_WINDOW_TOO_SHORT" });
          return;
        }
        const result = await promise;
        expect(result).toMatchObject({
          status: "needs_approval",
          expires_at: "2026-10-18T10:01:30.000Z",
        });
        const approvalId = (result as { approval_id: string }).approval_id;
        const snapshot = await new Store(
          asD1(db),
          PRINCIPAL,
        ).getExecutionSnapshot(`v2-window-${validatedLedger}-execution`);
        expect(snapshot).toMatchObject({
          approvalId,
          approvalExpiresAt: "2026-10-18T10:01:30.000Z",
          firstInclusionLedger: 101,
          lastLedgerSequence: 164,
        });
      } finally {
        db.close();
      }
    },
  );

  it("preflights at eight remaining and rejects exact expiry", async () => {
    const db = new SqliteD1();
    try {
      const build = await seedV2Build(db, "v2-preflight");
      await seedPolicy(db);
      await seedLink(db);
      const ids = ["v2-preflight-execution", "v2-preflight-approval"];
      let now = new Date(NOW);
      const services: ExecutionServices = {
        facts: facts(),
        now: () => now,
        randomUUID: () => ids.shift()!,
      };
      const ctx = v2Context(db, services, 156);
      const result = await handleTxExecute(ctx, {
        build_id: build.id,
        idempotency_key: "v2-preflight",
        require_owner_approval: true,
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
      });
      const approvalId = (result as { approval_id: string }).approval_id;
      const revision = await new Store(asD1(db), PRINCIPAL).getBuildRevision(
        build.id,
        1,
      );
      const request = {
        approval_id: approvalId,
        execution_contract: "xrpl_execution_v2" as const,
        build_revision: 1,
        unsigned_tx_digest: revision!.unsignedTxDigest,
        economic_fingerprint: revision!.economicFingerprint,
      };
      const concurrent = await Promise.allSettled([
        handleTxApprovalPreflight(ctx, request),
        handleTxApprovalPreflight(ctx, request),
      ]);
      const ready = concurrent.filter(
        (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof handleTxApprovalPreflight>>> =>
          outcome.status === "fulfilled",
      );
      const rejected = concurrent.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      expect(ready).toHaveLength(1);
      expect(ready[0]?.value).toMatchObject({
        status: "ready",
        validated_ledger: 156,
        remaining_ledgers: 8,
      });
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({
        code: "APPROVAL_ALREADY_PREFLIGHTED",
      });
      const approval = await new Store(asD1(db), PRINCIPAL).getApproval(
        approvalId,
      );
      expect(approval?.status).toBe("preflighted");

      await expect(handleTxApprovalPreflight(ctx, request)).rejects.toMatchObject({
        code: "APPROVAL_ALREADY_PREFLIGHTED",
      });

      now = new Date("2026-10-18T10:01:30.000Z");
      await expect(handleTxApprovalPreflight(ctx, request)).rejects.toMatchObject({
        code: "APPROVAL_EXPIRED",
      });
    } finally {
      db.close();
    }
  });

  it("returns already-preflighted when authorization wins a delayed validation failure", async () => {
    const db = new SqliteD1();
    try {
      const build = await seedV2Build(db, "v2-preflight-auth-wins");
      await seedPolicy(db);
      await seedLink(db);
      const ids = ["v2-preflight-auth-wins-execution", "v2-preflight-auth-wins-approval"];
      const setup = v2Context(db, {
        facts: facts(),
        now: () => new Date(NOW),
        randomUUID: () => ids.shift()!,
      }, 156);
      const approvalResult = await handleTxExecute(setup, {
        build_id: build.id,
        idempotency_key: "v2-preflight-auth-wins",
        require_owner_approval: true,
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
      });
      const revision = await new Store(asD1(db), PRINCIPAL).getBuildRevision(build.id, 1);
      const request = {
        approval_id: (approvalResult as { approval_id: string }).approval_id,
        execution_contract: "xrpl_execution_v2" as const,
        build_revision: 1,
        unsigned_tx_digest: revision!.unsignedTxDigest,
        economic_fingerprint: revision!.economicFingerprint,
      };
      const enteredFailure = deferred<void>();
      const releaseFailure = deferred<void>();
      const failing = v2Context(db, { now: () => new Date(NOW) }, 156);
      const failingRequest = failing.xrplRpc!.request.bind(failing.xrplRpc);
      let delayed = false;
      failing.xrplRpc = {
        request: vi.fn(async (network, command, params, options) => {
          if (command === "account_info" && !delayed) {
            delayed = true;
            enteredFailure.resolve();
            await releaseFailure.promise;
            const response = await failingRequest(network, command, params, options);
            return {
              ...response,
              account_data: { ...(response.account_data as object), Sequence: 8 },
            };
          }
          return failingRequest(network, command, params, options);
        }),
      };
      const losingFailure = handleTxApprovalPreflight(failing, request);
      await enteredFailure.promise;
      await expect(handleTxApprovalPreflight(
        v2Context(db, { now: () => new Date(NOW) }, 156),
        request,
      )).resolves.toMatchObject({ status: "ready" });
      releaseFailure.resolve();
      await expect(losingFailure).rejects.toMatchObject({
        code: "APPROVAL_ALREADY_PREFLIGHTED",
      });
      const rejectionCount = await db
        .prepare("SELECT COUNT(*) AS count FROM approval_preflight_rejections")
        .first<{ count: number }>();
      expect(rejectionCount?.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("persists one exact terminal rejection when validation beats authorization", async () => {
    const db = new SqliteD1();
    try {
      const build = await seedV2Build(db, "v2-preflight-rejection-wins");
      await seedPolicy(db);
      await seedLink(db);
      const ids = ["v2-preflight-rejection-wins-execution", "v2-preflight-rejection-wins-approval"];
      const setup = v2Context(db, {
        facts: facts(),
        now: () => new Date(NOW),
        randomUUID: () => ids.shift()!,
      }, 156);
      const approvalResult = await handleTxExecute(setup, {
        build_id: build.id,
        idempotency_key: "v2-preflight-rejection-wins",
        require_owner_approval: true,
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
      });
      const revision = await new Store(asD1(db), PRINCIPAL).getBuildRevision(build.id, 1);
      const approvalId = (approvalResult as { approval_id: string }).approval_id;
      const request = {
        approval_id: approvalId,
        execution_contract: "xrpl_execution_v2" as const,
        build_revision: 1,
        unsigned_tx_digest: revision!.unsignedTxDigest,
        economic_fingerprint: revision!.economicFingerprint,
      };
      const enteredSuccess = deferred<void>();
      const releaseSuccess = deferred<void>();
      const slowSuccess = v2Context(db, { now: () => new Date(NOW) }, 156);
      const slowRequest = slowSuccess.xrplRpc!.request.bind(slowSuccess.xrplRpc);
      let delayed = false;
      slowSuccess.xrplRpc = {
        request: vi.fn(async (network, command, params, options) => {
          if (command === "account_info" && !delayed) {
            delayed = true;
            enteredSuccess.resolve();
            await releaseSuccess.promise;
          }
          return slowRequest(network, command, params, options);
        }),
      };
      const losingAuthorization = handleTxApprovalPreflight(slowSuccess, request);
      await enteredSuccess.promise;
      const failing = v2Context(db, { now: () => new Date(NOW) }, 156);
      const failingRequest = failing.xrplRpc!.request.bind(failing.xrplRpc);
      failing.xrplRpc = {
        request: vi.fn(async (network, command, params, options) => {
          const response = await failingRequest(network, command, params, options);
          return command === "account_info"
            ? {
                ...response,
                account_data: { ...(response.account_data as object), Sequence: 8 },
              }
            : response;
        }),
      };
      await expect(handleTxApprovalPreflight(failing, request)).rejects.toMatchObject({
        code: "ACCOUNT_SEQUENCE_CHANGED",
      });
      releaseSuccess.resolve();
      await expect(losingAuthorization).rejects.toMatchObject({
        code: "ACCOUNT_SEQUENCE_CHANGED",
      });
      await expect(handleTxApprovalPreflight(
        v2Context(db, { now: () => new Date(NOW) }, 156),
        request,
      )).rejects.toMatchObject({ code: "ACCOUNT_SEQUENCE_CHANGED" });
      const row = await db
        .prepare(
          `SELECT a.status AS approval_status, e.status AS execution_status,
                  r.error_code, ev.detail
             FROM approvals AS a
             JOIN executions AS e ON e.id = a.execution_id
             JOIN approval_preflight_rejections AS r ON r.approval_id = a.id
             JOIN events AS ev ON ev.id = 'execution-result:' || e.id
            WHERE a.id = ?`,
        )
        .bind(approvalId)
        .first<{
          approval_status: string;
          execution_status: string;
          error_code: string;
          detail: string;
        }>();
      expect(row).toMatchObject({
        approval_status: "rejected",
        execution_status: "failed",
        error_code: "ACCOUNT_SEQUENCE_CHANGED",
      });
      expect(JSON.parse(row!.detail)).toMatchObject({
        result: { status: "failed", engine_result: "ACCOUNT_SEQUENCE_CHANGED" },
      });
    } finally {
      db.close();
    }
  });

  it("treats a raw durable rejection row as authoritative before preflight or submit", async () => {
    const db = new SqliteD1();
    try {
      const build = await seedV2Build(db, "v2-raw-durable-rejection");
      await seedPolicy(db);
      await seedLink(db);
      const ids = ["v2-raw-rejection-execution", "v2-raw-rejection-approval"];
      const services = {
        facts: facts(),
        now: () => new Date(NOW),
        randomUUID: () => ids.shift()!,
        submitApproval: vi.fn(),
        submitSigned: vi.fn(),
      };
      const ctx = v2Context(db, services, 156);
      const approvalResult = await handleTxExecute(ctx, {
        build_id: build.id,
        idempotency_key: "v2-raw-durable-rejection",
        require_owner_approval: true,
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
      });
      const approvalId = (approvalResult as { approval_id: string }).approval_id;
      const revision = await new Store(asD1(db), PRINCIPAL).getBuildRevision(build.id, 1);
      const binding = {
        approval_id: approvalId,
        execution_contract: "xrpl_execution_v2" as const,
        build_revision: 1,
        unsigned_tx_digest: revision!.unsignedTxDigest,
        economic_fingerprint: revision!.economicFingerprint,
      };
      await db.prepare(
        `INSERT INTO approval_preflight_rejections
          (principal, approval_id, execution_id, error_code, rejected_at)
         VALUES (?, ?, ?, 'ACCOUNT_SEQUENCE_CHANGED', ?)`,
      ).bind(PRINCIPAL, approvalId, "v2-raw-rejection-execution", NOW).run();

      await expect(handleTxApprovalPreflight(ctx, binding)).rejects.toMatchObject({
        code: "ACCOUNT_SEQUENCE_CHANGED",
      });
      await expect(handleTxSubmit(ctx, {
        tx_blob: "00",
        ...binding,
      })).rejects.toMatchObject({ code: "ACCOUNT_SEQUENCE_CHANGED" });
      expect(services.submitApproval).not.toHaveBeenCalled();
      expect(services.submitSigned).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("strictly parses the fixed approval reconciliation request", () => {
    const base = {
      approval_id: "approval",
      execution_contract: "xrpl_execution_v2" as const,
      build_revision: 1,
      unsigned_tx_digest: "A".repeat(64),
      economic_fingerprint: "B".repeat(64),
    };
    expect(TxApprovalReconcileArgsSchema.parse(base)).toEqual(base);
    expect(() => TxApprovalReconcileArgsSchema.parse({ ...base, owner: OWNER })).toThrow();
    expect(() => TxApprovalReconcileArgsSchema.parse({
      ...base,
      execution_contract: "xrpl_execution_v1",
    })).toThrow();
  });

  it("rejects approval reconciliation outside the exact reviewed trading profile before reads", async () => {
    const db = new SqliteD1();
    try {
      const request = vi.fn();
      const ctx: OpContext = {
        principal: PRINCIPAL,
        localDevRequest: true,
        db: asD1(db),
        env: { ...REVIEWED_ONBOARDING_ENV, DB: asD1(db) },
        xrplRpc: { request },
      };
      await expect(handleTxApprovalReconcile(ctx, {
        approval_id: "approval",
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
        unsigned_tx_digest: "A".repeat(64),
        economic_fingerprint: "B".repeat(64),
      })).rejects.toMatchObject({ code: "EXECUTION_CONTRACT_UNSUPPORTED" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("burns an expired unsigned acquisition only after a complete marker-exhausted proof and replays it exactly", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPreflightedRecoveryCandidate(db, "v2-recovery-success");
      const accountTxRequests: Record<string, unknown>[] = [];
      const ctx = v2Context(db, { now: () => new Date("2026-10-18T10:01:31.000Z") }, 165);
      const baseRequest = ctx.xrplRpc!.request.bind(ctx.xrplRpc);
      ctx.xrplRpc = {
        request: vi.fn(async (network, command, params, options) => {
          if (command === "account_lines") {
            return {
              account: OWNER,
              ledger_index: 165,
              validated: true,
              lines: [{
                account: TESTNET_RLUSD_ISSUER,
                currency: RLUSD_HEX_CURRENCY,
                balance: "0",
              }],
            };
          }
          if (command === "account_tx") {
            accountTxRequests.push(params ?? {});
            const second = Object.hasOwn(params ?? {}, "marker");
            return {
              account: OWNER,
              ledger_index_min: 101,
              ledger_index_max: 164,
              transactions: second
                ? []
                : [{
                    validated: true,
                    ledger_index: 120,
                    tx_json: { Account: DELEGATE, Sequence: 4 },
                  }],
              ...(second ? {} : { marker: { cursor: "next" } }),
            };
          }
          return baseRequest(network, command, params, options);
        }),
      };
      const expected = {
        status: "expired_nonincluded",
        approval_id: fixture.approvalId,
        execution_id: fixture.executionId,
        validated_ledger: 165,
        first_inclusion_ledger: 101,
        last_ledger_sequence: 164,
        next_action: "request_fresh_build",
      };
      await expect(handleTxSubmit(ctx, {
        tx_blob: "00",
        ...fixture.binding,
      })).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
      expect(await new Store(asD1(db), PRINCIPAL).getApproval(fixture.approvalId))
        .toMatchObject({ status: "preflighted" });
      await expect(handleTxApprovalReconcile(ctx, fixture.binding)).resolves.toEqual(expected);
      expect(accountTxRequests).toEqual([
        {
          account: OWNER,
          ledger_index_min: 101,
          ledger_index_max: 164,
          binary: false,
          forward: true,
          limit: 200,
        },
        {
          account: OWNER,
          ledger_index_min: 101,
          ledger_index_max: 164,
          binary: false,
          forward: true,
          limit: 200,
          marker: { cursor: "next" },
        },
      ]);
      expect(accountTxRequests.every((request) => !Object.hasOwn(request, "searched_all"))).toBe(true);
      const terminal = await db.prepare(
        `SELECT a.status AS approval_status, e.status AS execution_status,
                e.hash, e.signed_by, ev.detail
           FROM approvals a JOIN executions e ON e.id = a.execution_id
           JOIN events ev ON ev.id = 'execution-result:' || e.id
          WHERE a.id = ?`,
      ).bind(fixture.approvalId).first<{
        approval_status: string;
        execution_status: string;
        hash: string | null;
        signed_by: string | null;
        detail: string;
      }>();
      expect(terminal).toMatchObject({
        approval_status: "expired",
        execution_status: "failed",
        hash: null,
        signed_by: null,
      });
      expect(JSON.parse(terminal!.detail)).toMatchObject({
        result: { status: "failed", engine_result: "APPROVAL_RECOVERED_NONINCLUSION" },
      });

      const replayRequest = vi.fn(async () => {
        throw new Error("replay must not read XRPL");
      });
      const replayCtx = v2Context(db, { now: () => new Date("2026-10-18T10:02:00.000Z") }, 999);
      replayCtx.xrplRpc = { request: replayRequest };
      await expect(handleTxApprovalReconcile(replayCtx, fixture.binding)).resolves.toEqual(expected);
      expect(replayRequest).not.toHaveBeenCalled();
      await expect(handleTxApprovalReconcile(replayCtx, {
        ...fixture.binding,
        economic_fingerprint: "F".repeat(64),
      })).rejects.toMatchObject({ code: "APPROVAL_RECOVERY_CONFLICT" });
      await expect(handleTxExecute(replayCtx, {
        build_id: fixture.build.id,
        idempotency_key: "different-key-after-recovery",
        require_owner_approval: true,
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
      })).rejects.toMatchObject({ code: "APPROVAL_RECOVERY_CONFLICT" });
      await expect(handleTxSubmit(replayCtx, {
        tx_blob: "00",
        ...fixture.binding,
      })).rejects.toMatchObject({ code: "APPROVAL_RECOVERY_CONFLICT" });
    } finally {
      db.close();
    }
  });

  it("refuses recovery until both the wall deadline and validated head are past", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPreflightedRecoveryCandidate(db, "v2-recovery-not-ready");
      await expect(handleTxApprovalReconcile(
        v2Context(db, { now: () => new Date("2026-10-18T10:01:00.000Z") }, 165),
        fixture.binding,
      )).rejects.toMatchObject({ code: "APPROVAL_RECOVERY_NOT_READY" });
      await expect(handleTxApprovalReconcile(
        v2Context(db, { now: () => new Date("2026-10-18T10:01:31.000Z") }, 164),
        fixture.binding,
      )).rejects.toMatchObject({ code: "APPROVAL_RECOVERY_NOT_READY" });
      expect(await db.prepare("SELECT COUNT(*) AS count FROM approval_recoveries")
        .first<{ count: number }>()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("serializes concurrent identical recovery proofs into one replayable burn", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPreflightedRecoveryCandidate(db, "v2-recovery-concurrent");
      const ctx = v2Context(db, { now: () => new Date("2026-10-18T10:01:31.000Z") }, 165);
      const baseRequest = ctx.xrplRpc!.request.bind(ctx.xrplRpc);
      ctx.xrplRpc = {
        request: vi.fn(async (network, command, params, options) => {
          if (command === "account_lines") return {
            account: OWNER,
            ledger_index: 165,
            validated: true,
            lines: [{
              account: TESTNET_RLUSD_ISSUER,
              currency: RLUSD_HEX_CURRENCY,
              balance: "0",
            }],
          };
          if (command === "account_tx") return {
            account: OWNER,
            ledger_index_min: 101,
            ledger_index_max: 164,
            transactions: [],
          };
          return baseRequest(network, command, params, options);
        }),
      };
      const [first, second] = await Promise.all([
        handleTxApprovalReconcile(ctx, fixture.binding),
        handleTxApprovalReconcile(ctx, fixture.binding),
      ]);
      expect(first).toEqual(second);
      expect(await db.prepare("SELECT COUNT(*) AS count FROM approval_recoveries")
        .first<{ count: number }>()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("lets recovery remain the sole terminal winner against an expired submit race", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPreflightedRecoveryCandidate(db, "v2-recovery-submit-race");
      const submitApproval = vi.fn();
      const submitSigned = vi.fn();
      const ctx = v2Context(db, {
        now: () => new Date("2026-10-18T10:01:31.000Z"),
        submitApproval,
        submitSigned,
      }, 165);
      const baseRequest = ctx.xrplRpc!.request.bind(ctx.xrplRpc);
      ctx.xrplRpc = {
        request: vi.fn(async (network, command, params, options) => {
          if (command === "account_lines") return {
            account: OWNER,
            ledger_index: 165,
            validated: true,
            lines: [{
              account: TESTNET_RLUSD_ISSUER,
              currency: RLUSD_HEX_CURRENCY,
              balance: "0",
            }],
          };
          if (command === "account_tx") return {
            account: OWNER,
            ledger_index_min: 101,
            ledger_index_max: 164,
            transactions: [],
          };
          return baseRequest(network, command, params, options);
        }),
      };
      const [recovery, submission] = await Promise.allSettled([
        handleTxApprovalReconcile(ctx, fixture.binding),
        handleTxSubmit(ctx, { tx_blob: "00", ...fixture.binding }),
      ]);
      expect(recovery.status).toBe("fulfilled");
      expect(submission.status).toBe("rejected");
      if (submission.status === "rejected") {
        expect(["APPROVAL_EXPIRED", "APPROVAL_RECOVERY_CONFLICT"])
          .toContain((submission.reason as { code?: string }).code);
      }
      expect(await db.prepare("SELECT COUNT(*) AS count FROM approval_recoveries")
        .first<{ count: number }>()).toEqual({ count: 1 });
      expect(submitApproval).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("lets a concurrent execution claim win before burn and rejects recovery atomically", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPreflightedRecoveryCandidate(db, "v2-recovery-execute-wins");
      const enteredScan = deferred<void>();
      const releaseScan = deferred<void>();
      const ctx = v2Context(db, { now: () => new Date("2026-10-18T10:01:31.000Z") }, 165);
      const baseRequest = ctx.xrplRpc!.request.bind(ctx.xrplRpc);
      ctx.xrplRpc = {
        request: vi.fn(async (network, command, params, options) => {
          if (command === "account_lines") return {
            account: OWNER,
            ledger_index: 165,
            validated: true,
            lines: [{
              account: TESTNET_RLUSD_ISSUER,
              currency: RLUSD_HEX_CURRENCY,
              balance: "0",
            }],
          };
          if (command === "account_tx") {
            enteredScan.resolve();
            await releaseScan.promise;
            return {
              account: OWNER,
              ledger_index_min: 101,
              ledger_index_max: 164,
              transactions: [],
            };
          }
          return baseRequest(network, command, params, options);
        }),
      };
      const recovery = handleTxApprovalReconcile(ctx, fixture.binding);
      await enteredScan.promise;
      await new Store(asD1(db), PRINCIPAL).insertExecution({
        id: "v2-recovery-concurrent-execution",
        buildId: fixture.build.id,
        idempotencyKey: "v2-recovery-concurrent-key",
        status: "pending",
        hash: null,
        usdValue: null,
        signedBy: null,
        createdAt: NOW,
      });
      releaseScan.resolve();
      await expect(recovery).rejects.toMatchObject({ code: "APPROVAL_RECOVERY_CONFLICT" });
      expect(await db.prepare("SELECT COUNT(*) AS count FROM approval_recoveries")
        .first<{ count: number }>()).toEqual({ count: 0 });
      expect(await new Store(asD1(db), PRINCIPAL).getApproval(fixture.approvalId))
        .toMatchObject({ status: "preflighted" });
    } finally {
      db.close();
    }
  });

  it("rejects a prior terminal result before any recovery ledger read", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPreflightedRecoveryCandidate(db, "v2-recovery-terminal");
      await db.prepare("UPDATE events SET detail = ? WHERE id = ?")
        .bind(
          JSON.stringify({ result: {
            status: "failed",
            engine_result: "PRIOR_TERMINAL",
            detail: "prior terminal result",
          } }),
          `execution-result:${fixture.executionId}`,
        )
        .run();
      const request = vi.fn(async () => {
        throw new Error("conflict must precede XRPL reads");
      });
      const ctx = v2Context(db, { now: () => new Date("2026-10-18T10:01:31.000Z") }, 165);
      ctx.xrplRpc = { request };
      await expect(handleTxApprovalReconcile(ctx, fixture.binding)).rejects.toMatchObject({
        code: "APPROVAL_RECOVERY_CONFLICT",
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("fails closed when the bounded account transaction scan reaches its page cap", async () => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPreflightedRecoveryCandidate(db, "v2-recovery-page-cap");
      const ctx = v2Context(db, { now: () => new Date("2026-10-18T10:01:31.000Z") }, 165);
      const baseRequest = ctx.xrplRpc!.request.bind(ctx.xrplRpc);
      let pages = 0;
      ctx.xrplRpc = {
        request: vi.fn(async (network, command, params, options) => {
          if (command === "account_lines") return {
            account: OWNER,
            ledger_index: 165,
            validated: true,
            lines: [{
              account: TESTNET_RLUSD_ISSUER,
              currency: RLUSD_HEX_CURRENCY,
              balance: "0",
            }],
          };
          if (command === "account_tx") {
            pages += 1;
            return {
              account: OWNER,
              ledger_index_min: 101,
              ledger_index_max: 164,
              transactions: [],
              marker: { page: pages },
            };
          }
          return baseRequest(network, command, params, options);
        }),
      };
      await expect(handleTxApprovalReconcile(ctx, fixture.binding)).rejects.toMatchObject({
        code: "APPROVAL_RECOVERY_INCOMPLETE",
      });
      expect(pages).toBe(100);
    } finally {
      db.close();
    }
  });

  it.each([
    ["unvalidated head", "ledger", "APPROVAL_RECOVERY_INCOMPLETE"],
    ["changed Sequence", "account_info", "APPROVAL_RECOVERY_STATE_CHANGED"],
    ["changed RLUSD balance", "account_lines", "APPROVAL_RECOVERY_STATE_CHANGED"],
    ["wrong account_lines account", "account_lines_account", "APPROVAL_RECOVERY_INCOMPLETE"],
    ["changed range echo", "range", "APPROVAL_RECOVERY_INCOMPLETE"],
    ["repeated marker", "account_tx", "APPROVAL_RECOVERY_INCOMPLETE"],
    ["boolean marker", "marker_boolean", "APPROVAL_RECOVERY_INCOMPLETE"],
    ["array marker", "marker_array", "APPROVAL_RECOVERY_INCOMPLETE"],
    ["negative marker", "marker_negative", "APPROVAL_RECOVERY_INCOMPLETE"],
    ["fractional marker", "marker_fractional", "APPROVAL_RECOVERY_INCOMPLETE"],
    ["empty marker", "marker_empty", "APPROVAL_RECOVERY_INCOMPLETE"],
    ["unvalidated transaction", "unvalidated_tx", "APPROVAL_RECOVERY_INCOMPLETE"],
    ["consumed owner Sequence", "consumed_sequence", "APPROVAL_RECOVERY_CONFLICT"],
  ] as const)("fails closed on %s recovery evidence", async (_label, failure, code) => {
    const db = new SqliteD1();
    try {
      const fixture = await seedPreflightedRecoveryCandidate(db, `v2-recovery-${failure}`);
      const ctx = v2Context(db, { now: () => new Date("2026-10-18T10:01:31.000Z") }, 165);
      const baseRequest = ctx.xrplRpc!.request.bind(ctx.xrplRpc);
      ctx.xrplRpc = {
        request: vi.fn(async (network, command, params, options) => {
          if (command === "ledger" && failure === "ledger") {
            return { validated: false, ledger_index: 165 };
          }
          if (command === "account_info" && failure === "account_info") {
            const response = await baseRequest(network, command, params, options);
            return { ...response, account_data: { ...(response.account_data as object), Sequence: 8 } };
          }
          if (command === "account_lines") {
            return {
              account: failure === "account_lines_account" ? DELEGATE : OWNER,
              ledger_index: 165,
              validated: true,
              lines: [{
                account: TESTNET_RLUSD_ISSUER,
                currency: RLUSD_HEX_CURRENCY,
                balance: failure === "account_lines" ? "1" : "0",
              }],
            };
          }
          if (command === "account_tx") {
            const invalidMarker = failure === "marker_boolean"
              ? false
              : failure === "marker_array"
                ? ["cursor"]
                : failure === "marker_negative"
                  ? -1
                  : failure === "marker_fractional"
                    ? 1.5
                  : failure === "marker_empty"
                    ? ""
                    : undefined;
            const tx = failure === "consumed_sequence"
              ? { Account: OWNER, Sequence: 7 }
              : { Account: DELEGATE, Sequence: 1 };
            return {
              account: OWNER,
              ledger_index_min: failure === "range" ? 102 : 101,
              ledger_index_max: 164,
              transactions: [{
                validated: failure !== "unvalidated_tx",
                ledger_index: 120,
                tx_json: tx,
              }],
              ...(failure === "account_tx" ? { marker: "repeat" } : {}),
              ...(invalidMarker !== undefined ? { marker: invalidMarker } : {}),
            };
          }
          return baseRequest(network, command, params, options);
        }),
      };
      await expect(handleTxApprovalReconcile(ctx, fixture.binding)).rejects.toMatchObject({ code });
      expect(await db.prepare("SELECT COUNT(*) AS count FROM approval_recoveries")
        .first<{ count: number }>()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("persists the owner hash and insert-only relay claim before one sole relay", async () => {
    const db = new SqliteD1();
    try {
      const wallet = Wallet.generate();
      const build = await seedV2Build(db, "v2-owner-relay", wallet.address);
      await seedPolicy(db, wallet.address);
      await seedLink(db, "active", wallet.address);
      const signed = wallet.sign(build.txJson as Transaction);
      const ids = ["v2-owner-relay-execution", "v2-owner-relay-approval"];
      const submitApproval = vi.fn(async () => {
        const state = await db
          .prepare(
            `SELECT e.status, e.hash, a.status AS approval_status,
                    r.hash AS relay_hash
               FROM executions AS e
               JOIN approvals AS a ON a.execution_id = e.id
               JOIN relay_claims AS r ON r.execution_id = e.id
              WHERE e.id = ?`,
          )
          .bind("v2-owner-relay-execution")
          .first<{
            status: string;
            hash: string;
            approval_status: string;
            relay_hash: string;
          }>();
        expect(state).toEqual({
          status: "submitted",
          hash: signed.hash.toUpperCase(),
          approval_status: "submitted",
          relay_hash: signed.hash.toUpperCase(),
        });
        return {
          hash: signed.hash.toUpperCase(),
          ledger_index: 157,
          engine_result: "tesSUCCESS",
          validated: true as const,
        };
      });
      const services: ExecutionServices = {
        facts: facts(),
        now: () => new Date(NOW),
        randomUUID: () => ids.shift()!,
        submitApproval,
        submitSigned: vi.fn(),
      };
      const ctx = v2Context(db, services, 156, wallet.address);
      const approvalResult = await handleTxExecute(ctx, {
        build_id: build.id,
        idempotency_key: "v2-owner-relay",
        require_owner_approval: true,
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
      });
      const approvalId = (approvalResult as { approval_id: string }).approval_id;
      const revision = await new Store(asD1(db), PRINCIPAL).getBuildRevision(
        build.id,
        1,
      );
      const binding = {
        approval_id: approvalId,
        execution_contract: "xrpl_execution_v2" as const,
        build_revision: 1,
        unsigned_tx_digest: revision!.unsignedTxDigest,
        economic_fingerprint: revision!.economicFingerprint,
      };
      await handleTxApprovalPreflight(ctx, binding);
      const submitArgs = {
        ...binding,
        tx_blob: signed.tx_blob,
      };
      const first = await handleTxSubmit(ctx, submitArgs);
      expect(first).toMatchObject({ engine_result: "tesSUCCESS" });
      const replay = await handleTxSubmit(ctx, submitArgs);
      expect(replay).toEqual(first);
      expect(submitApproval).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it.each([
    ["keeps eight remaining through relay", [156, 156, 156], true],
    ["fails closed when only seven remain before relay", [156, 156, 157], false],
  ] as const)("%s for delegated v2 execution", async (_label, heads, succeeds) => {
    const db = new SqliteD1();
    try {
      const wallet = Wallet.generate();
      const build = await seedV2Build(db, `v2-delegate-${heads.join("-")}`, wallet.address);
      await seedPolicy(db, wallet.address);
      await seedLink(db, "active", wallet.address);
      const signed = wallet.sign({
        ...build.txJson,
        Delegate: DELEGATE,
      } as Transaction);
      const signDelegate = vi.fn(async () => ({
        tx_blob: signed.tx_blob,
        hash: signed.hash,
      }));
      const submitSigned = vi.fn(async () => ({
        hash: signed.hash.toUpperCase(),
        ledger_index: 157,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));
      const services: ExecutionServices = {
        facts: facts(),
        now: () => new Date(NOW),
        randomUUID: () => `v2-delegate-${heads.join("-")}-execution`,
        signDelegate,
        submitSigned,
      };
      const ctx = v2Context(db, services, heads[0], wallet.address);
      const baseRequest = ctx.xrplRpc!.request.bind(ctx.xrplRpc);
      let ledgerRead = 0;
      ctx.xrplRpc = {
        request: vi.fn(async (network, command, params, options) => {
          if (command === "ledger") {
            const ledger_index = heads[Math.min(ledgerRead++, heads.length - 1)];
            return {
              validated: true,
              ledger_index,
              ledger: { ledger_index },
            };
          }
          if (command === "account_info") {
            return {
              account_data: {
                Account: wallet.address,
                Balance: "100000000",
                OwnerCount: 0,
                Sequence: 7,
                Flags: 0,
              },
              ledger_index: params?.ledger_index,
              validated: true,
            };
          }
          return baseRequest(network, command, params, options);
        }),
      };

      const execution = handleTxExecute(ctx, {
        build_id: build.id,
        idempotency_key: `v2-delegate-${heads.join("-")}`,
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
      });
      if (succeeds) {
        await expect(execution).resolves.toMatchObject({
          status: "executed",
          signed_by: "delegate",
        });
        expect(submitSigned).toHaveBeenCalledTimes(1);
      } else {
        await expect(execution).rejects.toMatchObject({
          code: "TRANSACTION_WINDOW_TOO_SHORT",
        });
        expect(submitSigned).not.toHaveBeenCalled();
      }
      expect(signDelegate).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});

describe("delegated signing sequence ownership", () => {
  it("preserves only the safe delegate-key error code", async () => {
    const link = {
      id: "link-key-diagnostic",
      owner: OWNER,
      network: "testnet" as const,
      delegate: DELEGATE,
      delegateSeedEnc: new Uint8Array([1]).buffer,
      iv: new Uint8Array([2]).buffer,
      permissions: ["OfferCancel"],
      status: "active" as const,
    };

    await expect(signDelegatedTransaction(
      {
        principal: PRINCIPAL,
        env: { HARBOR_KEK: "test-only-kek" },
        store: { getLink: async () => link },
        xrplRpc: {
          request: vi.fn(async (_network, command) =>
            command === "account_info"
              ? { account_data: { Account: OWNER, Sequence: 7 } }
              : { drops: { open_ledger_fee: "10" } },
          ),
        },
        signingServices: {
          withDelegateSigner: (async () => {
            throw new DelegateKeyError(
              "sensitive cryptographic provider detail",
              "KEY_UNWRAP_FAILED",
            );
          }) as never,
        },
      },
      { network: "testnet", owner: OWNER, txJson: txJson() },
    )).rejects.toMatchObject({
      code: "KEY_UNWRAP_FAILED",
      message: "Delegated signing key is unavailable",
    });
  });

  it("uses the owner AccountRoot sequence even when the delegate has a different sequence", async () => {
    const sign = vi.fn((_transaction: Transaction) => ({
      tx_blob: "AB",
      hash: "B".repeat(64),
    }));
    const request = vi.fn(
      async (
        _network: string,
        command: string,
        params: Readonly<Record<string, unknown>> = {},
      ) => {
        if (command === "account_info") {
          const account = String(params.account);
          return {
            account_data: {
              Account: account,
              Sequence: account === OWNER ? 7 : 99,
            },
          };
        }
        if (command === "fee") {
          return { drops: { open_ledger_fee: "10" } };
        }
        throw new Error(`Unexpected XRPL command: ${command}`);
      },
    );

    await signDelegatedTransaction(
      {
        principal: PRINCIPAL,
        env: { HARBOR_KEK: "test-only-kek" },
        store: {
          getLink: async () => ({
            id: "link-owner-sequence",
            owner: OWNER,
            network: "testnet",
            delegate: DELEGATE,
            delegateSeedEnc: new Uint8Array([1]).buffer,
            iv: new Uint8Array([2]).buffer,
            permissions: ["OfferCancel"],
            status: "active",
          }),
        },
        xrplRpc: { request },
        signingServices: {
          withDelegateSigner: (async (_identity, _wrapped, _kek, run) =>
            run({ address: DELEGATE, publicKey: "public", sign })) as never,
        },
      },
      { network: "testnet", owner: OWNER, txJson: txJson() },
    );

    expect(
      request.mock.calls.some(
        ([network, command, params]) =>
          network === "testnet" &&
          command === "account_info" &&
          params.account === OWNER,
      ),
    ).toBe(true);
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({
        Account: OWNER,
        Delegate: DELEGATE,
        Sequence: 7,
        Fee: "10",
      }),
    );
  });

  it("rechecks the exact link identity and permission immediately before signing", async () => {
    const sign = vi.fn();
    const initialLink = {
      id: "link-before-rotation",
      owner: OWNER,
      network: "testnet" as const,
      delegate: DELEGATE,
      delegateSeedEnc: new Uint8Array([1]).buffer,
      iv: new Uint8Array([2]).buffer,
      permissions: ["OfferCancel"],
      status: "active" as const,
    };
    let reads = 0;

    await expect(
      signDelegatedTransaction(
        {
          principal: PRINCIPAL,
          env: { HARBOR_KEK: "test-only-kek" },
          store: {
            getLink: async () => {
              reads += 1;
              return reads === 1
                ? initialLink
                : { ...initialLink, id: "link-after-rotation", permissions: [] };
            },
          },
          xrplRpc: {
            request: vi.fn(async (_network, command) =>
              command === "account_info"
                ? { account_data: { Account: OWNER, Sequence: 7 } }
                : { drops: { open_ledger_fee: "10" } },
            ),
          },
          signingServices: {
            withDelegateSigner: (async (_identity, _wrapped, _kek, run) =>
              run({ address: DELEGATE, publicKey: "public", sign })) as never,
          },
        },
        { network: "testnet", owner: OWNER, txJson: txJson() },
      ),
    ).rejects.toMatchObject({ code: "LINK_NOT_ACTIVE" });
    expect(sign).not.toHaveBeenCalled();
    expect(reads).toBe(2);
  });
});
