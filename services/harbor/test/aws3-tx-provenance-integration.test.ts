import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";

const { loadKmsKekMock } = vi.hoisted(() => ({
  loadKmsKekMock: vi.fn(),
}));

vi.mock("../src/aws/kms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/aws/kms")>();
  return { ...actual, loadKmsKek: loadKmsKekMock };
});

import type { OpContext } from "../src/catalog/registry";
import { DEFAULT_POLICY } from "../src/contracts";
import { createWrappedDelegateKeyWithCryptoKey } from "../src/exec/keys";
import {
  createKmsDelegateKey,
  type KmsKeyLifecycleClient,
  type KmsSignRequest,
  type KmsSigningClient,
} from "../src/exec/kms-signer";
import type { BuildRow } from "../src/exec/store";
import { signedTransactionHash, SubmitValidationError } from "../src/exec/submit";
import {
  handleTxExecute,
  handleTxStatus,
  type ExecutionServices,
} from "../src/ops/tx-exec";
import { MemoryKeyStore } from "../tools/aws-local/src/key-store";
import { handleKms } from "../tools/aws-local/src/kms";
import { createAwsLocalServer } from "../tools/aws-local/src/server";

const PRINCIPAL = "aws3-provenance-test";
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const NOW = "2026-10-21T10:00:00.000Z";
const SIGNER = {
  kind: "aws-kms-kek" as const,
  key_ref: "alias/harbor/kek",
};

const SCHEMA = `
CREATE TABLE links (id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL, network TEXT NOT NULL,
  delegate TEXT NOT NULL, delegate_seed_enc BLOB, iv BLOB,
  key_backend TEXT NOT NULL DEFAULT 'local', kms_key_id TEXT, kms_alias TEXT,
  permissions TEXT NOT NULL,
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
CREATE TABLE builds (id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL, network TEXT NOT NULL,
  tx_json TEXT NOT NULL, summary TEXT NOT NULL, last_ledger_seq INTEGER NOT NULL, created_at TEXT NOT NULL,
  origin_profile TEXT, execution_contract TEXT, build_revision INTEGER);
CREATE TABLE build_revisions (principal TEXT NOT NULL, build_id TEXT NOT NULL, build_revision INTEGER NOT NULL,
  PRIMARY KEY (principal, build_id, build_revision));
CREATE TABLE execution_snapshots (execution_id TEXT NOT NULL, principal TEXT NOT NULL, build_id TEXT NOT NULL,
  snapshot_owner TEXT NOT NULL, snapshot_network TEXT NOT NULL,
  PRIMARY KEY (execution_id, principal, build_id));
CREATE TABLE executions (id TEXT PRIMARY KEY, principal TEXT NOT NULL, build_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, hash TEXT, usd_value REAL, signed_by TEXT,
  confirmed_by TEXT, confirmed_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE approvals (id TEXT PRIMARY KEY, principal TEXT NOT NULL, build_id TEXT NOT NULL, tx_json TEXT NOT NULL,
  expires_at TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE events (id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
  detail TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX idx_exec_hash ON executions(hash);
`;

type SqlValue = string | number | bigint | null | Uint8Array;

function sqliteValue(value: unknown): SqlValue {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SqlValue;
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

function buildRow(id: string): BuildRow {
  return {
    id,
    principal: PRINCIPAL,
    owner: OWNER,
    network: "testnet",
    txJson: {
      TransactionType: "OfferCancel",
      Account: OWNER,
      OfferSequence: 1,
      Fee: "12",
      Sequence: 7,
      LastLedgerSequence: 200,
    },
    summary: {
      action: "cancel offer",
      account: OWNER,
      amounts: [],
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

async function seedPolicy(db: SqliteD1): Promise<void> {
  await db
    .prepare(
      `INSERT INTO policies (principal, owner, network, json, updated_at)
       VALUES (?, ?, 'testnet', ?, ?)`,
    )
    .bind(PRINCIPAL, OWNER, JSON.stringify(DEFAULT_POLICY), NOW)
    .run();
}

async function seedWrappedLink(
  db: SqliteD1,
  key: CryptoKey,
): Promise<void> {
  const wrapped = await createWrappedDelegateKeyWithCryptoKey(
    { principal: PRINCIPAL, owner: OWNER, network: "testnet" },
    key,
  );
  await db
    .prepare(
      `INSERT INTO links
        (id, principal, owner, network, delegate, delegate_seed_enc, iv, permissions,
         status, last_ledger, revoke_tx, created_at)
       VALUES ('aws3-link', ?, ?, 'testnet', ?, ?, ?, ?, 'active', NULL, NULL, ?)`,
    )
    .bind(
      PRINCIPAL,
      OWNER,
      wrapped.address,
      wrapped.ciphertext,
      wrapped.iv,
      JSON.stringify(["OfferCancel"]),
      NOW,
    )
    .run();
}

async function seedKmsLink(
  db: SqliteD1,
  created: Awaited<ReturnType<typeof createKmsDelegateKey>>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO links
        (id, principal, owner, network, delegate, delegate_seed_enc, iv,
         key_backend, kms_key_id, kms_alias, permissions, status, last_ledger,
         revoke_tx, created_at)
       VALUES ('aws4-link', ?, ?, 'testnet', ?, NULL, NULL, 'kms', ?, ?, ?,
         'active', NULL, NULL, ?)`,
    )
    .bind(
      PRINCIPAL,
      OWNER,
      created.address,
      created.keyId,
      created.keyAlias,
      JSON.stringify(["OfferCancel"]),
      NOW,
    )
    .run();
}

function localKmsClient(store: MemoryKeyStore): KmsKeyLifecycleClient & KmsSigningClient {
  return {
    createKey: (input) => handleKms("TrentService.CreateKey", input, store),
    createAlias: (input) => handleKms("TrentService.CreateAlias", input, store),
    tagResource: (input) => handleKms("TrentService.TagResource", input, store),
    getPublicKey: (input) => handleKms("TrentService.GetPublicKey", input, store),
    scheduleKeyDeletion: (input) => handleKms("TrentService.ScheduleKeyDeletion", input, store),
    sign: (input: KmsSignRequest) => handleKms("TrentService.Sign", input, store),
  };
}

function xrplRpc() {
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
      if (command === "fee") {
        return {
          drops: { open_ledger_fee: "10" },
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
        return { ledger_index: 100, ledger: { ledger_index: 100 } };
      }
      throw new Error(`Unexpected XRPL command: ${command}`);
    }),
  };
}

function facts() {
  return {
    getPolicyFacts: vi.fn(async () => ({ usdValue: "10", issuerFacts: [] })),
  };
}

function context(
  db: SqliteD1,
  services: ExecutionServices,
  mode: "off" | "kek" | "sign" = "kek",
): OpContext & { env: Record<string, unknown> } {
  return {
    principal: PRINCIPAL,
    db: asD1(db),
    env: {
      KMS_MODE: mode,
      HARBOR_KEK_CIPHERTEXT: Buffer.from(
        "noncredential ciphertext fixture",
      ).toString("base64"),
    },
    xrplRpc: xrplRpc(),
    executionServices: {
      facts: facts(),
      now: () => new Date(NOW),
      ...services,
    },
  };
}

async function preparedDb(name: string, key: CryptoKey): Promise<SqliteD1> {
  const db = new SqliteD1();
  await seedBuild(db, buildRow(name));
  await seedPolicy(db);
  await seedWrappedLink(db, key);
  return db;
}

async function readSignerEvent(db: SqliteD1) {
  return db
    .prepare(
      "SELECT id, detail FROM events WHERE principal = ? AND kind = 'execution_signer'",
    )
    .bind(PRINCIPAL)
    .first<{ id: string; detail: string }>();
}

describe("AWS-3 transaction signer provenance", () => {
  let key: CryptoKey;

  beforeEach(async () => {
    loadKmsKekMock.mockReset();
    key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    loadKmsKekMock.mockResolvedValue(key);
  });

  it("persists KMS KEK provenance and replays it without inferring the current mode", async () => {
    const db = await preparedDb("aws3-provenance-build", key);
    try {
      const submitSigned = vi.fn(async ({ txBlob }: { txBlob: string }) => ({
        hash: signedTransactionHash(txBlob).toUpperCase(),
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));
      const ctx = context(db, {
        submitSigned,
        randomUUID: () => "aws3-provenance-execution",
      });
      const args = {
        build_id: "aws3-provenance-build",
        idempotency_key: "provenance",
      };

      const first = await handleTxExecute(ctx, args);
      expect(first).toMatchObject({
        status: "executed",
        signed_by: "delegate",
        signer: SIGNER,
      });
      expect(loadKmsKekMock).toHaveBeenCalledOnce();
      expect(loadKmsKekMock.mock.calls[0]?.[0]).not.toHaveProperty("HARBOR_KEK");
      expect(submitSigned).toHaveBeenCalledOnce();

      const signerEvent = await readSignerEvent(db);
      expect(signerEvent).toEqual({
        id: "execution-signer:aws3-provenance-execution",
        detail: JSON.stringify({ signer: SIGNER }),
      });
      expect(signerEvent?.detail).not.toMatch(/credential|ciphertext|secret/i);

      ctx.env.KMS_MODE = "off";
      await expect(handleTxExecute(ctx, args)).resolves.toEqual(first);
      expect(loadKmsKekMock).toHaveBeenCalledOnce();
      expect(submitSigned).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it("persists exact KMS alias provenance for default stand-in signing", async () => {
    const keyStore = new MemoryKeyStore();
    const created = await createKmsDelegateKey({
      principal: PRINCIPAL,
      owner: OWNER,
      network: "testnet",
      linkId: "aws4-link",
      client: localKmsClient(keyStore),
    });
    const server = createAwsLocalServer({ store: keyStore });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const db = new SqliteD1();
    await seedBuild(db, buildRow("aws4-provenance-build"));
    await seedPolicy(db);
    await seedKmsLink(db, created);
    try {
      const submitSigned = vi.fn(async ({ txBlob }: { txBlob: string }) => ({
        hash: signedTransactionHash(txBlob).toUpperCase(),
        ledger_index: 198,
        engine_result: "tesSUCCESS",
        validated: true as const,
      }));
      const ctx = context(db, {
        submitSigned,
        randomUUID: () => "aws4-provenance-execution",
      }, "sign");
      Object.assign(ctx.env, {
        AWS_REGION: "us-east-1",
        AWS_ENDPOINT_OVERRIDE: endpoint,
        EXEC_NETWORK: "testnet",
        HARBOR_LOCAL_DEV: "true",
      });
      const args = {
        build_id: "aws4-provenance-build",
        idempotency_key: "aws4-provenance",
      };

      const first = await handleTxExecute(ctx, args);
      const expectedSigner = {
        kind: "aws-kms" as const,
        key_ref: created.keyAlias,
      };
      expect(first).toMatchObject({
        status: "executed",
        signed_by: "delegate",
        signer: expectedSigner,
      });
      expect(await readSignerEvent(db)).toEqual({
        id: "execution-signer:aws4-provenance-execution",
        detail: JSON.stringify({ signer: expectedSigner }),
      });

      ctx.env.KMS_MODE = "off";
      await expect(handleTxExecute(ctx, args)).resolves.toEqual(first);
      expect(submitSigned).toHaveBeenCalledOnce();
      expect(loadKmsKekMock).not.toHaveBeenCalled();
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) => server.close((error) =>
        error ? reject(error) : resolve()));
    }
  });

  it("keeps an ambiguous result signer-free, then restores persisted provenance on status recovery", async () => {
    const db = await preparedDb("aws3-status-build", key);
    try {
      const submitSigned = vi.fn(async () => {
        throw new Error("synthetic ambiguous submission");
      });
      const status = vi.fn(async (_ctx, network: "testnet" | "devnet", hash: string) => ({
        hash,
        network,
        validated: true,
        ledger_index: 198,
        engine_result: "tesSUCCESS",
      }));
      const ctx = context(db, {
        submitSigned,
        status,
        randomUUID: () => "aws3-status-execution",
      });
      const args = {
        build_id: "aws3-status-build",
        idempotency_key: "status-recovery",
      };

      const pending = await handleTxExecute(ctx, args);
      expect(pending).toEqual({
        status: "failed",
        engine_result: "SUBMISSION_PENDING",
        detail:
          "Submission is ambiguous; the reserved amount and account sequence remain held until ledger reconciliation",
      });
      expect(pending).not.toHaveProperty("signer");

      const execution = await db
        .prepare("SELECT hash, status FROM executions WHERE id = ?")
        .bind("aws3-status-execution")
        .first<{ hash: string; status: string }>();
      expect(execution?.status).toBe("submitted");
      expect(execution?.hash).toMatch(/^[A-F0-9]{64}$/);

      ctx.env.KMS_MODE = "off";
      await expect(
        handleTxStatus(ctx, { hash: execution!.hash }),
      ).resolves.toMatchObject({
        hash: execution!.hash,
        validated: true,
        ledger_index: 198,
      });
      const recovered = await handleTxExecute(ctx, args);
      expect(recovered).toEqual({
        status: "executed",
        hash: execution!.hash,
        ledger_index: 198,
        result: "success",
        signed_by: "delegate",
        signer: SIGNER,
        confirmation: { provider: "poll", at: NOW, latency_ms: 0 },
      });
      expect(loadKmsKekMock).toHaveBeenCalledOnce();
      expect(submitSigned).toHaveBeenCalledOnce();
      expect(status).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it("never assigns AWS provenance to an injected signer", async () => {
    const db = await preparedDb("aws3-injected-build", key);
    try {
      const signed = Wallet.generate().sign({
        TransactionType: "AccountSet",
        Account: Wallet.generate().address,
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 200,
      });
      const signDelegate = vi.fn(async () => ({
        tx_blob: signed.tx_blob,
        hash: signed.hash,
      }));
      const ctx = context(db, {
        signDelegate,
        submitSigned: vi.fn(async () => ({
          hash: signed.hash,
          ledger_index: 198,
          engine_result: "tesSUCCESS",
          validated: true as const,
        })),
        randomUUID: () => "aws3-injected-execution",
      });

      const result = await handleTxExecute(ctx, {
        build_id: "aws3-injected-build",
        idempotency_key: "injected",
      });
      expect(result).toMatchObject({
        status: "executed",
        signed_by: "delegate",
      });
      expect(result).not.toHaveProperty("signer");
      expect(await readSignerEvent(db)).toBeNull();
      expect(loadKmsKekMock).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("keeps unresolved failures and legacy receipts signer-free", async () => {
    const db = await preparedDb("aws3-failed-build", key);
    try {
      const ctx = context(db, {
        submitSigned: vi.fn(async () => {
          throw new SubmitValidationError(
            "synthetic pre-submit rejection",
            "TRANSACTION_EXPIRED",
          );
        }),
        randomUUID: () => "aws3-failed-execution",
      });
      const failed = await handleTxExecute(ctx, {
        build_id: "aws3-failed-build",
        idempotency_key: "failed",
      });
      expect(failed).toEqual({
        status: "failed",
        engine_result: "SUBMISSION_PENDING",
        detail: "Submission validation stopped (TRANSACTION_EXPIRED); the reserved amount and account sequence remain held until ledger reconciliation",
      });
      expect(failed).not.toHaveProperty("signer");
      const failedReceipt = await db
        .prepare(
          "SELECT detail FROM events WHERE id = 'execution-result:aws3-failed-execution'",
        )
        .first<{ detail: string }>();
      // Post-sign failures remain unresolved and deliberately have no terminal
      // execution receipt until ledger reconciliation supplies evidence.
      expect(failedReceipt).toBeNull();

      await seedBuild(db, buildRow("aws3-legacy-build"));
      const legacyHash = "A".repeat(64);
      await db
        .prepare(
          `INSERT INTO executions
            (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
           VALUES ('aws3-legacy-execution', ?, 'aws3-legacy-build', ?, 'executed', ?, 10, 'delegate', ?)`,
        )
        .bind(PRINCIPAL, `${PRINCIPAL}:legacy`, legacyHash, NOW)
        .run();
      const legacyResult = {
        status: "executed",
        hash: legacyHash,
        ledger_index: 126,
        result: "success",
        signed_by: "delegate",
      };
      await db
        .prepare(
          `INSERT INTO events (id, principal, owner, kind, detail, created_at)
           VALUES ('execution-result:aws3-legacy-execution', ?, ?, 'execution_result', ?, ?)`,
        )
        .bind(PRINCIPAL, OWNER, JSON.stringify({ result: legacyResult }), NOW)
        .run();

      const replay = await handleTxExecute(ctx, {
        build_id: "aws3-legacy-build",
        idempotency_key: "legacy",
      });
      expect(replay).toEqual(legacyResult);
      expect(replay).not.toHaveProperty("signer");
    } finally {
      db.close();
    }
  });
});
